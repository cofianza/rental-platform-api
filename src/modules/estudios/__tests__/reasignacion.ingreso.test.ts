import { describe, it, expect, vi, beforeEach } from 'vitest';

// Portabilidad (§4.3): la regla canon/ingreso del destino se compara con el
// ingreso con el que se DECIDIO el estudio, el ajustado de la Adenda §1.1.

const { filas } = vi.hoisted(() => ({ filas: [] as Array<Record<string, unknown> | Error | null> }));

vi.mock('@/config', () => ({ env: new Proxy({}, { get: () => false }) }));
vi.mock('@/config/env', () => ({ env: new Proxy({}, { get: () => false }) }));
vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
  chain.maybeSingle = async () => {
    const f = filas.shift() ?? null;
    return f instanceof Error ? { data: null, error: f } : { data: f, error: null };
  };
  return { supabase: { from: () => chain } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../certificado.service', () => ({ generarCertificado: vi.fn() }));

import {
  leerIngresoInferidoOriginal,
  contratoQueBloqueaReasignacion,
  motivoNoReutilizable,
  esMismaCartera,
  type InsumosReutilizacion,
} from '../reasignacion.service';
import { evaluarPortabilidad } from '../portabilidad';

beforeEach(() => {
  filas.length = 0;
});

describe('ingreso de la corrida original para la reasignacion', () => {
  it('usa el ajustado cuando existe', async () => {
    filas.push({ ingreso_inferido_cop: 4_600_000, ingreso_inferido_ajustado_cop: 5_290_000 });
    expect(await leerIngresoInferidoOriginal('est-1')).toBe(5_290_000);
  });

  it('las filas anteriores a la Adenda (sin ajustado) usan el crudo', async () => {
    filas.push({ ingreso_inferido_cop: '4600000', ingreso_inferido_ajustado_cop: null });
    expect(await leerIngresoInferidoOriginal('est-1')).toBe(4_600_000);
  });

  it('la re-evaluacion (estudio hijo, sin fila sombra) hereda el ingreso del padre', async () => {
    filas.push(null, { estudio_padre_id: 'padre' }, { ingreso_inferido_cop: 4_000_000, ingreso_inferido_ajustado_cop: 4_600_000 });
    expect(await leerIngresoInferidoOriginal('hijo')).toBe(4_600_000);
  });

  it('con el padre ya leido (padreId) no vuelve a consultar estudios', async () => {
    filas.push(null, { ingreso_inferido_cop: 4_000_000, ingreso_inferido_ajustado_cop: 4_600_000 });
    expect(await leerIngresoInferidoOriginal('hijo', { padreId: 'padre' })).toBe(4_600_000);
    expect(filas).toHaveLength(0);
  });

  it('estricto (CRC, asistente V3): un error de lectura es 503, no "no evaluable"', async () => {
    filas.push(new Error('statement timeout'));
    await expect(leerIngresoInferidoOriginal('est-1', { estricto: true })).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'LECTURA_NO_VERIFICABLE',
    });
    filas.push(new Error('statement timeout'));
    expect(await leerIngresoInferidoOriginal('est-1')).toBeNull();
  });

  it('sin fila y sin padre: no evaluable', async () => {
    filas.push(null, { estudio_padre_id: null });
    expect(await leerIngresoInferidoOriginal('est-1')).toBeNull();
  });

  it('una propiedad mas barata que la aprobada no pide evaluacion nueva', async () => {
    filas.push({ ingreso_inferido_cop: 4_600_000, ingreso_inferido_ajustado_cop: 5_290_000 });
    const veredicto = evaluarPortabilidad({
      topeCop: 20_000_000,
      canonOriginal: 2_000_000,
      ingresoOriginal: await leerIngresoInferidoOriginal('est-1'),
      canonDestino: 1_900_000,
    });
    expect(veredicto).toMatchObject({ portable: true });
  });
});

describe('contratos que impiden reasignar (A12)', () => {
  const c = (estado: string, fecha_firma: string | null = null) => ({ id: estado, estado, fecha_firma });

  it('un contrato cancelado que nunca se firmó no bloquea (es la salida que se le indica al gestor)', () => {
    expect(contratoQueBloqueaReasignacion([c('cancelado'), c('cancelado')])).toBeNull();
    expect(contratoQueBloqueaReasignacion([])).toBeNull();
  });

  it('firmado y luego cancelado, o terminado (finalizado), o en firma: bloquea', () => {
    expect(contratoQueBloqueaReasignacion([c('cancelado', '2026-09-01T00:00:00Z')])?.estado).toBe('cancelado');
    expect(contratoQueBloqueaReasignacion([c('cancelado'), c('finalizado', '2026-09-01T00:00:00Z')])?.estado).toBe('finalizado');
    expect(contratoQueBloqueaReasignacion([c('pendiente_firma')])?.estado).toBe('pendiente_firma');
    expect(contratoQueBloqueaReasignacion([c('borrador')])?.estado).toBe('borrador');
  });
});

describe('§5.2: solo se promete reutilizar lo que la reasignacion acepta', () => {
  const portable = evaluarPortabilidad({ topeCop: 20_000_000, canonOriginal: 2_000_000, ingresoOriginal: null, canonDestino: 2_100_000 });
  const base: InsumosReutilizacion = {
    tipo: 'individual',
    resultado: 'aprobado',
    expedienteEstado: 'aprobado',
    titularDeReserva: false,
    contratos: [],
    destino: { mismaPropiedad: false, mismaCartera: true, veredicto: portable },
  };

  it('aprobado, sin contrato y dentro de la tolerancia: reutilizable', () => {
    expect(motivoNoReutilizable(base)).toBeNull();
    expect(motivoNoReutilizable({ ...base, resultado: 'condicionado' })).toBeNull();
  });

  it('no se promete: co-arrendatario, rechazado, cerrado, con contrato o titular de la reserva', () => {
    expect(motivoNoReutilizable({ ...base, tipo: 'con_coarrendatario' })).toMatch(/co-arrendatario/);
    expect(motivoNoReutilizable({ ...base, resultado: 'rechazado' })).toMatch(/no quedó aprobado/);
    expect(motivoNoReutilizable({ ...base, expedienteEstado: 'cerrado' })).toMatch(/cerrado/);
    expect(motivoNoReutilizable({ ...base, contratos: [{ numero: 'CT-1', estado: 'firmado', fecha_firma: '2026-09-01' }] })).toMatch(/CT-1/);
    expect(motivoNoReutilizable({ ...base, contratos: [{ numero: 'CT-2', estado: 'cancelado', fecha_firma: null }] })).toBeNull();
    expect(motivoNoReutilizable({ ...base, titularDeReserva: true })).toMatch(/reservada/);
  });

  it('fuera de la tolerancia del 15 % contra la propiedad del paso 1: dice el porqué', () => {
    const caro = evaluarPortabilidad({ topeCop: 20_000_000, canonOriginal: 2_000_000, ingresoOriginal: null, canonDestino: 2_400_000 });
    expect(motivoNoReutilizable({ ...base, destino: { mismaPropiedad: false, mismaCartera: true, veredicto: caro } })).toMatch(
      /supera en mas de 15%.*estudio nuevo/,
    );
    expect(motivoNoReutilizable({ ...base, destino: { mismaPropiedad: false, mismaCartera: false, veredicto: null } })).toMatch(/otra cartera/);
    expect(motivoNoReutilizable({ ...base, destino: { mismaPropiedad: true, mismaCartera: true, veredicto: null } })).toMatch(/misma propiedad/);
  });

  it('misma cartera: misma organizacion, o el mismo propietario individual', () => {
    expect(esMismaCartera('org-1', { inmobiliaria_id: 'org-1', propietario_id: 'a' }, { inmobiliaria_id: 'org-1', propietario_id: 'b' })).toBe(true);
    expect(esMismaCartera('org-1', { inmobiliaria_id: 'org-1', propietario_id: 'a' }, { inmobiliaria_id: 'org-2', propietario_id: 'a' })).toBe(false);
    expect(esMismaCartera(null, { inmobiliaria_id: null, propietario_id: 'p1' }, { inmobiliaria_id: null, propietario_id: 'p2' })).toBe(false);
    expect(esMismaCartera(null, { inmobiliaria_id: null, propietario_id: 'p1' }, { inmobiliaria_id: null, propietario_id: 'p1' })).toBe(true);
  });
});

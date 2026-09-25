import { describe, it, expect, vi, beforeEach } from 'vitest';

// Portabilidad (§4.3): la regla canon/ingreso del destino se compara con el
// ingreso con el que se DECIDIO el estudio, el ajustado de la Adenda §1.1.

const { filas } = vi.hoisted(() => ({ filas: [] as Array<Record<string, unknown> | null> }));

vi.mock('@/config', () => ({ env: new Proxy({}, { get: () => false }) }));
vi.mock('@/config/env', () => ({ env: new Proxy({}, { get: () => false }) }));
vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: filas.shift() ?? null, error: null });
  return { supabase: { from: () => chain } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../certificado.service', () => ({ generarCertificado: vi.fn() }));

import { leerIngresoInferidoOriginal, contratoQueBloqueaReasignacion } from '../reasignacion.service';
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

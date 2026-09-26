import { describe, it, expect, vi, beforeEach } from 'vitest';

// P2 (decisión 2026-09-24): el coarrendatario cuenta —prima 10 %, firma, tarifa
// 2,5 %— solo si su evaluación terminó y no salió rechazada. Mock de Supabase con
// colas por tabla (una tabla sin cola responde { data: null, error: null }).

const { mockFrom, enqueue, queues } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const next = (table: string): Res => queues.get(table)?.shift() ?? { data: null, error: null };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit']) chain[m] = () => chain;
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const mockCobrado = vi.hoisted(() => vi.fn(async (_: string) => true));
vi.mock('../pago.guard', () => ({ estudioYaCobrado: (id: string) => mockCobrado(id) }));

import {
  coarrendatarioVinculado,
  coarrendatarioVinculadoVerificado,
  coarrendatarioVigente,
  ventanaCoarrendatario,
} from '../coarrendatario-vinculado';

const EXP = 'exp-1';
const fila = { data: { id: 'coa-1', nombre: 'Luis', estudio_id: 'est-coa' }, error: null };

beforeEach(() => {
  queues.clear();
  mockFrom.mockClear();
});

describe('coarrendatarioVinculado — P2', () => {
  it.each([
    ['rechazada', { estado: 'completado', resultado: 'rechazado' }],
    ['fallida', { estado: 'fallido', resultado: 'pendiente' }],
    ['sin pagar', { estado: 'pago_pendiente', resultado: 'pendiente' }],
    ['en curso', { estado: 'en_proceso', resultado: 'pendiente' }],
  ])('con la evaluación %s no cuenta (20 % y contrato sin él)', async (_, estudio) => {
    enqueue('expediente_coarrendatarios', fila);
    enqueue('estudios', { data: estudio, error: null });

    expect(await coarrendatarioVinculado(EXP)).toBeNull();
  });

  it('con la evaluación terminada y no rechazada cuenta, con su puntaje', async () => {
    enqueue('expediente_coarrendatarios', fila);
    enqueue('estudios', { data: { estado: 'completado', resultado: 'condicionado' }, error: null });
    enqueue('estudios_scorecard_sombra', { data: { puntaje_normalizado: '82.5' }, error: null });

    expect(await coarrendatarioVinculado(EXP)).toEqual({ id: 'coa-1', nombre: 'Luis', estudioId: 'est-coa', puntaje: 82.5 });
  });

  // Revisión 2026-09-24 (plata): un contrato fijo sin él manda sobre la evaluación.
  const cuenta = () => {
    enqueue('expediente_coarrendatarios', fila);
    enqueue('estudios', { data: { estado: 'completado', resultado: 'aprobado' }, error: null });
  };

  it.each([
    ['anterior vivo que no lo imprimió', [{ id: 'c1', estado: 'vigente', destinacion: null, coa_anidado: null, coa_plano: '' }], []],
    ['V3 enviado a firma sin él en sus partes', [{ id: 'c3', estado: 'pendiente_firma', destinacion: 'vivienda' }], []],
  ])('contrato %s: no cuenta aunque su evaluación terminó bien', async (_, contratos, partes) => {
    enqueue('contratos', { data: contratos, error: null });
    enqueue('contrato_partes', { data: partes, error: null });
    cuenta();

    expect(await coarrendatarioVinculado(EXP)).toBeNull();
  });

  it.each([
    ['borrador V3 (se regenera con lo vivo)', [{ id: 'c3', estado: 'borrador', destinacion: 'vivienda' }], []],
    ['V3 en firma con él en sus partes', [{ id: 'c3', estado: 'pendiente_firma', destinacion: 'vivienda' }], [{ contrato_id: 'c3' }]],
    ['anterior que sí lo imprimió', [{ id: 'c1', estado: 'vigente', destinacion: null, coa_anidado: { nombre_completo: 'Luis Gómez' } }], []],
  ])('contrato %s: sigue la regla de su evaluación', async (_, contratos, partes) => {
    enqueue('contratos', { data: contratos, error: null });
    enqueue('contrato_partes', { data: partes, error: null });
    cuenta();

    expect(await coarrendatarioVinculado(EXP)).toMatchObject({ id: 'coa-1' });
  });

  it('para el CRC y la tarifa: un error de lectura es 503, no «solo» (no imprime un 20 % falso)', async () => {
    enqueue('expediente_coarrendatarios', fila);
    enqueue('estudios', { data: null, error: { message: 'timeout' } });

    await expect(coarrendatarioVinculadoVerificado(EXP)).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'LECTURA_NO_VERIFICABLE',
    });
  });

  it('un error de lectura es «solo»; en modo estricto se propaga', async () => {
    enqueue('expediente_coarrendatarios', fila, fila);
    enqueue('estudios', { data: null, error: { message: 'timeout' } }, { data: null, error: { message: 'timeout' } });

    expect(await coarrendatarioVinculado(EXP)).toBeNull();
    await expect(coarrendatarioVinculado(EXP, { estricto: true })).rejects.toThrow('timeout');
  });
});

// Decisiones 2 y 4 (2026-09-25): la ventana del co-arrendatario.
describe('coarrendatarioVigente / ventanaCoarrendatario — Decisiones 2 y 4', () => {
  const sinEl = { data: [{ id: 'c1', estado: 'vigente', destinacion: null, coa_anidado: null, coa_plano: '' }], error: null };
  const ventana = (estado: string, inmobiliariaId: string | null = 'org-1') =>
    ventanaCoarrendatario({ expedienteId: EXP, estado, inmobiliariaId });

  it('en revisión sí, sin leer contratos; resuelto o cerrado no', async () => {
    expect(await coarrendatarioVigente('condicionado', EXP)).toBe(true);
    for (const estado of ['rechazado', 'cerrado', 'en_revision', 'borrador']) expect(await coarrendatarioVigente(estado, EXP)).toBe(false);
    expect(mockFrom).not.toHaveBeenCalledWith('contratos');
  });

  it('aprobado: sí mientras ningún contrato fijo vaya sin él', async () => {
    expect(await coarrendatarioVigente('aprobado', EXP)).toBe(true);
    enqueue('contratos', sinEl);
    expect(await coarrendatarioVigente('aprobado', EXP)).toBe(false);
  });

  it('aprobado sin poder leer los contratos: 503, no se consulta el buró a ciegas', async () => {
    enqueue('contratos', { data: null, error: { message: 'boom' } });
    await expect(coarrendatarioVigente('aprobado', EXP)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('aprobado y pagado, canal de inmobiliaria: se puede invitar', async () => {
    expect(await ventana('aprobado')).toEqual({ vigente: true, puede_invitar: true, motivo: null, codigo: null });
  });

  it('propietario directo: nunca, ni en revisión (espera el Convenio); la invitación viva sigue en pie', async () => {
    expect(await ventana('condicionado', null)).toMatchObject({ vigente: true, puede_invitar: false, codigo: 'COARRENDATARIO_CANAL_PROPIETARIO' });
  });

  it('aprobado con un contrato fijo sin él, o sin el pago del estudio: no', async () => {
    enqueue('contratos', sinEl);
    expect(await ventana('aprobado')).toMatchObject({ vigente: false, puede_invitar: false, codigo: 'CONTRATO_SIN_COARRENDATARIO' });
    mockCobrado.mockResolvedValueOnce(false);
    expect(await ventana('aprobado')).toMatchObject({ vigente: true, puede_invitar: false, codigo: 'PAGO_ESTUDIO_REQUERIDO' });
  });

  it('rechazado: no, con el código de siempre', async () => {
    expect(await ventana('rechazado')).toMatchObject({ vigente: false, puede_invitar: false, codigo: 'EXPEDIENTE_NO_CONDICIONADO' });
  });
});

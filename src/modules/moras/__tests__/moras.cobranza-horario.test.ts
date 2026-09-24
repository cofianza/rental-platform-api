import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Ley 2300 de 2023: el WhatsApp de cobro fuera de la franja (L-V 7-19, sáb
// 8-15, sin domingos ni festivos) o con otra gestión ese día al mismo deudor
// queda programado —no se pierde— y lo manda el barrido horario.
// Mismo mock de Supabase con colas por tabla que el resto de moras.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues, mockEnviarTemplate } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'eq', 'in', 'order', 'range', 'limit', 'lte'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    resetQueues: () => queues.clear(),
    mockEnviarTemplate: vi.fn(async (..._a: unknown[]) => 'aceptado'),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: {} })); // plantillas de mora v2 (P28) apagadas
vi.mock('../../whatsapp', () => ({ enviarTemplate: mockEnviarTemplate }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn() }));
vi.mock('@/modules/users/users.service', () => ({ listOperators: async () => [] }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(),
  resolveAllowedExpedienteIds: async () => null,
}));

import { reportarMora, autoEscalar } from '../moras.service';

const co = (fechaHora: string) => new Date(`${fechaHora}:00-05:00`);
const INPUT = { contrato_id: 'c1', monto_mora: 1_500_000, fecha_vencimiento_canon: '2026-09-05' };

/** Lo que leen snapshotContrato, el chequeo de duplicado y el insert; `ultima` = última gestión al teléfono. */
function prepararReporte(ultima: string | null, programar: Record<string, unknown> = { error: null }) {
  enqueue('contratos', { data: { id: 'c1', expediente_id: 'exp1', estado: 'vigente' }, error: null });
  enqueue('expedientes', { data: { id: 'exp1', solicitante_id: 's1', inmueble_id: 'i1' }, error: null });
  enqueue('solicitantes', { data: { nombre: 'Ana', apellido: 'Pérez', email: 'a@b.co', telefono: '3001112233' } });
  enqueue('inmuebles', { data: { codigo: 'A1', direccion: 'Cra 7 # 45-10', propietario_id: 'p1' }, error: null });
  enqueue('moras_tickets',
    { data: null, error: null }, // sin mora activa del mismo canon
    {
      data: {
        id: 'm1', ticket_numero: 'MOR-2026-001', inquilino_telefono: '3001112233',
        inquilino_nombre: 'Ana Pérez', inmueble_direccion: 'Cra 7 # 45-10', monto_mora: 1_500_000,
      },
      error: null,
    },
    { data: [{ id: 'm1' }, { id: 'm0' }], error: null }, // moras de ese teléfono
    programar, // update de whatsapp_programado_para
    { data: { id: 'm1' }, error: null }, // getMoraById
  );
  enqueue('moras_mensajes', { data: ultima ? { created_at: ultima } : null, error: null });
}

const updatesProgramacion = () =>
  ops
    .filter((o) => o.table === 'moras_tickets' && o.method === 'update')
    .map((o) => (o.args[0] as { whatsapp_programado_para?: string | null }).whatsapp_programado_para);
const mensajes = () =>
  ops
    .filter((o) => o.table === 'moras_mensajes' && o.method === 'insert')
    .map((o) => o.args[0] as { mensaje: string; via_whatsapp: boolean });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  resetQueues();
  ops.length = 0;
  mockEnviarTemplate.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('reportarMora — horario de cobranza', () => {
  it('un sábado a las 8 p. m. el WhatsApp queda para el lunes a las 7 a. m.', async () => {
    vi.setSystemTime(co('2026-09-26T20:00'));
    prepararReporte(null);

    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');

    expect(mockEnviarTemplate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ whatsapp_estado: 'programado', whatsapp_programado_para: co('2026-09-28T07:00').toISOString() });
    expect(updatesProgramacion()).toEqual([co('2026-09-28T07:00').toISOString()]);
    expect(mensajes()[0].via_whatsapp).toBe(false);
    expect(mensajes()[0].mensaje).toContain('Ley 2300');
  });

  it('si el deudor ya tuvo una gestión hoy, sale al día siguiente', async () => {
    vi.setSystemTime(co('2026-09-29T10:00'));
    prepararReporte(co('2026-09-29T08:00').toISOString());

    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');

    expect(mockEnviarTemplate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ whatsapp_programado_para: co('2026-09-30T07:00').toISOString() });
  });

  it('en horario y sin gestión hoy sale ya, y cuenta como la gestión del día', async () => {
    vi.setSystemTime(co('2026-09-29T10:00'));
    prepararReporte(co('2026-09-28T18:00').toISOString());

    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');

    expect(mockEnviarTemplate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ whatsapp_estado: 'aceptado', whatsapp_programado_para: null });
    expect(updatesProgramacion()).toEqual([null]); // descarta lo que hubiera programado
    expect(mensajes()[0].via_whatsapp).toBe(true);
  });

  it('sin la columna (migración sin correr) no se pierde: sale ya', async () => {
    vi.setSystemTime(co('2026-09-26T20:00'));
    prepararReporte(null, { error: { message: 'column "whatsapp_programado_para" does not exist' } });

    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');

    expect(mockEnviarTemplate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ whatsapp_estado: 'aceptado' });
  });
});

describe('autoEscalar — barrido de lo programado', () => {
  const PROGRAMADO = '2026-09-28T12:00:00+00:00';
  const programada = {
    id: 'm1', estado: 'fase_2', whatsapp_programado_para: PROGRAMADO, inquilino_telefono: '3001112233',
    inquilino_nombre: 'Ana Pérez', inmueble_direccion: 'Cra 7', monto_mora: 1_500_000, fecha_vencimiento_canon: '2026-09-05',
  };
  const prepararBarrido = (ultima: string | null, reclamo: Record<string, unknown>) => {
    enqueue('moras_tickets',
      { data: [programada], error: null }, // programados ya vencidos
      { data: [{ id: 'm1' }], error: null }, // moras de ese teléfono
      reclamo, // update condicionado
      { data: [], error: null }, // nada en fase_1 para escalar
      { data: [], error: null }, // nada en fase_2 para escalar
    );
    enqueue('moras_mensajes', { data: ultima ? { created_at: ultima } : null, error: null });
  };

  it('el lunes a las 7:30 manda el de la fase en que está hoy la mora, una sola vez', async () => {
    vi.setSystemTime(co('2026-09-28T07:30'));
    prepararBarrido(null, { data: [{ id: 'm1' }], error: null });

    const r = await autoEscalar();

    expect(r).toEqual({ aFase2: 0, aFase3: 0, cobrosProgramados: 1 });
    expect(mockEnviarTemplate).toHaveBeenCalledTimes(1);
    expect(mockEnviarTemplate.mock.calls[0][0]).toMatchObject({ template: 'MORA_FASE_2' });
    expect(updatesProgramacion()).toEqual([null]);
    expect(ops).toContainEqual({ table: 'moras_tickets', method: 'eq', args: ['whatsapp_programado_para', PROGRAMADO] });
    expect(mensajes()[0].via_whatsapp).toBe(true);
  });

  it('si otra mora del mismo deudor ya tuvo gestión hoy, lo corre a mañana sin enviar', async () => {
    vi.setSystemTime(co('2026-09-28T07:30'));
    prepararBarrido(co('2026-09-28T07:10').toISOString(), { data: [{ id: 'm1' }], error: null });

    const r = await autoEscalar();

    expect(r.cobrosProgramados).toBe(0);
    expect(mockEnviarTemplate).not.toHaveBeenCalled();
    expect(updatesProgramacion()).toEqual([co('2026-09-29T07:00').toISOString()]);
  });

  it('si otra corrida ya lo tomó, no lo manda otra vez', async () => {
    vi.setSystemTime(co('2026-09-28T07:30'));
    prepararBarrido(null, { data: [], error: null });

    await autoEscalar();

    expect(mockEnviarTemplate).not.toHaveBeenCalled();
  });
});

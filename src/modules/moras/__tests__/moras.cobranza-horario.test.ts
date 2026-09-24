import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Ley 2300 de 2023: el WhatsApp de cobro fuera de la franja (L-V 7-19, sáb
// 8-15, sin domingos ni festivos) o con otra gestión ese día al mismo deudor
// queda programado —no se pierde— y lo manda su propio barrido. La gestión del
// día se toma ANTES de enviar (moras_gestiones_diarias, llave teléfono + día).
// Mismo mock de Supabase con colas por tabla que el resto de moras.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues, mockEnviarTemplate, mockEnv, mockNotificar } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'eq', 'is', 'not', 'in', 'order', 'range', 'limit', 'lte'];
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
    mockEnv: { MORAS_COBROS_PROGRAMADOS_ENABLED: true },
    mockNotificar: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('../../whatsapp', () => ({ enviarTemplate: mockEnviarTemplate }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: mockNotificar }));
vi.mock('@/modules/users/users.service', () => ({ listOperators: async () => [{ id: 'op1' }] }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(),
  resolveAllowedExpedienteIds: async () => null,
}));

import { reportarMora, enviarCobrosProgramados } from '../moras.service';

const co = (fechaHora: string) => new Date(`${fechaHora}:00-05:00`);
const INPUT = { contrato_id: 'c1', monto_mora: 1_500_000, fecha_vencimiento_canon: '2026-09-05' };

/** Lo que leen snapshotContrato, el chequeo de duplicado y el insert; `programar` = respuesta del update de la cola. */
function prepararReporte(programar: Record<string, unknown> = { error: null }) {
  enqueue('contratos', { data: { id: 'c1', expediente_id: 'exp1', estado: 'vigente' }, error: null });
  enqueue('expedientes', { data: { id: 'exp1', solicitante_id: 's1', inmueble_id: 'i1' }, error: null });
  enqueue('solicitantes', { data: { nombre: 'Ana', apellido: 'Pérez', email: 'a@b.co', telefono: '+57 300 111 2233' } });
  enqueue('inmuebles', { data: { codigo: 'A1', direccion: 'Cra 7 # 45-10', propietario_id: 'p1' }, error: null });
  enqueue('moras_tickets',
    { data: null, error: null }, // sin mora activa del mismo canon
    {
      data: {
        id: 'm1', ticket_numero: 'MOR-2026-001', inquilino_telefono: '+57 300 111 2233',
        inquilino_nombre: 'Ana Pérez', inmueble_direccion: 'Cra 7 # 45-10', monto_mora: 1_500_000,
      },
      error: null,
    },
    programar, // update de whatsapp_programado_para
    { data: { id: 'm1' }, error: null }, // getMoraById
  );
}

const updatesCola = () =>
  ops
    .filter((o) => o.table === 'moras_tickets' && o.method === 'update')
    .map((o) => (o.args[0] as { whatsapp_programado_para?: string | null }).whatsapp_programado_para);
const mensajes = () =>
  ops
    .filter((o) => o.table === 'moras_mensajes' && o.method === 'insert')
    .map((o) => o.args[0] as { mensaje: string; via_whatsapp: boolean });
const gestiones = () =>
  ops.filter((o) => o.table === 'moras_gestiones_diarias' && o.method === 'insert').map((o) => o.args[0]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  resetQueues();
  ops.length = 0;
  mockEnviarTemplate.mockClear();
  mockNotificar.mockClear();
  mockEnv.MORAS_COBROS_PROGRAMADOS_ENABLED = true;
});
afterEach(() => vi.useRealTimers());

describe('reportarMora — horario de cobranza', () => {
  it('un sábado a las 8 p. m. el WhatsApp queda para el lunes a las 7 a. m.', async () => {
    vi.setSystemTime(co('2026-09-26T20:00'));
    prepararReporte();

    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');

    expect(mockEnviarTemplate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ whatsapp_estado: 'programado', whatsapp_programado_para: co('2026-09-28T07:00').toISOString() });
    expect(updatesCola()).toEqual([co('2026-09-28T07:00').toISOString()]);
    expect(gestiones()).toEqual([]); // la gestión se toma al enviar
    expect(mensajes()[0].via_whatsapp).toBe(false);
    expect(mensajes()[0].mensaje).toContain('Ley 2300');
  });

  it('en horario toma la gestión del día ANTES de enviar, con el teléfono normalizado', async () => {
    vi.setSystemTime(co('2026-09-29T10:00'));
    prepararReporte();

    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');

    expect(gestiones()).toEqual([{ telefono: '573001112233', dia: '2026-09-29', mora_id: 'm1' }]);
    const tomada = ops.findIndex((o) => o.table === 'moras_gestiones_diarias');
    const envio = ops.findIndex((o) => o.table === 'moras_mensajes');
    expect(tomada).toBeLessThan(envio);
    expect(mockEnviarTemplate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ whatsapp_estado: 'aceptado', whatsapp_programado_para: null });
    expect(updatesCola()).toEqual([null]); // descarta lo que hubiera programado
    expect(mensajes()[0].via_whatsapp).toBe(true);
  });

  it('si el deudor ya tuvo su gestión hoy (llave repetida), sale al día siguiente', async () => {
    vi.setSystemTime(co('2026-09-29T10:00'));
    prepararReporte();
    enqueue('moras_gestiones_diarias', { error: { code: '23505', message: 'duplicate key' } });

    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');

    expect(mockEnviarTemplate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ whatsapp_estado: 'programado', whatsapp_programado_para: co('2026-09-30T07:00').toISOString() });
  });

  it('sin la columna (migración sin correr) no se pierde: sale ya', async () => {
    vi.setSystemTime(co('2026-09-26T20:00'));
    prepararReporte({ error: { code: 'PGRST204', message: "Could not find the 'whatsapp_programado_para' column" } });

    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');

    expect(mockEnviarTemplate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ whatsapp_estado: 'aceptado' });
  });

  it('un error de red al programar no manda el cobro de noche', async () => {
    vi.setSystemTime(co('2026-09-26T20:00'));
    prepararReporte({ error: { message: 'TypeError: fetch failed' } });

    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');

    expect(mockEnviarTemplate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ whatsapp_estado: 'fallido' });
    expect(mensajes()[0].mensaje).toContain('avísale por otro medio');
  });

  it('con el envío automático apagado no promete la hora: queda en espera y lo dice', async () => {
    mockEnv.MORAS_COBROS_PROGRAMADOS_ENABLED = false;
    vi.setSystemTime(co('2026-09-26T20:00'));
    prepararReporte();

    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');

    expect(mockEnviarTemplate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ whatsapp_estado: 'retenido' });
    expect(mensajes()[0].mensaje).toContain('el envío automático está apagado');
    expect(mensajes()[0].mensaje).not.toContain('sale el');
  });
});

describe('enviarCobrosProgramados — el barrido de la Ley 2300', () => {
  const PROGRAMADO = '2026-09-28T12:00:00+00:00';
  const programada = {
    id: 'm1', ticket_numero: 'MOR-2026-001', estado: 'fase_2', expediente_id: 'exp1', whatsapp_programado_para: PROGRAMADO,
    inquilino_telefono: '3001112233', inquilino_nombre: 'Ana Pérez', inmueble_direccion: 'Cra 7', monto_mora: 1_500_000,
    fecha_vencimiento_canon: '2026-09-05',
  };
  const prepararBarrido = (reclamo: Record<string, unknown>) =>
    enqueue('moras_tickets',
      { data: [programada], error: null }, // programados ya vencidos
      reclamo, // update condicionado (tomar la fila)
    );

  it('el lunes a las 7:30 manda el de la fase en que está hoy la mora, una sola vez', async () => {
    vi.setSystemTime(co('2026-09-28T07:30'));
    prepararBarrido({ data: [{ id: 'm1' }], error: null });

    await expect(enviarCobrosProgramados()).resolves.toBe(1);

    expect(mockEnviarTemplate).toHaveBeenCalledTimes(1);
    expect(mockEnviarTemplate.mock.calls[0][0]).toMatchObject({ template: 'MORA_FASE_2' });
    expect(ops).toContainEqual({ table: 'moras_tickets', method: 'eq', args: ['whatsapp_programado_para', PROGRAMADO] });
    expect(ops).toContainEqual({ table: 'moras_tickets', method: 'is', args: ['whatsapp_pausado_at', null] });
    expect(gestiones()).toEqual([{ telefono: '573001112233', dia: '2026-09-28', mora_id: 'm1' }]);
    expect(mensajes()[0]).toMatchObject({ via_whatsapp: true });
    expect(mensajes()[0].mensaje).toContain('Se envió el WhatsApp');
  });

  it('si el deudor ya tuvo su gestión hoy, lo corre a mañana sin enviar', async () => {
    vi.setSystemTime(co('2026-09-28T07:30'));
    prepararBarrido({ data: [{ id: 'm1' }], error: null });
    enqueue('moras_gestiones_diarias', { error: { code: '23505', message: 'duplicate key' } });

    await expect(enviarCobrosProgramados()).resolves.toBe(0);

    expect(mockEnviarTemplate).not.toHaveBeenCalled();
    expect(updatesCola()).toEqual([null, co('2026-09-29T07:00').toISOString()]);
    expect(mensajes()).toEqual([]);
  });

  it('si otra corrida ya lo tomó, no lo manda otra vez', async () => {
    vi.setSystemTime(co('2026-09-28T07:30'));
    prepararBarrido({ data: [], error: null });

    await enviarCobrosProgramados();

    expect(mockEnviarTemplate).not.toHaveBeenCalled();
    expect(gestiones()).toEqual([]);
  });

  it('si el envío falla, el historial no dice que salió y Cofianza se entera', async () => {
    vi.setSystemTime(co('2026-09-28T07:30'));
    prepararBarrido({ data: [{ id: 'm1' }], error: null });
    mockEnviarTemplate.mockResolvedValueOnce('fallido');

    await expect(enviarCobrosProgramados()).resolves.toBe(0);

    expect(mensajes()[0]).toMatchObject({ via_whatsapp: false });
    expect(mensajes()[0].mensaje).toContain('falló');
    expect(mensajes()[0].mensaje).not.toMatch(/enviado|Se envió/);
    expect(mockNotificar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'op1', tipo: 'mora.whatsapp_fallido' }));
  });
});

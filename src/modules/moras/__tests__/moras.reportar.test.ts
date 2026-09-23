import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Reportar y escalar moras: lo que queda escrito y lo que se le dice a la
// persona tiene que coincidir con lo que pasó de verdad.
// Mismo mock de Supabase con colas por tabla que moras.acceso.test.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues, mockEnviarTemplate, mockAssertAccess } = vi.hoisted(() => {
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
    enqueue: (table: string, ...items: Res[]) => {
      queues.set(table, [...(queues.get(table) ?? []), ...items]);
    },
    resetQueues: () => queues.clear(),
    mockEnviarTemplate: vi.fn(),
    mockAssertAccess: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../whatsapp', () => ({ enviarTemplate: mockEnviarTemplate }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: (...a: unknown[]) => mockAssertAccess(...a),
  resolveAllowedExpedienteIds: async () => null,
}));

import { reportarMora, escalarMora } from '../moras.service';

const INPUT = { contrato_id: 'c1', monto_mora: 1_500_000, fecha_vencimiento_canon: '2026-09-05' };

/** Encola lo que leen snapshotContrato, el insert y getMoraById. */
function prepararReporte() {
  enqueue('contratos', { data: { id: 'c1', expediente_id: 'exp1', estado: 'vigente' }, error: null });
  enqueue('expedientes', { data: { id: 'exp1', solicitante_id: null, inmueble_id: 'i1' }, error: null });
  enqueue('inmuebles', { data: { codigo: 'A1', direccion: 'Cra 7 # 45-10', propietario_id: 'p1' }, error: null });
  enqueue('moras_tickets',
    { data: null, error: null }, // sin mora activa del mismo canon
    {
      data: {
        id: 'm1', ticket_numero: 'MOR-2026-001', inquilino_telefono: null,
        inquilino_nombre: 'Ana Pérez', inmueble_direccion: 'Cra 7 # 45-10', monto_mora: 1_500_000,
      },
      error: null,
    },
    { data: { id: 'm1' }, error: null }, // getMoraById
  );
}

const mensajesDeSistema = () =>
  ops
    .filter((o) => o.table === 'moras_mensajes' && o.method === 'insert')
    .map((o) => (o.args[0] as { mensaje: string }).mensaje);

beforeEach(() => {
  resetQueues();
  ops.length = 0;
  mockEnviarTemplate.mockReset();
  mockAssertAccess.mockReset().mockResolvedValue(undefined);
});

describe('reportarMora — el aviso al inquilino', () => {
  it('sin teléfono no afirma que se le avisó y devuelve el estado del WhatsApp', async () => {
    mockEnviarTemplate.mockResolvedValue('sin_telefono');
    prepararReporte();
    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');
    expect(r).toMatchObject({ whatsapp_estado: 'sin_telefono' });
    expect(mensajesDeSistema()).toEqual([
      'Mora reportada — Fase 1 (Recordatorio). No se pudo avisar por WhatsApp: el inquilino no tiene teléfono registrado.',
    ]);
  });

  it('si Meta rechaza el envío lo deja dicho', async () => {
    mockEnviarTemplate.mockResolvedValue('fallido');
    prepararReporte();
    const r = await reportarMora(INPUT as never, 'u1', 'inmobiliaria');
    expect(r).toMatchObject({ whatsapp_estado: 'fallido' });
    expect(mensajesDeSistema()[0]).toContain('El WhatsApp al inquilino falló');
  });

  it('con el envío aceptado dice que se envió', async () => {
    mockEnviarTemplate.mockResolvedValue('aceptado');
    prepararReporte();
    await reportarMora(INPUT as never, 'u1', 'inmobiliaria');
    expect(mensajesDeSistema()[0]).toContain('Se envió el WhatsApp al inquilino.');
  });
});

describe('escalarMora — el aviso al inquilino', () => {
  it('escalar a un inquilino sin teléfono lo deja dicho en el chat y en la respuesta', async () => {
    mockEnviarTemplate.mockResolvedValue('sin_telefono');
    enqueue('moras_tickets',
      {
        data: {
          id: 'm1', estado: 'fase_1', expediente_id: 'exp1', reportado_por: 'u1',
          reportado_at: new Date().toISOString(), fecha_vencimiento_canon: '2026-09-05',
          inquilino_telefono: null, inquilino_nombre: 'Ana Pérez', inmueble_direccion: 'Cra 7', monto_mora: 1,
          ticket_numero: 'MOR-2026-001',
        },
        error: null,
      },
      { data: null, error: null }, // update
      { data: { id: 'm1' }, error: null }, // getMoraById
    );
    const r = await escalarMora('m1', {}, 'op', 'operador_analista');
    expect(r).toMatchObject({ whatsapp_estado: 'sin_telefono' });
    expect(mensajesDeSistema()[0]).toContain('Escalado a Fase 2 (Urgencia). No se pudo avisar por WhatsApp');
  });
});

describe('reportarMora — una mora activa por canon', () => {
  const prepararContrato = () => {
    enqueue('contratos', { data: { id: 'c1', expediente_id: 'exp1', estado: 'vigente' }, error: null });
    enqueue('expedientes', { data: { id: 'exp1', solicitante_id: null, inmueble_id: 'i1' }, error: null });
    enqueue('inmuebles', { data: { codigo: 'A1', direccion: 'Cra 7', propietario_id: 'p1' }, error: null });
  };

  it('si ya hay una activa del mismo canon responde 409 sin insertar ni escribir al inquilino', async () => {
    prepararContrato();
    enqueue('moras_tickets', { data: { ticket_numero: 'MOR-2026-001' }, error: null });
    await expect(reportarMora(INPUT as never, 'u2', 'inmobiliaria')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'MORA_DUPLICADA',
    });
    expect(ops.filter((o) => o.method === 'insert')).toEqual([]);
    expect(mockEnviarTemplate).not.toHaveBeenCalled();
    const filtros = ops.filter((o) => o.table === 'moras_tickets' && o.method === 'eq').map((o) => o.args);
    expect(filtros).toEqual([['contrato_id', 'c1'], ['fecha_vencimiento_canon', '2026-09-05']]);
  });

  it('dos reportes a la vez: el índice único se traduce al mismo 409', async () => {
    prepararContrato();
    enqueue('moras_tickets',
      { data: null, error: null }, // no había activa al mirar
      { data: null, error: { code: '23505', message: 'duplicate key' } }, // la otra ganó
    );
    await expect(reportarMora(INPUT as never, 'u2', 'inmobiliaria')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'MORA_DUPLICADA',
    });
    expect(mockEnviarTemplate).not.toHaveBeenCalled();
  });
});

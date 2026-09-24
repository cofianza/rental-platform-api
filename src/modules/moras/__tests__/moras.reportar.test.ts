import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Reportar y escalar moras: lo que queda escrito y lo que se le dice a la
// persona tiene que coincidir con lo que pasó de verdad.
// Mismo mock de Supabase con colas por tabla que moras.acceso.test.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues, mockEnviarTemplate, mockAssertAccess, mockNotificar, mockListOperators } = vi.hoisted(() => {
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
    mockNotificar: vi.fn(),
    mockListOperators: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../whatsapp', () => ({ enviarTemplate: mockEnviarTemplate }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: (...a: unknown[]) => mockAssertAccess(...a),
  resolveAllowedExpedienteIds: async () => null,
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: (...a: unknown[]) => mockNotificar(...a),
}));
vi.mock('@/modules/users/users.service', () => ({ listOperators: () => mockListOperators() }));

import { reportarMora, escalarMora, autoEscalar, marcarPagada, cancelarMora, getMoraById } from '../moras.service';
import { reportarMoraSchema } from '../moras.schema';

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
  // Martes 10 a. m. en Colombia: dentro del horario de cobranza (Ley 2300).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T10:00:00-05:00'));
  resetQueues();
  ops.length = 0;
  mockEnviarTemplate.mockReset();
  mockAssertAccess.mockReset().mockResolvedValue(undefined);
  mockNotificar.mockReset().mockResolvedValue(undefined);
  mockListOperators.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

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
      { data: [{ id: 'm1' }], error: null }, // update (1 fila)
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

describe('fechas de la mora', () => {
  const haceDias = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

  it('no acepta un vencimiento futuro (el canon aún no está en mora)', () => {
    const base = { contrato_id: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', monto_mora: 1 };
    expect(reportarMoraSchema.safeParse({ ...base, fecha_vencimiento_canon: haceDias(-2) }).success).toBe(false);
    expect(reportarMoraSchema.safeParse({ ...base, fecha_vencimiento_canon: haceDias(0) }).success).toBe(true);
  });

  it('el WhatsApp de Fase 1 muestra el día del vencimiento tal cual, sin correrlo por la zona horaria', async () => {
    mockEnviarTemplate.mockResolvedValue('aceptado');
    prepararReporte();
    await reportarMora(INPUT as never, 'u1', 'inmobiliaria');
    expect((mockEnviarTemplate.mock.calls[0][0] as { variables: string[] }).variables[3]).toMatch(/^05/);
  });

  it('al escalar, los días en mora se cuentan desde el vencimiento, no desde el reporte', async () => {
    mockEnviarTemplate.mockResolvedValue('aceptado');
    enqueue('moras_tickets',
      {
        data: {
          id: 'm1', estado: 'fase_1', expediente_id: 'exp1', reportado_por: 'u1',
          reportado_at: new Date().toISOString(), fecha_vencimiento_canon: haceDias(25),
          inquilino_telefono: '573001112233', inquilino_nombre: 'Ana Pérez', inmueble_direccion: 'Cra 7', monto_mora: 1,
          ticket_numero: 'MOR-2026-001',
        },
        error: null,
      },
      { data: [{ id: 'm1' }], error: null },
      { data: [], error: null }, // moras del teléfono (sin gestión previa)
      { data: null, error: null }, // whatsapp_programado_para → null
      { data: { id: 'm1' }, error: null },
    );
    await escalarMora('m1', {}, 'op', 'operador_analista');
    expect((mockEnviarTemplate.mock.calls[0][0] as { variables: string[] }).variables[3]).toBe('25');
  });
});

describe('aviso al equipo de Cofianza', () => {
  const moraEnFase = (estado: string) => ({
    data: {
      id: 'm1', ticket_numero: 'MOR-2026-007', estado, expediente_id: 'exp1', reportado_por: 'dueno',
      reportado_at: new Date().toISOString(), fecha_vencimiento_canon: '2026-09-05',
      inquilino_telefono: '573001112233', inquilino_nombre: 'Ana Pérez', inmueble_direccion: 'Cra 7', monto_mora: 1_500_000,
    },
    error: null,
  });
  const avisos = () => mockNotificar.mock.calls.map((c) => c[0] as { userId: string; tipo: string; link: string; titulo: string });

  it('al reportar se avisa a los internos, menos a quien reportó', async () => {
    mockEnviarTemplate.mockResolvedValue('aceptado');
    mockListOperators.mockResolvedValue([{ id: 'op1' }, { id: 'admin1' }]);
    prepararReporte();
    await reportarMora(INPUT as never, 'op1', 'operador_analista');
    expect(avisos()).toEqual([
      expect.objectContaining({ userId: 'admin1', tipo: 'mora.reportada', link: '/moras', titulo: 'Nueva mora reportada — MOR-2026-001' }),
    ]);
  });

  it('el escalado a Fase 3 avisa (el inquilino espera contacto); el de Fase 2 no', async () => {
    mockEnviarTemplate.mockResolvedValue('aceptado');
    mockListOperators.mockResolvedValue([{ id: 'op1' }]);
    // Las dos las escala Cofianza: el dueño no adelanta la Fase 2 ni pide la 3 (P27).
    const escalado = [{ data: [{ id: 'm1' }], error: null }, { data: [], error: null }, { data: null, error: null }, { data: { id: 'm1' }, error: null }];
    enqueue('moras_tickets', moraEnFase('fase_1'), ...escalado);
    await escalarMora('m1', {}, 'op2', 'operador_analista');
    expect(avisos()).toEqual([]);

    enqueue('moras_tickets', moraEnFase('fase_2'), ...escalado);
    await escalarMora('m1', {}, 'op2', 'operador_analista');
    expect(avisos()).toEqual([expect.objectContaining({ userId: 'op1', tipo: 'mora.fase_3', titulo: 'Mora en Fase 3 — MOR-2026-007' })]);
  });

  it('el escalado automático a Fase 3 también avisa', async () => {
    mockEnviarTemplate.mockResolvedValue('aceptado');
    mockListOperators.mockResolvedValue([{ id: 'op1' }]);
    enqueue('moras_tickets',
      { data: [], error: null }, // ningún WhatsApp programado
      { data: [], error: null }, // nada en fase_1
      { data: [moraEnFase('fase_2').data], error: null },
      { data: [{ id: 'm1' }], error: null }, // update → fase_3
    );
    await expect(autoEscalar()).resolves.toEqual({ aFase2: 0, aFase3: 1, cobrosProgramados: 0 });
    expect(avisos()).toEqual([expect.objectContaining({ userId: 'op1', tipo: 'mora.fase_3' })]);
  });

  it('si no se pueden listar los internos, el reporte sigue', async () => {
    mockEnviarTemplate.mockResolvedValue('aceptado');
    mockListOperators.mockRejectedValue(new Error('boom'));
    prepararReporte();
    await expect(reportarMora(INPUT as never, 'u1', 'inmobiliaria')).resolves.toMatchObject({ id: 'm1' });
  });
});

describe('rastro de quién gestionó la mora', () => {
  const moraActiva = {
    data: {
      id: 'm1', ticket_numero: 'MOR-2026-001', estado: 'fase_2', expediente_id: 'exp1', reportado_por: 'dueno',
      reportado_at: new Date().toISOString(), fecha_vencimiento_canon: '2026-09-05',
      inquilino_telefono: null, inquilino_nombre: 'Ana Pérez', inmueble_direccion: 'Cra 7', monto_mora: 1,
    },
    error: null,
  };
  const inserts = (table: string) =>
    ops.filter((o) => o.table === table && o.method === 'insert').map((o) => o.args[0] as Record<string, unknown>);

  it.each([
    ['pagada', () => marcarPagada('m1', { notas: 'pagó en efectivo' }, 'miembro1', 'inmobiliaria'), 'mora_pagada', 'miembro1'],
    ['cancelada', () => cancelarMora('m1', { motivo: 'error de registro' }, 'miembro1', 'inmobiliaria'), 'mora_cancelada', 'miembro1'],
    // De Fase 2 a Fase 3 solo escala Cofianza (P27).
    ['escalada', () => escalarMora('m1', {}, 'op1', 'operador_analista'), 'mora_escalada', 'op1'],
  ])('la mora %s deja autor en el chat y registro en la bitácora', async (_n, accion, esperada, autor) => {
    mockEnviarTemplate.mockResolvedValue('sin_telefono');
    enqueue('moras_tickets', moraActiva, { data: [{ id: 'm1' }], error: null }, { data: { id: 'm1' }, error: null });
    await accion();
    expect(inserts('moras_mensajes')[0]).toMatchObject({ autor_tipo: 'sistema', autor_id: autor });
    expect(inserts('bitacora')).toEqual([
      expect.objectContaining({
        usuario_id: autor,
        accion: esperada,
        entidad: 'mora',
        entidad_id: 'm1',
        detalle: expect.objectContaining({ expediente_id: 'exp1', estado_anterior: 'fase_2' }),
      }),
    ]);
  });

  it('el detalle trae el nombre de quien escribió cada mensaje', async () => {
    enqueue('moras_tickets', { data: { id: 'm1' }, error: null });
    enqueue('moras_mensajes', { data: [{ id: 'msg1', autor: { nombre: 'Luisa', apellido: 'Gómez' } }], error: null });
    const r = await getMoraById('m1');
    expect(r.mensajes).toEqual([expect.objectContaining({ autor: { nombre: 'Luisa', apellido: 'Gómez' } })]);
    const select = ops.find((o) => o.table === 'moras_mensajes' && o.method === 'select');
    expect(select?.args[0]).toContain('perfiles!moras_mensajes_autor_id_fkey(nombre, apellido)');
  });
});

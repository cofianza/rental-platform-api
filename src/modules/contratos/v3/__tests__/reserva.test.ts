import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Contratos V3 — barrido de la reserva del inmueble (Adenda 1 contratos,
// respuesta 15): cinco días hábiles sin enviar a firma → se cancela el
// borrador (la cancelación del sistema, con su CAS, se prueba en
// contratos-v3-guards.test.ts) y se avisa a la inmobiliaria.
// Mock de Supabase con colas por tabla (patrón de asistente.service.test).
// ============================================================

const { mockEnv, mockFrom, ops, queues, enqueue, mockCancelar, mockAvisar } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'is', 'not', 'in', 'lt', 'order', 'limit']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockEnv: { CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000, CONTRATOS_V3_ENABLED: true },
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => {
      queues.set(table, [...(queues.get(table) ?? []), ...items]);
    },
    mockCancelar: vi.fn(),
    mockAvisar: vi.fn(async (..._a: unknown[]) => undefined),
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/calibracion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/calibracion')>();
  return { ...actual, getCalibracion: vi.fn(async () => actual.CALIBRACION_DEFAULT) };
});
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: mockAvisar }));
vi.mock('../../contrato-workflow.service', () => ({ cancelarBorradorV3PorSistema: mockCancelar }));

// Import AFTER mocks
import { barrerReservasV3 } from '../reserva';
import { reservaHasta } from '../asistente.reglas';

const MOTIVO = 'Reserva del inmueble vencida: 5 días hábiles sin enviar a firma';
/** Iniciado el lunes 14/09/2026 (10:00 en Bogotá): la reserva va hasta el lunes 21. */
const borrador = (o: Record<string, unknown> = {}) => ({
  id: 'cto-1',
  numero: 'CTO-2026-0007',
  expediente_id: 'exp-1',
  generado_por: 'u-creador',
  created_at: '2026-09-14T15:00:00Z',
  ...o,
});
const EXP = {
  numero: 'EXP-2026-0100',
  inmobiliaria_id: 'org-1',
  miembro_responsable_id: 'u-resp',
  inmuebles: { estado: 'disponible', reservado_por_expediente_id: null },
};
const MIEMBROS = [
  { perfil_id: 'u-creador', rol_miembro: 'miembro' },
  { perfil_id: 'u-resp', rol_miembro: 'miembro' },
  { perfil_id: 'u-titular', rol_miembro: 'owner' },
];
const avisados = () => mockAvisar.mock.calls.map((c) => (c[0] as { userId: string }).userId);

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  mockCancelar.mockResolvedValue(true);
  mockEnv.CONTRATOS_V3_ENABLED = true;
});

describe('reservaHasta', () => {
  it('cinco hábiles desde el día siguiente al inicio (en Bogotá), saltando fines de semana y festivos', () => {
    expect(reservaHasta('2026-09-14T15:00:00Z', 5)).toBe('2026-09-21');
    // Las 21:00 del viernes 9 en Bogotá ya son el sábado 10 en UTC: cuenta el día de Bogotá.
    expect(reservaHasta('2026-10-10T02:00:00Z', 5)).toBe('2026-10-19'); // el lunes 12 es festivo
  });
});

describe('barrerReservasV3', () => {
  it('vencida: cancela con el motivo y avisa (in-app y correo) a quien lo inició y al responsable', async () => {
    enqueue('contratos', { data: [borrador()], error: null });
    enqueue('expedientes', { data: EXP, error: null });
    enqueue('inmobiliaria_miembros', { data: MIEMBROS, error: null });

    await barrerReservasV3(new Date('2026-09-22T15:00:00Z'));

    // Solo borradores V3, y un prefiltro que no deja fuera ninguno vencido (5 hábiles ≥ 5 calendario).
    const filtros = ops.filter((o) => o.table === 'contratos').map((o) => [o.method, ...o.args]);
    expect(filtros).toContainEqual(['not', 'destinacion', 'is', null]);
    expect(filtros).toContainEqual(['eq', 'estado', 'borrador']);
    expect(filtros).toContainEqual(['lt', 'created_at', '2026-09-17T15:00:00.000Z']);
    expect(mockCancelar).toHaveBeenCalledWith('cto-1', MOTIVO);
    expect(avisados()).toEqual(['u-creador', 'u-resp']);
    expect(mockAvisar.mock.calls[0][0]).toMatchObject({
      tipo: 'contrato.reserva_vencida',
      link: '/expedientes/exp-1/contrato',
      payload: { contrato_id: 'cto-1', expediente_id: 'exp-1' },
    });
    const { mensaje } = mockAvisar.mock.calls[0][0] as { mensaje: string };
    expect(mensaje).toContain('del estudio N.° 2026-0100');
    expect(mensaje).toContain('21/09/2026');
    expect(mensaje).toContain('el inmueble quedó libre');
    expect(mensaje).toContain('el asistente trae lo que ya llenaste');
    // El inmueble se lee con la pista de la FK (dos relaciones expedientes↔inmuebles).
    expect(String(ops.find((o) => o.table === 'expedientes' && o.method === 'select')?.args[0])).toContain(
      'inmuebles!expedientes_inmueble_id_fkey(estado, reservado_por_expediente_id)',
    );
  });

  it('si no se comprobó que el inmueble quedó libre, el aviso no lo afirma', async () => {
    enqueue('contratos', { data: [borrador()], error: null });
    enqueue('expedientes', { data: { ...EXP, inmuebles: { estado: 'ocupado', reservado_por_expediente_id: 'exp-1' } }, error: null });
    enqueue('inmobiliaria_miembros', { data: MIEMBROS, error: null });
    await barrerReservasV3(new Date('2026-09-22T15:00:00Z'));
    const { mensaje } = mockAvisar.mock.calls[0][0] as { mensaje: string };
    expect(mensaje).toContain('El borrador se canceló. Si el arriendo sigue');
    expect(mensaje).not.toContain('libre');
  });

  it('con CONTRATOS_V3_ENABLED apagado no hace nada (ni lee)', async () => {
    mockEnv.CONTRATOS_V3_ENABLED = false;
    enqueue('contratos', { data: [borrador()], error: null });
    await barrerReservasV3(new Date('2026-09-22T15:00:00Z'));
    expect(ops).toEqual([]);
    expect(mockCancelar).not.toHaveBeenCalled();
  });

  it.each([
    ['el último día de la reserva (lunes 21, 18:00 en Bogotá)', borrador(), '2026-09-21T23:00:00Z', false],
    ['el día siguiente (martes 22, 00:30 en Bogotá)', borrador(), '2026-09-22T05:30:00Z', true],
    ['con el lunes festivo de por medio, el viernes 16 todavía no', borrador({ created_at: '2026-10-09T15:00:00Z' }), '2026-10-16T20:00:00Z', false],
    ['… y el lunes 19 tampoco (el festivo corrió el plazo)', borrador({ created_at: '2026-10-09T15:00:00Z' }), '2026-10-19T20:00:00Z', false],
    ['… el martes 20 sí', borrador({ created_at: '2026-10-09T15:00:00Z' }), '2026-10-20T15:00:00Z', true],
  ])('%s', async (_caso, fila, ahora, cancela) => {
    enqueue('contratos', { data: [fila], error: null });
    enqueue('expedientes', { data: EXP, error: null });
    enqueue('inmobiliaria_miembros', { data: MIEMBROS, error: null });
    await barrerReservasV3(new Date(ahora));
    expect(mockCancelar).toHaveBeenCalledTimes(cancela ? 1 : 0);
  });

  it('idempotente: si ya se canceló o salió a firma (CAS perdido), no se avisa', async () => {
    mockCancelar.mockResolvedValue(false);
    enqueue('contratos', { data: [borrador()], error: null });
    await barrerReservasV3(new Date('2026-09-22T15:00:00Z'));
    expect(mockCancelar).toHaveBeenCalledTimes(1);
    expect(mockAvisar).not.toHaveBeenCalled();
    expect(ops.filter((o) => o.table !== 'contratos')).toEqual([]);
  });

  it('quien lo inició ya no está en la inmobiliaria y no hay responsable: se avisa a los titulares', async () => {
    enqueue('contratos', { data: [borrador({ generado_por: 'u-exmiembro' })], error: null });
    enqueue('expedientes', { data: { ...EXP, miembro_responsable_id: null }, error: null });
    enqueue('inmobiliaria_miembros', { data: MIEMBROS, error: null });
    await barrerReservasV3(new Date('2026-09-22T15:00:00Z'));
    expect(avisados()).toEqual(['u-titular']);
    // Solo miembros activos de la organización del estudio.
    const filtros = ops.filter((o) => o.table === 'inmobiliaria_miembros').map((o) => [o.method, ...o.args]);
    expect(filtros).toContainEqual(['eq', 'inmobiliaria_id', 'org-1']);
    expect(filtros).toContainEqual(['eq', 'estado', 'activo']);
  });

  it('si uno falla al cancelar, sigue con los demás', async () => {
    mockCancelar.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(true);
    enqueue('contratos', { data: [borrador(), borrador({ id: 'cto-2', numero: 'CTO-2026-0008' })], error: null });
    enqueue('expedientes', { data: EXP, error: null });
    enqueue('inmobiliaria_miembros', { data: MIEMBROS, error: null });
    await barrerReservasV3(new Date('2026-09-22T15:00:00Z'));
    expect(mockCancelar.mock.calls.map((c) => c[0])).toEqual(['cto-1', 'cto-2']);
    expect(mockAvisar.mock.calls.every((c) => (c[0] as { payload: { contrato_id: string } }).payload.contrato_id === 'cto-2')).toBe(true);
  });

  it('sin poder leer los borradores no cancela nada', async () => {
    enqueue('contratos', { data: null, error: { message: 'timeout' } });
    await barrerReservasV3(new Date('2026-09-22T15:00:00Z'));
    expect(mockCancelar).not.toHaveBeenCalled();
  });
});

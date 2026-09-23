import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@/types/auth';

// ============================================================
// Adenda 1 contratos, respuesta 21: un administrador cierra el estudio SIN
// ACTA con motivo registrado (quién, cuándo y por qué en el mismo UPDATE que
// cierra; el trigger de §12.2 lo deja pasar por esas columnas). Mock de
// Supabase con colas por tabla; `ops` registra lo que se escribió.
// ============================================================

const { queues, ops, enqueue, chainFor, mockLogAudit, mockGetExpediente, mockLiberar } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (t: string): Res => queues.get(t)?.shift() ?? { data: null, error: null };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'not', 'in', 'limit'])
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.single = async () => next(table);
    chain.then = (ok: (v: Res) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(next(table)).then(ok, ko);
    return chain;
  };
  return {
    queues,
    ops,
    enqueue: (t: string, ...r: Res[]) => queues.set(t, [...(queues.get(t) ?? []), ...r]),
    chainFor,
    mockLogAudit: vi.fn(),
    mockGetExpediente: vi.fn(async () => ({ id: 'exp-1', estado: 'cerrado' })),
    mockLiberar: vi.fn(async () => true),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => chainFor(t), rpc: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auditLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auditLog')>()),
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(),
  perfilEsDuenoDeInmueble: vi.fn(),
  resolveRolMiembro: vi.fn(),
}));
vi.mock('../expedientes.service', () => ({ getExpedienteById: () => mockGetExpediente() }));
vi.mock('../../inmuebles/inmuebles.service', () => ({ liberarReservaDeExpediente: () => mockLiberar() }));

import { cerrarSinActa } from '../expediente-workflow.service';

const ADMIN = { id: 'admin-1', email: 'admin@cofianza.co', rol: 'administrador', activo: true } as AuthUser;
const MOTIVO = 'La inmobiliaria no levantó el acta de entrega';
const expediente = (estado = 'aprobado') => ({
  data: { id: 'exp-1', numero: 'EXP-2026-0100', estado, analista_id: null, inmuebles: { propietario_id: 'p', inmobiliaria_id: 'org-1' } },
  error: null,
});
/** Un V3 con la fianza activa o terminada (cto-1) y las actas cargadas. */
const contratos = (actas: string[] = []) => {
  enqueue('contratos', { data: [{ id: 'cto-1' }], error: null });
  enqueue('contrato_archivos', { data: actas.map((contrato_id) => ({ contrato_id })), error: null });
};
const escrituras = () => ops.filter((o) => ['insert', 'update'].includes(o.method));

async function error(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { statusCode: number; errorCode: string };
  }
  throw new Error('se esperaba un error');
}

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('cerrarSinActa', () => {
  it('cierra con quién, cuándo y el motivo en el mismo UPDATE (CAS sobre el estado), timeline y bitácora', async () => {
    enqueue('expedientes', expediente(), { data: [{ id: 'exp-1' }], error: null });
    contratos();

    const r = await cerrarSinActa('exp-1', MOTIVO, ADMIN, '10.0.0.1');

    const [upd] = ops.filter((o) => o.table === 'expedientes' && o.method === 'update');
    expect(upd.args[0]).toEqual({
      estado: 'cerrado',
      cierre_sin_acta_en: expect.any(String),
      cierre_sin_acta_por: 'admin-1',
      cierre_sin_acta_motivo: MOTIVO,
    });
    const desde = ops.indexOf(upd);
    expect(ops.slice(desde + 1, desde + 3).map((o) => [o.table, o.method, ...o.args])).toEqual([
      ['expedientes', 'eq', 'id', 'exp-1'],
      ['expedientes', 'eq', 'estado', 'aprobado'],
    ]);
    expect(ops.find((o) => o.table === 'eventos_timeline' && o.method === 'insert')?.args[0]).toMatchObject({
      expediente_id: 'exp-1',
      tipo: 'estado',
      usuario_id: 'admin-1',
      estado_anterior: 'aprobado',
      estado_nuevo: 'cerrado',
      comentario: MOTIVO,
      metadata: { cierre_sin_acta: true },
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        usuarioId: 'admin-1',
        accion: 'expediente_cerrado_sin_acta',
        entidadId: 'exp-1',
        detalle: { motivo: MOTIVO, estado_anterior: 'aprobado' },
      }),
    );
    expect(r).toMatchObject({ id: 'exp-1', estado_anterior: 'aprobado' });
  });

  it.each(['operador_analista', 'inmobiliaria', 'gerencia_consulta'])('%s no puede: 403 sin leer ni escribir', async (rol) => {
    const e = await error(cerrarSinActa('exp-1', MOTIVO, { ...ADMIN, rol } as AuthUser));
    expect(e).toMatchObject({ statusCode: 403 });
    expect(ops).toEqual([]);
  });

  it('si el contrato ya tiene su acta, no aplica (409) y no escribe', async () => {
    enqueue('expedientes', expediente());
    contratos(['cto-1']);
    expect(await error(cerrarSinActa('exp-1', MOTIVO, ADMIN))).toMatchObject({ statusCode: 409, errorCode: 'CIERRE_SIN_ACTA_NO_APLICA' });
    expect(escrituras()).toEqual([]);
  });

  it('sin contrato V3 con la fianza activa o terminada, no aplica', async () => {
    enqueue('expedientes', expediente());
    enqueue('contratos', { data: [], error: null });
    expect(await error(cerrarSinActa('exp-1', MOTIVO, ADMIN))).toMatchObject({ errorCode: 'CIERRE_SIN_ACTA_NO_APLICA' });
    // Solo contratos V3 con la fianza activa o terminada.
    const filtros = ops.filter((o) => o.table === 'contratos').map((o) => [o.method, ...o.args]);
    expect(filtros).toContainEqual(['not', 'destinacion', 'is', null]);
    expect(filtros).toContainEqual(['in', 'estado', ['vigente', 'finalizado']]);
  });

  it('un estudio ya cerrado responde 409 sin escribir', async () => {
    enqueue('expedientes', expediente('cerrado'));
    expect(await error(cerrarSinActa('exp-1', MOTIVO, ADMIN))).toMatchObject({ statusCode: 409 });
    expect(escrituras()).toEqual([]);
  });

  it('si cambió de estado entretanto (el CAS no encuentra la fila): 409 sin timeline ni bitácora', async () => {
    enqueue('expedientes', expediente(), { data: [], error: null });
    contratos();
    expect(await error(cerrarSinActa('exp-1', MOTIVO, ADMIN))).toMatchObject({ statusCode: 409, errorCode: 'EXPEDIENTE_ESTADO_CAMBIADO' });
    expect(ops.some((o) => o.table === 'eventos_timeline')).toBe(false);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('con el contrato en firma el trigger lo rechaza: 409 CONTRATO_EN_FIRMA', async () => {
    enqueue('expedientes', expediente(), { data: null, error: { message: 'CONTRATO_EN_FIRMA: el contrato del estudio esta en firma' } });
    contratos();
    expect(await error(cerrarSinActa('exp-1', MOTIVO, ADMIN))).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_EN_FIRMA' });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

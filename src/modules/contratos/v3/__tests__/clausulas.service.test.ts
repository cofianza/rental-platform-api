import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

// ============================================================
// Catálogo de cláusulas adicionales — service (diseño §5.1, pruebas §8).
//
// Mock de Supabase con colas POR TABLA (patrón de autorizaciones.service.test):
// cualquier filtro devuelve el mismo builder; `maybeSingle`/`single` y el
// `await` directo consumen el siguiente resultado de la cola de esa tabla. Una
// tabla sin cola responde { data: null, error: null }. Todo queda en `ops` para
// afirmar QUÉ se escribió y con qué filtros (la org sale de la membresía).
// Sin mock de la IA: la inmobiliaria nunca pasa por ella (Adenda 1 del módulo
// de contratos, respuesta 13 bis), ni con el flag encendido y sin llave.
// ============================================================

const { mockEnv, mockFrom, ops, queues, enqueue, mockOrg, mockLogAudit } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'or', 'order', 'range'];
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
    mockEnv: { CONTRATOS_V3_ENABLED: true, CLAUSULAS_IA_ENABLED: false },
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => {
      queues.set(table, [...(queues.get(table) ?? []), ...items]);
    },
    mockOrg: vi.fn(async (): Promise<string | null> => 'org-1'),
    mockLogAudit: vi.fn(),
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  AUDIT_ACTIONS: { CLAUSULA_ADICIONAL_GUARDADA: 'clausula_adicional_guardada' },
  AUDIT_ENTITIES: { CLAUSULA_ADICIONAL: 'clausula_adicional' },
}));
vi.mock('@/lib/tenantScope', () => ({ resolveInmobiliariaIdForPerfil: () => mockOrg() }));

// Import AFTER mocks
import { AppError } from '@/lib/errors';
import { validate } from '@/middleware/validate';
import { cambiarEstadoSchema, registroQuerySchema } from '../clausulas.schema';
import * as svc from '../clausulas.service';
import { REGLAS_VERSION } from '../clausulas.reglas';

const T = 'clausulas_adicionales';
const ID = '11111111-1111-4111-8111-111111111111';
const BIEN = { titulo: 'Uso del parqueadero', texto: 'EL ARRENDATARIO usará el parqueadero asignado solo para vehículos livianos.' };

const fila = (x: Record<string, unknown> = {}) => ({
  id: ID,
  inmobiliaria_id: 'org-1',
  ...BIEN,
  version: 1,
  estado: 'activa',
  validacion: { reglas: REGLAS_VERSION, ia: null },
  inhabilitada_motivo: null,
  updated_at: '2026-09-21T10:00:00Z',
  ...x,
});

/** Primer op de `method` sobre la tabla; sus args. */
const op = (method: string, table = T) => ops.find((o) => o.table === table && o.method === method)?.args;
const filtros = (table = T) => ops.filter((o) => o.table === table && ['eq', 'is', 'neq'].includes(o.method)).map((o) => [o.method, ...o.args]);

async function error(p: Promise<unknown>): Promise<AppError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
}

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  mockLogAudit.mockClear();
  mockOrg.mockResolvedValue('org-1');
  mockEnv.CONTRATOS_V3_ENABLED = true;
  mockEnv.CLAUSULAS_IA_ENABLED = false;
});

describe('inmobiliaria', () => {
  it('crea en su propia org (de la membresía) con las reglas y bitácora', async () => {
    enqueue(T, { data: fila(), error: null });
    const r = await svc.crear('u-1', BIEN, '1.2.3.4');

    expect(op('insert')?.[0]).toMatchObject({ inmobiliaria_id: 'org-1', creado_por: 'u-1', ...BIEN, validacion: { reglas: REGLAS_VERSION, ia: null } });
    expect(r).toMatchObject({ origen: 'propia', campos: [], avisos: [] });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'clausula_adicional_guardada', entidadId: ID, ip: '1.2.3.4', detalle: expect.objectContaining({ op: 'crear' }) }),
    );
  });

  it('sin inmobiliaria → 403 SIN_INMOBILIARIA y no escribe', async () => {
    mockOrg.mockResolvedValue(null);
    const e = await error(svc.crear('u-1', BIEN));
    expect([e.statusCode, e.errorCode]).toEqual([403, 'SIN_INMOBILIARIA']);
    expect(op('insert')).toBeUndefined();
  });

  it('texto prohibido → 422 CLAUSULA_NO_PERMITIDA con los hallazgos, sin insertar', async () => {
    const e = await error(svc.crear('u-1', { titulo: 'Mascotas', texto: 'No se permiten mascotas en el inmueble arrendado.' }));
    expect([e.statusCode, e.errorCode]).toEqual([422, 'CLAUSULA_NO_PERMITIDA']);
    expect((e.details as { hallazgos: { codigo: string }[] }).hallazgos.map((h) => h.codigo)).toContain('mascotas');
    expect(op('insert')).toBeUndefined();
  });

  it('[[campo]] no se permite en una cláusula propia', async () => {
    const e = await error(svc.crear('u-1', { titulo: 'Parqueadero', texto: 'Usará el parqueadero número [[número]] del edificio.' }));
    expect((e.details as { hallazgos: { codigo: string }[] }).hallazgos[0].codigo).toBe('no_imprimible');
  });

  it('resp. 13 bis: con CLAUSULAS_IA_ENABLED encendido (y sin llave) la IA no corre: ni 503 ni bloqueo', async () => {
    mockEnv.CLAUSULAS_IA_ENABLED = true;
    enqueue(T, { data: fila(), error: null });
    await expect(svc.crear('u-1', BIEN)).resolves.toMatchObject({ origen: 'propia' });
    expect(op('insert')?.[0]).toMatchObject({ validacion: { reglas: REGLAS_VERSION, ia: null } });
  });

  it('PUT sube la versión con CAS (version, org, activa) y registra antes/después', async () => {
    const nuevo = { titulo: 'Uso del parqueadero cubierto', texto: BIEN.texto };
    enqueue(T, { data: fila({ version: 2 }), error: null }, { data: [fila({ ...nuevo, version: 3 })], error: null });
    const r = await svc.editar('u-1', ID, { ...nuevo, version: 2 });

    expect(op('update')?.[0]).toMatchObject({ ...nuevo, version: 3 });
    expect(filtros()).toEqual(
      expect.arrayContaining([['eq', 'version', 2], ['eq', 'inmobiliaria_id', 'org-1'], ['eq', 'estado', 'activa']]),
    );
    expect(r.version).toBe(3);
    expect(mockLogAudit.mock.calls[0][0].detalle).toMatchObject({ op: 'editar', antes: { version: 2 }, despues: { version: 3, titulo: nuevo.titulo } });
  });

  it('PUT con versión vieja → 409 sin revisar ni escribir', async () => {
    enqueue(T, { data: fila({ version: 3 }), error: null });
    const e = await error(svc.editar('u-1', ID, { ...BIEN, version: 2 }));
    expect([e.statusCode, e.errorCode]).toEqual([409, 'CLAUSULA_CAMBIADA']);
    expect(op('update')).toBeUndefined();
  });

  it('PUT sobre el id de otra org → 409 (la lectura filtra por la org propia)', async () => {
    enqueue(T, { data: null, error: null });
    const e = await error(svc.editar('u-1', ID, { ...BIEN, version: 1 }));
    expect(e.errorCode).toBe('CLAUSULA_CAMBIADA');
    expect(filtros()).toContainEqual(['eq', 'inmobiliaria_id', 'org-1']);
  });

  it('PUT que pierde la carrera (CAS sin filas) → 409', async () => {
    enqueue(T, { data: fila(), error: null }, { data: [], error: null });
    const e = await error(svc.editar('u-1', ID, { ...BIEN, version: 1 }));
    expect(e.errorCode).toBe('CLAUSULA_CAMBIADA');
  });

  it('DELETE es lógico: estado eliminada, solo en su org; sin filas → 404', async () => {
    enqueue(T, { data: [fila({ estado: 'eliminada' })], error: null });
    await svc.eliminar('u-1', ID);
    expect(op('update')?.[0]).toEqual({ estado: 'eliminada' });
    expect(op('delete')).toBeUndefined();
    expect(filtros()).toEqual(expect.arrayContaining([['eq', 'inmobiliaria_id', 'org-1'], ['neq', 'estado', 'eliminada']]));
    expect(mockLogAudit.mock.calls[0][0].detalle).toMatchObject({ op: 'eliminar', antes: { titulo: BIEN.titulo } });

    enqueue(T, { data: [], error: null });
    expect((await error(svc.eliminar('u-1', ID))).statusCode).toBe(404);
  });

  it('catálogo: biblioteca activa + propias activas o inhabilitadas, con los [[campos]] de la biblioteca', async () => {
    enqueue(
      T,
      { data: [fila({ inmobiliaria_id: null, texto: 'Usará el parqueadero [[número del parqueadero]] del edificio.' })], error: null },
      { data: [fila({ estado: 'inhabilitada', inhabilitada_motivo: 'Cita a la fianza' })], error: null },
    );
    const r = await svc.catalogo('u-1');
    expect(r.biblioteca[0]).toMatchObject({ origen: 'biblioteca', campos: ['número del parqueadero'] });
    expect(r.propias[0]).toMatchObject({ origen: 'propia', estado: 'inhabilitada', inhabilitadaMotivo: 'Cita a la fianza' });
    expect(op('in')).toEqual(['estado', ['activa', 'inhabilitada']]);
  });
});

describe('administrador', () => {
  it('la biblioteca acepta [[campos]], sin IA y sin org', async () => {
    const c = { titulo: 'Parqueadero', texto: 'Usará el parqueadero número [[número del parqueadero]] del edificio.' };
    enqueue(T, { data: fila({ ...c, inmobiliaria_id: null }), error: null });
    const r = await svc.crearBiblioteca('admin-1', c);
    expect(op('insert')?.[0]).toMatchObject({ inmobiliaria_id: null, texto: c.texto });
    expect(r).toMatchObject({ origen: 'biblioteca', campos: ['número del parqueadero'] });
  });

  it('PUT de la biblioteca: CAS con inmobiliaria_id IS NULL', async () => {
    enqueue(T, { data: fila({ inmobiliaria_id: null }), error: null }, { data: [fila({ inmobiliaria_id: null, version: 2 })], error: null });
    await svc.editarBiblioteca('admin-1', ID, { ...BIEN, version: 1 });
    expect(filtros()).toContainEqual(['is', 'inmobiliaria_id', null]);
    expect(filtros()).not.toContainEqual(['eq', 'inmobiliaria_id', expect.anything()]);
  });

  it('inhabilitar sin motivo → 400 (validate)', () => {
    const req = { body: { estado: 'inhabilitada' }, params: {}, query: {} } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    let e: unknown;
    try {
      validate({ body: cambiarEstadoSchema })(req, {} as Response, next);
    } catch (x) {
      e = x;
    }
    expect((e as AppError).statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('inhabilitar guarda motivo y fecha; reactivar los limpia', async () => {
    enqueue(T, { data: [fila({ estado: 'inhabilitada', inhabilitada_motivo: 'Riesgo' })], error: null });
    await svc.cambiarEstado('admin-1', ID, { estado: 'inhabilitada', motivo: 'Riesgo' });
    expect(op('update')?.[0]).toMatchObject({ estado: 'inhabilitada', inhabilitada_motivo: 'Riesgo', inhabilitada_en: expect.any(String) });
    expect(filtros()).toContainEqual(['neq', 'estado', 'eliminada']);

    ops.length = 0;
    enqueue(T, { data: [fila()], error: null });
    await svc.cambiarEstado('admin-1', ID, { estado: 'activa' });
    expect(op('update')?.[0]).toEqual({ estado: 'activa', inhabilitada_motivo: null, inhabilitada_en: null });
  });

  it('registro: q sin sintaxis de PostgREST, 50 por página, inmobiliaria y usos', async () => {
    const q = registroQuerySchema.parse({ q: '  depósito),id.eq.x%*"\\ ', page: '2', origen: 'propia' });
    expect(q.q).toBe('depósitoid.eq.x');
    enqueue(T, {
      data: [{ ...fila(), created_at: '2026-09-20T00:00:00Z', inmobiliarias: { id: 'org-1', nombre: 'Inmo Uno' }, contrato_clausulas_adicionales: [{ count: 3 }] }],
      error: null,
      count: 51,
    });
    const r = await svc.registro(q);
    expect(op('or')).toEqual(['titulo.ilike.%depósitoid.eq.x%,texto.ilike.%depósitoid.eq.x%']);
    expect(op('range')).toEqual([50, 99]);
    expect(op('not')).toEqual(['inmobiliaria_id', 'is', null]);
    expect(r).toEqual({ total: 51, items: [expect.objectContaining({ inmobiliaria: { id: 'org-1', nombre: 'Inmo Uno' }, usos: 3, creadaEn: '2026-09-20T00:00:00Z' })] });
  });

  it('usos: número de cláusula impreso en letras', async () => {
    enqueue('contrato_clausulas_adicionales', {
      data: [{ contrato_id: 'c-1', version: 2, numero: 34, created_at: '2026-09-21T00:00:00Z', contratos: { numero: 'CTO-2026-0001', estado: 'borrador', expediente_id: 'e-1' } }],
      error: null,
    });
    expect(await svc.usos(ID)).toEqual([
      { contratoId: 'c-1', contratoNumero: 'CTO-2026-0001', contratoEstado: 'borrador', expedienteId: 'e-1', version: 2, numero: 'TRIGÉSIMA CUARTA', en: '2026-09-21T00:00:00Z' },
    ]);
  });
});

describe('CONTRATOS_V3_ENABLED apagado', () => {
  it('las rutas de la inmobiliaria dan 404; las del administrador funcionan', async () => {
    mockEnv.CONTRATOS_V3_ENABLED = false;
    const llamadas = [
      () => svc.catalogo('u-1'),
      () => svc.crear('u-1', BIEN),
      () => svc.editar('u-1', ID, { ...BIEN, version: 1 }),
      () => svc.eliminar('u-1', ID),
    ];
    for (const llamar of llamadas) {
      const e = await error(llamar());
      expect([e.statusCode, e.errorCode]).toEqual([404, 'CONTRATOS_V3_NO_HABILITADO']);
    }
    expect(ops).toHaveLength(0);

    enqueue(T, { data: [], error: null, count: 0 });
    expect(await svc.registro({ page: 1 })).toEqual({ items: [], total: 0 });
  });
});

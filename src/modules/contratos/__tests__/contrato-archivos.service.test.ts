import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Archivos del contrato: quien no ve el estudio del contrato no lista ni
// descarga sus archivos (IDOR cerrado 2026-09-22). Mock de Supabase con colas
// por tabla; `ops` registra lo que se consultó.
// ============================================================

const { queues, ops, enqueue, chainFor, mockSignedUrl, mockAcceso } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string }> = [];
  const next = (t: string): Res => queues.get(t)?.shift() ?? { data: null, error: null };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order'])
      chain[m] = () => {
        ops.push({ table, method: m });
        return chain;
      };
    chain.single = async () => next(table);
    chain.maybeSingle = async () => next(table);
    chain.then = (ok: (v: Res) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(next(table)).then(ok, ko);
    return chain;
  };
  return {
    queues,
    ops,
    enqueue: (t: string, ...r: Res[]) => queues.set(t, [...(queues.get(t) ?? []), ...r]),
    chainFor,
    mockSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://firmada' }, error: null })),
    // Solo el estudio exp-propio es visible para el usuario de prueba.
    mockAcceso: vi.fn(async (expedienteId: string) => {
      if (expedienteId !== 'exp-propio') throw new Error('Estudio no encontrado');
    }),
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => chainFor(t), storage: { from: () => ({ createSignedUrl: mockSignedUrl }) } },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: { CONTRATO_ARCHIVO_DOWNLOADED: 'x', CONTRATO_ARCHIVO_UPLOADED: 'y', CONTRATO_ARCHIVO_DELETED: 'z' },
  AUDIT_ENTITIES: { CONTRATO: 'contrato' },
}));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: (id: string) => mockAcceso(id) }));

import { descargarArchivo, listarArchivos } from '../contrato-archivos.service';

const contrato = (expediente_id: string) => ({ data: { id: 'c1', expediente_id, estado: 'vigente' }, error: null });

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('archivos del contrato: alcance', () => {
  it('un contrato de otro estudio responde 404 y no lista nada', async () => {
    enqueue('contratos', contrato('exp-ajeno'));
    await expect(listarArchivos('c1', 'u1', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404, errorCode: 'CONTRATO_NOT_FOUND' });
    expect(ops.some((o) => o.table === 'contrato_archivos')).toBe(false);
  });

  it('un archivo de un contrato ajeno no se descarga (ni se firma la URL)', async () => {
    enqueue('contratos', contrato('exp-ajeno'));
    await expect(descargarArchivo('c1', 'a1', 'u1', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockSignedUrl).not.toHaveBeenCalled();
  });

  it('con acceso al estudio, lista y descarga', async () => {
    enqueue('contratos', contrato('exp-propio'), contrato('exp-propio'));
    enqueue('contrato_archivos', { data: [], error: null });
    enqueue('contrato_archivos', { data: { id: 'a1', storage_key: 'k', nombre_archivo: 'acta.pdf', tipo_mime: 'application/pdf' }, error: null });
    expect(await listarArchivos('c1', 'u1', 'inmobiliaria')).toEqual({ archivos: [] });
    expect((await descargarArchivo('c1', 'a1', 'u1', 'inmobiliaria')).url).toBe('https://firmada');
  });
});

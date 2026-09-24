import { describe, it, expect, vi, beforeEach } from 'vitest';

// La pestaña Documentos firma todas las URLs en UNA llamada a Storage (antes
// una por archivo) y el tenant guard sigue cortando el listado.
const { queues, createSignedUrls, createSignedUrl, assertAccess } = vi.hoisted(() => ({
  queues: new Map<string, Array<Record<string, unknown>>>(),
  createSignedUrls: vi.fn(async (keys: string[]) => ({
    data: keys.map((k) => ({ path: k, signedUrl: `https://firmada/${k}`, error: null })),
    error: null,
  })),
  createSignedUrl: vi.fn(),
  assertAccess: vi.fn(async () => undefined),
}));

vi.mock('@/lib/supabase', () => {
  const next = (t: string) => queues.get(t)?.shift() ?? { data: null, error: null };
  const from = (t: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'order', 'range', 'limit']) chain[m] = () => chain;
    chain.single = async () => next(t);
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(next(t)).then(res, rej);
    return chain;
  };
  return { supabase: { from, storage: { from: () => ({ createSignedUrls, createSignedUrl }) } } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: (...a: unknown[]) => assertAccess(...(a as [])) }));

import { listDocumentosByExpediente } from '../documentos.service';

beforeEach(() => {
  queues.clear();
  vi.clearAllMocks();
  queues.set('expedientes', [{ data: { id: 'e1' }, error: null }]);
  queues.set('documentos', [{
    data: [
      { id: 'd1', storage_key: 'expedientes/e1/documents/a.pdf' },
      { id: 'd2', storage_key: 'expedientes/e1/documents/b.pdf' },
      { id: 'd3', storage_key: null },
    ],
    error: null,
    count: 3,
  }]);
});

describe('listDocumentosByExpediente', () => {
  it('firma todos los archivos en una sola llamada', async () => {
    const r = await listDocumentosByExpediente('e1', {} as never, 'u1', 'inmobiliaria');

    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(r.documentos.map((d) => (d as { archivo_url: string | null }).archivo_url)).toEqual([
      'https://firmada/expedientes/e1/documents/a.pdf',
      'https://firmada/expedientes/e1/documents/b.pdf',
      null,
    ]);
  });

  it('fuera de la cartera responde el 404 del guard y no firma nada', async () => {
    assertAccess.mockRejectedValueOnce(Object.assign(new Error('no'), { statusCode: 404 }));
    await expect(listDocumentosByExpediente('e1', {} as never, 'u1', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    expect(createSignedUrls).not.toHaveBeenCalled();
  });
});

// P19: «Eliminar» sale con la misma regla que deleteDocumento.
describe('eliminable', () => {
  const docs = [
    { id: 'p1', estado: 'pendiente', subido_por: 'u1', storage_key: null },
    { id: 'p2', estado: 'pendiente', subido_por: 'otro', storage_key: null },
    { id: 'a1', estado: 'aprobado', subido_por: 'u1', storage_key: null },
  ];
  const listar = async (estado: string, rol = 'propietario', contratos: unknown[] = []) => {
    queues.set('expedientes', [{ data: { id: 'e1', estado }, error: null }]);
    queues.set('documentos', [{ data: docs, error: null, count: 3 }]);
    queues.set('contratos', [{ data: contratos, error: null }]);
    const r = await listDocumentosByExpediente('e1', {} as never, 'u1', rol);
    return Object.fromEntries(r.documentos.map((d) => [d.id, (d as { eliminable: boolean }).eliminable]));
  };

  it('solo el pendiente propio, con el estudio en curso', async () => {
    expect(await listar('en_revision')).toEqual({ p1: true, p2: false, a1: false });
  });

  it('nada con el estudio no aprobable, cerrado o aprobado con contrato', async () => {
    expect(await listar('rechazado')).toEqual({ p1: false, p2: false, a1: false });
    expect(await listar('cerrado')).toEqual({ p1: false, p2: false, a1: false });
    expect(await listar('aprobado', 'propietario', [{ id: 'c1' }])).toEqual({ p1: false, p2: false, a1: false });
  });

  it('sin permiso de borrado (Gerencia) nada', async () => {
    expect(await listar('en_revision', 'gerencia_consulta')).toEqual({ p1: false, p2: false, a1: false });
  });
});

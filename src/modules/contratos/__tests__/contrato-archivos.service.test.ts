import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Archivos del contrato: quien no ve el estudio del contrato no lista ni
// descarga sus archivos (IDOR cerrado 2026-09-22). Mock de Supabase con colas
// por tabla; `ops` registra lo que se consultó.
// ============================================================

const { queues, ops, enqueue, chainFor, mockSignedUrl, mockRemove, mockUpload, mockAcceso } = vi.hoisted(() => {
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
    mockRemove: vi.fn(async () => ({ error: null })),
    mockUpload: vi.fn(async () => ({ error: null })),
    // Solo el estudio exp-propio es visible para el usuario de prueba.
    mockAcceso: vi.fn(async (expedienteId: string) => {
      if (expedienteId !== 'exp-propio') throw new Error('Estudio no encontrado');
    }),
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: string) => chainFor(t),
    storage: { from: () => ({ createSignedUrl: mockSignedUrl, remove: mockRemove, upload: mockUpload }) },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: { CONTRATO_ARCHIVO_DOWNLOADED: 'x', CONTRATO_ARCHIVO_UPLOADED: 'y', CONTRATO_ARCHIVO_DELETED: 'z' },
  AUDIT_ENTITIES: { CONTRATO: 'contrato' },
}));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: (id: string) => mockAcceso(id) }));

import { descargarArchivo, eliminarArchivo, listarArchivos, subirArchivo } from '../contrato-archivos.service';

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

describe('borrar el acta de entrega (V3 §12.2)', () => {
  const acta = { data: { id: 'a1', contrato_id: 'c1', storage_key: 'k1', nombre_archivo: 'acta.pdf', tipo_archivo: 'acta_entrega' }, error: null };
  const v3 = (estado: string) => ({ data: { id: 'c1', expediente_id: 'exp-propio', estado, destinacion: 'vivienda' }, error: null });

  it('la única acta de un V3 con fianza activa no se borra (409) y no se toca storage', async () => {
    enqueue('contrato_archivos', acta, { count: 1, error: null });
    enqueue('contratos', v3('vigente'));
    await expect(eliminarArchivo('c1', 'a1', 'admin')).rejects.toMatchObject({ statusCode: 409, errorCode: 'ACTA_ENTREGA_UNICA' });
    expect(ops.some((o) => o.method === 'delete')).toBe(false);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('con otra acta cargada se borra: primero el registro, después el archivo', async () => {
    enqueue('contrato_archivos', acta, { count: 2, error: null }, { data: null, error: null });
    enqueue('contratos', v3('finalizado'));
    await eliminarArchivo('c1', 'a1', 'admin');
    expect(ops.some((o) => o.table === 'contrato_archivos' && o.method === 'delete')).toBe(true);
    expect(mockRemove).toHaveBeenCalledWith(['k1']);
  });

  it('si el registro no se borra, el archivo sigue en storage', async () => {
    enqueue('contrato_archivos', { ...acta, data: { ...acta.data, tipo_archivo: 'inventario' } }, { data: null, error: { message: 'caída' } });
    await expect(eliminarArchivo('c1', 'a1', 'admin')).rejects.toMatchObject({ statusCode: 500 });
    expect(mockRemove).not.toHaveBeenCalled();
  });
});

describe('cargar el acta de entrega de un V3 (Adenda 1 contratos, respuesta 21)', () => {
  const archivo = { buffer: Buffer.from('%PDF-1.4'), originalname: 'acta.pdf', size: 8, mimetype: 'application/pdf' };
  const fila = (destinacion: string | null) => ({
    data: { id: 'c1', expediente_id: 'exp-propio', estado: 'vigente', destinacion },
    error: null,
  });

  it.each(['administrador', 'operador_analista'])('%s no la carga en nombre de la inmobiliaria: 403, sin subir nada', async (rol) => {
    enqueue('contratos', fila('vivienda'));
    await expect(subirArchivo('c1', 'acta_entrega', archivo, 'u-cofianza', rol)).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'ACTA_SOLO_INMOBILIARIA',
    });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(ops.some((o) => o.method === 'insert')).toBe(false);
  });

  it('la inmobiliaria sí la carga', async () => {
    enqueue('contratos', fila('vivienda'));
    enqueue('contrato_archivos', { data: { id: 'a1' }, error: null });
    await subirArchivo('c1', 'acta_entrega', archivo, 'u-inmo', 'inmobiliaria');
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['otro tipo de archivo de un V3', 'inventario', 'vivienda'],
    ['el acta de un contrato del flujo anterior', 'acta_entrega', null],
  ] as const)('Cofianza sí carga %s', async (_caso, tipo, destinacion) => {
    enqueue('contratos', fila(destinacion));
    enqueue('contrato_archivos', { data: { id: 'a1' }, error: null });
    await subirArchivo('c1', tipo, archivo, 'u-cofianza', 'administrador');
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });
});

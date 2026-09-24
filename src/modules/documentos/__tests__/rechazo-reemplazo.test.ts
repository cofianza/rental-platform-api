import { describe, it, expect, vi, beforeEach } from 'vitest';

// Rechazar un documento avisa a quien debe corregirlo, y cualquiera que pueda
// subir al estudio puede reemplazarlo (antes solo quien lo subió o un admin:
// el documento quedaba «Esperando resubida» sin salida).
const { queues, notificar, assertAccess, removeArchivo } = vi.hoisted(() => ({
  queues: new Map<string, Array<Record<string, unknown>>>(),
  notificar: vi.fn(async () => undefined),
  assertAccess: vi.fn(async () => undefined),
  removeArchivo: vi.fn(async (_keys: string[]) => ({ error: null })),
}));

vi.mock('@/lib/supabase', () => {
  const next = (t: string) => queues.get(t)?.shift() ?? { data: null, error: null };
  const from = (t: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'order', 'limit']) chain[m] = () => chain;
    chain.single = chain.maybeSingle = async () => next(t);
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(next(t)).then(res, rej);
    return chain;
  };
  const bucket = {
    remove: removeArchivo,
    createSignedUrl: async () => ({ data: { signedUrl: 'https://ver' }, error: null }),
    createSignedUploadUrl: async () => ({ data: { signedUrl: 'https://subir', token: 't' }, error: null }),
  };
  return { supabase: { from, storage: { from: () => bucket } } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: (...a: unknown[]) => assertAccess(...(a as [])) }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: notificar }));

import { rechazarDocumento, iniciarReemplazo, deleteDocumento, confirmarSubida, confirmarReemplazo } from '../documentos.service';

const doc = (o: Record<string, unknown> = {}) => ({
  id: 'd1',
  expediente_id: 'e1',
  tipo_documento_id: 't1',
  nombre_original: 'cedula.pdf',
  storage_key: 'expedientes/e1/documents/a.pdf',
  estado: 'pendiente',
  subido_por: 'gestor-1',
  ...o,
});

beforeEach(() => {
  queues.clear();
  vi.clearAllMocks();
});

describe('rechazar documento', () => {
  it('avisa a quien lo subió, al dueño y al responsable, una vez cada uno y no al analista', async () => {
    queues.set('documentos', [{ data: doc(), error: null }, { data: doc({ estado: 'rechazado' }), error: null }]);
    queues.set('expedientes', [{
      data: { numero: 'EXP-1', miembro_responsable_id: 'gestor-1', inmuebles: { propietario_id: 'dueno-1' } },
      error: null,
    }]);
    queues.set('perfiles', [{ data: [{ id: 'gestor-1', rol: 'inmobiliaria' }, { id: 'dueno-1', rol: 'inmobiliaria' }], error: null }]);

    await rechazarDocumento('d1', 'Ilegible', 'analista-1');

    await vi.waitFor(() => expect(notificar).toHaveBeenCalledTimes(2));
    const ids = notificar.mock.calls.map((c) => (c as unknown as [{ userId: string }])[0].userId).sort();
    expect(ids).toEqual(['dueno-1', 'gestor-1']);
    expect((notificar.mock.calls[0] as unknown as [{ mensaje: string; link: string }])[0]).toMatchObject({
      mensaje: expect.stringContaining('Ilegible'),
      link: '/expedientes/e1',
    });
  });

  it('avisa al propietario directo (P19: ya puede resubir), no a quien no puede subir', async () => {
    queues.set('documentos', [
      { data: doc({ subido_por: 'analista-2' }), error: null },
      { data: doc({ estado: 'rechazado' }), error: null },
    ]);
    queues.set('expedientes', [{
      data: { numero: 'EXP-2', miembro_responsable_id: 'consulta-3', inmuebles: { propietario_id: 'dueno-1' } },
      error: null,
    }]);
    queues.set('perfiles', [{
      data: [
        { id: 'analista-2', rol: 'operador_analista' },
        { id: 'dueno-1', rol: 'propietario' },
        { id: 'consulta-3', rol: 'gerencia_consulta' },
      ],
      error: null,
    }]);

    await rechazarDocumento('d1', 'Ilegible', 'analista-1');

    await vi.waitFor(() => expect(notificar).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    const ids = notificar.mock.calls.map((c) => (c as unknown as [{ userId: string }])[0].userId);
    expect(ids).toEqual(['analista-2', 'dueno-1']);
  });
});

describe('reemplazar documento rechazado', () => {
  const input = { nombre_original: 'cedula2.pdf', tipo_mime: 'application/pdf', tamano_bytes: 1000 };

  it('otro miembro con acceso al estudio puede iniciarlo', async () => {
    queues.set('documentos', [{ data: doc({ estado: 'rechazado' }), error: null }]);
    queues.set('expedientes', [{ data: { id: 'e1', estado: 'en_revision' }, error: null }]);
    queues.set('tipos_documento', [{ data: { formatos_aceptados: ['application/pdf'], tamano_maximo_mb: 10 }, error: null }]);

    await expect(iniciarReemplazo('d1', input as never, 'miembro-2', 'inmobiliaria')).resolves.toBeTruthy();
    expect(assertAccess).toHaveBeenCalledWith('e1', 'miembro-2', 'inmobiliaria');
  });

  it('fuera de la cartera responde el 404 del guard', async () => {
    queues.set('documentos', [{ data: doc({ estado: 'rechazado' }), error: null }]);
    assertAccess.mockRejectedValueOnce(Object.assign(new Error('no'), { statusCode: 404 }));

    await expect(iniciarReemplazo('d1', input as never, 'otra-agencia', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// P19: el propietario y la inmobiliaria borran sus documentos pendientes, pero
// solo en su cartera y mientras el estudio no esté decidido.
describe('eliminar documento', () => {
  const borrar = (userId = 'gestor-1', rol = 'inmobiliaria') => deleteDocumento('d1', userId, rol);

  it('pendiente y propio, con el estudio en curso: se borra', async () => {
    queues.set('documentos', [{ data: doc(), error: null }]);
    queues.set('expedientes', [{ data: { estado: 'en_revision' }, error: null }]);
    await expect(borrar()).resolves.toBeUndefined();
    expect(assertAccess).toHaveBeenCalledWith('e1', 'gestor-1', 'inmobiliaria');
  });

  it('de otra agencia: el 404 del guard, antes de revelar nada', async () => {
    queues.set('documentos', [{ data: doc({ subido_por: 'otro' }), error: null }]);
    assertAccess.mockRejectedValueOnce(Object.assign(new Error('no'), { statusCode: 404 }));
    await expect(borrar('otra-agencia')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('subido por otra persona: 403', async () => {
    queues.set('documentos', [{ data: doc({ subido_por: 'otro' }), error: null }]);
    await expect(borrar()).rejects.toMatchObject({ statusCode: 403 });
  });

  it('con el estudio no aprobable, cerrado o aprobado con contrato: no se borra', async () => {
    for (const estado of ['rechazado', 'cerrado']) {
      queues.set('documentos', [{ data: doc(), error: null }]);
      queues.set('expedientes', [{ data: { estado }, error: null }]);
      await expect(borrar()).rejects.toMatchObject({ statusCode: 400, errorCode: 'EXPEDIENTE_TERMINAL' });
    }
    queues.set('documentos', [{ data: doc(), error: null }]);
    queues.set('expedientes', [{ data: { estado: 'aprobado' }, error: null }]);
    queues.set('contratos', [{ data: [{ id: 'c1' }], error: null }]);
    await expect(borrar()).rejects.toMatchObject({ statusCode: 400, errorCode: 'EXPEDIENTE_TERMINAL' });
  });

  it('aprobado sin contrato todavía se puede corregir', async () => {
    queues.set('documentos', [{ data: doc(), error: null }]);
    queues.set('expedientes', [{ data: { estado: 'aprobado' }, error: null }]);
    queues.set('contratos', [{ data: [], error: null }]);
    await expect(borrar()).resolves.toBeUndefined();
  });
});

// Subir otro del mismo tipo marca el anterior 'reemplazado'; sobre uno ya
// aprobado, eso solo lo hace quien valida documentos.
describe('subir sobre un documento aprobado', () => {
  const input = {
    expediente_id: 'e1', tipo_documento_id: 't1', nombre_original: 'cedula2.pdf', nombre_archivo: 'b.pdf',
    storage_key: 'expedientes/e1/documents/b.pdf', tipo_mime: 'application/pdf', tamano_bytes: 1000,
  };
  const encolar = () => {
    queues.set('expedientes', [{ data: { id: 'e1', estado: 'en_revision' }, error: null }]);
    queues.set('tipos_documento', [{ data: { id: 't1', nombre: 'Cédula' }, error: null }]);
  };

  it('el propietario no reemplaza lo que Cofianza ya aprobó', async () => {
    encolar();
    queues.set('documentos', [{ data: null, error: null, count: 1 }]);
    await expect(confirmarSubida(input as never, 'dueno-1', 'propietario')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'DOCUMENTO_YA_APROBADO',
    });
  });

  it('si no se pueden contar los aprobados, no se sube (503)', async () => {
    encolar();
    queues.set('documentos', [{ data: null, error: { message: 'timeout' }, count: null }]);
    await expect(confirmarSubida(input as never, 'dueno-1', 'propietario')).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'LECTURA_NO_VERIFICABLE',
    });
  });

  it('el operador sí (es quien valida)', async () => {
    encolar();
    queues.set('documentos', [
      { data: null, error: null, count: 0 }, // la clave no la usa otro documento
      { data: null, error: null, count: 1 }, // versión
      { data: doc({ id: 'd2', estado: 'pendiente', subido_por: 'op-1' }), error: null }, // insert
      { data: [{ id: 'd1' }], error: null }, // anteriores
      { data: null, error: null }, // marcar reemplazado
    ]);
    await expect(confirmarSubida(input as never, 'op-1', 'operador_analista')).resolves.toMatchObject({ id: 'd2', eliminable: true });
  });
});

// Revisión Q4: registrar la storage_key de un documento ajeno en uno propio y
// borrar el propio borraba el archivo del ajeno (la ruta sale en el listado).
describe('un archivo es de un solo documento', () => {
  const KEY_A = 'expedientes/e1/documents/cedula-aprobada.pdf';

  it('confirmar la subida con una clave que ya usa otro documento: 409', async () => {
    queues.set('expedientes', [{ data: { id: 'e1', estado: 'en_revision' }, error: null }]);
    queues.set('tipos_documento', [{ data: { id: 't9', nombre: 'Otro' }, error: null }]);
    queues.set('documentos', [
      { data: null, error: null, count: 0 }, // aprobados del tipo: ninguno
      { data: null, error: null, count: 1 }, // la clave ya la usa A
    ]);
    const input = {
      expediente_id: 'e1', tipo_documento_id: 't9', nombre_original: 'x.pdf', nombre_archivo: 'x.pdf',
      storage_key: KEY_A, tipo_mime: 'application/pdf', tamano_bytes: 1,
    };
    await expect(confirmarSubida(input as never, 'gestor-1', 'inmobiliaria')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'STORAGE_KEY_EN_USO',
    });
  });

  it('confirmar el reemplazo con una clave que ya usa otro documento: 409', async () => {
    queues.set('documentos', [
      { data: doc({ estado: 'rechazado' }), error: null },
      { data: null, error: null, count: 1 }, // la clave ya la usa A
    ]);
    queues.set('expedientes', [{ data: { estado: 'en_revision' }, error: null }]);
    const input = { nombre_original: 'x.pdf', nombre_archivo: 'x.pdf', storage_key: KEY_A, tipo_mime: 'application/pdf', tamano_bytes: 1 };
    await expect(confirmarReemplazo('d1', input as never, 'gestor-1', 'inmobiliaria')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'STORAGE_KEY_EN_USO',
    });
  });

  it('borrar un documento cuyo archivo usa otra fila: se borra la fila, no el archivo', async () => {
    queues.set('documentos', [
      { data: doc({ storage_key: KEY_A }), error: null },
      { data: null, error: null }, // revertir reemplazados
      { data: null, error: null, count: 1 }, // otra fila usa el archivo
    ]);
    queues.set('expedientes', [{ data: { estado: 'en_revision' }, error: null }]);
    await expect(deleteDocumento('d1', 'gestor-1', 'inmobiliaria')).resolves.toBeUndefined();
    expect(removeArchivo).not.toHaveBeenCalled();
  });

  it('si nadie más lo usa, el archivo sí se borra', async () => {
    queues.set('documentos', [{ data: doc(), error: null }]);
    queues.set('expedientes', [{ data: { estado: 'en_revision' }, error: null }]);
    await deleteDocumento('d1', 'gestor-1', 'inmobiliaria');
    expect(removeArchivo).toHaveBeenCalledWith(['expedientes/e1/documents/a.pdf']);
  });
});

// Entre iniciar y confirmar el reemplazo el estudio pudo cerrarse o quedar no
// aprobable: confirmar vuelve a mirar, como iniciarReemplazo.
describe('confirmar reemplazo', () => {
  it('con el estudio cerrado o no aprobable: 400, sin registrar nada', async () => {
    for (const estado of ['cerrado', 'rechazado']) {
      queues.set('documentos', [{ data: doc({ estado: 'rechazado' }), error: null }]);
      queues.set('expedientes', [{ data: { estado }, error: null }]);
      const input = { nombre_original: 'x.pdf', nombre_archivo: 'x.pdf', storage_key: 'expedientes/e1/documents/n.pdf', tipo_mime: 'application/pdf', tamano_bytes: 1 };
      await expect(confirmarReemplazo('d1', input as never, 'gestor-1', 'inmobiliaria')).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'EXPEDIENTE_TERMINAL',
      });
    }
  });
});

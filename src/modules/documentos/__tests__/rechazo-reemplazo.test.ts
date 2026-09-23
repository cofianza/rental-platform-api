import { describe, it, expect, vi, beforeEach } from 'vitest';

// Rechazar un documento avisa a quien debe corregirlo, y cualquiera que pueda
// subir al estudio puede reemplazarlo (antes solo quien lo subió o un admin:
// el documento quedaba «Esperando resubida» sin salida).
const { queues, notificar, assertAccess } = vi.hoisted(() => ({
  queues: new Map<string, Array<Record<string, unknown>>>(),
  notificar: vi.fn(async () => undefined),
  assertAccess: vi.fn(async () => undefined),
}));

vi.mock('@/lib/supabase', () => {
  const next = (t: string) => queues.get(t)?.shift() ?? { data: null, error: null };
  const from = (t: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'eq', 'in', 'order']) chain[m] = () => chain;
    chain.single = chain.maybeSingle = async () => next(t);
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(next(t)).then(res, rej);
    return chain;
  };
  const bucket = {
    createSignedUrl: async () => ({ data: { signedUrl: 'https://ver' }, error: null }),
    createSignedUploadUrl: async () => ({ data: { signedUrl: 'https://subir', token: 't' }, error: null }),
  };
  return { supabase: { from, storage: { from: () => bucket } } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: (...a: unknown[]) => assertAccess(...(a as [])) }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: notificar }));

import { rechazarDocumento, iniciarReemplazo } from '../documentos.service';

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

  it('no avisa al propietario individual: no puede resubir y el enlace lo llevaba a un 403', async () => {
    queues.set('documentos', [
      { data: doc({ subido_por: 'analista-2' }), error: null },
      { data: doc({ estado: 'rechazado' }), error: null },
    ]);
    queues.set('expedientes', [{
      data: { numero: 'EXP-2', miembro_responsable_id: null, inmuebles: { propietario_id: 'dueno-1' } },
      error: null,
    }]);
    queues.set('perfiles', [{ data: [{ id: 'analista-2', rol: 'operador_analista' }, { id: 'dueno-1', rol: 'propietario' }], error: null }]);

    await rechazarDocumento('d1', 'Ilegible', 'analista-1');

    await vi.waitFor(() => expect(notificar).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    const ids = notificar.mock.calls.map((c) => (c as unknown as [{ userId: string }])[0].userId);
    expect(ids).toEqual(['analista-2']);
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

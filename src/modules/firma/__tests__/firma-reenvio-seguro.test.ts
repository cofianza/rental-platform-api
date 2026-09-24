import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Reenviar a firma sin perder una firma (revisión 2 de Q6, punto 1): antes de
// abrir el sobre nuevo, el anterior se revisa en Auco. Si ya lo firmaron todos
// (el webhook FINISH se perdió) se reconcilia como firmado y responde 409; si
// sigue vivo se anula; si no se puede confirmar, 503 sin subir otro documento.
// Incluye los tres casos de la reproducción del revisor. Todo con mocks.
// ============================================================

const { ops, enqueue, queues, mockTransicionar, mockActivar } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  return {
    ops,
    queues,
    enqueue: (t: string, ...i: Res[]) => queues.set(t, [...(queues.get(t) ?? []), ...i]),
    mockTransicionar: vi.fn(async () => undefined),
    mockActivar: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/supabase', () => {
  const next = (t: string) => queues.get(t)?.shift() ?? { data: null, error: null };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'not', 'order', 'limit', 'is']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.single = chain.maybeSingle = async () => next(table);
    chain.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(next(table)).then(ok, ko);
    return chain;
  };
  return {
    supabase: {
      from,
      rpc: vi.fn(async () => ({ data: [], error: null })),
      storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => new ArrayBuffer(4) }, error: null }) }) },
    },
    supabaseAuth: {},
  };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({
  env: { AUCO_SENDER_EMAIL: 'sender@cofianza.com', FIRMA_BIOMETRIA_ENABLED: false, COFIANZA_AUTOFIRMA_ENABLED: true },
}));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(async () => undefined),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
}));
vi.mock('@/lib/companyConfig', () => ({
  getCompany: vi.fn(async () => ({ name: 'COFIANZA S.A.S.', email: 'hola@cofianza.co', phone: '3169724813', nit: '902.038.122-7' })),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn(), findPerfilIdByEmail: vi.fn() }));
vi.mock('@/modules/contratos/contratos.service', () => ({
  plazoFirmaContrato: vi.fn(async () => '2026-10-10T04:59:59.000Z'),
  assertPuedeAbrirSobre: vi.fn(async () => undefined), // el sobre viejo venció: no cuenta como vivo
  maybeAutoTransicionarFirmado: (...a: unknown[]) => mockTransicionar(...(a as [])),
  maybeAutoActivarVigente: (...a: unknown[]) => mockActivar(...(a as [])),
}));
vi.mock('@/lib/auco', () => ({
  normalizePhoneToInternational: vi.fn((t?: string | null) => (t ? `+57${t}` : null)),
  bufferToBase64: vi.fn(() => 'JVBERg=='),
  uploadDocumentForSignature: vi.fn(async () => 'DOC-NUEVO'),
  getDocumentStatus: vi.fn(),
  sendReminder: vi.fn(),
  cancelDocument: vi.fn(),
}));

import * as auco from '@/lib/auco';
import { crearSolicitudFirmaMultiparte } from '../firma-multiparte.service';
import { crearSolicitudFirma, reenviarSolicitudFirma } from '../firma.service';
import { assertPuedeAbrirSobre } from '@/modules/contratos/contratos.service';

const VIEJO = { id: 's-viejo', estado: 'enviado', auco_document_code: 'DOC-VIEJO' };
const de = (table: string, method: string) => ops.filter((o) => o.table === table && o.method === method);
const marcado = (estado: string) => de('solicitudes_firma', 'update').some((o) => (o.args[0] as { estado?: string }).estado === estado);

/** Lo que lee crearSolicitudFirmaMultiparte antes de revisar el sobre anterior. */
function prepararReenvio() {
  enqueue(
    'contratos',
    { data: { id: 'c1', estado: 'pendiente_firma', expediente_id: 'e1', storage_key: 'k.pdf', destinacion: null, datos_variables: {} }, error: null },
    { data: { id: 'c1', expediente_id: 'e1' }, error: null },
  );
  enqueue('expedientes', {
    data: {
      id: 'e1',
      solicitantes: { id: 's', nombre: 'Juan', apellido: 'Ruiz', email: 'juan@x.co', telefono: '3001112233', tipo_documento: 'cc', numero_documento: '1010' },
      inmuebles: { propietario_id: 'prop-1', inmobiliaria_id: null },
    },
    error: null,
  });
  enqueue('perfiles', { data: { id: 'prop-1', nombre: 'Ana', apellido: 'Gómez', rol: 'propietario', whatsapp_recaudo: '3104445566', email_recaudo: 'ana@x.co' }, error: null });
  enqueue('solicitudes_firma', { data: [VIEJO], error: null });
}

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  // Sin respuestas «una vez» de otra prueba (en el camino FINISH no se llega a anular).
  vi.mocked(auco.getDocumentStatus).mockReset();
  vi.mocked(auco.cancelDocument).mockReset();
});

describe('reenviar a firma con el sobre anterior ya firmado en Auco (webhook perdido)', () => {
  beforeEach(() => {
    vi.mocked(auco.getDocumentStatus).mockResolvedValue({ status: 'FINISH', url: 'https://auco/firmado.pdf', signProfile: [] } as never);
    // Auco no cancela un documento ya firmado: 200 con errors.cant = 1.
    vi.mocked(auco.cancelDocument).mockResolvedValue({ success: false, errors: { cant: 1 } });
  });

  it('no abre un sobre nuevo si Auco dice que el anterior no se pudo anular', async () => {
    prepararReenvio();
    await crearSolicitudFirmaMultiparte('c1', 'u1').catch(() => undefined);
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });

  it('no da por cancelado el sobre que Auco tiene firmado', async () => {
    prepararReenvio();
    await crearSolicitudFirmaMultiparte('c1', 'u1').catch(() => undefined);
    expect(marcado('cancelado')).toBe(false);
  });

  it('si la anulación en Auco falla por red, tampoco abre un segundo sobre', async () => {
    vi.mocked(auco.cancelDocument).mockRejectedValueOnce(new Error('ECONNRESET'));
    prepararReenvio();
    await crearSolicitudFirmaMultiparte('c1', 'u1').catch(() => undefined);
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });

  it('lo reconcilia como firmado por el camino del webhook y responde 409', async () => {
    prepararReenvio();
    // handleAucoWebhook: el sobre por su código, sus firmantes (multi-parte) y el cierre.
    enqueue('solicitudes_firma', { data: { id: 's-viejo', contrato_id: 'c1', estado: 'enviado', nombre_firmante: 'Juan', email_firmante: 'juan@x.co' }, error: null });
    enqueue('contrato_firmantes', { data: [{ id: 'f1' }], error: null }, { data: null, error: null }, { data: [{ estado: 'firmado' }, { estado: 'firmado' }], error: null });
    enqueue('contratos', { data: { expediente_id: 'e1' }, error: null });

    await expect(crearSolicitudFirmaMultiparte('c1', 'u1')).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_YA_FIRMADO' });

    expect(auco.cancelDocument).not.toHaveBeenCalled();
    expect(de('contrato_firmantes', 'update')[0].args[0]).toMatchObject({ estado: 'firmado' });
    expect(marcado('firmado')).toBe(true);
    expect(mockTransicionar).toHaveBeenCalledWith('c1');
    expect(mockActivar).toHaveBeenCalledWith('c1', 'e1');
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });
});

describe('reenviar a firma con el sobre anterior sin firmar', () => {
  const sobreNuevo = () => enqueue('solicitudes_firma', { data: null, error: null }, { data: { id: 's-nuevo' }, error: null });

  it('vivo en Auco: se anula, se cierra y recién entonces sale el nuevo', async () => {
    vi.mocked(auco.getDocumentStatus).mockResolvedValue({ status: 'CREATED', signProfile: [] } as never);
    vi.mocked(auco.cancelDocument).mockResolvedValue({ success: true });
    prepararReenvio();
    sobreNuevo();
    await crearSolicitudFirmaMultiparte('c1', 'u1');
    expect(auco.cancelDocument).toHaveBeenCalledWith('DOC-VIEJO', expect.objectContaining({ email: 'sender@cofianza.com' }));
    expect(marcado('cancelado')).toBe(true);
    expect(vi.mocked(auco.cancelDocument).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(auco.uploadDocumentForSignature).mock.invocationCallOrder[0],
    );
  });

  it('ya vencido en Auco: no hace falta anularlo; queda vencido y sale el nuevo', async () => {
    vi.mocked(auco.getDocumentStatus).mockResolvedValue({ status: 'EXPIRED', signProfile: [] } as never);
    prepararReenvio();
    sobreNuevo();
    await crearSolicitudFirmaMultiparte('c1', 'u1');
    expect(auco.cancelDocument).not.toHaveBeenCalled();
    expect(marcado('expirado')).toBe(true);
    expect(auco.uploadDocumentForSignature).toHaveBeenCalledTimes(1);
  });

  it('Auco no lo anula (errors.cant) y sigue vivo al releerlo → 503, sin marcarlo ni subir otro', async () => {
    vi.mocked(auco.getDocumentStatus).mockResolvedValue({ status: 'CREATED', signProfile: [] } as never);
    vi.mocked(auco.cancelDocument).mockResolvedValue({ success: true, errors: { cant: 1 } });
    prepararReenvio();
    await expect(crearSolicitudFirmaMultiparte('c1', 'u1')).rejects.toMatchObject({ statusCode: 503, errorCode: 'AUCO_NO_VERIFICABLE' });
    expect(de('solicitudes_firma', 'update')).toEqual([]);
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });

  it('la anulación falla por red pero al releerlo ya está cerrado (rechazado) → sigue', async () => {
    vi.mocked(auco.getDocumentStatus)
      .mockResolvedValueOnce({ status: 'CREATED', signProfile: [] } as never)
      .mockResolvedValueOnce({ status: 'REJECTED', signProfile: [] } as never);
    vi.mocked(auco.cancelDocument).mockRejectedValue(new Error('ECONNRESET'));
    prepararReenvio();
    sobreNuevo();
    await crearSolicitudFirmaMultiparte('c1', 'u1');
    expect(marcado('cancelado')).toBe(true);
    expect(auco.uploadDocumentForSignature).toHaveBeenCalledTimes(1);
  });

  it('si no se puede leer el sobre en Auco, o los sobres en la base → 503 sin subir nada', async () => {
    vi.mocked(auco.getDocumentStatus).mockRejectedValue(new Error('timeout'));
    prepararReenvio();
    await expect(crearSolicitudFirmaMultiparte('c1', 'u1')).rejects.toMatchObject({ statusCode: 503 });

    queues.clear();
    prepararReenvio();
    queues.set('solicitudes_firma', [{ data: null, error: { message: 'timeout' } }]);
    await expect(crearSolicitudFirmaMultiparte('c1', 'u1')).rejects.toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });

  it('los firmantes del sobre anterior no quedan «cancelado» (se leería como un rechazo)', async () => {
    vi.mocked(auco.getDocumentStatus).mockResolvedValue({ status: 'EXPIRED', signProfile: [] } as never);
    prepararReenvio();
    sobreNuevo();
    await crearSolicitudFirmaMultiparte('c1', 'u1');
    expect(de('contrato_firmantes', 'update')).toEqual([]);
  });

  it('un firmante (flag apagado): el mismo cierre seguro antes de abrir la solicitud nueva', async () => {
    vi.mocked(auco.getDocumentStatus).mockResolvedValue({ status: 'CREATED', signProfile: [] } as never);
    vi.mocked(auco.cancelDocument).mockResolvedValue({ success: false, errors: { cant: 1 } });
    enqueue('contratos', {
      data: { id: 'c1', estado: 'pendiente_firma', expediente_id: 'e1', storage_key: 'k.pdf', nombre_archivo: 'c.pdf', destinacion: null, datos_variables: {} },
      error: null,
    });
    enqueue('expedientes', { data: { numero: 'EXP-1', inmuebles: null, solicitantes: null }, error: null });
    enqueue('solicitudes_firma', { data: [VIEJO], error: null });
    await expect(
      crearSolicitudFirma({ contrato_id: 'c1', nombre_firmante: 'Juan', email_firmante: 'juan@x.co', telefono_firmante: '3001112233' } as never, 'u1'),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });
});

describe('si el sobre no queda registrado después de subir el documento (revisión 2, punto 7)', () => {
  /** Primer envío: sin sobres anteriores. */
  function prepararPrimerEnvio() {
    prepararReenvio();
    queues.set('solicitudes_firma', [{ data: [], error: null }]);
  }

  it('doble clic contra el índice de un solo sobre activo → anula el documento recién subido y 409', async () => {
    prepararPrimerEnvio();
    enqueue('solicitudes_firma', { data: null, error: { code: '23505', message: 'duplicate key' } });
    vi.mocked(auco.cancelDocument).mockResolvedValue({ success: true });
    await expect(crearSolicitudFirmaMultiparte('c1', 'u1')).rejects.toMatchObject({ statusCode: 409, errorCode: 'FIRMA_YA_EN_CURSO' });
    expect(auco.cancelDocument).toHaveBeenCalledWith('DOC-NUEVO', expect.objectContaining({ email: 'sender@cofianza.com' }));
  });

  it('si no se pueden quitar los firmantes anteriores: 500, y el documento y su sobre se deshacen', async () => {
    prepararPrimerEnvio();
    enqueue('solicitudes_firma', { data: { id: 's-nuevo' }, error: null });
    enqueue('contrato_firmantes', { data: null, error: { message: 'timeout' } });
    vi.mocked(auco.cancelDocument).mockResolvedValue({ success: true });
    await expect(crearSolicitudFirmaMultiparte('c1', 'u1')).rejects.toMatchObject({ statusCode: 500 });
    expect(auco.cancelDocument).toHaveBeenCalledWith('DOC-NUEVO', expect.anything());
    expect(marcado('cancelado')).toBe(true);
    expect(de('contrato_firmantes', 'insert')).toEqual([]);
  });

  it('un firmante: doble clic → anula el documento recién subido y 409', async () => {
    enqueue('contratos', {
      data: { id: 'c1', estado: 'pendiente_firma', expediente_id: 'e1', storage_key: 'k.pdf', nombre_archivo: 'c.pdf', destinacion: null, datos_variables: {} },
      error: null,
    });
    enqueue('expedientes', { data: { numero: 'EXP-1', inmuebles: null, solicitantes: null }, error: null });
    enqueue('solicitudes_firma', { data: [], error: null }, { data: null, error: { code: '23505', message: 'duplicate key' } });
    vi.mocked(auco.cancelDocument).mockResolvedValue({ success: true });
    await expect(
      crearSolicitudFirma({ contrato_id: 'c1', nombre_firmante: 'Juan', email_firmante: 'juan@x.co', telefono_firmante: '3001112233' } as never, 'u1'),
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'FIRMA_YA_EN_CURSO' });
    expect(auco.cancelDocument).toHaveBeenCalledWith('DOC-NUEVO', expect.anything());
  });
});

describe('un firmante: reenviar a otro correo sube un documento nuevo (revisión 2, punto 9)', () => {
  const solicitud = {
    data: {
      id: 's1', contrato_id: 'c1', nombre_firmante: 'Juan', email_firmante: 'juan@x.co', telefono_firmante: '3001112233',
      estado: 'enviado', envios_realizados: 1, max_envios: 5, auco_document_code: 'DOC-VIEJO',
      token_expiracion: new Date(Date.now() + 86_400_000).toISOString(),
      contratos: { expediente_id: 'e1', storage_key: 'k.pdf', nombre_archivo: null, datos_variables: { v: 1 }, expedientes: null },
    },
    error: null,
  };
  const reenviar = () => reenviarSolicitudFirma('s1', 'u1', 'propietario', undefined, 'otro@x.co');

  it('con el documento anterior ya firmado en Auco → 409 y no sube otro', async () => {
    vi.mocked(auco.getDocumentStatus).mockResolvedValue({ status: 'FINISH', url: 'https://auco/f.pdf', signProfile: [] } as never);
    enqueue('solicitudes_firma', solicitud, { data: { id: 's1', contrato_id: 'c1', estado: 'enviado', nombre_firmante: 'Juan', email_firmante: 'juan@x.co' }, error: null });
    enqueue('contrato_firmantes', { count: 0, error: null }, { data: [], error: null });
    await expect(reenviar()).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_YA_FIRMADO' });
    expect(assertPuedeAbrirSobre).toHaveBeenCalledWith('c1', 'e1', { v: 1 }, 's1');
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
    expect(marcado('firmado')).toBe(true);
  });

  it('si Auco no anula el documento anterior → 503 y no sube otro', async () => {
    vi.mocked(auco.getDocumentStatus).mockResolvedValue({ status: 'CREATED', signProfile: [] } as never);
    vi.mocked(auco.cancelDocument).mockResolvedValue({ success: false, errors: { cant: 1 } });
    enqueue('solicitudes_firma', solicitud);
    enqueue('contrato_firmantes', { count: 0, error: null });
    await expect(reenviar()).rejects.toMatchObject({ statusCode: 503 });
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });

  it('con el anterior anulado, sube el nuevo con el plazo de firma', async () => {
    vi.mocked(auco.getDocumentStatus).mockResolvedValue({ status: 'CREATED', signProfile: [] } as never);
    vi.mocked(auco.cancelDocument).mockResolvedValue({ success: true });
    enqueue('solicitudes_firma', solicitud, { data: { id: 's1' }, error: null });
    enqueue('contrato_firmantes', { count: 0, error: null });
    await reenviar();
    expect(auco.cancelDocument).toHaveBeenCalledWith('DOC-VIEJO', expect.anything());
    expect(auco.uploadDocumentForSignature).toHaveBeenCalledWith(expect.objectContaining({ expiredDate: '2026-10-10T04:59:59.000Z' }));
    expect(de('solicitudes_firma', 'update')[0].args[0]).toMatchObject({ auco_document_code: 'DOC-NUEVO', email_firmante: 'otro@x.co' });
  });
});

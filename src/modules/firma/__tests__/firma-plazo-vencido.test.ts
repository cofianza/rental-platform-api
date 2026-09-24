import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Firma del contrato viejo: el plazo es el de la Adenda 1 de contratos
// (respuesta 10, P5) y un sobre vencido o rechazado en Auco deja de figurar
// activo, sin recordatorios que no llegan a nadie (contratos-firma-2).
// Mock de Supabase con colas por tabla; `ops` registra lo que se escribió.
// ============================================================

const { ops, enqueue, queues, mockPlazo } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  return {
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockPlazo: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => {
  const next = (t: string) => queues.get(t)?.shift() ?? { data: null, error: null };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'not', 'order', 'limit']) {
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
vi.mock('@/modules/contratos/contratos.service', () => ({ plazoFirmaContrato: (...a: unknown[]) => mockPlazo(...a) }));
vi.mock('@/lib/auco', () => ({
  normalizePhoneToInternational: vi.fn((t?: string | null) => (t ? `+57${t}` : null)),
  bufferToBase64: vi.fn(() => 'JVBERg=='),
  uploadDocumentForSignature: vi.fn(async () => 'DOC-NUEVO'),
  getDocumentStatus: vi.fn(),
  sendReminder: vi.fn(),
}));

import { AppError } from '@/lib/errors';
import * as auco from '@/lib/auco';
import { crearSolicitudFirmaMultiparte, reconciliarFirmantesConAuco, reconciliarFirmantesPorWebhook } from '../firma-multiparte.service';
import { reenviarSolicitudFirma } from '../firma.service';

const PLAZO = '2026-10-10T04:59:59.000Z';
const de = (table: string, method: string) => ops.filter((o) => o.table === table && o.method === method);

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  mockPlazo.mockResolvedValue(PLAZO);
});

describe('P5: el sobre multi-parte sale con el plazo de la Adenda (no 72 horas)', () => {
  function prepararSobre() {
    enqueue('contratos', { data: { id: 'c1', estado: 'pendiente_firma', expediente_id: 'e1', storage_key: 'k.pdf', destinacion: null }, error: null });
    enqueue('contratos', { data: { id: 'c1', expediente_id: 'e1' }, error: null }); // derivarFirmantes
    enqueue('expedientes', {
      data: {
        id: 'e1',
        solicitantes: { id: 'sol1', nombre: 'Juan', apellido: 'Pérez', email: 'juan@x.co', telefono: '3001112233', tipo_documento: 'cc', numero_documento: '10' },
        inmuebles: { propietario_id: 'prop-1', inmobiliaria_id: null },
      },
      error: null,
    });
    enqueue('perfiles', { data: { id: 'prop-1', nombre: 'Ana', apellido: 'Gómez', rol: 'propietario', whatsapp_recaudo: '3104445566', email_recaudo: 'ana@x.co' }, error: null });
    enqueue('solicitudes_firma', { data: { id: 's1' }, error: null });
  }

  it('Auco y el sobre llevan el plazo calculado (15 días sin pasar el CRC)', async () => {
    prepararSobre();
    await crearSolicitudFirmaMultiparte('c1', 'u1');
    expect(mockPlazo).toHaveBeenCalledWith('e1');
    expect(auco.uploadDocumentForSignature).toHaveBeenCalledWith(expect.objectContaining({ expiredDate: PLAZO }));
    expect(de('solicitudes_firma', 'insert')[0].args[0]).toMatchObject({ token_expiracion: PLAZO });
  });

  it('sin margen de CRC no se sube nada a Auco', async () => {
    prepararSobre();
    mockPlazo.mockRejectedValue(AppError.conflict('Al certificado de riesgo le quedan menos de tres días de vigencia', 'CRC_SIN_MARGEN'));
    await expect(crearSolicitudFirmaMultiparte('c1', 'u1')).rejects.toMatchObject({ errorCode: 'CRC_SIN_MARGEN' });
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
    expect(de('solicitudes_firma', 'insert')).toEqual([]);
  });
});

describe('contratos-firma-2: el sobre vencido o rechazado deja de estar activo', () => {
  const sobreCerrado = () => de('solicitudes_firma', 'update').map((o) => o.args[0]);
  const soloSiSigueActivo = () =>
    expect(de('solicitudes_firma', 'in').map((o) => o.args)).toContainEqual(['estado', ['enviado', 'abierto']]);

  it('webhook EXPIRED → el sobre queda vencido', async () => {
    await reconciliarFirmantesPorWebhook('c1', { id: 's1', estado: 'enviado' }, { status: 'EXPIRED' });
    expect(sobreCerrado()).toEqual([expect.objectContaining({ estado: 'expirado' })]);
    soloSiSigueActivo();
  });

  it('webhook REJECTED de una parte → esa parte y el sobre quedan cancelados', async () => {
    await reconciliarFirmantesPorWebhook('c1', { id: 's1', estado: 'enviado' }, { status: 'REJECTED', signer: { email: 'ana@x.co' } });
    expect(de('contrato_firmantes', 'update')[0].args[0]).toMatchObject({ estado: 'cancelado' });
    expect(sobreCerrado()).toEqual([expect.objectContaining({ estado: 'cancelado' })]);
  });

  it('sin webhook: al consultar Auco y verlo vencido, se cierra igual', async () => {
    enqueue('solicitudes_firma', { data: { id: 's1', estado: 'enviado', auco_document_code: 'DOC1' }, error: null });
    vi.mocked(auco.getDocumentStatus).mockResolvedValue({ status: 'EXPIRED', signProfile: [] } as never);
    await reconciliarFirmantesConAuco('c1');
    expect(sobreCerrado()).toEqual([expect.objectContaining({ estado: 'expirado' })]);
  });
});

describe('contratos-firma-2: el recordatorio', () => {
  const solicitud = (o: Record<string, unknown> = {}) => ({
    data: {
      id: 's1', contrato_id: 'c1', nombre_firmante: 'Juan', email_firmante: 'juan@x.co', telefono_firmante: '3001112233',
      estado: 'enviado', envios_realizados: 1, max_envios: 5, auco_document_code: 'DOC1', token_expiracion: '2026-12-31T04:59:59Z',
      contratos: { expediente_id: 'e1', storage_key: 'k.pdf', nombre_archivo: null, expedientes: null },
      ...o,
    },
    error: null,
  });

  it.each([
    ['vencido en Auco', { estado: 'expirado' }],
    ['con el plazo ya pasado aunque el aviso no llegó', { token_expiracion: '2026-01-01T04:59:59Z' }],
  ])('%s → 409 y no se le pide nada a Auco', async (_caso, o) => {
    enqueue('solicitudes_firma', solicitud(o));
    await expect(reenviarSolicitudFirma('s1', 'u1', 'propietario')).rejects.toMatchObject({ statusCode: 409, errorCode: 'FIRMA_VENCIDA' });
    expect(auco.sendReminder).not.toHaveBeenCalled();
    expect(de('solicitudes_firma', 'update')).toEqual([]);
  });

  it('si Auco falla, se dice (antes: «Recordatorio enviado» sin enviar nada)', async () => {
    enqueue('solicitudes_firma', solicitud());
    vi.mocked(auco.sendReminder).mockRejectedValue(new Error('Auco caído'));
    await expect(reenviarSolicitudFirma('s1', 'u1', 'propietario')).rejects.toMatchObject({ statusCode: 502 });
    expect(de('solicitudes_firma', 'update')).toEqual([]);
  });

  it('un recordatorio no mueve el plazo (el de Auco no cambia)', async () => {
    enqueue('solicitudes_firma', solicitud(), { data: { id: 's1' }, error: null });
    vi.mocked(auco.sendReminder).mockResolvedValue(undefined);
    await reenviarSolicitudFirma('s1', 'u1', 'propietario');
    const update = de('solicitudes_firma', 'update')[0].args[0] as Record<string, unknown>;
    expect(update).toMatchObject({ envios_realizados: 2 });
    expect(update).not.toHaveProperty('token_expiracion');
    expect(mockPlazo).not.toHaveBeenCalled();
  });
});

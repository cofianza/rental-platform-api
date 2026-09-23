import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock de Supabase con colas por tabla: cada .from(tabla) consume la siguiente
// respuesta encolada para esa tabla.
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), storage: {} }, supabaseAuth: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: { AUCO_SENDER_EMAIL: 'sender@cofianza.com' } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn() }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(),
  findPerfilIdByEmail: vi.fn(),
}));
vi.mock('@/lib/auco', () => ({
  normalizePhoneToInternational: vi.fn(() => '+573001112233'),
  bufferToBase64: vi.fn(),
  uploadDocumentForSignature: vi.fn(),
  sendReminder: vi.fn(),
}));

import { reenviarSolicitudFirmaSelf } from '../firma.service';
import { supabase } from '@/lib/supabase';
import * as auco from '@/lib/auco';

const colas: Record<string, Array<Record<string, unknown>>> = {};

function montarMock() {
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    const resp = colas[table]?.shift() ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'update']) chain[m] = () => chain;
    chain.single = chain.maybeSingle = async () => resp;
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(resp).then(ok);
    return chain;
  }) as never);
}

function solicitudSelf(envios: number, max = 5) {
  return {
    data: {
      id: 's1',
      contrato_id: 'c1',
      envios_realizados: envios,
      max_envios: max,
      contratos: { expediente_id: 'e1', expedientes: { solicitante_id: 'sol1' } },
    },
    error: null,
  };
}

const solicitanteDueno = { data: { id: 'sol1', creado_por: 'u1' }, error: null };

function solicitudCompleta(envios: number) {
  return {
    data: {
      id: 's1', contrato_id: 'c1', nombre_firmante: 'Ana', email_firmante: 'ana@x.co',
      telefono_firmante: '3001112233', estado: 'enviado', envios_realizados: envios, max_envios: 5,
      auco_document_code: 'DOC1',
      contratos: { expediente_id: 'e1', storage_key: 'k.pdf', nombre_archivo: null, expedientes: null },
    },
    error: null,
  };
}

describe('reenviarSolicitudFirmaSelf — cupo de envíos', () => {
  beforeEach(() => {
    for (const k of Object.keys(colas)) delete colas[k];
    vi.mocked(auco.sendReminder).mockReset();
    montarMock();
  });

  it('con un solo envío restante, el arrendatario no lo gasta: queda para quien arrienda', async () => {
    colas.solicitudes_firma = [solicitudSelf(4)];
    colas.solicitantes = [solicitanteDueno];

    await expect(reenviarSolicitudFirmaSelf('s1', 'u1')).rejects.toMatchObject({ errorCode: 'MAX_ENVIOS_SELF' });
    expect(auco.sendReminder).not.toHaveBeenCalled();
  });

  it('con envíos de sobra, reenvía el recordatorio', async () => {
    colas.solicitudes_firma = [
      solicitudSelf(2),
      solicitudCompleta(2),
      { data: { id: 's1', envios_realizados: 3 }, error: null },
    ];
    colas.solicitantes = [solicitanteDueno];

    await expect(reenviarSolicitudFirmaSelf('s1', 'u1')).resolves.toMatchObject({ envios_realizados: 3 });
    expect(auco.sendReminder).toHaveBeenCalledWith('DOC1');
  });
});

describe('reenviarSolicitudFirmaSelf — otro correo en un contrato multi-parte', () => {
  beforeEach(() => {
    for (const k of Object.keys(colas)) delete colas[k];
    montarMock();
  });

  it('responde sin jerga interna (ni "sobre" ni "multi-parte")', async () => {
    colas.solicitudes_firma = [solicitudSelf(1), solicitudCompleta(1)];
    colas.solicitantes = [solicitanteDueno];
    colas.contrato_firmantes = [{ count: 3, error: null }];

    const err = await reenviarSolicitudFirmaSelf('s1', 'u1', undefined, 'otro@x.co').catch((e: unknown) => e);
    expect(err).toMatchObject({ errorCode: 'FIRMA_MULTIPARTE_NO_EMAIL_OVERRIDE' });
    expect((err as Error).message).not.toMatch(/sobre|multi-parte/i);
  });
});

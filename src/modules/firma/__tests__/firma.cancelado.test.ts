import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cancelar un contrato en firma debe anular el sobre en Auco (con message y
// email, que Auco exige) y un webhook tardío de ese sobre no puede volver
// 'firmado' al firmante ni al sobre.
const { st, cancelDocument } = vi.hoisted(() => ({
  st: {
    sobre: { id: 's1', contrato_id: 'c1', estado: 'cancelado', auco_document_code: 'ABC', contratos: { expediente_id: 'e1' } },
    updates: [] as Array<{ table: string; data: Record<string, unknown> }>,
  },
  cancelDocument: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const row = () => (table === 'solicitudes_firma' ? st.sobre : table === 'contrato_firmantes' ? [{ id: 'f1' }] : null);
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'not', 'order', 'limit']) chain[m] = () => chain;
    chain.update = (data: Record<string, unknown>) => {
      st.updates.push({ table, data });
      return chain;
    };
    chain.single = chain.maybeSingle = async () => ({ data: row(), error: null });
    chain.then = (res: (v: unknown) => unknown) => res({ data: row(), error: null });
    return chain;
  };
  return { supabase: { from, rpc: vi.fn(), storage: {} } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { AUCO_SENDER_EMAIL: 'sender@cofianza.com' } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/auco', () => ({ cancelDocument, getDocumentStatus: vi.fn(async () => ({ status: 'CREATED', signProfile: [] })) }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn(), findPerfilIdByEmail: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn() }));

import { handleAucoWebhook, cancelarSolicitud } from '../firma.service';

beforeEach(() => {
  st.updates = [];
  cancelDocument.mockClear();
});

describe('sobre cancelado', () => {
  it('un NOTIFICATION tardío no toca firmantes ni sobre', async () => {
    st.sobre.estado = 'cancelado';
    await handleAucoWebhook({ code: 'ABC', status: 'NOTIFICATION', signer: { email: 'a@b.co' } } as never);
    expect(st.updates).toEqual([]);
  });

  it('cancelar la solicitud anula el sobre en Auco con message y email', async () => {
    st.sobre.estado = 'enviado';
    await cancelarSolicitud('s1', 'u1', 'administrador');
    expect(cancelDocument).toHaveBeenCalledWith('ABC', {
      message: expect.any(String),
      email: 'sender@cofianza.com',
    });
  });
});

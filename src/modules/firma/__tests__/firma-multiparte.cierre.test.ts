import { describe, it, expect, vi, beforeEach } from 'vitest';

// Con todas las firmas, el webhook de Auco debe dejar el contrato 'vigente' sin
// esperar a que alguien abra el estudio: pendiente_firma → firmado → vigente,
// con fecha_firma = la hora en que se cerró el sobre.
const { st, rpc } = vi.hoisted(() => {
  const st = {
    contratoEstado: 'pendiente_firma',
    sobre: { id: 's1', estado: 'enviado', firmado_en: null as string | null },
    updates: [] as Array<{ table: string; data: Record<string, unknown> }>,
  };
  const rpc = vi.fn(async (_fn: string, args: { p_nuevo_estado: string }) => {
    st.contratoEstado = args.p_nuevo_estado;
    return { error: null };
  });
  return { st, rpc };
});

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const row = () => {
      if (table === 'contratos') return { id: 'c1', estado: st.contratoEstado, expediente_id: 'e1' };
      if (table === 'solicitudes_firma') return st.sobre;
      if (table === 'contrato_firmantes') return [{ estado: 'firmado' }, { estado: 'firmado' }];
      return null;
    };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'order', 'limit', 'insert']) chain[m] = () => chain;
    chain.update = (data: Record<string, unknown>) => {
      st.updates.push({ table, data });
      if (table === 'solicitudes_firma') Object.assign(st.sobre, data);
      return chain;
    };
    chain.single = chain.maybeSingle = async () => ({ data: row(), error: null });
    chain.then = (res: (v: unknown) => unknown) => res({ data: row(), error: null });
    return chain;
  };
  return { supabase: { from, rpc, storage: {} }, supabaseAuth: {} };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { RESEND_API_KEY: 're_test', AUCO_SENDER_EMAIL: 'sender@cofianza.com' } }));
vi.mock('@/config/env', () => ({ env: { RESEND_API_KEY: 're_test', AUCO_SENDER_EMAIL: 'sender@cofianza.com' } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/auco', () => ({
  normalizePhoneToInternational: vi.fn(),
  bufferToBase64: vi.fn(),
  uploadDocumentForSignature: vi.fn(),
  getDocumentStatus: vi.fn(),
}));

import { reconciliarFirmantesPorWebhook } from '../firma-multiparte.service';
import { maybeAutoTransicionarFirmado } from '@/modules/contratos/contratos.service';

beforeEach(() => {
  st.contratoEstado = 'pendiente_firma';
  st.sobre = { id: 's1', estado: 'enviado', firmado_en: null };
  st.updates = [];
  rpc.mockClear();
});

describe('cierre del sobre multi-parte', () => {
  it('FINISH lleva el contrato a firmado y luego a vigente, con la hora real de la firma', async () => {
    await reconciliarFirmantesPorWebhook('c1', { id: 's1', estado: 'enviado' }, { status: 'FINISH' });

    expect(rpc.mock.calls.map((c) => (c[1] as { p_nuevo_estado: string }).p_nuevo_estado)).toEqual(['firmado', 'vigente']);
    expect(st.contratoEstado).toBe('vigente');
    const fecha = st.updates.find((u) => u.table === 'contratos' && 'fecha_firma' in u.data)?.data.fecha_firma;
    expect(fecha).toBe(st.sobre.firmado_en);
  });

  it('si el sobre más reciente no está firmado, el contrato no se mueve', async () => {
    st.sobre = { id: 's2', estado: 'cancelado', firmado_en: null };
    await maybeAutoTransicionarFirmado('c1');
    expect(rpc).not.toHaveBeenCalled();
    expect(st.contratoEstado).toBe('pendiente_firma');
  });
});

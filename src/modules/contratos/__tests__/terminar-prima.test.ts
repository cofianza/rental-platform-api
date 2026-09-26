import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Terminar un contrato que llegó a FIANZA ACTIVA no anula el cobro de la prima
// (concepto 'garantia'): se causó al activarse la fianza. Los demás cobros
// pendientes del estudio sí se cancelan, como antes. Supabase sin colas: toda
// lectura responde vacío (sin contrato sucesor ni inmueble → «liberado»).
// ============================================================

const { mockRpc, mockCancelarPagos } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockCancelarPagos: vi.fn(async () => 0),
}));

vi.mock('@/config', () => ({ env: {} }));
vi.mock('@/config/env', () => ({ env: {} }));
vi.mock('@/lib/supabase', () => {
  const fila = { id: 'cto-1', expediente_id: 'exp-1', estado: 'vigente', storage_key: 'k.pdf', destinacion: 'vivienda' };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'not', 'in', 'order', 'limit']) chain[m] = () => chain;
    chain.single = chain.maybeSingle = async () => ({ data: table === 'contratos' ? fila : null, error: null });
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
    return chain;
  };
  return { supabase: { from, rpc: (...a: unknown[]) => mockRpc(...a) } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', async (orig) => ({ ...(await orig<typeof import('@/lib/auditLog')>()), logAudit: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn(async () => undefined) }));
vi.mock('../contratos.service', () => ({
  getContratoById: vi.fn(async () => ({ id: 'cto-1' })),
  enviarContratoAFirma: vi.fn(),
  notificarPartesContratoTerminado: vi.fn(async () => undefined),
}));
vi.mock('@/modules/moras/moras.service', () => ({ anotarContratoTerminadoEnMoras: vi.fn(async () => undefined) }));
vi.mock('@/modules/pagos/pagos.service', () => ({ cancelarPagosPendientesDeExpediente: mockCancelarPagos }));

import { executeContratoTransition } from '../contrato-workflow.service';

const ADMIN = { id: 'admin-1', rol: 'administrador', email: 'a@cofianza.co' } as never;

beforeEach(() => vi.clearAllMocks());

describe('terminar una fianza activa', () => {
  it('cancela los cobros pendientes del estudio salvo la prima (garantia)', async () => {
    mockRpc.mockResolvedValueOnce({ data: { estado_anterior: 'vigente', estado_nuevo: 'finalizado' }, error: null });
    const terminar = { nuevo_estado: 'finalizado', comentario: 'Entregó el inmueble', motivo: 'Mutuo acuerdo' } as never;

    await executeContratoTransition('cto-1', terminar, ADMIN);

    await vi.waitFor(() => expect(mockCancelarPagos).toHaveBeenCalled());
    const [expedienteId, , conceptos] = mockCancelarPagos.mock.calls[0] as unknown as [string, string, string[]];
    expect(expedienteId).toBe('exp-1');
    expect(conceptos).toEqual(['estudio', 'primer_canon', 'deposito', 'otro']);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Revisión 2026-10-08 (BLQ-1): pagar (cupo o pasarela) después de un bloqueo
// por documento o de «no soy yo» no reenvía el enlace solo: ese envío no lleva
// rol y se saltaría el tope de reenvíos y el bloqueo de «no soy yo» (BLQ §8.2, §4.5).

const { ops, mockLeerBloqueo, mockEnviar } = vi.hoisted(() => ({
  ops: [] as Array<{ table: string; method: string; args: unknown[] }>,
  mockLeerBloqueo: vi.fn(),
  mockEnviar: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'is', 'in', 'or', 'order', 'limit']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    // Sin autorización pendiente ni autorizada (la última quedó 'expirado').
    chain.single = chain.maybeSingle = async () => ({ data: null, error: null });
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
    return chain;
  };
  return { supabase: { from } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/config/env', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('../orchestrator.emails', () => ({}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn(), notificarResponsableExpediente: vi.fn() }));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ resolveNombreDueno: vi.fn() }));
vi.mock('@/modules/autorizaciones/bloqueo-documento', () => ({ leerBloqueo: mockLeerBloqueo }));
vi.mock('@/modules/autorizaciones/autorizaciones.service', () => ({ enviarEnlaceAutorizacion: mockEnviar }));

import { onEstudioPagado } from '../orchestrator.service';

const timeline = () => ops.filter((o) => o.table === 'eventos_timeline' && o.method === 'insert');

describe('onEstudioPagado tras un bloqueo', () => {
  beforeEach(() => {
    ops.length = 0;
    mockEnviar.mockClear();
  });

  it.each([
    [{ estado: 'bloqueado_documento', motivo: 'intentos' }],
    [{ estado: 'identidad_rechazada', motivo: 'no_soy_yo' }],
    [{ estado: 'pendiente_reenvio', motivo: 'no_soy_yo' }],
    [{ estado: 'pendiente_reenvio', motivo: 'datos_incorrectos' }],
  ])('no reenvía el enlace (%o)', async (bloqueo) => {
    mockLeerBloqueo.mockResolvedValueOnce(bloqueo);
    await expect(onEstudioPagado('exp-1', 'gestor-1')).resolves.toBe(false);
    expect(mockEnviar).not.toHaveBeenCalled();
    expect(timeline()).toHaveLength(1);
  });

  it('sin bloqueo, el pago sigue mandando el enlace', async () => {
    mockLeerBloqueo.mockResolvedValueOnce({ estado: null, motivo: null });
    await onEstudioPagado('exp-1', 'gestor-1');
    expect(mockEnviar).toHaveBeenCalledWith('exp-1', 'gestor-1');
  });
});

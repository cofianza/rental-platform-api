import { describe, it, expect, vi } from 'vitest';

// Mocks de dependencias con efectos al importar el módulo.
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), storage: {} }, supabaseAuth: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FIRMA_MULTIPARTE_ENABLED: false, AUCO_SENDER_EMAIL: 'sender@cofianza.com' } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/auco', () => ({
  normalizePhoneToInternational: vi.fn(),
  bufferToBase64: vi.fn(),
  uploadDocumentForSignature: vi.fn(),
  getDocumentStatus: vi.fn(),
}));

import { mapAucoSignerStatusToEstado, todasFirmaron } from '../firma-multiparte.service';

describe('mapAucoSignerStatusToEstado', () => {
  it('FINISH → firmado', () => {
    expect(mapAucoSignerStatusToEstado('FINISH')).toBe('firmado');
  });
  it('REJECT y BLOCK → cancelado', () => {
    expect(mapAucoSignerStatusToEstado('REJECT')).toBe('cancelado');
    expect(mapAucoSignerStatusToEstado('BLOCK')).toBe('cancelado');
  });
  it('NOTIFICATION → abierto, PENDING → enviado', () => {
    expect(mapAucoSignerStatusToEstado('NOTIFICATION')).toBe('abierto');
    expect(mapAucoSignerStatusToEstado('PENDING')).toBe('enviado');
  });
  it('estado desconocido → null (sin cambio)', () => {
    expect(mapAucoSignerStatusToEstado('LO_QUE_SEA')).toBeNull();
  });
});

describe('todasFirmaron', () => {
  it('true solo si hay filas y todas están firmado', () => {
    expect(todasFirmaron([{ estado: 'firmado' }, { estado: 'firmado' }, { estado: 'firmado' }])).toBe(true);
  });
  it('false si alguna no está firmado', () => {
    expect(todasFirmaron([{ estado: 'firmado' }, { estado: 'abierto' }])).toBe(false);
  });
  it('false si la lista está vacía', () => {
    expect(todasFirmaron([])).toBe(false);
  });
});

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

import { mapAucoSignerStatusToEstado, todasFirmaron, crearSolicitudFirmaMultiparte } from '../firma-multiparte.service';
import { supabase } from '@/lib/supabase';
import { env } from '@/config';
import * as auco from '@/lib/auco';

// Adenda 2 §9: con la biometria encendida, ningun camino (tampoco el POST
// legacy /firma/solicitudes) crea el sobre si el arrendatario no paso por la
// verificacion de identidad.
describe('crearSolicitudFirmaMultiparte — gate de la biometria de firma', () => {
  it('sin verificacion del arrendatario: 409 y no se sube nada a Auco', async () => {
    (env as Record<string, unknown>).FIRMA_BIOMETRIA_ENABLED = true;
    const filas: Record<string, unknown> = {
      contratos: { data: { id: 'c1', estado: 'pendiente_firma', expediente_id: 'e1', storage_key: 'k.pdf' }, error: null },
      firma_verificacion_identidad: { data: null, error: null },
    };
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) chain[m] = () => chain;
      chain.single = chain.maybeSingle = async () => filas[table];
      return chain;
    }) as never);

    await expect(crearSolicitudFirmaMultiparte('c1', 'u1')).rejects.toMatchObject({ errorCode: 'VERIFICACION_IDENTIDAD_PENDIENTE' });
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
    (env as Record<string, unknown>).FIRMA_BIOMETRIA_ENABLED = false;
  });
});

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

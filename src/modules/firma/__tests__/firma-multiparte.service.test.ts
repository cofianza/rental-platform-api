import { describe, it, expect, vi } from 'vitest';

// Mocks de dependencias con efectos al importar el módulo.
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), storage: {} }, supabaseAuth: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FIRMA_MULTIPARTE_ENABLED: false, AUCO_SENDER_EMAIL: 'sender@cofianza.com' } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
const { mockGuard } = vi.hoisted(() => ({ mockGuard: vi.fn(async () => undefined) }));
vi.mock('@/lib/tenantScope', async (orig) => ({
  ...(await orig<typeof import('@/lib/tenantScope')>()),
  assertExpedienteAccess: (...a: unknown[]) => mockGuard(...(a as [])),
}));
vi.mock('@/lib/auco', () => ({
  normalizePhoneToInternational: vi.fn(),
  bufferToBase64: vi.fn(),
  uploadDocumentForSignature: vi.fn(),
  getDocumentStatus: vi.fn(),
}));

import { mapAucoSignerStatusToEstado, todasFirmaron, crearSolicitudFirmaMultiparte, listarFirmantes } from '../firma-multiparte.service';
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

describe('listarFirmantes — los firmantes salen a la vez que el contrato', () => {
  it('lee los firmantes sin esperar al guard, y con 404 no devuelve nada', async () => {
    const tablas: string[] = [];
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      tablas.push(table);
      const res = table === 'contratos' ? { data: { id: 'c1', expediente_id: 'e1' }, error: null } : { data: [{ id: 'f1' }], error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order']) chain[m] = () => chain;
      chain.single = async () => res;
      chain.then = (r: (v: unknown) => unknown) => Promise.resolve(res).then(r);
      return chain;
    }) as never);

    let soltarGuard!: () => void;
    mockGuard.mockReturnValueOnce(new Promise<undefined>((r) => (soltarGuard = () => r(undefined))));
    const pendiente = listarFirmantes('c1', 'u1', 'inmobiliaria');
    await vi.waitFor(() => expect(mockGuard).toHaveBeenCalledWith('e1', 'u1', 'inmobiliaria'));
    // Con el guard aún pendiente, la consulta de firmantes ya salió (antes, 3 idas en serie).
    expect(tablas).toContain('contrato_firmantes');
    soltarGuard();
    await expect(pendiente).resolves.toEqual({ firmantes: [{ id: 'f1' }] });

    mockGuard.mockRejectedValueOnce(Object.assign(new Error('Estudio no encontrado'), { statusCode: 404 }));
    await expect(listarFirmantes('c1', 'intruso', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
  });
});

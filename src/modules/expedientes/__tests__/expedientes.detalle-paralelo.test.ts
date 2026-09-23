/**
 * Detalle del estudio: el guard de tenant y la lectura van en paralelo (antes
 * en serie: una ida más a Supabase antes de pintar), pero la fila no sale ni
 * se dispara el sync con Auco si el guard dice 404.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queues, ops, mockGuard, mockSyncAuco } = vi.hoisted(() => ({
  queues: new Map<string, Array<Record<string, unknown>>>(),
  ops: [] as Array<{ table: string; method: string }>,
  mockGuard: vi.fn(),
  mockSyncAuco: vi.fn(async () => undefined),
}));

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const next = async () => queues.get(table)?.shift() ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) {
      chain[m] = () => {
        ops.push({ table, method: m });
        return chain;
      };
    }
    chain.single = next;
    return chain;
  };
  return { supabase: { from: (t: string) => chainFor(t), rpc: vi.fn(), storage: { from: vi.fn() } } };
});
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => (typeof k === 'string' && k.endsWith('_ENABLED') ? false : 'x'),
  }),
}));
vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: (...a: unknown[]) => mockGuard(...a) }));
vi.mock('@/modules/firma/firma.service', () => ({ syncFirmaConAucoForExpediente: mockSyncAuco }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: vi.fn() }));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));
vi.mock('@/modules/solicitantes/solicitantes.service', () => ({ getApplicantById: vi.fn() }));
const mockCierre = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => null as unknown));
vi.mock('../cierre-sin-acta', () => ({ leerCierreSinActa: mockCierre }));

import { getExpedienteById } from '../expedientes.service';

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('getExpedienteById', () => {
  it('lee la fila sin esperar a que el guard termine', async () => {
    let soltarGuard!: () => void;
    mockGuard.mockReturnValueOnce(new Promise<void>((r) => (soltarGuard = r)));
    queues.set('expedientes', [{ data: { id: 'e1', estado: 'aprobado' }, error: null }]);

    const detalle = getExpedienteById('e1', 'u1', 'inmobiliaria');
    // Con el guard aún pendiente, la consulta del detalle ya salió.
    expect(ops).toContainEqual({ table: 'expedientes', method: 'select' });
    soltarGuard();

    await expect(detalle).resolves.toMatchObject({ id: 'e1' });
    // Con el guard superado sí se dispara (y se espera aquí para que no caiga en el siguiente test).
    await vi.waitFor(() => expect(mockSyncAuco).toHaveBeenCalledWith('e1'));
  });

  it('si el guard da 404, no sale la fila ni se dispara el sync con Auco', async () => {
    mockGuard.mockRejectedValueOnce(Object.assign(new Error('Estudio no encontrado'), { statusCode: 404 }));
    queues.set('expedientes', [{ data: { id: 'e1', estado: 'aprobado' }, error: null }]);

    await expect(getExpedienteById('e1', 'u2', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    await vi.dynamicImportSettled();
    expect(mockSyncAuco).not.toHaveBeenCalled();
  });
});

describe('getExpedienteById: cierre sin acta (Adenda 1 contratos, respuesta 21)', () => {
  it('trae la constancia en una lectura aparte, en paralelo; al prospecto no', async () => {
    mockGuard.mockResolvedValue(undefined);
    const constancia = { en: '2026-09-23T15:00:00Z', porNombre: 'Ana Admin', motivo: 'La inmobiliaria no levantó el acta' };
    mockCierre.mockResolvedValueOnce(constancia);
    queues.set('expedientes', [
      { data: { id: 'e1', estado: 'cerrado' }, error: null },
      { data: { id: 'e1', estado: 'cerrado' }, error: null },
    ]);
    await expect(getExpedienteById('e1', 'u1', 'inmobiliaria')).resolves.toMatchObject({ cierre_sin_acta: constancia });
    expect(mockCierre).toHaveBeenCalledWith('e1');

    mockCierre.mockClear();
    await expect(getExpedienteById('e1', 's1', 'solicitante')).resolves.toMatchObject({ cierre_sin_acta: null });
    expect(mockCierre).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mockSyncAuco).toHaveBeenCalled());
  });
});

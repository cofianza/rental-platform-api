import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Revisión 3 de Q6, M2: «Cancelar contrato», el envío con un contrato hermano
// en firma y el superseder no cancelan un contrato que todas las partes ya
// firmaron en Auco (el aviso se perdió). La lectura de Auco (exigirSinFirmaCompleta)
// se prueba en firma-reenvio-seguro; aquí, que cada camino la pida y la respete.
// Mock de Supabase con colas por tabla. Nada contra Auco.
// ============================================================

const { ops, enqueue, queues, mockRpc, mockExigir, mockCancelarSolicitudes, mockCrearSobre } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  return {
    ops,
    queues,
    enqueue: (t: string, ...i: Res[]) => queues.set(t, [...(queues.get(t) ?? []), ...i]),
    mockRpc: vi.fn(async () => ({ data: null, error: null })),
    mockExigir: vi.fn(async () => undefined),
    mockCancelarSolicitudes: vi.fn(async () => undefined),
    mockCrearSobre: vi.fn(async () => ({ solicitud_id: 's-nuevo' })),
  };
});

vi.mock('@/config', () => ({ env: { CONTRATOS_V3_ENABLED: false, FIRMA_MULTIPARTE_ENABLED: true, FIRMA_BIOMETRIA_ENABLED: false } }));
vi.mock('@/config/env', () => ({ env: { CONTRATOS_V3_ENABLED: false, FIRMA_MULTIPARTE_ENABLED: true, FIRMA_BIOMETRIA_ENABLED: false } }));
vi.mock('@/lib/supabase', () => {
  const next = (t: string) => queues.get(t)?.shift() ?? { data: null, error: null };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'or', 'lt', 'gt', 'order', 'limit']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.single = chain.maybeSingle = async () => next(table);
    chain.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(next(table)).then(ok, ko);
    return chain;
  };
  return { supabase: { from, rpc: (...a: unknown[]) => mockRpc(...(a as [])), storage: { from: vi.fn() } } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', async (orig) => ({ ...(await orig<typeof import('@/lib/auditLog')>()), logAudit: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(async () => undefined),
  assertInmuebleAccess: vi.fn(async () => undefined),
  resolveAllowedExpedienteIds: vi.fn(async () => null),
  puedeVerFilaExpediente: vi.fn(async () => true),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn(), findPerfilIdByEmail: vi.fn(async () => null) }));
vi.mock('@/modules/estudios/coarrendatario-vinculado', () => ({
  coarrendatarioVinculado: vi.fn(async () => null),
  coarrendatarioVinculadoVerificado: vi.fn(async () => null),
}));
vi.mock('@/lib/pdfRenderer', () => ({ renderHtmlToPdf: vi.fn(async () => Buffer.from('%PDF')) }));
vi.mock('@/modules/firma/firma.service', () => ({
  exigirSinFirmaCompleta: (...a: unknown[]) => mockExigir(...(a as [])),
  cancelarSolicitudesDeContrato: (...a: unknown[]) => mockCancelarSolicitudes(...(a as [])),
  YA_FIRMADO_NO_SE_CANCELA: 'Todas las partes ya firmaron este contrato.',
}));
vi.mock('@/modules/firma/firma-multiparte.service', () => ({
  crearSolicitudFirmaMultiparte: (...a: unknown[]) => mockCrearSobre(...(a as [])),
}));

import { AppError } from '@/lib/errors';
import { executeContratoTransition } from '../contrato-workflow.service';
import { enviarContratoAFirma, supersederContratosEnFirma } from '../contratos.service';

const EXP = 'exp-1';
const CTO = 'cto-1';
const ADMIN = { id: 'admin-1', rol: 'administrador' } as never;
const yaFirmado = (mensaje = 'Ya firmaron todos.') => AppError.conflict(mensaje, 'CONTRATO_YA_FIRMADO');

const de = (t: string, m: string) => ops.filter((o) => o.table === t && o.method === m);
const escrituras = () => ops.filter((o) => ['insert', 'update', 'upsert', 'delete'].includes(o.method));

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('«Cancelar contrato» de un contrato en firma', () => {
  const cancelar = { nuevo_estado: 'cancelado', comentario: 'Se cae el negocio', motivo: 'Desistió' } as never;

  it('si todas las partes ya firmaron en Auco → 409 CONTRATO_YA_FIRMADO y no se cancela', async () => {
    enqueue('contratos', { data: { id: CTO, expediente_id: EXP, estado: 'pendiente_firma', storage_key: 'k.pdf', destinacion: null }, error: null });
    mockExigir.mockRejectedValueOnce(yaFirmado());

    await expect(executeContratoTransition(CTO, cancelar, ADMIN)).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_YA_FIRMADO' });

    // Con Auco caído la cancelación manual no se frena: sigue (lo decide exigirSinFirmaCompleta).
    expect(mockExigir).toHaveBeenCalledWith(CTO, EXP, { mensaje: 'Todas las partes ya firmaron este contrato.', siAucoNoResponde: 'seguir' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockCancelarSolicitudes).not.toHaveBeenCalled();
    expect(escrituras()).toEqual([]);
  });
});

describe('Enviar a firma con otro contrato del estudio en firma', () => {
  it('si todas las partes ya firmaron ese otro contrato → 409, sin enviar este ni cancelar aquel', async () => {
    enqueue(
      'contratos',
      { data: { id: CTO, estado: 'pendiente_firma', expediente_id: EXP, storage_key: 'k.pdf', destinacion: null, datos_variables: null }, error: null },
      { data: [{ id: 'cto-hermano' }], error: null },
    );
    mockExigir.mockResolvedValueOnce(undefined).mockRejectedValueOnce(yaFirmado('Otro contrato de este estudio ya lo firmaron todas las partes.'));

    await expect(enviarContratoAFirma(CTO, 'admin-1', 'administrador')).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_YA_FIRMADO' });

    expect(mockExigir).toHaveBeenNthCalledWith(1, CTO, EXP);
    expect(mockExigir).toHaveBeenNthCalledWith(2, 'cto-hermano', EXP, { mensaje: expect.stringContaining('Otro contrato de este estudio') });
    expect(mockCrearSobre).not.toHaveBeenCalled();
    expect(mockCancelarSolicitudes).not.toHaveBeenCalled();
    expect(escrituras()).toEqual([]);
  });

  it('si no se pueden leer los otros contratos del estudio → 503, sin enviar', async () => {
    enqueue(
      'contratos',
      { data: { id: CTO, estado: 'pendiente_firma', expediente_id: EXP, storage_key: 'k.pdf', destinacion: null, datos_variables: null }, error: null },
      { data: null, error: { message: 'timeout' } },
    );
    await expect(enviarContratoAFirma(CTO, 'admin-1', 'administrador')).rejects.toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
    expect(mockCrearSobre).not.toHaveBeenCalled();
  });
});

describe('Superseder: «un solo contrato en firma por estudio»', () => {
  it('no cancela un hermano que todas las partes ya firmaron, ni uno que Auco no deja confirmar; sí los demás', async () => {
    enqueue('contratos', { data: [{ id: 'h-firmado' }, { id: 'h-sin-auco' }, { id: 'h-vivo' }], error: null });
    mockExigir
      .mockRejectedValueOnce(yaFirmado())
      .mockRejectedValueOnce(new AppError(503, 'AUCO_NO_VERIFICABLE', 'Auco no respondió'))
      .mockResolvedValueOnce(undefined);

    await supersederContratosEnFirma(EXP, CTO, 'admin-1');

    expect(mockExigir.mock.calls.map((c) => c[0])).toEqual(['h-firmado', 'h-sin-auco', 'h-vivo']);
    expect(mockCancelarSolicitudes.mock.calls).toEqual([['h-vivo']]);
    const cancelados = de('contratos', 'update').map((o) => ops[ops.indexOf(o) + 1].args);
    expect(cancelados).toEqual([['id', 'h-vivo']]);
    expect(de('contrato_historial_estados', 'insert').map((o) => (o.args[0] as { contrato_id: string }).contrato_id)).toEqual(['h-vivo']);
  });
});

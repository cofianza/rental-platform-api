import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

// ============================================================
// Migración — firma del Acta por Auco: webhook ajeno → next(), CAS e
// idempotencia de la reconciliación, activación con la última firma.
// Mock de Supabase con colas POR TABLA (patrón de v3/firma/__tests__/reconciliar).
// ============================================================

const { ops, queues, enqueue, mockRpc, chainFor, auco, efectos } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'is', 'not', 'in', 'or', 'order', 'limit', 'lt'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH)
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  const mockRpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    ops.push({ table: `rpc:${fn}`, method: 'rpc', args: [args] });
    return next(`rpc:${fn}`);
  });
  return {
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockRpc,
    chainFor,
    auco: {
      getDocumentStatus: vi.fn(),
      getDocumentRoadmap: vi.fn(),
      cancelDocument: vi.fn(),
      uploadDocumentForSignature: vi.fn(),
    },
    efectos: {
      bloquearInmuebleOcupado: vi.fn(async () => undefined),
      notificarUsuario: vi.fn(async () => undefined),
      enviarCorreoNotificacion: vi.fn(async () => undefined),
      listOperators: vi.fn(async () => [{ id: 'op1', rol: 'operador_analista' }]),
      logAudit: vi.fn(),
    },
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: string) => chainFor(t),
    rpc: (fn: string, args: Record<string, unknown>) => mockRpc(fn, args),
    storage: { from: () => ({ upload: async () => ({ error: null }), download: async () => ({ data: null, error: null }) }) },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: { AUCO_SENDER_EMAIL: 'firma@cofianza.co', AUCO_WEBHOOK_SECRET: undefined } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: efectos.logAudit,
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/auco', () => ({ ...auco, normalizePhoneToInternational: (t: string | null) => (t ? `+57${t.replace(/\D/g, '').slice(-10)}` : null) }));
vi.mock('@/lib/companyConfig', () => ({
  getCompany: async () => ({ name: 'Cofianza S.A.S.', email: 'hola@cofianza.co', phone: '3169724813', nit: '902' }),
}));
vi.mock('@/modules/contratos/v3/firma/reconciliar', () => ({ secretoValido: () => true }));
vi.mock('@/modules/inmuebles/inmuebles.service', () => ({ bloquearInmuebleOcupado: efectos.bloquearInmuebleOcupado }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: efectos.notificarUsuario,
  enviarCorreoNotificacion: efectos.enviarCorreoNotificacion,
}));
vi.mock('@/modules/users/users.service', () => ({ listOperators: efectos.listOperators }));
vi.mock('../habilitacion.service', () => ({ BUCKET: 'documentos-expedientes' }));

import { cancelarLote, reconciliarActa, vencerLote, webhookAucoMigracion, actaIdDeCustom } from '../acta-firma';

const ACTA_ID = '11111111-1111-4111-8111-111111111111';
const LOTE_ID = '22222222-2222-4222-8222-222222222222';

const acta = (over: Record<string, unknown> = {}) => ({
  id: ACTA_ID,
  lote_id: LOTE_ID,
  intento: 1,
  estado: 'en_firma',
  auco_code: 'ABC123',
  expira_en: new Date(Date.now() + 86_400_000).toISOString(),
  firmantes: [
    { parteId: 'representante_legal', estado: 'pendiente' },
    { parteId: 'cofianza', estado: 'pendiente' },
  ],
  storage_key: 'migracion/org/lotes/l/acta.pdf',
  storage_key_firmado: 'migracion/org/lotes/l/acta-firmada.pdf',
  motivo: null,
  motivo_detalle: null,
  cerrado_en: null,
  auco_cancelado_en: null,
  enviado_por: 'u1',
  created_at: new Date().toISOString(),
  updated_at: '2026-10-07T10:00:00.000Z',
  ...over,
});

const lote = (over: Record<string, unknown> = {}) => ({
  id: LOTE_ID,
  numero: 'MIG-2026-001',
  estado: 'en_firma',
  inmobiliaria_id: 'org1',
  vence_en: new Date(Date.now() + 86_400_000).toISOString(),
  acta_storage_key: 'migracion/org/lotes/l/acta.pdf',
  rep_legal_nombre: 'Ana Pérez',
  rep_legal_documento: '1020',
  rep_legal_email: 'ana@inmo.co',
  rep_legal_celular: '3001234567',
  ...over,
});

const finish = {
  status: 'FINISH',
  url: 'https://auco/firmado.pdf',
  signProfile: [
    { id: 's1', email: 'ana@inmo.co', status: 'FINISH' },
    { id: 's2', email: 'hola@cofianza.co', status: 'FINISH' },
  ],
};
const roadmap = {
  activityLog: [
    { action: 'PARTICIPANT_SIGN', participant: 'p1', timestamp: '2026-10-07T14:00:00.000Z' },
    { action: 'PARTICIPANT_SIGN', participant: 'p2', timestamp: '2026-10-07T15:30:00.000Z' },
  ],
};

beforeEach(() => {
  ops.length = 0;
  queues.clear();
  vi.clearAllMocks();
});

describe('actaIdDeCustom', () => {
  it('lee el id en objeto o arreglo, e ignora el custom de un sobre V3', () => {
    expect(actaIdDeCustom({ cofianza_acta: ACTA_ID })).toBe(ACTA_ID);
    expect(actaIdDeCustom([`cofianza_acta:${ACTA_ID}`])).toBe(ACTA_ID);
    expect(actaIdDeCustom({ cofianza_sobre: ACTA_ID })).toBeNull();
  });
});

describe('webhookAucoMigracion', () => {
  it('un evento que no es de un acta pasa al siguiente (next) sin responder', async () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    await webhookAucoMigracion({ method: 'POST', body: { code: 'OTRO', custom: { cofianza_sobre: ACTA_ID } } } as Request, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('un evento de un acta responde 200 y no llama next', async () => {
    enqueue('migracion_actas', { data: { id: ACTA_ID }, error: null });
    const next = vi.fn() as unknown as NextFunction;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    await webhookAucoMigracion({ method: 'POST', body: { code: 'ABC123' } } as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('reconciliarActa', () => {
  it('FINISH: CAS a completo con la última firma y activa el lote con esa fecha', async () => {
    enqueue('migracion_actas', { data: acta(), error: null }, { data: [{ id: ACTA_ID }], error: null });
    enqueue('migracion_lotes', { data: lote(), error: null }, { data: lote(), error: null });
    enqueue('rpc:fn_activar_lote_migracion', {
      data: { ya_activo: false, activados: 1, en_revision: 0, contratos: [{ fila_id: 'f1', contrato_id: 'c1', inmueble_id: 'i1', en_revision: false }] },
      error: null,
    });
    auco.getDocumentStatus.mockResolvedValue(finish);
    auco.getDocumentRoadmap.mockResolvedValue(roadmap);

    await reconciliarActa(ACTA_ID);

    const cas = ops.find((o) => o.table === 'migracion_actas' && o.method === 'update');
    expect(cas?.args[0]).toMatchObject({ estado: 'completo', cerrado_en: '2026-10-07T15:30:00.000Z' });
    expect(mockRpc).toHaveBeenCalledWith('fn_activar_lote_migracion', { p_lote: LOTE_ID, p_activado_en: '2026-10-07T15:30:00.000Z' });
    expect(efectos.bloquearInmuebleOcupado).toHaveBeenCalledWith('i1');
    expect(efectos.logAudit).toHaveBeenCalledOnce();
  });

  it('si otro proceso ganó el CAS, no activa nada', async () => {
    enqueue('migracion_actas', { data: acta(), error: null }, { data: [], error: null });
    enqueue('migracion_lotes', { data: lote(), error: null });
    auco.getDocumentStatus.mockResolvedValue(finish);
    auco.getDocumentRoadmap.mockResolvedValue(roadmap);

    await reconciliarActa(ACTA_ID);

    expect(mockRpc).not.toHaveBeenCalled();
    expect(efectos.notificarUsuario).not.toHaveBeenCalled();
  });

  it('FINISH sin todas las firmas en el roadmap: no inventa la fecha ni activa', async () => {
    enqueue('migracion_actas', { data: acta(), error: null }, { data: [{ id: ACTA_ID }], error: null });
    enqueue('migracion_lotes', { data: lote(), error: null });
    auco.getDocumentStatus.mockResolvedValue(finish);
    auco.getDocumentRoadmap.mockResolvedValue({ activityLog: [roadmap.activityLog[0]] });

    await reconciliarActa(ACTA_ID);

    const cas = ops.find((o) => o.table === 'migracion_actas' && o.method === 'update');
    expect(cas?.args[0]).not.toHaveProperty('estado');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('acta completa con el lote ya activo (curación repetida): no llama la RPC', async () => {
    enqueue('migracion_actas', { data: acta({ estado: 'completo', cerrado_en: '2026-10-07T15:30:00.000Z' }), error: null });
    enqueue('migracion_lotes', { data: lote({ estado: 'activo' }), error: null });

    await reconciliarActa(ACTA_ID);

    expect(mockRpc).not.toHaveBeenCalled();
    expect(auco.getDocumentStatus).not.toHaveBeenCalled();
  });

  it('RPC idempotente (ya_activo): no repite avisos', async () => {
    enqueue('migracion_actas', { data: acta({ estado: 'completo', cerrado_en: '2026-10-07T15:30:00.000Z' }), error: null });
    enqueue('migracion_lotes', { data: lote(), error: null });
    enqueue('rpc:fn_activar_lote_migracion', { data: { ya_activo: true, contratos: [] }, error: null });

    await reconciliarActa(ACTA_ID);

    expect(mockRpc).toHaveBeenCalledOnce();
    expect(efectos.notificarUsuario).not.toHaveBeenCalled();
    expect(efectos.logAudit).not.toHaveBeenCalled();
  });
});

describe('vencerLote / cancelarLote', () => {
  const updatesLote = () => ops.filter((o) => o.table === 'migracion_lotes' && o.method === 'update').map((o) => o.args[0]);

  it('con el acta ya firmada (completo) el lote no vence: el barrido reintenta la activación', async () => {
    enqueue('migracion_actas', { data: acta({ estado: 'completo', cerrado_en: '2026-10-07T15:30:00.000Z' }), error: null });
    await vencerLote(LOTE_ID);
    expect(updatesLote()).toEqual([]);
    expect(ops.some((o) => o.table === 'migracion_filas')).toBe(false);
  });

  it('cancelar antes de la firma: anula en Auco, cancela el acta y el lote, y libera las filas', async () => {
    auco.cancelDocument.mockResolvedValue({ success: true });
    enqueue('migracion_lotes', { data: lote(), error: null }, { data: [{ id: LOTE_ID, numero: 'MIG-2026-001' }], error: null }, { data: lote({ estado: 'cancelado' }), error: null });
    enqueue('migracion_actas', { data: acta(), error: null }, { data: null, error: null }, { data: acta(), error: null }, { data: [{ id: ACTA_ID }], error: null });
    await cancelarLote(LOTE_ID, 'u1');
    expect(auco.cancelDocument).toHaveBeenCalledWith('ABC123', expect.anything());
    const casActa = ops.filter((o) => o.table === 'migracion_actas' && o.method === 'update').map((o) => o.args[0]);
    expect(casActa).toContainEqual(expect.objectContaining({ estado: 'cancelado', motivo: 'CANCELADO' }));
    expect(updatesLote()).toEqual([{ estado: 'cancelado' }]);
    expect(ops.some((o) => o.table === 'migracion_filas' && o.method === 'update')).toBe(true);
    expect(efectos.logAudit).toHaveBeenCalledWith(expect.objectContaining({ accion: 'MIGRACION_LOTE_CANCELADO', usuarioId: 'u1' }));
  });

  it('no se cancela un lote ya activo', async () => {
    enqueue('migracion_lotes', { data: lote({ estado: 'activo' }), error: null });
    await expect(cancelarLote(LOTE_ID, 'u1')).rejects.toMatchObject({ statusCode: 409, errorCode: 'MIGRACION_LOTE_ESTADO' });
  });

  it('si el acta ya está firmada, cancelar responde 409 sin tocar el lote', async () => {
    enqueue('migracion_lotes', { data: lote(), error: null });
    enqueue('migracion_actas', { data: acta({ estado: 'completo', cerrado_en: '2026-10-07T15:30:00.000Z' }), error: null });
    await expect(cancelarLote(LOTE_ID, 'u1')).rejects.toMatchObject({ statusCode: 409 });
    expect(updatesLote()).toEqual([]);
  });
});

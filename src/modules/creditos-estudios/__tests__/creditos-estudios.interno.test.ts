/**
 * H99: el modal interno «Nueva evaluación» ofrece pagar con un crédito de la
 * inmobiliaria dueña del estudio. El saldo es el del titular de la org (no el
 * del operador), no se ofrece sin inmobiliaria ni con un cobro vivo, y la
 * liberación consume del titular dejando al operador como autor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockRpc, ops, queues, enqueue, mockCanon } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'gt', 'or', 'order', 'limit', 'not'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    mockRpc: vi.fn(),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockCanon: vi.fn(async (inm: { propietario_id: string; inmobiliaria_id: string | null }) =>
      inm.inmobiliaria_id ? 'titular-org' : inm.propietario_id,
    ),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: mockRpc } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/modules/pagos/gateway', () => ({ getPaymentGateway: vi.fn() }));
vi.mock('@/modules/pago-estudio/pago-estudio.service', () => ({ cerrarCobroEstudioFallido: vi.fn() }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn(async () => undefined) }));
const { mockNotificar } = vi.hoisted(() => ({ mockNotificar: vi.fn(async () => undefined) }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: mockNotificar }));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onEstudioPagado: vi.fn(async () => undefined) }));
// perfilEsDuenoDeInmueble real en su regla: el titular es miembro de la org del inmueble.
vi.mock('@/lib/tenantScope', () => ({
  perfilEsDuenoDeInmueble: vi.fn(async (p: { userId: string }) => p.userId === 'titular-org'),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
  resolvePerfilCanonicoDeInmueble: mockCanon,
}));

import {
  duenoCreditosDeExpediente,
  saldoCreditosDeExpediente,
  liberarEstudioConCredito,
  avisarCreditoUsadoPorCofianza,
} from '../creditos-estudios.service';

const expDeOrg = { data: { id: 'exp-1', inmueble: { propietario_id: 'asesor', inmobiliaria_id: 'org-1' } }, error: null };
const expSinOrg = { data: { id: 'exp-1', inmueble: { propietario_id: 'prop-1', inmobiliaria_id: null } }, error: null };

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('dueño de los créditos del estudio', () => {
  it('inmueble de una inmobiliaria: el titular de la org', async () => {
    enqueue('expedientes', expDeOrg);
    await expect(duenoCreditosDeExpediente('exp-1')).resolves.toBe('titular-org');
  });

  it('propietario individual: null (H2, los créditos son de inmobiliarias)', async () => {
    enqueue('expedientes', expSinOrg);
    await expect(duenoCreditosDeExpediente('exp-1')).resolves.toBeNull();
    expect(mockCanon).not.toHaveBeenCalled();
  });

  it('estudio inexistente: 404', async () => {
    await expect(duenoCreditosDeExpediente('exp-x')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('saldo usable para el modal interno', () => {
  it('sin inmobiliaria: saldo 0 (no se ofrece)', async () => {
    enqueue('expedientes', expSinOrg);
    enqueue('pagos', { data: [], error: null });
    await expect(saldoCreditosDeExpediente('exp-1')).resolves.toMatchObject({
      con_inmobiliaria: false,
      saldo_efectivo: 0,
    });
  });

  it('saldo en contra (contracargo) se resta: 2 disponibles - 2 en contra = 0', async () => {
    enqueue('expedientes', expDeOrg);
    enqueue('pagos', { data: [], error: null });
    enqueue('lotes_creditos_estudios', {
      data: [{ id: 'l-1', cantidad_disponible: 2, cantidad_inicial: 5, vence_en: null, origen: 'compra', created_at: 'x' }],
      error: null,
    });
    enqueue('compras_creditos_estudios', { data: [{ creditos_en_contra: 2 }], error: null });
    await expect(saldoCreditosDeExpediente('exp-1')).resolves.toEqual({
      con_inmobiliaria: true,
      saldo_efectivo: 0,
      creditos_en_contra: 2,
      pago_estudio_existente: false,
    });
    // El saldo leído es el del titular, no el del operador.
    const lotes = ops.find((o) => o.table === 'lotes_creditos_estudios' && o.method === 'eq');
    expect(lotes?.args).toEqual(['perfil_id', 'titular-org']);
  });

  it('con un cobro de la evaluación vivo lo avisa (liberar daría 409)', async () => {
    enqueue('expedientes', expDeOrg);
    enqueue('pagos', { data: [{ id: 'p-viejo' }], error: null });
    enqueue('lotes_creditos_estudios', { data: [], error: null });
    enqueue('compras_creditos_estudios', { data: [], error: null });
    await expect(saldoCreditosDeExpediente('exp-1')).resolves.toMatchObject({ pago_estudio_existente: true });
  });
});

describe('liberar con el crédito del titular', () => {
  const expLiberar = { data: { id: 'exp-1', numero: 'E-1', estado: 'en_estudio', inmueble_id: 'inm-1', solicitante_id: 'sol-1' }, error: null };
  const inmueble = { data: { propietario_id: 'asesor', inmobiliaria_id: 'org-1', direccion: 'Cra 1', ciudad: 'Bogotá' }, error: null };

  it('consume del titular y deja al operador como autor del pago y del consumo', async () => {
    enqueue('expedientes', expLiberar);
    enqueue('inmuebles', inmueble);
    enqueue('compras_creditos_estudios', { data: [], error: null }); // sin saldo en contra
    enqueue('pagos', { data: [], error: null }, { data: { id: 'pago-1' }, error: null });
    enqueue('configuracion_sistema', { data: { valor: '80000' }, error: null });
    mockRpc.mockResolvedValueOnce({ data: [{ lote_id: 'l-1', saldo_restante: 4 }], error: null });

    await expect(liberarEstudioConCredito('exp-1', 'titular-org', 'operador-1')).resolves.toEqual({
      pago_id: 'pago-1',
      saldo_restante: 4,
      lote_id: 'l-1',
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'consume_credito_estudio',
      expect.objectContaining({ p_perfil_id: 'titular-org', p_usuario_id: 'operador-1', p_pago_id: 'pago-1' }),
    );
    const pago = ops.find((o) => o.table === 'pagos' && o.method === 'insert')?.args[0] as { creado_por: string };
    expect(pago.creado_por).toBe('operador-1');
  });

  it('idempotente: con el pago ya completado no se consume otro crédito', async () => {
    enqueue('expedientes', expLiberar);
    enqueue('inmuebles', inmueble);
    enqueue('compras_creditos_estudios', { data: [], error: null });
    enqueue('pagos', { data: [{ id: 'p-1', estado: 'completado' }], error: null });
    await expect(liberarEstudioConCredito('exp-1', 'titular-org', 'operador-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'PAGO_ESTUDIO_YA_COMPLETADO',
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('sin saldo: el RPC lo rechaza y se revierte el pago', async () => {
    enqueue('expedientes', expLiberar);
    enqueue('inmuebles', inmueble);
    enqueue('compras_creditos_estudios', { data: [], error: null });
    enqueue('pagos', { data: [], error: null }, { data: { id: 'pago-1' }, error: null });
    enqueue('configuracion_sistema', { data: { valor: '80000' }, error: null });
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'SIN_SALDO_CREDITOS' } });
    await expect(liberarEstudioConCredito('exp-1', 'titular-org', 'operador-1')).rejects.toMatchObject({
      errorCode: 'SIN_SALDO_CREDITOS',
    });
    expect(ops.some((o) => o.table === 'pagos' && o.method === 'delete')).toBe(true);
  });
});

describe('aviso a la inmobiliaria cuando Cofianza gasta su crédito', () => {
  const expAviso = {
    data: { numero: 'EXP-2026-0005', inmueble: { direccion: 'Cra 1', ciudad: 'Bogotá', inmobiliaria_id: 'org-1' } },
    error: null,
  };

  it('avisa a cada titular activo con el estudio y el saldo que queda', async () => {
    enqueue('expedientes', expAviso);
    enqueue('inmobiliaria_miembros', { data: [{ perfil_id: 'titular-org' }, { perfil_id: 'cotitular' }], error: null });
    await avisarCreditoUsadoPorCofianza('exp-1', 3);
    expect(mockNotificar).toHaveBeenCalledTimes(2);
    expect(mockNotificar).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'cotitular',
        link: '/expedientes/exp-1',
        mensaje: expect.stringMatching(/N\.° 2026-0005 \(Cra 1, Bogotá\).*1 crédito.*Te quedan 3 créditos/),
      }),
    );
    expect(ops).toContainEqual({ table: 'inmobiliaria_miembros', method: 'eq', args: ['rol_miembro', 'owner'] });
  });

  it('sin inmobiliaria no avisa a nadie', async () => {
    enqueue('expedientes', { data: { numero: 'EXP-1', inmueble: { direccion: null, ciudad: null, inmobiliaria_id: null } }, error: null });
    await avisarCreditoUsadoPorCofianza('exp-1', 3);
    expect(mockNotificar).not.toHaveBeenCalled();
  });

  it('si el aviso falla no lanza (el consumo no se revierte)', async () => {
    enqueue('expedientes', expAviso);
    enqueue('inmobiliaria_miembros', { data: [{ perfil_id: 'titular-org' }], error: null });
    mockNotificar.mockRejectedValueOnce(new Error('Resend caído'));
    await expect(avisarCreditoUsadoPorCofianza('exp-1', 0)).resolves.toBeUndefined();
  });
});

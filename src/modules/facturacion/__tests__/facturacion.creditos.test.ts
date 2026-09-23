import { describe, it, expect, vi, beforeEach } from 'vitest';

// Facturación y créditos de estudios: el consumo de un crédito no se factura
// (ya se facturó la compra del paquete) y la compra sí aparece en Pendientes.
// Mock de Supabase con colas por tabla, como pago-estudio.service.test.ts.

const { mockFrom, ops, queues, enqueue, mockCanonical, mockCreateBill } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'order', 'limit'];
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
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockCanonical: vi.fn(async (id: string) => id),
    mockCreateBill: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: string) => mockFrom(t),
    auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: { email: 'titular@inmo.co' } } })) } },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/companyConfig', () => ({ getCompany: vi.fn() }));
vi.mock('@/lib/factus', () => ({ createBill: mockCreateBill, discoverNumberingRangeId: vi.fn(async () => null) }));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: vi.fn(async () => null),
  assertExpedienteAccess: vi.fn(async () => undefined),
  resolveVisibilityScope: vi.fn(),
  resolveMembershipInmobiliariaIds: vi.fn(async () => []),
  resolveOrgMemberPerfilIds: vi.fn(async () => []),
  resolveOrgCanonicalPerfilId: (id: string) => mockCanonical(id),
}));

import {
  crearFacturaDesdePago,
  previewFacturaPago,
  listPendientesFacturar,
  crearFacturaDesdeCompraCreditos,
} from '../facturacion.service';

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  mockCanonical.mockImplementation(async (id: string) => id);
});

describe('pago de una evaluación liberada con crédito', () => {
  it('no se factura: 409 PAGO_CON_CREDITO antes de tocar Factus (emitir y previsualizar)', async () => {
    enqueue('movimientos_creditos_estudios', { data: [{ pago_id: 'pago-credito' }], error: null });
    await expect(crearFacturaDesdePago('pago-credito', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'PAGO_CON_CREDITO',
    });

    enqueue('movimientos_creditos_estudios', { data: [{ pago_id: 'pago-credito' }], error: null });
    await expect(previewFacturaPago('pago-credito')).rejects.toMatchObject({ errorCode: 'PAGO_CON_CREDITO' });

    expect(mockCreateBill).not.toHaveBeenCalled();
  });
});

describe('listPendientesFacturar', () => {
  it('admin: excluye el consumo de crédito e incluye la compra del paquete sin factura', async () => {
    enqueue('pagos', {
      data: [
        { id: 'pago-mp', expediente_id: 'e1', concepto: 'estudio', monto: 80000, fecha_pago: '2026-09-01', expediente: { numero: 'EXP-1' } },
        { id: 'pago-credito', expediente_id: 'e2', concepto: 'estudio', monto: 80000, fecha_pago: '2026-09-03', expediente: { numero: 'EXP-2' } },
      ],
      error: null,
    });
    enqueue('facturas', { data: [], error: null }); // facturas de los pagos
    enqueue('movimientos_creditos_estudios', { data: [{ pago_id: 'pago-credito' }], error: null });
    enqueue('compras_creditos_estudios', {
      data: [
        { id: 'compra-1', perfil_id: 'owner-1', precio_cop: 1400000, completed_at: '2026-09-02' },
        { id: 'compra-facturada', perfil_id: 'owner-1', precio_cop: 350000, completed_at: '2026-08-01' },
      ],
      error: null,
    });
    enqueue('facturas', { data: [{ compra_creditos_id: 'compra-facturada', estado: 'emitida', error_mensaje: null }], error: null });
    enqueue('perfiles', { data: [{ id: 'owner-1', nombre: 'Ana', apellido: 'Titular', razon_social: 'Inmo SAS' }], error: null });

    const r = await listPendientesFacturar('admin-1', 'administrador');

    expect(r.map((p) => p.pago_id ?? p.compra_id)).toEqual(['compra-1', 'pago-mp']);
    expect(r[0]).toMatchObject({ pago_id: null, compra_id: 'compra-1', cliente_nombre: 'Inmo SAS', monto: 1400000 });
  });

  it('inmobiliaria: no ve compras (las factura desde Configuración › Créditos)', async () => {
    const { resolveAllowedExpedienteIds } = await import('@/lib/tenantScope');
    vi.mocked(resolveAllowedExpedienteIds).mockResolvedValueOnce(['e1']);
    enqueue('pagos', { data: [], error: null });

    expect(await listPendientesFacturar('inmo-1', 'inmobiliaria')).toEqual([]);
    expect(ops.some((o) => o.table === 'compras_creditos_estudios')).toBe(false);
  });
});

describe('crearFacturaDesdeCompraCreditos: la compra es de la organización', () => {
  const compra = {
    id: 'compra-1',
    perfil_id: 'owner-1',
    cantidad_estudios: 25,
    precio_cop: 1400000,
    estado: 'completado',
    stripe_session_id: 'pref-1',
    stripe_payment_intent_id: null,
    completed_at: '2026-09-02',
    paquete_id: 'paq-25',
  };
  // Perfil sin municipio: la emisión se detiene en la validación, después de
  // pasar el chequeo de pertenencia (no hace falta simular a Factus).
  const perfilIncompleto = {
    id: 'owner-1', nombre: 'Ana', apellido: 'Titular', rol: 'inmobiliaria', tipo_documento: 'NIT',
    numero_documento: null, razon_social: 'Inmo SAS', nit: '900123456', direccion: 'Calle 1', direccion_comercial: null,
    ciudad: 'Bogotá', nombre_representante: null, telefono: '3000000000', email_recaudo: null,
    municipio_codigo: null, municipio_nombre: null,
  };

  it('un miembro factura la compra del titular, con los datos fiscales de la organización', async () => {
    mockCanonical.mockResolvedValueOnce('owner-1');
    enqueue('compras_creditos_estudios', { data: compra, error: null });
    enqueue('perfiles', { data: perfilIncompleto, error: null });

    await expect(crearFacturaDesdeCompraCreditos('compra-1', 'miembro-1', undefined, 'miembro-1')).rejects.toMatchObject({
      errorCode: 'CLIENTE_DATOS_INCOMPLETOS',
    });
    expect(ops.find((o) => o.table === 'perfiles' && o.method === 'eq')?.args).toEqual(['id', 'owner-1']);
  });

  it('alguien de otra organización: 403 NOT_OWNER', async () => {
    mockCanonical.mockResolvedValueOnce('otro-owner');
    enqueue('compras_creditos_estudios', { data: compra, error: null });

    await expect(crearFacturaDesdeCompraCreditos('compra-1', 'intruso', undefined, 'intruso')).rejects.toMatchObject({
      errorCode: 'NOT_OWNER',
    });
  });

  it('el webhook (null) no pasa por el chequeo de pertenencia', async () => {
    enqueue('compras_creditos_estudios', { data: compra, error: null });
    enqueue('perfiles', { data: perfilIncompleto, error: null });

    await expect(crearFacturaDesdeCompraCreditos('compra-1', null, undefined, null)).rejects.toMatchObject({
      errorCode: 'CLIENTE_DATOS_INCOMPLETOS',
    });
    expect(mockCanonical).not.toHaveBeenCalled();
  });
});

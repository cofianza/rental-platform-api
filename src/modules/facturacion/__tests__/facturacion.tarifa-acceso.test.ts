import { describe, it, expect, vi, beforeEach } from 'vitest';

// Plan cobro-tarifa-mensual B4: los titulares ven y descargan la factura de la
// cuenta de cobro de su organización; un miembro o el titular de otra, 404.
// Mock de Supabase con colas por tabla, como facturacion.creditos.test.ts.

const { ops, queues, enqueue, efectos } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  return {
    ops,
    queues,
    enqueue: (t: string, ...items: Res[]) => queues.set(t, [...(queues.get(t) ?? []), ...items]),
    efectos: {
      membresia: vi.fn(async () => null as { orgId: string; rolMiembro: string } | null),
      expedientes: vi.fn(async () => [] as string[] | null),
    },
  };
});

vi.mock('@/lib/supabase', () => {
  const next = (t: string) => queues.get(t)?.shift() ?? { data: null, error: null };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'or', 'order', 'range'])
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return { supabase: { from: (t: string) => chainFor(t) } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/companyConfig', () => ({ getCompany: async () => ({ name: 'Cofianza', nit: '1', address: 'x' }) }));
vi.mock('@/lib/factus', () => ({}));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: efectos.expedientes,
  assertExpedienteAccess: vi.fn(),
  resolveVisibilityScope: async () => ({ kind: 'org' }),
  resolveMembershipInmobiliariaIds: async () => [],
  resolveOrgMemberPerfilIds: async () => [],
  resolveOrgCanonicalPerfilId: async (id: string) => id,
  getActiveMembership: efectos.membresia,
}));

import { getFacturaById, listFacturas } from '../facturacion.service';

const ok = (data: unknown) => ({ data, error: null });
const FACTURA = { id: 'f1', expediente_id: null, pago_id: null, compra_creditos_id: null, cuenta_cobro_id: 'k1', total: 100, tax_amount: 16 };

beforeEach(() => {
  ops.length = 0;
  queues.clear();
  vi.clearAllMocks();
});

describe('factura de la cuenta de cobro de la tarifa', () => {
  it('el titular de la organización la abre', async () => {
    efectos.membresia.mockResolvedValueOnce({ orgId: 'orgA', rolMiembro: 'owner' });
    enqueue('facturas', ok(FACTURA));
    enqueue('cuentas_cobro_tarifa', ok([{ id: 'k1' }]));
    await expect(getFacturaById('f1', 't1', 'inmobiliaria')).resolves.toMatchObject({ id: 'f1' });
    expect(ops).toContainEqual({ table: 'cuentas_cobro_tarifa', method: 'eq', args: ['inmobiliaria_id', 'orgA'] });
  });

  it('un miembro que no es titular, o el titular de otra organización: 404', async () => {
    efectos.membresia.mockResolvedValueOnce({ orgId: 'orgA', rolMiembro: 'miembro' });
    enqueue('facturas', ok(FACTURA));
    await expect(getFacturaById('f1', 'm1', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });

    efectos.membresia.mockResolvedValueOnce({ orgId: 'orgB', rolMiembro: 'owner' });
    enqueue('facturas', ok(FACTURA));
    enqueue('cuentas_cobro_tarifa', ok([{ id: 'k9' }]));
    await expect(getFacturaById('f1', 't2', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('el listado del titular suma las facturas de las cuentas de su organización', async () => {
    efectos.membresia.mockResolvedValueOnce({ orgId: 'orgA', rolMiembro: 'owner' });
    efectos.expedientes.mockResolvedValueOnce(['e1']);
    enqueue('cuentas_cobro_tarifa', ok([{ id: 'k1' }, { id: 'k2' }]));
    enqueue('facturas', { data: [], error: null, count: 0 });
    await listFacturas({ page: 1, limit: 10 } as never, 't1', 'inmobiliaria');
    expect(ops).toContainEqual({ table: 'facturas', method: 'or', args: ['expediente_id.in.(e1),cuenta_cobro_id.in.(k1,k2)'] });
  });

  it('sin estudios ni cuentas, el listado sale vacío sin consultar facturas', async () => {
    efectos.membresia.mockResolvedValueOnce({ orgId: 'orgA', rolMiembro: 'miembro' });
    efectos.expedientes.mockResolvedValueOnce([]);
    await expect(listFacturas({ page: 1, limit: 10 } as never, 'm1', 'inmobiliaria')).resolves.toMatchObject({ facturas: [] });
    expect(ops.filter((o) => o.table === 'facturas' && o.method === 'or')).toHaveLength(0);
  });

  it('la bandeja de notas crédito pendientes incluye las facturas de cuentas con líneas marcadas', async () => {
    enqueue('pagos', ok([]));
    enqueue('compras_creditos_estudios', ok([]));
    enqueue('cuentas_cobro_tarifa_lineas', ok([{ id: 'k1' }, { id: 'k1' }]));
    enqueue('facturas', { data: [], error: null, count: 0 });
    await listFacturas({ page: 1, limit: 10, nota_credito_pendiente: true } as never, 'a1', 'administrador');
    expect(ops).toContainEqual({ table: 'cuentas_cobro_tarifa_lineas', method: 'eq', args: ['requiere_nota_credito', true] });
    expect(ops).toContainEqual({ table: 'facturas', method: 'or', args: ['cuenta_cobro_id.in.(k1)'] });
  });
});

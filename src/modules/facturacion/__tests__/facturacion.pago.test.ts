import { describe, it, expect, vi, beforeEach } from 'vitest';

// Facturar un pago: solo si está completado, y un intento fallido (la carrera
// entre el disparo automático y el clic manual) no pisa la factura emitida.
// Mock de Supabase con colas por tabla, como facturacion.creditos.test.ts.

const { mockFrom, ops, queues, enqueue, mockCreateBill } = vi.hoisted(() => {
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
    mockCreateBill: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: string) => mockFrom(t),
    auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: null } })) } },
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
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
}));

import { crearFacturaDesdePago, previewFacturaPago } from '../facturacion.service';

const solicitante = {
  id: 'sol-1', tipo_persona: 'natural', nombre: 'Juan', apellido: 'Pérez', razon_social: null,
  email: 'juan@correo.co', telefono: '3001234567', tipo_documento: 'CC', numero_documento: '1020304050',
  digito_verificacion: null, direccion: 'Calle 1 # 2-3', municipio_id: '11001', municipio_nombre: 'Bogotá', tribute_code: null,
};
const pago = (estado: string) => ({
  data: {
    id: 'pago-1', expediente_id: 'exp-1', concepto: 'estudio', monto: 80000, estado,
    email_pagador: 'juan@correo.co', nombre_pagador: 'Juan Pérez', creado_por: 'gestor-1',
    expediente: { numero: 'EXP-1', solicitante },
  },
  error: null,
});

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('facturar un pago que no está completado', () => {
  it.each(['pendiente', 'cancelado', 'fallido'])('%s: 409 PAGO_NO_COMPLETADO sin tocar Factus', async (estado) => {
    enqueue('pagos', pago(estado));
    await expect(crearFacturaDesdePago('pago-1', 'sol-user')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'PAGO_NO_COMPLETADO',
    });

    enqueue('pagos', pago(estado));
    await expect(previewFacturaPago('pago-1')).rejects.toMatchObject({ errorCode: 'PAGO_NO_COMPLETADO' });

    expect(mockCreateBill).not.toHaveBeenCalled();
  });
});

describe('carrera entre el disparo automático y el clic manual', () => {
  it('Factus rechaza el duplicado pero la otra llamada ya emitió: devuelve esa factura sin degradarla', async () => {
    enqueue(
      'facturas',
      { data: null, error: null }, // idempotencia inicial: todavía no hay factura
      { data: { id: 'fac-1', estado: 'emitida', factus_number: 'SETP990001', cufe: 'cufe-1' }, error: null },
    );
    enqueue('pagos', pago('completado'));
    mockCreateBill.mockRejectedValueOnce(new Error('reference_code duplicado'));

    const r = await crearFacturaDesdePago('pago-1', 'sol-user');

    expect(r).toEqual({ id: 'fac-1', factus_number: 'SETP990001', cufe: 'cufe-1', estado: 'emitida' });
    expect(ops.some((o) => o.table === 'facturas' && (o.method === 'update' || o.method === 'insert'))).toBe(false);
  });

  it('un intento fallido que actualiza la fila previa nunca la pasa de emitida a solicitada', async () => {
    const previa = { data: { id: 'fac-1', estado: 'solicitada', factus_number: null, cufe: null, factus_reference_code: 'COFIANZA-PAGO-X' }, error: null };
    enqueue('facturas', previa, previa, previa);
    enqueue('pagos', pago('completado'));
    mockCreateBill.mockRejectedValueOnce(new Error('Factus caído'));

    await expect(crearFacturaDesdePago('pago-1', 'sol-user')).rejects.toThrow('Factus caído');

    expect(ops.some((o) => o.table === 'facturas' && o.method === 'update')).toBe(true);
    expect(ops.find((o) => o.table === 'facturas' && o.method === 'neq')?.args).toEqual(['estado', 'emitida']);
  });
});

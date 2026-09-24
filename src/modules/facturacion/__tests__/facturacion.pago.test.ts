import { describe, it, expect, vi, beforeEach } from 'vitest';

// Facturar un pago: solo si está completado, y un intento fallido (la carrera
// entre el disparo automático y el clic manual) no pisa la factura emitida.
// Mock de Supabase con colas por tabla, como facturacion.creditos.test.ts.

const { mockFrom, ops, queues, enqueue, mockCreateBill, calibracion } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'order', 'limit'];
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
    calibracion: { TARIFA_IVA: 19 },
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
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => calibracion) }));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: vi.fn(async () => null),
  assertExpedienteAccess: vi.fn(async () => undefined),
  resolveVisibilityScope: vi.fn(),
  resolveMembershipInmobiliariaIds: vi.fn(async () => []),
  resolveOrgMemberPerfilIds: vi.fn(async () => []),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
}));

import { crearFacturaDesdePago, previewFacturaPago, updateTarifasIva, listTarifasIva, medioPagoDian } from '../facturacion.service';

const solicitante = {
  id: 'sol-1', tipo_persona: 'natural', nombre: 'Juan', apellido: 'Pérez', razon_social: null,
  email: 'juan@correo.co', telefono: '3001234567', tipo_documento: 'CC', numero_documento: '1020304050',
  digito_verificacion: null, direccion: 'Calle 1 # 2-3', municipio_id: '11001', municipio_nombre: 'Bogotá', tribute_code: null,
};
const pago = (estado: string, concepto = 'estudio', monto = 80000) => ({
  data: {
    id: 'pago-1', expediente_id: 'exp-1', concepto, monto, estado,
    email_pagador: 'juan@correo.co', nombre_pagador: 'Juan Pérez', creado_por: 'gestor-1',
    expediente: { numero: 'EXP-1', solicitante },
  },
  error: null,
});

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  calibracion.TARIFA_IVA = 19;
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

// Adenda 1 del módulo de contratos §1.6: la prima (cobro 'garantia') se
// factura gravada con TARIFA_IVA, la misma tasa con la que se cobró (§1.1);
// el estudio no cambia.
describe('IVA por concepto', () => {
  const tasa = (valor: string) => enqueue('configuracion_sistema', { data: { valor }, error: null });
  const facturaEmitida = () => {
    enqueue('facturas', { data: null, error: null }, { data: null, error: null }, { data: { id: 'fac-1' }, error: null });
    mockCreateBill.mockResolvedValueOnce({ data: { bill: { id: 1, number: 'FE1', cufe: 'cufe-1', total: '357000.00', tax_amount: '57000.00' } } });
  };
  const payload = () => mockCreateBill.mock.calls[0][0];

  // Factus calcula el IVA sobre el price redondeado a 2 decimales; lo que no
  // cuadra con lo pagado va en cash_rounding_amount (pagado - total).
  it.each([
    [357_000, '300000.00', undefined], // 300.000 + 57.000: exacto
    [53_000, '44537.82', '-0.01'], // 44.537,82 + 8.462,19 = 53.000,01
    [71_414, '60011.76', '0.01'], // 60.011,76 + 11.402,23 = 71.413,99
  ])('prima de $%i: price %s (IVA 01 al 19) y cash_rounding_amount %s', async (monto, price, ajuste) => {
    facturaEmitida();
    enqueue('pagos', pago('completado', 'garantia', monto));

    await crearFacturaDesdePago('pago-1', null);

    expect(payload().items[0].price).toBe(price);
    expect(payload().items[0].taxes).toEqual([{ code: '01', rate: '19.00' }]);
    expect(payload().items[0].name).toBe('Prima de vinculación de la fianza - EXP-1');
    expect(payload().payment_details[0].amount).toBe(`${monto}.00`);
    expect(payload().cash_rounding_amount).toBe(ajuste);
  });

  it('la tasa de la prima es TARIFA_IVA, no la fila iva_concepto_garantia', async () => {
    facturaEmitida();
    enqueue('pagos', pago('completado', 'garantia', 357_000));
    tasa('0'); // una fila vieja en 0 ya no manda

    await crearFacturaDesdePago('pago-1', null);

    expect(payload().items[0].taxes).toEqual([{ code: '01', rate: '19.00' }]);
    expect(ops.some((o) => o.table === 'configuracion_sistema')).toBe(false);
  });

  it('con TARIFA_IVA en 0 no se emite como excluida, y el intento queda con el motivo', async () => {
    calibracion.TARIFA_IVA = 0;
    enqueue('pagos', pago('completado', 'garantia', 357_000));

    await expect(crearFacturaDesdePago('pago-1', null)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'IVA_CONCEPTO_GRAVADO_EN_CERO',
    });
    expect(mockCreateBill).not.toHaveBeenCalled();
    const intento = ops.find((o) => o.table === 'facturas' && o.method === 'insert')?.args[0] as Record<string, unknown>;
    expect(intento).toMatchObject({ pago_id: 'pago-1', estado: 'solicitada' });
    expect(intento.error_mensaje).toContain('TARIFA_IVA');
  });

  it('el estudio sigue excluido de IVA', async () => {
    facturaEmitida();
    enqueue('pagos', pago('completado'));
    tasa('0');

    await crearFacturaDesdePago('pago-1', null);

    expect(payload().items[0].price).toBe('80000.00');
    expect(payload().items[0].taxes).toEqual([{ is_excluded: true }]);
    expect(payload().cash_rounding_amount).toBeUndefined();
  });
});

describe('Tarifas de IVA', () => {
  it('la prima se muestra con TARIFA_IVA y marcada como derivada', async () => {
    enqueue('configuracion_sistema', { data: [{ clave: 'iva_concepto_garantia', valor: '0' }], error: null });

    expect((await listTarifasIva()).find((t) => t.concepto === 'garantia')).toEqual({ concepto: 'garantia', tasa: 19, derivada: true });
  });

  it.each([0, 16])('la prima no se puede poner en %s si TARIFA_IVA es 19', async (t) => {
    await expect(updateTarifasIva([{ concepto: 'garantia', tasa: t }], 'admin-1')).rejects.toMatchObject({
      errorCode: 'CONCEPTO_GRAVADO',
    });
    expect(ops.some((o) => o.method === 'upsert')).toBe(false);
  });

  it.each([0.001, 19.005])('la tasa %s se rechaza: Factus solo lee 2 decimales', async (t) => {
    await expect(updateTarifasIva([{ concepto: 'otro', tasa: t }], 'admin-1')).rejects.toMatchObject({
      errorCode: 'TASA_INVALIDA',
    });
  });

  it('guardar la prima con TARIFA_IVA no le pone «0 = exento» a su descripción', async () => {
    await updateTarifasIva([{ concepto: 'garantia', tasa: 19 }, { concepto: 'otro', tasa: 0 }], 'admin-1');

    const filas = ops.filter((o) => o.method === 'upsert').map((o) => o.args[0] as { clave: string; descripcion: string });
    expect(filas.find((f) => f.clave === 'iva_concepto_garantia')?.descripcion).not.toContain('exento');
    expect(filas.find((f) => f.clave === 'iva_concepto_otro')?.descripcion).toContain('0 = exento');
  });
});

// P39: el medio de pago de la factura es el de la plata que entró (tabla de
// medios de pago del anexo técnico DIAN), no 'efectivo' para todo.
describe('medio de pago DIAN', () => {
  it.each([
    ['pasarela', { payment_type_id: 'credit_card' }, '48'],
    ['pasarela', { payment_type_id: 'debit_card' }, '49'],
    ['pasarela', { payment_type_id: 'bank_transfer', payment_method_id: 'pse' }, '47'],
    ['pasarela', { payment_type_id: 'ticket', payment_method_id: 'efecty' }, '10'],
    ['transferencia', null, '47'],
    ['cheque', null, '20'],
    ['efectivo', null, '10'],
    ['pasarela', { payment_type_id: 'account_money' }, '1'],
    ['pasarela', null, '1'],
  ])('%s %j → %s', (metodo, gw, codigo) => {
    expect(medioPagoDian(metodo, gw)).toBe(codigo);
  });

  it('la factura de un pago con tarjeta de crédito por Mercado Pago lleva 48', async () => {
    enqueue('facturas', { data: null, error: null }, { data: null, error: null }, { data: { id: 'fac-1' }, error: null });
    mockCreateBill.mockResolvedValueOnce({ data: { bill: { id: 1, number: 'FE1', cufe: 'cufe-1', total: '80000.00', tax_amount: '0' } } });
    const p = pago('completado');
    enqueue('pagos', { ...p, data: { ...p.data, metodo: 'pasarela', gateway_response: { payment_type_id: 'credit_card' } } });

    await crearFacturaDesdePago('pago-1', null);

    expect(mockCreateBill.mock.calls[0][0].payment_details[0].payment_method_code).toBe('48');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Plan cobro-tarifa-mensual §6, emisión (B4): el bloqueo «emitiendo», la
// factura solo con las líneas facturables, a crédito, y el reintento que
// recupera la factura con getBillByReference. emitirCuenta con la
// crearFacturaDesdeCuentaCobro real; Factus y Supabase (colas por tabla) mockeados.

const { ops, queues, enqueue, next, efectos, envMock } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (t: string): Res => queues.get(t)?.shift() ?? { data: null, error: null };
  return {
    ops,
    queues,
    enqueue: (t: string, ...items: Res[]) => queues.set(t, [...(queues.get(t) ?? []), ...items]),
    next,
    efectos: { aviso: vi.fn(async () => undefined), createBill: vi.fn(), getBillByReference: vi.fn() },
    envMock: { TARIFA_FACTURA_ENABLED: true },
  };
});

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'neq', 'is', 'not', 'in', 'or', 'lte', 'gt', 'order', 'limit', 'range'])
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    supabase: {
      from: (t: string) => chainFor(t),
      auth: { admin: { getUserById: async () => ({ data: { user: { email: 'titular@inmo.co' } } }) } },
    },
  };
});
vi.mock('@/config/env', () => ({ env: envMock }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/companyConfig', () => ({ getCompany: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({}));
vi.mock('@/lib/factus', () => ({
  createBill: efectos.createBill,
  getBillByReference: efectos.getBillByReference,
  discoverNumberingRangeId: async () => null,
}));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: async () => ({ TARIFA_IVA: 19, TARIFA_COBRO_DESDE: 202611 }), mesCobroDesde: () => '2026-11-01' }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: efectos.aviso }));
vi.mock('@/modules/beneficios/beneficios.service', () => ({ gerenciaGeneralIds: async () => ['g1'] }));
vi.mock('@/modules/dashboard/dashboard.service', () => ({ pctDeEstudio: vi.fn() }));
vi.mock('@/modules/estudios/certificado.service', () => ({ viaDelEstudio: vi.fn() }));

import { emitirCuenta, emitirPendientes } from '../tarifa-cobro.service';

const ok = (data: unknown) => ({ data, error: null });
const de = (t: string, m: string) => ops.filter((o) => o.table === t && o.method === m);
const K = 'cuentas_cobro_tarifa';
const L = 'cuentas_cobro_tarifa_lineas';
const CUENTA = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', inmobiliaria_id: 'org1', periodo: '2026-12-01', vence_en: '2026-12-10', estado: 'emitiendo' };
const perfil = {
  nombre: 'Ana', apellido: 'Ruiz', tipo_documento: 'CC', numero_documento: '1', razon_social: 'Inmo S.A.S.', nit: '900123456-7',
  domicilio_direccion: 'Calle 1', direccion_comercial: null, direccion: null, telefono: '3001234567', whatsapp_recaudo: null,
  email_recaudo: 'facturas@inmo.co', municipio_codigo: '11001', municipio_nombre: 'Bogotá',
};
const linea = (o: Record<string, unknown>) => ({
  contrato_id: 'c1', periodo: '2026-12-01', dias: 31, dias_mes: 31, iva_pct: 19, facturable: true, contrato: { numero: 'CTO-1' }, ...o,
});
const LINEAS = [
  linea({ base_cop: 25_000, iva_cop: 4750 }), // V3 Tradicional
  linea({ contrato_id: 'm1', periodo: '2026-11-01', dias: 12, dias_mes: 30, base_cop: 12_345, iva_cop: 2345.55, contrato: { numero: 'MIG-7' } }), // migrado, tardía
  linea({ contrato_id: 'c2', base_cop: 30_000, iva_cop: 5700, facturable: false, contrato: { numero: 'CTO-2' } }), // Trasladada (D13)
];
const BILL = { data: { bill: { id: 9, number: 'FE1', cufe: 'cufe-1', qr: 'q', qr_image: 'i', total: '44441.00', tax_amount: '7095.55' } } };

/** Cuenta tomada, sus líneas y la inmobiliaria con datos fiscales completos. */
function hastaElCliente() {
  enqueue(K, ok([CUENTA]));
  enqueue(L, ok(LINEAS));
  enqueue('inmobiliarias', ok({ owner_perfil_id: 'p1', estado: 'activa' }));
  enqueue('perfiles', ok(perfil));
}

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  envMock.TARIFA_FACTURA_ENABLED = true;
});

describe('emitirCuenta: bloqueo', () => {
  it('toma la cuenta solo desde borrador (o una emisión colgada) en una sola actualización condicionada', async () => {
    hastaElCliente();
    enqueue('facturas', ok(null), ok({ id: 'f1' }));
    efectos.createBill.mockResolvedValueOnce(BILL);
    enqueue(K, ok({ id: CUENTA.id, estado: 'emitida' }));
    enqueue('inmobiliaria_miembros', ok([{ perfil_id: 't1' }]));

    await emitirCuenta(CUENTA.id, 'admin');

    expect(de(K, 'update')[0].args[0]).toEqual({ estado: 'emitiendo' });
    expect(String(de(K, 'or')[0].args[0])).toMatch(/^estado\.eq\.borrador,and\(estado\.eq\.emitiendo,updated_at\.lt\./);
  });

  it('la segunda de dos emisiones a la vez recibe 409 sin tocar Factus ni la cuenta', async () => {
    enqueue(K, ok([]), ok({ estado: 'emitiendo' }));

    await expect(emitirCuenta(CUENTA.id)).rejects.toMatchObject({ statusCode: 409, errorCode: 'CUENTA_COBRO_NO_EMITIBLE' });
    expect(efectos.createBill).not.toHaveBeenCalled();
    expect(de(K, 'update')).toHaveLength(1);
  });
});

describe('emitirCuenta: factura', () => {
  it('solo líneas facturables, a crédito con vencimiento, IVA por línea y un solo cash_rounding', async () => {
    hastaElCliente();
    enqueue('facturas', ok(null), ok({ id: 'f1' }));
    efectos.createBill.mockResolvedValueOnce(BILL);
    enqueue(K, ok({ id: CUENTA.id, estado: 'emitida', factura_id: 'f1' }));
    enqueue('inmobiliaria_miembros', ok([{ perfil_id: 't1' }]));

    await emitirCuenta(CUENTA.id, 'admin');

    const payload = efectos.createBill.mock.calls[0][0];
    expect(payload.reference_code).toBe('TM-AAAAAAAABBBB');
    expect(payload.items.map((i: { name: string }) => i.name)).toEqual([
      'Tarifa mensual fianza – Contrato CTO-1 – 2026-12 (31/31 días)',
      'Tarifa mensual fianza – Contrato MIG-7 – 2026-11 (12/30 días)',
    ]);
    expect(payload.items[1]).toMatchObject({ code_reference: 'tarifa_mensual', price: '12345.00', taxes: [{ code: '01', rate: '19.00' }] });
    // 37.345 + 7.095,55 de IVA = 44.440,55 → se cobran 44.441: 0,45 de ajuste.
    expect(payload.payment_details).toEqual([{ payment_form: 2, payment_method_code: '47', amount: '44441.00', due_date: '2026-12-10' }]);
    expect(payload.cash_rounding_amount).toBe('0.45');
    expect(payload.customer).toMatchObject({ identification: '900123456', dv: '7', company: 'Inmo S.A.S.', legal_organization_code: '1' });

    // La cuenta congela los totales de TODAS sus líneas (Trasladada incluida) y queda con la factura.
    const final = de(K, 'update')[1].args[0] as Record<string, unknown>;
    expect(final).toMatchObject({ estado: 'emitida', base_cop: 67_345, total_cop: 80_141, factura_id: 'f1', cliente_nit: '900123456-7' });
    expect(de('facturas', 'insert')[0].args[0]).toMatchObject({ cuenta_cobro_id: CUENTA.id, estado: 'emitida', concepto: 'tarifa_mensual', factus_number: 'FE1' });
    expect(efectos.aviso).toHaveBeenCalledWith(expect.objectContaining({ userId: 't1', tipo: 'tarifa.cuenta_emitida' }));
  });

  it('solo Trasladada: se emite sin factura', async () => {
    enqueue(K, ok([CUENTA]));
    enqueue(L, ok([LINEAS[2]]));
    enqueue('inmobiliarias', ok({ owner_perfil_id: 'p1', estado: 'activa' }));
    enqueue('perfiles', ok(perfil));
    enqueue(K, ok({ id: CUENTA.id, estado: 'emitida' }));
    enqueue('inmobiliaria_miembros', ok([{ perfil_id: 't1' }]));

    await emitirCuenta(CUENTA.id);

    expect(efectos.createBill).not.toHaveBeenCalled();
    expect(de(K, 'update')[1].args[0]).toMatchObject({ estado: 'emitida', factura_id: null });
  });

  it('TARIFA_FACTURA_ENABLED apagado: queda emitida sin pasar por Factus y sin avisar a la inmobiliaria (sombra)', async () => {
    envMock.TARIFA_FACTURA_ENABLED = false;
    hastaElCliente();
    enqueue(K, ok({ id: CUENTA.id, estado: 'emitida' }));

    await emitirCuenta(CUENTA.id);

    expect(efectos.createBill).not.toHaveBeenCalled();
    expect(de('facturas', 'select')).toHaveLength(0);
    expect(de(K, 'update')[1].args[0]).toMatchObject({ estado: 'emitida', factura_id: null });
    expect(de('inmobiliaria_miembros', 'select')).toHaveLength(0);
    expect(efectos.aviso).toHaveBeenCalledTimes(1);
    expect(efectos.aviso).toHaveBeenCalledWith(expect.objectContaining({ userId: 'g1', tipo: 'tarifa.cuenta_emitida_sombra' }));
  });

  it('con líneas anteriores a TARIFA_COBRO_DESDE no se emite (D16) y vuelve a borrador', async () => {
    enqueue(K, ok([CUENTA]));
    enqueue(L, ok([linea({ periodo: '2026-10-01', base_cop: 25_000, iva_cop: 4750 })]));

    await expect(emitirCuenta(CUENTA.id)).rejects.toMatchObject({ statusCode: 409, errorCode: 'CUENTA_COBRO_ANTERIOR_AL_DESDE' });
    expect(efectos.createBill).not.toHaveBeenCalled();
    expect(de(K, 'update').at(-1)!.args[0]).toEqual({ estado: 'borrador' });
  });
});

describe('emitirCuenta: fallas y reintento', () => {
  it('Factus falla y no la tiene: queda el intento y la cuenta sigue en emitiendo, con las líneas congeladas, para el reintento', async () => {
    hastaElCliente();
    enqueue('facturas', ok(null), ok({ id: 'f1' }));
    efectos.createBill.mockRejectedValueOnce(new Error('Factus 500'));
    efectos.getBillByReference.mockResolvedValueOnce(null);

    await expect(emitirCuenta(CUENTA.id)).rejects.toThrow('Factus 500');

    expect(de('facturas', 'insert')[0].args[0]).toMatchObject({ estado: 'solicitada', error_mensaje: 'Factus 500', factus_reference_code: 'TM-AAAAAAAABBBB' });
    expect(de(K, 'update')).toHaveLength(1); // solo la toma: no vuelve a borrador
  });

  it('falla antes de Factus (datos fiscales): vuelve a borrador', async () => {
    enqueue(K, ok([CUENTA]));
    enqueue(L, ok(LINEAS));
    enqueue('inmobiliarias', ok({ owner_perfil_id: 'p1', estado: 'activa' }));
    enqueue('perfiles', ok({ ...perfil, nit: null, razon_social: null }));

    await expect(emitirCuenta(CUENTA.id)).rejects.toMatchObject({ errorCode: 'CLIENTE_DATOS_INCOMPLETOS' });
    expect(de(K, 'update').at(-1)!.args[0]).toEqual({ estado: 'borrador' });
    expect(de(K, 'eq').slice(-1)[0].args).toEqual(['estado', 'emitiendo']);
  });

  it('la factura recuperada no cuadra con la cuenta: 409, no se guarda como emitida y se avisa a Gerencia', async () => {
    hastaElCliente();
    enqueue('facturas', ok({ id: 'f1', estado: 'solicitada', factus_number: null, cufe: null }));
    efectos.getBillByReference.mockResolvedValueOnce({ data: { bill: { ...BILL.data.bill, total: '30000.00' } } });

    await expect(emitirCuenta(CUENTA.id)).rejects.toMatchObject({ statusCode: 409, errorCode: 'FACTURA_RECUPERADA_NO_CUADRA' });
    expect(de('facturas', 'update')).toHaveLength(0);
    expect(de(K, 'update')).toHaveLength(1);
    expect(efectos.aviso).toHaveBeenCalledWith(expect.objectContaining({ userId: 'g1', tipo: 'tarifa.factura_no_cuadra' }));
  });

  it('si no se puede leer el intento anterior, no se llama a Factus', async () => {
    hastaElCliente();
    enqueue('facturas', { data: null, error: { code: '08006', message: 'conexión' } });

    await expect(emitirCuenta(CUENTA.id)).rejects.toMatchObject({ statusCode: 500 });
    expect(efectos.createBill).not.toHaveBeenCalled();
    expect(efectos.getBillByReference).not.toHaveBeenCalled();
  });

  it('el reintento recupera con getBillByReference la factura que Factus ya emitió, sin emitir otra', async () => {
    hastaElCliente();
    enqueue('facturas', ok({ id: 'f1', estado: 'solicitada', factus_number: null, cufe: null }), ok({ id: 'f1' }));
    efectos.getBillByReference.mockResolvedValueOnce(BILL);
    enqueue(K, ok({ id: CUENTA.id, estado: 'emitida', factura_id: 'f1' }));
    enqueue('inmobiliaria_miembros', ok([{ perfil_id: 't1' }]));

    await emitirCuenta(CUENTA.id);

    expect(efectos.getBillByReference).toHaveBeenCalledWith('TM-AAAAAAAABBBB');
    expect(efectos.createBill).not.toHaveBeenCalled();
    expect(de('facturas', 'update')[0].args[0]).toMatchObject({ estado: 'emitida', cufe: 'cufe-1' });
    expect(de('facturas', 'insert')).toHaveLength(0);
    expect(de(K, 'update')[1].args[0]).toMatchObject({ estado: 'emitida', factura_id: 'f1' });
  });

  it('la respuesta de Factus se perdió: se recupera la factura en el mismo intento', async () => {
    hastaElCliente();
    enqueue('facturas', ok(null), ok({ id: 'f1' }));
    efectos.createBill.mockRejectedValueOnce(new Error('socket hang up'));
    efectos.getBillByReference.mockResolvedValueOnce(BILL);
    enqueue(K, ok({ id: CUENTA.id, estado: 'emitida', factura_id: 'f1' }));
    enqueue('inmobiliaria_miembros', ok([{ perfil_id: 't1' }]));

    await emitirCuenta(CUENTA.id);

    expect(de('facturas', 'insert')[0].args[0]).toMatchObject({ estado: 'emitida', factus_number: 'FE1' });
  });
});

describe('emitirPendientes', () => {
  it('toma las borrador ya cortadas y retoma las colgadas en emitiendo', async () => {
    enqueue(K, ok([]));
    await expect(emitirPendientes(new Date('2026-12-03T15:00:00Z'))).resolves.toEqual({ emitidas: 0, fallidas: 0 });
    expect(String(de(K, 'or')[0].args[0])).toBe('estado.eq.borrador,and(estado.eq.emitiendo,updated_at.lt."2026-12-03T14:50:00.000Z")');
    expect(de(K, 'lte')[0].args).toEqual(['periodo', '2026-12-01']);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Plan cobro-tarifa-mensual §6, barrido (B3). Mock de Supabase con colas por
// tabla (patrón de primas-remision.test): cada await consume el siguiente
// resultado de la tabla; todas las llamadas quedan en `ops`.

const { ops, queues, enqueue, next, efectos } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (t: string): Res => queues.get(t)?.shift() ?? { data: null, error: null };
  return {
    ops,
    queues,
    enqueue: (t: string, ...items: Res[]) => queues.set(t, [...(queues.get(t) ?? []), ...items]),
    next,
    efectos: { aviso: vi.fn(async () => undefined), pctEstudio: vi.fn(async () => null as number | null) },
  };
});

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'neq', 'is', 'not', 'in', 'lt', 'order', 'limit', 'range'])
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.maybeSingle = async () => next(table);
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
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/calibracion', () => ({
  getCalibracion: async () => ({ TARIFA_COBRO_DESDE: 202611, TARIFA_IVA: 19 }),
  mesCobroDesde: (n: number) => `${Math.floor(n / 100)}-${String(n % 100).padStart(2, '0')}-01`,
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: efectos.aviso }));
vi.mock('@/modules/beneficios/beneficios.service', () => ({ gerenciaGeneralIds: async () => ['g1'] }));
vi.mock('@/modules/dashboard/dashboard.service', () => ({ pctDeEstudio: efectos.pctEstudio }));
vi.mock('@/modules/estudios/certificado.service', () => ({ viaDelEstudio: vi.fn() }));
vi.mock('@/config/env', () => ({ env: {} }));
vi.mock('@/modules/facturacion/facturacion.service', () => ({ crearFacturaDesdeCuentaCobro: vi.fn() }));

import { liquidarPendientes } from '../tarifa-cobro.service';

const ok = (data: unknown) => ({ data, error: null });
const de = (t: string, m: string) => ops.filter((o) => o.table === t && o.method === m);
const L = 'cuentas_cobro_tarifa_lineas';
const K = 'cuentas_cobro_tarifa';
// 15/11/2026 en Bogotá: el mes cortado es noviembre.
const NOV_15 = new Date('2026-11-15T15:00:00Z');

const v3 = (o: Record<string, unknown> = {}) => ({
  id: 'c1',
  numero: 'CTO-1',
  origen: 'plataforma',
  estado: 'vigente',
  destinacion: 'vivienda',
  fecha_firma: '2026-11-10T15:00:00Z',
  fecha_inicio: '2026-11-10',
  fecha_terminacion: null,
  fecha_terminacion_efectiva: null,
  valor_arriendo: 1_000_000,
  tarifa_congelada: 2.5,
  modalidad: 'tradicional',
  expediente_id: 'e1',
  expedientes: { inmuebles: { inmobiliaria_id: 'org1' } },
  migracion_filas: [],
  ...o,
});
const migrado = (o: Record<string, unknown> = {}) =>
  v3({
    id: 'm1',
    origen: 'migracion',
    destinacion: null,
    modalidad: null,
    tarifa_congelada: null,
    fecha_firma: '2026-10-01T15:00:00Z',
    migracion_filas: [{ tarifa_pct: 2.5, tarifa_acta_pct: null, tarifa_desde: null, excluido_en: null }],
    ...o,
  });

const PERFIL_OK = {
  nombre: 'Ana',
  apellido: 'Gómez',
  tipo_documento: 'cc',
  numero_documento: '123',
  razon_social: 'Inmobiliaria Uno S.A.S.',
  nit: '900123456-7',
  domicilio_direccion: 'Calle 1 # 2-3',
  telefono: '3001234567',
  municipio_codigo: '11001',
  municipio_nombre: 'Bogotá',
};

/** Lecturas iniciales del barrido, en el orden de cada tabla. */
function base(p: { contratos: unknown[]; lineas?: unknown[]; cuentas?: unknown[]; condiciones?: unknown[] }) {
  enqueue('contratos', ok(p.contratos));
  enqueue('contrato_condiciones_cobro', ok(p.condiciones ?? []));
  enqueue(L, ok(p.lineas ?? []));
  enqueue(K, ok(p.cuentas ?? []));
}
const fiscal = (perfil: unknown = PERFIL_OK) => {
  enqueue('inmobiliarias', ok({ owner_perfil_id: 'p1' }));
  enqueue('perfiles', ok(perfil));
};
const cuenta = (id: string, periodo: string, estado = 'borrador') => ({ id, inmobiliaria_id: 'org1', periodo, estado });

beforeEach(() => {
  ops.length = 0;
  queues.clear();
  vi.clearAllMocks();
});

describe('liquidarPendientes', () => {
  it('crea la cuenta del mes en borrador (vence el 10) con la línea proporcional del contrato', async () => {
    base({ contratos: [v3()] });
    enqueue(K, ok(null), ok(cuenta('k1', '2026-11-01')), ok([cuenta('k1', '2026-11-01')]));
    enqueue(L, ok(null), ok([{ base_cop: 17500, iva_cop: 3325 }]));
    fiscal();

    expect(await liquidarPendientes(NOV_15)).toEqual({ lineas: 1, recalculadas: 0, bloqueadas: 0 });
    expect(de(K, 'upsert')[0].args[0]).toEqual({ inmobiliaria_id: 'org1', periodo: '2026-11-01', vence_en: '2026-11-10' });
    expect(de(L, 'insert')[0].args[0]).toMatchObject({
      cuenta_id: 'k1',
      contrato_id: 'c1',
      periodo: '2026-11-01',
      modalidad: 'tradicional',
      origen: 'plataforma',
      facturable: true,
      dias: 21,
      dias_mes: 30,
      base_cop: 17500,
      iva_cop: 3325,
      total_cop: 20825,
    });
    // Totales desde las líneas, solo sobre una cuenta que sigue en borrador.
    const totales = de(K, 'update')[0];
    expect(totales.args[0]).toEqual({ base_cop: 17500, iva_cop: 3325, cash_rounding_cop: 0, total_cop: 20825 });
    expect(ops.some((o) => o.table === K && o.method === 'in' && o.args[0] === 'estado')).toBe(true);
    expect(efectos.aviso).not.toHaveBeenCalled();
  });

  it('es idempotente: con la línea ya liquidada no inserta ni actualiza; un 23505 de otra pasada no rompe', async () => {
    const viva = {
      id: 'l1', cuenta_id: 'k1', contrato_id: 'c1', periodo: '2026-11-01', estado: 'pendiente',
      pct: 2.5, canon_base: 1_000_000, dias: 21, base_cop: 17500, iva_pct: 19, requiere_nota_credito: false, cuenta: { estado: 'borrador' },
    };
    base({ contratos: [v3()], lineas: [viva], cuentas: [cuenta('k1', '2026-11-01')] });
    enqueue(K, ok([cuenta('k1', '2026-11-01')]));
    fiscal();
    expect(await liquidarPendientes(NOV_15)).toEqual({ lineas: 0, recalculadas: 0, bloqueadas: 0 });
    expect(de(L, 'insert')).toHaveLength(0);
    expect(de(L, 'update')).toHaveLength(0);

    ops.length = 0;
    queues.clear();
    base({ contratos: [v3()], cuentas: [cuenta('k1', '2026-11-01')] });
    enqueue(L, { data: null, error: { code: '23505', message: 'duplicate key' } });
    enqueue(K, ok([]));
    expect(await liquidarPendientes(NOV_15)).toMatchObject({ lineas: 0 });
  });

  it('una línea anulada (B5) se vuelve a liquidar en la siguiente pasada: el índice parcial la deja insertar', async () => {
    // El barrido solo lee las líneas vivas (estado <> 'anulada'): la anulada no cuenta.
    base({ contratos: [v3()], cuentas: [cuenta('k1', '2026-11-01')] });
    enqueue(L, ok(null), ok([{ base_cop: 17500, iva_cop: 3325 }]));
    enqueue(K, ok([cuenta('k1', '2026-11-01')]));
    fiscal();
    expect(await liquidarPendientes(NOV_15)).toMatchObject({ lineas: 1 });
    expect(de(L, 'neq')[0].args).toEqual(['estado', 'anulada']);
    expect(de(L, 'insert')[0].args[0]).toMatchObject({ cuenta_id: 'k1', contrato_id: 'c1', periodo: '2026-11-01' });
  });

  it('excluye propietario directo, legacy y migrados excluidos (también finalizado + excluido)', async () => {
    const excluida = [{ tarifa_pct: 2.5, tarifa_acta_pct: null, tarifa_desde: null, excluido_en: '2026-10-20T00:00:00Z' }];
    base({
      contratos: [
        v3({ id: 'directo', expedientes: { inmuebles: { inmobiliaria_id: null } } }),
        v3({ id: 'legacy', destinacion: null }),
        migrado({ id: 'excl', migracion_filas: excluida }),
        migrado({ id: 'excl-fin', estado: 'finalizado', fecha_terminacion: '2026-12-20T15:00:00Z', migracion_filas: excluida }),
      ],
    });
    enqueue(K, ok([]));
    expect(await liquidarPendientes(NOV_15)).toEqual({ lineas: 0, recalculadas: 0, bloqueadas: 0 });
    expect(de(L, 'insert')).toHaveLength(0);
    expect(de(K, 'upsert')).toHaveLength(0);
  });

  it('cobra el contrato que se activa y termina en el mismo mes después del corte (mes completo desde la activación)', async () => {
    const c = v3({ fecha_firma: '2026-11-12T15:00:00Z', fecha_inicio: '2026-11-12', estado: 'finalizado', fecha_terminacion: '2026-11-25T15:00:00Z' });
    base({ contratos: [c] });
    // 3/12: el mes cortado es diciembre; noviembre llega tarde y va a la cuenta de diciembre (D7).
    enqueue(K, ok(null), ok(cuenta('k12', '2026-12-01')), ok([]));
    expect(await liquidarPendientes(new Date('2026-12-03T15:00:00Z'))).toMatchObject({ lineas: 1 });
    expect(de(K, 'upsert')[0].args[0]).toMatchObject({ periodo: '2026-12-01', vence_en: '2026-12-10' });
    const ins = de(L, 'insert').map((o) => o.args[0] as Record<string, unknown>);
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ cuenta_id: 'k12', periodo: '2026-11-01', dias: 19 });
  });

  it('una línea tardía va al borrador más reciente: con la de M ya emitida, a la del siguiente corte', async () => {
    base({ contratos: [v3()], cuentas: [cuenta('k11', '2026-11-01', 'emitida')] });
    enqueue(K, ok(null), ok(cuenta('k12', '2026-12-01')), ok([]));
    await liquidarPendientes(NOV_15);
    expect(de(K, 'upsert')[0].args[0]).toMatchObject({ periodo: '2026-12-01', vence_en: '2026-12-10' });
    expect(de(L, 'insert')[0].args[0]).toMatchObject({ cuenta_id: 'k12', periodo: '2026-11-01' });
  });

  it('una inmobiliaria sin NIT queda en bloqueada_fiscal y se avisa a sus titulares una vez; con los datos, vuelve a borrador', async () => {
    base({ contratos: [], cuentas: [] });
    enqueue(K, ok([cuenta('k1', '2026-11-01')]), ok(null), ok([{ id: 'k1' }]));
    enqueue(L, ok([]));
    fiscal({ ...PERFIL_OK, nit: null, razon_social: null });
    enqueue('inmobiliaria_miembros', ok([{ perfil_id: 't1' }]));
    expect(await liquidarPendientes(NOV_15)).toMatchObject({ bloqueadas: 1 });
    const cambio = de(K, 'update')[1];
    expect(cambio.args[0]).toEqual({ estado: 'bloqueada_fiscal' });
    expect(efectos.aviso).toHaveBeenCalledTimes(1);
    expect(efectos.aviso.mock.calls[0]).toEqual([
      expect.objectContaining({ userId: 't1', tipo: 'tarifa.datos_fiscales_faltantes', link: '/configuracion/datos-contrato', mensaje: expect.stringContaining('NIT') }),
    ]);

    ops.length = 0;
    queues.clear();
    vi.clearAllMocks();
    base({ contratos: [] });
    enqueue(K, ok([cuenta('k1', '2026-11-01', 'bloqueada_fiscal')]), ok(null), ok([{ id: 'k1' }]));
    fiscal();
    expect(await liquidarPendientes(NOV_15)).toMatchObject({ bloqueadas: 0 });
    expect(de(K, 'update')[1].args[0]).toEqual({ estado: 'borrador' });
    expect(efectos.aviso).not.toHaveBeenCalled();
  });

  it('cambio de reportable el día del corte: avisa a Gerencia por la línea emitida y recalcula la de borrador', async () => {
    // El migrado pasa a 1,5 % desde noviembre; noviembre ya estaba emitido a 2,5 %.
    const m = migrado({ migracion_filas: [{ tarifa_pct: 1.5, tarifa_acta_pct: 2.5, tarifa_desde: '2026-11-01', excluido_en: null }] });
    const linea = (id: string, periodo: string, estado: string) => ({
      id, cuenta_id: `k-${periodo}`, contrato_id: 'm1', periodo, estado: 'pendiente', pct: 2.5, canon_base: 1_000_000,
      dias: 31, base_cop: 25000, iva_pct: 19, requiere_nota_credito: false, cuenta: { estado },
    });
    base({ contratos: [m], lineas: [linea('l-oct', '2026-10-01', 'emitida'), linea('l-nov', '2026-11-01', 'emitida'), linea('l-dic', '2026-12-01', 'borrador')] });
    enqueue(L, ok([{ id: 'l-nov' }]));
    enqueue(K, ok([]));
    // 30/11 a las 15:00 en Bogotá: ya se cortó diciembre.
    const r = await liquidarPendientes(new Date('2026-11-30T20:00:00Z'));
    expect(r).toMatchObject({ lineas: 0, recalculadas: 1 });
    const [flag, recalculo] = de(L, 'update');
    expect(flag.args[0]).toEqual({ requiere_nota_credito: true });
    expect(recalculo.args[0]).toMatchObject({ pct: 1.5, base_cop: 15000 });
    expect(efectos.aviso).toHaveBeenCalledTimes(1); // octubre (antes del cobro) no se toca
    expect(efectos.aviso.mock.calls[0]).toEqual([expect.objectContaining({ userId: 'g1', tipo: 'tarifa.cambio_en_cuenta_emitida' })]);
  });

  it('A6: Cofianza corrigió el canon de un mes ya emitido: se marca la nota crédito y se avisa a Gerencia', async () => {
    const emitida = {
      id: 'l1', cuenta_id: 'k1', contrato_id: 'c1', periodo: '2026-11-01', estado: 'pendiente',
      pct: 2.5, canon_base: 1_000_000, dias: 21, base_cop: 17500, iva_pct: 19, requiere_nota_credito: false, cuenta: { estado: 'emitida' },
    };
    base({ contratos: [v3()], lineas: [emitida], condiciones: [{ contrato_id: 'c1', desde: '2026-11-01', canon_cop: 900_000, tarifa_pct: null }] });
    enqueue(L, ok([{ id: 'l1' }]));
    enqueue(K, ok([]));
    await liquidarPendientes(NOV_15);
    expect(de(L, 'update')[0].args[0]).toEqual({ requiere_nota_credito: true });
    expect(efectos.aviso.mock.calls[0]).toEqual([expect.objectContaining({ tipo: 'tarifa.cambio_en_cuenta_emitida', payload: expect.objectContaining({ canon_nuevo: 900_000 }) })]);
  });

  it('V3 sin tarifa congelada: congela el % de su estudio en el primer período cobrado (D2)', async () => {
    efectos.pctEstudio.mockResolvedValueOnce(2);
    base({ contratos: [v3({ tarifa_congelada: null })] });
    // upsert y completar el % sin respuesta; la relectura devuelve la fila como quedó.
    enqueue('contrato_condiciones_cobro', ok(null), ok(null), ok({ desde: '2026-11-01', canon_cop: null, tarifa_pct: 2 }));
    enqueue(K, ok(null), ok(cuenta('k1', '2026-11-01')), ok([]));
    await liquidarPendientes(NOV_15);
    expect(de('contrato_condiciones_cobro', 'upsert')[0].args[0]).toEqual({ contrato_id: 'c1', desde: '2026-11-01', canon_cop: null, tarifa_pct: 2 });
    expect(de(L, 'insert')[0].args[0]).toMatchObject({ pct: 2, base_cop: 14000 });
  });

  it('D2: si el mes ya tenía fila solo con el canon, se le completa el % y se cobra con esa fila', async () => {
    efectos.pctEstudio.mockResolvedValueOnce(2);
    base({ contratos: [v3({ tarifa_congelada: null })], condiciones: [{ contrato_id: 'c1', desde: '2026-11-01', canon_cop: 800_000, tarifa_pct: null }] });
    enqueue('contrato_condiciones_cobro', ok(null), ok(null), ok({ desde: '2026-11-01', canon_cop: 800_000, tarifa_pct: 2 }));
    enqueue(K, ok(null), ok(cuenta('k1', '2026-11-01')), ok([]));
    await liquidarPendientes(NOV_15);
    const completar = de('contrato_condiciones_cobro', 'update')[0];
    expect(completar.args[0]).toEqual({ tarifa_pct: 2 });
    expect(de('contrato_condiciones_cobro', 'is')[0].args).toEqual(['tarifa_pct', null]);
    expect(de(L, 'insert')[0].args[0]).toMatchObject({ pct: 2, canon_base: 800_000 });
  });

  it('antes de TARIFA_COBRO_DESDE no liquida; solo anula las pendientes en borrador de meses anteriores al tope (D16)', async () => {
    // El tope se movió hacia adelante (o se «apagó»): lo ya liquidado en borrador de esos meses sale.
    enqueue(K, ok([{ id: 'k10' }, { id: 'k11' }]));
    enqueue(L, ok([{ id: 'l1' }]));
    expect(await liquidarPendientes(new Date('2026-10-15T15:00:00Z'))).toEqual({ lineas: 0, recalculadas: 1, bloqueadas: 0 });
    expect(de(K, 'in')[0].args).toEqual(['estado', ['borrador', 'bloqueada_fiscal']]);
    expect(de(L, 'update')[0].args[0]).toMatchObject({ estado: 'anulada' });
    expect(de(L, 'in')[0].args).toEqual(['cuenta_id', ['k10', 'k11']]);
    expect(de(L, 'lt')[0].args).toEqual(['periodo', '2026-11-01']);
    expect(de(L, 'eq')[0].args).toEqual(['estado', 'pendiente']);
    expect(de('contratos', 'select')).toHaveLength(0);
  });

  it('la cuenta pasó a emitiendo entre la lectura y la escritura: el trigger (P0T01) frena la línea y el barrido sigue', async () => {
    base({ contratos: [v3()], cuentas: [cuenta('k1', '2026-11-01')] });
    enqueue(L, { data: null, error: { code: 'P0T01', message: 'congelada' } });
    enqueue(K, ok([]));
    expect(await liquidarPendientes(NOV_15)).toEqual({ lineas: 0, recalculadas: 0, bloqueadas: 0 });
  });
});

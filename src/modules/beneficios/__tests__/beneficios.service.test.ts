import { describe, it, expect, vi, beforeEach } from 'vitest';

// Adenda de precios §4: beneficio Tradicional y alerta de mezcla.
// Mock de Supabase con colas por tabla (patrón de creditos-estudios.org.test).

const { ops, queues, enqueue, chainFor, mockNotificar, operadores, usuarios } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'upsert', 'update', 'eq', 'in', 'is', 'not', 'gte', 'or', 'order', 'limit'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH)
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    chainFor,
    mockNotificar: vi.fn(async () => undefined),
    operadores: [
      { id: 'gg', rol: 'administrador' },
      { id: 'ad2', rol: 'administrador' },
      { id: 'op1', rol: 'operador_analista' },
    ],
    usuarios: { gg: 'gerencia@cofianza.co', ad2: 'otro@cofianza.co' } as Record<string, string>,
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => chainFor(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: { GERENCIA_GENERAL_EMAILS: ['gerencia@cofianza.co'] } }));
vi.mock('@/lib/calibracion', () => ({
  getCalibracion: vi.fn(async () => ({ PORCENTAJE_BENEFICIO_TRADICIONAL: 50, ALERTA_MEZCLA_TRADICIONAL_PAQUETE_25: 80 })),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: mockNotificar }));
vi.mock('@/modules/users/users.service', () => ({
  listOperators: vi.fn(async () => operadores),
  getUserById: vi.fn(async (id: string) => ({ id, email: usuarios[id] })),
}));

import {
  baseBeneficioEstudio,
  causarBeneficioTradicional,
  decidirAlertaMezcla,
  evaluarAlertaMezcla,
} from '../beneficios.service';

const ok = (data: unknown) => ({ data, error: null });
const tabla = (t: string, m: string) => ops.filter((o) => o.table === t && o.method === m);

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('baseBeneficioEstudio (§4.1 / §9.9)', () => {
  const pago = { id: 'p1', monto: 80_000, base_cop: null };

  it('con crédito: precio unitario sin IVA de la compra del lote, no pagos.monto', () => {
    const b = baseBeneficioEstudio({
      pago: { id: 'p1', monto: 95_200, base_cop: null },
      consumo: { lote_id: 'l1', compra: { id: 'c1', precio_cop: 1_400_000, cantidad_estudios: 25 } },
    });
    expect(b).toEqual({ base: 56_000, pago_id: 'p1', lote_id: 'l1', compra_id: 'c1' });
  });

  it('paquetes de 5 y 10: 70.000 y 64.000 por estudio', () => {
    const conCompra = (precio_cop: number, cantidad_estudios: number) =>
      baseBeneficioEstudio({ pago, consumo: { lote_id: 'l', compra: { id: 'c', precio_cop, cantidad_estudios } } }).base;
    expect(conCompra(350_000, 5)).toBe(70_000);
    expect(conCompra(640_000, 10)).toBe(64_000);
  });

  it('directo: la base sin IVA guardada en el pago', () => {
    expect(baseBeneficioEstudio({ pago: { id: 'p1', monto: 95_200, base_cop: 80_000 }, consumo: null }).base).toBe(80_000);
  });

  it('directo sin instantánea (cobro anterior, exento): pagos.monto', () => {
    expect(baseBeneficioEstudio({ pago, consumo: null }).base).toBe(80_000);
  });

  it('sin pago propio (portabilidad) o lote de ajuste sin compra: 0', () => {
    expect(baseBeneficioEstudio({ pago: null, consumo: null }).base).toBe(0);
    expect(baseBeneficioEstudio({ pago, consumo: { lote_id: 'l1', compra: null } }).base).toBe(0);
  });
});

describe('causarBeneficioTradicional (§4.2)', () => {
  const ctx = { contratoId: 'ct1', expedienteId: 'e1', orgId: 'org1' };

  it('Trasladada o sin inmobiliaria: no lee pagos ni causa', async () => {
    expect(await causarBeneficioTradicional({ ...ctx, modalidad: 'trasladada' })).toBe(false);
    expect(await causarBeneficioTradicional({ ...ctx, orgId: null, modalidad: 'tradicional' })).toBe(false);
    expect(ops).toEqual([]);
  });

  it('Tradicional pagado con crédito del paquete de 25: causa 28.000 con su origen', async () => {
    enqueue('pagos', ok([{ id: 'p1', monto: 95_200, base_cop: null }]));
    enqueue('movimientos_creditos_estudios', ok([{ tipo: 'consumo', lote_id: 'l1' }, { tipo: 'reserva', lote_id: 'l1' }]));
    enqueue('lotes_creditos_estudios', ok({ compra_id: 'c1' }));
    enqueue('compras_creditos_estudios', ok({ id: 'c1', precio_cop: 1_400_000, cantidad_estudios: 25 }));
    enqueue('beneficios_intermediacion', ok([{ id: 'b1' }]));

    expect(await causarBeneficioTradicional({ ...ctx, modalidad: 'tradicional' })).toBe(true);
    const [row, opts] = tabla('beneficios_intermediacion', 'upsert')[0].args as [Record<string, unknown>, Record<string, unknown>];
    expect(row).toMatchObject({
      inmobiliaria_id: 'org1',
      expediente_id: 'e1',
      contrato_id: 'ct1',
      tipo: 'tradicional_50',
      base_cop: 56_000,
      pct: 50,
      valor_cop: 28_000,
      lote_id: 'l1',
      compra_id: 'c1',
      pago_id: 'p1',
    });
    expect(opts).toEqual({ onConflict: 'expediente_id,tipo', ignoreDuplicates: true });
    // Solo el pago completado del estudio (del titular) es la base.
    expect(tabla('pagos', 'eq').map((o) => o.args)).toEqual([
      ['expediente_id', 'e1'],
      ['concepto', 'estudio'],
      ['estado', 'completado'],
    ]);
  });

  it('idempotente: si ya estaba causado (UNIQUE), no causa otro', async () => {
    enqueue('pagos', ok([{ id: 'p1', monto: 80_000, base_cop: null }]));
    enqueue('movimientos_creditos_estudios', ok([]));
    enqueue('beneficios_intermediacion', ok([])); // ignoreDuplicates: 0 filas

    expect(await causarBeneficioTradicional({ ...ctx, modalidad: 'tradicional' })).toBe(false);
    expect(tabla('beneficios_intermediacion', 'upsert')[0].args[0]).toMatchObject({ base_cop: 80_000, valor_cop: 40_000 });
  });

  it('M3: pagado con cupo aún en reserva: base del lote, nunca pagos.monto (95.200 con IVA)', async () => {
    enqueue('pagos', ok([{ id: 'p1', monto: 95_200, base_cop: null }]));
    enqueue('movimientos_creditos_estudios', ok([{ tipo: 'reserva', lote_id: 'l1' }]));
    enqueue('lotes_creditos_estudios', ok({ compra_id: 'c1' }));
    enqueue('compras_creditos_estudios', ok({ id: 'c1', precio_cop: 1_400_000, cantidad_estudios: 25 }));
    enqueue('beneficios_intermediacion', ok([{ id: 'b1' }]));

    expect(await causarBeneficioTradicional({ ...ctx, modalidad: 'tradicional' })).toBe(true);
    expect(tabla('beneficios_intermediacion', 'upsert')[0].args[0]).toMatchObject({ base_cop: 56_000, lote_id: 'l1', compra_id: 'c1' });
    // Reconoce el pago con cupo por cualquier movimiento, no solo por 'consumo'.
    expect(tabla('movimientos_creditos_estudios', 'eq').map((o) => o.args)).toEqual([['pago_id', 'p1']]);
    expect(tabla('movimientos_creditos_estudios', 'in')[0].args).toEqual(['tipo', ['reserva', 'consumo', 'liberacion', 'ajuste']]);
  });

  it('M3: pagado con cupo que se liberó (último movimiento liberación o ajuste): no causa', async () => {
    for (const tipo of ['liberacion', 'ajuste']) {
      enqueue('pagos', ok([{ id: 'p1', monto: 95_200, base_cop: null }]));
      enqueue('movimientos_creditos_estudios', ok([{ tipo, lote_id: 'l1' }, { tipo: 'reserva', lote_id: 'l1' }]));
      expect(await causarBeneficioTradicional({ ...ctx, modalidad: 'tradicional' })).toBe(false);
    }
    expect(tabla('lotes_creditos_estudios', 'select')).toEqual([]);
    expect(tabla('beneficios_intermediacion', 'upsert')).toEqual([]);
  });

  it('estudio sin pago propio (portabilidad): no causa', async () => {
    enqueue('pagos', ok([]));
    expect(await causarBeneficioTradicional({ ...ctx, modalidad: 'tradicional' })).toBe(false);
    expect(tabla('beneficios_intermediacion', 'upsert')).toEqual([]);
  });
});

describe('alerta de mezcla (§4.4)', () => {
  const base = { tienePaquete25: true, tradicionales: 5, total: 6, umbralPct: 80, yaAlertada: false };

  it('decide solo al cruzar y se rearma al bajar', () => {
    expect(decidirAlertaMezcla(base)).toBe('alertar'); // 83 % > 80 %
    expect(decidirAlertaMezcla({ ...base, yaAlertada: true })).toBe('nada');
    expect(decidirAlertaMezcla({ ...base, tradicionales: 4, total: 5 })).toBe('nada'); // 80 % no supera
    expect(decidirAlertaMezcla({ ...base, tradicionales: 4, total: 5, yaAlertada: true })).toBe('rearmar');
    expect(decidirAlertaMezcla({ ...base, tradicionales: 4, total: 4 })).toBe('nada'); // menos de 5 contratos
    expect(decidirAlertaMezcla({ ...base, tienePaquete25: false })).toBe('nada');
  });

  const escenario = (alertada: string | null, marcada: unknown = [{ id: 'org1' }]) => {
    enqueue('inmobiliarias', ok({ nombre: 'Inmo Uno', owner_perfil_id: 'own1', alerta_mezcla_tradicional_en: alertada }), ok(marcada));
    enqueue('lotes_creditos_estudios', ok([{ compra_id: 'c25' }]));
    enqueue('compras_creditos_estudios', ok([{ id: 'c25' }]));
    enqueue(
      'contratos',
      ok([...Array(5).fill({ modalidad: 'tradicional' }), { modalidad: 'trasladada' }]),
    );
  };

  it('al cruzar el umbral avisa (in-app y correo) solo a la Gerencia General y guarda la alerta', async () => {
    escenario(null);
    expect(await evaluarAlertaMezcla('org1')).toBe('alertar');
    expect(mockNotificar).toHaveBeenCalledTimes(1);
    expect(mockNotificar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'gg', tipo: 'inmobiliaria.mezcla_tradicional' }));
    const msg = (mockNotificar.mock.calls[0] as unknown as [{ mensaje: string }])[0].mensaje;
    expect(msg).toContain('5 de 6');
    expect(msg).toContain('no se bloqueó nada');
    const upd = tabla('inmobiliarias', 'update')[0].args[0] as Record<string, unknown>;
    expect(upd.alerta_mezcla_tradicional_en).toEqual(expect.any(String));
    expect(tabla('inmobiliarias', 'is')[0].args).toEqual(['alerta_mezcla_tradicional_en', null]);
  });

  it('los contratos migrados no entran en la mezcla (spec migración §4.1)', async () => {
    escenario(null);
    await evaluarAlertaMezcla('org1');
    expect(tabla('contratos', 'eq').map((o) => o.args)).toContainEqual(['origen', 'plataforma']);
  });

  it('ya alertada: no repite el aviso', async () => {
    escenario('2026-09-01T00:00:00Z');
    expect(await evaluarAlertaMezcla('org1')).toBe('nada');
    expect(mockNotificar).not.toHaveBeenCalled();
    expect(tabla('inmobiliarias', 'update')).toEqual([]);
  });

  it('ventana de 6 meses sin desborde de mes: 31-ago cuenta desde el 28-feb', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-31T15:00:00.000Z'), toFake: ['Date'] });
    try {
      escenario('2026-09-01T00:00:00Z');
      await evaluarAlertaMezcla('org1');
      expect(tabla('contratos', 'gte')[0].args).toEqual(['fecha_firma', '2026-02-28T15:00:00.000Z']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('si otra activación ganó la marca, no avisa dos veces', async () => {
    escenario(null, []);
    expect(await evaluarAlertaMezcla('org1')).toBe('nada');
    expect(mockNotificar).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  calcularLinea,
  canonPropuesto,
  mesDe,
  periodoDesde,
  proximoAniversario,
  recordatorioQueToca,
  situacionDe,
  entraAlCobro,
  ivaLinea,
  mesCortado,
  mesesACobrar,
  terminacionDe,
  totalesDe,
  type ContratoCobro,
} from '../tarifa-cobro.reglas';

// Plan cobro-tarifa-mensual §6, reglas puras. Canon 1.000.000 × 2,5 % = 25.000 al mes; IVA 19 %.
const v3 = (o: Partial<ContratoCobro> = {}): ContratoCobro => ({
  id: 'c1',
  numero: 'CTO-1',
  origen: 'plataforma',
  estado: 'vigente',
  destinacion: 'vivienda',
  fecha_firma: '2026-11-01T15:00:00Z',
  fecha_inicio: '2026-11-01',
  fecha_terminacion: null,
  fecha_terminacion_efectiva: null,
  valor_arriendo: 1_000_000,
  tarifa_congelada: 2.5,
  modalidad: 'tradicional',
  inmobiliaria_id: 'org1',
  migracion: null,
  ...o,
});
const migrado = (o: Partial<ContratoCobro> = {}) =>
  v3({ origen: 'migracion', destinacion: null, modalidad: null, tarifa_congelada: null, fecha_inicio: '2025-03-01', migracion: { tarifa_pct: 2.5, tarifa_acta_pct: null, tarifa_desde: null, excluido_en: null }, ...o });

const linea = (c: ContratoCobro, periodo: string, conds = [], ivaPct = 19) => calcularLinea(c, conds, periodo, terminacionDe(c), ivaPct);

describe('primer mes proporcional (D4), contando el día de la activación', () => {
  it.each([
    ['2027-02-15', '2027-02-01', 14, 28, 12500], // 25.000 × 14/28
    ['2028-02-15', '2028-02-01', 15, 29, 12931],
    ['2026-11-10', '2026-11-01', 21, 30, 17500],
    ['2026-12-10', '2026-12-01', 22, 31, 17742],
  ])('activación %s', (dia, periodo, dias, diasMes, base) => {
    const l = linea(v3({ fecha_firma: `${dia}T15:00:00Z`, fecha_inicio: dia }), periodo)!;
    expect(l).toMatchObject({ dias, dias_mes: diasMes, base_cop: base, pct: 2.5, canon_base: 1_000_000, iva_pct: 19 });
    expect(l.iva_cop).toBe(ivaLinea(base, 19));
  });

  it('activación a las 20:00 de Bogotá del último día del mes: 1 día de ese mes', () => {
    const c = v3({ fecha_firma: '2026-12-01T01:00:00Z', fecha_inicio: null });
    expect(linea(c, '2026-11-01')).toMatchObject({ dias: 1, dias_mes: 30, base_cop: 833 });
    expect(linea(c, '2026-12-01')).toMatchObject({ dias: 31, base_cop: 25000 });
  });

  it('V3 con inicio posterior a la firma: causa desde el inicio (D3)', () => {
    const c = v3({ fecha_firma: '2026-11-05T15:00:00Z', fecha_inicio: '2026-12-01' });
    expect(linea(c, '2026-11-01')).toBeNull();
    expect(linea(c, '2026-12-01')).toMatchObject({ dias: 31, base_cop: 25000 });
    expect(mesesACobrar('2026-12-01T05:00:00.000Z', null, '2026-11-01', '2027-01-01')).toEqual(['2026-12-01', '2027-01-01']);
  });
});

describe('terminación', () => {
  const terminado = v3({ estado: 'finalizado', fecha_terminacion: '2027-01-03T16:00:00Z' });

  it('el mes de terminación se cobra completo (D5) y el siguiente no', () => {
    expect(linea(terminado, '2027-01-01')).toMatchObject({ dias: 31, base_cop: 25000 });
    expect(linea(terminado, '2027-02-01')).toBeNull();
  });

  it('la fecha efectiva prevalece, aun vigente; un terminado sin fechas usa el historial', () => {
    expect(terminacionDe(v3({ fecha_terminacion_efectiva: '2026-12-31' }))).toBe('2026-12-31T05:00:00.000Z');
    expect(terminacionDe(v3({ estado: 'vigente', fecha_terminacion: '2027-01-03T16:00:00Z' }))).toBeNull();
    expect(terminacionDe(v3({ estado: 'cancelado' }), '2027-02-02T10:00:00Z')).toBe('2027-02-02T10:00:00Z');
    const efectiva = v3({ fecha_terminacion_efectiva: '2026-12-31' });
    expect(linea(efectiva, '2027-01-01')).toBeNull();
    expect(mesesACobrar(efectiva.fecha_firma!, terminacionDe(efectiva), '2026-11-01', '2027-03-01')).toEqual(['2026-11-01', '2026-12-01']);
  });
});

describe('% y canon', () => {
  it('baja de tarifa del migrado: rige desde su tarifa_desde', () => {
    const c = migrado({ migracion: { tarifa_pct: 1.5, tarifa_acta_pct: 2.5, tarifa_desde: '2027-01-01', excluido_en: null } });
    expect(linea(c, '2026-12-01')).toMatchObject({ pct: 2.5, base_cop: 25000 });
    expect(linea(c, '2027-01-01')).toMatchObject({ pct: 1.5, base_cop: 15000 });
  });

  it('canon y % desde contrato_condiciones_cobro: la última fila con desde ≤ día 1 (D9)', () => {
    const conds = [
      { desde: '2027-01-01', canon_cop: 1_100_000, tarifa_pct: null },
      { desde: '2027-02-15', canon_cop: 1_200_000, tarifa_pct: null }, // a mitad de mes: rige desde marzo
      { desde: '2027-03-01', canon_cop: null, tarifa_pct: 2 }, // otrosí de Gerencia
    ];
    expect(calcularLinea(v3(), conds as never, '2026-12-01', null, 19)).toMatchObject({ canon_base: 1_000_000, pct: 2.5 });
    expect(calcularLinea(v3(), conds as never, '2027-02-01', null, 19)).toMatchObject({ canon_base: 1_100_000, base_cop: 27500 });
    expect(calcularLinea(v3(), conds as never, '2027-03-01', null, 19)).toMatchObject({ canon_base: 1_200_000, pct: 2, base_cop: 24000 });
    // En el migrado el % registrado también gana sobre el de su fila.
    expect(calcularLinea(migrado(), conds as never, '2027-03-01', null, 19)).toMatchObject({ pct: 2 });
  });

  it('V3 sin % no causa (la congelación la hace el barrido)', () => {
    expect(linea(v3({ tarifa_congelada: null }), '2026-11-01')).toBeNull();
  });
});

describe('meses y corte', () => {
  it('TARIFA_COBRO_DESDE impide liquidar meses anteriores (D16)', () => {
    expect(mesesACobrar('2025-06-10T15:00:00Z', null, '2026-11-01', '2027-01-01')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
    expect(mesesACobrar('2027-02-10T15:00:00Z', null, '2026-11-01', '2027-01-01')).toEqual([]);
  });

  it('mesCortado: el último día del mes (Bogotá) ya corta el siguiente (D6)', () => {
    expect(mesCortado('2026-11-29')).toBe('2026-11-01');
    expect(mesCortado('2026-11-30')).toBe('2026-12-01');
    expect(mesCortado('2026-12-31')).toBe('2027-01-01');
    expect(mesCortado('2028-02-28')).toBe('2028-02-01');
    expect(mesCortado('2028-02-29')).toBe('2028-03-01');
  });
});

describe('selección', () => {
  const desde = '2026-11-01';
  it('excluye propietario directo, legacy, migrado excluido o sin fila, sin firma, otros estados y terminados antes del cobro', () => {
    expect(entraAlCobro(v3(), null, desde)).toBe(true);
    expect(entraAlCobro(migrado(), null, desde)).toBe(true);
    expect(entraAlCobro(v3({ inmobiliaria_id: null }), null, desde)).toBe(false);
    expect(entraAlCobro(v3({ destinacion: null }), null, desde)).toBe(false);
    expect(entraAlCobro(migrado({ migracion: null }), null, desde)).toBe(false);
    const excluido = migrado({ estado: 'finalizado', migracion: { tarifa_pct: 2.5, tarifa_acta_pct: null, tarifa_desde: null, excluido_en: '2026-12-01T00:00:00Z' } });
    expect(entraAlCobro(excluido, '2027-01-01T00:00:00Z', desde)).toBe(false);
    expect(entraAlCobro(v3({ fecha_firma: null }), null, desde)).toBe(false);
    expect(entraAlCobro(v3({ estado: 'firma_incompleta' }), null, desde)).toBe(false);
    expect(entraAlCobro(v3({ estado: 'finalizado' }), '2026-10-31T15:00:00Z', desde)).toBe(false);
    expect(entraAlCobro(v3({ estado: 'finalizado' }), '2026-11-01T15:00:00Z', desde)).toBe(true);
  });
});

describe('IVA de N líneas (como Factus) + un solo cash_rounding', () => {
  it('IVA con centavos por línea; el total redondea una vez al peso', () => {
    const lineas = [17500, 8333, 8333, 8333].map((b) => ({ base_cop: b, iva_cop: ivaLinea(b, 19) }));
    expect(lineas[1].iva_cop).toBe(1583.27);
    const t = totalesDe(lineas);
    // base 42.499; IVA 3.325 + 3 × 1.583,27 = 8.074,81; exacto 50.573,81 → 50.574
    expect(t).toEqual({ base_cop: 42499, iva_cop: 8074.81, cash_rounding_cop: 0.19, total_cop: 50574 });
    expect(t.base_cop + t.iva_cop + t.cash_rounding_cop).toBeCloseTo(t.total_cop, 6);
  });

  it('sin líneas, todo en cero', () => {
    expect(totalesDe([])).toEqual({ base_cop: 0, iva_cop: 0, cash_rounding_cop: 0, total_cop: 0 });
  });
});

describe('situación de la cuenta (no guardada: sale de las líneas)', () => {
  const l = (...e: string[]) => e.map((estado) => ({ estado }));
  it('pagada, parcial, vencida y emitida', () => {
    expect(situacionDe('borrador', '2026-12-10', l('pendiente'), '2026-12-20')).toBe('borrador');
    expect(situacionDe('emitida', '2026-12-10', l('pagada', 'anulada'), '2026-12-20')).toBe('pagada');
    expect(situacionDe('emitida', '2026-12-10', l('pagada', 'pendiente'), '2026-12-05')).toBe('parcial');
    expect(situacionDe('emitida', '2026-12-10', l('pagada', 'pendiente'), '2026-12-11')).toBe('vencida');
    expect(situacionDe('emitida', '2026-12-10', l('pendiente'), '2026-12-10')).toBe('emitida');
    // Trasladada sin recaudar: no es pagada, pero tampoco vencida (la inmobiliaria no la debe todavía).
    expect(situacionDe('emitida', '2026-12-10', l('pagada', 'no_recaudada'), '2026-12-20')).toBe('parcial');
  });
});

describe('recordatorios de atraso (+1, +7, +15)', () => {
  it('uno por umbral, sin repetir y sin ráfagas', () => {
    expect(recordatorioQueToca('2026-12-10', '2026-12-10', 0)).toBeNull();
    expect(recordatorioQueToca('2026-12-10', '2026-12-11', 0)).toBe(1);
    expect(recordatorioQueToca('2026-12-10', '2026-12-12', 1)).toBeNull();
    expect(recordatorioQueToca('2026-12-10', '2026-12-17', 1)).toBe(2);
    // vista por primera vez a los 10 días: un solo recordatorio (el 2)
    expect(recordatorioQueToca('2026-12-10', '2026-12-20', 0)).toBe(2);
    expect(recordatorioQueToca('2026-12-10', '2026-12-25', 2)).toBe(3);
    expect(recordatorioQueToca('2027-01-10', '2027-03-01', 3)).toBeNull();
  });
});

describe('canon reajustado (D9) y aniversario', () => {
  it('a mitad de mes rige desde el día 1 del siguiente', () => {
    expect(periodoDesde('2027-03-01')).toBe('2027-03-01');
    expect(periodoDesde('2027-03-15')).toBe('2027-04-01');
    expect(periodoDesde('2027-12-31')).toBe('2028-01-01');
  });
  it('próximo aniversario de fecha_inicio, nunca el mismo día de inicio', () => {
    expect(proximoAniversario('2026-03-15', '2026-11-20')).toBe('2027-03-15');
    expect(proximoAniversario('2025-03-15', '2026-03-15')).toBe('2026-03-15');
    expect(proximoAniversario('2025-03-15', '2026-03-16')).toBe('2027-03-15');
    expect(proximoAniversario('2024-02-29', '2025-01-10')).toBe('2025-02-28');
  });
  it('canon propuesto con IPC, al peso', () => {
    expect(canonPropuesto(1_000_000, 5.1)).toBe(1_051_000);
    expect(canonPropuesto(1_234_567, 5.1)).toBe(1_297_530);
  });
  it('mes de un DATE o de un instante, en Bogotá', () => {
    expect(mesDe('2026-12-01')).toBe('2026-12-01');
    expect(mesDe('2026-12-01T03:00:00Z')).toBe('2026-11-01');
  });
});

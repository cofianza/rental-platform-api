import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { contarEstados, estadoMigracion, liquidarMes, primerDiaMesSiguiente } from '../cartera.reglas';

// ============================================================
// Migración — estado derivado (A4) y liquidación mensual (§4.7, §5.2.5).
// ============================================================

const fila = (o: Partial<Parameters<typeof estadoMigracion>[0]> = {}) => ({
  resultado: 'aceptada',
  en_revision: false,
  excluido_en: null,
  contrato_estado: null,
  ...o,
});

describe('estadoMigracion (A4)', () => {
  it('deriva cada estado de la spec §6', () => {
    expect(estadoMigracion(fila({ resultado: 'rechazada' }))).toBe('rechazado_validacion');
    expect(estadoMigracion(fila())).toBe('borrador');
    expect(estadoMigracion(fila({ resultado: 'advertencia' }))).toBe('borrador');
    expect(estadoMigracion(fila({ contrato_estado: 'vigente' }))).toBe('activa');
    expect(estadoMigracion(fila({ contrato_estado: 'vigente', en_revision: true }))).toBe('en_revision');
    expect(estadoMigracion(fila({ contrato_estado: 'cancelado', excluido_en: '2026-11-02T15:00:00Z' }))).toBe('excluido');
    expect(estadoMigracion(fila({ contrato_estado: 'finalizado' }))).toBe('terminado');
    // Cancelado sin exclusión (p. ej. terminado a mano) no es EXCLUIDO.
    expect(estadoMigracion(fila({ contrato_estado: 'cancelado' }))).toBe('terminado');
  });

  it('cuenta todos los estados, también los que están en cero', () => {
    const c = contarEstados(['activa', 'activa', 'borrador']);
    expect(c).toEqual({ rechazado_validacion: 0, borrador: 1, activa: 2, en_revision: 0, excluido: 0, terminado: 0 });
  });
});

describe('primerDiaMesSiguiente (§5.2.5)', () => {
  it('pasa al mes siguiente, también en diciembre', () => {
    expect(primerDiaMesSiguiente('2026-10-31')).toBe('2026-11-01');
    expect(primerDiaMesSiguiente('2026-12-15')).toBe('2027-01-01');
  });
});

describe('liquidarMes (§4.7)', () => {
  const base = {
    canon: 2_000_000,
    tarifa_pct: 2.5,
    tarifa_acta_pct: 2.5,
    tarifa_desde: '2026-10-16',
    // 16-oct 10:00 en Bogotá.
    activado_en: '2026-10-16T15:00:00Z',
    terminado_en: null,
  };

  it('el mes de la activación es proporcional a los días restantes, contando el de la activación', () => {
    // Octubre: 31 días; del 16 al 31 = 16 días. 2,5 % de 2.000.000 = 50.000 → 50.000 × 16/31.
    const l = liquidarMes(base, '2026-10', 19)!;
    expect(l).toMatchObject({ pct: 2.5, dias: 16, dias_mes: 31, tarifa: Math.round((50_000 * 16) / 31) });
    expect(l.total).toBe(Math.round(l.tarifa * 1.19));
    expect(l.iva).toBe(l.total - l.tarifa);
  });

  it('usa el día de Bogotá: 1-nov 03:00Z es todavía 31-oct', () => {
    expect(liquidarMes({ ...base, activado_en: '2026-11-01T03:00:00Z' }, '2026-10', 19)!.dias).toBe(1);
  });

  it('meses siguientes completos; antes de la activación no causa', () => {
    expect(liquidarMes(base, '2026-11', 19)).toMatchObject({ dias: 30, dias_mes: 30, tarifa: 50_000 });
    expect(liquidarMes(base, '2026-09', 19)).toBeNull();
  });

  it('paso a REPORTABLE: la tarifa base rige desde tarifa_desde (día 1 del mes siguiente)', () => {
    const f = { ...base, tarifa_pct: 2, tarifa_desde: '2026-12-01' };
    expect(liquidarMes(f, '2026-11', 19)!.pct).toBe(2.5);
    expect(liquidarMes(f, '2026-12', 19)).toMatchObject({ pct: 2, tarifa: 40_000 });
  });

  it('terminado: causa hasta el mes de la terminación', () => {
    const f = { ...base, terminado_en: '2027-02-10T17:00:00Z' };
    expect(liquidarMes(f, '2027-02', 19)!.tarifa).toBe(50_000);
    expect(liquidarMes(f, '2027-03', 19)).toBeNull();
  });
});

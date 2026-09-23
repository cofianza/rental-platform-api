import { describe, it, expect } from 'vitest';
import { esDiaHabil, festivosColombia, sumarDiasHabiles } from '../diasHabiles';

// Calendario oficial de festivos de Colombia (Ley 51 de 1983 + Semana Santa).
const FESTIVOS_2026 = [
  '2026-01-01', '2026-01-12', '2026-03-23', '2026-04-02', '2026-04-03', '2026-05-01',
  '2026-05-18', '2026-06-08', '2026-06-15', '2026-06-29', '2026-07-20', '2026-08-07',
  '2026-08-17', '2026-10-12', '2026-11-02', '2026-11-16', '2026-12-08', '2026-12-25',
];
const FESTIVOS_2027 = [
  '2027-01-01', '2027-01-11', '2027-03-22', '2027-03-25', '2027-03-26', '2027-05-01',
  '2027-05-10', '2027-05-31', '2027-06-07', '2027-07-05', '2027-07-20', '2027-08-07',
  '2027-08-16', '2027-10-18', '2027-11-01', '2027-11-15', '2027-12-08', '2027-12-25',
];

describe('festivosColombia', () => {
  it('2026 y 2027: los 18 del calendario oficial (trasladados al lunes y los de la Pascua)', () => {
    expect([...festivosColombia(2026)].sort()).toEqual(FESTIVOS_2026);
    expect([...festivosColombia(2027)].sort()).toEqual(FESTIVOS_2027);
  });
});

describe('esDiaHabil', () => {
  it('lunes a viernes que no son festivo', () => {
    expect(esDiaHabil('2026-09-23')).toBe(true); // miércoles
    expect(esDiaHabil('2026-09-26')).toBe(false); // sábado
    expect(esDiaHabil('2026-09-27')).toBe(false); // domingo
    expect(esDiaHabil('2026-10-12')).toBe(false); // lunes festivo
  });
});

describe('sumarDiasHabiles', () => {
  it.each([
    ['2026-09-23', 5, '2026-09-30'], // miércoles: cruza un fin de semana
    ['2026-10-09', 5, '2026-10-19'], // viernes antes del lunes festivo 12
    ['2026-03-31', 5, '2026-04-09'], // Semana Santa
    ['2026-12-24', 3, '2026-12-30'], // Navidad
    ['2026-12-30', 3, '2027-01-05'], // cambio de año con el 1.º de enero
    ['2026-09-26', 1, '2026-09-28'], // desde un sábado, el lunes
  ])('%s + %i hábiles = %s', (desde, n, esperado) => {
    expect(sumarDiasHabiles(desde, n)).toBe(esperado);
  });
});

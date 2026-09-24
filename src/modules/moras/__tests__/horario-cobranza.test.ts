import { describe, it, expect } from 'vitest';
import { siguienteMomentoPermitido, momentoDeCobro } from '../horario-cobranza';

// Ley 2300 de 2023: L-V 7 a. m.-7 p. m., sábados 8 a. m.-3 p. m., sin domingos
// ni festivos; una gestión por día. Horas en Colombia (UTC-5).
const co = (fechaHora: string) => new Date(`${fechaHora}:00-05:00`);

describe('siguienteMomentoPermitido', () => {
  it('dentro de la franja sale ya', () => {
    expect(siguienteMomentoPermitido(co('2026-09-28T10:00'))).toEqual(co('2026-09-28T10:00')); // lunes
    expect(siguienteMomentoPermitido(co('2026-09-26T14:59'))).toEqual(co('2026-09-26T14:59')); // sábado
  });

  it('antes de abrir espera la apertura; al cerrar pasa al día siguiente', () => {
    expect(siguienteMomentoPermitido(co('2026-09-28T06:59'))).toEqual(co('2026-09-28T07:00'));
    expect(siguienteMomentoPermitido(co('2026-09-28T19:00'))).toEqual(co('2026-09-29T07:00'));
    expect(siguienteMomentoPermitido(co('2026-09-25T20:00'))).toEqual(co('2026-09-26T08:00')); // viernes → sábado 8
  });

  it('se salta domingos y festivos', () => {
    // Sábado 15:00 → domingo no, lunes 12-oct festivo → martes 7:00.
    expect(siguienteMomentoPermitido(co('2026-10-10T15:00'))).toEqual(co('2026-10-13T07:00'));
    // Jueves de noche → viernes 25-dic festivo → sábado 8:00.
    expect(siguienteMomentoPermitido(co('2026-12-24T20:00'))).toEqual(co('2026-12-26T08:00'));
  });
});

describe('momentoDeCobro', () => {
  it('una sola gestión por día al mismo deudor', () => {
    expect(momentoDeCobro(co('2026-09-29T10:00'), co('2026-09-29T07:30'))).toEqual(co('2026-09-30T07:00'));
    expect(momentoDeCobro(co('2026-09-29T10:00'), co('2026-09-28T18:00'))).toEqual(co('2026-09-29T10:00'));
    expect(momentoDeCobro(co('2026-09-29T10:00'), null)).toEqual(co('2026-09-29T10:00'));
  });
});

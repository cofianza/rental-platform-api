import { describe, it, expect } from 'vitest';
import { siguienteMomentoPermitido, momentoDeCobro, DIAS_ENTRE_COBROS_WHATSAPP } from '../horario-cobranza';

// Ley 2300 de 2023: L-V 7 a. m.-7 p. m., sábados 8 a. m.-3 p. m., sin domingos
// ni festivos; 7 días entre dos WhatsApp de cobro. Horas en Colombia (UTC-5).
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
  it('al menos 7 días entre dos WhatsApp de cobro (Ley 2300 art. 3)', () => {
    expect(DIAS_ENTRE_COBROS_WHATSAPP).toBe(7);
    expect(momentoDeCobro(co('2026-09-29T10:00'), co('2026-09-29T07:30'))).toEqual(co('2026-10-06T07:30'));
    expect(momentoDeCobro(co('2026-09-25T10:00'), co('2026-09-21T10:00'))).toEqual(co('2026-09-28T10:00')); // día 4 → día 7
    expect(momentoDeCobro(co('2026-09-29T10:00'), co('2026-09-22T09:59'))).toEqual(co('2026-09-29T10:00'));
    expect(momentoDeCobro(co('2026-09-29T10:00'), null)).toEqual(co('2026-09-29T10:00'));
  });

  it('si el séptimo día cae en domingo o festivo, corre al siguiente momento permitido', () => {
    // Un cobro de domingo (anterior a la franja) → el domingo siguiente no: lunes 7:00.
    expect(momentoDeCobro(co('2026-09-22T10:00'), co('2026-09-20T10:00'))).toEqual(co('2026-09-28T07:00'));
    // Lunes 12-oct festivo → martes 7:00.
    expect(momentoDeCobro(co('2026-10-08T10:00'), co('2026-10-05T10:00'))).toEqual(co('2026-10-13T07:00'));
    // Jueves y Viernes Santo 2027 → sábado 8:00.
    expect(momentoDeCobro(co('2027-03-20T10:00'), co('2027-03-18T10:00'))).toEqual(co('2027-03-27T08:00'));
    // Sábado a las 16:00 + 7 → cerró el sábado, domingo no: lunes 7:00.
    expect(momentoDeCobro(co('2026-09-22T10:00'), co('2026-09-19T16:00'))).toEqual(co('2026-09-28T07:00'));
  });
});

import { describe, expect, it } from 'vitest';
import { esNombrePersona, sinEnlaces } from '../textoSinEnlaces';

describe('textoSinEnlaces', () => {
  it.each(['María José', "O'Neil", 'O’Neil', 'J.R.', 'Ana-María', 'Núñez Peña'])('«%s» es un nombre', (v) => {
    expect(esNombrePersona(v)).toBe(true);
  });

  it.each([
    'www.cofianza-pagos.co',
    'Entra a pagos-cofianza.co ya',
    'pago-seguro.info',
    'FALSO．CO',
    'falso。app',
    'is.gd/x',
    'hxxps://falso.xyz',
    '<b>Ana</b>',
    'Ana 123',
    "'Ana",
  ])('«%s» no es un nombre', (v) => {
    expect(esNombrePersona(v)).toBe(false);
  });

  it('un mensaje con horas, números o iniciales pasa; uno con dominio no', () => {
    expect(sinEnlaces('Puedo de 8 a.m a 5 p.m, apto No.301 Torre 2')).toBe(true);
    expect(sinEnlaces('Mira reserva.click antes')).toBe(false);
    expect(sinEnlaces('https://x')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { numeroALetras, numeroAPesosLetras } from '@/lib/numerosEnLetras';
import { FORMATOS, mayus, ordinal, sumarMeses, titulo } from '../formato';

// ============================================================
// Formatos del motor V3 (diseño §8.1). Lo que sale de aquí se imprime tal
// cual en el contrato: un ordinal o una cifra en letras mal escritos es un
// contrato mal numerado o una suma que no cuadra con la cifra.
// ============================================================

const f = (fmt: string, v: string | number) => (FORMATOS[fmt].fn as (x: string | number) => string)(v);

describe('ordinal', () => {
  it.each([
    [1, 'primera', 'primero', 'PRIMERA', 'Primera'],
    [10, 'décima', 'décimo', 'DÉCIMA', 'Décima'],
    [11, 'décima primera', 'décimo primero', 'DÉCIMA PRIMERA', 'Décima Primera'],
    [20, 'vigésima', 'vigésimo', 'VIGÉSIMA', 'Vigésima'],
    [21, 'vigésima primera', 'vigésimo primero', 'VIGÉSIMA PRIMERA', 'Vigésima Primera'],
    [33, 'trigésima tercera', 'trigésimo tercero', 'TRIGÉSIMA TERCERA', 'Trigésima Tercera'],
    [34, 'trigésima cuarta', 'trigésimo cuarto', 'TRIGÉSIMA CUARTA', 'Trigésima Cuarta'],
    [45, 'cuadragésima quinta', 'cuadragésimo quinto', 'CUADRAGÉSIMA QUINTA', 'Cuadragésima Quinta'],
  ])('%i → %s', (n, fem, masc, may, tit) => {
    expect(ordinal(n)).toBe(fem);
    expect(ordinal(n, 'o')).toBe(masc);
    expect(mayus(ordinal(n))).toBe(may);
    expect(titulo(ordinal(n))).toBe(tit);
  });

  it('1..59 son todos distintos; 0, 60 y no enteros lanzan', () => {
    const todos = Array.from({ length: 59 }, (_, i) => ordinal(i + 1));
    expect(new Set(todos).size).toBe(59);
    expect(() => ordinal(0)).toThrow(RangeError);
    expect(() => ordinal(60)).toThrow(RangeError);
    expect(() => ordinal(1.5)).toThrow(RangeError);
  });
});

describe('numeroALetras (apócope)', () => {
  it('21.000, 21.000.000 y 1.521.000', () => {
    expect(numeroALetras(21_000)).toBe('veintiún mil');
    expect(numeroALetras(21_000_000)).toBe('veintiún millones');
    expect(numeroALetras(1_521_000)).toBe('un millón quinientos veintiún mil');
  });

  it('lo que ya salía bien sigue igual (callers V4)', () => {
    expect(numeroALetras(21)).toBe('veintiuno');
    expect(numeroALetras(31_000)).toBe('treinta y un mil');
    expect(numeroALetras(101_000)).toBe('ciento un mil');
    expect(numeroALetras(1_000_000)).toBe('un millón');
    expect(numeroALetras(2_500_000)).toBe('dos millones quinientos mil');
    expect(numeroAPesosLetras(21_000)).toBe('VEINTIÚN MIL PESOS M/CTE');
  });

  it('pesos en letras: "de" tras millones exactos y apócope ante "pesos"', () => {
    expect(numeroAPesosLetras(2_000_000)).toBe('DOS MILLONES DE PESOS M/CTE');
    expect(numeroAPesosLetras(1_000_000)).toBe('UN MILLÓN DE PESOS M/CTE');
    expect(numeroAPesosLetras(2_500_000)).toBe('DOS MILLONES QUINIENTOS MIL PESOS M/CTE');
    expect(numeroAPesosLetras(1_021)).toBe('MIL VEINTIÚN PESOS M/CTE');
  });
});

describe('FORMATOS', () => {
  it('pctLetras: 2,5 y 2,05, sin apócope', () => {
    expect(f('pctLetras', 2.5)).toBe('dos coma cinco');
    expect(f('pctLetras', 2.05)).toBe('dos coma cero cinco');
    expect(f('pctLetras', 30)).toBe('treinta');
    expect(f('pctLetras', 21)).toBe('veintiuno');
  });

  it('letras y diaLetras con apócope', () => {
    expect(f('letras', 21)).toBe('veintiún');
    expect(f('letras', 31)).toBe('treinta y un');
    expect(f('diaLetras', '2026-10-21')).toBe('veintiún');
    expect(f('meses', 12)).toBe('doce (12) meses');
  });

  it('fechas', () => {
    expect(f('fecha', '2026-10-01')).toBe('1 de octubre de 2026');
    expect([f('dia', '2026-10-01'), f('mes', '2026-10-01'), f('anio', '2026-10-01')]).toEqual(['1', 'octubre', '2026']);
    expect(() => f('fecha', '2026-02-30')).toThrow(RangeError);
    expect(() => f('fecha', '2026-10-01T00:00:00Z')).toThrow(RangeError);
  });

  it('dd2 y mm2: el dd/mm/aaaa del cuadro del Anexo va a dos dígitos', () => {
    expect([f('dd2', '2026-10-01'), f('mm2', '2026-10-01')]).toEqual(['01', '10']);
    expect([f('dd2', '2027-09-15'), f('mm2', '2027-09-15')]).toEqual(['15', '09']);
    expect(() => f('dd2', '2026-02-30')).toThrow(RangeError);
  });

  it('pesos y pct se leen de vuelta con inverso; lo que no tiene la forma da NaN', () => {
    expect(f('pesos', 2_500_000)).toBe('2.500.000');
    expect(FORMATOS.pesos.inverso!('2.500.000')).toBe(2_500_000);
    expect(FORMATOS.pesos.inverso!('2.500.00')).toBeNaN();
    expect(f('pct', 2.5)).toBe('2,5');
    expect(FORMATOS.pct.inverso!('2,5')).toBe(2.5);
    expect(FORMATOS.pct.inverso!('2,05')).toBe(2.05);
    expect(FORMATOS.pct.inverso!('2.5')).toBeNaN();
  });

  it('documentos; un tipo desconocido lanza y la tabla no tiene prototipo', () => {
    expect(f('doc', 'ce')).toBe('C.E.');
    expect(f('docLargo', 'ce')).toBe('cédula de extranjería');
    expect(() => f('doc', 'xx')).toThrow(RangeError);
    expect('toString' in FORMATOS).toBe(false);
  });
});

describe('sumarMeses (art. 67 C.C.)', () => {
  it('mismo número de día, recortado al último día del mes', () => {
    expect(sumarMeses('2026-01-31', 1)).toBe('2026-02-28');
    expect(sumarMeses('2026-10-01', 12)).toBe('2027-10-01');
    expect(sumarMeses('2027-11-30', 3)).toBe('2028-02-29');
  });
});

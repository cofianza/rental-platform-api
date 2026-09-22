import { describe, it, expect } from 'vitest';
import { AppError } from '@/lib/errors';
import type { CodigoHallazgo } from '../asistente.types';
import {
  CATALOGO,
  REGLAS,
  campos,
  huella,
  llenar,
  plegar,
  shaClausula,
  validarClausula,
  type Destinacion,
  type OpcionesValidacion,
} from '../clausulas.reglas';
import { CASOS } from './clausulas.casos';

// ============================================================
// Reglas de las cláusulas adicionales (Entrega 4, diseño §6 y §8): la tabla
// de ejemplos ✗/✓, estructurales (imprimible, coarrendatario, campos), avisos,
// catálogo, huellas y un texto adversario de 4.000 caracteres en < 50 ms.
// ============================================================

const TITULO = 'Obligaciones especiales';
const V: OpcionesValidacion = { destinacion: 'vivienda', sinCoarrendatario: false };
const validar = (texto: string, o: Partial<OpcionesValidacion> = {}, titulo = TITULO) =>
  validarClausula({ titulo, texto }, { ...V, ...o });
const codigos = (texto: string, o: Partial<OpcionesValidacion> = {}) =>
  validar(texto, o).hallazgos.map((h) => h.codigo);

// Tabla §8: ✗ debe bloquear con ese código; ✓ no debe traer ningún hallazgo.
const TABLA: Record<string, { bloquea: string[]; pasa: string[] }> = {
  deposito: {
    bloquea: [
      'Entregará un depósito de dos cánones que se devolverá',
      'Como garantía consignará $2.000.000',
      'Pagará dos meses por adelantado',
      'Entregará un cheque en garantía',
      'Constituirá prenda sobre un CDT como respaldo',
    ],
    pasa: ['Usará el cuarto útil o depósito número 12', 'El canon se pagará mediante depósito en la cuenta de recaudo'],
  },
  mascotas: {
    bloquea: [
      'No se permiten mascotas',
      'Solo podrá tener mascotas con autorización previa',
      'Se admite máximo una mascota',
      'Cada mascota pagará un valor adicional',
      'La tenencia de perros será causal de terminación',
      'No se permiten mascotas ni la cría de animales',
    ],
    pasa: [
      'Responderá por daños y multas que causen sus mascotas',
      'La tenencia de mascotas, por sí sola, no constituye causal de terminación',
      'Al terminar el contrato fumigará si convivió con mascotas',
      'No se permite la cría ni venta de animales',
    ],
  },
  incremento: {
    bloquea: [
      'El canon se incrementará en el IPC más tres puntos',
      'El canon se reajustará cada seis meses',
      'El canon subirá un 8 % anual',
    ],
    pasa: [
      'Cada doce meses el canon se reajustará hasta el 100 % del IPC',
      'La administración se ajustará según la asamblea',
    ],
  },
  fianza: {
    bloquea: [
      'La fianza de Cofianza cubrirá la administración',
      'La cobertura se amplía a 24 cánones',
      'No informará a COFIANZA los pagos',
    ],
    pasa: ['Seguro de hogar con cobertura contra incendio', 'Solo entregará llaves a una persona de confianza'],
  },
  renuncia: {
    bloquea: [
      'Renuncia a exigir reparaciones',
      'EL ARRENDATARIO renuncia al preaviso y a la indemnización',
      'Se obliga a no presentar reclamaciones',
      'Renuncia a los requerimientos y al preaviso',
    ],
    pasa: [
      'EL ARRENDATARIO renuncia a los requerimientos privados y judiciales para constituirlo en mora',
      'EL ARRENDADOR renuncia a cobrar intereses los primeros 5 días',
    ],
  },
  terminacion: {
    bloquea: [
      'El arrendador podrá dar por terminado el contrato si hay visitas nocturnas',
      'El incumplimiento de esta cláusula será causal de terminación',
      'Preaviso de un (1) mes',
      'La vigencia del contrato será de seis meses',
      'No se prorrogará',
    ],
    pasa: [
      'Al terminar el contrato entregará el inmueble pintado',
      'Durante la vigencia y sus prórrogas mantendrá el jardín',
      'Tener visitas no será causal de terminación',
    ],
  },
  tenencia: {
    bloquea: [
      'Si hay mora, EL ARRENDADOR podrá cambiar las guardas',
      'EL ARRENDADOR podrá suspender los servicios',
      'Podrá retirar los enseres sin orden judicial',
      'Se procederá a desalojar',
    ],
    pasa: [
      'EL ARRENDATARIO no podrá cambiar las guardas sin autorización',
      'EL ARRENDATARIO asumirá el cambio de chapas dañadas',
      'La empresa podrá suspender el servicio por falta de pago del arrendatario',
      'A falta de entrega voluntaria EL ARRENDADOR iniciará el proceso del art. 384 del C.G.P.',
    ],
  },
  modifica_contrato: {
    bloquea: ['La cláusula de restitución queda sin efecto', 'Esta cláusula prevalece sobre lo pactado'],
    pasa: [
      'Cualquier modificación a este contrato constará por escrito',
      'No podrá hacer modificaciones al inmueble durante este contrato',
    ],
  },
};

const plano = (texto: string, titulo = TITULO) => `${titulo}. ${texto}`;

describe('tabla de ejemplos (§8)', () => {
  const bloquea = Object.entries(TABLA).flatMap(([c, t]) => t.bloquea.map((x) => [c, x] as const));
  const pasa = Object.entries(TABLA).flatMap(([c, t]) => t.pasa.map((x) => [c, x] as const));

  it.each(bloquea)('%s ✗ «%s»', (codigo, texto) => {
    const r = validar(texto);
    expect(r.hallazgos.map((h) => h.codigo)).toContain(codigo);
    for (const h of r.hallazgos) {
      expect(h.fuente).toBe('reglas');
      expect(h.fragmento).toBeTruthy();
      expect(plano(texto)).toContain(h.fragmento);
      expect(h.fragmento!.length).toBeLessThanOrEqual(200);
    }
  });

  it.each(pasa)('%s ✓ «%s»', (_codigo, texto) => {
    expect(validar(texto).hallazgos).toEqual([]);
  });

  it('no_imprimible / coarrendatario ✗', () => {
    expect(codigos('Valor: XXX')).toEqual(['no_imprimible']);
    expect(codigos('Entregará el dep­ósito')).toEqual(['no_imprimible']);
    expect(codigos('EL COARRENDATARIO responde solidariamente', { sinCoarrendatario: true })).toEqual([
      'coarrendatario',
    ]);
  });

  it('cada código sale una sola vez y los estructurales van primero', () => {
    const r = validar('Valor XXX. No se permiten mascotas. Tampoco se permiten gatos.', { sinCoarrendatario: true });
    expect(r.hallazgos.map((h) => h.codigo)).toEqual(['no_imprimible', 'mascotas']);
    expect(r.hallazgos[1].fragmento).toBe('No se permiten mascotas');
  });

  it('el fragmento del título también es literal', () => {
    const r = validarClausula({ titulo: 'Prórroga', texto: 'No se prorrogará el contrato.' }, V);
    expect(r.hallazgos.map((h) => h.codigo)).toEqual(['terminacion']);
    expect(r.hallazgos[0].fragmento).toBe('No se prorrogará');
  });
});

describe('ajustes a la tabla §6 (falsos positivos evitados)', () => {
  it.each([
    'En el término de tres días hábiles reparará los daños que cause',
    'El seguro del ARRENDATARIO tendrá cobertura contra incendio y terremoto',
    'Esta cláusula quedará sin efecto si EL ARRENDATARIO vende su vehículo',
    'Entregará el depósito N° 12 limpio y ordenado',
    'El canon incluye la cuota de administración, que se reajustará cada doce meses hasta el cien por ciento (100 %) del IPC',
  ])('✓ «%s»', (texto) => {
    expect(validar(texto).hallazgos).toEqual([]);
  });

  it.each([
    ['deposito', 'Entregará un depósito de 2.000.000 como garantía'],
    ['incremento', 'El canon se reajustará en el 105 % del IPC'],
    ['modifica_contrato', 'Se modifica la cláusula de restitución'],
    ['tenencia', 'EL ARRENDADOR podrá desalojar al arrendatario por su propia cuenta'],
  ] as const)('%s ✗ «%s»', (codigo, texto) => {
    expect(codigos(texto)).toContain(codigo);
  });
});

describe('corpus de la revisión adversaria', () => {
  it.each(CASOS)('%s «%s» %s', (codigo, texto, titulo = TITULO) => {
    const r = validarClausula({ titulo, texto }, V);
    if (codigo) expect(r.hallazgos.map((h) => h.codigo)).toContain(codigo);
    else expect(r.hallazgos).toEqual([]);
  });
});

describe('plegar', () => {
  it('conserva la longitud (emoji, ligadura «ﬁ», tildes)', () => {
    for (const s of ['😀 ﬁn', 'Ñandú ﬁ 😀😀 x', 'dep­ósito', 'ÁÉÍÓÚ Ü ñ «»', ''])
      expect(plegar(s).length).toBe(s.length);
    expect(plegar('ÁÉÍÓÚ Ñ $5%')).toBe('aeiou n $5%');
    expect(plegar('ﬁ')).toBe('f');
  });
});

describe('estructurales', () => {
  it.each([
    ['guion suave', 'Entregará el dep­ósito'],
    ['espacio de ancho cero', 'Pagará el​canon puntualmente'],
    ['cirílico', 'Pagará el depоsito puntualmente'],
    ['llaves', 'Pagará el {campo} puntualmente'],
    ['emoji', 'Cuidará el jardín 🌱 del inmueble'],
    ['NO APLICA', 'Parqueadero: NO APLICA'],
  ])('no_imprimible: %s', (_n, texto) => {
    const r = validar(texto);
    expect(r.hallazgos[0].codigo).toBe('no_imprimible');
    expect(plano(texto)).toContain(r.hallazgos[0].fragmento);
  });

  it('el título se juzga como se imprime (en mayúsculas): «no aplica» es NO APLICA', () => {
    const r = validar('EL ARRENDATARIO recibirá visitas en horario diurno.', {}, 'Visitas: no aplica');
    expect(r.hallazgos.map((h) => h.codigo)).toEqual(['no_imprimible']);
    expect(r.hallazgos[0].fragmento).toBe('Visitas: no aplica');
    expect(validar('EL ARRENDATARIO recibirá visitas en horario diurno.', {}, 'Visitas').hallazgos).toEqual([]);
  });

  it('[[campo]] solo en la biblioteca; más de 10 campos no', () => {
    const texto = 'Se le asigna el parqueadero número [[número del parqueadero]] del conjunto.';
    expect(codigos(texto)).toEqual(['no_imprimible']);
    expect(codigos(texto, { biblioteca: true })).toEqual([]);
    expect(codigos('Se le asigna el parqueadero [[ ]] del conjunto.', { biblioteca: true })).toEqual(['no_imprimible']);
    expect(codigos('Se le asigna el parqueadero [[a{b]] del conjunto.', { biblioteca: true })).toEqual([
      'no_imprimible',
    ]);
    const n = (k: number) =>
      'Datos: ' + Array.from({ length: k }, (_, i) => `[[dato ${String.fromCharCode(97 + i)}]]`).join(', ') + '.';
    expect(codigos(n(10), { biblioteca: true })).toEqual([]);
    const r = validar(n(11), { biblioteca: true });
    expect(r.hallazgos.map((h) => h.codigo)).toEqual(['no_imprimible']);
    expect(r.hallazgos[0].fragmento).toBe('[[dato k]]');
    // en el título nunca: no se llena
    expect(validar('Texto sin campos, veinte o más.', { biblioteca: true }, 'Parqueadero [[n]]').hallazgos[0].codigo).toBe(
      'no_imprimible',
    );
  });

  it('coarrendatario solo cuando el contrato no lo tiene', () => {
    const texto = 'EL COARRENDATARIO responde solidariamente';
    expect(codigos(texto, { sinCoarrendatario: true })).toEqual(['coarrendatario']);
    expect(codigos(texto, { sinCoarrendatario: false })).toEqual([]);
    expect(validar(texto, { sinCoarrendatario: true }).hallazgos[0].fragmento).toBe('COARRENDATARIO');
  });

  it('cita_numero va a avisos, no a hallazgos', () => {
    const r = validar('EL ARRENDATARIO cumplirá lo previsto en la cláusula 12 respecto del parqueadero.');
    expect(r.hallazgos).toEqual([]);
    expect(r.avisos.map((a) => a.codigo)).toEqual(['cita_numero']);
    expect(r.avisos[0].fragmento).toBe('cláusula 12');
    expect(validar('Según el parágrafo segundo de la cláusula penal.').avisos).toHaveLength(1);
    expect(validar('Según la cláusula penal del contrato.').avisos).toEqual([]);
  });
});

describe('catálogo y reglas', () => {
  const JURIDICOS: CodigoHallazgo[] = [
    'deposito', 'mascotas', 'incremento', 'fianza', 'renuncia', 'terminacion', 'tenencia', 'modifica_contrato',
  ];

  it('toda entrada tiene etiqueta y mensaje; los jurídicos, norma', () => {
    for (const [k, e] of Object.entries(CATALOGO)) {
      expect(e.codigo).toBe(k);
      expect(e.etiqueta.trim()).not.toBe('');
      expect(e.mensaje.trim()).not.toBe('');
      if (JURIDICOS.includes(e.codigo)) expect(e.norma?.trim()).toBeTruthy();
      else expect(e.norma).toBeNull();
    }
  });

  it('vivienda tiene reglas; una destinación sin reglas falla cerrada', () => {
    expect(REGLAS.vivienda?.map((r) => r.hallazgo.codigo)).toEqual(JURIDICOS);
    try {
      validarClausula({ titulo: 'x', texto: 'y' }, { ...V, destinacion: 'comercial' as Destinacion });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(500);
      expect((e as AppError).errorCode).toBe('CLAUSULAS_SIN_REGLAS');
    }
  });
});

describe('campos, llenar y huellas', () => {
  it('campos únicos en orden; llenar literal', () => {
    expect(campos('[[b]] y [[a]] y [[b]] y [[ c]] y [[]]')).toEqual(['b', 'a']);
    expect(llenar('[[a]]-[[b]]-[[c]]', { a: '1', b: '$&' })).toBe('1-$&-[[c]]');
    expect(llenar('[[constructor]]', {})).toBe('[[constructor]]');
  });

  it('huella depende del orden; shaClausula es estable', () => {
    const a = { titulo: 'A', texto: 'uno' };
    const b = { titulo: 'B', texto: 'dos' };
    expect(huella([a, b])).not.toBe(huella([b, a]));
    expect(huella([a, b])).toMatch(/^[0-9a-f]{64}$/);
    expect(shaClausula(a)).toBe(shaClausula({ ...a }));
    expect(shaClausula(a)).not.toBe(shaClausula(b));
  });
});

describe('rendimiento', () => {
  const rep = (s: string) => s.repeat(Math.ceil(4000 / s.length)).slice(0, 4000);
  const ADVERSARIOS = [
    rep('a;'),
    rep('a '),
    rep('. A'),
    rep('$'),
    rep('deposito '),
    rep('garantia '),
    rep('EL ARRENDADOR renuncia '),
    rep('el canon se incrementara 8 % 100 % del '),
    rep('perro no se prohibe '),
    rep('modificar la clausula del inmueble '),
    rep('no podra cambiar '),
    rep('causal de terminacion no sera '),
    rep('dos meses '),
    rep('😀'),
    rep('[['),
  ];

  // Mejor de tres: lo que se vigila es el backtracking catastrofico (segundos),
  // no el ruido de la maquina cuando la suite corre en paralelo.
  it('4.000 caracteres adversarios en < 50 ms cada uno', () => {
    validar('Calentamiento: EL ARRENDADOR renuncia al preaviso.');
    for (const texto of ADVERSARIOS) {
      const medidas = [0, 1, 2].map(() => {
        const t0 = performance.now();
        validar(texto, { sinCoarrendatario: true });
        return performance.now() - t0;
      });
      expect(Math.min(...medidas)).toBeLessThan(50);
    }
  });
});

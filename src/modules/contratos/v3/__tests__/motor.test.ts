import { describe, it, expect } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  asientosDeHtml,
  htmlATexto,
  inventarioSupresiones,
  lineaDeSegmentos,
  parsearPlantilla,
  renderizar,
  verificarCoherencia,
  verificarSinMarcadores,
  type Contexto,
  type DefPlantilla,
  type Resultado,
} from '../motor';

// ============================================================
// Motor de plantillas V3 (diseño §8.2) sobre plantillas sintéticas: parser,
// numeración, borradores, modo final, escape y coherencia de cifras. La
// plantilla real de vivienda se prueba en fidelidad.test.ts y vivienda.test.ts.
// ============================================================

const DEF: DefPlantilla = {
  codigo: 'prueba',
  partes: ['prueba.txt'],
  campos: {
    nombre: 'texto',
    canon: 'numero',
    prima: 'numero',
    primaPct: 'numero',
    comision: 'numero',
    total: 'numero',
    fecha: 'fecha',
    'parte.nombre': 'texto',
  },
  cifras: ['canon', 'prima', 'primaPct', 'comision', 'total'],
  condiciones: ['x', 'y', 'coa', 'parte.cc'],
  roles: ['coarrendatario'],
};

const plantilla = (...lineas: string[]) =>
  parsearPlantilla(DEF, { 'prueba.txt': lineas.join('\n') });

const persona = (nombre: string, cc = true) => ({
  condiciones: { 'parte.cc': cc },
  valores: { 'parte.nombre': nombre },
});

function ctx(
  condiciones: Record<string, boolean> = {},
  valores: Record<string, string | number> = {},
  coas = [persona('Luis')],
): Contexto {
  return {
    condiciones: { x: true, y: true, coa: coas.length > 0, ...condiciones },
    valores: {
      nombre: 'Ana Pérez',
      canon: 2500000,
      primaPct: 2.5,
      prima: 62500,
      comision: 62500,
      total: 2562500,
      fecha: '2026-10-01',
      ...valores,
    },
    roles: { coarrendatario: coas },
  };
}

const revisar = (
  p: ReturnType<typeof plantilla>,
  c = ctx(),
  o: Parameters<typeof renderizar>[2] = { modo: 'revision' },
) => renderizar(p, c, { aprobados: {}, ...o });
const textos = (r: Resultado) => r.lineas.map((l) => l.texto);

/** errorCode (y mensaje) del AppError que lanza fn; undefined si no lanza. */
function falla(fn: () => unknown): { code: string; message: string; details: unknown } | undefined {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { code: e.errorCode, message: e.message, details: e.details };
  }
  return undefined;
}

describe('parser: rechazos (PLANTILLA_INVALIDA con archivo:línea)', () => {
  const invalida = (...lineas: string[]) => falla(() => plantilla(...lineas));

  it.each([
    ['cláusula con ordinal literal', ['@clausula a', '**{N}: A.** Ver la Cláusula Cuarta.']],
    ['parágrafo con ordinal literal', ['@clausula a', '**{N}: A.** Ver el parágrafo segundo.']],
    ['cabecera con ordinal literal', ['@clausula a', '**PRIMERA: A.** texto']],
    ['PARÁGRAFO literal', ['@clausula a', '**{N}: A.** texto', '> **PARÁGRAFO — USOS:** texto']],
    ['campo desconocido', ['Hola {apellido}']],
    ['condición desconocida', ['?z Hola']],
    ['condición desconocida en [[ ]]', ['Hola [[z: a | ]]']],
    ['formato desconocido', ['Canon {plata:canon}']],
    ['formato de otro tipo', ['Fecha {pesos:fecha}']],
    ['número sin formato', ['Canon {canon}']],
    ['alternativa que no es vacía, PENDIENTE ni #id', ['Hola [[x: a | b]]']],
    ['?! sin #id ni PENDIENTE', ['?!x texto suelto']],
    ['[[ anidado', ['Hola [[x: a [[y: b | ]] | ]]']],
    ['cláusula duplicada', ['@clausula a', '**{N}: A**', '@clausula a', '**{N}: B**']],
    [
      'parágrafo duplicado',
      ['@clausula a', '**{N}: A**', '> **{P:uso} — X:** a', '> **{P:uso} — Y:** b'],
    ],
    ['borrador duplicado', ['[[x: a | #b-1: uno]]', '[[y: b | #b-1: dos]]']],
    ['referencia a cláusula desconocida', ['@clausula a', '**{N}: A.** ver {ref:b}']],
    ['referencia a parágrafo desconocido', ['@clausula a', '**{N}: A.** ver {ref:a/nada}']],
    ['{N} fuera de la cabecera', ['@clausula a', '**{N}: A**', 'Otra vez {N}']],
    ['@clausula sin cabecera {N}', ['@clausula a', 'texto']],
    ['{P:} fuera de una cláusula', ['> **{P:x} — X:** texto']],
    ['prefijo desconocido', ['>>> texto']],
    ['directiva desconocida', ['@tabla']],
    ['@fin sin bloque', ['@fin']],
    ['bloque sin @fin', ['@cuadro', 'a | b']],
    ['rol desconocido', ['@cada fiador', '@fin']],
    ['parte.* fuera de @cada', ['Hola {parte.nombre}']],
    ['** sin cerrar', ['**Hola']],
  ])('%s', (_caso, lineas) => {
    const e = invalida(...lineas);
    expect(e?.code).toBe('PLANTILLA_INVALIDA');
    expect(e?.message).toMatch(/^prueba\.txt:\d+: /);
  });

  it('señala el archivo y la línea', () => {
    expect(invalida('Hola', '', '# comentario', 'Canon {plata:canon}')?.message).toMatch(
      /^prueba\.txt:4: /,
    );
  });

  it('@nota-editorial puede nombrar ordinales; las menciones sin ordinal quedan literales', () => {
    expect(() =>
      plantilla(
        '@clausula a',
        '**{N}: A.** Lo dispuesto en la presente cláusula y en este parágrafo.',
        '@adicionales CLÁUSULAS ADICIONALES',
        '@nota-editorial Se numeran a partir de la cláusula TRIGÉSIMA CUARTA.',
      ),
    ).not.toThrow();
  });
});

describe('numeración', () => {
  const tres = plantilla(
    '@clausula a',
    '**{N}: A.** Ver {ref:c}.',
    '?y @clausula b',
    '**{N}: B.** Texto.',
    '@clausula c',
    '**{N}: C.** Ver {ref:a}.',
  );

  it('quitar una cláusula del medio renumera las siguientes y sus referencias', () => {
    expect(textos(revisar(tres))).toEqual([
      '**PRIMERA: A.** Ver Cláusula Tercera.',
      '**SEGUNDA: B.** Texto.',
      '**TERCERA: C.** Ver Cláusula Primera.',
    ]);
    const r = revisar(tres, ctx({ y: false }));
    expect(textos(r)).toEqual([
      '**PRIMERA: A.** Ver Cláusula Segunda.',
      '**SEGUNDA: C.** Ver Cláusula Primera.',
    ]);
    expect(r.refs).toEqual([
      { origen: 'a', destino: 'c', texto: 'Cláusula Segunda' },
      { origen: 'c', destino: 'a', texto: 'Cláusula Primera' },
    ]);
    expect(r.lineas.map((l) => l.kind)).toEqual(['p', 'p']);
    expect(r.html).toContain('class="k-p inicio"');
  });

  it('una referencia a una cláusula suprimida lanza', () => {
    const p = plantilla(
      '@clausula a',
      '**{N}: A.** Ver {ref:b}.',
      '?y @clausula b',
      '**{N}: B.** Texto.',
    );
    expect(falla(() => revisar(p, ctx({ y: false })))?.code).toBe(
      'PLANTILLA_REFERENCIA_A_SUPRIMIDA',
    );
  });

  const parrafos = plantilla(
    '@clausula a',
    '**{N}: A**',
    '> **{P:uno} — UNO:** a',
    '?y > **{P:dos} — DOS:** b',
    '> Ver {ref:/uno} [[y: y el {ref:/dos} | ]] de esta cláusula.',
    '@clausula b',
    '**{N}: B.** Ver {ref:a/uno}.',
  );

  it('parágrafos numerados, y "PARÁGRAFO" cuando queda uno solo', () => {
    expect(textos(revisar(parrafos))).toEqual([
      '**PRIMERA: A**',
      '**PARÁGRAFO PRIMERO — UNO:** a',
      '**PARÁGRAFO SEGUNDO — DOS:** b',
      'Ver Parágrafo Primero y el Parágrafo Segundo de esta cláusula.',
      '**SEGUNDA: B.** Ver Parágrafo Primero de la Cláusula Primera.',
    ]);
    expect(textos(revisar(parrafos, ctx({ y: false })))).toEqual([
      '**PRIMERA: A**',
      '**PARÁGRAFO — UNO:** a',
      'Ver Parágrafo de esta cláusula.',
      '**SEGUNDA: B.** Ver Parágrafo de la Cláusula Primera.',
    ]);
  });

  it('numerales continuos a través de >> y reiniciados en {P:}; literales a), b)', () => {
    const p = plantilla(
      '@clausula a',
      '**{N}: A**',
      '+ uno',
      '>> sigue el uno',
      '?y + dos',
      '+ tres',
      '> **{P:p1} — X:** texto',
      '+ otra vez uno',
      '+a letra',
      '+a otra letra',
    );
    expect(revisar(p).lineas).toEqual([
      { kind: 'p', texto: '**PRIMERA: A**' },
      { kind: 'item', texto: '**1.** uno' },
      { kind: 'sangria2', texto: 'sigue el uno' },
      { kind: 'item', texto: '**2.** dos' },
      { kind: 'item', texto: '**3.** tres' },
      { kind: 'sangria', texto: '**PARÁGRAFO — X:** texto' },
      { kind: 'item', texto: '**1.** otra vez uno' },
      { kind: 'literal', texto: '**a)** letra' },
      { kind: 'literal', texto: '**b)** otra letra' },
    ]);
    expect(textos(revisar(p, ctx({ y: false }))).slice(1, 4)).toEqual([
      '**1.** uno',
      'sigue el uno',
      '**2.** tres',
    ]);
  });

  it('secciones {S}: solo cuentan las que sobreviven y las que llevan {S}', () => {
    const p = plantilla(
      '@bloque PRELIMINAR.  RESUMEN',
      '@seccion {S}.  Uno',
      '?coa @seccion {S}.  Coarrendatario',
      'texto del coarrendatario',
      '@seccion {S}.  Tres',
      '@seccion Sin número',
    );
    expect(textos(revisar(p))).toEqual([
      '**PRELIMINAR. RESUMEN**',
      '**1. Uno**',
      '**2. Coarrendatario**',
      'texto del coarrendatario',
      '**3. Tres**',
      '**Sin número**',
    ]);
    expect(textos(revisar(p, ctx({}, {}, [])))).toEqual([
      '**PRELIMINAR. RESUMEN**',
      '**1. Uno**',
      '**2. Tres**',
      '**Sin número**',
    ]);
  });

  const cada = plantilla(
    '@cuadro',
    '**Arrendatario** | {nombre}',
    '@cada coarrendatario',
    '**Coarrendatario** | {parte.nombre}, [[parte.cc: C.C. | #j-doc: otro documento]]',
    '@fin',
    '@fin',
    '@datos',
    'ARRENDATARIO',
    '@cada coarrendatario',
    'COARRENDATARIO {parte.nombre}',
    '@fin',
    '@fin',
    '@firma',
    '{linea}',
    '**EL ARRENDATARIO**',
    '{nombre}',
    '@fin',
    '@cada coarrendatario',
    '@firma',
    '{linea}',
    '**EL COARRENDATARIO**',
    '{parte.nombre}',
    '@fin',
    '@fin',
  );

  it('@cada con 0, 1 y 3 elementos', () => {
    expect(textos(revisar(cada, ctx({}, {}, [])))).toEqual([
      '**Arrendatario**',
      'Ana Pérez',
      'ARRENDATARIO',
      '**EL ARRENDATARIO** Ana Pérez',
    ]);
    expect(textos(revisar(cada, ctx({}, {}, [persona('Luis')])))).toEqual([
      '**Arrendatario**',
      'Ana Pérez',
      '**Coarrendatario**',
      'Luis, C.C.',
      'ARRENDATARIO',
      'COARRENDATARIO Luis',
      '**EL ARRENDATARIO** Ana Pérez',
      '**EL COARRENDATARIO** Luis',
    ]);
    const r = revisar(
      cada,
      ctx({}, {}, [persona('Luis'), persona('Eva', false), persona('Rosa', false)]),
    );
    expect(r.lineas.filter((l) => l.kind === 'firma').map((l) => l.texto)).toEqual([
      '**EL ARRENDATARIO** Ana Pérez',
      '**EL COARRENDATARIO** Luis',
      '**EL COARRENDATARIO** Eva',
      '**EL COARRENDATARIO** Rosa',
    ]);
    expect(r.lineas.filter((l) => l.kind === 'dato')).toHaveLength(4);
    expect(textos(r)).toContain('Rosa, otro documento');
    expect(r.pendientes).toEqual([{ id: 'j-doc', tipo: 'borrador' }]); // una sola vez aunque se repita
  });

  it('dos cláusulas adicionales siguen la numeración; sin adicionales no sale el título', () => {
    const p = plantilla(
      '@clausula a',
      '**{N}: A.** texto',
      '@adicionales CLÁUSULAS ADICIONALES DEL ARRENDADOR',
      '@nota-editorial Solo si hay adicionales.',
      '@bloque XI.  FIRMAS',
      'Fin.',
    );
    const adicionales = [
      { titulo: 'Uso del parqueadero', texto: 'El parqueadero <b>no</b> es cubierto.' },
      { titulo: 'Mascotas.', texto: 'Se permiten.' },
    ];
    const r = revisar(p, ctx(), { modo: 'revision', adicionales });
    expect(r.lineas).toEqual([
      { kind: 'p', texto: '**PRIMERA: A.** texto' },
      { kind: 'centrado', texto: '**CLÁUSULAS ADICIONALES DEL ARRENDADOR**' },
      {
        kind: 'p',
        texto: '**SEGUNDA: USO DEL PARQUEADERO.** El parqueadero <b>no</b> es cubierto.',
      },
      { kind: 'p', texto: '**TERCERA: MASCOTAS.** Se permiten.' },
      { kind: 'bloque', texto: '**XI. FIRMAS**' },
      { kind: 'p', texto: 'Fin.' },
    ]);
    expect(r.origenes.slice(1, 4)).toEqual(['prueba.txt:3', 'adicional:1', 'adicional:2']);
    expect(textos(revisar(p))).toEqual(['**PRIMERA: A.** texto', '**XI. FIRMAS**', 'Fin.']);
    // el Word trae el título y la nota editorial
    expect(renderizar(p, null, { modo: 'fidelidad' }).lineas.slice(1, 3)).toEqual([
      { kind: 'centrado', texto: '**CLÁUSULAS ADICIONALES DEL ARRENDADOR**' },
      { kind: 'nota', texto: '*Solo si hay adicionales.*' },
    ]);
    expect(
      falla(() => revisar(plantilla('Hola'), ctx(), { modo: 'revision', adicionales }))?.code,
    ).toBe('PLANTILLA_NO_SOPORTA');
  });
});

describe('modo fidelidad', () => {
  it('todo campo es ▢, toda condición es verdadera y @cada corre una vez', () => {
    const p = plantilla(
      '@pie Contrato de prueba',
      '@titulo CONTRATO DE PRUEBA',
      '@nota Ley 820 de 2003',
      '@cuadro',
      '**Canon** | ${pesos:canon}  ({pesosLetras:canon})',
      '@cada coarrendatario',
      '**Coarrendatario** | {parte.nombre}',
      '@fin',
      '**Propiedad horizontal** | SÍ {casilla:x}   NO {casilla:!x}',
      '@fin',
      '?!x PENDIENTE(b)',
      '@recuadro',
      '**Si paga de menos**',
      '- **Lo que hace:** paga.',
      '- Lo demás.',
      '@fin',
      'Carro[[y: , número {nombre} | ]]; moto.',
      '@firma',
      '{linea}',
      '**EL ARRENDATARIO**',
      'C.C. N° {nombre}',
      '@fin',
    );
    const r = renderizar(p, null, { modo: 'fidelidad' });
    expect(p.pie).toBe('Contrato de prueba');
    expect(r.lineas).toEqual([
      { kind: 'titulo', texto: '**CONTRATO DE PRUEBA**' },
      { kind: 'nota', texto: '*Ley 820 de 2003*' },
      { kind: 'celda', texto: '**Canon**' },
      { kind: 'celda', texto: '$▢ (▢)' },
      { kind: 'celda', texto: '**Coarrendatario**' },
      { kind: 'celda', texto: '▢' },
      { kind: 'celda', texto: '**Propiedad horizontal**' },
      { kind: 'celda', texto: 'SÍ ▢ NO ▢' },
      { kind: 'recuadro', texto: '**Si paga de menos**' },
      { kind: 'recuadro', texto: '**• Lo que hace:** paga.' },
      { kind: 'recuadro', texto: '• Lo demás.' },
      { kind: 'p', texto: 'Carro, número ▢; moto.' },
      { kind: 'firma', texto: '▢ **EL ARRENDATARIO** C.C. N° ▢' },
    ]);
    expect(r.origenes).toEqual([
      'prueba.txt:2',
      'prueba.txt:3',
      'prueba.txt:5',
      'prueba.txt:5',
      'prueba.txt:7',
      'prueba.txt:7',
      'prueba.txt:9',
      'prueba.txt:9',
      'prueba.txt:13',
      'prueba.txt:14',
      'prueba.txt:15',
      'prueba.txt:17',
      'prueba.txt:18',
    ]);
    expect(r.pendientes).toEqual([]);
    expect(r.asientos).toEqual([]);
  });

  it('lineaDeSegmentos une tramos, saca el espacio de los marcadores y normaliza como el Word', () => {
    expect(
      lineaDeSegmentos('p', [
        { t: 'PRIMERA: OBJETO. ', b: true, i: false },
        { t: 'Ubicado en ', b: false, i: false },
        { t: 'XXXXXX', b: false, i: false },
        { t: '  y  N° ', b: false, i: false },
        { t: '______', b: true, i: false },
        { t: ' ', b: false, i: false },
        { t: 'fin', b: true, i: false },
      ]),
    ).toEqual({ kind: 'p', texto: '**PRIMERA: OBJETO.** Ubicado en ▢ y N° **▢ fin**' });
  });
});

describe('borradores y pendientes', () => {
  const version = (verbo: string) =>
    plantilla(
      `Todo pago que [[coa: EL ARRENDATARIO o EL COARRENDATARIO efectúe | #c-01: EL ARRENDATARIO ${verbo}]].`,
    );

  it('un borrador aprobado imprime limpio; si su texto cambia vuelve a quedar pendiente', () => {
    const p1 = version('efectúe');
    const [b] = p1.borradores;
    expect(b).toMatchObject({
      id: 'c-01',
      word: 'EL ARRENDATARIO o EL COARRENDATARIO efectúe',
      texto: 'EL ARRENDATARIO efectúe',
    });
    const aprobados = { 'c-01': { sha256: b.sha256 } };
    const sinCoa = ctx({}, {}, []);

    const pendiente = revisar(p1, sinCoa);
    expect(pendiente.pendientes).toEqual([{ id: 'c-01', tipo: 'borrador' }]);
    expect(pendiente.html).toContain('<span class="pendiente">EL ARRENDATARIO efectúe</span>');

    const aprobado = revisar(p1, sinCoa, { modo: 'revision', aprobados });
    expect(aprobado.pendientes).toEqual([]);
    expect(textos(aprobado)).toEqual(['Todo pago que EL ARRENDATARIO efectúe.']);

    const editado = revisar(version('efectúe ahora'), sinCoa, { modo: 'revision', aprobados });
    expect(editado.pendientes).toEqual([{ id: 'c-01', tipo: 'borrador' }]);
    expect(textos(revisar(p1))).toEqual([
      'Todo pago que EL ARRENDATARIO o EL COARRENDATARIO efectúe.',
    ]);
  });

  it('PENDIENTE(x) en revisión se marca ⟦PENDIENTE: x⟧ y se lista una vez', () => {
    const p = plantilla('?!x PENDIENTE(b)', 'Texto [[x: de la fianza | PENDIENTE(b)]].');
    const r = revisar(p, ctx({ x: false }));
    expect(textos(r)).toEqual(['⟦PENDIENTE: b⟧', 'Texto ⟦PENDIENTE: b⟧.']);
    expect(r.pendientes).toEqual([{ id: 'b', tipo: 'texto' }]);
    expect(revisar(p).lineas).toEqual([{ kind: 'p', texto: 'Texto de la fianza.' }]);
  });
});

describe('modo final', () => {
  const p = plantilla('Firma {nombre} [[coa: y su coarrendatario | #c-02: sin más]].');

  it('lanza PLANTILLA_TEXTO_PENDIENTE si queda algo pendiente', () => {
    const e = falla(() => revisar(p, ctx({}, {}, []), { modo: 'final' }));
    expect(e?.code).toBe('PLANTILLA_TEXTO_PENDIENTE');
    expect(e?.details).toEqual({ pendientes: [{ id: 'c-02', tipo: 'borrador' }] });
    expect(textos(revisar(p, ctx(), { modo: 'final' }))).toEqual([
      'Firma Ana Pérez y su coarrendatario.',
    ]);
  });

  it('un dato "___" lanza PLANTILLA_MARCADOR; un dato vacío, PLANTILLA_DATO_FALTANTE', () => {
    expect(falla(() => revisar(p, ctx({}, { nombre: '___' }), { modo: 'final' }))?.code).toBe(
      'PLANTILLA_MARCADOR',
    );
    expect(falla(() => revisar(p, ctx({}, { nombre: '  ' })))).toMatchObject({
      code: 'PLANTILLA_DATO_FALTANTE',
      details: { campo: 'nombre' },
    });
    expect(
      falla(() => revisar(plantilla('Canon {pesos:canon}'), ctx({}, { canon: NaN })))?.code,
    ).toBe('PLANTILLA_DATO_FALTANTE');
  });

  it('verificarSinMarcadores: marcadores, y "coarrendatari" cuando no hay coarrendatario', () => {
    const l = (texto: string) => [{ kind: 'p', texto }];
    expect(() =>
      verificarSinMarcadores(l('Todo en orden.'), { sinCoarrendatario: true }),
    ).not.toThrow();
    for (const t of ['a ▢ b', '⟦PENDIENTE: b⟧', 'valor undefined', 'NO APLICA', '{x}'])
      expect(falla(() => verificarSinMarcadores(l(t), { sinCoarrendatario: false }))?.code).toBe(
        'PLANTILLA_MARCADOR',
      );
    expect(
      falla(() => verificarSinMarcadores(l('EL COARRENDATARIO'), { sinCoarrendatario: true }))
        ?.code,
    ).toBe('PLANTILLA_MARCADOR');
  });
});

describe('escape', () => {
  it('un <script> en un dato sale escapado en el HTML y literal en el texto', () => {
    const r = revisar(
      plantilla('Hola {nombre}.'),
      ctx({}, { nombre: '<script>alert("x")</script> & Cía' }),
    );
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Cía');
    expect(textos(r)).toEqual(['Hola <script>alert("x")</script> & Cía.']);
    expect(htmlATexto(r.html)).toEqual(r.lineas);
  });
});

describe('coherencia de cifras', () => {
  const lineas = (fila = 'Prima ({pct:primaPct}% del canon) | ${pesos:prima}') => [
    '@cuadro',
    '**Canon** | ${pesos:canon}  ({pesosLetras:canon})',
    '@fin',
    '@bloque PRELIMINAR',
    '@seccion {S}.  ¿Cuánto tengo que pagar?',
    '@dinero',
    '**Concepto** | **Valor**',
    'Primer canon | ${pesos:canon}',
    fila,
    '**TOTAL** | **${pesos:total}**',
    '@fin',
    '@bloque I',
    '@clausula canon',
    '**{N}: CANON.** La suma de ${pesos:canon} ({pesosLetras:canon}).',
    '@clausula fianza',
    '**{N}: FIANZA.** Prima del {pct:primaPct}%, es decir ${pesos:prima}.',
  ];
  const derivadas = {
    prima: (v: (c: string) => number) => Math.round((v('canon') * v('primaPct')) / 100),
  };
  const r = revisar(plantilla(...lineas()));
  const incoherente = (fn: () => unknown) => falla(fn)?.code;

  it('el libro sale del HTML y cuadra', () => {
    expect(r.asientos).toContainEqual({
      campo: 'total',
      fmt: 'pesos',
      zona: 'resumen',
      tabla: 0,
      total: true,
      texto: '2.562.500',
    });
    expect(r.asientos).toContainEqual({
      campo: 'canon',
      fmt: 'pesos',
      zona: 'cuadro',
      texto: '2.500.000',
    });
    expect(r.asientos).toContainEqual({
      campo: 'prima',
      fmt: 'pesos',
      zona: 'clausula',
      texto: '62.500',
    });
    expect(asientosDeHtml(r.html)).toEqual(r.asientos);
    expect(() => verificarCoherencia(r.asientos, derivadas)).not.toThrow();
  });

  it('un libro alterado → 422', () => {
    const alterado = r.asientos.map((a, k) => (k === 0 ? { ...a, texto: '2.600.000' } : a));
    expect(incoherente(() => verificarCoherencia(alterado, derivadas))).toBe(
      'CONTRATO_RESUMEN_INCOHERENTE',
    );
    const letras = r.asientos.map((a) =>
      a.fmt === 'pesosLetras' ? { ...a, texto: 'un peso' } : a,
    );
    expect(incoherente(() => verificarCoherencia(letras, derivadas))).toBe(
      'CONTRATO_RESUMEN_INCOHERENTE',
    );
  });

  it('un HTML alterado → 422, en una cifra y en un total', () => {
    const cifra = r.html.replace('>62.500</span>', '>70.000</span>');
    expect(incoherente(() => verificarCoherencia(asientosDeHtml(cifra), derivadas))).toBe(
      'CONTRATO_RESUMEN_INCOHERENTE',
    );
    const total = r.html.replace('>2.562.500<', '>2.600.000<');
    expect(falla(() => verificarCoherencia(asientosDeHtml(total), derivadas))).toMatchObject({
      code: 'CONTRATO_RESUMEN_INCOHERENTE',
      details: { campo: 'total' },
    });
  });

  it('una derivada que no cuadra con lo impreso → 422', () => {
    const malDerivada = revisar(plantilla(...lineas()), ctx({}, { prima: 70000, total: 2570000 }));
    expect(falla(() => verificarCoherencia(malDerivada.asientos, derivadas))).toMatchObject({
      details: { campo: 'prima' },
    });
  });

  it('una fila del resumen conectada al campo equivocado → 422 aunque el total sume', () => {
    const cruzada = revisar(
      plantilla(...lineas('Prima ({pct:primaPct}% del canon) | ${pesos:comision}')),
    );
    expect(falla(() => verificarCoherencia(cruzada.asientos, derivadas))).toMatchObject({
      code: 'CONTRATO_RESUMEN_INCOHERENTE',
      details: { campo: 'comision' },
    });
  });
});

describe('inventario de supresiones', () => {
  it('lista por condición líneas, ámbitos con su tamaño, tramos vacíos y los @cada', () => {
    const p = plantilla(
      '@cuadro',
      '**Arrendatario** | {nombre}',
      '@cada coarrendatario',
      '**Coarrendatario** | {parte.nombre}',
      '@fin',
      '@fin',
      '?coa @seccion {S}.  Coarrendatario',
      'uno',
      '- dos',
      '@clausula a',
      '**{N}: A.** Carro[[y: , número {nombre} | ]].',
      '?x + Tarifa mensual.',
      '?!x PENDIENTE(b)',
      '[[coa: y el coarrendatario | #c-01: y nadie más]]',
    );
    expect(inventarioSupresiones(p)).toEqual({
      '@cada coarrendatario': ['**Coarrendatario** | {parte.nombre}'],
      coa: ['@seccion {S}.  Coarrendatario (3 líneas)'],
      y: ['[[, número {nombre}]]'],
      x: ['+ Tarifa mensual.'],
    });
  });
});

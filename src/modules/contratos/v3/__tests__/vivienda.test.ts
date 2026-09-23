import { describe, it, expect, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import { mayus, ordinal, titulo } from '../formato';
import {
  asientosDeHtml,
  contarClausulas,
  inventarioSupresiones,
  verificarCoherencia,
  verificarSinMarcadores,
  type Nodo,
  type Resultado,
} from '../motor';
import { PLANTILLA_VIVIENDA } from '../plantilla-vivienda';
import {
  contexto,
  derivadas,
  renderizarVivienda,
  type DatosVivienda,
  type OpcionesVivienda,
  type Persona,
} from '../vivienda';

// vivienda.ts → documento.ts → pdfRenderer → logger → env, que exige las variables de entorno
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ============================================================
// Contrato de vivienda V3 con la plantilla real (diseño §8.4): qué puede
// quitar cada condición (lista autorizada), la matriz de 16 casos × 0/2
// cláusulas adicionales (numeración, referencias, pendientes, marcadores,
// coherencia de cifras), el caso de referencia con nombre, el modo final, los
// rechazos y los golden files que revisa el abogado (golden/*.txt).
// Sin Chromium: el PDF lo cubre scripts/render-contrato-v3.ts.
// ============================================================

// ── Datos de prueba ──

const persona = (
  nombre: string,
  numeroDocumento: string,
  email: string,
  tipoDocumento: Persona['tipoDocumento'] = 'cc',
): Persona => ({
  tipoPersona: 'natural',
  nombre,
  tipoDocumento,
  numeroDocumento,
  email,
  telefono: '3001234567',
  direccion: 'Calle 10 # 20-30',
  municipio: 'Medellín',
});

const ARRENDADOR: Persona = {
  ...persona(
    'INMOBILIARIA EJEMPLO S.A.S.',
    '900123456',
    'contratos@inmobiliaria-ejemplo.co',
    'nit',
  ),
  tipoPersona: 'juridica',
  digitoVerificacion: '7',
  representanteLegalNombre: 'Ana María Gómez Restrepo',
  matriculaNumero: 'MA-2019-0456',
  matriculaExpedidaPor: 'Alcaldía de Medellín',
};
const ARRENDATARIO = persona('Juan Carlos Pérez Mejía', '1020304050', 'juan.perez@correo.co');
const COARRENDATARIO = persona('María Fernanda López Arango', '43123456', 'maria.lopez@correo.co');

interface Caso {
  coa: boolean;
  comision: boolean;
  ph: boolean;
  trasladada: boolean;
}

function datos(c: Caso): DatosVivienda {
  return {
    numero: 'CTO-2026-0001',
    ciudadFirma: 'Medellín',
    fechaDocumento: '2026-09-21',
    arrendador: ARRENDADOR,
    arrendatario: ARRENDATARIO,
    coarrendatarios: c.coa ? [COARRENDATARIO] : [],
    inmueble: {
      direccion: 'Carrera 43A # 1-50, apartamento 1201',
      municipio: 'Medellín',
      propiedadHorizontal: c.ph,
      usos: { carro: '12', moto: null, util: '3' },
    },
    canonCop: 2_500_000,
    vigenciaMeses: 12,
    fechaInicio: '2026-10-01',
    cuenta: {
      tipo: 'de ahorros',
      numero: '123-456789-01',
      banco: 'Bancolombia',
      titular: 'INMOBILIARIA EJEMPLO S.A.S.',
      nit: '900.123.456-7',
    },
    modalidad: c.trasladada ? 'trasladada' : 'tradicional',
    crc: { numero: 'CRC-2026-0042', fecha: '2026-09-15' },
    primaPct: c.coa ? 10 : 20,
    tarifaPct: 2.5,
    ivaPct: IVA,
    cashbackPct: 30,
    comisionPct: c.comision ? 8 : 0,
    administracion: c.ph
      ? { aCargoDe: 'arrendatario', valorCop: 350_000, incluidaEnCanon: false }
      : null,
  };
}

const COMPLETO: Caso = { coa: true, comision: true, ph: true, trasladada: true };
const IVA = 19;
const ADICIONALES = [
  { titulo: 'Cláusula adicional de prueba uno', texto: 'Texto de ejemplo del arrendador.' },
  { titulo: 'Cláusula adicional de prueba dos', texto: 'Otro texto de ejemplo del arrendador.' },
];

const revision = (d: DatosVivienda, o: Partial<OpcionesVivienda> = {}) =>
  renderizarVivienda(d, { modo: 'revision', logoInmobiliaria: null, ...o });

/** errorCode y details del AppError que lanza fn; undefined si no lanza. */
function falla(fn: () => unknown): { code: string; details: unknown } | undefined {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { code: e.errorCode, details: e.details };
  }
  return undefined;
}

const ids = (r: { pendientes: { id: string }[] }) => r.pendientes.map((p) => p.id).sort();

// Los borradores en singular sin coarrendatario (V3 §9.4). El diseño contaba
// 19; los conversores hallaron 5 tramos más con concordancia plural (c-20…c-24).
const C_IDS = Array.from({ length: 24 }, (_, k) => `c-${String(k + 1).padStart(2, '0')}`);

// ── Lectura de lo impreso, por origen en la plantilla ──

/** "archivo:línea" de cada nodo de la plantilla → la cláusula que lo contiene. */
const CLAUSULA_DE = new Map<string, string>();
/** id de cláusula → origen de su cabecera; "cl/p" → origen de la línea con {P:p}. */
const CABECERA = new Map<string, string>();
const PARRAFO = new Map<string, string>();
(function recorrer(nodos: Nodo[], cl: string | null) {
  for (const nd of nodos) {
    const o = `${nd.o.parte}:${nd.o.linea}`;
    const id = nd.n === 'ambito' ? (nd.tipo === 'clausula' ? nd.id : null) : cl;
    if (id) CLAUSULA_DE.set(o, id);
    if (nd.n === 'linea' && id) {
      if (nd.inicio) CABECERA.set(id, o);
      for (const t of nd.toks) if (t.t === 'P') PARRAFO.set(`${id}/${t.id}`, o);
    }
    if (nd.n === 'ambito' || nd.n === 'caja') recorrer(nd.hijos, id);
  }
})(PLANTILLA_VIVIENDA.nodos, null);

const tc = (s: string) => titulo(s.toLocaleLowerCase('es-CO'));
const ORDINALES = Array.from({ length: 59 }, (_, k) => mayus(ordinal(k + 1)));

/** Las líneas impresas de una cláusula (por id), en orden. */
const deClausula = (r: Resultado, cl: string) =>
  r.lineas.filter((_, k) => CLAUSULA_DE.get(r.origenes[k]) === cl);

/** Texto impreso de la línea que viene de ese origen de la plantilla. */
function impresa(r: Resultado, o: string | undefined): string {
  const k = o ? r.origenes.indexOf(o) : -1;
  if (k < 0) throw new Error(`no se imprimió la línea ${o}`);
  return r.lineas[k].texto;
}

/** Ordinal impreso en la cabecera de la cláusula: "DÉCIMA PRIMERA". */
const ordinalDe = (r: Resultado, cl: string) =>
  /^\*\*([^:*]+):/.exec(impresa(r, CABECERA.get(cl)))![1];

/** Rótulo impreso de un parágrafo: "PARÁGRAFO SEXTO", "PARÁGRAFO". */
const rotulo = (texto: string) => /^\*\*(PARÁGRAFO(?: [A-ZÁÉÍÓÚ]+)*?)(?: —|:)/.exec(texto)?.[1];

const cabeceras = (r: Resultado) =>
  r.lineas
    .filter((l) => l.kind === 'p')
    .map((l) => /^\*\*([A-ZÁÉÍÓÚ ]+): /.exec(l.texto)?.[1])
    .filter((o): o is string => !!o && ORDINALES.includes(o));

const numerales = (r: Resultado, cl: string, kind: 'item' | 'literal') =>
  deClausula(r, cl)
    .filter((l) => l.kind === kind)
    .map((l) => /^\*\*(\w+)[.)]\*\*/.exec(l.texto)?.[1]);

const hasta = (n: number) => Array.from({ length: n }, (_, k) => String(k + 1));

// ── Lo que cada condición puede quitar del texto Word (diseño §8.4) ──

const SUPRESIONES_AUTORIZADAS: Record<string, string[]> = {
  // V3 §9.4, §3.4.6: sin coarrendatario no hay sección 7 del resumen ni su cláusula
  coa: [
    '@seccion {S}.  Si usted firma como coarrendatario, esto es lo que asume (7 líneas)',
    '@clausula coarrendatario (9 líneas)',
  ],
  // V3 §7.4–7.5, §3.4.5: en Tradicional EL ARRENDATARIO no paga prima ni tarifa
  trasladada: [
    'Prima de la fianza ({pct:primaPct}% del canon + IVA) | ${pesos:primaIvaCop}',
    'Tarifa de la fianza ({pct:tarifaPct}% + IVA) | ${pesos:tarifaCop}',
    '> Los porcentajes señalados son los que rigen jurídicamente y se aplican sobre el canon vigente, de modo que los valores en pesos se actualizan automáticamente cuando el canon se incrementa. Las sumas expresadas en pesos son informativas y corresponden al canon vigente a la fecha de suscripción. Estos valores no hacen parte del canon de arrendamiento y serán referenciados de manera independiente en el correspondiente recibo de caja.',
    '+ Tarifa mensual de la fianza COFIANZA.',
    '+ Pagar oportunamente la tarifa mensual de la fianza, junto con el canon, cuando la modalidad aplicable sea Trasladada, en los términos de la {ref:fianza}.',
  ],
  // V3 §13.2: sin comisión, ni la cláusula ni la fila del resumen
  comision: [
    'Comisión de intermediación ({pct:comisionPct}% + IVA) | ${pesos:comisionCop}',
    '@clausula comision (1 línea)',
  ],
  // V3 §13.2 + pendiente (d): sin propiedad horizontal no hay cuota de administración
  ph: ['@clausula administracion (3 líneas)'],
  // V3 §3.4.3: incluida en el canon (o a cargo del arrendador) no se suma aparte
  adminAparte: ['Cuota de administración, si está a su cargo | ${pesos:adminCop}'],
  // V3 §3.4.7: sin cuota a cargo de EL ARRENDATARIO no hace perder el cashback
  adminArrendatario: ['- La cuota de administración, si está a su cargo.'],
  // V3 §8.2: el número de un uso conexo solo va si está declarado
  carro: ['[[, número {usos.carro}]]'],
  moto: ['[[, número {usos.moto}]]'],
  util: ['[[, número {usos.util}]]'],
};

// Lo único que se repite por coarrendatario: la fila del cuadro, sus datos de
// notificación y su bloque de firma.
const CADA_COARRENDATARIO = [
  '**Coarrendatario** | {parte.nombre}',
  'COARRENDATARIO · Dirección: {parte.direccion}     Municipio: {parte.municipio} · Correo electrónico: {parte.email}     Celular: {parte.celular}',
  '@firma (4 líneas)',
];

// Cada referencia numerada del Word en el caso completo (diseño §3.4, tabla de
// 19, más la del cierre que trae el Word corregido de la Adenda 1): origen →
// destino y el texto que imprime. La 12 es la desviación (f): el Word dice
// "Trigésima", la cláusula de notificaciones es la Vigésima Octava.
const REFS_COMPLETO: [origen: string, destino: string, texto: string][] = [
  ['fianza', 'fianza/faltantes', 'Parágrafo Segundo'],
  ['fianza', 'fianza/valores', 'Parágrafo Primero'],
  ['comision', 'fianza', 'Cláusula Cuarta'],
  ['vigencia', 'canon', 'Cláusula Tercera'],
  ['obligaciones-arrendador', 'reparaciones', 'Cláusula Décima Primera'],
  ['obligaciones-arrendador', 'reparaciones', 'Cláusula Décima Primera'],
  ['obligaciones-arrendatario', 'canon', 'Cláusula Tercera'],
  ['obligaciones-arrendatario', 'fianza', 'Cláusula Cuarta'],
  ['obligaciones-arrendatario', 'reparaciones', 'Cláusula Décima Primera'],
  ['obligaciones-arrendatario', 'reparaciones', 'Cláusula Décima Primera'],
  ['obligaciones-arrendatario', 'acceso', 'Cláusula Décima Segunda'],
  ['obligaciones-arrendatario', 'notificaciones', 'Cláusula Vigésima Octava'],
  ['obligaciones-arrendatario', 'restitucion', 'Cláusula Vigésima Cuarta'],
  ['exencion', 'destinacion', 'Cláusula Segunda'],
  ['causales', 'fianza/terminacion', 'Parágrafo Sexto de la Cláusula Cuarta'],
  ['abandono', 'fianza/subrogacion', 'Parágrafo Quinto de la Cláusula Cuarta'],
  ['cesion', 'fianza/terminacion', 'Parágrafo Sexto de la Cláusula Cuarta'],
  ['aceptacion', 'fianza', 'Cláusula Cuarta'],
  ['aceptacion', 'fianza', 'Cláusula Cuarta'],
  // el cierre (bloque XI) está fuera de toda cláusula
  ['', 'totalidad/firma', 'Parágrafo Primero de la Cláusula Trigésima Tercera'],
];
// Las únicas referencias cuyo origen puede no imprimirse: la cláusula SEXTA
// (comisión) y el numeral 2 de DÉCIMA CUARTA (solo en Trasladada).
const REFS_CONDICIONADAS: Record<string, keyof Caso> = {
  'comision→fianza': 'comision',
  'obligaciones-arrendatario→fianza': 'trasladada',
};

// ── Tests ──

describe('lista autorizada de supresiones', () => {
  it('cada condición quita del Word exactamente lo que el V3 autoriza', () => {
    const { '@cada coarrendatario': cada, ...supresiones } =
      inventarioSupresiones(PLANTILLA_VIVIENDA);
    expect(supresiones).toEqual(SUPRESIONES_AUTORIZADAS);
    expect(cada).toEqual(CADA_COARRENDATARIO);
  });

  it('los borradores de concordancia son c-01…c-24', () => {
    expect(
      PLANTILLA_VIVIENDA.borradores
        .map((b) => b.id)
        .filter((id) => id.startsWith('c-'))
        .sort(),
    ).toEqual(C_IDS);
  });
});

describe('matriz: coarrendatario × comisión × PH × modalidad, con 0 y 2 adicionales', () => {
  const casos: (Caso & { adicionales: number })[] = [];
  for (const coa of [true, false])
    for (const comision of [true, false])
      for (const ph of [true, false])
        for (const trasladada of [true, false])
          for (const adicionales of [0, 2])
            casos.push({ coa, comision, ph, trasladada, adicionales });
  const nombre = (c: Caso & { adicionales: number }) =>
    [
      c.coa ? 'coa' : 'sin coa',
      c.comision ? 'comisión' : 'sin comisión',
      c.ph ? 'PH' : 'sin PH',
      c.trasladada ? 'Trasladada' : 'Tradicional',
      `+${c.adicionales}`,
    ].join(' · ');

  it.each(casos.map((c) => [nombre(c), c] as const))('%s', (_, c) => {
    const r = revision(datos(c), { adicionales: ADICIONALES.slice(0, c.adicionales) });

    // cabeceras PRIMERA…N sin huecos, las adicionales a continuación
    const n = 33 - +!c.coa - +!c.comision - +!c.ph + c.adicionales;
    expect(cabeceras(r)).toEqual(ORDINALES.slice(0, n));
    // Entrega 4: el asistente numera las adicionales con esta cuenta (la 1.ª va de la 34 a la 31).
    expect(contarClausulas(PLANTILLA_VIVIENDA, contexto(datos(c)).condiciones)).toBe(n - c.adicionales);
    expect(r.html.match(/class="k-p inicio"/g)).toHaveLength(n);
    expect(r.lineas.some((l) => l.kind === 'centrado')).toBe(c.adicionales > 0);

    // numerales y literales
    expect(numerales(r, 'imputacion', 'item')).toEqual(hasta(c.trasladada ? 9 : 8));
    expect(numerales(r, 'obligaciones-arrendatario', 'item')).toEqual(
      hasta(c.trasladada ? 13 : 12),
    );
    expect(numerales(r, 'reparaciones', 'item')).toEqual(hasta(4));
    expect(numerales(r, 'obligaciones-arrendador', 'item')).toEqual(hasta(6));
    expect(numerales(r, 'causales', 'literal')).toEqual([...'abcdefghi']);

    // parágrafos en secuencia dentro de cada cláusula, uno por cada {P:} impreso
    let leidos = 0;
    for (const cl of new Set(CLAUSULA_DE.values())) {
      const rotulos = deClausula(r, cl)
        .map((l) => rotulo(l.texto))
        .filter(Boolean);
      const esperado =
        rotulos.length === 1
          ? ['PARÁGRAFO']
          : rotulos.map((_, k) => `PARÁGRAFO ${mayus(ordinal(k + 1, 'o'))}`);
      expect(rotulos, cl).toEqual(esperado);
      leidos += rotulos.length;
    }
    expect(leidos).toBe([...PARRAFO.values()].filter((o) => r.origenes.includes(o)).length);

    // secciones del resumen: 1–8 con coarrendatario, 1–7 sin él
    const secciones = r.lineas
      .filter((l) => l.kind === 'seccion')
      .map((l) => /^\*\*(\d+)\./.exec(l.texto)?.[1])
      .filter(Boolean);
    expect(secciones).toEqual(hasta(c.coa ? 8 : 7));

    // cada referencia imprime el ordinal que de verdad tiene su destino
    for (const ref of r.refs) {
      const [cl, p] = ref.destino.split('/');
      const clausula = `Cláusula ${tc(ordinalDe(r, cl))}`;
      if (!p) {
        expect(ref.texto, ref.destino).toBe(clausula);
        continue;
      }
      const par = tc(rotulo(impresa(r, PARRAFO.get(ref.destino)))!);
      expect(
        ref.origen === cl ? [par, `${par} de la ${clausula}`] : [`${par} de la ${clausula}`],
      ).toContain(ref.texto);
    }
    // y las referencias son las del caso completo menos las de orígenes suprimidos
    expect(r.refs.map((x) => `${x.origen}→${x.destino}`)).toEqual(
      REFS_COMPLETO.map(([o, d]) => `${o}→${d}`).filter((k) => {
        const cond = REFS_CONDICIONADAS[k];
        return !cond || c[cond];
      }),
    );

    // sin marcadores (salvo los ⟦PENDIENTE⟧ del modo revisión) ni coarrendatario sobrante
    const sinPendientes = r.lineas.map((l) => ({
      ...l,
      texto: l.texto.replace(/⟦PENDIENTE: [\w-]+⟧/g, ''),
    }));
    expect(() =>
      verificarSinMarcadores(sinPendientes, { sinCoarrendatario: !c.coa }),
    ).not.toThrow();
    if (!c.coa) expect(r.html).not.toMatch(/coarrendatari/i);

    // firmas: arrendatario, coarrendatarios, arrendador
    expect(
      r.lineas.filter((l) => l.kind === 'firma').map((l) => /^\*\*([^*]+)\*\*/.exec(l.texto)?.[1]),
    ).toEqual(['EL ARRENDATARIO', ...(c.coa ? ['EL COARRENDATARIO'] : []), 'EL ARRENDADOR']);

    // pendientes: c-* sin coarrendatario, b en Tradicional, d sin PH
    expect(r.pendientes.map((x) => `${x.tipo}:${x.id}`).sort()).toEqual(
      [
        ...(c.coa ? [] : C_IDS.map((id) => `borrador:${id}`)),
        ...(c.trasladada ? [] : ['texto:b']),
        ...(c.ph ? [] : ['texto:d']),
      ].sort(),
    );

    // las cifras impresas cuadran (leídas del HTML)
    expect(() => verificarCoherencia(asientosDeHtml(r.html), derivadas(IVA))).not.toThrow();
  });

  it('el caso completo trae las 20 referencias numeradas del Word', () => {
    expect(revision(datos(COMPLETO)).refs.map((x) => [x.origen, x.destino, x.texto])).toEqual(
      REFS_COMPLETO,
    );
  });
});

describe('caso de referencia: sin coarrendatario, sin comisión, sin PH', () => {
  const r = revision(datos({ coa: false, comision: false, ph: false, trasladada: true }));
  const item = (cl: string, n: number) =>
    deClausula(r, cl).find((l) => l.kind === 'item' && l.texto.startsWith(`**${n}.**`))!.texto;

  it('DÉCIMA TERCERA num. 4 remite a la Cláusula Novena (reparaciones)', () => {
    expect(ordinalDe(r, 'obligaciones-arrendador')).toBe('DÉCIMA PRIMERA');
    expect(item('obligaciones-arrendador', 4)).toContain(
      'en los términos y plazos de la Cláusula Novena.',
    );
  });

  it('DÉCIMA CUARTA num. 12 y 13 remiten a la Vigésima Quinta y la Vigésima Primera', () => {
    expect(item('obligaciones-arrendatario', 12)).toContain(
      'en los términos de la Cláusula Vigésima Quinta,',
    );
    expect(item('obligaciones-arrendatario', 13)).toContain(
      'en las condiciones pactadas en la Cláusula Vigésima Primera,',
    );
  });

  it('el Parágrafo Sexto de la CUARTA no cambia', () => {
    expect(ordinalDe(r, 'fianza')).toBe('CUARTA');
    expect(impresa(r, PARRAFO.get('fianza/terminacion'))).toMatch(
      /^\*\*PARÁGRAFO SEXTO — TERMINACIÓN ANTICIPADA Y CESIÓN:\*\*/,
    );
    const aTerminacion = r.refs.filter((x) => x.destino === 'fianza/terminacion');
    expect(aTerminacion.map((x) => x.texto)).toEqual([
      'Parágrafo Sexto de la Cláusula Cuarta',
      'Parágrafo Sexto de la Cláusula Cuarta',
    ]);
  });
});

describe('modo final', () => {
  it('el caso completo pasa por el camino final y el barrido de marcadores', () => {
    const r = renderizarVivienda(datos(COMPLETO), { modo: 'final', logoInmobiliaria: null });
    expect(r.pendientes).toEqual([]);
    expect(r.html).not.toMatch(/class="pendiente"/);
    expect(() => verificarSinMarcadores(r.lineas, { sinCoarrendatario: false })).not.toThrow();
  });
});

describe('rechazos', () => {
  const final = (d: DatosVivienda) => () =>
    renderizarVivienda(d, { modo: 'final', logoInmobiliaria: null });
  const completo = datos(COMPLETO);

  it('final sin coarrendatario → PLANTILLA_TEXTO_PENDIENTE con los c-*', () => {
    const e = falla(final(datos({ ...COMPLETO, coa: false })));
    expect(e?.code).toBe('PLANTILLA_TEXTO_PENDIENTE');
    const { pendientes } = e!.details as { pendientes: { id: string; tipo: string }[] };
    expect(pendientes.map((p) => p.id).sort()).toEqual(C_IDS);
    expect(new Set(pendientes.map((p) => p.tipo))).toEqual(new Set(['borrador']));
  });

  it('dos coarrendatarios o un cashback que no es el del Word → PLANTILLA_NO_SOPORTA', () => {
    expect(
      falla(final({ ...completo, coarrendatarios: [COARRENDATARIO, COARRENDATARIO] })),
    ).toMatchObject({ code: 'PLANTILLA_NO_SOPORTA', details: { regla: 'coarrendatarios' } });
    expect(falla(final({ ...completo, cashbackPct: 25 }))).toMatchObject({
      code: 'PLANTILLA_NO_SOPORTA',
      details: { regla: 'cashback' },
    });
  });

  it('final con un número que no es CTO-AAAA-NNNN → PLANTILLA_DATO_FALTANTE', () => {
    expect(falla(final({ ...completo, numero: 'BORRADOR' }))).toMatchObject({
      code: 'PLANTILLA_DATO_FALTANTE',
      details: { campo: 'numero' },
    });
  });

  it('una parte con C.E. deja pendientes los j-* y no pasa a final', () => {
    const ce = (p: Persona) => ({ ...p, tipoDocumento: 'ce' as const });
    const d = {
      ...completo,
      arrendatario: ce(ARRENDATARIO),
      coarrendatarios: [ce(COARRENDATARIO)],
    };
    const r = revision(d);
    expect(ids(r)).toEqual(['j-coa-doc', 'j-firma-arrendatario', 'j-firma-coa']);
    expect(deClausula(r, 'coarrendatario')[1].texto).toContain(
      'identificado(a) con cédula de extranjería N° 43123456',
    );
    expect(r.lineas.filter((l) => l.kind === 'firma').map((l) => l.texto)).toEqual([
      '**EL ARRENDATARIO** Juan Carlos Pérez Mejía C.E. N° 1020304050',
      '**EL COARRENDATARIO** María Fernanda López Arango C.E. N° 43123456',
      '**EL ARRENDADOR** Ana María Gómez Restrepo Representante Legal NIT 900.123.456-7',
    ]);
    expect(falla(final(d))?.code).toBe('PLANTILLA_TEXTO_PENDIENTE');
  });

  it('fechado el día 1 no deja pendientes: el cierre del Word corregido no lleva ciudad ni fecha', () => {
    const r = revision({ ...completo, fechaDocumento: '2026-10-01' });
    expect(ids(r)).toEqual([]);
    expect(r.lineas.map((l) => l.texto)).toContain(
      'El presente contrato se perfecciona con la firma de LAS PARTES. Cuando se suscriba de manera física, se firma en dos (2) ejemplares del mismo tenor y a un solo efecto, uno para cada parte. Cuando se suscriba mediante firma electrónica, se otorga en un único ejemplar electrónico del cual cada parte recibirá copia, en los términos del Parágrafo Primero de la Cláusula Trigésima Tercera.',
    );
    // la fecha va solo en el cuadro, con el día en número
    expect(r.lineas.map((l) => l.texto)).toContain('Medellín, 1 de octubre de 2026');
  });
});

describe('prima con IVA (Adenda 1 §1.1)', () => {
  // canon impar: la base se redondea primero y el IVA va sobre ella, como la tarifa con IVA del CRC
  const r = revision({ ...datos(COMPLETO), canonCop: 2_345_678 });
  const texto = r.lineas.map((l) => l.texto).join('\n');

  it('la CUARTA y el resumen imprimen la prima con IVA; la tarifa sigue "$X más IVA"', () => {
    // 10 % de 2.345.678 = 234.568; × 1,19 = 279.135,92 → 279.136
    expect(texto).toContain(
      'diez por ciento (10%) del canon mensual más el Impuesto sobre las Ventas (IVA), equivalente a la fecha de suscripción a la suma de $279.136, pagadera',
    );
    expect(texto).toContain('Prima de la fianza (10% del canon + IVA)\n$279.136');
    expect(texto).toContain('a la suma de $58.642 más IVA, pagadera');
  });

  it('el total al ingreso suma la prima con IVA', () => {
    // 2.345.678 + comisión 8 % (187.654) + 279.136
    expect(texto).toContain('**TOTAL APROXIMADO AL INGRESO**\n**$2.812.468**');
  });
});

describe('coherencia de las cifras impresas', () => {
  const r = revision(datos(COMPLETO));
  const incoherente = (html: string) =>
    falla(() => verificarCoherencia(asientosDeHtml(html), derivadas(IVA)));

  it('cuadra en el caso completo', () => {
    expect(incoherente(r.html)).toBeUndefined();
  });

  it('un HTML alterado → 422: una cifra, una derivada y un total', () => {
    // el canon del resumen distinto al de la cláusula
    const cifra = r.html.replace(
      /(data-campo="canon" data-fmt="pesos" data-zona="resumen"[^>]*>)2\.500\.000</,
      (_, a: string) => `${a}2.600.000<`,
    );
    expect(cifra).not.toBe(r.html);
    expect(incoherente(cifra)).toMatchObject({
      code: 'CONTRATO_RESUMEN_INCOHERENTE',
      details: { campo: 'canon' },
    });
    // la prima cambiada en todas partes: ya no es primaPct del canon más IVA
    const prima = r.html.replace(
      /(data-campo="primaIvaCop"[^>]*>)297\.500</g,
      (_, a: string) => `${a}250.000<`,
    );
    expect(prima).not.toBe(r.html);
    expect(incoherente(prima)).toMatchObject({
      code: 'CONTRATO_RESUMEN_INCOHERENTE',
      details: { campo: 'primaIvaCop' },
    });
    const total = r.html.replace(
      /(data-campo="totalIngreso"[^>]*>)2\.997\.500</,
      (_, a: string) => `${a}2.950.000<`,
    );
    expect(total).not.toBe(r.html);
    expect(incoherente(total)).toMatchObject({
      code: 'CONTRATO_RESUMEN_INCOHERENTE',
      details: { campo: 'totalIngreso' },
    });
  });
});

describe('golden files (lo que revisa el abogado)', () => {
  const texto = (r: Resultado) => r.lineas.map((l) => `[${l.kind}] ${l.texto}`).join('\n') + '\n';
  const minimo = datos({ coa: false, comision: false, ph: false, trasladada: true });
  minimo.inmueble.usos = { carro: null, moto: null, util: null };

  it.each([
    ['completo', datos(COMPLETO)],
    ['minimo', minimo],
    ['tradicional', datos({ ...COMPLETO, trasladada: false })],
  ] as const)('%s', async (nombre, d) => {
    await expect(texto(revision(d))).toMatchFileSnapshot(`golden/${nombre}.txt`);
  });
});

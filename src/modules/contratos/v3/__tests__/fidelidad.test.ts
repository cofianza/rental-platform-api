import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { lineaDeSegmentos, renderizar, type Linea, type Plantilla } from '../motor';
import { PLANTILLA_ANEXO, PLANTILLA_VIVIENDA } from '../plantilla-vivienda';
import { pieTexto, type OpcionesPie } from '../documento';

// documento.ts → pdfRenderer → logger → env, que exige las variables de entorno
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ============================================================
// Fidelidad de las plantillas contra su Word (diseño §8.3; Entrega 5 §4.4
// agrega el Anexo). En modo 'fidelidad' todo campo imprime ▢, toda condición
// es verdadera y @cada corre una vez: así la plantilla tiene que leerse,
// párrafo por párrafo, igual al .docx fijado por sha256 (texto,
// negritas/cursivas y tipo de párrafo). Lo único que puede diferir está en
// las DESVIACIONES de ese documento.
//
// FIDELIDAD_PARTE=1..4 compara solo un archivo de la plantilla contra su
// rango de párrafos del Word; es lo que usa cada conversor (C1–C4):
//   FIDELIDAD_PARTE=2 npx vitest run fidelidad
// (el Anexo es una sola parte, la 1).
// ============================================================

const fuente = (f: string) =>
  path.resolve(__dirname, '../../../../../recursos/contratos/fuente', f);

/** Rango de párrafos del Word (w:p del document.xml, base 0) que convierte cada parte. */
interface Parte {
  n: number;
  desde: number;
  hasta: number;
}

/**
 * Diferencia autorizada contra el Word; cada una tiene que ocurrir exactamente
 * una vez: `word`→`motor` cambia el texto, `kindWord`→`kindMotor` el tipo de
 * párrafo (lo que el motor no sabe emitir igual).
 */
interface Desviacion {
  parrafo: number;
  motivo: string;
  word?: string;
  motor?: string;
  kindWord?: string;
  kindMotor?: string;
}

interface Documento {
  nombre: string;
  docx: string;
  sha256: string;
  plantilla: Plantilla;
  partes: Parte[];
  cuerpo: Desviacion[];
  /** documento.ts pone los logos en el encabezado; el motor no emite estos textos */
  encabezado: string[];
  pie: OpcionesPie;
}

const LOGOS = ['*[ espacio para logo de la inmobiliaria ]*', '*[ espacio para logo de COFIANZA ]*'];

const DOCUMENTOS: Documento[] = [
  {
    nombre: 'vivienda',
    docx: fuente('CONTRATO_ARRENDAMIENTO_VIVIENDA_COFIANZA_INTEGRADO.docx'),
    sha256: '083eeabb0836b4a79663d7542d40c857803956af06fffc32b9462346ac6bdc5e',
    plantilla: PLANTILLA_VIVIENDA,
    partes: [
      { n: 1, desde: 0, hasta: 134 },
      { n: 2, desde: 135, hasta: 195 },
      { n: 3, desde: 196, hasta: 306 },
      { n: 4, desde: 307, hasta: 361 },
    ],
    cuerpo: [
      {
        parrafo: 242,
        word: 'Cláusula Trigésima,',
        motor: 'Cláusula Vigésima Octava,',
        motivo:
          '(f) el Word remite a la TRIGÉSIMA; la cláusula de notificaciones es la VIGÉSIMA OCTAVA',
      },
    ],
    encabezado: LOGOS,
    pie: {},
  },
  {
    nombre: 'anexo',
    docx: fuente('ANEXO_CONDICIONES_AFIANZAMIENTO_COFIANZA_V3.docx'),
    sha256: '9bd779a4c3e2c1a026ca18b82251b5275df3e7be2559cf3aeb0f2a5a987a02c0',
    plantilla: PLANTILLA_ANEXO,
    partes: [{ n: 1, desde: 0, hasta: 157 }],
    cuerpo: [
      {
        parrafo: 1,
        kindWord: 'centrado',
        kindMotor: 'titulo',
        motivo:
          'el Word centra "COFIANZA S.A.S." en 11 pt; el motor solo emite k-centrado desde ' +
          '@adicionales, que no se imprime cuando no hay cláusulas adicionales. @titulo da el ' +
          'mismo centrado en negrita (13 pt) y el texto queda idéntico',
      },
    ],
    encabezado: LOGOS,
    pie: { rotulo: 'CRC N°', iniciales: false },
  },
];

const envParte = process.env.FIDELIDAD_PARTE;
const DOCS = envParte
  ? DOCUMENTOS.filter((d) => d.partes.some((p) => String(p.n) === envParte))
  : DOCUMENTOS;
if (!DOCS.length) throw new Error(`FIDELIDAD_PARTE=${envParte}: ninguna plantilla tiene esa parte`);

// ── Lado Word ──

type LineaWord = Linea & { parrafo: number };
type LineaMotor = Linea & { o: string };
type Seg = { t: string; b: boolean; i: boolean };

/** `<w:b/>`, `<w:b w:val="true"/>` → activo; `w:val="false"` o ausente → no. */
const activo = (rpr: string, tag: string) => {
  const m = rpr.match(new RegExp(`<w:${tag}(?: w:val="([^"]*)")?/>`));
  return !!m && !/^(false|0|off)$/.test(m[1] ?? '');
};

/** Tipo de párrafo del Word, tabla del diseño §8.3 en orden: gana la primera fila que aplique. */
function tipoWord(
  ppr: string,
  cols: number,
  segs: Seg[],
  r: { tamano: number; cursiva: boolean; br: boolean },
): string {
  const crudo = segs.map((s) => s.t).join('');
  const num = (re: RegExp) => Number(ppr.match(re)?.[1] ?? -1);
  const centrado = /<w:jc w:val="center"/.test(ppr);
  const borde = /<w:pBdr>[\s\S]*?<w:bottom\b/.test(ppr);
  const sangria = num(/<w:ind\b[^>]*w:left="(\d+)"/);
  const antes = num(/w:before="(\d+)"/);
  const despues = num(/w:after="(\d+)"/);
  if (cols > 1) return 'celda';
  if (cols === 1) return 'recuadro';
  if (borde && r.tamano === 22) return 'bloque';
  if (borde && r.tamano === 21) return 'seccion';
  if (centrado && r.tamano === 26) return 'titulo';
  if (r.cursiva && crudo.trim()) return 'nota';
  if (centrado) return 'centrado';
  if (r.br) return 'firma';
  if (sangria === 560) return 'sangria2';
  if (sangria === 300) return 'vineta';
  if (sangria === 340)
    return /^\d+\. /.test(crudo) ? 'item' : /^[a-z]\) /.test(crudo) ? 'literal' : 'sangria';
  if (antes === 150 && despues === 60) return 'subtitulo';
  if (antes === 40 && despues === 40) return 'dato';
  return 'p';
}

/**
 * Párrafos en orden de cuerpo (celdas de tabla incluidas) → líneas con su tipo.
 * ponytail: regex sobre el XML en vez de un parser; alcanza porque el .docx está
 * fijado por sha256 (sin entidades, sin tablas anidadas). Si cambia el Word, revisar.
 */
function parrafosWord(xml: string): LineaWord[] {
  const out: LineaWord[] = [];
  const tablas: number[] = []; // columnas de cada tabla abierta
  let parrafo = 0;
  for (const [tok] of xml.matchAll(
    /<w:tbl>|<\/w:tbl>|<w:gridCol\b|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g,
  )) {
    if (tok === '<w:tbl>') tablas.push(0);
    else if (tok === '</w:tbl>') tablas.pop();
    else if (tok === '<w:gridCol') tablas[tablas.length - 1]++;
    else {
      const ppr = tok.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)?.[1] ?? '';
      const segs: Seg[] = [];
      let tamano = 0;
      let cursiva = true;
      let br = false;
      for (const [, r] of tok
        .replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '')
        .matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
        const rpr = r.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1] ?? '';
        let t = '';
        for (const m of r.matchAll(
          /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(br|tab)\b[^>]*\/>|<w:instrText[^>]*>([^<]*)<\/w:instrText>/g,
        )) {
          if (m[2] === 'br') br = true;
          t += m[1] ?? (m[2] ? ' ' : /^\s*(PAGE|NUMPAGES)\b/.test(m[3]) ? '▢' : '');
        }
        const i = activo(rpr, 'i');
        if (t.trim()) {
          tamano ||= Number(rpr.match(/<w:sz w:val="(\d+)"/)?.[1] ?? 0);
          cursiva &&= i;
        }
        segs.push({ t, b: activo(rpr, 'b'), i });
      }
      const kind = tipoWord(ppr, tablas[tablas.length - 1] ?? 0, segs, { tamano, cursiva, br });
      const linea = lineaDeSegmentos(kind, segs);
      if (linea.texto) out.push({ ...linea, parrafo }); // los párrafos vacíos (espaciadores) no cuentan
      parrafo++;
    }
  }
  return out;
}

function aplicarDesviaciones(lineas: LineaWord[], cuerpo: Desviacion[]): LineaWord[] {
  return lineas.map((l) => {
    const d = cuerpo.find((x) => x.parrafo === l.parrafo);
    if (!d) return l;
    let { kind, texto } = l;
    if (d.word !== undefined) {
      const n = texto.split(d.word).length - 1;
      if (n !== 1)
        throw new Error(
          `Desviación ${d.motivo}: "${d.word}" aparece ${n} veces en el ¶${d.parrafo}`,
        );
      texto = texto.replace(d.word, d.motor!);
    }
    if (d.kindWord !== undefined) {
      if (kind !== d.kindWord)
        throw new Error(`Desviación ${d.motivo}: el ¶${d.parrafo} es ${kind}, no ${d.kindWord}`);
      kind = d.kindMotor!;
    }
    return { ...l, kind, texto };
  });
}

// ── Diferencias ──

const clave = (l: Linea) => `${l.kind}\u0000${l.texto}`;

/** Contexto alrededor del primer carácter distinto, para párrafos de 500+ caracteres. */
function recorte(a: string, b: string): [string, string] {
  let k = 0;
  while (k < a.length && a[k] === b[k]) k++;
  const desde = Math.max(0, k - 40);
  const cortar = (s: string) =>
    (desde ? '…' : '') + s.slice(desde, k + 60) + (s.length > k + 60 ? '…' : '');
  return [cortar(a), cortar(b)];
}

/** Diff por LCS (≈350² celdas): una línea faltante no descuadra todo lo que sigue. */
function diferencias(
  word: LineaWord[],
  motor: LineaMotor[],
  etiqueta: (parrafo: number) => string,
): string[] {
  const n = word.length;
  const m = motor.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] =
        clave(word[i]) === clave(motor[j])
          ? L[i + 1][j + 1] + 1
          : Math.max(L[i + 1][j], L[i][j + 1]);

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const w = word[i];
    const mo = motor[j];
    if (w && mo && clave(w) === clave(mo)) {
      i++;
      j++;
    } else if (w && mo && L[i + 1][j + 1] === L[i][j]) {
      const [a, b] = recorte(w.texto, mo.texto);
      out.push(
        `¶${w.parrafo} ${etiqueta(w.parrafo)} ≠ ${mo.o}\n    word  (${w.kind}): ${a}\n    motor (${mo.kind}): ${b}`,
      );
      i++;
      j++;
    } else if (w && (!mo || L[i + 1][j] >= L[i][j + 1])) {
      out.push(
        `¶${w.parrafo} ${etiqueta(w.parrafo)} falta en la plantilla\n    word  (${w.kind}): ${w.texto.slice(0, 120)}`,
      );
      i++;
    } else {
      const ref = w?.parrafo ?? word[n - 1]?.parrafo ?? 0;
      out.push(
        `${mo.o} sobra en la plantilla (antes del ¶${ref} ${etiqueta(ref)})\n    motor (${mo.kind}): ${mo.texto.slice(0, 120)}`,
      );
      j++;
    }
  }
  return out;
}

// ── Tests ──

describe.each(DOCS)('fidelidad de la plantilla de $nombre con el Word', (doc) => {
  const SOLO = envParte ? doc.partes.find((p) => String(p.n) === envParte) : undefined;
  /** Nombre del archivo de la parte n, como sale en Resultado.origenes ("archivo:línea"). */
  const archivo = (n: number) => path.basename(doc.plantilla.def.partes[n - 1]);
  const etiqueta = (parrafo: number) => {
    const { n } = doc.partes.find((p) => parrafo <= p.hasta) ?? doc.partes[doc.partes.length - 1];
    return `[C${n} ${archivo(n)}]`;
  };

  let docx: Buffer;
  let cuerpo: string;
  let encabezado: string;
  let pie: string;

  beforeAll(async () => {
    docx = fs.readFileSync(doc.docx);
    const zip = await JSZip.loadAsync(docx);
    const leer = (f: string) => zip.file(`word/${f}`)!.async('string');
    [cuerpo, encabezado, pie] = await Promise.all([
      leer('document.xml'),
      leer('header1.xml'),
      leer('footer1.xml'),
    ]);
  });

  it('el .docx fuente es el fijado por sha256', () => {
    expect(crypto.createHash('sha256').update(docx).digest('hex')).toBe(doc.sha256);
  });

  it(`modo fidelidad reproduce el Word párrafo por párrafo${SOLO ? ` (solo C${SOLO.n}: ¶${SOLO.desde}–${SOLO.hasta})` : ''}`, () => {
    const word = aplicarDesviaciones(parrafosWord(cuerpo), doc.cuerpo).filter(
      (l) => !SOLO || (l.parrafo >= SOLO.desde && l.parrafo <= SOLO.hasta),
    );
    const r = renderizar(doc.plantilla, null, { modo: 'fidelidad' });
    const motor = r.lineas
      .map((l, k) => ({ ...l, o: r.origenes[k] }))
      .filter((l) => !SOLO || l.o.startsWith(`${archivo(SOLO.n)}:`));
    const difs = diferencias(word, motor, etiqueta);
    const informe = `${difs.length} diferencia(s) con el Word (primeras 20):\n${difs.slice(0, 20).join('\n')}`;
    expect(difs.length, informe).toBe(0);
  });

  it('el encabezado del Word solo trae los dos espacios de logo', () => {
    expect(parrafosWord(encabezado).map((l) => l.texto)).toEqual(doc.encabezado);
  });

  it.skipIf(SOLO && SOLO.n !== 1)('el pie del Word es pieTexto(pie, "fidelidad")', () => {
    const word = parrafosWord(pie);
    expect(word).toHaveLength(1);
    const motor = lineaDeSegmentos(word[0].kind, [
      { t: pieTexto(doc.plantilla.pie, 'fidelidad', doc.pie), b: false, i: false },
    ]);
    expect(motor.texto).toBe(word[0].texto);
  });
});

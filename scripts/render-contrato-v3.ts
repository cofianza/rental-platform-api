/**
 * Render de revisión del contrato de vivienda V3 (Entrega 2, diseño §8.5).
 *
 * vivienda.test.ts prueba el texto; esto prueba el PDF de verdad, que se
 * rompe en silencio (una firma partida entre dos páginas, una fuente de
 * respaldo, un pie sin número). Genera los escenarios con Chromium, los relee
 * y deja en [dir] el paquete para Mario:
 *   - final:    completo, sin-logo, y con las anclas de Auco: anexo (Ruta B)
 *               y adicional-larga (una cláusula que empuja las firmas al
 *               corte de página, donde se partía el bloque del arrendador)
 *   - revisión: sin-coarrendatario, minimo-adicionales, tradicional,
 *               admin-incluida, ce
 *   - <escenario>.pdf, sus páginas en PNG (pdftoppm) y borradores.txt (cada
 *     borrador #id con su estado, sha256, texto Word y borrador, y cada
 *     PENDIENTE(x)).
 *
 * Chequea, con pdf-lib: páginas y que toda /BaseFont sea Gelasio. Con
 * pdftotext (si está instalado): "Página i de N" y el número del contrato en
 * cada página, los finales sin marcadores, y cada bloque de firma (rótulo,
 * nombre y documento) en una sola página.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/render-contrato-v3.ts [dir]
 */

for (const [k, v] of Object.entries({
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'x',
  SUPABASE_SERVICE_ROLE_KEY: 'x',
  SUPABASE_JWT_SECRET: 'x',
  RESEND_API_KEY: 'x',
  AUCO_SENDER_EMAIL: 'qa@cofianza.co',
  LOG_LEVEL: 'warn',
})) {
  if (!process.env[k]) process.env[k] = v;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { APROBACIONES } from '@/modules/contratos/v3/aprobaciones';
import type { LogoPdf } from '@/modules/contratos/v3/documento';
import { FORMATOS } from '@/modules/contratos/v3/formato';
import type { Nodo, Tok } from '@/modules/contratos/v3/motor';
import { PLANTILLA_VIVIENDA } from '@/modules/contratos/v3/plantilla-vivienda';
import {
  contexto,
  generarAnexoVivienda,
  generarContratoVivienda,
  type DatosVivienda,
  type Persona,
} from '@/modules/contratos/v3/vivienda';

const DIR = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'contrato-v3'));

// ── Datos de muestra (los mismos del caso completo de vivienda.test.ts) ──

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

const ARRENDATARIO = persona('Juan Carlos Pérez Mejía', '1020304050', 'juan.perez@correo.co');
const COARRENDATARIO = persona('María Fernanda López Arango', '43123456', 'maria.lopez@correo.co');

const COMPLETO: DatosVivienda = {
  numero: 'CTO-2026-0001',
  ciudadFirma: 'Medellín',
  fechaDocumento: '2026-09-21',
  arrendador: {
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
  },
  arrendatario: ARRENDATARIO,
  coarrendatarios: [COARRENDATARIO],
  inmueble: {
    direccion: 'Carrera 43A # 1-50, apartamento 1201',
    municipio: 'Medellín',
    propiedadHorizontal: true,
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
  modalidad: 'trasladada',
  crc: { numero: 'CRC-2026-0042', fecha: '2026-09-15' },
  primaPct: 10,
  tarifaPct: 2.5,
  cashbackPct: 30,
  comisionPct: 8,
  administracion: { aCargoDe: 'arrendatario', valorCop: 350_000, incluidaEnCanon: false },
};

const BORRADOR = { ...COMPLETO, numero: 'BORRADOR' };
const SIN_COA = { ...BORRADOR, coarrendatarios: [], primaPct: 20 };
const ce = (p: Persona): Persona => ({ ...p, tipoDocumento: 'ce' });

/** Un PNG de muestra para la cabecera (un cuadro y una "palabra" en franjas): sin binarios en el repo. */
function logoDeMuestra(): LogoPdf {
  const [ancho, alto] = [360, 90];
  const fila = ancho * 3 + 1; // byte de filtro + RGB
  const px = Buffer.alloc(fila * alto, 255);
  for (let y = 0; y < alto; y++) {
    px[y * fila] = 0;
    for (let x = 0; x < ancho; x++)
      if (x < alto || (y > 30 && y < 60 && x > 110 && x % 24 < 16))
        px.set([4, 120, 87], y * fila + 1 + x * 3);
  }
  const trozo = (tipo: string, datos: Buffer) => {
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'latin1'), datos]);
    const pie = Buffer.alloc(8);
    pie.writeUInt32BE(datos.length, 0);
    pie.writeUInt32BE(zlib.crc32(cuerpo), 4);
    return Buffer.concat([pie.subarray(0, 4), cuerpo, pie.subarray(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    trozo('IHDR', ihdr),
    trozo('IDAT', zlib.deflateSync(px)),
    trozo('IEND', Buffer.alloc(0)),
  ]);
  return { mime: 'image/png', base64: png.toString('base64') };
}

interface Escenario {
  nombre: string;
  modo: 'final' | 'revision';
  d: DatosVivienda;
  logo?: boolean;
  adicionales?: { titulo: string; texto: string }[];
  /** El Anexo de la Ruta B en vez del contrato. */
  anexo?: boolean;
  /** Con las anclas {{signature:i}} de Auco, como sale a firma. */
  anclas?: boolean;
}

const FRASE =
  'EL ARRENDATARIO se obliga a mantener el inmueble en buen estado de aseo y conservación durante toda la vigencia del contrato. ';

const ESCENARIOS: Escenario[] = [
  { nombre: 'completo', modo: 'final', d: COMPLETO, logo: true },
  { nombre: 'sin-logo', modo: 'final', d: COMPLETO },
  { nombre: 'anexo', modo: 'final', d: COMPLETO, anexo: true, anclas: true },
  {
    nombre: 'adicional-larga',
    modo: 'final',
    d: COMPLETO,
    anclas: true,
    // 24 frases dejaban el bloque del arrendador partido entre dos páginas.
    adicionales: [{ titulo: 'Cláusula adicional larga', texto: FRASE.repeat(24).trim() }],
  },
  { nombre: 'sin-coarrendatario', modo: 'revision', d: SIN_COA, logo: true },
  {
    nombre: 'minimo-adicionales',
    modo: 'revision',
    d: {
      ...SIN_COA,
      comisionPct: 0,
      inmueble: {
        ...COMPLETO.inmueble,
        propiedadHorizontal: false,
        usos: { carro: null, moto: null, util: null },
      },
      administracion: null,
    },
    adicionales: [
      {
        titulo: 'Cláusula adicional de ejemplo',
        texto: 'Texto de ejemplo: aquí va lo que redacte EL ARRENDADOR (no es texto legal).',
      },
      {
        titulo: 'Segunda cláusula adicional de ejemplo',
        texto: 'Otro texto de ejemplo del arrendador, para ver la numeración continua.',
      },
    ],
  },
  { nombre: 'tradicional', modo: 'revision', d: { ...BORRADOR, modalidad: 'tradicional' } },
  {
    nombre: 'admin-incluida',
    modo: 'revision',
    d: {
      ...BORRADOR,
      administracion: { aCargoDe: 'arrendatario', valorCop: 350_000, incluidaEnCanon: true },
    },
  },
  {
    nombre: 'ce',
    modo: 'revision',
    d: { ...BORRADOR, arrendatario: ce(ARRENDATARIO), coarrendatarios: [ce(COARRENDATARIO)] },
  },
];

// ── Lectura del PDF ──

/** Toda fuente del PDF por su /BaseFont (las Type3 no tienen: salen como tales). */
async function leerPdf(pdf: Buffer): Promise<{ paginas: number; fuentes: string[] }> {
  const doc = await PDFDocument.load(pdf);
  const fuentes = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Type')) !== PDFName.of('Font')) continue;
    const base = obj.get(PDFName.of('BaseFont'));
    fuentes.add(
      base instanceof PDFName
        ? base.decodeText()
        : `sin BaseFont (${obj.get(PDFName.of('Subtype'))})`,
    );
  }
  return { paginas: doc.getPageCount(), fuentes: [...fuentes].sort() };
}

const hay = (bin: string) => !spawnSync(bin, ['-v']).error;
const PDFTOTEXT = hay('pdftotext');
const PDFTOPPM = hay('pdftoppm');

/** Texto de cada página (pdftotext separa las páginas con \f). */
function paginasDeTexto(archivo: string): string[] {
  const r = spawnSync('pdftotext', ['-enc', 'UTF-8', archivo, '-'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pdftotext: ${r.stderr}`);
  return r.stdout.split('\f').slice(0, -1);
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Las partes seguidas, con cualquier espacio o salto de línea entre ellas. */
const seguidas = (...partes: string[]) => new RegExp(partes.map(escRe).join('\\s+'));

const docCorto = FORMATOS.doc.fn as (tipo: string) => string;
const MARCADOR = /[Xx]{3,}|_{3,}|▢|⟦|\[PENDIENTE|[{}]|NO APLICA|\b(undefined|null|NaN)\b|BORRADOR/;

function firmas(d: DatosVivienda): [string, RegExp][] {
  const parte = (rotulo: string, p: Persona): [string, RegExp] => [
    rotulo,
    seguidas(rotulo, p.nombre, `${docCorto(p.tipoDocumento)} N° ${p.numeroDocumento}`),
  ];
  const a = d.arrendador;
  const nit = String(contexto(d).valores['arrendador.nit']);
  return [
    parte('EL ARRENDATARIO', d.arrendatario),
    ...d.coarrendatarios.map((p) => parte('EL COARRENDATARIO', p)),
    [
      'EL ARRENDADOR',
      seguidas('EL ARRENDADOR', a.representanteLegalNombre!, 'Representante Legal', `NIT ${nit}`),
    ],
  ];
}

// ── borradores.txt ──

type Alt = Extract<Tok, { t: 'alt' }>;

/** Cada [[c: Word | alternativa]] y ?!c de la plantilla, con su origen. */
function alternativas(nodos: Nodo[], out: { o: string; alt: Alt }[] = []) {
  for (const nd of nodos) {
    const o = `${nd.o.parte}:${nd.o.linea}`;
    const toks = nd.n === 'linea' ? nd.toks : nd.n === 'fila' ? nd.celdas.flat() : [];
    for (const t of toks) if (t.t === 'alt') out.push({ o, alt: t });
    if (nd.n === 'ambito' || nd.n === 'caja') alternativas(nd.hijos, out);
  }
  return out;
}

function borradoresTxt(): string {
  const alts = alternativas(PLANTILLA_VIVIENDA.nodos);
  const lineas = [
    'Contrato de arrendamiento de vivienda urbana (V3) — textos por aprobar',
    `Plantilla: ${PLANTILLA_VIVIENDA.def.codigo}, versión sha256 ${PLANTILLA_VIVIENDA.version}`,
    '',
    'BORRADORES (#id): texto redactado por nosotros donde el Word no alcanza. Se',
    'imprime solo cuando la condición es falsa. Se aprueba agregando su sha256 a',
    'src/modules/contratos/v3/aprobaciones.ts; si el texto cambia, vuelve a quedar',
    'pendiente. Mientras esté pendiente, ese caso no sale en modo final.',
    '',
  ];
  for (const b of PLANTILLA_VIVIENDA.borradores) {
    const a = APROBACIONES[b.id];
    const estado = a?.sha256 === b.sha256 ? `APROBADO (${a.aprobadoPor}, ${a.fecha})` : 'PENDIENTE';
    const { o, alt } = alts.find((x) => x.alt.alt.t === 'borrador' && x.alt.alt.id === b.id)!;
    lineas.push(
      `#${b.id}  ${estado}  ${o}  (si !${alt.c})`,
      `  sha256:   ${b.sha256}`,
      `  Word:     ${b.word || '(no está en el Word)'}`,
      `  Borrador: ${b.texto}`,
      '',
    );
  }
  lineas.push(
    'TEXTOS PENDIENTE(x): los redacta Gerencia; mientras falten, ese caso no sale',
    'en modo final.',
    '',
  );
  for (const { o, alt } of alts) {
    if (alt.alt.t !== 'pendiente') continue;
    lineas.push(
      `PENDIENTE(${alt.alt.id})  ${o}  (si !${alt.c})`,
      `  Word: ${alt.fuente || '(no está en el Word: línea nueva)'}`,
      '',
    );
  }
  return lineas.join('\n');
}

// ── Main ──

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const logo = logoDeMuestra();
  const fallas: string[] = [];
  const falla = (e: string, msg: string) => fallas.push(`${e}: ${msg}`);

  fs.writeFileSync(path.join(DIR, 'borradores.txt'), borradoresTxt());
  if (!PDFTOTEXT) console.log('(sin pdftotext: se omiten los chequeos de texto del PDF)');

  for (const e of ESCENARIOS) {
    const r = await (e.anexo ? generarAnexoVivienda : generarContratoVivienda)(e.d, {
      modo: e.modo,
      logoInmobiliaria: e.logo ? logo : null,
      adicionales: e.adicionales,
      anclas: e.anclas,
    });
    // El pie del Anexo lleva el CRC, no el número del contrato.
    const numero = e.anexo ? e.d.crc.numero : e.d.numero;
    const archivo = path.join(DIR, `${e.nombre}.pdf`);
    fs.writeFileSync(archivo, r.pdf);

    const { paginas, fuentes } = await leerPdf(r.pdf);
    if (!paginas) falla(e.nombre, 'PDF sin páginas');
    const ajenas = fuentes.filter((f) => !/^([A-Z]{6}\+)?Gelasio-/.test(f));
    if (!fuentes.length || ajenas.length) falla(e.nombre, `fuentes que no son Gelasio: ${ajenas}`);

    if (PDFTOTEXT) {
      const textos = paginasDeTexto(archivo);
      if (textos.length !== paginas)
        falla(e.nombre, `pdftotext lee ${textos.length} páginas de ${paginas}`);
      textos.forEach((t, k) => {
        if (!t.includes(`Página ${k + 1} de ${paginas}`))
          falla(e.nombre, `p. ${k + 1} sin "Página ${k + 1} de ${paginas}"`);
        if (!t.includes(`N° ${numero}`)) falla(e.nombre, `p. ${k + 1} sin el número ${numero}`);
      });
      if (e.modo === 'final') {
        const m = MARCADOR.exec(textos.join('\n').replace(/\{\{signature:\d+\}\}/g, ''));
        if (m) falla(e.nombre, `marcador en el PDF final: "${m[0]}"`);
      }
      for (const [rotulo, re] of firmas(e.d))
        if (!textos.some((t) => re.test(t)))
          falla(e.nombre, `la firma de ${rotulo} no está entera en una página`);
    }

    if (PDFTOPPM) {
      const r2 = spawnSync('pdftoppm', ['-png', '-r', '80', archivo, path.join(DIR, e.nombre)]);
      if (r2.status !== 0) falla(e.nombre, `pdftoppm: ${r2.stderr}`);
    }
    const pend = r.pendientes.map((p) => p.id);
    console.log(
      `${e.nombre.padEnd(20)} ${e.modo.padEnd(8)} ${String(paginas).padStart(2)} págs  ` +
        `${fuentes.join(', ')}  pendientes: ${pend.length ? pend.join(' ') : '—'}`,
    );
  }

  console.log(`\nPDF, PNG y borradores.txt en ${DIR}`);
  if (fallas.length) {
    console.error(`\nFALLAS (${fallas.length}):\n  ${fallas.join('\n  ')}`);
    process.exit(1);
  }
  console.log('Todos los chequeos pasan.');
  // el Chromium de pdfRenderer queda vivo para la próxima request: se cierra con el proceso
  process.exit(0);
})().catch((e) => {
  console.error('\nFALLO:', e);
  process.exit(1);
});

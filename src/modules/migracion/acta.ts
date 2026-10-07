// ============================================================
// Acta de Migración (spec §3). Lista contrato por contrato lo que Cofianza va
// a activar (§3.5), con la marca REPORTABLE / NO REPORTABLE y la tarifa de
// cada uno (§5.1.5, §5.2.4), y recoge la declaración de la Sección 7, que
// firma el representante legal por Auco (§7.1). Cofianza también suscribe.
//
// htmlActa es pura (se prueba sin Chromium); generarActa la renderiza, la
// guarda en el bucket y devuelve la llave y el hash del PDF.
// ============================================================

import { createHash } from 'crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { escapeHtml } from '@/lib/escapeHtml';
import { renderHtmlToPdf } from '@/lib/pdfRenderer';
import { formatearPesos } from '@/lib/numerosEnLetras';
import type { CompanyInfo } from '@/lib/companyConfig';
import { BUCKET } from './habilitacion.service';
import type { Destinacion, ResultadoFila } from './validacion';

export interface DatosActa {
  empresa: CompanyInfo;
  inmobiliaria: { id: string; nombre: string };
  /** Habilitaciones con las que se cargó el lote (identifican el convenio, §3.2). */
  habilitaciones: { destinacion: Destinacion; revisado_en: string | null }[];
  lote: {
    numero: string;
    rep_legal_nombre: string;
    rep_legal_documento: string;
  };
  generadaEn: Date;
  filas: ResultadoFila[];
  mesesSinMora: number;
  diasRespuestaAuditoria: number;
}

const e = (v: string | number | null | undefined) => escapeHtml(v == null ? '' : String(v));

/** AAAA-MM-DD → DD/MM/AAAA. */
const fecha = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

const fechaHoraBogota = (d: Date) =>
  d.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short', hour12: false });

const pct = (n: number) => `${n.toLocaleString('es-CO', { maximumFractionDigits: 2 })} %`;

const nombreArrendatario = (r: ResultadoFila) =>
  [r.datos.arrendatario.nombre, r.datos.arrendatario.apellido].filter(Boolean).join(' ');

const documento = (r: ResultadoFila) =>
  [r.datos.arrendatario.tipo_documento, r.datos.arrendatario.numero_documento].filter(Boolean).join(' ');

const direccion = (r: ResultadoFila) => [r.datos.direccion, r.datos.municipio].filter(Boolean).join(', ');

const CSS = `
@page { size: Letter; margin: 2cm 1.8cm; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 9.5pt; color: #111; line-height: 1.4; }
h1 { font-size: 14pt; text-align: center; margin: 0 0 4pt; }
h2 { font-size: 11pt; margin: 14pt 0 6pt; }
.sub { text-align: center; margin: 0 0 12pt; }
table { width: 100%; border-collapse: collapse; margin: 4pt 0; }
th, td { border: 1px solid #999; padding: 3pt 4pt; vertical-align: top; text-align: left; }
th { background: #eee; font-size: 8.5pt; }
td.n { text-align: right; white-space: nowrap; }
tr { page-break-inside: avoid; }
.datos td { border: none; padding: 1pt 4pt 1pt 0; }
.marca { font-weight: bold; white-space: nowrap; }
ol li { margin-bottom: 4pt; }
.firmas { display: flex; justify-content: space-between; margin-top: 48pt; page-break-inside: avoid; }
.firma { width: 45%; }
.linea { position: relative; display: block; border-bottom: 1px solid #000; height: 40pt; }
.ancla { position: absolute; left: 0; bottom: 4pt; font-size: 1px; line-height: 1px; color: #fff; }
`;

function tablaAceptados(filas: ResultadoFila[]): string {
  if (!filas.length) return '<p>Ninguno.</p>';
  const renglones = filas
    .map(
      (r) => `<tr>
  <td class="n">${r.n_fila}</td>
  <td>${e(direccion(r))}</td>
  <td>${e(r.datos.destinacion)}</td>
  <td>${e(nombreArrendatario(r))}</td>
  <td>${e(documento(r))}</td>
  <td class="n">$ ${e(formatearPesos(r.datos.canon ?? 0))}</td>
  <td>${e(fecha(r.datos.fecha_inicio))} a ${e(fecha(r.datos.fecha_vencimiento))}</td>
  <td class="marca">${r.reportable ? 'REPORTABLE' : 'NO REPORTABLE'}</td>
  <td class="n">${e(pct(r.tarifa_pct ?? 0))} + IVA</td>
</tr>`,
    )
    .join('\n');
  return `<table>
<thead><tr><th>Fila</th><th>Inmueble</th><th>Destinación</th><th>Arrendatario</th><th>Documento</th><th>Canon sin IVA</th><th>Vigencia del contrato</th><th>Marca</th><th>Tarifa mensual</th></tr></thead>
<tbody>
${renglones}
</tbody>
</table>`;
}

function tablaRechazados(filas: ResultadoFila[]): string {
  if (!filas.length) return '<p>Ninguno.</p>';
  const renglones = filas
    .map(
      (r) => `<tr>
  <td class="n">${r.n_fila}</td>
  <td>${e(direccion(r))}</td>
  <td>${e(nombreArrendatario(r))} ${e(documento(r))}</td>
  <td>${r.motivos.map(e).join('<br>')}</td>
</tr>`,
    )
    .join('\n');
  return `<table>
<thead><tr><th>Fila</th><th>Inmueble</th><th>Arrendatario</th><th>Motivo del rechazo</th></tr></thead>
<tbody>
${renglones}
</tbody>
</table>`;
}

/** Texto de la declaración y de los remedios (spec §7, §3.4, §4.5). */
function declaracion(d: DatosActa): string {
  const m = d.mesesSinMora;
  return `<ol>
<li>La inmobiliaria declara, para CADA UNO de los contratos aceptados listados en esta acta y de manera individual, que a la fecha de esta acta el contrato está vigente y en ejecución, que el arrendatario está al día en el pago del canon y que no ha tenido mora en los últimos ${m} meses. Esta declaración es la única información de comportamiento de pago con la que cuenta ${e(d.empresa.name)} para otorgar la fianza: no hay estudio de crédito, consulta a centrales de riesgo ni prima de vinculación.</li>
<li>La inmobiliaria declara que revisó los datos de cada contrato tal como aparecen en esta acta y que corresponden a los contratos de arrendamiento firmados.</li>
<li>La fianza de cada contrato aceptado se activa en la fecha y hora en que se complete la firma de esta acta. La fianza cubre exclusivamente las obligaciones causadas a partir de esa fecha; cualquier mora anterior, aunque no haya sido declarada, queda fuera de cobertura y sigue a cargo del arrendador.</li>
<li>La modalidad es Tradicional: la tarifa mensual indicada para cada contrato está a cargo de la inmobiliaria, sobre el canon sin IVA, más IVA. Los contratos marcados NO REPORTABLE no autorizan a ${e(d.empresa.name)} a reportar al arrendatario ante centrales de riesgo, y por eso su tarifa incluye un recargo.</li>
<li>Si se verifica que la declaración del numeral 1 es falsa respecto de un contrato, aplican en este orden los siguientes remedios:
  <ol type="a">
    <li>Exclusión de cobertura de ese contrato, automática y de pleno derecho: ese contrato nunca estuvo cubierto, sin necesidad de declaración previa de ${e(d.empresa.name)} ni de intervención judicial.</li>
    <li>Suspensión automática de nuevas migraciones de la inmobiliaria hasta decisión de la Gerencia General de ${e(d.empresa.name)}.</li>
    <li>Compensación de lo pagado por un contrato excluido contra cualquier suma que ${e(d.empresa.name)} le deba a la inmobiliaria, incluido el cashback de la modalidad Tradicional, en los términos del convenio de migración.</li>
    <li>Terminación del convenio por falta grave, conforme al convenio de inmobiliaria.</li>
    <li>Repetición judicial de lo pagado, como último recurso, cuando los remedios anteriores no alcancen a cubrir lo desembolsado.</li>
  </ol>
</li>
<li>${e(d.empresa.name)} puede exigir en cualquier momento, sobre cualquier contrato migrado, los extractos o soportes de recaudo de los ${m} meses anteriores a la migración. La inmobiliaria debe entregarlos dentro de los ${d.diasRespuestaAuditoria} días hábiles siguientes al requerimiento; si no los entrega en ese plazo, procede la exclusión de cobertura de ese contrato en los mismos términos del literal a) del numeral anterior.</li>
<li>Cualquier corrección de un contrato después de la firma de esta acta requiere un acta nueva.</li>
</ol>`;
}

/** Pura: el HTML del acta, con las anclas de firma de Auco (0 = rep. legal, 1 = Cofianza). */
export function htmlActa(d: DatosActa): string {
  const aceptados = d.filas.filter((r) => r.resultado !== 'rechazada');
  const rechazados = d.filas.filter((r) => r.resultado === 'rechazada');
  const habs = d.habilitaciones
    .map((h) => `${h.destinacion}${h.revisado_en ? ` (plantilla revisada el ${fecha(h.revisado_en)})` : ''}`)
    .join('; ');

  return `<!doctype html>
<html lang="es-CO"><head><meta charset="utf-8"><title>Acta de Migración ${e(d.lote.numero)}</title><style>${CSS}</style></head>
<body>
<h1>ACTA DE MIGRACIÓN DE CARTERA</h1>
<p class="sub">Lote ${e(d.lote.numero)} · Generada el ${e(fechaHoraBogota(d.generadaEn))} (hora de Colombia)</p>

<h2>1. Partes</h2>
<table class="datos">
<tr><td><strong>Fiador:</strong></td><td>${e(d.empresa.name)}, NIT ${e(d.empresa.nit)}, ${e(d.empresa.address)}</td></tr>
<tr><td><strong>Inmobiliaria:</strong></td><td>${e(d.inmobiliaria.nombre)} (identificador en la plataforma ${e(d.inmobiliaria.id)})</td></tr>
<tr><td><strong>Representante legal:</strong></td><td>${e(d.lote.rep_legal_nombre)}, documento ${e(d.lote.rep_legal_documento)}</td></tr>
<tr><td><strong>Convenio:</strong></td><td>Convenio de inmobiliaria vigente y convenio de migración firmado. Migración habilitada para: ${e(habs)}.</td></tr>
</table>

<h2>2. Contratos aceptados (${aceptados.length})</h2>
<p>Estos son los contratos que ${e(d.empresa.name)} activará con la firma de esta acta. Revise cada dato antes de firmar.</p>
${tablaAceptados(aceptados)}

<h2>3. Contratos rechazados (${rechazados.length})</h2>
<p>Estos contratos no quedan cubiertos. Pueden cargarse de nuevo, ya corregidos, en otro lote.</p>
${tablaRechazados(rechazados)}

<h2>4. Declaración de la inmobiliaria y remedios</h2>
${declaracion(d)}

<div class="firmas">
  <div class="firma">
    <span class="linea"><span class="ancla">{{signature:0}}</span></span>
    <p>${e(d.lote.rep_legal_nombre)}<br>Documento ${e(d.lote.rep_legal_documento)}<br>Representante legal de ${e(d.inmobiliaria.nombre)}</p>
  </div>
  <div class="firma">
    <span class="linea"><span class="ancla">{{signature:1}}</span></span>
    <p>${e(d.empresa.name)}<br>NIT ${e(d.empresa.nit)}</p>
  </div>
</div>
</body></html>`;
}

/** Renderiza el acta, la guarda en el bucket y devuelve su llave y su hash (SHA-256). */
export async function generarActa(d: DatosActa, loteId: string): Promise<{ storage_key: string; hash: string }> {
  const pdf = await renderHtmlToPdf(htmlActa(d));
  const storage_key = `migracion/${d.inmobiliaria.id}/lotes/${loteId}/acta.pdf`;
  const { error } = await supabase.storage.from(BUCKET).upload(storage_key, pdf, {
    contentType: 'application/pdf',
    upsert: false,
  });
  if (error) throw new AppError(500, 'STORAGE_ERROR', 'No se pudo guardar el Acta de Migración. Intente de nuevo.');
  return { storage_key, hash: createHash('sha256').update(pdf).digest('hex') };
}

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { PassThrough } from 'node:stream';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
// §10.1 — el CRC lleva "su numero, vigencia y condiciones economicas".
import { canonMaximoTolerado, PORTABILIDAD_TOLERANCIA_PCT } from './portabilidad';
import { resolverRuta } from './rutas-resultado';
import { MODELO_VERSION } from './motor';
// Adenda 1: tarifas por ruta (§5), factor de ajuste del ingreso (§1.1),
// fuentes consultadas (§2.4) y vigencia del panel (§6, §11).
import { calcularTarifas, leerTarifaOverride, viaPorRutaDeAprobacion, type Tarifas, type ViaAprobacion } from './tarifas';
// Adenda §5.2: la prima baja al 10% cuando HAY coarrendatario vinculado al
// expediente — no cuando el tipo de esta fila es 'con_coarrendatario'.
import { coarrendatarioVinculado, assertNoEsEstudioDeOtraPersona } from './coarrendatario-vinculado';
import { getCalibracion } from '@/lib/calibracion';
import { getCompany } from '@/lib/companyConfig';
import { assertExpedienteAccess } from '@/lib/tenantScope';

// ============================================================
// Constants
// ============================================================

const BUCKET_NAME = 'documentos-expedientes';
const RESULTADOS_CERTIFICABLES = ['aprobado', 'condicionado'];

/**
 * El estudio ya cumplio su vigencia: no se emite un certificado que naceria
 * vencido. Codigo propio (y no CONFLICT generico) porque la web y la
 * reasignacion del §4.3 discriminan por el.
 */
export const ESTUDIO_VENCIDO_ERROR_CODE = 'ESTUDIO_VENCIDO';

const RESULTADO_COLORS: Record<string, { bg: [number, number, number]; text: [number, number, number]; label: string }> = {
  aprobado: { bg: [220, 252, 231], text: [22, 101, 52], label: 'APROBADO' },
  condicionado: { bg: [254, 249, 195], text: [133, 77, 14], label: 'CONDICIONADO' },
};

const TEAL = [13, 148, 136] as const; // #0d9488

// ============================================================
// Helpers
// ============================================================

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value);
}

function formatPct(value: number): string {
  return `${value.toLocaleString('es-CO', { maximumFractionDigits: 2 })}%`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function maskName(nombre: string, apellido: string): string {
  const parts = nombre.split(' ');
  const first = parts[0] || '';
  return `${first} ****** ${apellido}`;
}

function maskDocumento(numero: string): string {
  if (numero.length <= 4) return '****';
  return '****' + numero.slice(-4);
}

function maskAddress(direccion: string): string {
  const parts = direccion.split(' ');
  if (parts.length <= 2) return '***';
  return parts[0] + ' ***';
}

// ============================================================
// generateCertificateCode
// ============================================================

export async function generateCertificateCode(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `CERT-${year}-`;

  const { data } = await (supabase
    .from('estudios_certificados' as string) as ReturnType<typeof supabase.from>)
    .select('codigo')
    .like('codigo', `${prefix}%`)
    .order('codigo', { ascending: false })
    .limit(1);

  let nextNum = 1;
  if (data && data.length > 0) {
    const lastCode = (data[0] as { codigo: string }).codigo;
    const lastNum = parseInt(lastCode.replace(prefix, ''), 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }

  return `${prefix}${String(nextNum).padStart(5, '0')}`;
}

// ============================================================
// generateQrCode
// ============================================================

export async function generateQrCode(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    width: 200,
    margin: 1,
    color: { dark: '#0d9488', light: '#ffffff' },
  });
}

// ============================================================
// generateCertificatePdf
// ============================================================

export interface CertificatePdfData {
  codigo: string;
  fechaEmision: string;
  fechaVencimiento: string;
  // Solicitante
  solicitanteNombre: string;
  solicitanteApellido: string;
  solicitanteTipoDoc: string;
  solicitanteNumDoc: string;
  solicitanteEmail: string;
  solicitanteTelefono: string;
  tipoEstudio: string;
  // Inmueble
  inmuebleDireccion: string;
  inmuebleCiudad: string;
  inmuebleDepartamento: string;
  inmuebleTipo: string;
  inmuebleUso: string;
  inmuebleEstrato: number | null;
  inmuebleValorArriendo: number | null;
  inmuebleArea: number | null;
  inmuebleCodigo: string | null;
  // Resultado
  resultado: string;
  score: number | null;
  proveedor: string;
  fechaEstudio: string;
  duracionContrato: number | null;
  observaciones: string | null;
  condiciones: string | null;
  // §10.1 — "Certificado de Riesgo Cofianza (CRC) descargable, con su numero,
  // vigencia y CONDICIONES ECONOMICAS."
  canonEvaluado: number | null;
  canonMaximoTolerado: number | null;
  requiereAcompanante: boolean;
  /** Hay un coarrendatario que ya acepto y tiene su propio estudio (Adenda §5.2). */
  coarrendatarioVinculado: boolean;
  rutaEtiqueta: string | null;
  modeloVersion: string;
  // Adenda §5: tarifa mensual, prima de vinculacion y cashback por ruta.
  tarifas: Tarifas | null;
  // Adenda §1.1: "el CRC [...] debe registrar el valor del factor aplicado".
  factorAjusteIngreso: number | null;
  // Adenda §2.4: "que centrales se consultaron y cual fue la decision de cascada".
  fuentesConsultadas: string | null;
  decisionCascada: string | null;
  // Adenda 2 §4.3: denominador del puntaje y variables que participaron.
  denominadorPuntaje?: string | null;
  // Adenda 1 contratos, respuesta 19: relacion canon/ingreso de la evaluacion,
  // con el ingreso que dio la central. null = no verificable (TransUnion no lo
  // da y el declarado nunca la alimenta).
  canonIngresoPct: number | null;
  /**
   * Adenda 1 contratos, respuesta 5: versión sin puntaje ni observaciones (ver
   * sinPuntaje). La del arrendatario también la lleva, con su score (P13).
   */
  paraFirmantes?: boolean;
}

/**
 * Adenda 1 del módulo de contratos, respuesta 5: el CRC que va al paquete de
 * firma no lleva puntaje ni observaciones.
 * Sale todo lo que lo revela: el score del buró, el perfil ("Aprobado
 * automatico (87 pts)"), la decisión de cascada ("puntaje 92 >= 90…") y el
 * denominador. Mismo criterio que redactarEstudioParaProspecto. Las
 * condiciones del analista cuentan como observaciones (A10).
 */
export function sinPuntaje(data: CertificatePdfData): CertificatePdfData {
  return {
    ...data,
    score: null,
    observaciones: null,
    condiciones: null,
    rutaEtiqueta: null,
    decisionCascada: null,
    denominadorPuntaje: null,
    paraFirmantes: true,
  };
}

/**
 * P13 (Ley 1266): el arrendatario conoce SU puntaje. Baja la versión para
 * firmantes con su score y sus condiciones, que ya ve en la plataforma. El
 * perfil con puntos, la cascada, el denominador y las observaciones siguen fuera.
 */
export function paraArrendatario(data: CertificatePdfData): CertificatePdfData {
  return { ...sinPuntaje(data), score: data.score, condiciones: data.condiciones };
}

export async function generateCertificatePdf(
  data: CertificatePdfData,
  qrBuffer: Buffer,
): Promise<Buffer> {
  // Sin sello para el resultado no hay certificado (antes caia en APROBADO).
  const rc = RESULTADO_COLORS[data.resultado];
  if (!rc) {
    throw AppError.conflict(
      'Solo se puede generar certificado para estudios aprobados o condicionados',
      'ESTUDIO_NO_CERTIFICABLE',
    );
  }
  const company = await getCompany();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const passthrough = new PassThrough();
    const chunks: Buffer[] = [];

    passthrough.on('data', (chunk: Buffer) => chunks.push(chunk));
    passthrough.on('end', () => resolve(Buffer.concat(chunks)));
    passthrough.on('error', reject);
    doc.pipe(passthrough);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - 100; // 50 margin each side

    // ---- WATERMARK ----
    doc.save();
    doc.rotate(-45, { origin: [pageWidth / 2, doc.page.height / 2] });
    doc.fontSize(60).fillColor('#e5e7eb').opacity(0.3);
    doc.text('COPIA DIGITAL', 80, doc.page.height / 2 - 30, { align: 'center' });
    doc.restore();
    doc.opacity(1);

    // ---- HEADER ----
    const headerHeight = 90;
    doc.rect(50, 50, contentWidth, headerHeight).fill(TEAL as unknown as string);

    // Logo monogram (Cofianza)
    doc.fontSize(32).fillColor('#ffffff').font('Helvetica-Bold');
    doc.text('C', 70, 62);

    // Company info
    doc.fontSize(9).font('Helvetica').fillColor('#ffffff');
    doc.text(company.name, 120, 62);
    doc.text(`NIT: ${company.nit}`, 120, 74);
    doc.text(company.address, 120, 86);
    doc.text(`${company.phone} | ${company.email}`, 120, 98);

    // Title
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#ffffff');
    doc.text('CERTIFICADO DE RIESGO COFIANZA (CRC)', 50, 118, {
      width: contentWidth,
      align: 'center',
    });

    let y = 50 + headerHeight + 15;

    // §10.1 pide que el CRC lleve "su numero, vigencia y condiciones
    // economicas". El numero y la vigencia iban antes en 9pt y en el pie en
    // 7pt: quien recibe el certificado no los encontraba. Ahora abren el
    // documento, que es donde el documento los pone.
    doc.roundedRect(50, y, contentWidth, 46, 4).fill('#f0fdfa');
    doc.fontSize(8).font('Helvetica').fillColor('#6b7280');
    doc.text('NÚMERO DEL CERTIFICADO', 60, y + 8);
    doc.text('VIGENTE HASTA', 60 + contentWidth / 2, y + 8);
    doc.fontSize(13).font('Helvetica-Bold').fillColor(TEAL as unknown as string);
    doc.text(data.codigo, 60, y + 21);
    doc.text(formatDate(data.fechaVencimiento), 60 + contentWidth / 2, y + 21);
    y += 54;

    doc.fontSize(9).font('Helvetica').fillColor('#374151');
    doc.text(`Fecha de emisión: ${formatDate(data.fechaEmision)}`, 50, y, {
      width: contentWidth,
      align: 'right',
    });

    y += 20;

    if (data.paraFirmantes) {
      doc.fontSize(8).font('Helvetica-Oblique').fillColor('#6b7280');
      // La del arrendatario lleva su score (P13): no se dice que falta.
      doc.text(
        data.score != null
          ? 'Esta versión no incluye las observaciones de la evaluación.'
          : 'Esta versión no incluye el puntaje ni las observaciones de la evaluación.',
        50,
        y,
        { width: contentWidth },
      );
      y += 16;
    }

    // ---- SECTION: SOLICITANTE ----
    y = drawSectionTitle(doc, 'DATOS DEL SOLICITANTE', y, contentWidth);
    const solicitanteRows = [
      ['Nombre completo', `${data.solicitanteNombre} ${data.solicitanteApellido}`],
      ['Tipo de documento', data.solicitanteTipoDoc.toUpperCase()],
      ['Número de documento', data.solicitanteNumDoc],
      ['Email', data.solicitanteEmail],
      ['Teléfono', data.solicitanteTelefono],
      ['Tipo de estudio', data.tipoEstudio === 'individual' ? 'Individual' : 'Con coarrendatario'],
    ];
    y = drawTable(doc, solicitanteRows, y, contentWidth);

    y += 10;

    // ---- SECTION: INMUEBLE ----
    y = drawSectionTitle(doc, 'DATOS DEL INMUEBLE', y, contentWidth);
    const inmuebleRows = [
      ['Dirección', data.inmuebleDireccion],
      ['Ciudad / Departamento', `${data.inmuebleCiudad}, ${data.inmuebleDepartamento}`],
      ['Tipo', data.inmuebleTipo],
      ['Uso', data.inmuebleUso],
    ];
    if (data.inmuebleEstrato) inmuebleRows.push(['Estrato', String(data.inmuebleEstrato)]);
    if (data.inmuebleValorArriendo) inmuebleRows.push(['Canon de arriendo', formatCurrency(data.inmuebleValorArriendo)]);
    if (data.inmuebleArea) inmuebleRows.push(['Área (m²)', String(data.inmuebleArea)]);
    if (data.inmuebleCodigo) inmuebleRows.push(['Código del inmueble', data.inmuebleCodigo]);
    y = drawTable(doc, inmuebleRows, y, contentWidth);

    y += 10;

    // ---- SECTION: RESULTADO ----
    y = drawSectionTitle(doc, 'RESULTADO DEL ESTUDIO', y, contentWidth);

    // Result badge
    doc.roundedRect(50, y, 160, 28, 4).fill(rc.bg as unknown as string);
    doc.fontSize(12).font('Helvetica-Bold').fillColor(rc.text as unknown as string);
    doc.text(rc.label, 55, y + 7, { width: 150, align: 'center' });
    y += 36;

    const resultRows = [];
    if (data.score != null) resultRows.push(['Score', String(data.score)]);
    resultRows.push(['Proveedor', data.proveedor]);
    resultRows.push(['Fecha del estudio', formatDate(data.fechaEstudio)]);
    if (data.duracionContrato != null) resultRows.push(['Duración del contrato', `${data.duracionContrato} meses`]);
    if (data.rutaEtiqueta) resultRows.push(['Perfil', data.rutaEtiqueta]);
    if (data.observaciones) resultRows.push(['Observaciones', data.observaciones]);
    if (data.condiciones) resultRows.push(['Condiciones', data.condiciones]);
    y = drawTable(doc, resultRows, y, contentWidth);

    y += 10;

    // ---- SECTION: CONDICIONES DEL CERTIFICADO (§10.1) ----
    //
    // El §10.1 pide "condiciones economicas". Aqui va lo que el sistema SI
    // conoce: sobre que canon se evaluo y hasta que canon sigue sirviendo este
    // mismo CRC. El VALOR DE LA PRIMA no aparece porque no existe todavia en
    // el sistema — no hay modelo de precios — y ponerlo inventado seria peor
    // que omitirlo en un documento que el cliente puede oponer.
    if (data.canonEvaluado != null) {
      // titulo (22) + hasta 10 filas (~22 c/u) + el parrafo de tolerancia (~32).
      y = asegurarEspacio(doc, y, 22 + 10 * 22 + 32);
      y = drawSectionTitle(doc, 'CONDICIONES DEL CERTIFICADO', y, contentWidth);
      const condRows: string[][] = [
        ['Canon evaluado', formatCurrency(data.canonEvaluado)],
      ];
      if (data.canonMaximoTolerado != null) {
        condRows.push(['Canon máximo amparado', formatCurrency(data.canonMaximoTolerado)]);
      }
      condRows.push([
        'Acompañante',
        data.coarrendatarioVinculado
          ? 'Vinculado: este CRC ampara el contrato presentado con coarrendatario'
          : data.requiereAcompanante
            ? 'Requerido: este CRC ampara el contrato presentado con coarrendatario'
            : 'No requerido',
      ]);
      // Adenda §5 — tarifas y primas por ruta de aprobacion.
      if (data.tarifas) {
        const t = data.tarifas;
        // La via deja inferir la banda del puntaje: la version para firmantes no la lleva.
        const via = data.paraFirmantes
          ? ''
          : t.via === 'automatica'
            ? ' (aprobación automática)'
            : t.via === 'condicionada_coarrendatario'
              ? ' (aprobación condicionada con coarrendatario)'
              : ' (aprobación tras revisión manual)';
        // Adenda 1 contratos §1.1: la prima y la tarifa causan IVA, siempre
        // (TARIFA_IVA del panel), sobre el canon sin IVA.
        const masIva = (base: number | null, conIva: number | null) =>
          base == null || conIva == null
            ? ''
            : `: ${formatCurrency(base)} + IVA del ${formatPct(t.iva_pct)} = ${formatCurrency(conIva)}`;
        const primaConIva =
          t.prima_vinculacion_cop == null ? null : Math.round(t.prima_vinculacion_cop * (1 + t.iva_pct / 100));
        condRows.push([
          'Tarifa mensual de la fianza',
          `${formatPct(t.tarifa_mensual_pct)} del canon más IVA${via}` +
            masIva(t.tarifa_mensual_cop, t.tarifa_mensual_con_iva_cop) +
            (t.negociada ? ' — condiciones especiales autorizadas' : ''),
        ]);
        condRows.push([
          'Prima de vinculación',
          `${formatPct(t.prima_vinculacion_pct)} del canon más IVA, pago único al activar` +
            masIva(t.prima_vinculacion_cop, primaConIva),
        ]);
        condRows.push([
          'Cashback',
          `${t.cashback_pct}% de las tarifas mensuales pagadas, al terminar sin moras (no aplica sobre la prima)`,
        ]);
      }
      y = drawTable(doc, condRows, y, contentWidth);

      // Parrafo del §8 de la Politica V4.1 (TOLERANCIA DE CANON DEL CRC),
      // parafraseado. Va aqui y no en el pie porque define CUANDO este
      // certificado deja de servir, que es justo lo que el arrendador necesita
      // saber antes de firmar.
      doc.fontSize(7).font('Helvetica').fillColor('#6b7280');
      doc.text(
        `Este certificado ampara contratos cuyo canon no supere en más de ${PORTABILIDAD_TOLERANCIA_PCT}% el canon evaluado` +
          (data.canonIngresoPct == null
            ? '. La relación canon/ingreso no se recalcula porque no fue verificable. '
            : ', siempre que la relación canon/ingreso recalculada se mantenga en o por debajo del 40%. ') +
          'Si el canon excede esa tolerancia se requiere una nueva evaluación.',
        50,
        y + 4,
        { width: contentWidth },
      );
      y += 32;
    }

    y += 10;

    // ---- SECTION: TRAZABILIDAD (Adenda §2.4, §1.1; Politica §8) ----
    //
    // Antes vivia dentro del bloque de condiciones y desaparecia con el: un
    // estudio sin canon congelado (registro manual antiguo) salia sin fuentes,
    // sin factor y sin version del modelo, que la Politica §8 exige "en cada
    // CRC emitido". Ahora imprime siempre.
    const trazaRows: string[][] = [];
    if (data.fuentesConsultadas) trazaRows.push(['Fuentes consultadas', data.fuentesConsultadas]);
    if (data.decisionCascada) trazaRows.push(['Decisión de cascada', data.decisionCascada]);
    if (data.denominadorPuntaje) trazaRows.push(['Denominador del puntaje', `${data.denominadorPuntaje} (Adenda 2 §4.3)`]);
    // Adenda 1 contratos, respuesta 19: que la decision quede trazada tambien
    // sin ingreso verificado. La cifra deja ver el ingreso del arrendatario:
    // la version para firmantes no la lleva.
    if (data.canonIngresoPct == null) {
      trazaRows.push(['Relación canon/ingreso', 'No verificable (no se contó con ingreso verificado)']);
    } else if (!data.paraFirmantes) {
      trazaRows.push(['Relación canon/ingreso', formatPct(data.canonIngresoPct)]);
    }
    if (data.factorAjusteIngreso != null && data.factorAjusteIngreso !== 1) {
      trazaRows.push(['Factor de ajuste de ingreso', `x${data.factorAjusteIngreso} (Adenda 1 §1.1)`]);
    }
    trazaRows.push(['Versión del modelo', data.modeloVersion]);
    y = asegurarEspacio(doc, y, 22 + trazaRows.length * 22);
    y = drawSectionTitle(doc, 'TRAZABILIDAD DE LA EVALUACIÓN', y, contentWidth);
    y = drawTable(doc, trazaRows, y, contentWidth);

    y += 15;

    // ---- SECTION: QR + VERIFICACION ----
    // QR (110) y pie (~70) van juntos: sin esto el pie se partia y quedaba una
    // pagina con una sola linea.
    y = asegurarEspacio(doc, y, 180);
    const verificationUrl = `${env.FRONTEND_URL}/verificar/${data.codigo}`;

    doc.image(qrBuffer, 50, y, { width: 100, height: 100 });

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#374151');
    doc.text('Verificación de autenticidad', 165, y);
    doc.fontSize(8).font('Helvetica').fillColor('#6b7280');
    doc.text(
      'Escanee el código QR o visite la siguiente URL para verificar la autenticidad de este certificado:',
      165,
      y + 14,
      { width: contentWidth - 115 },
    );
    doc.fontSize(8).font('Helvetica').fillColor(TEAL as unknown as string);
    doc.text(verificationUrl, 165, y + 38, { width: contentWidth - 115 });

    y += 110;

    // ---- FOOTER ----
    doc.moveTo(50, y).lineTo(50 + contentWidth, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
    y += 10;

    doc.fontSize(7).font('Helvetica').fillColor('#9ca3af');
    doc.text(`Válido hasta: ${formatDate(data.fechaVencimiento)}`, 50, y);
    y += 12;
    doc.text(
      'Este certificado es generado electrónicamente por Cofianza S.A.S. y tiene validez como documento informativo. ' +
      'La información contenida proviene de centrales de riesgo crediticio autorizadas. ' +
      'Para verificar su autenticidad, escanee el código QR o visite la URL indicada.',
      50,
      y,
      { width: contentWidth },
    );
    y += 30;
    doc.text(`${company.name} | NIT: ${company.nit} | ${company.website}`, 50, y, {
      width: contentWidth,
      align: 'center',
    });

    doc.end();
  });
}

// ---- PDF Drawing Helpers ----

/**
 * Evita el titulo huerfano: si en lo que queda de pagina no cabe el bloque,
 * salta antes de dibujarlo. Sin esto el encabezado "CONDICIONES DEL
 * CERTIFICADO" quedaba solo al pie de la pagina 1 y su tabla arrancaba en la 2.
 *
 * ponytail: el alto se estima, no se mide. pdfkit no sabe cuanto va a ocupar
 * una tabla hasta dibujarla, y medir de verdad exigiria renderizar dos veces.
 */
function asegurarEspacio(doc: PDFKit.PDFDocument, y: number, altoNecesario: number): number {
  const limite = doc.page.height - 60;
  if (y + altoNecesario <= limite) return y;
  doc.addPage();
  return 50;
}

function drawSectionTitle(doc: PDFKit.PDFDocument, title: string, y: number, width: number): number {
  doc.rect(50, y, width, 22).fill('#f3f4f6');
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#1f2937');
  doc.text(title, 58, y + 6);
  return y + 28;
}

function drawTable(doc: PDFKit.PDFDocument, rows: string[][], startY: number, width: number): number {
  let y = startY;
  const labelWidth = 160;

  for (const [label, value] of rows) {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#6b7280');
    doc.text(label, 58, y, { width: labelWidth });
    doc.fontSize(8).font('Helvetica').fillColor('#374151');
    doc.text(value || '-', 58 + labelWidth, y, { width: width - labelWidth - 16 });
    // Un valor de dos o mas lineas empuja la fila siguiente (antes se montaban).
    y = Math.max(y + 16, doc.y + 6);
  }

  return y;
}

// ============================================================
// generarCertificado (orchestrator)
// ============================================================

/**
 * Ultima corrida del motor para el estudio. Sin fila (estudio anterior al
 * motor) el CRC sale igual, sin factor ni puntaje. Un error de lectura se
 * lanza: con null el CRC diria "no verificable" y quitaria el 40% por un
 * fallo de la base, no porque no hubiera ingreso.
 */
export async function leerSombraDelEstudio(
  estudioId: string,
): Promise<{
  puntaje: number | null;
  factor: number | null;
  modeloVersion: string | null;
  denominador: string | null;
  canonIngresoPct: number | null;
} | null> {
  const { data, error } = await (supabase
    .from('estudios_scorecard_sombra' as string) as ReturnType<typeof supabase.from>)
    .select('puntaje_normalizado, factor_ajuste_ingreso, modelo_version, features_crudas, canon_ingreso_ajustado_pct')
    .eq('estudio_id', estudioId)
    .order('fecha_calculo', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error({ estudioId, error: error.message }, 'CRC: no se pudo leer la corrida del motor');
    throw new AppError(503, 'LECTURA_NO_VERIFICABLE', 'No pudimos leer la evaluación del estudio. Intenta de nuevo en un momento.');
  }
  const row = data as { puntaje_normalizado?: number | string | null; factor_ajuste_ingreso?: number | string | null; modelo_version?: string | null; features_crudas?: Record<string, unknown> | null; canon_ingreso_ajustado_pct?: number | string | null } | null;
  if (!row) return null;
  const num = (v: unknown) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  // Adenda 2 §4.3: "el CRC [...] debe indicar el denominador aplicado y que
  // variables participaron". Las corridas anteriores a la Adenda 2 no lo traen.
  // Si un analista resolvio la revision manual, manda su recalculo (con V7/V9).
  const rm = row.features_crudas?.revision_manual as Record<string, unknown> | undefined;
  const den = num(rm?.denominador ?? row.features_crudas?.denominador_normalizacion);
  const vars = rm?.variables_participantes ?? row.features_crudas?.variables_participantes;
  const denominador = den && Array.isArray(vars)
    ? `${den} puntos (${vars.join(', ')})${rm ? ' — recalculado en revisión manual' : ''}`
    : null;
  const puntaje = rm ? num(rm.puntaje_normalizado) : num(row.puntaje_normalizado);
  return {
    puntaje,
    factor: num(row.factor_ajuste_ingreso),
    modeloVersion: row.modelo_version ?? null,
    denominador,
    // Sobre el ingreso ajustado por el factor (Adenda 1 §1.1): con el que decide
    // el motor y el unico que usa el asistente de contratos al recalcular. Una
    // corrida anterior al factor solo trae el crudo: sale no verificable, igual
    // que en el asistente.
    canonIngresoPct: num(row.canon_ingreso_ajustado_pct),
  };
}

/**
 * Adenda 2 §6: la via de aprobacion (fila de la tabla de tarifas) segun COMO
 * se aprobo. Insumos de viaPorRutaDeAprobacion: la traza del motor, el
 * resultado que dejo el buro, si hubo reporte de central (un resultado
 * registrado a mano no trae referencia del proveedor) y si el expediente paso
 * a aprobado por la ponderacion con coarrendatario (evento del timeline).
 * Una sola definicion para el CRC y para GET /estudios/:id/tarifa.
 */
export async function viaDelEstudio(e: {
  expediente_id: string;
  resultado: string | null;
  referencia_proveedor?: string | null;
  cascada?: unknown;
}): Promise<ViaAprobacion> {
  const { data: ponderacion } = await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('expediente_id', e.expediente_id)
    .eq('estado_nuevo', 'aprobado')
    .eq('metadata->>origen', 'ponderacion_coarrendatario')
    .limit(1);
  const cascada = e.cascada && typeof e.cascada === 'object' ? (e.cascada as Record<string, unknown>) : null;
  return viaPorRutaDeAprobacion({
    aprobadoPorPonderacion: Array.isArray(ponderacion) && ponderacion.length > 0,
    viaMotor: cascada?.via ?? null,
    resultadoEstudio: e.resultado,
    conReporteDeCentral: !!e.referencia_proveedor,
  });
}

export async function generarCertificado(
  estudioId: string,
  userId: string,
  ip?: string,
  userRol?: string,
) {
  // 1. Deep join: estudio → expediente → solicitante + inmueble
  const e = await leerEstudioCrc(estudioId);

  // Tenant guard: genera + persiste el PDF del certificado (con datos del
  // solicitante y del inmueble) para este estudio. Sin scoping, la inmobiliaria
  // (rol externo con expedientes:update) generaba certificados de estudios de
  // OTRA agencia por UUID (write-IDOR). No-op para roles internos.
  await assertExpedienteAccess(e.expediente_id as string, userId, userRol);

  // 2. Validate
  assertCertificable(e);

  // 2.b VIGENCIA DEL ESTUDIO — el guard que faltaba.
  //
  //      La vigencia se ancla en `fecha_completado` (ver el paso 5), asi que un
  //      estudio mas viejo que la ventana produce un `fecha_vencimiento`
  //      ANTERIOR a la emision: un PDF que se declara vencido antes de existir
  //      ("Fecha de emision: hoy / Valido hasta: hace tres semanas") y que
  //      /verificar/<codigo> marca 'valido_vencido' en el primer escaneo del QR.
  //      Emitirlo en silencio es entregarle al arrendador un documento inutil,
  //      asi que se bloquea aqui, con la salida que manda el §13.
  //
  //      Va ANTES del paso 3 a proposito: alli la regeneracion BORRA el PDF
  //      anterior del storage, y fallar despues dejaria al estudio sin
  //      certificado descargable.
  // Adenda §6: vigencia del CRC desde el panel de calibracion (60 dias).
  const validezDias = (await getCalibracion()).VIGENCIA_CRC_DIAS;
  const validezMs = validezDias * 24 * 60 * 60 * 1000;
  const fechaEmisionMs = Date.now();
  const fechaCompletado = e.fecha_completado as string | null;
  // Fallback a `now` cuando el estudio no tiene fecha_completado (registro
  // manual antiguo): ahi no hay corrida en que anclarse y el comportamiento es
  // el de siempre — nace vigente.
  const completadoMs = fechaCompletado ? new Date(fechaCompletado).getTime() : Number.NaN;
  const inicioVigenciaMs = Number.isFinite(completadoMs) ? completadoMs : fechaEmisionMs;

  if (inicioVigenciaMs + validezMs <= fechaEmisionMs) {
    throw AppError.conflict(
      `Este estudio se completo el ${formatDate(new Date(inicioVigenciaMs).toISOString())} y ya cumplio su ` +
        `vigencia de ${validezDias} dias, asi que el certificado naceria vencido. ` +
        'Para certificar esta propiedad se requiere una evaluacion nueva.',
      ESTUDIO_VENCIDO_ERROR_CODE,
    );
  }

  if (!e.expedientes) {
    throw AppError.badRequest('La evaluación no tiene estudio asociado', 'ESTUDIO_SIN_EXPEDIENTE');
  }

  // 3. Check if certificate already exists (regenerate)
  const { data: existing } = await (supabase
    .from('estudios_certificados' as string) as ReturnType<typeof supabase.from>)
    .select('id, codigo, version, pdf_storage_key')
    .eq('estudio_id', estudioId)
    .single();

  const existingCert = existing as { id: string; codigo: string; version: number; pdf_storage_key: string } | null;
  let codigo: string;
  let version: number;

  if (existingCert) {
    codigo = existingCert.codigo;
    version = existingCert.version + 1;
    // El PDF anterior NO se borra (Contratos V3, Entrega 3): un contrato puede
    // citar esa version del CRC ("CRC N° … del {fecha_emision}") y su snapshot
    // guarda pdf_storage_key. Cada version tiene su propia llave (uuid), asi que
    // conservarlo no pisa nada.
  } else {
    codigo = await generateCertificateCode();
    version = 1;
  }

  // 4. Generate QR
  const verificationUrl = `${env.FRONTEND_URL}/verificar/${codigo}`;
  const qrBuffer = await generateQrCode(verificationUrl);

  // 5. Dates
  //
  //    La vigencia se ancla en `estudios.fecha_completado` (cuando el dato del
  //    buro estuvo vigente), NO en la emision del certificado.
  //
  //    Es lo que hace estructural la promesa del Flujo §4.3: "el estudio
  //    conserva su vigencia original; la reutilizacion no la extiende". Con el
  //    calculo anterior (emision + N dias), bastaba con reasignar el estudio a
  //    otra propiedad y regenerar el certificado para ganar 60 dias nuevos —
  //    justo por la puerta de atras que el documento cierra. Anclado en la
  //    corrida, regenerar el PDF (version+1) reimprime el mismo vencimiento.
  //
  //    Fallback a `now` solo si el estudio no tiene fecha_completado (registro
  //    manual antiguo): ahi no hay corrida en que anclarse y el comportamiento
  //    es el de siempre.
  //    Los dos instantes ya se resolvieron en el paso 2.b, que es donde se
  //    verifica que el estudio siga vigente. Recalcularlos aqui abriria la
  //    puerta a que el guard mirara un numero y el PDF imprimiera otro.
  const fechaEmision = new Date(fechaEmisionMs).toISOString();
  const fechaVencimiento = new Date(inicioVigenciaMs + validezMs).toISOString();

  // 6. Generate PDF: el completo y, con los mismos datos, el de los firmantes.
  const pdfData = await datosDelCrc(e, { codigo, fecha_emision: fechaEmision, fecha_vencimiento: fechaVencimiento });

  const pdfBuffer = await generateCertificatePdf(pdfData, qrBuffer);
  const pdfFirmantes = await generateCertificatePdf(sinPuntaje(pdfData), qrBuffer);

  // 7. Upload to storage
  const storageKey = `estudios/${estudioId}/certificado/${crypto.randomUUID()}.pdf`;
  const { error: uploadErr } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storageKey, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadErr) {
    logger.error({ error: uploadErr, estudioId }, 'Error uploading certificate PDF');
    throw new AppError(500, 'INTERNAL_ERROR','Error al subir el certificado PDF');
  }

  // Si esta falla, crcParaFirmantes la genera cuando alguien la pida.
  const { error: uploadFirmantesErr } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(llaveDeVersion(storageKey, 'firmantes'), pdfFirmantes, { contentType: 'application/pdf', upsert: false });
  if (uploadFirmantesErr) {
    logger.warn({ error: uploadFirmantesErr, estudioId }, 'CRC: no se subió la versión para firmantes; se generará al pedirla');
  }

  // 8. Upsert estudios_certificados
  const certData = {
    estudio_id: estudioId,
    codigo,
    pdf_storage_key: storageKey,
    fecha_emision: fechaEmision,
    fecha_vencimiento: fechaVencimiento,
    emitido_por: userId,
    version,
  };

  let certificadoId: string;

  if (existingCert) {
    const { error: updateErr } = await (supabase
      .from('estudios_certificados' as string) as ReturnType<typeof supabase.from>)
      .update(certData as never)
      .eq('id', existingCert.id);

    if (updateErr) {
      logger.error({ error: updateErr, estudioId }, 'Error updating certificate record');
      throw new AppError(500, 'INTERNAL_ERROR','Error al actualizar el registro del certificado');
    }
    certificadoId = existingCert.id;
  } else {
    const { data: inserted, error: insertErr } = await (supabase
      .from('estudios_certificados' as string) as ReturnType<typeof supabase.from>)
      .insert(certData as never)
      .select('id')
      .single();

    if (insertErr || !inserted) {
      logger.error({ error: insertErr, estudioId }, 'Error inserting certificate record');
      throw new AppError(500, 'INTERNAL_ERROR','Error al crear el registro del certificado');
    }
    certificadoId = (inserted as { id: string }).id;
  }

  // 9. Update estudios.certificado_url and codigo_qr
  await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .update({ certificado_url: storageKey, codigo_qr: codigo } as never)
    .eq('id', estudioId);

  // 10. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CERTIFICADO_GENERATED,
    entidad: AUDIT_ENTITIES.CERTIFICADO,
    entidadId: certificadoId,
    detalle: { estudioId, codigo, version },
    ip,
  });

  // 11. Return
  return {
    id: certificadoId,
    estudio_id: estudioId,
    codigo,
    pdf_storage_key: storageKey,
    fecha_emision: fechaEmision,
    fecha_vencimiento: fechaVencimiento,
    version,
  };
}

/**
 * Compuertas de la emision. Tambien las pasa la version para firmantes que se
 * genera a demanda: con el estudio de hoy pendiente, rechazado o negado por el
 * analista, regenerar imprimiria un resultado que ya no es.
 */
function assertCertificable(e: Record<string, unknown>): void {
  // Los datos de la persona salen del expediente (el titular): con la fila del
  // co-arrendatario salia un CRC a nombre del titular con el resultado y el
  // score de otra persona, verificable por QR.
  if (e.tipo === 'con_coarrendatario') {
    throw AppError.conflict(
      'El certificado se emite sobre el estudio del titular; la evaluación del co-arrendatario ya se refleja en él.',
      'ESTUDIO_COARRENDATARIO_NO_CERTIFICABLE',
    );
  }
  if (e.estado !== 'completado') {
    throw AppError.conflict('El estudio debe estar completado para generar certificado', 'ESTUDIO_NO_COMPLETADO');
  }
  if (!RESULTADOS_CERTIFICABLES.includes(e.resultado as string)) {
    throw AppError.conflict(
      'Solo se puede generar certificado para estudios aprobados o condicionados',
      'ESTUDIO_NO_CERTIFICABLE',
    );
  }
  // El analista niega un condicionado cambiando solo el expediente: el estudio
  // se queda 'condicionado' (mismo criterio que resultadoEfectivo de estudios.service).
  const exp = e.expedientes as { estado?: string | null; estado_pre_cancelacion?: string | null } | null;
  if (exp?.estado === 'rechazado' || (exp?.estado === 'cerrado' && exp.estado_pre_cancelacion === 'rechazado')) {
    throw AppError.conflict(
      'El estudio quedó no aprobable tras la revisión de Cofianza, así que no se genera certificado.',
      'ESTUDIO_NO_CERTIFICABLE',
    );
  }
}

/** Deep join: estudio → expediente → solicitante + inmueble. */
async function leerEstudioCrc(estudioId: string): Promise<Record<string, unknown>> {
  const { data: estudio, error: estudioErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      *,
      expedientes!estudios_expediente_id_fkey(
        numero, estado, estado_pre_cancelacion, duracion_contrato_meses,
        solicitantes!expedientes_solicitante_id_fkey(
          nombre, apellido, tipo_documento, numero_documento, email, telefono
        ),
        inmuebles!expedientes_inmueble_id_fkey(
          direccion, ciudad, departamento, tipo, uso, estrato, valor_arriendo, area_m2, codigo
        )
      )
    `)
    .eq('id', estudioId)
    .single();

  if (estudioErr || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }
  return estudio as Record<string, unknown>;
}

/**
 * Lo que imprime el CRC, del estudio leido con leerEstudioCrc. Lo usan la
 * emision y la version para firmantes que se genera a demanda.
 */
async function datosDelCrc(
  e: Record<string, unknown>,
  cert: { codigo: string; fecha_emision: string; fecha_vencimiento: string },
): Promise<CertificatePdfData> {
  const estudioId = e.id as string;
  const expediente = e.expedientes as Record<string, unknown> | null;
  if (!expediente) {
    throw AppError.badRequest('La evaluación no tiene estudio asociado', 'ESTUDIO_SIN_EXPEDIENTE');
  }
  const solicitante = (expediente.solicitantes as Record<string, unknown>) || {};
  const inmueble = (expediente.inmuebles as Record<string, unknown>) || {};

  // §10 — la ruta del resultado, para imprimir el perfil y saber si el CRC
  // ampara un contrato con acompañante. Sin puntaje: el scorecard sigue en
  // sombra (ver adjuntarRuta en estudios.service.ts).
  const reglasDuras = e.regla_dura_activada;
  const cal = await getCalibracion();
  // Corrida del motor de ESTE estudio: puntaje (solo cuando el motor decide),
  // factor de ajuste aplicado y fuente del score. La ultima por fecha.
  const sombra = await leerSombraDelEstudio(estudioId);
  const usaPuntaje = env.MOTOR_DECIDE_ENABLED || env.MOTOR_RUTA_USA_SCORECARD;
  const puntajeCrc = usaPuntaje ? (sombra?.puntaje ?? null) : null;
  // Adenda §5.2 / §3: el coarrendatario es una fila de expediente_coarrendatarios
  // con su propio estudio, no el `tipo` de esta fila (ver coarrendatario-vinculado.ts).
  const coa = await coarrendatarioVinculado(e.expediente_id as string);
  const conCoarrendatario = coa !== null;
  const puntajeCoa = usaPuntaje ? (coa?.puntaje ?? null) : null;
  // El estudio guarda lo que dijo el buro/motor; la decision de Cofianza es
  // la del expediente. Un 'condicionado' cuyo expediente ya esta 'aprobado'
  // (analista en revision manual, o ponderacion con coarrendatario) se
  // certifica como aprobado: un CRC que diga CONDICIONADO / "en revision"
  // sobre un contrato que Cofianza ya respalda es un documento que miente.
  const resultadoEfectivo: 'aprobado' | 'condicionado' =
    e.resultado === 'condicionado' && expediente.estado === 'aprobado' ? 'aprobado' : (e.resultado as 'aprobado' | 'condicionado');
  const umbrales = {
    aprobacion: cal.UMBRAL_APROBACION_AUTOMATICA,
    zonaGris: cal.UMBRAL_ZONA_GRIS,
    coarrendatario: cal.UMBRAL_COARRENDATARIO,
  };
  const rutaCrc = resolverRuta({
    puntaje: puntajeCrc,
    resultadoVigente: resultadoEfectivo,
    reglaDuraActivada: Array.isArray(reglasDuras) ? reglasDuras.length > 0 : Boolean(reglasDuras),
    coarrendatarioVinculado: conCoarrendatario,
    puntajeCoarrendatario: puntajeCoa,
    umbrales,
  });

  // Adenda 2 §6: la fila de la tabla de tarifas segun la ruta de aprobacion.
  const via = await viaDelEstudio({
    expediente_id: e.expediente_id as string,
    resultado: e.resultado as string | null,
    referencia_proveedor: e.referencia_proveedor as string | null,
    cascada: e.cascada,
  });

  // Adenda §2.4: que centrales se consultaron y cual fue la decision de cascada.
  // `decision_cascada` es la traza que escribe decidirConCascada (Adenda §2);
  // `decision` (la del modelo) queda de respaldo para trazas anteriores.
  const etiquetaBuro = (id: unknown) =>
    id === 'datacredito' ? 'DataCrédito' : id === 'transunion' ? 'TransUnion' : id ? String(id) : null;
  const fuentes = [etiquetaBuro(e.proveedor), etiquetaBuro(e.proveedor_secundario)].filter((x): x is string => !!x);
  const cascada = (e.cascada && typeof e.cascada === 'object' ? (e.cascada as Record<string, unknown>) : null);
  const decisionCascada =
    typeof cascada?.decision_cascada === 'string'
      ? cascada.decision_cascada
      : typeof cascada?.decision === 'string'
        ? cascada.decision
        : null;

  const canonEvaluadoRaw = e.canon_evaluado;
  const canonEvaluadoCop =
    canonEvaluadoRaw === null || canonEvaluadoRaw === undefined
      ? ((inmueble.valor_arriendo as number | null) ?? null)
      : Number(canonEvaluadoRaw);

  return {
    codigo: cert.codigo,
    fechaEmision: cert.fecha_emision,
    fechaVencimiento: cert.fecha_vencimiento,
    solicitanteNombre: (solicitante.nombre as string) || '',
    solicitanteApellido: (solicitante.apellido as string) || '',
    solicitanteTipoDoc: (solicitante.tipo_documento as string) || '',
    solicitanteNumDoc: (solicitante.numero_documento as string) || '',
    solicitanteEmail: (solicitante.email as string) || '',
    solicitanteTelefono: (solicitante.telefono as string) || '',
    tipoEstudio: conCoarrendatario ? 'con_coarrendatario' : 'individual',
    inmuebleDireccion: (inmueble.direccion as string) || '',
    inmuebleCiudad: (inmueble.ciudad as string) || '',
    inmuebleDepartamento: (inmueble.departamento as string) || '',
    inmuebleTipo: (inmueble.tipo as string) || '',
    inmuebleUso: (inmueble.uso as string) || '',
    inmuebleEstrato: (inmueble.estrato as number) || null,
    inmuebleValorArriendo: (inmueble.valor_arriendo as number) || null,
    inmuebleArea: (inmueble.area_m2 as number) || null,
    inmuebleCodigo: (inmueble.codigo as string) || null,
    resultado: resultadoEfectivo,
    score: (e.score as number) ?? null,
    proveedor: e.proveedor === 'manual' ? 'Registro manual' : (etiquetaBuro(e.proveedor) ?? ''),
    fechaEstudio: (e.fecha_completado as string) || (e.created_at as string),
    // El asistente de habilitación guarda la duración solo en el expediente.
    duracionContrato: (e.duracion_contrato_meses as number | null) ?? (expediente.duracion_contrato_meses as number | null) ?? null,
    observaciones: (e.observaciones as string) || null,
    condiciones: (e.condiciones as string) || null,
    // §10.1 — condiciones economicas. El canon evaluado es el CONGELADO con el
    // que se corrio el estudio (portabilidad.ts lo explica): si el inmueble
    // cambia de precio despues, el CRC sigue amparando lo que se evaluo, no lo
    // que valga hoy.
    canonEvaluado: canonEvaluadoCop,
    canonMaximoTolerado:
      canonEvaluadoCop === null
        ? null
        : canonMaximoTolerado(canonEvaluadoCop, PORTABILIDAD_TOLERANCIA_PCT),
    requiereAcompanante: rutaCrc.coarrendatarioObligatorio || conCoarrendatario,
    coarrendatarioVinculado: conCoarrendatario,
    rutaEtiqueta: rutaCrc.etiquetaGestor,
    // La Politica V4.1 §8 lo exige: "Version del modelo aplicable — registrada
    // en cada CRC emitido", para poder reproducir cualquier evaluacion pasada.
    modeloVersion: sombra?.modeloVersion ?? MODELO_VERSION,
    // Adenda §5: la tabla de tarifas "va en la Politica y en el CRC" — para
    // TODO resultado certificable, no solo el aprobado. Un condicionado en
    // revision imprime la fila que le aplicaria al aprobarse (revision manual,
    // 2,7%, o la condicionada si su coarrendatario ya alcanza el umbral).
    tarifas: calcularTarifas({
      via,
      conCoarrendatario,
      canonCop: canonEvaluadoCop,
      ivaPct: cal.TARIFA_IVA,
      override: leerTarifaOverride(e.tarifa_override),
    }),
    factorAjusteIngreso: sombra?.factor ?? null,
    fuentesConsultadas: fuentes.length > 0 ? fuentes.join(' + ') : null,
    denominadorPuntaje: sombra?.denominador ?? null,
    decisionCascada,
    canonIngresoPct: sombra?.canonIngresoPct ?? null,
  };
}

/**
 * Flujo §10/§11: el CRC es un ENTREGABLE del resultado, no un boton. Se emite
 * apenas el expediente avanza a aprobado/condicionado (orquestador) y se
 * ACTUALIZA cuando la ponderacion con coarrendatario aprueba el conjunto (las
 * condiciones economicas cambian: prima 10%, via condicionada).
 *
 * Best-effort y NUNCA lanza: si falla (estudio vencido, storage caido, sin
 * actor) el gestor conserva el boton manual y queda un warn. Sin `regenerar`
 * es idempotente — un certificado ya emitido (o subido a mano con el
 * resultado) no se toca: pudo llevar una tarifa negociada mas reciente que lo
 * que el hook sabe. `actorId` = perfil que firma la emision (quien creo el
 * expediente); sin rol, assertExpedienteAccess lo trata como llamada de sistema.
 */
export async function emitirCertificadoAutomatico(
  estudioId: string,
  actorId: string | null | undefined,
  opts: { regenerar?: boolean } = {},
): Promise<boolean> {
  if (!actorId) {
    logger.warn({ estudioId }, 'CRC automatico: sin actor (expediente sin creado_por) — queda el boton manual');
    return false;
  }
  try {
    const { data } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select('expediente_id, certificado_url')
      .eq('id', estudioId)
      .maybeSingle();
    const row = data as { expediente_id: string; certificado_url: string | null } | null;
    if (!row) return false;
    if (row.certificado_url && !opts.regenerar) return false;

    const cert = await generarCertificado(estudioId, actorId);

    await (supabase
      .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
      .insert({
        expediente_id: row.expediente_id,
        tipo: 'estudio',
        descripcion:
          `Certificado de Riesgo Cofianza ${cert.codigo} ` +
          `${cert.version > 1 ? 'actualizado' : 'emitido'} automáticamente con el resultado del estudio.`,
        metadata: { automatico: true, origen: 'crc_automatico', estudio_id: estudioId, codigo: cert.codigo, version: cert.version },
      } as never);
    return true;
  } catch (err) {
    logger.warn(
      { estudioId, err: err instanceof Error ? err.message : String(err) },
      'CRC automatico: no se pudo emitir el certificado — queda el boton manual',
    );
    return false;
  }
}

// ============================================================
// Versiones reducidas: firmantes (Adenda 1 contratos, respuesta 5) y
// arrendatario (P13)
// ============================================================

type VersionReducida = 'firmantes' | 'arrendatario';

type CertGuardado = {
  estudio_id: string;
  codigo: string;
  pdf_storage_key: string;
  fecha_emision: string;
  fecha_vencimiento: string;
};

/** Vive al lado del completo: misma llave con sufijo, sin columna nueva. */
export function llaveDeVersion(llaveCompleta: string, version: VersionReducida): string {
  return `${llaveCompleta.replace(/\.pdf$/i, '')}-${version}.pdf`;
}

/**
 * El CRC reducido: el de firmantes (sin puntaje ni observaciones) va al paquete
 * de firma; el del arrendatario es ese mismo con su score. El completo queda
 * solo en el panel de la inmobiliaria, del propietario y de Cofianza. El de
 * firmantes se emite junto al completo; el del arrendatario, y el de firmantes
 * de un CRC anterior, se generan aqui una vez, con su numero y sus fechas, y
 * quedan guardados. Salen de los datos de hoy del estudio: si algo cambio desde
 * la emision, lo reflejan. No verifica acceso: el llamador ya paso por
 * assertExpedienteAccess.
 */
async function crcReducido(cert: CertGuardado, version: VersionReducida): Promise<{ key: string; pdf: Buffer }> {
  const key = llaveDeVersion(cert.pdf_storage_key, version);
  const { data } = await supabase.storage.from(BUCKET_NAME).download(key);
  if (data) return { key, pdf: Buffer.from(await data.arrayBuffer()) };

  const e = await leerEstudioCrc(cert.estudio_id);
  assertCertificable(e);
  const datos = await datosDelCrc(e, cert);
  const reducido = version === 'firmantes' ? sinPuntaje(datos) : paraArrendatario(datos);
  const pdf = await generateCertificatePdf(reducido, await generateQrCode(`${env.FRONTEND_URL}/verificar/${cert.codigo}`));
  // Sin upsert: si ya existia (una lectura que fallo), no se pisa; se reintenta.
  const { error } = await supabase.storage.from(BUCKET_NAME).upload(key, pdf, { contentType: 'application/pdf', upsert: false });
  if (error) {
    logger.error({ error, key }, `CRC: no se pudo guardar la versión ${version}`);
    throw new AppError(503, 'CRC_NO_DISPONIBLE', 'No pudimos preparar el certificado. Intenta de nuevo en un momento.');
  }
  return { key, pdf };
}

export function crcParaFirmantes(cert: CertGuardado) {
  return crcReducido(cert, 'firmantes');
}

export function crcParaArrendatario(cert: CertGuardado) {
  return crcReducido(cert, 'arrendatario');
}

// ============================================================
// descargarCertificado
// ============================================================

export async function descargarCertificado(estudioId: string, userId?: string, userRol?: string) {
  // Tenant guard: resolvemos el expediente del estudio y verificamos acceso antes
  // de devolver la URL firmada del PDF. Sin scoping, un rol externo con
  // expedientes:read descargaba el certificado de OTRA agencia por UUID (IDOR).
  const { data: estRow, error: estErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('expediente_id, tipo')
    .eq('id', estudioId)
    .single();

  if (estErr || !estRow) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estRow as { expediente_id: string; tipo: string };
  await assertExpedienteAccess(est.expediente_id, userId, userRol);
  assertNoEsEstudioDeOtraPersona(est.tipo, userRol);

  const { data: cert, error: certErr } = await (supabase
    .from('estudios_certificados' as string) as ReturnType<typeof supabase.from>)
    .select('id, codigo, pdf_storage_key, version, fecha_emision, fecha_vencimiento')
    .eq('estudio_id', estudioId)
    .single();

  if (certErr || !cert) {
    throw AppError.notFound('Certificado no encontrado', 'CERTIFICADO_NOT_FOUND');
  }

  const c = cert as { id: string; codigo: string; pdf_storage_key: string; version: number; fecha_emision: string; fecha_vencimiento: string };
  // P13 (Ley 1266): el arrendatario baja la version para firmantes con SU puntaje.
  const key =
    userRol === 'solicitante' ? (await crcParaArrendatario({ ...c, estudio_id: estudioId })).key : c.pdf_storage_key;

  const { data: signedData, error: signErr } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(key, 3600);

  if (signErr || !signedData) {
    logger.error({ error: signErr, estudioId }, 'Error creating signed URL for certificate');
    throw new AppError(500, 'INTERNAL_ERROR','Error al generar URL de descarga');
  }

  return {
    url: signedData.signedUrl,
    expires_in: 3600,
    codigo: c.codigo,
    version: c.version,
  };
}

// ============================================================
// verificarCertificado (public)
// ============================================================

export async function verificarCertificado(codigo: string) {
  const company = await getCompany();
  const { data: cert, error: certErr } = await (supabase
    .from('estudios_certificados' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, codigo, fecha_emision, fecha_vencimiento, version,
      estudios!estudios_certificados_estudio_id_fkey(
        resultado, score, proveedor,
        expedientes!estudios_expediente_id_fkey(
          numero, estado,
          solicitantes!expedientes_solicitante_id_fkey(
            nombre, apellido, tipo_documento, numero_documento
          ),
          inmuebles!expedientes_inmueble_id_fkey(
            direccion, ciudad
          )
        )
      )
    `)
    .eq('codigo', codigo)
    .single();

  if (certErr || !cert) {
    return {
      status: 'invalido' as const,
      codigo,
      nombre_masked: '',
      resultado: '',
      direccion_masked: '',
      fecha_emision: '',
      fecha_vencimiento: '',
      empresa: company.name,
      numero_documento_masked: '',
    };
  }

  const c = cert as Record<string, unknown>;
  const estudio = c.estudios as Record<string, unknown> | null;
  const expediente = estudio
    ? (estudio.expedientes as Record<string, unknown> | null)
    : null;
  const solicitante = expediente
    ? (expediente.solicitantes as Record<string, unknown> | null)
    : null;
  const inmueble = expediente
    ? (expediente.inmuebles as Record<string, unknown> | null)
    : null;

  // Determine status
  const now = new Date();
  const vencimiento = new Date(c.fecha_vencimiento as string);
  const status = now <= vencimiento ? 'valido_vigente' : 'valido_vencido';

  // Mismo criterio que el PDF (ver resultadoEfectivo en generarCertificado):
  // un condicionado cuyo expediente ya esta aprobado se verifica como aprobado.
  const resultadoEstudio = (estudio?.resultado as string) || '';
  const resultadoVerificado =
    resultadoEstudio === 'condicionado' && expediente?.estado === 'aprobado' ? 'aprobado' : resultadoEstudio;

  return {
    status,
    codigo: c.codigo as string,
    nombre_masked: solicitante
      ? maskName(solicitante.nombre as string, solicitante.apellido as string)
      : '',
    resultado: resultadoVerificado,
    direccion_masked: inmueble
      ? maskAddress(inmueble.direccion as string)
      : '',
    fecha_emision: c.fecha_emision as string,
    fecha_vencimiento: c.fecha_vencimiento as string,
    empresa: company.name,
    numero_documento_masked: solicitante
      ? maskDocumento(solicitante.numero_documento as string)
      : '',
  };
}

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
import { calcularTarifas, leerTarifaOverride, viaSegunCalibracion, type Tarifas } from './tarifas';
// Adenda §5.2: la prima baja al 10% cuando HAY coarrendatario vinculado al
// expediente — no cuando el tipo de esta fila es 'con_coarrendatario'.
import { coarrendatarioVinculado } from './coarrendatario-vinculado';
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

interface CertificatePdfData {
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
  duracionContrato: number;
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
}

export async function generateCertificatePdf(
  data: CertificatePdfData,
  qrBuffer: Buffer,
): Promise<Buffer> {
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
    doc.text('NUMERO DEL CERTIFICADO', 60, y + 8);
    doc.text('VIGENTE HASTA', 60 + contentWidth / 2, y + 8);
    doc.fontSize(13).font('Helvetica-Bold').fillColor(TEAL as unknown as string);
    doc.text(data.codigo, 60, y + 21);
    doc.text(formatDate(data.fechaVencimiento), 60 + contentWidth / 2, y + 21);
    y += 54;

    doc.fontSize(9).font('Helvetica').fillColor('#374151');
    doc.text(`Fecha de emision: ${formatDate(data.fechaEmision)}`, 50, y, {
      width: contentWidth,
      align: 'right',
    });

    y += 20;

    // ---- SECTION: SOLICITANTE ----
    y = drawSectionTitle(doc, 'DATOS DEL SOLICITANTE', y, contentWidth);
    const solicitanteRows = [
      ['Nombre completo', `${data.solicitanteNombre} ${data.solicitanteApellido}`],
      ['Tipo de documento', data.solicitanteTipoDoc],
      ['Numero de documento', data.solicitanteNumDoc],
      ['Email', data.solicitanteEmail],
      ['Telefono', data.solicitanteTelefono],
      ['Tipo de estudio', data.tipoEstudio === 'individual' ? 'Individual' : 'Con coarrendatario'],
    ];
    y = drawTable(doc, solicitanteRows, y, contentWidth);

    y += 10;

    // ---- SECTION: INMUEBLE ----
    y = drawSectionTitle(doc, 'DATOS DEL INMUEBLE', y, contentWidth);
    const inmuebleRows = [
      ['Direccion', data.inmuebleDireccion],
      ['Ciudad / Departamento', `${data.inmuebleCiudad}, ${data.inmuebleDepartamento}`],
      ['Tipo', data.inmuebleTipo],
      ['Uso', data.inmuebleUso],
    ];
    if (data.inmuebleEstrato) inmuebleRows.push(['Estrato', String(data.inmuebleEstrato)]);
    if (data.inmuebleValorArriendo) inmuebleRows.push(['Canon de arriendo', formatCurrency(data.inmuebleValorArriendo)]);
    if (data.inmuebleArea) inmuebleRows.push(['Area (m²)', String(data.inmuebleArea)]);
    if (data.inmuebleCodigo) inmuebleRows.push(['Codigo inmueble', data.inmuebleCodigo]);
    y = drawTable(doc, inmuebleRows, y, contentWidth);

    y += 10;

    // ---- SECTION: RESULTADO ----
    y = drawSectionTitle(doc, 'RESULTADO DEL ESTUDIO', y, contentWidth);

    // Result badge
    const rc = RESULTADO_COLORS[data.resultado] || RESULTADO_COLORS.aprobado;
    doc.roundedRect(50, y, 160, 28, 4).fill(rc.bg as unknown as string);
    doc.fontSize(12).font('Helvetica-Bold').fillColor(rc.text as unknown as string);
    doc.text(rc.label, 55, y + 7, { width: 150, align: 'center' });
    y += 36;

    const resultRows = [];
    if (data.score != null) resultRows.push(['Score', String(data.score)]);
    resultRows.push(['Proveedor', data.proveedor.toUpperCase()]);
    resultRows.push(['Fecha del estudio', formatDate(data.fechaEstudio)]);
    resultRows.push(['Duracion contrato', `${data.duracionContrato} meses`]);
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
        condRows.push(['Canon maximo amparado', formatCurrency(data.canonMaximoTolerado)]);
      }
      condRows.push([
        'Acompanante',
        data.coarrendatarioVinculado
          ? 'Vinculado: este CRC ampara el contrato presentado con coarrendatario'
          : data.requiereAcompanante
            ? 'Requerido: este CRC ampara el contrato presentado con coarrendatario'
            : 'No requerido',
      ]);
      // Adenda §5 — tarifas y primas por ruta de aprobacion.
      if (data.tarifas) {
        const t = data.tarifas;
        const via =
          t.via === 'automatica'
            ? 'aprobacion automatica'
            : t.via === 'condicionada_coarrendatario'
              ? 'aprobacion condicionada con coarrendatario'
              : 'aprobacion tras revision manual';
        condRows.push([
          'Tarifa mensual de la fianza',
          `${t.tarifa_mensual_pct}% del canon mas IVA (${via})` +
            (t.tarifa_mensual_cop != null ? ` = ${formatCurrency(t.tarifa_mensual_cop)} + IVA` : '') +
            (t.negociada ? ' — condiciones especiales autorizadas' : ''),
        ]);
        condRows.push([
          'Prima de vinculacion',
          `${t.prima_vinculacion_pct}% del canon, pago unico al activar` +
            (t.prima_vinculacion_cop != null ? ` = ${formatCurrency(t.prima_vinculacion_cop)}` : ''),
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
        `Este certificado ampara contratos cuyo canon no supere en mas de ${PORTABILIDAD_TOLERANCIA_PCT}% el canon evaluado, ` +
          'siempre que la relacion canon/ingreso recalculada se mantenga en o por debajo del 40%. ' +
          'Si el canon excede esa tolerancia se requiere una nueva evaluacion.',
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
    if (data.decisionCascada) trazaRows.push(['Decision de cascada', data.decisionCascada]);
    if (data.factorAjusteIngreso != null && data.factorAjusteIngreso !== 1) {
      trazaRows.push(['Factor de ajuste de ingreso', `x${data.factorAjusteIngreso} (Adenda 1 §1.1)`]);
    }
    trazaRows.push(['Version del modelo', data.modeloVersion]);
    y = asegurarEspacio(doc, y, 22 + trazaRows.length * 22);
    y = drawSectionTitle(doc, 'TRAZABILIDAD DE LA EVALUACION', y, contentWidth);
    y = drawTable(doc, trazaRows, y, contentWidth);

    y += 15;

    // ---- SECTION: QR + VERIFICACION ----
    const verificationUrl = `${env.FRONTEND_URL}/verificar/${data.codigo}`;

    doc.image(qrBuffer, 50, y, { width: 100, height: 100 });

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#374151');
    doc.text('Verificacion de autenticidad', 165, y);
    doc.fontSize(8).font('Helvetica').fillColor('#6b7280');
    doc.text(
      'Escanee el codigo QR o visite la siguiente URL para verificar la autenticidad de este certificado:',
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
    doc.text(`Valido hasta: ${formatDate(data.fechaVencimiento)}`, 50, y);
    y += 12;
    doc.text(
      'Este certificado es generado electronicamente por Cofianza S.A.S. y tiene validez como documento informativo. ' +
      'La informacion contenida proviene de centrales de riesgo crediticio autorizadas. ' +
      'Para verificar su autenticidad, escanee el codigo QR o visite la URL indicada.',
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
    y += 16;
  }

  return y;
}

// ============================================================
// generarCertificado (orchestrator)
// ============================================================

/**
 * Ultima corrida del motor para el estudio. Best-effort: sin fila (estudio
 * anterior al motor, o migracion sin correr) el CRC sale igual, sin factor
 * ni puntaje.
 */
export async function leerSombraDelEstudio(
  estudioId: string,
): Promise<{ puntaje: number | null; factor: number | null; modeloVersion: string | null } | null> {
  try {
    const { data } = await (supabase
      .from('estudios_scorecard_sombra' as string) as ReturnType<typeof supabase.from>)
      .select('puntaje_normalizado, factor_ajuste_ingreso, modelo_version')
      .eq('estudio_id', estudioId)
      .order('fecha_calculo', { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = data as { puntaje_normalizado?: number | string | null; factor_ajuste_ingreso?: number | string | null; modelo_version?: string | null } | null;
    if (!row) return null;
    const num = (v: unknown) => {
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    };
    return { puntaje: num(row.puntaje_normalizado), factor: num(row.factor_ajuste_ingreso), modeloVersion: row.modelo_version ?? null };
  } catch {
    return null;
  }
}

export async function generarCertificado(
  estudioId: string,
  userId: string,
  ip?: string,
  userRol?: string,
) {
  // 1. Deep join: estudio → expediente → solicitante + inmueble
  const { data: estudio, error: estudioErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      *,
      expedientes!estudios_expediente_id_fkey(
        numero, estado,
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

  const e = estudio as Record<string, unknown>;

  // Tenant guard: genera + persiste el PDF del certificado (con datos del
  // solicitante y del inmueble) para este estudio. Sin scoping, la inmobiliaria
  // (rol externo con expedientes:update) generaba certificados de estudios de
  // OTRA agencia por UUID (write-IDOR). No-op para roles internos.
  await assertExpedienteAccess(e.expediente_id as string, userId, userRol);

  // 2. Validate
  if (e.estado !== 'completado') {
    throw AppError.conflict('El estudio debe estar completado para generar certificado', 'ESTUDIO_NO_COMPLETADO');
  }
  if (!RESULTADOS_CERTIFICABLES.includes(e.resultado as string)) {
    throw AppError.conflict(
      'Solo se puede generar certificado para estudios aprobados o condicionados',
      'ESTUDIO_NO_CERTIFICABLE',
    );
  }

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

  const expediente = e.expedientes as Record<string, unknown> | null;
  if (!expediente) {
    throw AppError.badRequest('La evaluación no tiene estudio asociado', 'ESTUDIO_SIN_EXPEDIENTE');
  }

  const solicitante = (expediente.solicitantes as Record<string, unknown>) || {};
  const inmueble = (expediente.inmuebles as Record<string, unknown>) || {};

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
    // Delete old PDF from storage
    await supabase.storage.from(BUCKET_NAME).remove([existingCert.pdf_storage_key]);
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

  // 6. Generate PDF
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

  // Adenda §5: la fila de la tabla de tarifas segun la via de aprobacion.
  const via = viaSegunCalibracion(puntajeCrc, conCoarrendatario, cal, puntajeCoa);

  // Adenda §2.4: que centrales se consultaron y cual fue la decision de cascada.
  // `decision_cascada` es la traza que escribe decidirConCascada (Adenda §2);
  // `decision` (la del modelo) queda de respaldo para trazas anteriores.
  const etiquetaBuro = (id: unknown) =>
    id === 'datacredito' ? 'DataCredito' : id === 'transunion' ? 'TransUnion' : id ? String(id) : null;
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

  const pdfData: CertificatePdfData = {
    codigo,
    fechaEmision,
    fechaVencimiento,
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
    proveedor: e.proveedor as string,
    fechaEstudio: (e.fecha_completado as string) || (e.created_at as string),
    duracionContrato: e.duracion_contrato_meses as number,
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
      override: leerTarifaOverride(e.tarifa_override),
    }),
    factorAjusteIngreso: sombra?.factor ?? null,
    fuentesConsultadas: fuentes.length > 0 ? fuentes.join(' + ') : null,
    decisionCascada,
  };

  const pdfBuffer = await generateCertificatePdf(pdfData, qrBuffer);

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
// descargarCertificado
// ============================================================

export async function descargarCertificado(estudioId: string, userId?: string, userRol?: string) {
  // Tenant guard: resolvemos el expediente del estudio y verificamos acceso antes
  // de devolver la URL firmada del PDF. Sin scoping, un rol externo con
  // expedientes:read descargaba el certificado de OTRA agencia por UUID (IDOR).
  const { data: estRow, error: estErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('expediente_id')
    .eq('id', estudioId)
    .single();

  if (estErr || !estRow) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  await assertExpedienteAccess((estRow as { expediente_id: string }).expediente_id, userId, userRol);

  const { data: cert, error: certErr } = await (supabase
    .from('estudios_certificados' as string) as ReturnType<typeof supabase.from>)
    .select('id, codigo, pdf_storage_key, version, fecha_emision, fecha_vencimiento')
    .eq('estudio_id', estudioId)
    .single();

  if (certErr || !cert) {
    throw AppError.notFound('Certificado no encontrado', 'CERTIFICADO_NOT_FOUND');
  }

  const c = cert as { id: string; codigo: string; pdf_storage_key: string; version: number; fecha_emision: string; fecha_vencimiento: string };

  const { data: signedData, error: signErr } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(c.pdf_storage_key, 3600);

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

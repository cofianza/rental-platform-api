import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { PassThrough } from 'node:stream';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { COMPANY } from '@/config/company';

// ============================================================
// Constants
// ============================================================

const BUCKET_NAME = 'documentos-expedientes';
const RESULTADOS_CERTIFICABLES = ['aprobado', 'condicionado'];

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
}

export async function generateCertificatePdf(
  data: CertificatePdfData,
  qrBuffer: Buffer,
): Promise<Buffer> {
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

    // HP logo text
    doc.fontSize(32).fillColor('#ffffff').font('Helvetica-Bold');
    doc.text('HP', 70, 62);

    // Company info
    doc.fontSize(9).font('Helvetica').fillColor('#ffffff');
    doc.text(COMPANY.name, 120, 62);
    doc.text(`NIT: ${COMPANY.nit}`, 120, 74);
    doc.text(COMPANY.address, 120, 86);
    doc.text(`${COMPANY.phone} | ${COMPANY.email}`, 120, 98);

    // Title
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#ffffff');
    doc.text('CERTIFICADO DE ESTUDIO DE RIESGO CREDITICIO', 50, 118, {
      width: contentWidth,
      align: 'center',
    });

    let y = 50 + headerHeight + 15;

    // Code + date row
    doc.fontSize(9).font('Helvetica').fillColor('#374151');
    doc.text(`Codigo: ${data.codigo}`, 50, y);
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
    if (data.observaciones) resultRows.push(['Observaciones', data.observaciones]);
    if (data.condiciones) resultRows.push(['Condiciones', data.condiciones]);
    y = drawTable(doc, resultRows, y, contentWidth);

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
    doc.text(`${COMPANY.name} | NIT: ${COMPANY.nit} | ${COMPANY.website}`, 50, y, {
      width: contentWidth,
      align: 'center',
    });

    doc.end();
  });
}

// ---- PDF Drawing Helpers ----

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

export async function generarCertificado(
  estudioId: string,
  userId: string,
  ip?: string,
) {
  // 1. Deep join: estudio → expediente → solicitante + inmueble
  const { data: estudio, error: estudioErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      *,
      expedientes!estudios_expediente_id_fkey(
        numero,
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

  const expediente = e.expedientes as Record<string, unknown> | null;
  if (!expediente) {
    throw AppError.badRequest('Estudio no tiene expediente asociado', 'ESTUDIO_SIN_EXPEDIENTE');
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
  const fechaEmision = new Date().toISOString();
  const fechaVencimiento = new Date(
    Date.now() + COMPANY.certificateValidityDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // 6. Generate PDF
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
    tipoEstudio: e.tipo as string,
    inmuebleDireccion: (inmueble.direccion as string) || '',
    inmuebleCiudad: (inmueble.ciudad as string) || '',
    inmuebleDepartamento: (inmueble.departamento as string) || '',
    inmuebleTipo: (inmueble.tipo as string) || '',
    inmuebleUso: (inmueble.uso as string) || '',
    inmuebleEstrato: (inmueble.estrato as number) || null,
    inmuebleValorArriendo: (inmueble.valor_arriendo as number) || null,
    inmuebleArea: (inmueble.area_m2 as number) || null,
    inmuebleCodigo: (inmueble.codigo as string) || null,
    resultado: e.resultado as string,
    score: (e.score as number) ?? null,
    proveedor: e.proveedor as string,
    fechaEstudio: (e.fecha_completado as string) || (e.created_at as string),
    duracionContrato: e.duracion_contrato_meses as number,
    observaciones: (e.observaciones as string) || null,
    condiciones: (e.condiciones as string) || null,
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

// ============================================================
// descargarCertificado
// ============================================================

export async function descargarCertificado(estudioId: string) {
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
  const { data: cert, error: certErr } = await (supabase
    .from('estudios_certificados' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, codigo, fecha_emision, fecha_vencimiento, version,
      estudios!estudios_certificados_estudio_id_fkey(
        resultado, score, proveedor,
        expedientes!estudios_expediente_id_fkey(
          numero,
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
      empresa: COMPANY.name,
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

  return {
    status,
    codigo: c.codigo as string,
    nombre_masked: solicitante
      ? maskName(solicitante.nombre as string, solicitante.apellido as string)
      : '',
    resultado: estudio?.resultado as string || '',
    direccion_masked: inmueble
      ? maskAddress(inmueble.direccion as string)
      : '',
    fecha_emision: c.fecha_emision as string,
    fecha_vencimiento: c.fecha_vencimiento as string,
    empresa: COMPANY.name,
    numero_documento_masked: solicitante
      ? maskDocumento(solicitante.numero_documento as string)
      : '',
  };
}

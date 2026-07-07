import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { assertExpedienteAccess } from '@/lib/tenantScope';
import { executePostFirma } from './post-firma.service';

// ============================================================
// Constants
// ============================================================

const BUCKET_NAME = 'documentos-expedientes';
const DOWNLOAD_URL_EXPIRY_SECONDS = 900;

// ============================================================
// Types
// ============================================================

interface CompletarFirmaInput {
  firma_imagen: string; // base64 PNG
  user_agent: string;
  geo_latitud?: number;
  geo_longitud?: number;
  geo_precision?: number;
}

interface EvidenciaRow {
  id: string;
  solicitud_firma_id: string;
  ip_firmante: string;
  user_agent: string;
  geo_latitud: number | null;
  geo_longitud: number | null;
  geo_precision: number | null;
  otp_verificado_en: string;
  firma_imagen_key: string;
  firmado_en: string;
  hash_documento: string;
  acuse_storage_key: string | null;
  created_at: string;
}

interface SolicitudForCompletar {
  id: string;
  contrato_id: string;
  nombre_firmante: string;
  email_firmante: string;
  estado: string;
  token_expiracion: string;
}

// ============================================================
// Completar firma (public, called from /firma/[token])
// ============================================================

export async function completarFirma(
  token: string,
  input: CompletarFirmaInput,
  ip: string,
) {
  // 1. Validate token and get solicitud
  const { data: solData, error: solError } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, nombre_firmante, email_firmante, estado, token_expiracion')
    .eq('token', token)
    .single();

  if (solError || !solData) {
    throw AppError.notFound('Enlace de firma no valido', 'INVALID_TOKEN');
  }

  const solicitud = solData as unknown as SolicitudForCompletar;

  // Check token expiration
  if (new Date(solicitud.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de firma ha expirado', 'TOKEN_EXPIRED');
  }

  // Must be in otp_validado state
  if (solicitud.estado !== 'otp_validado') {
    throw AppError.badRequest(
      'Debes verificar el codigo OTP antes de firmar',
      'OTP_NOT_VALIDATED',
    );
  }

  // Check no existing evidencia (1:1 constraint)
  const { data: existing } = await (supabase
    .from('evidencias_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('solicitud_firma_id', solicitud.id)
    .single();

  if (existing) {
    throw AppError.conflict('Esta solicitud ya fue firmada', 'ALREADY_SIGNED');
  }

  // 2. Get OTP verification timestamp
  const { data: otpData } = await (supabase
    .from('codigos_otp' as string) as ReturnType<typeof supabase.from>)
    .select('verificado_en')
    .eq('solicitud_firma_id', solicitud.id)
    .not('verificado_en', 'is', null)
    .order('verificado_en', { ascending: false })
    .limit(1)
    .single();

  if (!otpData) {
    throw AppError.badRequest('No se encontro verificacion OTP', 'OTP_NOT_FOUND');
  }

  const otpVerificadoEn = (otpData as unknown as { verificado_en: string }).verificado_en;

  // 3. Get contrato PDF and compute SHA-256 hash
  const { data: contrato } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, storage_key, nombre_archivo, expediente_id, expedientes(numero, inmuebles(direccion, ciudad))')
    .eq('id', solicitud.contrato_id)
    .single();

  if (!contrato) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  const c = contrato as unknown as {
    id: string;
    storage_key: string | null;
    nombre_archivo: string | null;
    expediente_id: string;
    expedientes: {
      numero: string;
      inmuebles: { direccion: string; ciudad: string } | null;
    } | null;
  };

  let hashDocumento = 'no-pdf-available';
  if (c.storage_key) {
    try {
      const { data: pdfBlob } = await supabase.storage
        .from(BUCKET_NAME)
        .download(c.storage_key);

      if (pdfBlob) {
        const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());
        hashDocumento = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
      }
    } catch (err) {
      logger.warn({ error: err, contratoId: c.id }, 'Could not download PDF for hashing');
    }
  }

  // 4. Store signature image in storage
  const firmaBuffer = Buffer.from(input.firma_imagen.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const firmaKey = `firmas/${c.expediente_id}/${solicitud.id}/firma.png`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(firmaKey, firmaBuffer, {
      contentType: 'image/png',
      upsert: false,
    });

  if (uploadError) {
    logger.error({ error: uploadError.message, solicitudId: solicitud.id }, 'Error uploading signature image');
    throw new AppError(500, 'UPLOAD_ERROR', 'Error al almacenar la firma');
  }

  // 5. Insert evidencia
  const firmadoEn = new Date().toISOString();

  const { data: evidencia, error: insertError } = await (supabase
    .from('evidencias_firma' as string) as ReturnType<typeof supabase.from>)
    .insert({
      solicitud_firma_id: solicitud.id,
      ip_firmante: ip,
      user_agent: input.user_agent,
      geo_latitud: input.geo_latitud || null,
      geo_longitud: input.geo_longitud || null,
      geo_precision: input.geo_precision || null,
      otp_verificado_en: otpVerificadoEn,
      firma_imagen_key: firmaKey,
      firmado_en: firmadoEn,
      hash_documento: hashDocumento,
    } as never)
    .select('id')
    .single();

  if (insertError || !evidencia) {
    logger.error({ error: insertError?.message }, 'Error inserting evidencia');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al registrar la evidencia');
  }

  // 6. Update solicitud estado to firmado
  await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'firmado',
      firmado_en: firmadoEn,
      ip_firmante: ip,
      user_agent_firmante: input.user_agent,
      updated_at: firmadoEn,
    } as never)
    .eq('id', solicitud.id);

  // 7. Generate acuse PDF in background (fire-and-forget)
  generateAndStoreAcuse(
    (evidencia as unknown as { id: string }).id,
    solicitud,
    c,
    {
      ip,
      userAgent: input.user_agent,
      firmadoEn,
      hashDocumento,
      otpVerificadoEn,
      geoLatitud: input.geo_latitud || null,
      geoLongitud: input.geo_longitud || null,
      firmaKey,
    },
  ).catch((err) => {
    logger.error({ error: err, evidenciaId: (evidencia as unknown as { id: string }).id }, 'Error generating acuse PDF');
  });

  // 8. Audit log
  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.FIRMA_COMPLETADA,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: solicitud.contrato_id,
    detalle: {
      solicitud_id: solicitud.id,
      evidencia_id: (evidencia as unknown as { id: string }).id,
      hash_documento: hashDocumento,
    },
    ip,
  });

  // 9. Post-firma orchestration (fire-and-forget)
  // Transitions contrato, inserts timeline event, sends emails
  executePostFirma({
    solicitudId: solicitud.id,
    contratoId: solicitud.contrato_id,
    nombreFirmante: solicitud.nombre_firmante,
    emailFirmante: solicitud.email_firmante,
    firmadoEn,
  }).catch((err) => {
    logger.error({ error: err, solicitudId: solicitud.id }, 'Error in post-firma orchestration');
  });

  return {
    firmado: true,
    firmado_en: firmadoEn,
    hash_documento: hashDocumento,
  };
}

// ============================================================
// Get evidencia (authenticated, for dashboard)
// ============================================================

export async function getEvidencia(solicitudId: string, userId?: string, userRol?: string) {
  // Guard de pertenencia (IDOR): resolvemos el expediente vía el contrato de la
  // solicitud y gateamos. No-op para roles internos / sin identidad; 404 fuera
  // de scope (no confirma existencia cross-tenant).
  const { data: sol } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contratos(expediente_id)')
    .eq('id', solicitudId)
    .single();
  if (!sol) {
    throw AppError.notFound('Evidencia no encontrada', 'EVIDENCIA_NOT_FOUND');
  }
  await assertExpedienteAccess(
    (sol as { contratos?: { expediente_id: string | null } | null }).contratos?.expediente_id ?? '',
    userId,
    userRol,
  );

  const { data, error } = await (supabase
    .from('evidencias_firma' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('solicitud_firma_id', solicitudId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Evidencia no encontrada', 'EVIDENCIA_NOT_FOUND');
  }

  const row = data as unknown as EvidenciaRow;

  // Get signed URL for firma image
  let firmaImageUrl: string | null = null;
  if (row.firma_imagen_key) {
    const { data: urlData } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(row.firma_imagen_key, DOWNLOAD_URL_EXPIRY_SECONDS);

    if (urlData) {
      firmaImageUrl = urlData.signedUrl;
    }
  }

  return {
    id: row.id,
    solicitud_firma_id: row.solicitud_firma_id,
    ip_firmante: row.ip_firmante,
    user_agent: row.user_agent,
    geo_latitud: row.geo_latitud,
    geo_longitud: row.geo_longitud,
    geo_precision: row.geo_precision,
    otp_verificado_en: row.otp_verificado_en,
    firma_imagen_url: firmaImageUrl,
    firmado_en: row.firmado_en,
    hash_documento: row.hash_documento,
    tiene_acuse: !!row.acuse_storage_key,
    created_at: row.created_at,
  };
}

// ============================================================
// Download acuse PDF (authenticated)
// ============================================================

export async function downloadAcuse(solicitudId: string) {
  const { data, error } = await (supabase
    .from('evidencias_firma' as string) as ReturnType<typeof supabase.from>)
    .select('acuse_storage_key')
    .eq('solicitud_firma_id', solicitudId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Evidencia no encontrada', 'EVIDENCIA_NOT_FOUND');
  }

  const row = data as unknown as { acuse_storage_key: string | null };

  if (!row.acuse_storage_key) {
    throw AppError.notFound('El acuse de firma aun no ha sido generado', 'ACUSE_NOT_READY');
  }

  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(row.acuse_storage_key, DOWNLOAD_URL_EXPIRY_SECONDS, {
      download: 'acuse-firma.pdf',
    });

  if (urlError || !urlData) {
    throw new AppError(500, 'DOWNLOAD_ERROR', 'Error al generar enlace de descarga');
  }

  return {
    url: urlData.signedUrl,
    nombre_archivo: 'acuse-firma.pdf',
    expires_in: DOWNLOAD_URL_EXPIRY_SECONDS,
  };
}

// ============================================================
// Generate acuse PDF (internal, fire-and-forget)
// ============================================================

interface AcuseData {
  ip: string;
  userAgent: string;
  firmadoEn: string;
  hashDocumento: string;
  otpVerificadoEn: string;
  geoLatitud: number | null;
  geoLongitud: number | null;
  firmaKey: string;
}

async function generateAndStoreAcuse(
  evidenciaId: string,
  solicitud: SolicitudForCompletar,
  contrato: {
    id: string;
    nombre_archivo: string | null;
    expediente_id: string;
    expedientes: {
      numero: string;
      inmuebles: { direccion: string; ciudad: string } | null;
    } | null;
  },
  data: AcuseData,
) {
  // Descargar la imagen de firma del storage para embedir en el acuse.
  // Si falla, generamos el acuse sin imagen (degradacion controlada).
  let firmaImagenBuffer: Buffer | null = null;
  try {
    const { data: imgBlob, error: imgErr } = await supabase.storage
      .from(BUCKET_NAME)
      .download(data.firmaKey);
    if (imgErr || !imgBlob) {
      logger.warn({ err: imgErr?.message, firmaKey: data.firmaKey }, 'Acuse: firma image no descargada');
    } else {
      firmaImagenBuffer = Buffer.from(await imgBlob.arrayBuffer());
    }
  } catch (err) {
    logger.warn({ err, firmaKey: data.firmaKey }, 'Acuse: error al cargar firma image');
  }

  const pdfBuffer = await buildAcusePdf(solicitud, contrato, data, firmaImagenBuffer);

  const acuseKey = `firmas/${contrato.expediente_id}/${solicitud.id}/acuse-firma.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(acuseKey, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    logger.error({ error: uploadError.message, evidenciaId }, 'Error uploading acuse PDF');
    return;
  }

  // Update evidencia with acuse key
  await (supabase
    .from('evidencias_firma' as string) as ReturnType<typeof supabase.from>)
    .update({ acuse_storage_key: acuseKey } as never)
    .eq('id', evidenciaId);

  logger.info({ evidenciaId, acuseKey }, 'Acuse PDF generated and stored');
}

function buildAcusePdf(
  solicitud: SolicitudForCompletar,
  contrato: {
    id: string;
    nombre_archivo: string | null;
    expedientes: {
      numero: string;
      inmuebles: { direccion: string; ciudad: string } | null;
    } | null;
  },
  data: AcuseData,
  firmaImagenBuffer: Buffer | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(18).font('Helvetica-Bold')
      .text('ACUSE DE FIRMA ELECTRONICA', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica')
      .text('Cofianza — Ley 527 de 1999', { align: 'center' });
    doc.moveDown(1.5);

    // Horizontal rule
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke('#cccccc');
    doc.moveDown(1);

    // Section: Datos del contrato
    doc.fontSize(12).font('Helvetica-Bold').text('DATOS DEL CONTRATO');
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica');
    addField(doc, 'Contrato', contrato.nombre_archivo || 'N/A');
    addField(doc, 'Expediente', contrato.expedientes?.numero || 'N/A');
    addField(doc, 'Inmueble', formatInmueble(contrato.expedientes?.inmuebles));
    doc.moveDown(1);

    // Section: Datos del firmante
    doc.fontSize(12).font('Helvetica-Bold').text('DATOS DEL FIRMANTE');
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica');
    addField(doc, 'Nombre', solicitud.nombre_firmante);
    addField(doc, 'Email', solicitud.email_firmante);
    doc.moveDown(1);

    // Imagen de la firma manuscrita (canvas) — evidencia visual.
    if (firmaImagenBuffer) {
      doc.fontSize(12).font('Helvetica-Bold').text('FIRMA MANUSCRITA');
      doc.moveDown(0.5);
      try {
        // El canvas guarda la firma como PNG. La encajamos en un cuadro
        // de 280x100pt centrado al margen izquierdo. fit:[w,h] preserva
        // la relacion de aspecto.
        doc.image(firmaImagenBuffer, doc.x, doc.y, { fit: [280, 100] });
        // Avanzar el cursor manualmente porque doc.image no lo hace
        doc.moveDown(6);
        doc.moveTo(50, doc.y).lineTo(330, doc.y).stroke('#000000');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica-Bold').text(solicitud.nombre_firmante);
        doc.fontSize(8).font('Helvetica').fillColor('#666666')
          .text('Firma electronica capturada en canvas');
        doc.fillColor('#000000');
      } catch (err) {
        logger.warn({ err }, 'Acuse: no se pudo embedir la imagen de firma');
      }
      doc.moveDown(1);
    }

    // Section: Evidencia de firma
    doc.fontSize(12).font('Helvetica-Bold').text('EVIDENCIA DE FIRMA');
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica');
    addField(doc, 'Fecha y hora de firma (UTC)', data.firmadoEn);
    addField(doc, 'Verificacion OTP (UTC)', data.otpVerificadoEn);
    addField(doc, 'Direccion IP', data.ip);
    addField(doc, 'User Agent', data.userAgent);

    if (data.geoLatitud !== null && data.geoLongitud !== null) {
      addField(doc, 'Geolocalizacion', `${data.geoLatitud}, ${data.geoLongitud}`);
    } else {
      addField(doc, 'Geolocalizacion', 'No proporcionada por el firmante');
    }
    doc.moveDown(1);

    // Section: Integridad del documento
    doc.fontSize(12).font('Helvetica-Bold').text('INTEGRIDAD DEL DOCUMENTO');
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica');
    addField(doc, 'Hash SHA-256', data.hashDocumento);
    doc.moveDown(0.5);
    doc.fontSize(8).font('Helvetica').fillColor('#666666')
      .text('Este hash permite verificar que el documento no fue alterado despues de la firma.');
    doc.fillColor('#000000');
    doc.moveDown(1.5);

    // Horizontal rule
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke('#cccccc');
    doc.moveDown(1);

    // Legal footer
    doc.fontSize(8).font('Helvetica')
      .text(
        'Este acuse constituye evidencia legal de la firma electronica realizada conforme a la Ley 527 de 1999 de Colombia sobre comercio electronico y firmas digitales, y la Ley 1581 de 2012 sobre proteccion de datos personales.',
        { align: 'justify' },
      );
    doc.moveDown(0.5);
    doc.text(
      `Documento generado automaticamente por Cofianza el ${new Date().toISOString()}`,
      { align: 'center' },
    );

    doc.end();
  });
}

function addField(doc: PDFKit.PDFDocument, label: string, value: string) {
  doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
  doc.font('Helvetica').text(value);
}

function formatInmueble(inmueble: { direccion: string; ciudad: string } | null | undefined): string {
  if (!inmueble) return 'N/A';
  return inmueble.ciudad ? `${inmueble.direccion}, ${inmueble.ciudad}` : inmueble.direccion;
}

// ============================================================
// Ensure acuse exists (auto-heal de acuses faltantes/desactualizados)
//
// Reconstruye el acuse PDF para una solicitud_firma firmada cuando:
// - No tiene acuse_storage_key (race con fire-and-forget original)
// - O queremos forzar regeneracion (eg. nueva version del acuse con
//   firma manuscrita visible que la version vieja no incluia)
//
// Idempotente: si el acuse ya existe y `force=false`, retorna su key.
// Devuelve null si no se pudo (ej. solicitud no firmada todavia).
// ============================================================

export async function ensureAcuseExists(
  solicitudId: string,
  options: { force?: boolean } = {},
): Promise<string | null> {
  const { force = false } = options;

  // 1. Cargar solicitud + contrato + evidencia
  const { data: solRow } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, contrato_id, nombre_firmante, email_firmante, estado, token_expiracion,
      contratos!inner(
        id, nombre_archivo, expediente_id,
        expedientes(numero, inmuebles(direccion, ciudad))
      )
    `)
    .eq('id', solicitudId)
    .single();

  if (!solRow) return null;

  const sol = solRow as unknown as {
    id: string;
    contrato_id: string;
    nombre_firmante: string;
    email_firmante: string;
    estado: string;
    token_expiracion: string;
    contratos: {
      id: string;
      nombre_archivo: string | null;
      expediente_id: string;
      expedientes: {
        numero: string;
        inmuebles: { direccion: string; ciudad: string } | null;
      } | null;
    };
  };

  if (sol.estado !== 'firmado') return null;

  const { data: evRow } = await (supabase
    .from('evidencias_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, ip_firmante, user_agent, geo_latitud, geo_longitud, otp_verificado_en, firma_imagen_key, firmado_en, hash_documento, acuse_storage_key')
    .eq('solicitud_firma_id', solicitudId)
    .single();

  if (!evRow) return null;

  const ev = evRow as unknown as {
    id: string;
    ip_firmante: string;
    user_agent: string;
    geo_latitud: number | null;
    geo_longitud: number | null;
    otp_verificado_en: string;
    firma_imagen_key: string;
    firmado_en: string;
    hash_documento: string;
    acuse_storage_key: string | null;
  };

  // 2. Si ya existe y no se fuerza, devolverlo. Pero antes verificamos
  //    su tamano: la version vieja del acuse no incluia la imagen de la
  //    firma manuscrita y pesaba ~3-4KB. La version actual con la imagen
  //    embebida pesa >8KB. Si el acuse existente es chico, lo
  //    consideramos desactualizado y forzamos regeneracion para que el
  //    usuario vea su firma en el PDF descargable.
  if (ev.acuse_storage_key && !force) {
    try {
      const { data: blob } = await supabase.storage
        .from(BUCKET_NAME)
        .download(ev.acuse_storage_key);
      if (blob) {
        const buf = Buffer.from(await blob.arrayBuffer());
        if (buf.length >= 8 * 1024) {
          return ev.acuse_storage_key;
        }
        logger.info(
          { evidenciaId: ev.id, sizeBytes: buf.length },
          'Acuse desactualizado (sin imagen de firma) — regenerando',
        );
      }
    } catch (err) {
      logger.warn(
        { evidenciaId: ev.id, err: err instanceof Error ? err.message : String(err) },
        'No se pudo verificar tamano del acuse — regenerando por seguridad',
      );
    }
  }

  // 3. Regenerar.
  await generateAndStoreAcuse(
    ev.id,
    {
      id: sol.id,
      contrato_id: sol.contrato_id,
      nombre_firmante: sol.nombre_firmante,
      email_firmante: sol.email_firmante,
      estado: sol.estado,
      token_expiracion: sol.token_expiracion,
    },
    sol.contratos,
    {
      ip: ev.ip_firmante,
      userAgent: ev.user_agent,
      firmadoEn: ev.firmado_en,
      hashDocumento: ev.hash_documento,
      otpVerificadoEn: ev.otp_verificado_en,
      geoLatitud: ev.geo_latitud,
      geoLongitud: ev.geo_longitud,
      firmaKey: ev.firma_imagen_key,
    },
  );

  // 4. Releer acuse_storage_key (lo acaba de actualizar generateAndStoreAcuse).
  const { data: refreshed } = await (supabase
    .from('evidencias_firma' as string) as ReturnType<typeof supabase.from>)
    .select('acuse_storage_key')
    .eq('id', ev.id)
    .single();
  return ((refreshed as { acuse_storage_key?: string | null } | null)?.acuse_storage_key) || null;
}

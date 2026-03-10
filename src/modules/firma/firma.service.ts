import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { sendFirmaEmail } from '@/lib/email';
import * as aucoClient from '@/lib/auco';
import type { AucoWebhookPayload } from '@/lib/auco';
import type { CrearSolicitudFirmaInput } from './firma.schema';

// ============================================================
// Constants
// ============================================================

const TOKEN_EXPIRY_HOURS = 72;
const MAX_ENVIOS_DEFAULT = 5;
const BUCKET_NAME = 'documentos-expedientes';

// Estados validos del contrato para crear solicitudes de firma
const ESTADOS_VALIDOS_FIRMA = ['pendiente_firma'];

const SOLICITUD_SELECT = `
  id, contrato_id, nombre_firmante, email_firmante, telefono_firmante,
  token, token_expiracion, estado, envios_realizados, max_envios,
  enviado_por, abierto_en, firmado_en, ip_firmante, user_agent_firmante,
  auco_document_code, auco_signed_url,
  created_at, updated_at
`;

// ============================================================
// Types
// ============================================================

interface SolicitudFirmaRow {
  id: string;
  contrato_id: string;
  nombre_firmante: string;
  email_firmante: string;
  telefono_firmante: string | null;
  token: string;
  token_expiracion: string;
  estado: string;
  envios_realizados: number;
  max_envios: number;
  enviado_por: string;
  abierto_en: string | null;
  firmado_en: string | null;
  ip_firmante: string | null;
  user_agent_firmante: string | null;
  auco_document_code: string | null;
  auco_signed_url: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Crear solicitud y enviar a Auco para firma
// ============================================================

export async function crearSolicitudFirma(
  input: CrearSolicitudFirmaInput,
  userId: string,
  ip?: string,
) {
  // 1. Validate contrato exists and is in valid state
  const { data: contrato, error: contratoError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, expediente_id, storage_key, nombre_archivo')
    .eq('id', input.contrato_id)
    .single();

  if (contratoError || !contrato) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  const c = contrato as unknown as {
    id: string; estado: string; expediente_id: string;
    storage_key: string | null; nombre_archivo: string | null;
  };

  if (!ESTADOS_VALIDOS_FIRMA.includes(c.estado)) {
    throw AppError.badRequest(
      `El contrato debe estar en estado "Pendiente de firma" para enviar una solicitud. Estado actual: ${c.estado}`,
      'INVALID_CONTRACT_STATE',
    );
  }

  if (!c.storage_key) {
    throw AppError.badRequest(
      'El contrato no tiene PDF generado para enviar a firma',
      'NO_PDF',
    );
  }

  // 2. Fetch expediente + inmueble data for the email
  const { data: expediente } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero_expediente, inmuebles(direccion, ciudad)')
    .eq('id', c.expediente_id)
    .single();

  const exp = expediente as unknown as {
    numero_expediente: string;
    inmuebles: { direccion: string; ciudad: string } | null;
  } | null;

  // 3. Generate secure token
  const token = crypto.randomBytes(32).toString('hex');
  const tokenExpiracion = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  // 4. Download PDF from storage and upload to Auco
  let aucoDocumentCode: string | null = null;
  const direccionInmueble = exp?.inmuebles?.direccion || 'N/A';
  const ciudadInmueble = exp?.inmuebles?.ciudad || '';

  try {
    const { data: pdfData, error: downloadError } = await supabase.storage
      .from(BUCKET_NAME)
      .download(c.storage_key);

    if (downloadError || !pdfData) {
      throw new Error(downloadError?.message || 'No se pudo descargar el PDF');
    }

    const buffer = Buffer.from(await pdfData.arrayBuffer());
    const pdfBase64 = aucoClient.bufferToBase64(buffer);

    const processName = `Contrato - ${exp?.numero_expediente || c.id}`;

    aucoDocumentCode = await aucoClient.uploadDocumentForSignature({
      email: env.AUCO_SENDER_EMAIL,
      name: processName,
      subject: `Firma de contrato de arrendamiento - ${direccionInmueble}${ciudadInmueble ? `, ${ciudadInmueble}` : ''}`,
      message: `Estimado/a ${input.nombre_firmante}, se le invita a revisar y firmar el contrato de arrendamiento del inmueble ubicado en ${direccionInmueble}${ciudadInmueble ? `, ${ciudadInmueble}` : ''}. Por favor revise el documento y proceda con la firma electrónica.`,
      file: pdfBase64,
      signProfile: [{
        name: input.nombre_firmante,
        email: input.email_firmante,
        phone: input.telefono_firmante || '',
        role: 'SIGNER',
      }],
      otpCode: true,
      expiredDate: tokenExpiracion,
      webhooks: ['default'],
    });
  } catch (aucoError) {
    logger.error({ error: aucoError, contratoId: c.id }, 'Error al enviar documento a Auco');
    // Continue without Auco — still create solicitud with our own email link as fallback
  }

  // 5. Insert solicitud
  const { data: solicitud, error: insertError } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .insert({
      contrato_id: input.contrato_id,
      nombre_firmante: input.nombre_firmante,
      email_firmante: input.email_firmante,
      telefono_firmante: input.telefono_firmante || null,
      token,
      token_expiracion: tokenExpiracion,
      estado: 'enviado',
      envios_realizados: 1,
      max_envios: MAX_ENVIOS_DEFAULT,
      enviado_por: userId,
      auco_document_code: aucoDocumentCode,
    } as never)
    .select(SOLICITUD_SELECT)
    .single();

  if (insertError || !solicitud) {
    logger.error({ error: insertError?.message }, 'Error al crear solicitud de firma');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear la solicitud de firma');
  }

  const row = solicitud as unknown as SolicitudFirmaRow;

  // 6. Send our own notification email (as backup/complement to Auco's email)
  const firmaUrl = `${env.FRONTEND_URL}/firma/${token}`;

  try {
    await sendFirmaEmail(
      input.email_firmante,
      input.nombre_firmante,
      firmaUrl,
      TOKEN_EXPIRY_HOURS,
      {
        direccion_inmueble: direccionInmueble,
        ciudad_inmueble: ciudadInmueble,
        nombre_arrendatario: input.nombre_firmante,
      },
    );
  } catch (emailError) {
    logger.error({ error: emailError, solicitudId: row.id }, 'Error al enviar email de firma');
  }

  // 7. Audit log
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.FIRMA_SOLICITUD_CREATED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: input.contrato_id,
    detalle: {
      solicitud_id: row.id,
      email_firmante: input.email_firmante,
      nombre_firmante: input.nombre_firmante,
      auco_document_code: aucoDocumentCode,
    },
    ip,
  });

  return {
    ...row,
    firma_url: firmaUrl,
  };
}

// ============================================================
// Reenviar link (nuevo token + Auco reminder)
// ============================================================

export async function reenviarSolicitudFirma(
  solicitudId: string,
  userId: string,
  ip?: string,
) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select(`${SOLICITUD_SELECT}, contratos(expediente_id, expedientes(numero_expediente, inmuebles(direccion, ciudad)))`)
    .eq('id', solicitudId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Solicitud de firma no encontrada', 'SOLICITUD_NOT_FOUND');
  }

  const row = data as unknown as SolicitudFirmaRow & {
    contratos: {
      expediente_id: string;
      expedientes: {
        numero_expediente: string;
        inmuebles: { direccion: string; ciudad: string } | null;
      } | null;
    } | null;
  };

  // Check estado
  if (['firmado', 'cancelado'].includes(row.estado)) {
    throw AppError.badRequest(
      'No se puede reenviar una solicitud en este estado',
      'INVALID_SOLICITUD_STATE',
    );
  }

  // Check max envios
  if (row.envios_realizados >= row.max_envios) {
    throw AppError.badRequest(
      `Se alcanzó el máximo de envíos permitidos (${row.max_envios})`,
      'MAX_ENVIOS_REACHED',
    );
  }

  // Send Auco reminder if document code exists
  if (row.auco_document_code) {
    try {
      await aucoClient.sendReminder(row.auco_document_code);
    } catch (aucoError) {
      logger.error({ error: aucoError, solicitudId }, 'Error al enviar recordatorio via Auco');
    }
  }

  // Generate new token
  const newToken = crypto.randomBytes(32).toString('hex');
  const newExpiration = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  const { data: updated, error: updateError } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .update({
      token: newToken,
      token_expiracion: newExpiration,
      estado: 'enviado',
      envios_realizados: row.envios_realizados + 1,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', solicitudId)
    .select(SOLICITUD_SELECT)
    .single();

  if (updateError || !updated) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al reenviar la solicitud');
  }

  // Send email
  const firmaUrl = `${env.FRONTEND_URL}/firma/${newToken}`;
  const direccion = row.contratos?.expedientes?.inmuebles?.direccion || 'N/A';
  const ciudad = row.contratos?.expedientes?.inmuebles?.ciudad || '';

  try {
    await sendFirmaEmail(
      row.email_firmante,
      row.nombre_firmante,
      firmaUrl,
      TOKEN_EXPIRY_HOURS,
      {
        direccion_inmueble: direccion,
        ciudad_inmueble: ciudad,
        nombre_arrendatario: row.nombre_firmante,
      },
    );
  } catch (emailError) {
    logger.error({ error: emailError, solicitudId }, 'Error al reenviar email de firma');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.FIRMA_SOLICITUD_RESENT,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: row.contrato_id,
    detalle: { solicitud_id: solicitudId, envio_numero: row.envios_realizados + 1 },
    ip,
  });

  return updated as unknown as SolicitudFirmaRow;
}

// ============================================================
// Consultar estado de una solicitud
// ============================================================

export async function getSolicitud(solicitudId: string) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select(`${SOLICITUD_SELECT}, perfiles(id, nombre, apellido)`)
    .eq('id', solicitudId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Solicitud de firma no encontrada', 'SOLICITUD_NOT_FOUND');
  }

  const row = data as unknown as SolicitudFirmaRow & {
    perfiles: { id: string; nombre: string; apellido: string } | null;
  };

  return {
    ...row,
    enviado_por_nombre: row.perfiles
      ? `${row.perfiles.nombre} ${row.perfiles.apellido}`
      : null,
    token: undefined, // Don't expose token
    perfiles: undefined,
  };
}

// ============================================================
// Listar solicitudes de un contrato
// ============================================================

export async function listarSolicitudes(contratoId: string) {
  // Verify contrato exists
  const { data: contrato } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', contratoId)
    .single();

  if (!contrato) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select(`${SOLICITUD_SELECT}, perfiles(id, nombre, apellido)`)
    .eq('contrato_id', contratoId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error: error.message, contratoId }, 'Error al listar solicitudes de firma');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener las solicitudes');
  }

  const solicitudes = (data ?? []).map((row: unknown) => {
    const r = row as SolicitudFirmaRow & {
      perfiles: { id: string; nombre: string; apellido: string } | null;
    };
    return {
      id: r.id,
      contrato_id: r.contrato_id,
      nombre_firmante: r.nombre_firmante,
      email_firmante: r.email_firmante,
      telefono_firmante: r.telefono_firmante,
      estado: r.estado,
      envios_realizados: r.envios_realizados,
      max_envios: r.max_envios,
      token_expiracion: r.token_expiracion,
      abierto_en: r.abierto_en,
      firmado_en: r.firmado_en,
      auco_document_code: r.auco_document_code,
      created_at: r.created_at,
      updated_at: r.updated_at,
      enviado_por_nombre: r.perfiles
        ? `${r.perfiles.nombre} ${r.perfiles.apellido}`
        : null,
    };
  });

  return { solicitudes };
}

// ============================================================
// Cancelar solicitud (+ cancelar en Auco)
// ============================================================

export async function cancelarSolicitud(
  solicitudId: string,
  userId: string,
  ip?: string,
) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, estado, auco_document_code')
    .eq('id', solicitudId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Solicitud no encontrada', 'SOLICITUD_NOT_FOUND');
  }

  const row = data as unknown as {
    id: string; contrato_id: string; estado: string; auco_document_code: string | null;
  };

  if (['firmado', 'cancelado'].includes(row.estado)) {
    throw AppError.badRequest('No se puede cancelar esta solicitud', 'INVALID_STATE');
  }

  // Cancel in Auco if document code exists
  if (row.auco_document_code) {
    try {
      await aucoClient.cancelDocument(row.auco_document_code);
    } catch (aucoError) {
      logger.error({ error: aucoError, solicitudId }, 'Error al cancelar documento en Auco');
    }
  }

  const { error: updateError } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'cancelado',
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', solicitudId);

  if (updateError) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al cancelar la solicitud');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.FIRMA_SOLICITUD_CANCELLED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: row.contrato_id,
    detalle: { solicitud_id: solicitudId },
    ip,
  });
}

// ============================================================
// Validar token (para pagina publica)
// ============================================================

export async function validarToken(token: string) {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, nombre_firmante, email_firmante, estado, token_expiracion')
    .eq('token', token)
    .single();

  if (error || !data) {
    throw AppError.notFound('Enlace de firma no válido', 'INVALID_TOKEN');
  }

  const row = data as unknown as {
    id: string;
    contrato_id: string;
    nombre_firmante: string;
    email_firmante: string;
    estado: string;
    token_expiracion: string;
  };

  // Check expiration
  if (new Date(row.token_expiracion) < new Date()) {
    if (row.estado !== 'expirado' && row.estado !== 'firmado' && row.estado !== 'cancelado') {
      await (supabase
        .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'expirado', updated_at: new Date().toISOString() } as never)
        .eq('id', row.id);
    }
    throw AppError.badRequest('El enlace de firma ha expirado', 'TOKEN_EXPIRED');
  }

  if (['firmado', 'cancelado', 'expirado'].includes(row.estado)) {
    throw AppError.badRequest(
      row.estado === 'firmado'
        ? 'Este contrato ya fue firmado'
        : 'Este enlace ya no es válido',
      'INVALID_TOKEN_STATE',
    );
  }

  // Mark as opened if first time
  if (row.estado === 'enviado') {
    await (supabase
      .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
      .update({
        estado: 'abierto',
        abierto_en: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never)
      .eq('id', row.id);
  }

  // Fetch contrato + expediente info for display
  const { data: contratoData } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, nombre_archivo, expedientes(numero_expediente, inmuebles(direccion, ciudad))')
    .eq('id', row.contrato_id)
    .single();

  const cc = contratoData as unknown as {
    id: string;
    nombre_archivo: string | null;
    expedientes: {
      numero_expediente: string;
      inmuebles: { direccion: string; ciudad: string } | null;
    } | null;
  } | null;

  return {
    solicitud_id: row.id,
    nombre_firmante: row.nombre_firmante,
    email_firmante: row.email_firmante,
    estado: row.estado === 'enviado' ? 'abierto' : row.estado,
    token_expiracion: row.token_expiracion,
    contrato_nombre: cc?.nombre_archivo || 'Contrato',
    expediente_numero: cc?.expedientes?.numero_expediente || '',
    inmueble_direccion: cc?.expedientes?.inmuebles?.direccion || '',
    inmueble_ciudad: cc?.expedientes?.inmuebles?.ciudad || '',
  };
}

// ============================================================
// Get contract PDF for public signing page (HP-342)
// ============================================================

const PDF_URL_EXPIRY_SECONDS = 600; // 10 minutes

export async function getContratoPdf(token: string) {
  // Validate token first
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, estado, token_expiracion')
    .eq('token', token)
    .single();

  if (error || !data) {
    throw AppError.notFound('Enlace de firma no válido', 'INVALID_TOKEN');
  }

  const row = data as unknown as {
    id: string;
    contrato_id: string;
    estado: string;
    token_expiracion: string;
  };

  // Check expiration
  if (new Date(row.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de firma ha expirado', 'TOKEN_EXPIRED');
  }

  // Check state
  if (['firmado', 'cancelado', 'expirado'].includes(row.estado)) {
    throw AppError.badRequest('Este enlace ya no es válido', 'INVALID_TOKEN_STATE');
  }

  // Get contract storage_key
  const { data: contratoData, error: contratoError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, storage_key, nombre_archivo')
    .eq('id', row.contrato_id)
    .single();

  if (contratoError || !contratoData) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  const contrato = contratoData as unknown as {
    id: string;
    storage_key: string | null;
    nombre_archivo: string | null;
  };

  if (!contrato.storage_key) {
    throw AppError.badRequest('El contrato no tiene PDF generado', 'NO_PDF');
  }

  // Generate signed URL (read-only, no download header)
  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(contrato.storage_key, PDF_URL_EXPIRY_SECONDS);

  if (urlError || !urlData?.signedUrl) {
    logger.error({ error: urlError, storageKey: contrato.storage_key }, 'Error creating signed URL for PDF');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el PDF');
  }

  return {
    pdf_url: urlData.signedUrl,
    nombre_archivo: contrato.nombre_archivo || 'contrato.pdf',
    expira_en_segundos: PDF_URL_EXPIRY_SECONDS,
  };
}

// ============================================================
// Auco Webhook Handler
// ============================================================

/**
 * Process incoming webhook notifications from Auco.
 * Maps Auco statuses to our internal solicitud states:
 *   NOTIFICATION → abierto (signer was notified / opened)
 *   FINISH       → firmado (all signers completed)
 *   REJECTED     → cancelado (signer rejected)
 *   BLOCKED      → cancelado (too many failed attempts)
 *   EXPIRED      → expirado (past deadline)
 */
export async function handleAucoWebhook(payload: AucoWebhookPayload) {
  const { code, status, url: signedUrl } = payload;

  logger.info({ code, status }, 'Auco webhook received');

  // Find solicitud by auco_document_code
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, estado')
    .eq('auco_document_code', code)
    .single();

  if (error || !data) {
    logger.warn({ code }, 'Auco webhook: solicitud not found for document code');
    return;
  }

  const row = data as unknown as { id: string; contrato_id: string; estado: string };

  // Don't update if already in terminal state
  if (['firmado', 'cancelado', 'expirado'].includes(row.estado)) {
    logger.debug({ id: row.id, estado: row.estado, aucoStatus: status }, 'Auco webhook: solicitud already in terminal state');
    return;
  }

  const now = new Date().toISOString();
  let newEstado: string | null = null;
  const updateFields: Record<string, unknown> = { updated_at: now };

  switch (status) {
    case 'NOTIFICATION':
      if (row.estado === 'enviado' || row.estado === 'pendiente') {
        newEstado = 'abierto';
        updateFields.abierto_en = now;
      }
      break;

    case 'FINISH':
      newEstado = 'firmado';
      updateFields.firmado_en = now;
      if (signedUrl) {
        updateFields.auco_signed_url = signedUrl;
      }
      break;

    case 'REJECTED':
    case 'REJECT':
    case 'BLOCKED':
      newEstado = 'cancelado';
      break;

    case 'EXPIRED':
      newEstado = 'expirado';
      break;

    default:
      logger.debug({ code, status }, 'Auco webhook: unhandled status');
      return;
  }

  if (newEstado) {
    updateFields.estado = newEstado;

    await (supabase
      .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
      .update(updateFields as never)
      .eq('id', row.id);

    logger.info(
      { solicitudId: row.id, oldEstado: row.estado, newEstado, aucoStatus: status },
      'Solicitud de firma updated via Auco webhook',
    );

    if (newEstado === 'firmado') {
      logAudit({
        usuarioId: null,
        accion: AUDIT_ACTIONS.FIRMA_AUCO_SIGNED,
        entidad: AUDIT_ENTITIES.CONTRATO,
        entidadId: row.contrato_id,
        detalle: {
          solicitud_id: row.id,
          auco_code: code,
          signed_url: signedUrl,
        },
      });
    }
  }
}

// ============================================================
// Bulk token expiration (cron)
// ============================================================

export async function expirarSolicitudesVencidas(): Promise<{ expiradas: number }> {
  const now = new Date().toISOString();

  // Find all solicitudes with expired tokens that are still in active states
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id')
    .in('estado', ['pendiente', 'enviado', 'abierto', 'otp_validado'])
    .lt('token_expiracion', now);

  if (error) {
    logger.error({ error: error.message }, 'Error al buscar solicitudes expiradas');
    return { expiradas: 0 };
  }

  const rows = (data as unknown as { id: string; contrato_id: string }[]) || [];

  if (rows.length === 0) {
    return { expiradas: 0 };
  }

  const ids = rows.map((r) => r.id);

  const { error: updateError } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'expirado', updated_at: new Date().toISOString() } as never)
    .in('id', ids);

  if (updateError) {
    logger.error({ error: updateError.message }, 'Error al expirar solicitudes en bulk');
    return { expiradas: 0 };
  }

  logger.info({ count: rows.length, ids }, 'Solicitudes de firma expiradas por cron');

  return { expiradas: rows.length };
}

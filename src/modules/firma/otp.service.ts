import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { sendOtpEmail } from '@/lib/email';

// ============================================================
// Constants
// ============================================================

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const MAX_INTENTOS = 3;
const COOLDOWN_SECONDS = 60;

// ============================================================
// Types
// ============================================================

interface CodigoOtpRow {
  id: string;
  solicitud_firma_id: string;
  codigo_hash: string;
  canal: string;
  expiracion: string;
  intentos_realizados: number;
  max_intentos: number;
  verificado_en: string | null;
  invalidado: boolean;
  created_at: string;
}

interface SolicitudForOtp {
  id: string;
  nombre_firmante: string;
  email_firmante: string;
  telefono_firmante: string | null;
  estado: string;
  token_expiracion: string;
}

// ============================================================
// Helpers
// ============================================================

function generateOtpCode(): string {
  // Cryptographically secure 6-digit code
  const bytes = crypto.randomBytes(4);
  const num = bytes.readUInt32BE(0) % 1_000_000;
  return num.toString().padStart(OTP_LENGTH, '0');
}

function hashOtp(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

// ============================================================
// Validate token and return solicitud
// ============================================================

async function getSolicitudByToken(token: string): Promise<SolicitudForOtp> {
  const { data, error } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre_firmante, email_firmante, telefono_firmante, estado, token_expiracion')
    .eq('token', token)
    .single();

  if (error || !data) {
    throw AppError.notFound('Enlace de firma no valido', 'INVALID_TOKEN');
  }

  const row = data as unknown as SolicitudForOtp;

  // Check token expiration
  if (new Date(row.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de firma ha expirado', 'TOKEN_EXPIRED');
  }

  // Check terminal states
  if (['firmado', 'cancelado', 'expirado'].includes(row.estado)) {
    throw AppError.badRequest('Este enlace ya no es valido', 'INVALID_TOKEN_STATE');
  }

  return row;
}

// ============================================================
// Solicitar OTP (generate + send)
// ============================================================

export async function solicitarOtp(token: string) {
  const solicitud = await getSolicitudByToken(token);

  // Check cooldown: find last OTP created for this solicitud
  const { data: lastOtp } = await (supabase
    .from('codigos_otp' as string) as ReturnType<typeof supabase.from>)
    .select('id, created_at')
    .eq('solicitud_firma_id', solicitud.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (lastOtp) {
    const last = lastOtp as unknown as { id: string; created_at: string };
    const elapsed = (Date.now() - new Date(last.created_at).getTime()) / 1000;
    if (elapsed < COOLDOWN_SECONDS) {
      const wait = Math.ceil(COOLDOWN_SECONDS - elapsed);
      throw new AppError(429, 'OTP_COOLDOWN', `Debes esperar ${wait} segundos antes de solicitar un nuevo codigo`);
    }
  }

  // Invalidate all previous unverified OTPs for this solicitud
  await (supabase
    .from('codigos_otp' as string) as ReturnType<typeof supabase.from>)
    .update({ invalidado: true } as never)
    .eq('solicitud_firma_id', solicitud.id)
    .is('verificado_en', null)
    .eq('invalidado', false);

  // Generate and hash OTP
  const code = generateOtpCode();
  const codeHash = hashOtp(code);
  const expiracion = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  // Determine channel
  const canal = 'email'; // SMS not implemented yet

  // Insert OTP record
  const { error: insertError } = await (supabase
    .from('codigos_otp' as string) as ReturnType<typeof supabase.from>)
    .insert({
      solicitud_firma_id: solicitud.id,
      codigo_hash: codeHash,
      canal,
      expiracion,
      intentos_realizados: 0,
      max_intentos: MAX_INTENTOS,
    } as never);

  if (insertError) {
    logger.error({ error: insertError.message }, 'Error al crear codigo OTP');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al generar el codigo');
  }

  // Send OTP via email
  try {
    await sendOtpEmail(solicitud.email_firmante, solicitud.nombre_firmante, code);
  } catch (emailError) {
    logger.error({ error: emailError, solicitudId: solicitud.id }, 'Error al enviar OTP por email');
    throw new AppError(500, 'EMAIL_ERROR', 'Error al enviar el codigo de verificacion');
  }

  logger.info({ solicitudId: solicitud.id, canal }, 'OTP enviado');

  return {
    enviado: true,
    canal,
    destino_enmascarado: maskEmail(solicitud.email_firmante),
    expira_en_minutos: OTP_EXPIRY_MINUTES,
  };
}

// ============================================================
// Verificar OTP
// ============================================================

export async function verificarOtp(token: string, codigo: string) {
  const solicitud = await getSolicitudByToken(token);

  // Find the active (non-invalidated, non-verified) OTP for this solicitud
  const { data: otpData, error: otpError } = await (supabase
    .from('codigos_otp' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('solicitud_firma_id', solicitud.id)
    .eq('invalidado', false)
    .is('verificado_en', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (otpError || !otpData) {
    throw AppError.badRequest(
      'No hay un codigo OTP activo. Solicita uno nuevo.',
      'NO_ACTIVE_OTP',
    );
  }

  const otp = otpData as unknown as CodigoOtpRow;

  // Check expiration
  if (new Date(otp.expiracion) < new Date()) {
    // Mark as invalidated
    await (supabase
      .from('codigos_otp' as string) as ReturnType<typeof supabase.from>)
      .update({ invalidado: true } as never)
      .eq('id', otp.id);

    throw AppError.badRequest(
      'El codigo ha expirado. Solicita uno nuevo.',
      'OTP_EXPIRED',
    );
  }

  // Check max attempts
  if (otp.intentos_realizados >= otp.max_intentos) {
    // Mark as invalidated
    await (supabase
      .from('codigos_otp' as string) as ReturnType<typeof supabase.from>)
      .update({ invalidado: true } as never)
      .eq('id', otp.id);

    throw AppError.badRequest(
      'Se alcanzaron los intentos maximos. Solicita un nuevo codigo.',
      'MAX_ATTEMPTS_REACHED',
    );
  }

  // Compare hashes
  const inputHash = hashOtp(codigo);
  const isValid = inputHash === otp.codigo_hash;

  if (!isValid) {
    // Increment attempts
    const newAttempts = otp.intentos_realizados + 1;
    await (supabase
      .from('codigos_otp' as string) as ReturnType<typeof supabase.from>)
      .update({ intentos_realizados: newAttempts } as never)
      .eq('id', otp.id);

    const remaining = otp.max_intentos - newAttempts;

    logger.warn(
      { solicitudId: solicitud.id, intentos: newAttempts },
      'OTP verification failed',
    );

    if (remaining <= 0) {
      // Invalidate after max attempts
      await (supabase
        .from('codigos_otp' as string) as ReturnType<typeof supabase.from>)
        .update({ invalidado: true } as never)
        .eq('id', otp.id);

      throw AppError.badRequest(
        'Codigo incorrecto. Se alcanzaron los intentos maximos. Solicita un nuevo codigo.',
        'MAX_ATTEMPTS_REACHED',
      );
    }

    throw AppError.badRequest(
      `Codigo incorrecto. Te quedan ${remaining} intento${remaining === 1 ? '' : 's'}.`,
      'INVALID_OTP',
      { intentos_restantes: remaining },
    );
  }

  // OTP is valid — mark as verified
  const now = new Date().toISOString();
  await (supabase
    .from('codigos_otp' as string) as ReturnType<typeof supabase.from>)
    .update({ verificado_en: now } as never)
    .eq('id', otp.id);

  // Update solicitud estado to otp_validado
  await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'otp_validado',
      updated_at: now,
    } as never)
    .eq('id', solicitud.id);

  logger.info({ solicitudId: solicitud.id }, 'OTP verified successfully');

  return {
    verificado: true,
    estado: 'otp_validado',
  };
}

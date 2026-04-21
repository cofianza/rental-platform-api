import crypto from 'node:crypto';
import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config';
import { sendVerificationEmail } from '@/lib/email';
import type {
  RegisterPropietarioInput,
  RegisterInmobiliariaInput,
  ResendVerificationInput,
} from './registration.schema';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function registerPropietario(
  input: RegisterPropietarioInput,
  ipAddress: string,
  userAgent: string,
): Promise<{ message: string }> {
  const { email, password, nombre, apellido, telefono, tipo_documento,
          numero_documento, direccion } = input;

  const { data: authData, error: authError } = await supabaseAuth.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
    user_metadata: { nombre, apellido, rol: 'propietario' },
  });

  if (authError) {
    logger.error({ error: authError.message, email }, 'Error al crear usuario propietario');
    if (authError.message.includes('already') || authError.message.includes('duplicate')) {
      throw AppError.conflict('Ya existe un usuario con este email', 'EMAIL_ALREADY_EXISTS');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el usuario');
  }

  const userId = authData.user.id;

  // El trigger handle_new_user() ya creo la fila en perfiles con estado='activo'
  // Actualizamos inmediatamente a estado='inactivo' y agregamos campos extra
  const { error: updateError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({
      rol: 'propietario',
      estado: 'inactivo',
      telefono,
      tipo_documento,
      numero_documento,
      direccion,
      registration_source: 'email',
    } as never)
    .eq('id', userId);

  if (updateError) {
    logger.error({ error: updateError.message, userId }, 'Error al actualizar perfil de propietario');
  }

  await recordTermsAcceptance(userId, ipAddress, userAgent);
  await generateAndSendVerificationEmail(userId, email, nombre);

  logger.info({ userId, email, rol: 'propietario' }, 'Propietario registrado exitosamente');

  return { message: 'Registro exitoso. Revisa tu correo para verificar tu cuenta.' };
}

export async function registerInmobiliaria(
  input: RegisterInmobiliariaInput,
  ipAddress: string,
  userAgent: string,
): Promise<{ message: string }> {
  const { email, password, razon_social, nit, direccion_comercial, ciudad,
          nombre_representante_nombre, nombre_representante_apellido, telefono } = input;

  const { data: authData, error: authError } = await supabaseAuth.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
    user_metadata: {
      nombre: nombre_representante_nombre,
      apellido: nombre_representante_apellido,
      rol: 'inmobiliaria',
    },
  });

  if (authError) {
    logger.error({ error: authError.message, email }, 'Error al crear usuario inmobiliaria');
    if (authError.message.includes('already') || authError.message.includes('duplicate')) {
      throw AppError.conflict('Ya existe un usuario con este email', 'EMAIL_ALREADY_EXISTS');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el usuario');
  }

  const userId = authData.user.id;
  const nombre_representante = `${nombre_representante_nombre} ${nombre_representante_apellido}`.trim();

  const { error: updateError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({
      rol: 'inmobiliaria',
      estado: 'inactivo',
      telefono,
      tipo_documento: 'nit',
      numero_documento: nit,
      razon_social,
      nit,
      direccion_comercial,
      ciudad,
      nombre_representante,
      registration_source: 'email',
    } as never)
    .eq('id', userId);

  if (updateError) {
    logger.error({ error: updateError.message, userId }, 'Error al actualizar perfil de inmobiliaria');
  }

  await recordTermsAcceptance(userId, ipAddress, userAgent);
  await generateAndSendVerificationEmail(userId, email, nombre_representante_nombre);

  logger.info({ userId, email, rol: 'inmobiliaria' }, 'Inmobiliaria registrada exitosamente');

  return { message: 'Registro exitoso. Revisa tu correo para verificar tu cuenta.' };
}

export async function verifyEmail(token: string): Promise<{ message: string }> {
  const tokenHash = hashToken(token);

  const { data: tokenData, error: tokenError } = await supabase
    .from('email_verification_tokens' as string)
    .select('id, user_id, expires_at, used_at')
    .eq('token_hash', tokenHash)
    .is('used_at', null)
    .single<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();

  if (tokenError || !tokenData) {
    throw AppError.badRequest('Token de verificacion invalido o expirado', 'INVALID_VERIFICATION_TOKEN');
  }

  if (new Date(tokenData.expires_at) < new Date()) {
    throw AppError.badRequest('Token de verificacion invalido o expirado', 'INVALID_VERIFICATION_TOKEN');
  }

  // Marcar token como usado
  await (supabase
    .from('email_verification_tokens' as string) as ReturnType<typeof supabase.from>)
    .update({ used_at: new Date().toISOString() } as never)
    .eq('id', tokenData.id);

  // Marcar email como verificado en perfiles (NO activa la cuenta)
  await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({ email_verified_at: new Date().toISOString() } as never)
    .eq('id', tokenData.user_id);

  // Confirmar email en Supabase Auth
  await supabaseAuth.auth.admin.updateUserById(tokenData.user_id, {
    email_confirm: true,
  });

  logger.info({ userId: tokenData.user_id }, 'Email verificado exitosamente');

  return { message: 'Email verificado exitosamente. Tu cuenta sera activada por un administrador.' };
}

export async function resendVerification({ email }: ResendVerificationInput): Promise<{ message: string }> {
  const genericMessage = 'Si el email existe en nuestro sistema, recibiras un nuevo enlace de verificacion.';

  const { data: userResult, error: rpcError } = await supabase
    .rpc('find_user_by_email' as never, { user_email: email } as never)
    .single<{ id: string; email: string }>();

  if (rpcError || !userResult) {
    return { message: genericMessage };
  }

  // Verificar que no este ya verificado
  const { data: perfil } = await supabase
    .from('perfiles' as string)
    .select('email_verified_at, nombre')
    .eq('id', userResult.id)
    .single<{ email_verified_at: string | null; nombre: string }>();

  if (perfil?.email_verified_at) {
    return { message: genericMessage };
  }

  await generateAndSendVerificationEmail(userResult.id, email, perfil?.nombre || '');

  return { message: genericMessage };
}

// --- Helpers ---

/**
 * Persiste la aceptación de términos + tratamiento de datos del usuario.
 * Exportado para reuso desde vitrina.service.registerSolicitante (el flujo
 * público del solicitante requiere la misma evidencia legal que propietario
 * e inmobiliaria: user_id + timestamps + IP + user-agent).
 *
 * Error policy: log-only. No se revierte el registro del usuario si este
 * INSERT falla — decisión heredada del flujo propietario/inmobiliaria.
 */
export async function recordTermsAcceptance(
  userId: string,
  ipAddress: string,
  userAgent: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await (supabase
    .from('terminos_aceptaciones' as string) as ReturnType<typeof supabase.from>)
    .insert({
      user_id: userId,
      acepta_terminos: true,
      acepta_tratamiento_datos: true,
      terminos_aceptados_at: now,
      datos_aceptados_at: now,
      ip_address: ipAddress,
      user_agent: userAgent,
    } as never);

  if (error) {
    logger.error({ error: error.message, userId }, 'Error al registrar aceptacion de terminos');
  }
}

async function generateAndSendVerificationEmail(
  userId: string,
  email: string,
  nombre: string,
): Promise<void> {
  // Invalidar tokens previos de este usuario
  await (supabase
    .from('email_verification_tokens' as string) as ReturnType<typeof supabase.from>)
    .update({ used_at: new Date().toISOString() } as never)
    .eq('user_id', userId)
    .is('used_at', null);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { error: insertError } = await (supabase
    .from('email_verification_tokens' as string) as ReturnType<typeof supabase.from>)
    .insert({
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    } as never);

  if (insertError) {
    logger.error({ error: insertError.message }, 'Error al guardar token de verificacion');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error interno del servidor');
  }

  const verifyUrl = `${env.FRONTEND_URL}/verificar-email?token=${rawToken}`;

  try {
    await sendVerificationEmail(email, nombre, verifyUrl);
  } catch (emailError) {
    logger.error({ error: emailError, email }, 'Error al enviar email de verificacion');
    // No fallar el registro por error de email
  }

  logger.info({ email, userId }, 'Email de verificacion enviado');
}

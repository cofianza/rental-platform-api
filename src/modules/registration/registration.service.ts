import crypto from 'node:crypto';
import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config';
import { sendVerificationEmail } from '@/lib/email';
import { ensureOrgConOwner } from '@/lib/tenantScope';
import type {
  RegisterPropietarioInput,
  RegisterInmobiliariaInput,
  ResendVerificationInput,
} from './registration.schema';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * ¿El error de supabaseAuth.admin.createUser corresponde a un email ya
 * registrado? El texto del mensaje varía según la versión de GoTrue
 * ("already registered", "email_exists", …); nos apoyamos también en el
 * `code`/`status` para no clasificar un duplicado como 500 genérico.
 */
function esEmailDuplicado(err: { message?: string; code?: string; status?: number }): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return (
    msg.includes('already') ||
    msg.includes('duplicate') ||
    msg.includes('exists') ||
    err.code === 'email_exists' ||
    err.status === 422
  );
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
    logger.error({ error: authError.message, code: authError.code, status: authError.status, email }, 'Error al crear usuario propietario');
    if (esEmailDuplicado(authError)) {
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
          nombre_representante_nombre, nombre_representante_apellido, telefono,
          cargo_representante, afianzadora_actual, afianzadora_tipo } = input;

  // NIT duplicado. La web ya tenia una rama para `NIT_ALREADY_EXISTS` y ese
  // codigo no existia en todo el API: el registro escribia el NIT sin consultar
  // y acto seguido ensureOrgConOwner creaba una SEGUNDA organizacion con la
  // misma razon social — cartera partida, equipo invisible, y dos clientes DIAN
  // donde hay uno. Va antes de createUser para no dejar un usuario huerfano.
  // El cierre duradero es el indice unico (migracion 20260916000001); esto
  // ademas da un mensaje que dice que hacer.
  const { data: nitExistente } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('nit', nit)
    .limit(1)
    .maybeSingle();
  if (nitExistente) {
    throw AppError.conflict(
      'Ya hay una inmobiliaria registrada con este NIT. Pídele al titular de la cuenta que te invite a su equipo.',
      'NIT_ALREADY_EXISTS',
    );
  }

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
    logger.error({ error: authError.message, code: authError.code, status: authError.status, email }, 'Error al crear usuario inmobiliaria');
    if (esEmailDuplicado(authError)) {
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
      // El campo es opcional y la migracion 20260512000003 lo agrega; si la
      // BD aun no tiene la columna, ignorar el undefined sin romper el insert.
      ...(cargo_representante ? { cargo_representante } : {}),
      // Afianzadora/aseguradora actual (tarea 1.6, migración 20260706000002).
      ...(afianzadora_actual ? { afianzadora_actual } : {}),
      ...(afianzadora_tipo ? { afianzadora_tipo } : {}),
      registration_source: 'email',
    } as never)
    .eq('id', userId);

  if (updateError) {
    // 23505 = el indice unico uq_perfiles_nit (migracion 20260916000001) gano la
    // carrera que el pre-chequeo de arriba no puede cerrar.
    if ((updateError as { code?: string }).code === '23505') {
      await supabaseAuth.auth.admin.deleteUser(userId).catch(() => undefined);
      throw AppError.conflict(
        'Ya hay una inmobiliaria registrada con este NIT. Pídele al titular de la cuenta que te invite a su equipo.',
        'NIT_ALREADY_EXISTS',
      );
    }
    // Antes solo se logueaba y el usuario leia "Registro exitoso" sobre un
    // perfil sin razon social, sin NIT y sin rol de inmobiliaria — una cuenta
    // inservible que nadie sabia que estaba rota. Se borra el usuario de auth
    // para que pueda reintentar con el mismo correo.
    logger.error({ error: updateError.message, userId }, 'Error al actualizar perfil de inmobiliaria');
    await supabaseAuth.auth.admin.deleteUser(userId).catch((e) =>
      logger.error({ err: e, userId }, 'No se pudo limpiar el usuario tras fallar el perfil'),
    );
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo completar el registro. Inténtalo de nuevo.');
  }

  // Multi-tenant: crear la organización con esta inmobiliaria como owner, para
  // que pueda invitar miembros. Idempotente. Log-only: si falla, el registro
  // no se aborta (el scoping cae al fallback por propietario_id).
  try {
    await ensureOrgConOwner(userId, razon_social);
  } catch (orgError) {
    logger.error({ error: (orgError as Error).message, userId }, 'Error al crear organización de inmobiliaria');
  }

  await recordTermsAcceptance(userId, ipAddress, userAgent);
  await generateAndSendVerificationEmail(userId, email, nombre_representante_nombre);

  logger.info({ userId, email, rol: 'inmobiliaria' }, 'Inmobiliaria registrada exitosamente');

  return { message: 'Registro exitoso. Revisa tu correo para verificar tu cuenta.' };
}

export async function verifyEmail(token: string): Promise<{ message: string }> {
  const tokenHash = hashToken(token);

  const { data: tokenData } = await supabase
    .from('email_verification_tokens' as string)
    .select('id, user_id, expires_at, used_at')
    .eq('token_hash', tokenHash)
    .maybeSingle<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();

  if (!tokenData) {
    throw AppError.badRequest('Token de verificacion invalido o expirado', 'INVALID_VERIFICATION_TOKEN');
  }

  // Idempotencia: si el enlace ya se usó (doble click en el correo, o el
  // usuario lo reabre) y la cuenta ya quedó verificada, respondemos éxito en
  // vez de un "enlace inválido" alarmante — la cuenta ya está activa.
  if (tokenData.used_at) {
    const { data: perfilRow } = await (supabase
      .from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('email_verified_at')
      .eq('id', tokenData.user_id)
      .maybeSingle();
    const perfilVerificado = perfilRow as { email_verified_at: string | null } | null;
    if (perfilVerificado?.email_verified_at) {
      return { message: 'Tu correo ya estaba verificado. Ya puedes iniciar sesion.' };
    }
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

  // Marcar email como verificado y activar la cuenta. El registro arranca
  // en estado='inactivo' como medida anti-bot/anti-spam; al verificar el
  // email (prueba de control sobre la casilla) consideramos legitimo el
  // alta y activamos el perfil para que pueda iniciar sesion.
  const nowIso = new Date().toISOString();
  await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({
      email_verified_at: nowIso,
      estado: 'activo',
    } as never)
    .eq('id', tokenData.user_id);

  // Confirmar email en Supabase Auth
  await supabaseAuth.auth.admin.updateUserById(tokenData.user_id, {
    email_confirm: true,
  });

  logger.info({ userId: tokenData.user_id }, 'Email verificado y cuenta activada');

  return { message: 'Email verificado. Tu cuenta esta activa, ya puedes iniciar sesion.' };
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

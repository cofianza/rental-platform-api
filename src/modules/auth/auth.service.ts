import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config';
import { sendPasswordResetEmail } from '@/lib/email';
import type { LoginInput, RefreshInput, ForgotPasswordInput, ResetPasswordInput } from './auth.schema';

export async function loginWithEmail({ email, password }: LoginInput) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    logger.warn({ email, error: error.message }, 'Login fallido');
    throw AppError.unauthorized('Credenciales invalidas', 'INVALID_CREDENTIALS');
  }

  // Verificar que el perfil este activo y obtener el rol
  const { data: perfil, error: perfilError } = await supabase
    .from('perfiles')
    .select('estado, rol')
    .eq('id', data.user.id)
    .single<{ estado: string; rol: string }>();

  if (perfilError) {
    logger.warn({ userId: data.user.id, error: perfilError }, 'Error al obtener perfil en login');
  }

  if (perfil && perfil.estado !== 'activo') {
    // Cerrar la sesion recien creada
    await supabase.auth.admin.signOut(data.session.access_token);
    throw AppError.forbidden('Cuenta desactivada', 'ACCOUNT_INACTIVE');
  }

  const userRol = perfil?.rol ?? 'operador_analista';
  logger.info({ userId: data.user.id, rol: userRol, perfilRol: perfil?.rol }, 'Login exitoso');

  return {
    user: {
      id: data.user.id,
      email: data.user.email,
      rol: userRol,
    },
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    },
  };
}

export function getGoogleOAuthUrl() {
  const redirectTo = `${env.CORS_ORIGIN}/auth/callback`;

  // Supabase genera la URL de OAuth para Google
  // El frontend redirige al usuario a esta URL
  return {
    provider: 'google' as const,
    redirectTo,
    // La URL real se construye en el frontend con supabase.auth.signInWithOAuth()
    // En el backend solo documentamos la configuracion necesaria
    instructions: 'Usar supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } }) desde el frontend',
  };
}

export async function refreshSession({ refresh_token }: RefreshInput) {
  const { data, error } = await supabase.auth.refreshSession({ refresh_token });

  if (error || !data.session) {
    throw AppError.unauthorized('Refresh token invalido o expirado', 'INVALID_REFRESH_TOKEN');
  }

  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  };
}

export async function logout(accessToken: string) {
  const { error } = await supabase.auth.admin.signOut(accessToken);

  if (error) {
    logger.warn({ error: error.message }, 'Error al cerrar sesion');
    // No lanzar error - el token puede haber expirado naturalmente
  }
}

export async function getProfile(userId: string) {
  // Obtener perfil de la tabla perfiles
  const { data: perfil, error: perfilError } = await supabase
    .from('perfiles' as string)
    .select('id, nombre, apellido, rol, estado, created_at, updated_at')
    .eq('id', userId)
    .single<{ id: string; nombre: string; apellido: string; rol: string; estado: string; created_at: string; updated_at: string }>();

  if (perfilError || !perfil) {
    throw AppError.notFound('Perfil no encontrado');
  }

  // Obtener email de auth.users
  const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);

  if (userError || !user) {
    throw AppError.notFound('Usuario no encontrado');
  }

  // Construir respuesta con datos combinados
  return {
    id: perfil.id,
    email: user.email || '',
    nombre_completo: `${perfil.nombre} ${perfil.apellido}`.trim(),
    rol: perfil.rol,
    activo: perfil.estado === 'activo',
    created_at: perfil.created_at,
    updated_at: perfil.updated_at,
  };
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function forgotPassword({ email }: ForgotPasswordInput) {
  // Buscar usuario por email en auth.users via RPC (perfiles no tiene columna email)
  const { data: userResult, error: rpcError } = await supabase
    .rpc('find_user_by_email' as never, { user_email: email } as never)
    .single<{ id: string; email: string }>();

  if (rpcError || !userResult) {
    logger.info({ email }, 'Solicitud de reset para email no registrado');
    return; // No revelar que el email no existe
  }

  const userId = userResult.id;

  // Verificar si es cuenta Google-only (sin password)
  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId);

  if (userError || !userData?.user) {
    logger.error({ userId, error: userError?.message }, 'Error al obtener usuario');
    return;
  }

  const identities = userData.user.identities ?? [];
  const hasEmailIdentity = identities.some((i) => i.provider === 'email');

  if (!hasEmailIdentity && identities.length > 0) {
    // Usuario registrado solo con Google, no tiene contrasena
    logger.info({ email }, 'Solicitud de reset para cuenta Google-only');
    return; // No revelar informacion sobre el tipo de cuenta
  }

  // Invalidar todos los tokens previos del usuario
  await (supabase
    .from('password_reset_tokens' as string) as ReturnType<typeof supabase.from>)
    .update({ used_at: new Date().toISOString() } as never)
    .eq('user_id', userId)
    .is('used_at', null);

  // Generar token seguro
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora

  // Guardar en base de datos
  const { error: insertError } = await (supabase
    .from('password_reset_tokens' as string) as ReturnType<typeof supabase.from>)
    .insert({
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    } as never);

  if (insertError) {
    logger.error({ error: insertError.message }, 'Error al guardar token de reset');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error interno del servidor');
  }

  // Enviar email
  const resetUrl = `${env.FRONTEND_URL}/restablecer-contrasena?token=${rawToken}`;
  await sendPasswordResetEmail(email, resetUrl);

  logger.info({ email, userId }, 'Token de reset generado y email enviado');
}

export async function validateResetToken(token: string) {
  const tokenHash = hashToken(token);

  const { data, error } = await supabase
    .from('password_reset_tokens' as string)
    .select('id, expires_at, used_at')
    .eq('token_hash', tokenHash)
    .is('used_at', null)
    .single<{ id: string; expires_at: string; used_at: string | null }>();

  if (error || !data) {
    throw AppError.badRequest('Token invalido o expirado', 'INVALID_RESET_TOKEN');
  }

  if (new Date(data.expires_at) < new Date()) {
    throw AppError.badRequest('Token invalido o expirado', 'INVALID_RESET_TOKEN');
  }

  return { valid: true };
}

export async function resetPassword({ token, password }: ResetPasswordInput) {
  const tokenHash = hashToken(token);

  // Buscar y validar token
  const { data: tokenData, error: tokenError } = await supabase
    .from('password_reset_tokens' as string)
    .select('id, user_id, expires_at, used_at')
    .eq('token_hash', tokenHash)
    .is('used_at', null)
    .single<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();

  if (tokenError || !tokenData) {
    throw AppError.badRequest('Token invalido o expirado', 'INVALID_RESET_TOKEN');
  }

  if (new Date(tokenData.expires_at) < new Date()) {
    throw AppError.badRequest('Token invalido o expirado', 'INVALID_RESET_TOKEN');
  }

  // Actualizar contrasena en Supabase Auth
  const { error: updateError } = await supabase.auth.admin.updateUserById(tokenData.user_id, {
    password,
  });

  if (updateError) {
    logger.error({ error: updateError.message }, 'Error al actualizar contrasena');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al restablecer la contrasena');
  }

  // Marcar token como usado
  await (supabase
    .from('password_reset_tokens' as string) as ReturnType<typeof supabase.from>)
    .update({ used_at: new Date().toISOString() } as never)
    .eq('id', tokenData.id);

  // Revocar todas las sesiones del usuario
  await supabase.auth.admin.signOut(tokenData.user_id, 'global');

  logger.info({ userId: tokenData.user_id }, 'Contrasena restablecida exitosamente');

  return { message: 'Contrasena restablecida exitosamente' };
}

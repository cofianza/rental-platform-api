import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config';
import type { LoginInput, RefreshInput } from './auth.schema';

export async function loginWithEmail({ email, password }: LoginInput) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    logger.warn({ email, error: error.message }, 'Login fallido');
    throw AppError.unauthorized('Credenciales invalidas', 'INVALID_CREDENTIALS');
  }

  // Verificar que el perfil este activo
  const { data: perfil } = await supabase
    .from('perfiles' as string)
    .select('activo')
    .eq('id', data.user.id)
    .single<{ activo: boolean }>();

  if (perfil && !perfil.activo) {
    // Cerrar la sesion recien creada
    await supabase.auth.admin.signOut(data.session.access_token);
    throw AppError.forbidden('Cuenta desactivada', 'ACCOUNT_INACTIVE');
  }

  return {
    user: {
      id: data.user.id,
      email: data.user.email,
      rol: data.user.user_metadata?.rol ?? 'sin_rol',
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
  const { data, error } = await supabase
    .from('perfiles' as string)
    .select('id, email, nombre_completo, rol, activo, created_at, updated_at')
    .eq('id', userId)
    .single<{ id: string; email: string; nombre_completo: string; rol: string; activo: boolean; created_at: string; updated_at: string }>();

  if (error || !data) {
    throw AppError.notFound('Perfil no encontrado');
  }

  return data;
}

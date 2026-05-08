import crypto from 'node:crypto';
import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendPasswordResetEmail } from '@/lib/email';
import type { LoginInput, RefreshInput, ForgotPasswordInput, ResetPasswordInput, UpdateMyProfileInput } from './auth.schema';

export async function loginWithEmail({ email, password }: LoginInput, ip?: string) {
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

  if (error) {
    logger.warn({ email, error: error.message }, 'Login fallido');
    logAudit({
      usuarioId: null,
      accion: AUDIT_ACTIONS.LOGIN_FAILED,
      entidad: AUDIT_ENTITIES.SESSION,
      detalle: { email },
      ip,
    });

    // Detección tolerante: Supabase puede cambiar el texto exacto entre
    // versiones del SDK. `includes('not confirmed')` cubre las variantes
    // conocidas; si no matchea, caemos al genérico INVALID_CREDENTIALS.
    const msg = (error.message || '').toLowerCase();
    if (msg.includes('not confirmed') || msg.includes('not_confirmed')) {
      throw AppError.unauthorized(
        'Aún no has verificado tu correo. Revisa tu bandeja de entrada (y la carpeta de spam).',
        'EMAIL_NOT_CONFIRMED',
      );
    }

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
    await supabaseAuth.auth.admin.signOut(data.session.access_token);
    throw AppError.forbidden('Cuenta desactivada', 'ACCOUNT_INACTIVE');
  }

  const userRol = perfil?.rol ?? 'operador_analista';
  logger.info({ userId: data.user.id, rol: userRol, perfilRol: perfil?.rol }, 'Login exitoso');

  logAudit({
    usuarioId: data.user.id,
    accion: AUDIT_ACTIONS.LOGIN_SUCCESS,
    entidad: AUDIT_ENTITIES.SESSION,
    detalle: { email: data.user.email, rol: userRol },
    ip,
  });

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
  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token });

  if (error || !data.session) {
    throw AppError.unauthorized('Refresh token invalido o expirado', 'INVALID_REFRESH_TOKEN');
  }

  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  };
}

export async function logout(accessToken: string, userId?: string, ip?: string) {
  const { error } = await supabaseAuth.auth.admin.signOut(accessToken);

  if (error) {
    logger.warn({ error: error.message }, 'Error al cerrar sesion');
    // No lanzar error - el token puede haber expirado naturalmente
  }

  if (userId) {
    logAudit({
      usuarioId: userId,
      accion: AUDIT_ACTIONS.LOGOUT,
      entidad: AUDIT_ENTITIES.SESSION,
      ip,
    });
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
  const { data: { user }, error: userError } = await supabaseAuth.auth.admin.getUserById(userId);

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

// ============================================================
// Mi cuenta — perfil extendido (incluye telefono, documento, etc).
// Para rol='solicitante', merge con la fila correspondiente en
// `solicitantes` (donde vive el documento) usando creado_por = userId.
// ============================================================
type PerfilExtRow = {
  id: string;
  nombre: string;
  apellido: string;
  telefono: string | null;
  tipo_documento: string | null;
  numero_documento: string | null;
  rol: string;
  estado: string;
  avatar_url: string | null;
  nombre_representante: string | null;
  created_at: string;
  updated_at: string;
};

type SolicitanteRow = {
  id: string;
  nombre: string;
  apellido: string;
  tipo_documento: string;
  numero_documento: string;
  telefono: string | null;
};

async function getSolicitanteByUser(userId: string): Promise<SolicitanteRow | null> {
  const { data } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre, apellido, tipo_documento, numero_documento, telefono')
    .eq('creado_por', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SolicitanteRow | null) ?? null;
}

export async function getMyProfile(userId: string) {
  const { data: perfilRaw, error: perfilError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, nombre, apellido, telefono, tipo_documento, numero_documento, ' +
      'rol, estado, avatar_url, nombre_representante, created_at, updated_at',
    )
    .eq('id', userId)
    .single();

  if (perfilError || !perfilRaw) {
    throw AppError.notFound('Perfil no encontrado');
  }

  const perfil = perfilRaw as unknown as PerfilExtRow;

  const { data: { user }, error: userError } = await supabaseAuth.auth.admin.getUserById(userId);
  if (userError || !user) {
    throw AppError.notFound('Usuario no encontrado');
  }

  // Para solicitantes, el documento autoritativo vive en `solicitantes`
  // (porque se sincroniza con el documento consultado en TransUnion).
  // Devolvemos esos campos por encima de los de `perfiles`.
  const solicitante = perfil.rol === 'solicitante' ? await getSolicitanteByUser(userId) : null;

  return {
    id: perfil.id,
    email: user.email || '',
    nombre: solicitante?.nombre || perfil.nombre,
    apellido: solicitante?.apellido || perfil.apellido,
    telefono: solicitante?.telefono ?? perfil.telefono ?? null,
    tipo_documento: solicitante?.tipo_documento ?? perfil.tipo_documento ?? null,
    numero_documento: solicitante?.numero_documento ?? perfil.numero_documento ?? null,
    rol: perfil.rol,
    avatar_url: perfil.avatar_url,
    nombre_representante: perfil.nombre_representante,
    activo: perfil.estado === 'activo',
    created_at: perfil.created_at,
    updated_at: perfil.updated_at,
  };
}

// ============================================================
// Mi cuenta — actualizar mi propio perfil.
// - Para todos los roles: actualiza perfiles (nombre, apellido, telefono,
//   documento, nombre_representante).
// - Para rol='solicitante': si el documento cambia, validamos que NO haya
//   estudios crediticios activos (porque el documento ya fue consultado y
//   reflejarlo aqui implicaria inconsistencia con TransUnion).
// - Para rol='solicitante': si existe fila en `solicitantes`, la actualizamos
//   en sincro con perfiles.
// ============================================================
export async function updateMyProfile(userId: string, input: UpdateMyProfileInput) {
  const { data: actualRaw, error: actualErr } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('rol, tipo_documento, numero_documento')
    .eq('id', userId)
    .single();

  if (actualErr || !actualRaw) {
    throw AppError.notFound('Perfil no encontrado');
  }

  const actual = actualRaw as unknown as { rol: string; tipo_documento: string | null; numero_documento: string | null };

  const wantsTipoDoc = input.tipo_documento ?? null;
  const wantsNumDoc = input.numero_documento ?? null;
  const docCambia =
    (wantsTipoDoc !== null && wantsTipoDoc !== actual.tipo_documento) ||
    (wantsNumDoc !== null && wantsNumDoc !== actual.numero_documento);

  // Solicitantes: bloquear cambio de documento si ya hay estudios crediticios
  // activos (en_proceso o completado) — el CC consultado en TransUnion no
  // puede divergir del registrado en el sistema sin invalidar trazabilidad.
  // Los estudios de expedientes CANCELADOS no cuentan: el solicitante puede
  // arrancar de cero con otro documento si su expediente fue cancelado.
  if (actual.rol === 'solicitante' && docCambia) {
    const sol = await getSolicitanteByUser(userId);
    if (sol) {
      const { data: exps } = await (supabase
        .from('expedientes' as string) as ReturnType<typeof supabase.from>)
        .select('id')
        .eq('solicitante_id', sol.id)
        .is('cancelado_at', null);
      const expIds = ((exps as { id: string }[] | null) ?? []).map((e) => e.id);
      if (expIds.length > 0) {
        const { count: estCount } = await (supabase
          .from('estudios' as string) as ReturnType<typeof supabase.from>)
          .select('id', { count: 'exact', head: true })
          .in('expediente_id', expIds)
          .in('estado', ['en_proceso', 'completado']);
        if ((estCount ?? 0) > 0) {
          throw AppError.badRequest(
            'No puedes cambiar tu documento porque ya tienes un estudio crediticio en curso o completado. Contacta soporte si necesitas corregirlo.',
            'DOCUMENTO_BLOQUEADO_POR_ESTUDIO',
          );
        }
      }
    }
  }

  const perfilPatch: Record<string, unknown> = {
    nombre: input.nombre,
    apellido: input.apellido,
    telefono: input.telefono,
    updated_at: new Date().toISOString(),
  };
  if (input.tipo_documento !== undefined) perfilPatch.tipo_documento = input.tipo_documento;
  if (input.numero_documento !== undefined) perfilPatch.numero_documento = input.numero_documento;
  // nombre_representante solo aplica a inmobiliaria; lo persistimos siempre que
  // venga porque la columna existe en la tabla y otros roles lo dejan null.
  if (input.nombre_representante !== undefined) perfilPatch.nombre_representante = input.nombre_representante;

  const { error: updErr } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update(perfilPatch as never)
    .eq('id', userId);

  if (updErr) {
    // Constraint de unicidad de (tipo_documento, numero_documento) si llega
    // a existir en perfiles → mensaje claro.
    if ((updErr as { code?: string }).code === '23505') {
      throw AppError.conflict(
        'Ya existe otra cuenta con ese número de documento.',
        'DOCUMENTO_DUPLICADO',
      );
    }
    logger.error({ userId, error: updErr.message }, 'Error al actualizar perfiles');
    throw AppError.badRequest('Error al actualizar el perfil', 'PROFILE_UPDATE_ERROR');
  }

  // Sincronizar con `solicitantes` cuando aplica.
  if (actual.rol === 'solicitante') {
    const sol = await getSolicitanteByUser(userId);
    if (sol) {
      const solPatch: Record<string, unknown> = {
        nombre: input.nombre,
        apellido: input.apellido,
        telefono: input.telefono,
        updated_at: new Date().toISOString(),
      };
      if (wantsTipoDoc) solPatch.tipo_documento = wantsTipoDoc;
      if (wantsNumDoc) solPatch.numero_documento = wantsNumDoc;

      const { error: solErr } = await (supabase
        .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
        .update(solPatch as never)
        .eq('id', sol.id);

      if (solErr) {
        if ((solErr as { code?: string }).code === '23505') {
          throw AppError.conflict(
            'Ya existe otra persona registrada con ese número de documento.',
            'DOCUMENTO_DUPLICADO',
          );
        }
        logger.error({ userId, solicitanteId: sol.id, error: solErr.message }, 'Error al sincronizar solicitantes');
        throw AppError.badRequest('Error al actualizar los datos del solicitante', 'SOLICITANTE_UPDATE_ERROR');
      }
    }
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.USER_UPDATED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    detalle: { campos: Object.keys(perfilPatch) },
  });

  return getMyProfile(userId);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function forgotPassword({ email }: ForgotPasswordInput, ip?: string) {
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
  const { data: userData, error: userError } = await supabaseAuth.auth.admin.getUserById(userId);

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

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PASSWORD_RESET_REQUEST,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    detalle: { email },
    ip,
  });

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

export async function resetPassword({ token, password }: ResetPasswordInput, ip?: string) {
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
  const { error: updateError } = await supabaseAuth.auth.admin.updateUserById(tokenData.user_id, {
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
  await supabaseAuth.auth.admin.signOut(tokenData.user_id, 'global');

  logAudit({
    usuarioId: tokenData.user_id,
    accion: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETE,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: tokenData.user_id,
    ip,
  });

  logger.info({ userId: tokenData.user_id }, 'Contrasena restablecida exitosamente');

  return { message: 'Contrasena restablecida exitosamente' };
}

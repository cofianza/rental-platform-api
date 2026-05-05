import crypto from 'node:crypto';
import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendWelcomeEmail } from '@/lib/email';
import type { CreateUserInput, UpdateUserInput, ListUsersQuery } from './users.schema';

interface UserRow {
  id: string;
  email: string;
  nombre: string;
  apellido: string;
  telefono: string | null;
  tipo_documento: string | null;
  numero_documento: string | null;
  rol: string;
  estado: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
  total_count?: number;
}

export async function listUsers(query: ListUsersQuery) {
  const { page, limit, search, role, is_active, sortBy, sortOrder } = query;
  const offset = (page - 1) * limit;

  const estado = is_active === 'true' ? 'activo' : is_active === 'false' ? 'inactivo' : undefined;

  const { data, error } = await supabase
    .rpc('list_users_with_email' as never, {
      search_term: search || null,
      filter_rol: role || null,
      filter_estado: estado || null,
      sort_field: sortBy,
      sort_direction: sortOrder,
      page_limit: limit,
      page_offset: offset,
    } as never);

  if (error) {
    logger.error({ error: error.message }, 'Error al listar usuarios');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener la lista de usuarios');
  }

  const rows = (data as UserRow[]) || [];
  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;

  const users = rows.map(({ total_count: _, ...user }) => user);

  return {
    users,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getUserById(userId: string) {
  const { data, error } = await supabase
    .rpc('get_user_with_email' as never, { user_id: userId } as never);

  if (error) {
    logger.error({ error: error.message, userId }, 'Error al obtener usuario');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el usuario');
  }

  const rows = data as UserRow[];
  if (!rows || rows.length === 0) {
    throw AppError.notFound('Usuario no encontrado');
  }

  return rows[0];
}

export async function createUser(input: CreateUserInput, createdBy: string, ip?: string) {
  const { email, nombre, apellido, telefono, rol } = input;

  // Verificar que el email no exista
  const { data: existing } = await supabase
    .rpc('find_user_by_email' as never, { user_email: email } as never)
    .single<{ id: string }>();

  if (existing) {
    throw AppError.conflict('Ya existe un usuario con este email', 'EMAIL_ALREADY_EXISTS');
  }

  // Generar contrasena temporal segura
  const tempPassword = generateTempPassword();

  // Crear usuario en Supabase Auth
  const { data: authData, error: authError } = await supabaseAuth.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { nombre, apellido, rol },
  });

  if (authError) {
    logger.error({ error: authError.message, email }, 'Error al crear usuario en Supabase Auth');
    if (authError.message.includes('already been registered')) {
      throw AppError.conflict('Ya existe un usuario con este email', 'EMAIL_ALREADY_EXISTS');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el usuario');
  }

  const userId = authData.user.id;

  // Actualizar perfil con datos adicionales (el trigger ya crea la fila base)
  const updateData: Record<string, unknown> = { rol };
  if (telefono) updateData.telefono = telefono;

  const { error: updateError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update(updateData as never)
    .eq('id', userId);

  if (updateError) {
    logger.error({ error: updateError.message, userId }, 'Error al actualizar perfil');
  }

  // Registrar en bitacora
  logAudit({
    usuarioId: createdBy,
    accion: AUDIT_ACTIONS.USER_CREATED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    detalle: { email, nombre, apellido, rol },
    ip,
  });

  // Enviar email de bienvenida con contrasena temporal
  try {
    await sendWelcomeEmail(email, nombre, tempPassword);
  } catch (emailError) {
    logger.error({ error: emailError, email }, 'Error al enviar email de bienvenida');
    // No fallar la creacion por error de email
  }

  // Retornar usuario creado
  return getUserById(userId);
}

export async function updateUser(userId: string, input: UpdateUserInput, updatedBy: string, ip?: string) {
  // Obtener estado anterior para diff en bitacora
  const previousUser = await getUserById(userId);

  const updateData: Record<string, unknown> = {};
  if (input.nombre !== undefined) updateData.nombre = input.nombre;
  if (input.apellido !== undefined) updateData.apellido = input.apellido;
  if (input.telefono !== undefined) updateData.telefono = input.telefono;
  if (input.rol !== undefined) updateData.rol = input.rol;

  if (Object.keys(updateData).length === 0) {
    throw AppError.badRequest('No se proporcionaron campos para actualizar');
  }

  const { error } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update(updateData as never)
    .eq('id', userId);

  if (error) {
    logger.error({ error: error.message, userId }, 'Error al actualizar usuario');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al actualizar el usuario');
  }

  // Construir diff before/after solo con campos modificados
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(updateData)) {
    before[key] = (previousUser as unknown as Record<string, unknown>)[key];
  }

  // Registrar en bitacora con before/after
  logAudit({
    usuarioId: updatedBy,
    accion: AUDIT_ACTIONS.USER_UPDATED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    detalle: { before, after: updateData },
    ip,
  });

  return getUserById(userId);
}

export async function deactivateUser(userId: string, requestingUserId: string, ip?: string) {
  if (userId === requestingUserId) {
    throw AppError.badRequest('No puedes desactivar tu propia cuenta', 'SELF_DEACTIVATION');
  }

  // Verificar que el usuario existe
  await getUserById(userId);

  // Cambiar estado a inactivo
  const { error } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'inactivo' } as never)
    .eq('id', userId);

  if (error) {
    logger.error({ error: error.message, userId }, 'Error al desactivar usuario');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al desactivar el usuario');
  }

  // Revocar todas las sesiones del usuario
  try {
    await supabaseAuth.auth.admin.signOut(userId, 'global');
  } catch (signOutError) {
    logger.warn({ error: signOutError, userId }, 'Error al revocar sesiones del usuario');
  }

  // Registrar en bitacora
  logAudit({
    usuarioId: requestingUserId,
    accion: AUDIT_ACTIONS.USER_DEACTIVATED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    ip,
  });

  return getUserById(userId);
}

export async function activateUser(userId: string, requestingUserId: string, ip?: string) {
  // Verificar que el usuario existe
  await getUserById(userId);

  const { error } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'activo' } as never)
    .eq('id', userId);

  if (error) {
    logger.error({ error: error.message, userId }, 'Error al activar usuario');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al activar el usuario');
  }

  // Registrar en bitacora
  logAudit({
    usuarioId: requestingUserId,
    accion: AUDIT_ACTIONS.USER_ACTIVATED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    ip,
  });

  return getUserById(userId);
}

// ============================================================
// Hard delete (super-admin) — Mario, 5-may-2026
//
// Borra el usuario por completo: auth.users + perfiles (CASCADE) y todo lo
// que dependa con ON DELETE CASCADE / SET NULL. Útil para limpiar cuentas
// huérfanas y de prueba sin entrar a la BD a mano.
//
// Antes de borrar verificamos relaciones que bloquearían el DELETE
// (FKs sin política de cascade) — inmuebles del propietario, expedientes
// donde el usuario sea analista/creador, pagos, créditos, etc. Si hay,
// devolvemos detalle para que el admin sepa qué pasaría. El flag `force`
// salta la pre-flight pero igual fallará si el RDBMS rechaza, en cuyo caso
// el error se devuelve como 409 con la causa.
// ============================================================

interface DeleteCheck {
  /** Tabla → cantidad de filas que apuntan al usuario. */
  blockers: Record<string, number>;
  /** Si true, podemos borrar sin riesgo de FK violation. */
  safe: boolean;
}

async function checkDeleteBlockers(userId: string): Promise<DeleteCheck> {
  // Solo chequeamos las tablas con FKs NOT NULL sin policy de delete:
  // estas son las que bloquearán el DELETE en Postgres.
  const checks: Array<[string, () => Promise<number>]> = [
    ['inmuebles (como propietario)', async () => {
      const { count } = await (supabase
        .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('propietario_id', userId);
      return count || 0;
    }],
    ['pagos (creados por)', async () => {
      const { count } = await (supabase
        .from('pagos' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('creado_por', userId);
      return count || 0;
    }],
    ['creditos_estudios (perfil)', async () => {
      const { count } = await (supabase
        .from('creditos_estudios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('perfil_id', userId);
      return count || 0;
    }],
    ['cambios_inmuebles (autor)', async () => {
      const { count } = await (supabase
        .from('cambios_inmuebles' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('usuario_id', userId);
      return count || 0;
    }],
    ['comentarios', async () => {
      const { count } = await (supabase
        .from('comentarios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('usuario_id', userId);
      return count || 0;
    }],
  ];

  const blockers: Record<string, number> = {};
  for (const [label, fn] of checks) {
    try {
      const n = await fn();
      if (n > 0) blockers[label] = n;
    } catch {
      // Si la tabla no existe (migración pendiente), ignoramos.
    }
  }

  return { blockers, safe: Object.keys(blockers).length === 0 };
}

export interface DeleteUserResult {
  deleted: true;
  user_id: string;
  email: string | null;
}

export async function deleteUser(
  userId: string,
  requestingUserId: string,
  options: { force?: boolean } = {},
  ip?: string,
): Promise<DeleteUserResult> {
  if (userId === requestingUserId) {
    throw AppError.badRequest('No puedes eliminar tu propia cuenta', 'SELF_DELETION');
  }

  // 1. Verificar que existe + capturar email para audit / response.
  const user = await getUserById(userId);
  const email = (user as unknown as { email?: string }).email ?? null;

  // 2. Pre-flight check de relaciones bloqueantes.
  const check = await checkDeleteBlockers(userId);
  if (!check.safe && !options.force) {
    throw AppError.badRequest(
      'El usuario tiene datos asociados que bloquean el borrado. Usa force=true para intentar de todos modos.',
      'USER_HAS_DEPENDENCIES',
      { blockers: check.blockers },
    );
  }

  // 3. Borrar de auth.users → cascadea a perfiles + cualquier FK con
  //    ON DELETE CASCADE / SET NULL. Si alguna FK sin cascade lo bloquea,
  //    el RDBMS lo rechaza y caemos al catch.
  const { error: authError } = await supabaseAuth.auth.admin.deleteUser(userId);
  if (authError) {
    logger.error(
      { error: authError.message, userId },
      'Error al borrar auth.user — probablemente FK de tabla con datos contables',
    );
    throw AppError.conflict(
      `No se pudo eliminar el usuario: ${authError.message}. Tiene datos vinculados que no se pueden borrar (probablemente pagos, créditos o historial). Considera desactivar en lugar de borrar.`,
      'DELETE_BLOCKED_BY_FK',
    );
  }

  // 4. Auditoría — el registro queda aunque el perfil desaparezca, porque
  //    bitacora.usuario_id apunta al ADMIN que ejecuta, no al borrado.
  logAudit({
    usuarioId: requestingUserId,
    accion: AUDIT_ACTIONS.USER_DELETED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    detalle: { email, force: !!options.force, blockers: check.blockers },
    ip,
  });

  logger.info({ userId, email, requestingUserId }, 'Usuario eliminado completamente');

  return { deleted: true, user_id: userId, email };
}

// ============================================================
// Operators (HP-285)
// ============================================================

export async function listOperators() {
  const { data, error } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre, apellido, rol')
    .in('rol', ['administrador', 'operador_analista'])
    .eq('estado', 'activo')
    .order('nombre', { ascending: true });

  if (error) {
    logger.error({ error: error.message }, 'Error al listar operadores');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener la lista de operadores');
  }

  return (data as unknown as Array<{ id: string; nombre: string; apellido: string; rol: string }>) || [];
}

// Helpers

function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;

  let password = '';
  // Garantizar al menos 1 de cada tipo
  password += upper[crypto.randomInt(upper.length)];
  password += lower[crypto.randomInt(lower.length)];
  password += digits[crypto.randomInt(digits.length)];

  // Rellenar hasta 12 caracteres
  for (let i = password.length; i < 12; i++) {
    password += all[crypto.randomInt(all.length)];
  }

  // Mezclar
  return password.split('').sort(() => crypto.randomInt(3) - 1).join('');
}

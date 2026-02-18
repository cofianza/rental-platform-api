import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
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
      size: limit,
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
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
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
  // Verificar que el usuario existe
  await getUserById(userId);

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

  // Registrar en bitacora
  logAudit({
    usuarioId: updatedBy,
    accion: AUDIT_ACTIONS.USER_UPDATED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    detalle: updateData,
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
    await supabase.auth.admin.signOut(userId, 'global');
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

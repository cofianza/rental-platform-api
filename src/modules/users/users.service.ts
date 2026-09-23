import crypto from 'node:crypto';
import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendWelcomeEmail } from '@/lib/email';
import { invalidateAuthCache, cerrarSesionesDe } from '@/middleware/auth';
import { ensureOrgConOwner, resolveInmobiliariaIdForPerfil, resolveMembershipInmobiliariaIds } from '@/lib/tenantScope';
import { assertCuentaDeGerencia } from '@/lib/gerenciaGeneral';
import type { CreateUserInput, UpdateUserInput, ListUsersQuery, ResetPasswordByAdminInput } from './users.schema';

/** Quien hace el cambio: el correo y el rol deciden si puede tocar una cuenta de la Gerencia General. */
export interface Solicitante {
  id: string;
  email: string;
  rol: string;
}

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

export async function createUser(input: CreateUserInput, solicitante: Solicitante, ip?: string) {
  const { email, nombre, apellido, telefono, rol } = input;
  assertCuentaDeGerencia(email, solicitante, 'crearla');

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

  if (rol === 'inmobiliaria') await asegurarOrgPropia(userId, `${nombre} ${apellido ?? ''}`);

  // Registrar en bitacora
  logAudit({
    usuarioId: solicitante.id,
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

/**
 * Una inmobiliaria dada de alta desde el panel necesita su organización con
 * ella de titular, igual que en el registro. Sin eso /auth/me le da
 * rol_miembro null, la web le muestra sus datos en solo lectura y
 * createInmueble la manda a completar esos mismos datos: no podía operar.
 * Log-only como en el registro: la cuenta ya existe y ensureOrgConOwner es
 * idempotente (la migración 202609290016 repara las que quedaron sin org).
 *
 * Las fichas que ya registró sin organización (p.ej. un propietario que pasa a
 * inmobiliaria) se van con ella: con org, el alcance de solicitantes es
 * inmobiliaria_id y dejaría de verlas, y la deduplicación crearía otra ficha
 * de la misma persona. Sus inmuebles no hace falta: se ven por propietario_id.
 */
async function asegurarOrgPropia(userId: string, nombre: string): Promise<void> {
  try {
    const orgId = await ensureOrgConOwner(userId, nombre.trim());
    // ponytail: si la org ya existía y tiene la misma cédula, el índice único
    // rechaza todo el UPDATE (queda en el log); la migración sí salta esas.
    const { error } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .update({ inmobiliaria_id: orgId } as never)
      .eq('creado_por', userId)
      .is('inmobiliaria_id', null);
    if (error) throw error;
  } catch (orgError) {
    logger.error({ error: (orgError as Error).message, userId }, 'Error al crear organización de inmobiliaria');
  }
}

/**
 * ¿Alguna de estas organizaciones tiene otro miembro activo además de userId?
 * Borrar o cambiarle el rol desde /usuarios a quien tiene equipo lo saca de la
 * agencia sin pasar por los guardas de Miembros de inmobiliarias (último
 * titular, responsables, re-apuntar el titular principal). Una agencia de una
 * sola persona sí puede: no deja a nadie sin titular.
 */
async function tieneEquipo(orgIds: string[], userId: string): Promise<boolean> {
  if (!orgIds.length) return false;
  const { count, error } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .in('inmobiliaria_id', orgIds)
    .eq('estado', 'activo')
    .neq('perfil_id', userId);
  if (error) {
    logger.error({ error: error.message, userId }, 'Error al contar el equipo de la inmobiliaria');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al revisar el equipo de la inmobiliaria');
  }
  return (count ?? 0) > 0;
}

export async function updateUser(userId: string, input: UpdateUserInput, solicitante: Solicitante, ip?: string) {
  const updatedBy = solicitante.id;
  // Obtener estado anterior para diff en bitacora
  const previousUser = await getUserById(userId);

  const cambiaRol = input.rol !== undefined && input.rol !== previousUser.rol;
  if (cambiaRol) assertCuentaDeGerencia(previousUser.email, solicitante, 'cambiarle el rol');
  if (cambiaRol && userId === updatedBy) {
    // El único administrador que se quita el rol pierde el panel y solo se
    // recupera por base de datos.
    throw AppError.badRequest('No puedes cambiar tu propio rol', 'SELF_ROLE_CHANGE');
  }
  if (cambiaRol && (await tieneEquipo(await resolveMembershipInmobiliariaIds(userId), userId))) {
    throw AppError.conflict(
      'Pertenece al equipo de una inmobiliaria: primero sácalo del equipo (o pasa la titularidad a otra persona) desde Miembros de inmobiliarias.',
      'MIEMBRO_CON_EQUIPO',
    );
  }

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

  if (input.rol === 'inmobiliaria' && previousUser.rol !== 'inmobiliaria' && !(await resolveInmobiliariaIdForPerfil(userId))) {
    await asegurarOrgPropia(userId, `${input.nombre ?? previousUser.nombre} ${input.apellido ?? previousUser.apellido ?? ''}`);
  }

  // Construir diff before/after solo con campos modificados
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(updateData)) {
    before[key] = (previousUser as unknown as Record<string, unknown>)[key];
  }

  // Registrar en bitacora con before/after
  invalidateAuthCache(userId); // rol o estado nuevos: que valgan ya, no al vencer el caché de auth
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

export async function deactivateUser(userId: string, solicitante: Solicitante, ip?: string) {
  const requestingUserId = solicitante.id;
  if (userId === requestingUserId) {
    throw AppError.badRequest('No puedes desactivar tu propia cuenta', 'SELF_DEACTIVATION');
  }

  // Verificar que el usuario existe
  const objetivo = await getUserById(userId);
  assertCuentaDeGerencia(objetivo.email, solicitante, 'desactivarla');

  // Cambiar estado a inactivo
  const { error } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'inactivo' } as never)
    .eq('id', userId);

  if (error) {
    logger.error({ error: error.message, userId }, 'Error al desactivar usuario');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al desactivar el usuario');
  }

  // Revocar todas las sesiones del usuario (y su caché de auth)
  await cerrarSesionesDe(userId);

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
  invalidateAuthCache(userId); // rol o estado nuevos: que valgan ya, no al vencer el caché de auth
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
// Listar usuarios huérfanos en auth.users (sin perfil) — super-admin.
//
// Estos quedan cuando un registro falla a mitad de camino: el auth.user
// se crea, pero el INSERT en `perfiles` o `solicitantes` aborta. Quedan
// invisibles en el panel normal y bloquean reintentos del mismo email.
//
// Iteramos `auth.admin.listUsers` paginando (Supabase devuelve hasta 1000
// por llamada) y restamos los IDs que sí tienen perfil. El resultado es
// pequeño en la práctica — solo los rotos.
// ============================================================

export interface OrphanAuthUser {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  user_metadata: Record<string, unknown>;
}

export async function listOrphanAuthUsers(): Promise<OrphanAuthUser[]> {
  // Iterar auth.users paginando y, por cada lote, preguntar cuáles tienen
  // perfil. Antes se traían todos los perfiles en una consulta, pero PostgREST
  // corta en 1000 filas: pasado ese número, cuentas reales salían como
  // huérfanas (y el panel las borra). Un lote de 200 nunca llega al tope.
  const PAGE_SIZE = 100; // .in() de 100 UUID: la URL queda lejos del tope de ~8 KB del gateway
  const orphans: OrphanAuthUser[] = [];
  let page = 1;
   
  while (true) {
    const { data, error } = await supabaseAuth.auth.admin.listUsers({
      page,
      perPage: PAGE_SIZE,
    });
    if (error) {
      logger.error({ error: error.message, page }, 'Error al iterar auth.users');
      throw new AppError(500, 'INTERNAL_ERROR', 'Error al iterar auth.users');
    }
    const batch = data?.users ?? [];
    if (!batch.length) break;
    const { data: perfilesData, error: perfilesErr } = await (supabase
      .from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .in('id', batch.map((u) => u.id));
    if (perfilesErr) {
      logger.error({ error: perfilesErr.message }, 'Error al listar perfiles para detectar huérfanos');
      throw new AppError(500, 'INTERNAL_ERROR', 'Error al listar perfiles');
    }
    const perfilIds = new Set((perfilesData as unknown as Array<{ id: string }>).map((r) => r.id));
    for (const u of batch) {
      if (!perfilIds.has(u.id)) {
        orphans.push({
          id: u.id,
          email: u.email ?? null,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at ?? null,
          user_metadata: (u.user_metadata as Record<string, unknown>) || {},
        });
      }
    }
    if (batch.length < PAGE_SIZE) break;
    page += 1;
    // Hard stop como salvavidas — > 100k usuarios indica un problema serio
    // independiente de huérfanos.
    if (page > 500) break;
  }

  return orphans;
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
  /** Etiqueta legible (se muestra al admin) → filas que apuntan al usuario. */
  blockers: Record<string, number>;
  /** Si true, podemos borrar sin riesgo de FK violation. */
  safe: boolean;
}

async function checkDeleteBlockers(userId: string): Promise<DeleteCheck> {
  // Solo chequeamos las tablas con FKs NOT NULL sin policy de delete:
  // estas son las que bloquearán el DELETE en Postgres.
  const checks: Array<[string, () => Promise<number>]> = [
    ['Inmuebles a su nombre', async () => {
      const { count } = await (supabase
        .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('propietario_id', userId);
      return count || 0;
    }],
    ['Pagos que registró', async () => {
      const { count } = await (supabase
        .from('pagos' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('creado_por', userId);
      return count || 0;
    }],
    ['Paquetes de créditos', async () => {
      const { count } = await (supabase
        .from('lotes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('perfil_id', userId);
      return count || 0;
    }],
    ['Compras de créditos', async () => {
      const { count } = await (supabase
        .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('perfil_id', userId);
      return count || 0;
    }],
    ['Movimientos de créditos', async () => {
      const { count } = await (supabase
        .from('movimientos_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('perfil_id', userId);
      return count || 0;
    }],
    ['Cambios en inmuebles', async () => {
      const { count } = await (supabase
        .from('cambios_inmuebles' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('usuario_id', userId);
      return count || 0;
    }],
    ['Comentarios', async () => {
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
  solicitante: Solicitante,
  options: { force?: boolean; soloHuerfano?: boolean } = {},
  ip?: string,
): Promise<DeleteUserResult> {
  const requestingUserId = solicitante.id;
  if (userId === requestingUserId) {
    throw AppError.badRequest('No puedes eliminar tu propia cuenta', 'SELF_DELETION');
  }

  // 1. Capturar email para audit / response. Soportamos dos casos:
  //    (a) usuario "normal" con entrada en perfiles → getUserById.
  //    (b) huérfano en auth.users sin perfil (registro fallido a medias) →
  //        leer email directo de auth.admin.getUserById, sin pre-flight de
  //        FKs porque no hay nada que pueda apuntarle (perfiles está vacío).
  let email: string | null = null;
  let esHuerfano = false;
  try {
    const user = await getUserById(userId);
    email = (user as unknown as { email?: string }).email ?? null;
  } catch (err) {
    const isNotFound = err instanceof AppError && err.statusCode === 404;
    if (!isNotFound) throw err;
    // Sin perfil — verificar que sí exista en auth.users.
    const { data: authResult, error: authErr } = await supabaseAuth.auth.admin.getUserById(userId);
    if (authErr || !authResult?.user) {
      throw AppError.notFound('Usuario no encontrado en auth.users');
    }
    email = authResult.user.email ?? null;
    esHuerfano = true;
  }

  // También un huérfano con el correo de la Gerencia: su alta queda para ella.
  assertCuentaDeGerencia(email, solicitante, 'eliminarla');

  // El panel de huérfanos solo debe poder borrar huérfanos: si la lista se
  // equivocó (o quedó vieja), una cuenta real no se borra desde ahí.
  if (options.soloHuerfano && !esHuerfano) {
    throw AppError.conflict('Esta cuenta sí tiene perfil; no es huérfana. Gestiónala desde Usuarios.', 'USER_NOT_ORPHAN');
  }

  // Titular principal con equipo: owner_perfil_id es ON DELETE CASCADE, así
  // que el borrado se llevaría la organización y las membresías de todos. Ni
  // con force: primero se pasa la titularidad desde Miembros de inmobiliarias.
  if (!esHuerfano) {
    const { data: orgs, error: orgsError } = await (supabase
      .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('owner_perfil_id', userId);
    if (orgsError) {
      logger.error({ error: orgsError.message, userId }, 'Error al buscar inmobiliarias del usuario');
      throw new AppError(500, 'INTERNAL_ERROR', 'Error al revisar las inmobiliarias del usuario');
    }
    const orgIds = ((orgs as unknown as Array<{ id: string }>) ?? []).map((o) => o.id);
    if (await tieneEquipo(orgIds, userId)) {
      throw AppError.conflict(
        'Es titular principal de una inmobiliaria con equipo: borrarlo borraría la inmobiliaria. Primero pasa la titularidad a otra persona desde Miembros de inmobiliarias.',
        'USER_IS_ORG_OWNER',
      );
    }
  }

  // 2. Pre-flight check de relaciones bloqueantes — solo aplica si tiene
  //    perfil, porque las FKs son a perfiles(id). Para huérfanos saltamos.
  const check = esHuerfano
    ? { blockers: {}, safe: true }
    : await checkDeleteBlockers(userId);
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
  invalidateAuthCache(userId);
  logAudit({
    usuarioId: requestingUserId,
    accion: AUDIT_ACTIONS.USER_DELETED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    detalle: { email, force: !!options.force, blockers: check.blockers, huerfano: esHuerfano },
    ip,
  });

  logger.info({ userId, email, requestingUserId, huerfano: esHuerfano }, 'Usuario eliminado completamente');

  return { deleted: true, user_id: userId, email };
}

// ============================================================
// Reset de contrasena por administrador
// ============================================================
/**
 * Permite al admin establecer directamente una contrasena para otro
 * usuario (sin pasar por el flujo de "olvide mi contrasena"). Util para
 * resetear cuentas de soporte cuando el usuario no puede acceder a su
 * email. La contrasena ya viene validada por el schema (8+ chars,
 * mayuscula/minuscula/numero).
 *
 * Cierra todas sus sesiones: si el reset es para sacar a quien usa la cuenta
 * (comprometida, exempleado con el celular de la oficina), no sigue adentro.
 */
export async function resetPasswordByAdmin(
  userId: string,
  input: ResetPasswordByAdminInput,
  solicitante: Solicitante,
  ip?: string,
) {
  const requestingUserId = solicitante.id;
  // 1. Verificar que el usuario existe en perfiles. getUserById ya tira
  //    404 limpio si no existe.
  const user = await getUserById(userId);
  assertCuentaDeGerencia(user.email, solicitante, 'restablecer su contraseña');

  // 2. Actualizar la contrasena via Supabase Auth admin API.
  const { error } = await supabaseAuth.auth.admin.updateUserById(userId, {
    password: input.password,
  });

  if (error) {
    logger.error(
      { userId, requestingUserId, error: error.message },
      'Error al resetear contrasena por admin',
    );
    throw new AppError(500, 'PASSWORD_RESET_FAILED', `Error al actualizar la contrasena: ${error.message}`);
  }

  logger.info(
    { userId, requestingUserId, email: user.email },
    'Contrasena reseteada por administrador',
  );

  await cerrarSesionesDe(userId);
  logAudit({
    usuarioId: requestingUserId,
    accion: AUDIT_ACTIONS.PASSWORD_RESET_BY_ADMIN,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    detalle: { email_objetivo: user.email },
    ip,
  });

  return { id: userId, email: user.email, reset: true };
}

// ============================================================
// Operators (HP-285)
// ============================================================

/** El término dentro del filtro `or` de PostgREST: sin comas, paréntesis, comillas ni comodines (no cambian el filtro). */
export const terminoBusqueda = (s: string) => s.replace(/[^\p{L}\p{N} .@-]/gu, '').trim().slice(0, 60);

/**
 * Selector de propietario del formulario de inmueble (admin y operador):
 * perfiles activos por nombre, apellido o razón social. Antes la web leía
 * `perfiles` directo con la llave anon, que dejaba la tabla pública.
 */
export async function buscarPerfilesActivos(search: string) {
  const t = terminoBusqueda(search);
  if (t.length < 2) return [];
  const { data, error } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre, apellido, telefono, rol, estado')
    .eq('estado', 'activo')
    .or(`nombre.ilike.%${t}%,apellido.ilike.%${t}%,razon_social.ilike.%${t}%`)
    .order('nombre', { ascending: true })
    .limit(10);

  if (error) {
    logger.error({ error: error.message }, 'Error al buscar perfiles');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al buscar usuarios');
  }

  return (data as unknown as Array<{
    id: string;
    nombre: string;
    apellido: string;
    telefono: string | null;
    rol: string;
    estado: string;
  }>) ?? [];
}

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

import crypto from 'node:crypto';
import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendInvitacionMiembroEmail } from '../orchestrator/orchestrator.emails';
import { notificarUsuario } from '../notificaciones/notificaciones.service';
import type { AuthUser } from '@/types/auth';
import type { InvitarMiembroInput, RegistrarMiembroInput } from './inmobiliaria-miembros.schema';

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

const TOKEN_EXPIRY_DAYS = 7;

function nuevoToken(): { token: string; expiracion: string } {
  return {
    token: crypto.randomBytes(32).toString('hex'),
    expiracion: new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function truncateToken(token: string): string {
  return `${token.slice(0, 8)}***`;
}

// ============================================================
// Resolución de organización / rol del que llama
// ============================================================

type RolMiembro = 'owner' | 'miembro' | 'solo_lectura';

interface OrgMembership {
  miembro_id: string;
  inmobiliaria_id: string;
  rol_miembro: RolMiembro;
  nombre_organizacion: string;
  miembros_ven_todo: boolean;
}

/** Org (membresía activa) del usuario, o null si no pertenece a ninguna. */
async function resolveMembership(userId: string): Promise<OrgMembership | null> {
  const { data } = await db('inmobiliaria_miembros')
    .select('id, inmobiliaria_id, rol_miembro, inmobiliarias(nombre, miembros_ven_todo)')
    .eq('perfil_id', userId)
    .eq('estado', 'activo')
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  const row = data as unknown as {
    id: string;
    inmobiliaria_id: string;
    rol_miembro: RolMiembro;
    inmobiliarias: { nombre: string; miembros_ven_todo: boolean } | null;
  };
  return {
    miembro_id: row.id,
    inmobiliaria_id: row.inmobiliaria_id,
    rol_miembro: row.rol_miembro,
    nombre_organizacion: row.inmobiliarias?.nombre ?? 'Tu organización',
    miembros_ven_todo: row.inmobiliarias?.miembros_ven_todo ?? true,
  };
}

/** Nº de owners ACTIVOS de una organización (para no dejarla sin titular). */
async function contarOwnersActivos(orgId: string): Promise<number> {
  const { count } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .eq('inmobiliaria_id', orgId)
    .eq('rol_miembro', 'owner')
    .eq('estado', 'activo') as unknown as { count: number | null };
  return count ?? 0;
}

/**
 * Si `salientePerfilId` es el titular principal (inmobiliarias.owner_perfil_id),
 * re-apunta esa columna a otro owner activo de la org para que siempre referencie
 * a un titular real. Best-effort: no rompe el flujo si falla.
 */
async function reapuntarTitularPrincipalSiNecesario(orgId: string, salientePerfilId: string): Promise<void> {
  const { data: org } = await (supabase
    .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
    .select('owner_perfil_id')
    .eq('id', orgId)
    .maybeSingle();
  const ownerPrincipal = (org as { owner_perfil_id: string | null } | null)?.owner_perfil_id;
  if (ownerPrincipal !== salientePerfilId) return;

  const { data: otro } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .select('perfil_id')
    .eq('inmobiliaria_id', orgId)
    .eq('rol_miembro', 'owner')
    .eq('estado', 'activo')
    .neq('perfil_id', salientePerfilId)
    .not('perfil_id', 'is', null)
    .limit(1)
    .maybeSingle();
  const nuevoTitular = (otro as { perfil_id: string | null } | null)?.perfil_id;
  if (!nuevoTitular) return;

  const { error } = await (supabase
    .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
    .update({ owner_perfil_id: nuevoTitular } as never)
    .eq('id', orgId);
  if (error) {
    logger.warn({ error: error.message, orgId }, 'No se pudo re-apuntar owner_perfil_id');
  }
}

/**
 * Libera inmuebles/expedientes de la org que tenían a `perfilId` como
 * responsable, para no dejar asignaciones apuntando a alguien que sale del
 * equipo. Best-effort (loguea warn si falla, no rompe el flujo).
 */
async function liberarResponsablesDeMiembro(orgId: string, perfilId: string): Promise<void> {
  const [{ error: errInm }, { error: errExp }] = await Promise.all([
    db('inmuebles')
      .update({ miembro_responsable_id: null } as never)
      .eq('inmobiliaria_id', orgId)
      .eq('miembro_responsable_id', perfilId),
    db('expedientes')
      .update({ miembro_responsable_id: null } as never)
      .eq('inmobiliaria_id', orgId)
      .eq('miembro_responsable_id', perfilId),
  ]);
  if (errInm) {
    logger.warn({ error: errInm.message, perfilId }, 'No se pudieron limpiar responsables de inmuebles');
  }
  if (errExp) {
    logger.warn({ error: errExp.message, perfilId }, 'No se pudieron limpiar responsables de expedientes');
  }
}

/** Exige que el usuario sea OWNER activo de una org; devuelve su contexto. */
async function assertOwner(userId: string): Promise<OrgMembership> {
  const m = await resolveMembership(userId);
  if (!m || m.rol_miembro !== 'owner') {
    throw AppError.forbidden(
      'Sólo el titular de la inmobiliaria puede gestionar miembros',
      'NO_ES_OWNER',
    );
  }
  return m;
}

// ============================================================
// Listado de miembros (owner o miembro pueden ver el equipo)
// ============================================================

export interface MiembroView {
  id: string;
  perfil_id: string | null;
  email: string | null;
  rol_miembro: RolMiembro;
  estado: 'activo' | 'invitado' | 'revocado';
  nombre: string | null;
  apellido: string | null;
  invitado_en: string;
  es_yo: boolean;
}

/**
 * Borra invitaciones PENDIENTES vencidas de una organización (token expirado y
 * aún sin aceptar). No toca miembros activos ni filas con perfil vinculado.
 * Best-effort: se invoca al listar el equipo para mantener la tabla limpia sin
 * necesidad de un cron. El owner puede volver a invitar cuando quiera.
 */
async function limpiarInvitacionesExpiradas(orgId: string): Promise<void> {
  const { error, count } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .delete({ count: 'exact' })
    .eq('inmobiliaria_id', orgId)
    .eq('estado', 'invitado')
    .is('perfil_id', null)
    .not('token_expiracion', 'is', null)
    .lt('token_expiracion', new Date().toISOString()) as unknown as {
      error: { message: string } | null;
      count: number | null;
    };
  if (error) {
    logger.warn({ error: error.message, orgId }, 'No se pudieron limpiar invitaciones expiradas');
  } else if (count && count > 0) {
    logger.info({ orgId, count }, 'Invitaciones expiradas eliminadas');
  }
}

export async function listMiembros(userId: string): Promise<{
  organizacion: { id: string; nombre: string };
  soy_owner: boolean;
  miembros_ven_todo: boolean;
  miembros: MiembroView[];
}> {
  const m = await resolveMembership(userId);
  if (!m) {
    // Inmobiliaria sin org (no debería pasar tras ensureOrgConOwner, pero es
    // defensivo): no hay equipo que mostrar.
    return { organizacion: { id: '', nombre: '' }, soy_owner: false, miembros_ven_todo: true, miembros: [] };
  }

  // Limpieza perezosa: purga invitaciones vencidas antes de listar (sin cron).
  await limpiarInvitacionesExpiradas(m.inmobiliaria_id);

  const { data, error } = await db('inmobiliaria_miembros')
    // FK explícito: inmobiliaria_miembros tiene 2 FKs a perfiles (perfil_id e
    // invitado_por), así que hay que desambiguar el embed o PostgREST falla con
    // "more than one relationship was found".
    .select('id, email, rol_miembro, estado, perfil_id, created_at, perfiles!inmobiliaria_miembros_perfil_id_fkey(nombre, apellido)')
    .eq('inmobiliaria_id', m.inmobiliaria_id)
    .neq('estado', 'revocado')
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ error: error.message, userId }, 'Error al listar miembros');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener los miembros');
  }

  const rows = (data as unknown as Array<{
    id: string;
    email: string | null;
    rol_miembro: RolMiembro;
    estado: 'activo' | 'invitado' | 'revocado';
    perfil_id: string | null;
    created_at: string;
    perfiles: { nombre: string; apellido: string } | null;
  }>) || [];

  return {
    organizacion: { id: m.inmobiliaria_id, nombre: m.nombre_organizacion },
    soy_owner: m.rol_miembro === 'owner',
    miembros_ven_todo: m.miembros_ven_todo,
    miembros: rows.map((r) => ({
      id: r.id,
      perfil_id: r.perfil_id,
      email: r.email,
      rol_miembro: r.rol_miembro,
      estado: r.estado,
      nombre: r.perfiles?.nombre ?? null,
      apellido: r.perfiles?.apellido ?? null,
      invitado_en: r.created_at,
      es_yo: r.perfil_id === userId,
    })),
  };
}

// ============================================================
// Config de la organización: miembros_ven_todo (owner-only)
// ============================================================

export async function setMiembrosVenTodo(
  userId: string,
  value: boolean,
): Promise<{ miembros_ven_todo: boolean }> {
  const org = await assertOwner(userId);
  const { error } = await (supabase
    .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
    .update({ miembros_ven_todo: value } as never)
    .eq('id', org.inmobiliaria_id);
  if (error) {
    logger.error({ error: error.message, userId }, 'Error al actualizar miembros_ven_todo');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo actualizar la configuración');
  }
  logger.info({ inmobiliariaId: org.inmobiliaria_id, value }, 'miembros_ven_todo actualizado');
  return { miembros_ven_todo: value };
}

// ============================================================
// Invitar miembro (owner-only)
// ============================================================

export async function invitarMiembro(
  userId: string,
  input: InvitarMiembroInput,
): Promise<{ message: string; reenviada: boolean }> {
  const org = await assertOwner(userId);
  const email = input.email; // ya normalizado por el schema

  // ¿Ya existe una fila para (org, email)?
  const { data: existing } = await db('inmobiliaria_miembros')
    .select('id, estado, perfil_id')
    .eq('inmobiliaria_id', org.inmobiliaria_id)
    .eq('email', email)
    .maybeSingle();

  const ex = existing as { id: string; estado: string; perfil_id: string | null } | null;
  if (ex && ex.estado === 'activo') {
    throw AppError.conflict('Esa persona ya es miembro de tu inmobiliaria', 'MIEMBRO_YA_ACTIVO');
  }

  const { token, expiracion } = nuevoToken();
  let reenviada = false;
  let miembroRowId: string | null = ex?.id ?? null;

  if (ex) {
    // Invitación pendiente o revocada -> regenerar token y reactivar.
    reenviada = ex.estado === 'invitado';
    const { error } = await db('inmobiliaria_miembros')
      .update({
        estado: 'invitado',
        rol_miembro: input.rol_miembro,
        token,
        token_expiracion: expiracion,
        invitado_por: userId,
      } as never)
      .eq('id', ex.id);
    if (error) {
      logger.error({ error: error.message }, 'Error al regenerar invitación de miembro');
      throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo enviar la invitación');
    }
  } else {
    const { data: inserted, error } = await db('inmobiliaria_miembros').insert({
      inmobiliaria_id: org.inmobiliaria_id,
      email,
      rol_miembro: input.rol_miembro,
      estado: 'invitado',
      token,
      token_expiracion: expiracion,
      invitado_por: userId,
    } as never)
      .select('id')
      .maybeSingle();
    if (error) {
      logger.error({ error: error.message }, 'Error al crear invitación de miembro');
      throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo crear la invitación');
    }
    miembroRowId = (inserted as { id: string } | null)?.id ?? null;
  }

  await enviarEmailInvitacion(email, token, org.nombre_organizacion, userId);

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.MIEMBRO_INVITADO,
    entidad: AUDIT_ENTITIES.INMOBILIARIA_MIEMBRO,
    entidadId: miembroRowId ?? undefined,
    detalle: { inmobiliaria_id: org.inmobiliaria_id, email, rol_miembro: input.rol_miembro, reenviada },
  });

  logger.info(
    { inmobiliariaId: org.inmobiliaria_id, email, reenviada },
    'Invitación de miembro enviada',
  );
  return {
    message: reenviada ? 'Invitación reenviada' : 'Invitación enviada',
    reenviada,
  };
}

async function enviarEmailInvitacion(
  email: string,
  token: string,
  nombreOrg: string,
  invitadorId: string,
): Promise<void> {
  // Nombre del invitador (para el correo). Best-effort.
  let nombreInvitador = nombreOrg;
  const { data: perfil } = await db('perfiles')
    .select('nombre, apellido, razon_social')
    .eq('id', invitadorId)
    .maybeSingle();
  const p = perfil as { nombre: string | null; apellido: string | null; razon_social: string | null } | null;
  if (p) {
    nombreInvitador = p.razon_social || `${p.nombre ?? ''} ${p.apellido ?? ''}`.trim() || nombreOrg;
  }

  try {
    await sendInvitacionMiembroEmail({
      email,
      nombre_invitador: nombreInvitador,
      nombre_organizacion: nombreOrg,
      token,
      frontend_url: env.FRONTEND_URL,
    });
  } catch (emailError) {
    // La invitación ya quedó persistida; el email es best-effort (igual que
    // expediente-externo). Log y seguir — el owner puede reenviar.
    logger.error({ error: emailError, email }, 'Error al enviar email de invitación de miembro (invitación ya creada)');
  }
}

// ============================================================
// Reenviar / revocar (owner-only)
// ============================================================

export async function reenviarInvitacion(userId: string, miembroId: string): Promise<{ message: string }> {
  const org = await assertOwner(userId);

  const { data } = await db('inmobiliaria_miembros')
    .select('id, email, estado, inmobiliaria_id')
    .eq('id', miembroId)
    .maybeSingle();
  const row = data as { id: string; email: string | null; estado: string; inmobiliaria_id: string } | null;

  if (!row || row.inmobiliaria_id !== org.inmobiliaria_id) {
    throw AppError.notFound('Invitación no encontrada', 'MIEMBRO_NOT_FOUND');
  }
  if (row.estado === 'activo') {
    throw AppError.badRequest('Ese miembro ya aceptó la invitación', 'MIEMBRO_YA_ACTIVO');
  }
  if (!row.email) {
    throw AppError.badRequest('La invitación no tiene email asociado', 'MIEMBRO_SIN_EMAIL');
  }

  const { token, expiracion } = nuevoToken();
  const { error } = await db('inmobiliaria_miembros')
    .update({ estado: 'invitado', token, token_expiracion: expiracion, invitado_por: userId } as never)
    .eq('id', miembroId);
  if (error) {
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo reenviar la invitación');
  }

  await enviarEmailInvitacion(row.email, token, org.nombre_organizacion, userId);
  return { message: 'Invitación reenviada' };
}

export async function revocarMiembro(userId: string, miembroId: string): Promise<{ message: string }> {
  const org = await assertOwner(userId);

  const { data } = await db('inmobiliaria_miembros')
    .select('id, rol_miembro, perfil_id, inmobiliaria_id')
    .eq('id', miembroId)
    .maybeSingle();
  const row = data as
    | { id: string; rol_miembro: RolMiembro; perfil_id: string | null; inmobiliaria_id: string }
    | null;

  if (!row || row.inmobiliaria_id !== org.inmobiliaria_id) {
    throw AppError.notFound('Miembro no encontrado', 'MIEMBRO_NOT_FOUND');
  }
  // Con co-titularidad, un owner SÍ puede revocar a otro owner, pero nunca al
  // último: la organización no puede quedarse sin titular.
  if (row.rol_miembro === 'owner' && (await contarOwnersActivos(org.inmobiliaria_id)) <= 1) {
    throw AppError.badRequest(
      'No puedes revocar al único titular. Promueve antes a otro miembro como titular.',
      'ULTIMO_OWNER',
    );
  }

  const { error } = await db('inmobiliaria_miembros')
    .update({ estado: 'revocado', token: null, token_expiracion: null } as never)
    .eq('id', miembroId);
  if (error) {
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo revocar el miembro');
  }

  // Liberar asignaciones de responsable y, si era el titular principal,
  // re-apuntar owner_perfil_id a otro owner activo.
  if (row.perfil_id) {
    await liberarResponsablesDeMiembro(org.inmobiliaria_id, row.perfil_id);
    if (row.rol_miembro === 'owner') {
      await reapuntarTitularPrincipalSiNecesario(org.inmobiliaria_id, row.perfil_id);
    }
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.MIEMBRO_REVOCADO,
    entidad: AUDIT_ENTITIES.INMOBILIARIA_MIEMBRO,
    entidadId: miembroId,
    detalle: { inmobiliaria_id: org.inmobiliaria_id, perfil_id: row.perfil_id, rol_miembro: row.rol_miembro },
  });

  logger.info({ inmobiliariaId: org.inmobiliaria_id, miembroId }, 'Miembro revocado');
  return { message: 'Miembro revocado' };
}

// ============================================================
// Cambio de rol (owner-only): promover a co-titular, degradar, sólo lectura
// ============================================================

export async function cambiarRolMiembro(
  userId: string,
  miembroId: string,
  nuevoRol: RolMiembro,
): Promise<{ message: string }> {
  const org = await assertOwner(userId);

  const { data } = await db('inmobiliaria_miembros')
    .select('id, rol_miembro, perfil_id, estado, inmobiliaria_id')
    .eq('id', miembroId)
    .maybeSingle();
  const row = data as
    | { id: string; rol_miembro: RolMiembro; perfil_id: string | null; estado: string; inmobiliaria_id: string }
    | null;

  if (!row || row.inmobiliaria_id !== org.inmobiliaria_id) {
    throw AppError.notFound('Miembro no encontrado', 'MIEMBRO_NOT_FOUND');
  }
  if (row.estado !== 'activo' || !row.perfil_id) {
    throw AppError.badRequest('Sólo puedes cambiar el rol de un miembro activo', 'MIEMBRO_NO_ACTIVO');
  }
  if (row.rol_miembro === nuevoRol) {
    return { message: 'El rol no cambió' };
  }
  // Degradar a un owner (incluido uno mismo) sólo si queda otro titular activo.
  if (row.rol_miembro === 'owner' && nuevoRol !== 'owner' && (await contarOwnersActivos(org.inmobiliaria_id)) <= 1) {
    throw AppError.badRequest(
      'No puedes quitar la titularidad al único titular. Promueve antes a otro miembro como titular.',
      'ULTIMO_OWNER',
    );
  }

  const { error } = await db('inmobiliaria_miembros')
    .update({ rol_miembro: nuevoRol } as never)
    .eq('id', miembroId);
  if (error) {
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo cambiar el rol del miembro');
  }

  // Si se degradó al titular principal, re-apuntar owner_perfil_id.
  if (row.rol_miembro === 'owner' && nuevoRol !== 'owner') {
    await reapuntarTitularPrincipalSiNecesario(org.inmobiliaria_id, row.perfil_id);
  }
  // Si pasó a sólo lectura, ya no debe figurar como responsable de nada.
  if (nuevoRol === 'solo_lectura') {
    await liberarResponsablesDeMiembro(org.inmobiliaria_id, row.perfil_id);
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.MIEMBRO_ROL_CAMBIADO,
    entidad: AUDIT_ENTITIES.INMOBILIARIA_MIEMBRO,
    entidadId: miembroId,
    detalle: { inmobiliaria_id: org.inmobiliaria_id, de: row.rol_miembro, a: nuevoRol },
  });

  const promovido = nuevoRol === 'owner';
  notificarUsuario({
    userId: row.perfil_id,
    tipo: 'inmobiliaria.rol_cambiado',
    titulo: promovido ? 'Ahora eres titular' : 'Tu rol cambió',
    mensaje: promovido
      ? `Ahora eres co-titular de ${org.nombre_organizacion}.`
      : `Tu rol en ${org.nombre_organizacion} ahora es ${nuevoRol === 'solo_lectura' ? 'sólo lectura' : 'miembro'}.`,
    link: '/configuracion/equipo',
  }).catch((e) => logger.warn({ error: e, miembroId }, 'Error notificando cambio de rol'));

  logger.info({ inmobiliariaId: org.inmobiliaria_id, miembroId, de: row.rol_miembro, a: nuevoRol }, 'Rol de miembro cambiado');
  return { message: 'Rol actualizado' };
}

// ============================================================
// Salir de la organización (cualquier miembro activo, incl. viewer)
// ============================================================

export async function salirDeOrg(userId: string): Promise<{ message: string }> {
  const m = await resolveMembership(userId);
  if (!m) {
    throw AppError.badRequest('No perteneces a ninguna inmobiliaria', 'SIN_ORGANIZACION');
  }
  // Un titular no puede salir si es el único: dejaría la org sin owner.
  if (m.rol_miembro === 'owner' && (await contarOwnersActivos(m.inmobiliaria_id)) <= 1) {
    throw AppError.badRequest(
      'Eres el único titular. Transfiere la titularidad a otro miembro antes de salir.',
      'ULTIMO_OWNER',
    );
  }

  const { error } = await db('inmobiliaria_miembros')
    .update({ estado: 'revocado', token: null, token_expiracion: null } as never)
    .eq('id', m.miembro_id);
  if (error) {
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo procesar la salida');
  }

  await liberarResponsablesDeMiembro(m.inmobiliaria_id, userId);
  if (m.rol_miembro === 'owner') {
    await reapuntarTitularPrincipalSiNecesario(m.inmobiliaria_id, userId);
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.MIEMBRO_REVOCADO,
    entidad: AUDIT_ENTITIES.INMOBILIARIA_MIEMBRO,
    entidadId: m.miembro_id,
    detalle: { inmobiliaria_id: m.inmobiliaria_id, perfil_id: userId, via: 'self' },
  });

  // Avisar a los titulares restantes que alguien salió del equipo.
  notificarOwnersOrg(m.inmobiliaria_id, userId, `Un miembro salió de tu equipo en ${m.nombre_organizacion}.`)
    .catch((e) => logger.warn({ error: e }, 'Error notificando salida de miembro'));

  logger.info({ inmobiliariaId: m.inmobiliaria_id, userId }, 'Miembro salió de la organización');
  return { message: 'Saliste de la inmobiliaria' };
}

/** Notifica (in-app) a todos los owners activos de una org, excepto a `exceptoPerfilId`. */
async function notificarOwnersOrg(orgId: string, exceptoPerfilId: string, mensaje: string): Promise<void> {
  const { data } = await db('inmobiliaria_miembros')
    .select('perfil_id')
    .eq('inmobiliaria_id', orgId)
    .eq('rol_miembro', 'owner')
    .eq('estado', 'activo')
    .not('perfil_id', 'is', null);
  const owners = ((data as Array<{ perfil_id: string | null }> | null) || [])
    .map((r) => r.perfil_id)
    .filter((id): id is string => !!id && id !== exceptoPerfilId);
  for (const ownerId of owners) {
    notificarUsuario({
      userId: ownerId,
      tipo: 'inmobiliaria.miembro_salio',
      titulo: 'Cambio en tu equipo',
      mensaje,
      link: '/configuracion/equipo',
    }).catch(() => {});
  }
}

// ============================================================
// Público: GET /public/invitacion-miembro/:token
// ============================================================

export interface InvitacionMiembroPublicInfo {
  email: string;
  estado: 'invitado' | 'activo' | 'revocado';
  organizacion: string;
  invitador: string | null;
  tiene_cuenta: boolean; // true -> debe iniciar sesión; false -> debe registrarse
}

interface InvitacionRow {
  id: string;
  email: string | null;
  estado: 'invitado' | 'activo' | 'revocado';
  perfil_id: string | null;
  token_expiracion: string | null;
  inmobiliaria_id: string;
  invitado_por: string | null;
  inmobiliarias: { nombre: string } | null;
}

async function findInvitacionByToken(token: string): Promise<InvitacionRow> {
  const { data, error } = await db('inmobiliaria_miembros')
    .select('id, email, estado, perfil_id, token_expiracion, inmobiliaria_id, invitado_por, inmobiliarias(nombre)')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ tokenPrefix: truncateToken(token), error: error.message }, 'Error al buscar invitación de miembro');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al procesar la invitación');
  }
  if (!data) {
    throw AppError.notFound('Invitación no encontrada', 'INVITACION_NOT_FOUND');
  }
  return data as unknown as InvitacionRow;
}

function assertInvitacionVigente(inv: InvitacionRow): void {
  if (inv.estado === 'activo' || inv.perfil_id) {
    throw AppError.conflict('Esta invitación ya fue aceptada', 'INVITACION_YA_ACEPTADA');
  }
  if (inv.estado === 'revocado') {
    throw AppError.badRequest('Esta invitación fue revocada', 'INVITACION_REVOCADA');
  }
  if (inv.token_expiracion && new Date(inv.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de invitación ha expirado', 'INVITACION_EXPIRADA');
  }
}

/** ¿Existe ya un usuario auth con ese email? (decide registrar vs iniciar sesión). */
async function emailTieneCuenta(email: string): Promise<boolean> {
  const { data } = await supabase
    .rpc('find_user_by_email' as never, { user_email: email } as never)
    .maybeSingle<{ id: string }>();
  return !!data;
}

export async function getInvitacionMiembroPublic(token: string): Promise<InvitacionMiembroPublicInfo> {
  const inv = await findInvitacionByToken(token);
  assertInvitacionVigente(inv);

  let invitador: string | null = null;
  if (inv.invitado_por) {
    const { data: p } = await db('perfiles')
      .select('nombre, apellido, razon_social')
      .eq('id', inv.invitado_por)
      .maybeSingle();
    const perfil = p as { nombre: string | null; apellido: string | null; razon_social: string | null } | null;
    if (perfil) {
      invitador = perfil.razon_social || `${perfil.nombre ?? ''} ${perfil.apellido ?? ''}`.trim() || null;
    }
  }

  const tieneCuenta = inv.email ? await emailTieneCuenta(inv.email) : false;

  return {
    email: inv.email ?? '',
    estado: inv.estado,
    organizacion: inv.inmobiliarias?.nombre ?? 'la inmobiliaria',
    invitador,
    tiene_cuenta: tieneCuenta,
  };
}

// ============================================================
// Público: POST /public/invitacion-miembro/:token/aceptar (usuario con cuenta)
// ============================================================

export async function aceptarInvitacionMiembro(
  token: string,
  user: AuthUser,
): Promise<{ message: string; redirect: string }> {
  const inv = await findInvitacionByToken(token);
  assertInvitacionVigente(inv);

  if (!inv.email || inv.email.toLowerCase() !== user.email.toLowerCase()) {
    logger.warn(
      { invEmail: inv.email, authEmail: user.email, userId: user.id },
      'Intento de aceptar invitación de miembro con email mismatch',
    );
    throw AppError.forbidden(
      'El email de tu cuenta no coincide con el de la invitación. Inicia sesión con el correo invitado.',
      'INVITACION_EMAIL_MISMATCH',
    );
  }

  await vincularMiembro(inv.id, user.id);

  notificarOwnerNuevoMiembro(inv, user.email);
  logAudit({
    usuarioId: user.id,
    accion: AUDIT_ACTIONS.MIEMBRO_ACEPTO,
    entidad: AUDIT_ENTITIES.INMOBILIARIA_MIEMBRO,
    entidadId: inv.id,
    detalle: { inmobiliaria_id: inv.inmobiliaria_id, via: 'login' },
  });

  logger.info({ inmobiliariaId: inv.inmobiliaria_id, userId: user.id }, 'Invitación de miembro aceptada');
  return { message: 'Te uniste a la inmobiliaria', redirect: '/dashboard' };
}

/** Vincula el perfil a la fila de invitación y la activa. */
async function vincularMiembro(miembroId: string, perfilId: string): Promise<void> {
  const { error } = await db('inmobiliaria_miembros')
    .update({
      perfil_id: perfilId,
      estado: 'activo',
      token: null,
      token_expiracion: null,
    } as never)
    .eq('id', miembroId);
  if (error) {
    logger.error({ error: error.message, miembroId }, 'Error al vincular miembro');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo completar la aceptación');
  }
}

/**
 * Avisa al owner (quien invitó) que el invitado ya se unió. Fire-and-forget:
 * la aceptación no debe fallar si la notificación falla.
 */
function notificarOwnerNuevoMiembro(inv: InvitacionRow, nombreMiembro: string): void {
  if (!inv.invitado_por) return;
  const org = inv.inmobiliarias?.nombre ?? 'tu inmobiliaria';
  notificarUsuario({
    userId: inv.invitado_por,
    tipo: 'inmobiliaria.miembro_acepto',
    titulo: 'Nuevo miembro en tu equipo',
    mensaje: `${nombreMiembro} aceptó tu invitación y ya forma parte de ${org}.`,
    link: '/configuracion/equipo',
  }).catch((e) => logger.warn({ error: e, miembroId: inv.id }, 'Error notificando owner de nuevo miembro'));
}

// ============================================================
// Público: POST /public/invitacion-miembro/:token/registrar (cuenta nueva)
// ============================================================

export async function registrarMiembro(
  token: string,
  input: RegistrarMiembroInput,
): Promise<{ message: string; email: string }> {
  const inv = await findInvitacionByToken(token);
  assertInvitacionVigente(inv);

  if (!inv.email) {
    throw new AppError(500, 'INTERNAL_ERROR', 'La invitación no tiene email');
  }

  // Crear cuenta auth. El email viene de la invitación (no del body): el invitado
  // no puede registrarse con otro correo. email_confirm=true: poseer el enlace
  // (enviado a ese correo por el owner) prueba el control del email.
  const { data: authData, error: authError } = await supabaseAuth.auth.admin.createUser({
    email: inv.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { nombre: input.nombre, apellido: input.apellido, rol: 'inmobiliaria' },
  });

  if (authError || !authData?.user) {
    if (authError && (authError.message.includes('already') || authError.message.includes('registered') || authError.message.includes('duplicate'))) {
      throw AppError.conflict(
        'Ya tienes una cuenta con este correo. Inicia sesión y acepta la invitación.',
        'EMAIL_ALREADY_EXISTS',
      );
    }
    logger.error({ error: authError?.message, email: inv.email }, 'Error al crear cuenta de miembro');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo crear la cuenta');
  }

  const userId = authData.user.id;

  // El trigger handle_new_user ya creó el perfil con rol/nombre/apellido del
  // metadata. Completar datos y activar para que pueda iniciar sesión.
  const { error: updateError } = await db('perfiles')
    .update({
      rol: 'inmobiliaria',
      estado: 'activo',
      email_verified_at: new Date().toISOString(),
      registration_source: 'invitacion_miembro',
      ...(input.telefono ? { telefono: input.telefono } : {}),
    } as never)
    .eq('id', userId);
  if (updateError) {
    logger.error({ error: updateError.message, userId }, 'Error al activar perfil de miembro');
  }

  await vincularMiembro(inv.id, userId);

  const nombreMiembro = `${input.nombre ?? ''} ${input.apellido ?? ''}`.trim() || inv.email;
  notificarOwnerNuevoMiembro(inv, nombreMiembro);
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.MIEMBRO_ACEPTO,
    entidad: AUDIT_ENTITIES.INMOBILIARIA_MIEMBRO,
    entidadId: inv.id,
    detalle: { inmobiliaria_id: inv.inmobiliaria_id, via: 'registro' },
  });

  logger.info({ inmobiliariaId: inv.inmobiliaria_id, userId }, 'Miembro registrado y vinculado');
  return { message: 'Cuenta creada. Ya puedes iniciar sesión.', email: inv.email };
}

// ============================================================
// Administración de plataforma (rol 'administrador'): gestiona los miembros
// de CUALQUIER organización. La autorización es por roleGuard(['administrador'])
// en las rutas; aquí NO se aplica assertOwner.
// ============================================================

export interface InmobiliariaAdminView {
  id: string;
  nombre: string;
  estado: string;
  owner_perfil_id: string | null;
  owner_nombre: string | null;
  miembros_ven_todo: boolean;
  miembros_activos: number;
  invitaciones_pendientes: number;
  created_at: string;
}

export async function adminListInmobiliarias(): Promise<InmobiliariaAdminView[]> {
  const { data: orgsRaw, error } = await db('inmobiliarias')
    .select('id, nombre, estado, owner_perfil_id, miembros_ven_todo, created_at, perfiles!inmobiliarias_owner_perfil_id_fkey(nombre, apellido, razon_social)')
    .order('created_at', { ascending: false });
  if (error) {
    logger.error({ error: error.message }, 'Error listando inmobiliarias (admin)');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudieron cargar las inmobiliarias');
  }
  const orgs = (orgsRaw as unknown as Array<{
    id: string;
    nombre: string;
    estado: string;
    owner_perfil_id: string | null;
    miembros_ven_todo: boolean;
    created_at: string;
    perfiles: { nombre: string | null; apellido: string | null; razon_social: string | null } | null;
  }>) || [];

  // Conteos por org (una sola lectura de miembros no-revocados).
  const { data: miembrosRaw } = await db('inmobiliaria_miembros')
    .select('inmobiliaria_id, estado')
    .neq('estado', 'revocado');
  const conteos = new Map<string, { activos: number; pendientes: number }>();
  ((miembrosRaw as Array<{ inmobiliaria_id: string; estado: string }> | null) || []).forEach((r) => {
    const c = conteos.get(r.inmobiliaria_id) ?? { activos: 0, pendientes: 0 };
    if (r.estado === 'activo') c.activos += 1;
    else if (r.estado === 'invitado') c.pendientes += 1;
    conteos.set(r.inmobiliaria_id, c);
  });

  return orgs.map((o) => {
    const p = o.perfiles;
    const ownerNombre = p
      ? p.razon_social || `${p.nombre ?? ''} ${p.apellido ?? ''}`.trim() || null
      : null;
    const c = conteos.get(o.id) ?? { activos: 0, pendientes: 0 };
    return {
      id: o.id,
      nombre: o.nombre,
      estado: o.estado,
      owner_perfil_id: o.owner_perfil_id,
      owner_nombre: ownerNombre,
      miembros_ven_todo: o.miembros_ven_todo,
      miembros_activos: c.activos,
      invitaciones_pendientes: c.pendientes,
      created_at: o.created_at,
    };
  });
}

/** Devuelve {id, nombre} de la org o lanza notFound. */
async function getOrgOrThrow(orgId: string): Promise<{ id: string; nombre: string }> {
  const { data } = await db('inmobiliarias').select('id, nombre').eq('id', orgId).maybeSingle();
  const org = data as { id: string; nombre: string } | null;
  if (!org) throw AppError.notFound('Inmobiliaria no encontrada', 'INMOBILIARIA_NOT_FOUND');
  return org;
}

export async function adminListMiembrosDeOrg(orgId: string): Promise<{
  organizacion: { id: string; nombre: string };
  miembros_ven_todo: boolean;
  miembros: MiembroView[];
}> {
  const { data: orgRow } = await db('inmobiliarias')
    .select('id, nombre, miembros_ven_todo')
    .eq('id', orgId)
    .maybeSingle();
  const org = orgRow as { id: string; nombre: string; miembros_ven_todo: boolean } | null;
  if (!org) throw AppError.notFound('Inmobiliaria no encontrada', 'INMOBILIARIA_NOT_FOUND');

  const { data, error } = await db('inmobiliaria_miembros')
    .select('id, email, rol_miembro, estado, perfil_id, created_at, perfiles!inmobiliaria_miembros_perfil_id_fkey(nombre, apellido)')
    .eq('inmobiliaria_id', orgId)
    .neq('estado', 'revocado')
    .order('created_at', { ascending: true });
  if (error) {
    logger.error({ error: error.message, orgId }, 'Error listando miembros (admin)');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudieron cargar los miembros');
  }
  const rows = (data as unknown as Array<{
    id: string;
    email: string | null;
    rol_miembro: RolMiembro;
    estado: 'activo' | 'invitado' | 'revocado';
    perfil_id: string | null;
    created_at: string;
    perfiles: { nombre: string; apellido: string } | null;
  }>) || [];

  return {
    organizacion: { id: org.id, nombre: org.nombre },
    miembros_ven_todo: org.miembros_ven_todo,
    miembros: rows.map((r) => ({
      id: r.id,
      perfil_id: r.perfil_id,
      email: r.email,
      rol_miembro: r.rol_miembro,
      estado: r.estado,
      nombre: r.perfiles?.nombre ?? null,
      apellido: r.perfiles?.apellido ?? null,
      invitado_en: r.created_at,
      es_yo: false,
    })),
  };
}

/** Carga una fila de miembro garantizando que pertenece a la org dada. */
async function cargarMiembroDeOrg(
  orgId: string,
  miembroId: string,
): Promise<{ id: string; rol_miembro: RolMiembro; perfil_id: string | null; estado: string }> {
  const { data } = await db('inmobiliaria_miembros')
    .select('id, rol_miembro, perfil_id, estado, inmobiliaria_id')
    .eq('id', miembroId)
    .maybeSingle();
  const row = data as
    | { id: string; rol_miembro: RolMiembro; perfil_id: string | null; estado: string; inmobiliaria_id: string }
    | null;
  if (!row || row.inmobiliaria_id !== orgId) {
    throw AppError.notFound('Miembro no encontrado', 'MIEMBRO_NOT_FOUND');
  }
  return row;
}

export async function adminCambiarRolMiembro(
  adminId: string,
  orgId: string,
  miembroId: string,
  nuevoRol: RolMiembro,
): Promise<{ message: string }> {
  await getOrgOrThrow(orgId);
  const row = await cargarMiembroDeOrg(orgId, miembroId);

  if (row.estado !== 'activo' || !row.perfil_id) {
    throw AppError.badRequest('Sólo puedes cambiar el rol de un miembro activo', 'MIEMBRO_NO_ACTIVO');
  }
  if (row.rol_miembro === nuevoRol) {
    return { message: 'El rol no cambió' };
  }
  if (row.rol_miembro === 'owner' && nuevoRol !== 'owner' && (await contarOwnersActivos(orgId)) <= 1) {
    throw AppError.badRequest(
      'No puedes quitar la titularidad al único titular. Promueve antes a otro miembro.',
      'ULTIMO_OWNER',
    );
  }

  const { error } = await db('inmobiliaria_miembros')
    .update({ rol_miembro: nuevoRol } as never)
    .eq('id', miembroId);
  if (error) {
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo cambiar el rol del miembro');
  }

  if (row.rol_miembro === 'owner' && nuevoRol !== 'owner') {
    await reapuntarTitularPrincipalSiNecesario(orgId, row.perfil_id);
  }
  if (nuevoRol === 'solo_lectura') {
    await liberarResponsablesDeMiembro(orgId, row.perfil_id);
  }

  logAudit({
    usuarioId: adminId,
    accion: AUDIT_ACTIONS.MIEMBRO_ROL_CAMBIADO,
    entidad: AUDIT_ENTITIES.INMOBILIARIA_MIEMBRO,
    entidadId: miembroId,
    detalle: { inmobiliaria_id: orgId, de: row.rol_miembro, a: nuevoRol, por: 'admin' },
  });
  logger.info({ orgId, miembroId, de: row.rol_miembro, a: nuevoRol, adminId }, 'Rol de miembro cambiado (admin)');
  return { message: 'Rol actualizado' };
}

export async function adminRevocarMiembro(
  adminId: string,
  orgId: string,
  miembroId: string,
): Promise<{ message: string }> {
  await getOrgOrThrow(orgId);
  const row = await cargarMiembroDeOrg(orgId, miembroId);

  if (row.rol_miembro === 'owner' && (await contarOwnersActivos(orgId)) <= 1) {
    throw AppError.badRequest(
      'No puedes revocar al único titular. Promueve antes a otro miembro como titular.',
      'ULTIMO_OWNER',
    );
  }

  const { error } = await db('inmobiliaria_miembros')
    .update({ estado: 'revocado', token: null, token_expiracion: null } as never)
    .eq('id', miembroId);
  if (error) {
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo revocar el miembro');
  }

  if (row.perfil_id) {
    await liberarResponsablesDeMiembro(orgId, row.perfil_id);
    if (row.rol_miembro === 'owner') {
      await reapuntarTitularPrincipalSiNecesario(orgId, row.perfil_id);
    }
  }

  logAudit({
    usuarioId: adminId,
    accion: AUDIT_ACTIONS.MIEMBRO_REVOCADO,
    entidad: AUDIT_ENTITIES.INMOBILIARIA_MIEMBRO,
    entidadId: miembroId,
    detalle: { inmobiliaria_id: orgId, perfil_id: row.perfil_id, rol_miembro: row.rol_miembro, por: 'admin' },
  });
  logger.info({ orgId, miembroId, adminId }, 'Miembro revocado (admin)');
  return { message: 'Miembro revocado' };
}

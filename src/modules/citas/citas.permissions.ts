import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { UserRole } from '@/types/auth';
import { resolveAllowedExpedienteIds, resolveMembershipInmobiliariaIds } from '@/lib/tenantScope';

export type CitaAction =
  | 'create'
  | 'confirmar'
  | 'reprogramar'
  | 'realizar'
  | 'cancelar'
  | 'no_asistio'
  | 'read';

export interface CitaPermissionContext {
  expedienteId: string;
  expedienteNumero: string;
  expedienteEstado: string;
  inmueblePropietarioId: string | null;
  inmuebleInmobiliariaId: string | null;
  inmuebleEstado: string | null;
  inmuebleReservadoPor: string | null;
  solicitanteCreadoPor: string | null;
}

const FULL_ACCESS_ROLES: ReadonlyArray<UserRole> = ['administrador', 'operador_analista'];
const READ_ONLY_ROLES: ReadonlyArray<UserRole> = ['gerencia_consulta'];
const PROPIETARIO_LIKE_ROLES: ReadonlyArray<UserRole> = ['propietario', 'inmobiliaria'];
// El solicitante puede reprogramar su cita (la deja en 'solicitada' pendiente
// de re-confirmacion del propietario) y cancelarla. Confirmar/realizar/no_asistio
// siguen siendo exclusivos del propietario o admin.
const SOLICITANTE_ALLOWED_ACTIONS: ReadonlyArray<CitaAction> = [
  'create',
  'read',
  'cancelar',
  'reprogramar',
];

interface ExpedienteOwnershipRow {
  id: string;
  numero: string;
  estado: string;
  solicitante_id: string | null;
  inmueble_id: string;
  inmuebles: {
    propietario_id: string;
    inmobiliaria_id: string | null;
    estado: string | null;
    reservado_por_expediente_id: string | null;
  } | null;
  solicitantes: { creado_por: string } | null;
}

async function fetchExpedienteOwnership(expedienteId: string): Promise<ExpedienteOwnershipRow> {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, numero, estado, solicitante_id, inmueble_id, inmuebles!expedientes_inmueble_id_fkey(propietario_id, inmobiliaria_id, estado, reservado_por_expediente_id), solicitantes(creado_por)',
    )
    .eq('id', expedienteId)
    .single();

  if (error || !data) {
    if (error?.code === 'PGRST116') {
      throw AppError.notFound('Estudio no encontrado');
    }
    logger.error({ error: error?.message, expedienteId }, 'Error al verificar estudio para permisos de cita');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar el estudio');
  }

  return data as unknown as ExpedienteOwnershipRow;
}

function toContext(row: ExpedienteOwnershipRow): CitaPermissionContext {
  return {
    expedienteId: row.id,
    expedienteNumero: row.numero,
    expedienteEstado: row.estado,
    inmueblePropietarioId: row.inmuebles?.propietario_id ?? null,
    inmuebleInmobiliariaId: row.inmuebles?.inmobiliaria_id ?? null,
    inmuebleEstado: row.inmuebles?.estado ?? null,
    inmuebleReservadoPor: row.inmuebles?.reservado_por_expediente_id ?? null,
    solicitanteCreadoPor: row.solicitantes?.creado_por ?? null,
  };
}

/**
 * Solo se agenda o reprograma una visita sobre un inmueble que todavía se le
 * puede arrendar a ESTE estudio. Reservado para otro candidato, arrendado o
 * inactivo -> 409 (misma regla que crear un estudio). Al reservar, las visitas
 * de los demás se cancelan (cancelarVisitasDeOtros).
 */
export function assertInmuebleAdmiteVisitas(
  expedienteId: string,
  estado: string | null | undefined,
  reservadoPor: string | null | undefined,
): void {
  if (reservadoPor && reservadoPor === expedienteId) return;
  if (reservadoPor) {
    throw AppError.conflict('El inmueble ya fue reservado para otro candidato.', 'INMUEBLE_RESERVADO');
  }
  if (estado === 'ocupado' || estado === 'inactivo') {
    throw AppError.conflict('El inmueble ya no está disponible para visitas.', 'INMUEBLE_NO_DISPONIBLE');
  }
}

function denyAndThrow(
  userId: string,
  userRol: UserRole,
  expedienteId: string,
  action: CitaAction,
  reason: string,
): never {
  logger.warn(
    { userId, userRol, expedienteId, action, reason },
    'Acceso a cita denegado',
  );
  throw AppError.forbidden('No tienes permisos sobre esta cita', 'CITA_FORBIDDEN');
}

/**
 * Guard fine-grained de autorización para el módulo citas.
 *
 * Reglas:
 * - administrador, operador_analista: acceso total.
 * - gerencia_consulta: solo action='read'.
 * - propietario, inmobiliaria: cualquier acción sobre citas cuyo expediente
 *   apunte a un inmueble de su propiedad.
 * - solicitante: create/read/cancelar/reprogramar sobre expedientes donde
 *   sea dueño vía solicitantes.creado_por, aunque la cita la haya agendado
 *   la inmobiliaria (el enlace del WhatsApp ya lo dejaba). Nunca puede
 *   confirmar, realizar ni marcar no_asistio.
 *
 * Hace UNA sola query a expedientes con joins embebidos a inmuebles y
 * solicitantes. Devuelve el contexto del expediente para que el caller
 * lo reutilice (evita un fetchExpediente adicional).
 */
export async function assertCitaPermission(params: {
  userId: string;
  userRol: UserRole;
  expedienteId: string;
  action: CitaAction;
}): Promise<CitaPermissionContext> {
  const { userId, userRol, expedienteId, action } = params;

  if (FULL_ACCESS_ROLES.includes(userRol)) {
    const row = await fetchExpedienteOwnership(expedienteId);
    logger.debug({ userId, userRol, expedienteId, action }, 'Cita autorizada (full access)');
    return toContext(row);
  }

  if (READ_ONLY_ROLES.includes(userRol)) {
    if (action !== 'read') {
      denyAndThrow(userId, userRol, expedienteId, action, 'gerencia_consulta solo puede read');
    }
    const row = await fetchExpedienteOwnership(expedienteId);
    logger.debug({ userId, userRol, expedienteId, action }, 'Cita autorizada (read-only)');
    return toContext(row);
  }

  const row = await fetchExpedienteOwnership(expedienteId);

  if (PROPIETARIO_LIKE_ROLES.includes(userRol)) {
    // Dueño directo del inmueble (propietario individual o inmobiliaria de un
    // solo usuario), o miembro activo de la organización dueña del inmueble.
    let pertenece = row.inmuebles?.propietario_id === userId;
    if (!pertenece && userRol === 'inmobiliaria' && row.inmuebles?.inmobiliaria_id) {
      const orgIds = await resolveMembershipInmobiliariaIds(userId);
      pertenece = orgIds.includes(row.inmuebles.inmobiliaria_id);
    }
    if (!pertenece) {
      denyAndThrow(userId, userRol, expedienteId, action, 'inmueble no pertenece al usuario ni a su organización');
    }
    logger.debug({ userId, userRol, expedienteId, action }, 'Cita autorizada (propietario/inmobiliaria)');
    return toContext(row);
  }

  if (userRol === 'solicitante') {
    if (!SOLICITANTE_ALLOWED_ACTIONS.includes(action)) {
      denyAndThrow(userId, userRol, expedienteId, action, 'solicitante no puede confirmar/realizar/no_asistio');
    }
    if (row.solicitantes?.creado_por !== userId) {
      denyAndThrow(userId, userRol, expedienteId, action, 'solicitante no es dueño del estudio');
    }
    logger.debug({ userId, userRol, expedienteId, action }, 'Cita autorizada (solicitante)');
    return toContext(row);
  }

  denyAndThrow(userId, userRol, expedienteId, action, `rol '${userRol}' no reconocido`);
}

/**
 * Devuelve la lista de expediente IDs accesibles por el usuario, o null si
 * puede ver todos (admin / operador / gerencia). Lista vacía significa que
 * no tiene ningún expediente asociado y la respuesta debe ser vacía.
 *
 * Usado para filtrar listados de citas por rol sin necesidad de iterar.
 */
export async function resolveAccessibleExpedienteIds(
  userId: string,
  userRol: UserRole,
): Promise<string[] | null> {
  if (FULL_ACCESS_ROLES.includes(userRol) || READ_ONLY_ROLES.includes(userRol)) {
    return null;
  }

  if (PROPIETARIO_LIKE_ROLES.includes(userRol)) {
    // El mismo alcance que el estudio (tenantScope): la copia por inmuebles
    // dejaba fuera los estudios asignados al miembro restringido, que abría el
    // estudio pero recibía 403 al listar sus citas.
    return resolveAllowedExpedienteIds(userId, userRol);
  }

  if (userRol === 'solicitante') {
    const { data: sols } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('creado_por', userId);
    const solIds = ((sols as { id: string }[] | null) || []).map((s) => s.id);
    if (solIds.length === 0) return [];

    const { data: exps } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .in('solicitante_id', solIds);
    return ((exps as { id: string }[] | null) || []).map((e) => e.id);
  }

  return [];
}

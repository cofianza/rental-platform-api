import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { UserRole } from '@/types/auth';

export type CitaAction = 'create' | 'confirmar' | 'realizar' | 'cancelar' | 'no_asistio' | 'read';

export interface CitaPermissionContext {
  expedienteId: string;
  expedienteNumero: string;
  expedienteEstado: string;
  inmueblePropietarioId: string | null;
  solicitanteCreadoPor: string | null;
}

const FULL_ACCESS_ROLES: ReadonlyArray<UserRole> = ['administrador', 'operador_analista'];
const READ_ONLY_ROLES: ReadonlyArray<UserRole> = ['gerencia_consulta'];
const PROPIETARIO_LIKE_ROLES: ReadonlyArray<UserRole> = ['propietario', 'inmobiliaria'];
const SOLICITANTE_ALLOWED_ACTIONS: ReadonlyArray<CitaAction> = ['create', 'read', 'cancelar'];

interface ExpedienteOwnershipRow {
  id: string;
  numero: string;
  estado: string;
  solicitante_id: string | null;
  inmueble_id: string;
  inmuebles: { propietario_id: string } | null;
  solicitantes: { creado_por: string } | null;
}

async function fetchExpedienteOwnership(expedienteId: string): Promise<ExpedienteOwnershipRow> {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, numero, estado, solicitante_id, inmueble_id, inmuebles(propietario_id), solicitantes(creado_por)',
    )
    .eq('id', expedienteId)
    .single();

  if (error || !data) {
    if (error?.code === 'PGRST116') {
      throw AppError.notFound('Expediente no encontrado');
    }
    logger.error({ error: error?.message, expedienteId }, 'Error al verificar expediente para permisos de cita');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar el expediente');
  }

  return data as unknown as ExpedienteOwnershipRow;
}

function toContext(row: ExpedienteOwnershipRow): CitaPermissionContext {
  return {
    expedienteId: row.id,
    expedienteNumero: row.numero,
    expedienteEstado: row.estado,
    inmueblePropietarioId: row.inmuebles?.propietario_id ?? null,
    solicitanteCreadoPor: row.solicitantes?.creado_por ?? null,
  };
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
 * - solicitante: create/read sobre expedientes donde sea dueño vía
 *   solicitantes.creado_por. Para 'cancelar' además requiere ser autor
 *   de la cita (se valida pasando citaCreadoPor). Nunca puede confirmar,
 *   realizar ni marcar no_asistio.
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
  citaCreadoPor?: string;
}): Promise<CitaPermissionContext> {
  const { userId, userRol, expedienteId, action, citaCreadoPor } = params;

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
    if (row.inmuebles?.propietario_id !== userId) {
      denyAndThrow(userId, userRol, expedienteId, action, 'inmueble no pertenece al usuario');
    }
    logger.debug({ userId, userRol, expedienteId, action }, 'Cita autorizada (propietario/inmobiliaria)');
    return toContext(row);
  }

  if (userRol === 'solicitante') {
    if (!SOLICITANTE_ALLOWED_ACTIONS.includes(action)) {
      denyAndThrow(userId, userRol, expedienteId, action, 'solicitante no puede confirmar/realizar/no_asistio');
    }
    if (row.solicitantes?.creado_por !== userId) {
      denyAndThrow(userId, userRol, expedienteId, action, 'solicitante no es dueño del expediente');
    }
    if (action === 'cancelar' && citaCreadoPor !== userId) {
      denyAndThrow(userId, userRol, expedienteId, action, 'solicitante solo puede cancelar citas propias');
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
    const { data: inmuebles } = await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('propietario_id', userId);
    const inmuebleIds = ((inmuebles as { id: string }[] | null) || []).map((i) => i.id);
    if (inmuebleIds.length === 0) return [];

    const { data: exps } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .in('inmueble_id', inmuebleIds);
    return ((exps as { id: string }[] | null) || []).map((e) => e.id);
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

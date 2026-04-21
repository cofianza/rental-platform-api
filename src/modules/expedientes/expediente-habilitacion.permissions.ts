import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { UserRole } from '@/types/auth';

export interface HabilitacionContext {
  expedienteId: string;
  numero: string;
  estado: string;
  source: string | null;
  estudioHabilitado: boolean;
  inmueblePropietarioId: string | null;
  inmuebleDireccion: string;
  inmuebleCiudad: string;
  solicitanteEmail: string | null;
  solicitanteNombre: string | null;
}

const FULL_ACCESS_ROLES: ReadonlyArray<UserRole> = ['administrador', 'operador_analista'];
const PROPIETARIO_LIKE_ROLES: ReadonlyArray<UserRole> = ['propietario', 'inmobiliaria'];

/**
 * Ownership guard para el endpoint PATCH /expedientes/:id/habilitar-estudio.
 *
 * Precondición: el `roleGuard` de la ruta ya filtra solicitante y
 * gerencia_consulta. Aquí solo atendemos admin/operador (passthrough) y
 * propietario/inmobiliaria (verifican ser dueños del inmueble).
 *
 * Hace UNA query a expedientes con embeds a inmuebles + solicitantes para
 * que el service pueda componer el email post-habilitación sin más viajes
 * a la DB.
 */
export async function assertHabilitacionPermission(params: {
  userId: string;
  userRol: UserRole;
  expedienteId: string;
}): Promise<HabilitacionContext> {
  const { userId, userRol, expedienteId } = params;

  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, numero, estado, source, estudio_habilitado, inmueble_id, solicitante_id, ' +
        'inmuebles(propietario_id, direccion, ciudad), ' +
        'solicitantes(email, nombre, apellido)',
    )
    .eq('id', expedienteId)
    .single();

  if (error || !data) {
    if (error?.code === 'PGRST116') {
      throw AppError.notFound('Expediente no encontrado');
    }
    logger.error(
      { error: error?.message, expedienteId },
      'Error al verificar expediente para habilitación',
    );
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar el expediente');
  }

  const row = data as unknown as {
    id: string;
    numero: string;
    estado: string;
    source: string | null;
    estudio_habilitado: boolean;
    inmueble_id: string;
    solicitante_id: string | null;
    inmuebles: { propietario_id: string; direccion: string; ciudad: string } | null;
    solicitantes: { email: string; nombre: string; apellido: string } | null;
  };

  const ctx: HabilitacionContext = {
    expedienteId: row.id,
    numero: row.numero,
    estado: row.estado,
    source: row.source,
    estudioHabilitado: row.estudio_habilitado,
    inmueblePropietarioId: row.inmuebles?.propietario_id ?? null,
    inmuebleDireccion: row.inmuebles?.direccion ?? '',
    inmuebleCiudad: row.inmuebles?.ciudad ?? '',
    solicitanteEmail: row.solicitantes?.email ?? null,
    solicitanteNombre: row.solicitantes
      ? `${row.solicitantes.nombre} ${row.solicitantes.apellido}`.trim()
      : null,
  };

  if (FULL_ACCESS_ROLES.includes(userRol)) {
    logger.debug({ userId, userRol, expedienteId }, 'Habilitación autorizada (full access)');
    return ctx;
  }

  if (PROPIETARIO_LIKE_ROLES.includes(userRol)) {
    if (ctx.inmueblePropietarioId !== userId) {
      logger.warn(
        { userId, userRol, expedienteId, reason: 'inmueble no pertenece al usuario' },
        'Habilitación denegada',
      );
      throw AppError.forbidden(
        'No tienes permisos para habilitar este expediente',
        'EXPEDIENTE_FORBIDDEN',
      );
    }
    logger.debug(
      { userId, userRol, expedienteId },
      'Habilitación autorizada (propietario/inmobiliaria)',
    );
    return ctx;
  }

  // Defensa en profundidad — el roleGuard ya debería haber filtrado antes.
  logger.warn({ userId, userRol, expedienteId }, 'Habilitación denegada por rol no permitido');
  throw AppError.forbidden('Rol no autorizado para habilitar estudios', 'ROLE_NOT_ALLOWED');
}

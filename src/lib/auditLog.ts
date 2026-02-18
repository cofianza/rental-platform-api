import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILED: 'login_failed',
  LOGOUT: 'logout',
  PASSWORD_RESET_REQUEST: 'password_reset_request',
  PASSWORD_RESET_COMPLETE: 'password_reset_complete',
  USER_CREATED: 'user_created',
  USER_UPDATED: 'user_updated',
  USER_DEACTIVATED: 'user_deactivated',
  USER_ACTIVATED: 'user_activated',
  USER_ROLE_CHANGED: 'user_role_changed',
  CONFIG_CHANGED: 'config_changed',
  INMUEBLE_CREATED: 'inmueble_created',
  INMUEBLE_UPDATED: 'inmueble_updated',
  INMUEBLE_DELETED: 'inmueble_deleted',
} as const;

export const AUDIT_ENTITIES = {
  USER: 'user',
  SESSION: 'session',
  CONFIG: 'config',
  INMUEBLE: 'inmueble',
} as const;

interface AuditLogParams {
  usuarioId: string | null;
  accion: string;
  entidad: string;
  entidadId?: string;
  detalle?: Record<string, unknown>;
  ip?: string;
}

/**
 * Registra una accion en la bitacora de auditoria.
 * Fire-and-forget: no bloquea la operacion principal.
 */
export function logAudit(params: AuditLogParams): void {
  const { usuarioId, accion, entidad, entidadId, detalle, ip } = params;

  (supabase
    .from('bitacora' as string) as ReturnType<typeof supabase.from>)
    .insert({
      usuario_id: usuarioId,
      accion,
      entidad,
      entidad_id: entidadId || null,
      detalle: detalle || null,
      ip: ip || null,
    } as never)
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) {
        logger.warn({ error: error.message, accion, entidad, entidadId }, 'Error al registrar en bitacora');
      }
    })
    .catch((error: unknown) => {
      logger.warn({ error, accion, entidad, entidadId }, 'Error al registrar en bitacora');
    });
}

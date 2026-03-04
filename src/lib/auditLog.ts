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
  // Fotos de inmuebles (HP-203)
  FOTO_CREATED: 'foto_created',
  FOTO_UPDATED: 'foto_updated',
  FOTO_DELETED: 'foto_deleted',
  FOTO_SET_FACHADA: 'foto_set_fachada',
  FOTOS_REORDERED: 'fotos_reordered',
  // Solicitantes
  SOLICITANTE_CREATED: 'solicitante_created',
  SOLICITANTE_UPDATED: 'solicitante_updated',
  SOLICITANTE_DEACTIVATED: 'solicitante_deactivated',
  // Expedientes
  EXPEDIENTE_CREATED: 'expediente_created',
  EXPEDIENTE_UPDATED: 'expediente_updated',
  // Comentarios
  COMMENT_CREATED: 'comment_created',
  COMMENT_UPDATED: 'comment_updated',
  COMMENT_DELETED: 'comment_deleted',
  // Asignaciones
  ASSIGNMENT_CREATED: 'assignment_created',
  // Documentos
  DOCUMENTO_UPLOADED: 'documento_uploaded',
  DOCUMENTO_DELETED: 'documento_deleted',
  DOCUMENTO_APROBADO: 'documento_aprobado',
  DOCUMENTO_RECHAZADO: 'documento_rechazado',
  DOCUMENTO_DESCARGADO: 'documento_descargado',
  DOCUMENTO_REEMPLAZADO: 'documento_reemplazado',
  // Tipos de documento (admin)
  TIPO_DOCUMENTO_CREATED: 'tipo_documento_created',
  TIPO_DOCUMENTO_UPDATED: 'tipo_documento_updated',
  TIPO_DOCUMENTO_TOGGLED: 'tipo_documento_toggled',
  TIPO_DOCUMENTO_REORDERED: 'tipo_documento_reordered',
  // Estudios de riesgo crediticio
  ESTUDIO_CREATED: 'estudio_created',
  ESTUDIO_CANCELLED: 'estudio_cancelled',
  ESTUDIO_LINK_SENT: 'estudio_link_sent',
  ESTUDIO_FORM_SUBMITTED: 'estudio_form_submitted',
  ESTUDIO_RESULTADO_REGISTERED: 'estudio_resultado_registered',
  // Proveedores de riesgo crediticio
  ESTUDIO_PROVIDER_EXECUTED: 'estudio_provider_executed',
  ESTUDIO_PROVIDER_FAILED: 'estudio_provider_failed',
  ESTUDIO_PROVIDER_RESULT_RECEIVED: 'estudio_provider_result_received',
  // Re-evaluacion de estudios
  ESTUDIO_SOPORTE_UPLOADED: 'estudio_soporte_uploaded',
  ESTUDIO_REEVALUACION_SOLICITADA: 'estudio_reevaluacion_solicitada',
  // Certificados
  CERTIFICADO_GENERATED: 'certificado_generated',
  // Autorizacion habeas data
  AUTORIZACION_ENLACE_SENT: 'autorizacion_enlace_sent',
  AUTORIZACION_FIRMADA: 'autorizacion_firmada',
  AUTORIZACION_REVOCADA: 'autorizacion_revocada',
} as const;

export const AUDIT_ENTITIES = {
  USER: 'user',
  SESSION: 'session',
  CONFIG: 'config',
  INMUEBLE: 'inmueble',
  FOTO_INMUEBLE: 'foto_inmueble',
  SOLICITANTE: 'solicitante',
  EXPEDIENTE: 'expediente',
  COMENTARIO: 'comentario',
  ASIGNACION: 'asignacion',
  DOCUMENTO: 'documento',
  TIPO_DOCUMENTO: 'tipo_documento',
  ESTUDIO: 'estudio',
  DOCUMENTO_SOPORTE: 'documento_soporte',
  CERTIFICADO: 'certificado',
  AUTORIZACION: 'autorizacion',
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

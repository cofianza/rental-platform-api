// ============================================================
// Contrato tipo del inmueble — servicio
//
// El propietario/inmobiliaria puede subir un PDF de contrato que luego se
// usará como base para el contrato del expediente (en vez de compilarlo
// desde una plantilla con variables).
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type { UserRole } from '@/types/auth';

const BUCKET_NAME = 'documentos-expedientes';
const DOWNLOAD_URL_EXPIRY_SECONDS = 600; // 10 min

const INMUEBLE_SELECT = `
  id, propietario_id,
  contrato_tipo_storage_key, contrato_tipo_nombre_archivo,
  contrato_tipo_tamano_bytes, contrato_tipo_subido_por, contrato_tipo_subido_en
`;

interface InmuebleContratoTipoRow {
  id: string;
  propietario_id: string | null;
  contrato_tipo_storage_key: string | null;
  contrato_tipo_nombre_archivo: string | null;
  contrato_tipo_tamano_bytes: number | null;
  contrato_tipo_subido_por: string | null;
  contrato_tipo_subido_en: string | null;
}

// ── Helpers ────────────────────────────────────────────────────

async function fetchInmuebleOrThrow(inmuebleId: string): Promise<InmuebleContratoTipoRow> {
  const { data, error } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select(INMUEBLE_SELECT)
    .eq('id', inmuebleId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Inmueble no encontrado', 'INMUEBLE_NOT_FOUND');
  }
  return data as unknown as InmuebleContratoTipoRow;
}

/**
 * Ownership guard: propietario/inmobiliaria solo pueden operar sobre
 * inmuebles propios. Admin/operador pasan sin chequeo.
 */
function assertOwnership(inmueble: InmuebleContratoTipoRow, userId: string, userRol: UserRole): void {
  if (userRol === 'administrador' || userRol === 'operador_analista') return;
  if (userRol === 'propietario' || userRol === 'inmobiliaria') {
    if (inmueble.propietario_id !== userId) {
      throw AppError.forbidden(
        'No tienes permisos sobre este inmueble',
        'INMUEBLE_FORBIDDEN',
      );
    }
    return;
  }
  throw AppError.forbidden('Rol no autorizado', 'ROLE_NOT_ALLOWED');
}

// ── Upload / reemplazo ─────────────────────────────────────────

export async function subirContratoTipo(
  inmuebleId: string,
  file: { buffer: Buffer; originalname: string; size: number; mimetype: string },
  userId: string,
  userRol: string,
  ip?: string,
) {
  if (file.mimetype !== 'application/pdf') {
    throw AppError.badRequest('Solo se acepta formato PDF', 'INVALID_FILE_TYPE');
  }

  const inmueble = await fetchInmuebleOrThrow(inmuebleId);
  assertOwnership(inmueble, userId, userRol as UserRole);

  // Si ya había un contrato tipo, borramos el anterior del storage antes de
  // subir el nuevo (no queremos dejar archivos huérfanos).
  if (inmueble.contrato_tipo_storage_key) {
    const { error: removeError } = await supabase.storage
      .from(BUCKET_NAME)
      .remove([inmueble.contrato_tipo_storage_key]);
    if (removeError) {
      logger.warn(
        { error: removeError.message, key: inmueble.contrato_tipo_storage_key },
        'No se pudo borrar contrato tipo anterior (continuamos con el upload)',
      );
    }
  }

  const storageKey = `inmuebles/${inmuebleId}/contrato-tipo.pdf`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storageKey, file.buffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    logger.error({ error: uploadError.message, inmuebleId }, 'Error al subir contrato tipo a storage');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al almacenar el contrato tipo');
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .update({
      contrato_tipo_storage_key: storageKey,
      contrato_tipo_nombre_archivo: file.originalname,
      contrato_tipo_tamano_bytes: file.size,
      contrato_tipo_subido_por: userId,
      contrato_tipo_subido_en: now,
      updated_at: now,
    } as never)
    .eq('id', inmuebleId)
    .select(INMUEBLE_SELECT)
    .single();

  if (updateError || !updated) {
    logger.error({ error: updateError?.message, inmuebleId }, 'Error al actualizar inmueble con contrato tipo');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al registrar el contrato tipo');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.INMUEBLE_UPDATED,
    entidad: AUDIT_ENTITIES.INMUEBLE,
    entidadId: inmuebleId,
    detalle: {
      accion: 'contrato_tipo_subido',
      storage_key: storageKey,
      nombre_archivo: file.originalname,
      tamano_bytes: file.size,
    },
    ip,
  });

  return updated as unknown as InmuebleContratoTipoRow;
}

// ── Ver / descargar ────────────────────────────────────────────

export async function obtenerUrlContratoTipo(
  inmuebleId: string,
  userId: string,
  userRol: string,
) {
  const inmueble = await fetchInmuebleOrThrow(inmuebleId);
  assertOwnership(inmueble, userId, userRol as UserRole);

  if (!inmueble.contrato_tipo_storage_key) {
    throw AppError.notFound('Este inmueble no tiene contrato tipo subido', 'CONTRATO_TIPO_NOT_FOUND');
  }

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(inmueble.contrato_tipo_storage_key, DOWNLOAD_URL_EXPIRY_SECONDS, {
      download: inmueble.contrato_tipo_nombre_archivo || 'contrato-tipo.pdf',
    });

  if (error || !data?.signedUrl) {
    logger.error({ error, inmuebleId }, 'Error al generar signed URL del contrato tipo');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al obtener el contrato tipo');
  }

  return {
    url: data.signedUrl,
    nombre_archivo: inmueble.contrato_tipo_nombre_archivo,
    tamano_bytes: inmueble.contrato_tipo_tamano_bytes,
    subido_en: inmueble.contrato_tipo_subido_en,
    expires_in: DOWNLOAD_URL_EXPIRY_SECONDS,
  };
}

// ── Eliminar ───────────────────────────────────────────────────

export async function eliminarContratoTipo(
  inmuebleId: string,
  userId: string,
  userRol: string,
  ip?: string,
) {
  const inmueble = await fetchInmuebleOrThrow(inmuebleId);
  assertOwnership(inmueble, userId, userRol as UserRole);

  if (!inmueble.contrato_tipo_storage_key) {
    throw AppError.notFound('Este inmueble no tiene contrato tipo subido', 'CONTRATO_TIPO_NOT_FOUND');
  }

  // Remove from storage (log-only en error para no bloquear el nullify del registro).
  const { error: removeError } = await supabase.storage
    .from(BUCKET_NAME)
    .remove([inmueble.contrato_tipo_storage_key]);
  if (removeError) {
    logger.warn(
      { error: removeError.message, key: inmueble.contrato_tipo_storage_key },
      'No se pudo borrar contrato tipo del storage',
    );
  }

  const { error: updateError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .update({
      contrato_tipo_storage_key: null,
      contrato_tipo_nombre_archivo: null,
      contrato_tipo_tamano_bytes: null,
      contrato_tipo_subido_por: null,
      contrato_tipo_subido_en: null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', inmuebleId);

  if (updateError) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al eliminar el contrato tipo');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.INMUEBLE_UPDATED,
    entidad: AUDIT_ENTITIES.INMUEBLE,
    entidadId: inmuebleId,
    detalle: { accion: 'contrato_tipo_eliminado' },
    ip,
  });

  return { eliminado: true };
}

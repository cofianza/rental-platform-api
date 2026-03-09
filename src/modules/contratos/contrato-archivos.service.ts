import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type { TipoArchivoContrato } from './contrato-archivos.schema';

// ============================================================
// Constants
// ============================================================

const BUCKET_NAME = 'documentos-expedientes';
const DOWNLOAD_URL_EXPIRY_SECONDS = 600; // 10 minutes
const ESTADOS_CON_ARCHIVOS = ['firmado', 'vigente', 'finalizado', 'cancelado'];

const TIPO_LABELS: Record<TipoArchivoContrato, string> = {
  inventario: 'Inventario del inmueble',
  acta_entrega: 'Acta de entrega',
  documento_identidad: 'Documento de identidad',
};

// ============================================================
// Helper: fetch contrato base
// ============================================================

async function fetchContratoBase(contratoId: string) {
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, estado')
    .eq('id', contratoId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  return data as unknown as { id: string; expediente_id: string; estado: string };
}

// ============================================================
// Subir archivo asociado
// ============================================================

export async function subirArchivo(
  contratoId: string,
  tipoArchivo: TipoArchivoContrato,
  file: { buffer: Buffer; originalname: string; size: number; mimetype: string },
  userId: string,
  ip?: string,
) {
  const contrato = await fetchContratoBase(contratoId);

  if (!ESTADOS_CON_ARCHIVOS.includes(contrato.estado)) {
    throw AppError.badRequest(
      'Solo se pueden subir archivos cuando el contrato esta en estado Firmado o posterior',
      'INVALID_STATE',
    );
  }

  // Calcular hash SHA-256
  const hashIntegridad = crypto.createHash('sha256').update(file.buffer).digest('hex');

  // Storage key
  const extension = file.originalname.split('.').pop() || 'pdf';
  const uniqueId = crypto.randomUUID();
  const storageKey = `contratos/${contrato.expediente_id}/${contratoId}/archivos/${tipoArchivo}_${uniqueId}.${extension}`;

  // Upload to storage
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storageKey, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (uploadError) {
    logger.error({ error: uploadError.message, contratoId, tipoArchivo }, 'Error al subir archivo a storage');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al almacenar el archivo');
  }

  // Insert record
  const { data: archivo, error: insertError } = await (supabase
    .from('contrato_archivos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      contrato_id: contratoId,
      tipo_archivo: tipoArchivo,
      storage_key: storageKey,
      nombre_archivo: file.originalname,
      tipo_mime: file.mimetype,
      tamano_bytes: file.size,
      hash_integridad: hashIntegridad,
      subido_por: userId,
    } as never)
    .select('id, contrato_id, tipo_archivo, nombre_archivo, tipo_mime, tamano_bytes, hash_integridad, subido_por, created_at')
    .single();

  if (insertError || !archivo) {
    logger.error({ error: insertError?.message, contratoId }, 'Error al registrar archivo en BD');
    // Intentar limpiar el archivo huerfano en storage
    await supabase.storage.from(BUCKET_NAME).remove([storageKey]);
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al registrar el archivo');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_ARCHIVO_UPLOADED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: {
      archivo_id: (archivo as unknown as { id: string }).id,
      tipo_archivo: tipoArchivo,
      nombre_archivo: file.originalname,
      tamano_bytes: file.size,
    },
    ip,
  });

  return archivo;
}

// ============================================================
// Listar archivos del contrato
// ============================================================

export async function listarArchivos(contratoId: string) {
  // Verify contrato exists
  await fetchContratoBase(contratoId);

  const { data, error } = await (supabase
    .from('contrato_archivos' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, tipo_archivo, nombre_archivo, tipo_mime, tamano_bytes, hash_integridad, subido_por, created_at, perfiles(id, nombre, apellido)')
    .eq('contrato_id', contratoId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error: error.message, contratoId }, 'Error al listar archivos del contrato');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener los archivos');
  }

  const archivos = (data ?? []).map((row: unknown) => {
    const r = row as {
      id: string;
      contrato_id: string;
      tipo_archivo: string;
      nombre_archivo: string;
      tipo_mime: string;
      tamano_bytes: number;
      hash_integridad: string;
      subido_por: string | null;
      created_at: string;
      perfiles: { id: string; nombre: string; apellido: string } | null;
    };
    return {
      id: r.id,
      contrato_id: r.contrato_id,
      tipo_archivo: r.tipo_archivo,
      tipo_archivo_label: TIPO_LABELS[r.tipo_archivo as TipoArchivoContrato] || r.tipo_archivo,
      nombre_archivo: r.nombre_archivo,
      tipo_mime: r.tipo_mime,
      tamano_bytes: r.tamano_bytes,
      hash_integridad: r.hash_integridad,
      created_at: r.created_at,
      subido_por: r.perfiles,
    };
  });

  return { archivos };
}

// ============================================================
// Descargar archivo
// ============================================================

export async function descargarArchivo(
  contratoId: string,
  archivoId: string,
  userId: string,
  ip?: string,
) {
  const { data, error } = await (supabase
    .from('contrato_archivos' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, storage_key, nombre_archivo, tipo_mime')
    .eq('id', archivoId)
    .eq('contrato_id', contratoId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Archivo no encontrado', 'ARCHIVO_NOT_FOUND');
  }

  const archivo = data as unknown as {
    id: string;
    storage_key: string;
    nombre_archivo: string;
    tipo_mime: string;
  };

  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(archivo.storage_key, DOWNLOAD_URL_EXPIRY_SECONDS, {
      download: archivo.nombre_archivo,
    });

  if (urlError || !urlData) {
    logger.error({ error: urlError?.message, archivoId }, 'Error al generar URL de descarga del archivo');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de descarga');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_ARCHIVO_DOWNLOADED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: { archivo_id: archivoId, nombre_archivo: archivo.nombre_archivo },
    ip,
  });

  return {
    url: urlData.signedUrl,
    nombre_archivo: archivo.nombre_archivo,
    tipo_mime: archivo.tipo_mime,
    expires_in: DOWNLOAD_URL_EXPIRY_SECONDS,
  };
}

// ============================================================
// Eliminar archivo
// ============================================================

export async function eliminarArchivo(
  contratoId: string,
  archivoId: string,
  userId: string,
  ip?: string,
) {
  const { data, error } = await (supabase
    .from('contrato_archivos' as string) as ReturnType<typeof supabase.from>)
    .select('id, contrato_id, storage_key, nombre_archivo, tipo_archivo')
    .eq('id', archivoId)
    .eq('contrato_id', contratoId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Archivo no encontrado', 'ARCHIVO_NOT_FOUND');
  }

  const archivo = data as unknown as {
    id: string;
    storage_key: string;
    nombre_archivo: string;
    tipo_archivo: string;
  };

  // Delete from storage
  const { error: removeError } = await supabase.storage
    .from(BUCKET_NAME)
    .remove([archivo.storage_key]);

  if (removeError) {
    logger.warn({ error: removeError.message, archivoId }, 'Error al eliminar archivo de storage');
  }

  // Delete record
  const { error: deleteError } = await (supabase
    .from('contrato_archivos' as string) as ReturnType<typeof supabase.from>)
    .delete()
    .eq('id', archivoId);

  if (deleteError) {
    logger.error({ error: deleteError.message, archivoId }, 'Error al eliminar registro de archivo');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al eliminar el archivo');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_ARCHIVO_DELETED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: {
      archivo_id: archivoId,
      tipo_archivo: archivo.tipo_archivo,
      nombre_archivo: archivo.nombre_archivo,
    },
    ip,
  });
}

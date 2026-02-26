import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type {
  PresignedUrlInput,
  ConfirmarSubidaInput,
  ListDocumentosQuery,
  ReemplazarDocumentoInput,
  ConfirmarReemplazoInput,
} from './documentos.schema';

// ============================================================
// Constants
// ============================================================

const BUCKET_NAME = 'documentos-expedientes';
const PRESIGNED_URL_EXPIRY_SECONDS = 900; // 15 minutes
const SIGNED_URL_VIEW_EXPIRY_SECONDS = 3600; // 1 hour for viewing
const VIEWER_URL_EXPIRY_SECONDS = 900; // 15 minutes for viewer
const ESTADOS_TERMINALES = ['cerrado', 'rechazado'];

const DOCUMENTO_FIELDS = `
  id, expediente_id, tipo_documento_id, archivo_url, nombre_original,
  nombre_archivo, storage_key, tipo_mime, tamano_bytes, estado,
  motivo_rechazo, version, validado_por, subido_por, fecha_revision,
  reemplazado_por, created_at, updated_at
`;

// ============================================================
// Interfaces
// ============================================================

interface DocumentoRow {
  id: string;
  expediente_id: string;
  tipo_documento_id: string;
  archivo_url: string | null;
  nombre_original: string;
  nombre_archivo: string | null;
  storage_key: string | null;
  tipo_mime: string | null;
  tamano_bytes: number | null;
  estado: string;
  motivo_rechazo: string | null;
  version: number;
  validado_por: string | null;
  subido_por: string | null;
  fecha_revision: string | null;
  reemplazado_por: string | null;
  created_at: string;
  updated_at: string;
}

interface TipoDocumentoRow {
  id: string;
  codigo: string;
  nombre: string;
  descripcion: string | null;
  es_obligatorio: boolean;
  formatos_aceptados: string[];
  tamano_maximo_mb: number;
  orden: number;
  activo: boolean;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Helper: Generate signed URL for viewing
// ============================================================

async function generateViewUrl(storageKey: string | null): Promise<string | null> {
  if (!storageKey) return null;

  try {
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(storageKey, SIGNED_URL_VIEW_EXPIRY_SECONDS);

    if (error || !data) {
      logger.warn({ error: error?.message, storageKey }, 'Error generating signed URL');
      return null;
    }

    return data.signedUrl;
  } catch (err) {
    logger.warn({ error: (err as Error).message, storageKey }, 'Exception generating signed URL');
    return null;
  }
}

/**
 * Adds archivo_url to documents by generating signed URLs
 */
async function addSignedUrls<T extends DocumentoRow>(docs: T[]): Promise<T[]> {
  const results = await Promise.all(
    docs.map(async (doc) => {
      const archivo_url = await generateViewUrl(doc.storage_key);
      return { ...doc, archivo_url };
    })
  );
  return results;
}

// ============================================================
// generatePresignedUrl
// ============================================================

export async function generatePresignedUrl(input: PresignedUrlInput, userId: string) {
  // 1. Validate tipo_documento
  const { data: tipoDoc, error: tipoError } = await (supabase
    .from('tipos_documento' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('id', input.tipo_documento_id)
    .eq('activo', true)
    .single();

  if (tipoError || !tipoDoc) {
    throw AppError.badRequest(
      'Tipo de documento no encontrado o inactivo',
      'TIPO_DOCUMENTO_NOT_FOUND',
    );
  }

  const tipo = tipoDoc as unknown as TipoDocumentoRow;

  // 2. Validate MIME type
  if (!tipo.formatos_aceptados.includes(input.tipo_mime)) {
    throw AppError.badRequest(
      `Tipo de archivo '${input.tipo_mime}' no permitido para '${tipo.nombre}'. Formatos aceptados: ${tipo.formatos_aceptados.join(', ')}`,
      'MIME_TYPE_NOT_ALLOWED',
    );
  }

  // 3. Validate file size
  const maxBytes = tipo.tamano_maximo_mb * 1024 * 1024;
  if (input.tamano_bytes > maxBytes) {
    throw new AppError(
      413,
      'FILE_TOO_LARGE',
      `El archivo excede el tamano maximo de ${tipo.tamano_maximo_mb}MB`,
    );
  }

  // 4. Validate expediente exists and is not terminal
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('id', input.expediente_id)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado');
  }

  const exp = expediente as unknown as { id: string; estado: string };
  if (ESTADOS_TERMINALES.includes(exp.estado)) {
    throw AppError.badRequest(
      'No se pueden subir documentos a un expediente en estado terminal',
      'EXPEDIENTE_TERMINAL',
    );
  }

  // 5. Generate storage key
  const ext = input.nombre_original.includes('.')
    ? input.nombre_original.split('.').pop()!.toLowerCase()
    : 'bin';
  const nombreArchivo = `${crypto.randomUUID()}.${ext}`;
  const storageKey = `expedientes/${input.expediente_id}/documents/${nombreArchivo}`;

  // 6. Create signed upload URL
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUploadUrl(storageKey);

  if (uploadError || !uploadData) {
    logger.error({ error: uploadError?.message, storageKey }, 'Error al crear URL de subida');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de subida');
  }

  return {
    signedUrl: uploadData.signedUrl,
    storage_key: storageKey,
    nombre_archivo: nombreArchivo,
    token: uploadData.token,
    expires_in: PRESIGNED_URL_EXPIRY_SECONDS,
  };
}

// ============================================================
// confirmarSubida
// ============================================================

export async function confirmarSubida(
  input: ConfirmarSubidaInput,
  userId: string,
  ip?: string,
) {
  // 1. Validate expediente
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('id', input.expediente_id)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado');
  }

  const exp = expediente as unknown as { id: string; estado: string };
  if (ESTADOS_TERMINALES.includes(exp.estado)) {
    throw AppError.badRequest(
      'No se pueden subir documentos a un expediente en estado terminal',
      'EXPEDIENTE_TERMINAL',
    );
  }

  // 2. Validate tipo_documento
  const { data: tipoDoc, error: tipoError } = await (supabase
    .from('tipos_documento' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre')
    .eq('id', input.tipo_documento_id)
    .eq('activo', true)
    .single();

  if (tipoError || !tipoDoc) {
    throw AppError.badRequest(
      'Tipo de documento no encontrado o inactivo',
      'TIPO_DOCUMENTO_NOT_FOUND',
    );
  }

  // 3. Verify file exists in storage
  const { error: verifyError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(input.storage_key, 60);

  if (verifyError) {
    logger.warn(
      { error: verifyError.message, storage_key: input.storage_key },
      'Archivo no encontrado en storage',
    );
    throw AppError.badRequest(
      'El archivo no fue encontrado en el storage. Verifique que la subida se completo correctamente.',
      'FILE_NOT_FOUND_IN_STORAGE',
    );
  }

  // 4. Calculate version
  const { count } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .eq('expediente_id', input.expediente_id)
    .eq('tipo_documento_id', input.tipo_documento_id);

  const version = (count ?? 0) + 1;

  // 5. Insert document record
  const { data: doc, error: insertError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: input.expediente_id,
      tipo_documento_id: input.tipo_documento_id,
      nombre_original: input.nombre_original,
      nombre_archivo: input.nombre_archivo,
      storage_key: input.storage_key,
      tipo_mime: input.tipo_mime,
      tamano_bytes: input.tamano_bytes,
      estado: 'pendiente',
      version,
      subido_por: userId,
    } as never)
    .select(DOCUMENTO_FIELDS)
    .single();

  if (insertError) {
    logger.error({ error: insertError.message }, 'Error al registrar documento');
    if (insertError.code === '23503') {
      throw AppError.badRequest(
        'Referencia invalida. Verifique los datos proporcionados',
        'FK_VIOLATION',
      );
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al registrar el documento');
  }

  const created = doc as unknown as DocumentoRow;

  // 6. Mark previous docs of same type as replaced
  const { data: previousDocs } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('expediente_id', input.expediente_id)
    .eq('tipo_documento_id', input.tipo_documento_id)
    .in('estado', ['pendiente', 'aprobado'])
    .neq('id', created.id);

  if (previousDocs && (previousDocs as unknown as Array<{ id: string }>).length > 0) {
    const prevIds = (previousDocs as unknown as Array<{ id: string }>).map((d) => d.id);
    await (supabase
      .from('documentos' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'reemplazado', reemplazado_por: created.id } as never)
      .in('id', prevIds);
  }

  // 7. Audit log
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.DOCUMENTO_UPLOADED,
    entidad: AUDIT_ENTITIES.DOCUMENTO,
    entidadId: created.id,
    detalle: {
      expediente_id: input.expediente_id,
      tipo_documento_id: input.tipo_documento_id,
      nombre_original: input.nombre_original,
      storage_key: input.storage_key,
      version,
    },
    ip,
  });

  // Add signed URL for immediate viewing
  const archivo_url = await generateViewUrl(created.storage_key);

  return { ...created, archivo_url };
}

// ============================================================
// listDocumentosByExpediente
// ============================================================

export async function listDocumentosByExpediente(
  expedienteId: string,
  query: ListDocumentosQuery,
) {
  // Validate expediente exists
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado');
  }

  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 20;
  const sortBy = query.sortBy || 'created_at';
  const sortOrder = query.sortOrder || 'desc';
  const offset = (page - 1) * limit;

  // Build query with join to tipos_documento
  let dbQuery = (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select(
      `${DOCUMENTO_FIELDS}, tipo_documento:tipos_documento!documentos_tipo_documento_id_fkey(id, codigo, nombre)`,
      { count: 'exact' },
    )
    .eq('expediente_id', expedienteId);

  // Apply filters
  if (query.tipo_documento_id) {
    dbQuery = dbQuery.eq('tipo_documento_id', query.tipo_documento_id);
  }
  if (query.estado) {
    dbQuery = dbQuery.eq('estado', query.estado);
  }

  // Sort + paginate
  const ascending = sortOrder === 'asc';
  dbQuery = dbQuery
    .order(sortBy, { ascending })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await dbQuery;

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al listar documentos');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener documentos');
  }

  const total = count ?? 0;
  const rawDocs = (data as unknown as DocumentoRow[]) || [];

  // Generate signed URLs for viewing
  const documentos = await addSignedUrls(rawDocs);

  return {
    documentos,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ============================================================
// getDocumentoById
// ============================================================

export async function getDocumentoById(id: string) {
  const { data, error } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select(`
      ${DOCUMENTO_FIELDS},
      tipo_documento:tipos_documento!documentos_tipo_documento_id_fkey(id, codigo, nombre),
      subidor:perfiles!documentos_subido_por_fkey(id, nombre, apellido),
      validador:perfiles!documentos_validado_por_fkey(id, nombre, apellido)
    `)
    .eq('id', id)
    .single();

  if (error || !data) {
    if (error?.code === 'PGRST116') {
      throw AppError.notFound('Documento no encontrado');
    }
    logger.error({ error: error?.message, id }, 'Error al obtener documento');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el documento');
  }

  // Add signed URL for viewing
  const doc = data as unknown as DocumentoRow;
  const archivo_url = await generateViewUrl(doc.storage_key);

  return { ...data, archivo_url };
}

// ============================================================
// deleteDocumento
// ============================================================

export async function deleteDocumento(
  id: string,
  userId: string,
  userRole: string,
  ip?: string,
) {
  // 1. Get existing document
  const { data: existing, error: existError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select(DOCUMENTO_FIELDS)
    .eq('id', id)
    .single();

  if (existError || !existing) {
    if (existError?.code === 'PGRST116') {
      throw AppError.notFound('Documento no encontrado');
    }
    throw AppError.notFound('Documento no encontrado');
  }

  const doc = existing as unknown as DocumentoRow;

  // 2. Only allow delete if estado = 'pendiente'
  if (doc.estado !== 'pendiente') {
    throw AppError.badRequest(
      'Solo se pueden eliminar documentos con estado pendiente',
      'DELETE_NOT_ALLOWED',
    );
  }

  // 3. Only owner or admin can delete
  if (doc.subido_por !== userId && userRole !== 'administrador') {
    throw AppError.forbidden(
      'Solo el propietario del documento o un administrador puede eliminarlo',
    );
  }

  // 4. Delete from storage
  if (doc.storage_key) {
    const { error: storageError } = await supabase.storage
      .from(BUCKET_NAME)
      .remove([doc.storage_key]);

    if (storageError) {
      logger.warn(
        { error: storageError.message, storage_key: doc.storage_key },
        'Error al eliminar archivo del storage',
      );
    }
  }

  // 5. Delete from DB
  const { error: deleteError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .delete()
    .eq('id', id);

  if (deleteError) {
    logger.error({ error: deleteError.message, id }, 'Error al eliminar documento');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al eliminar el documento');
  }

  // 6. Audit log
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.DOCUMENTO_DELETED,
    entidad: AUDIT_ENTITIES.DOCUMENTO,
    entidadId: id,
    detalle: {
      expediente_id: doc.expediente_id,
      nombre_original: doc.nombre_original,
      storage_key: doc.storage_key,
    },
    ip,
  });
}

// ============================================================
// listTiposDocumento
// ============================================================

export async function listTiposDocumento() {
  const { data, error } = await (supabase
    .from('tipos_documento' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('activo', true)
    .order('orden', { ascending: true });

  if (error) {
    logger.error({ error: error.message }, 'Error al listar tipos de documento');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener tipos de documento');
  }

  return (data as unknown as TipoDocumentoRow[]) || [];
}

// ============================================================
// aprobarDocumento
// ============================================================

const ESTADOS_NO_VALIDABLES = ['aprobado', 'reemplazado'];

export async function aprobarDocumento(id: string, userId: string, ip?: string) {
  // 1. Fetch document
  const { data: existing, error: existError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select(DOCUMENTO_FIELDS)
    .eq('id', id)
    .single();

  if (existError || !existing) {
    if (existError?.code === 'PGRST116') {
      throw AppError.notFound('Documento no encontrado');
    }
    throw AppError.notFound('Documento no encontrado');
  }

  const doc = existing as unknown as DocumentoRow;

  // 2. Validate estado
  if (ESTADOS_NO_VALIDABLES.includes(doc.estado)) {
    throw AppError.conflict(
      `No se puede aprobar un documento con estado '${doc.estado}'`,
      'DOCUMENTO_ALREADY_VALIDATED',
    );
  }

  // 3. Update
  const { data: updated, error: updateError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'aprobado',
      validado_por: userId,
      fecha_revision: new Date().toISOString(),
      motivo_rechazo: null,
    } as never)
    .eq('id', id)
    .select(DOCUMENTO_FIELDS)
    .single();

  if (updateError) {
    logger.error({ error: updateError.message, id }, 'Error al aprobar documento');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al aprobar el documento');
  }

  const result = updated as unknown as DocumentoRow;

  // 4. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.DOCUMENTO_APROBADO,
    entidad: AUDIT_ENTITIES.DOCUMENTO,
    entidadId: id,
    detalle: {
      expediente_id: doc.expediente_id,
      nombre_original: doc.nombre_original,
      estado_anterior: doc.estado,
    },
    ip,
  });

  // 5. Return with signed URL
  const archivo_url = await generateViewUrl(result.storage_key);
  return { ...result, archivo_url };
}

// ============================================================
// rechazarDocumento
// ============================================================

export async function rechazarDocumento(
  id: string,
  motivoRechazo: string,
  userId: string,
  ip?: string,
) {
  // 1. Fetch document
  const { data: existing, error: existError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select(DOCUMENTO_FIELDS)
    .eq('id', id)
    .single();

  if (existError || !existing) {
    if (existError?.code === 'PGRST116') {
      throw AppError.notFound('Documento no encontrado');
    }
    throw AppError.notFound('Documento no encontrado');
  }

  const doc = existing as unknown as DocumentoRow;

  // 2. Validate estado
  if (ESTADOS_NO_VALIDABLES.includes(doc.estado)) {
    throw AppError.conflict(
      `No se puede rechazar un documento con estado '${doc.estado}'`,
      'DOCUMENTO_ALREADY_VALIDATED',
    );
  }

  // 3. Update
  const { data: updated, error: updateError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'rechazado',
      motivo_rechazo: motivoRechazo,
      validado_por: userId,
      fecha_revision: new Date().toISOString(),
    } as never)
    .eq('id', id)
    .select(DOCUMENTO_FIELDS)
    .single();

  if (updateError) {
    logger.error({ error: updateError.message, id }, 'Error al rechazar documento');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al rechazar el documento');
  }

  const result = updated as unknown as DocumentoRow;

  // 4. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.DOCUMENTO_RECHAZADO,
    entidad: AUDIT_ENTITIES.DOCUMENTO,
    entidadId: id,
    detalle: {
      expediente_id: doc.expediente_id,
      nombre_original: doc.nombre_original,
      estado_anterior: doc.estado,
      motivo_rechazo: motivoRechazo,
    },
    ip,
  });

  // 5. Return with signed URL
  const archivo_url = await generateViewUrl(result.storage_key);
  return { ...result, archivo_url };
}

// ============================================================
// getPendientesRevision
// ============================================================

export async function getPendientesRevision(expedienteId: string) {
  // Validate expediente
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado');
  }

  // Get total docs count (excluding reemplazado)
  const { count: totalCount } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .eq('expediente_id', expedienteId)
    .neq('estado', 'reemplazado');

  // Get pending docs with tipo_documento join
  const { data, error } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select(
      `${DOCUMENTO_FIELDS}, tipo_documento:tipos_documento!documentos_tipo_documento_id_fkey(id, codigo, nombre)`,
    )
    .eq('expediente_id', expedienteId)
    .eq('estado', 'pendiente')
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al obtener pendientes');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener documentos pendientes');
  }

  const rawDocs = (data as unknown as DocumentoRow[]) || [];
  const documentos = await addSignedUrls(rawDocs);

  return {
    documentos,
    total_documentos: totalCount ?? 0,
    pendientes: rawDocs.length,
  };
}

// ============================================================
// getHistorialRevision
// ============================================================

export async function getHistorialRevision(docId: string) {
  // Get the document to find its expediente_id and tipo_documento_id
  const { data: doc, error: docError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, tipo_documento_id')
    .eq('id', docId)
    .single();

  if (docError || !doc) {
    if (docError?.code === 'PGRST116') {
      throw AppError.notFound('Documento no encontrado');
    }
    throw AppError.notFound('Documento no encontrado');
  }

  const { expediente_id, tipo_documento_id } = doc as unknown as {
    expediente_id: string;
    tipo_documento_id: string;
  };

  // Get all versions of this document type for this expediente
  const { data, error } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, estado, motivo_rechazo, validado_por, fecha_revision, version, created_at,
      validador:perfiles!documentos_validado_por_fkey(id, nombre, apellido)
    `)
    .eq('expediente_id', expediente_id)
    .eq('tipo_documento_id', tipo_documento_id)
    .order('version', { ascending: false });

  if (error) {
    logger.error({ error: error.message, docId }, 'Error al obtener historial');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener historial de revision');
  }

  return (data as unknown as Array<{
    id: string;
    estado: string;
    motivo_rechazo: string | null;
    validado_por: string | null;
    fecha_revision: string | null;
    version: number;
    created_at: string;
    validador: { id: string; nombre: string; apellido: string } | null;
  }>) || [];
}

// ============================================================
// generateViewUrlForViewer (15-min signed URL for inline viewing)
// ============================================================

export async function generateViewUrlForViewer(id: string, userId: string) {
  // 1. Fetch document
  const { data, error } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select('id, storage_key, nombre_original, tipo_mime')
    .eq('id', id)
    .single();

  if (error || !data) {
    throw AppError.notFound('Documento no encontrado');
  }

  const doc = data as unknown as {
    id: string;
    storage_key: string | null;
    nombre_original: string;
    tipo_mime: string | null;
  };

  if (!doc.storage_key) {
    throw AppError.badRequest('El documento no tiene archivo asociado', 'NO_STORAGE_KEY');
  }

  // 2. Generate signed URL for inline viewing
  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(doc.storage_key, VIEWER_URL_EXPIRY_SECONDS);

  if (urlError || !urlData) {
    logger.error({ error: urlError?.message, id }, 'Error al generar URL de visualizacion');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de visualizacion');
  }

  return {
    url: urlData.signedUrl,
    nombre_original: doc.nombre_original,
    tipo_mime: doc.tipo_mime,
    expires_in: VIEWER_URL_EXPIRY_SECONDS,
  };
}

// ============================================================
// generateDownloadUrl (signed URL with Content-Disposition: attachment)
// ============================================================

export async function generateDownloadUrl(id: string, userId: string, ip?: string) {
  // 1. Fetch document
  const { data, error } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select('id, storage_key, nombre_original, tipo_mime')
    .eq('id', id)
    .single();

  if (error || !data) {
    throw AppError.notFound('Documento no encontrado');
  }

  const doc = data as unknown as {
    id: string;
    storage_key: string | null;
    nombre_original: string;
    tipo_mime: string | null;
  };

  if (!doc.storage_key) {
    throw AppError.badRequest('El documento no tiene archivo asociado', 'NO_STORAGE_KEY');
  }

  // 2. Generate signed URL with download disposition
  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(doc.storage_key, VIEWER_URL_EXPIRY_SECONDS, {
      download: doc.nombre_original,
    });

  if (urlError || !urlData) {
    logger.error({ error: urlError?.message, id }, 'Error al generar URL de descarga');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de descarga');
  }

  // 3. Audit log
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.DOCUMENTO_DESCARGADO,
    entidad: AUDIT_ENTITIES.DOCUMENTO,
    entidadId: id,
    detalle: { nombre_original: doc.nombre_original },
    ip,
  });

  return {
    url: urlData.signedUrl,
    nombre_original: doc.nombre_original,
    tipo_mime: doc.tipo_mime,
    expires_in: VIEWER_URL_EXPIRY_SECONDS,
  };
}

// ============================================================
// iniciarReemplazo — presigned URL for replacing a rejected doc
// ============================================================

export async function iniciarReemplazo(
  docId: string,
  input: ReemplazarDocumentoInput,
  userId: string,
  userRole: string,
) {
  // 1. Fetch documento
  const { data: existing, error: existError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select(DOCUMENTO_FIELDS)
    .eq('id', docId)
    .single();

  if (existError || !existing) {
    if (existError?.code === 'PGRST116') {
      throw AppError.notFound('Documento no encontrado');
    }
    throw AppError.notFound('Documento no encontrado');
  }

  const doc = existing as unknown as DocumentoRow;

  // 2. Validate estado === 'rechazado'
  if (doc.estado !== 'rechazado') {
    throw AppError.conflict(
      'Solo se pueden reemplazar documentos con estado rechazado',
      'DOCUMENTO_NOT_RECHAZADO',
    );
  }

  // 3. Validate ownership
  if (doc.subido_por !== userId && userRole !== 'administrador') {
    throw AppError.forbidden(
      'Solo el propietario del documento o un administrador puede reemplazarlo',
    );
  }

  // 4. Validate expediente not terminal
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('id', doc.expediente_id)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado');
  }

  const exp = expediente as unknown as { id: string; estado: string };
  if (ESTADOS_TERMINALES.includes(exp.estado)) {
    throw AppError.badRequest(
      'No se pueden subir documentos a un expediente en estado terminal',
      'EXPEDIENTE_TERMINAL',
    );
  }

  // 5. Validate tipo_documento activo + MIME + size
  const { data: tipoDoc, error: tipoError } = await (supabase
    .from('tipos_documento' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('id', doc.tipo_documento_id)
    .eq('activo', true)
    .single();

  if (tipoError || !tipoDoc) {
    throw AppError.badRequest(
      'Tipo de documento no encontrado o inactivo',
      'TIPO_DOCUMENTO_NOT_FOUND',
    );
  }

  const tipo = tipoDoc as unknown as TipoDocumentoRow;

  if (!tipo.formatos_aceptados.includes(input.tipo_mime)) {
    throw AppError.badRequest(
      `Tipo de archivo '${input.tipo_mime}' no permitido. Formatos aceptados: ${tipo.formatos_aceptados.join(', ')}`,
      'MIME_TYPE_NOT_ALLOWED',
    );
  }

  const maxBytes = tipo.tamano_maximo_mb * 1024 * 1024;
  if (input.tamano_bytes > maxBytes) {
    throw new AppError(
      413,
      'FILE_TOO_LARGE',
      `El archivo excede el tamano maximo de ${tipo.tamano_maximo_mb}MB`,
    );
  }

  // 6. Generate storage key
  const ext = input.nombre_original.includes('.')
    ? input.nombre_original.split('.').pop()!.toLowerCase()
    : 'bin';
  const nombreArchivo = `${crypto.randomUUID()}.${ext}`;
  const storageKey = `expedientes/${doc.expediente_id}/documents/${nombreArchivo}`;

  // 7. Create signed upload URL
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUploadUrl(storageKey);

  if (uploadError || !uploadData) {
    logger.error({ error: uploadError?.message, storageKey }, 'Error al crear URL de subida para reemplazo');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de subida');
  }

  return {
    signedUrl: uploadData.signedUrl,
    storage_key: storageKey,
    nombre_archivo: nombreArchivo,
    token: uploadData.token,
    expires_in: PRESIGNED_URL_EXPIRY_SECONDS,
    documento_original_id: doc.id,
    expediente_id: doc.expediente_id,
    tipo_documento_id: doc.tipo_documento_id,
  };
}

// ============================================================
// confirmarReemplazo — atomically create new doc + mark old as replaced
// ============================================================

export async function confirmarReemplazo(
  docId: string,
  input: ConfirmarReemplazoInput,
  userId: string,
  ip?: string,
) {
  // 1. Re-fetch and re-validate estado (race condition protection)
  const { data: existing, error: existError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select(DOCUMENTO_FIELDS)
    .eq('id', docId)
    .single();

  if (existError || !existing) {
    throw AppError.notFound('Documento no encontrado');
  }

  const doc = existing as unknown as DocumentoRow;

  if (doc.estado !== 'rechazado') {
    throw AppError.conflict(
      'El documento ya no esta en estado rechazado. Posible operacion duplicada.',
      'DOCUMENTO_NOT_RECHAZADO',
    );
  }

  // 2. Verify file exists in storage
  const { error: verifyError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(input.storage_key, 60);

  if (verifyError) {
    logger.warn(
      { error: verifyError.message, storage_key: input.storage_key },
      'Archivo de reemplazo no encontrado en storage',
    );
    throw AppError.badRequest(
      'El archivo no fue encontrado en el storage. Verifique que la subida se completo correctamente.',
      'FILE_NOT_FOUND_IN_STORAGE',
    );
  }

  // 3. Calculate version
  const { count } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .eq('expediente_id', doc.expediente_id)
    .eq('tipo_documento_id', doc.tipo_documento_id);

  const version = (count ?? 0) + 1;

  // 4. INSERT new document
  const { data: newDoc, error: insertError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: doc.expediente_id,
      tipo_documento_id: doc.tipo_documento_id,
      nombre_original: input.nombre_original,
      nombre_archivo: input.nombre_archivo,
      storage_key: input.storage_key,
      tipo_mime: input.tipo_mime,
      tamano_bytes: input.tamano_bytes,
      estado: 'pendiente',
      version,
      subido_por: userId,
    } as never)
    .select(DOCUMENTO_FIELDS)
    .single();

  if (insertError) {
    logger.error({ error: insertError.message }, 'Error al registrar documento de reemplazo');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al registrar el documento de reemplazo');
  }

  const created = newDoc as unknown as DocumentoRow;

  // 5. UPDATE original document → reemplazado
  await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'reemplazado', reemplazado_por: created.id } as never)
    .eq('id', docId);

  // 6. Audit log
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.DOCUMENTO_REEMPLAZADO,
    entidad: AUDIT_ENTITIES.DOCUMENTO,
    entidadId: created.id,
    detalle: {
      documento_original_id: docId,
      expediente_id: doc.expediente_id,
      tipo_documento_id: doc.tipo_documento_id,
      nombre_original: input.nombre_original,
      version,
    },
    ip,
  });

  // 7. Return with signed URL
  const archivo_url = await generateViewUrl(created.storage_key);
  return { ...created, archivo_url };
}

// ============================================================
// getVersiones — version history for a document type in an expediente
// ============================================================

export async function getVersiones(docId: string) {
  // 1. Fetch doc to get expediente_id, tipo_documento_id
  const { data: doc, error: docError } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, tipo_documento_id')
    .eq('id', docId)
    .single();

  if (docError || !doc) {
    if (docError?.code === 'PGRST116') {
      throw AppError.notFound('Documento no encontrado');
    }
    throw AppError.notFound('Documento no encontrado');
  }

  const { expediente_id, tipo_documento_id } = doc as unknown as {
    expediente_id: string;
    tipo_documento_id: string;
  };

  // 2. Get all versions
  const { data, error } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, estado, motivo_rechazo, validado_por, fecha_revision, version,
      nombre_original, created_at, subido_por,
      validador:perfiles!documentos_validado_por_fkey(id, nombre, apellido),
      subidor:perfiles!documentos_subido_por_fkey(id, nombre, apellido)
    `)
    .eq('expediente_id', expediente_id)
    .eq('tipo_documento_id', tipo_documento_id)
    .order('version', { ascending: false });

  if (error) {
    logger.error({ error: error.message, docId }, 'Error al obtener versiones');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener versiones del documento');
  }

  return {
    documento_id: docId,
    expediente_id,
    tipo_documento_id,
    versiones: data || [],
  };
}

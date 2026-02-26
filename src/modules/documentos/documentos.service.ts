import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type {
  PresignedUrlInput,
  ConfirmarSubidaInput,
  ListDocumentosQuery,
} from './documentos.schema';

// ============================================================
// Constants
// ============================================================

const BUCKET_NAME = 'documentos-expedientes';
const PRESIGNED_URL_EXPIRY_SECONDS = 900; // 15 minutes
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

  return created;
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

  return {
    documentos: (data as unknown as DocumentoRow[]) || [],
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

  return data;
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

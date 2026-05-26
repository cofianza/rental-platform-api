/**
 * Documentos legales que la inmobiliaria/propietario carga para operar
 * con Cofianza (Camara de Comercio, RUT, Matricula, Cedula RL, Poder,
 * Poliza, Contrato Marco). Mario 12-may-2026.
 *
 * - El UNIQUE(perfil_id, tipo) hace upsert: subir el mismo tipo dos
 *   veces reemplaza el doc anterior. Antes del upsert borramos el blob
 *   anterior del storage para no acumular.
 * - Storage bucket: documentos-expedientes con prefix documentos-legales/
 *   { perfil_id }/{ tipo }.{ ext }.
 */

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { TIPOS_DOCUMENTO_LEGAL, type TipoDocumentoLegal } from './documentos-legales.schema';

const BUCKET = 'documentos-expedientes';
const PATH_PREFIX = 'documentos-legales';

interface DocumentoLegalRow {
  id: string;
  perfil_id: string;
  tipo: TipoDocumentoLegal;
  storage_key: string;
  nombre_archivo: string;
  tipo_mime: string;
  tamano_bytes: number;
  estado: 'cargado' | 'validado' | 'rechazado';
  notas_validacion: string | null;
  subido_por: string | null;
  subido_en: string;
  validado_por: string | null;
  validado_en: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentoLegalResumen {
  tipo: TipoDocumentoLegal;
  cargado: boolean;
  documento: DocumentoLegalRow | null;
}

function mimeToExt(mime: string): string {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

/**
 * Lista los 7 tipos de documento con el estado de cada uno para el perfil
 * autenticado. Si un tipo no tiene fila, viene como `cargado: false`.
 */
export async function listMisDocumentosLegales(perfilId: string): Promise<DocumentoLegalResumen[]> {
  const { data, error } = await (supabase
    .from('documentos_legales_inmobiliaria' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('perfil_id', perfilId);

  if (error) {
    logger.error({ error: error.message, perfilId }, 'Error listando documentos legales');
    throw AppError.badRequest('Error al obtener documentos legales', 'DOCS_LEGALES_LIST_ERROR');
  }

  const docs = (data as DocumentoLegalRow[]) || [];
  const byTipo = new Map(docs.map((d) => [d.tipo, d]));

  return TIPOS_DOCUMENTO_LEGAL.map((tipo) => ({
    tipo,
    cargado: byTipo.has(tipo),
    documento: byTipo.get(tipo) ?? null,
  }));
}

/**
 * Sube un documento legal. Si ya existe uno del mismo tipo lo reemplaza
 * (borra el blob anterior en storage + upsert en la fila).
 */
export async function uploadDocumentoLegal(
  perfilId: string,
  tipo: TipoDocumentoLegal,
  file: { buffer: Buffer; mimetype: string; size: number; originalname: string },
  ip?: string,
): Promise<DocumentoLegalRow> {
  const ext = mimeToExt(file.mimetype);
  const storageKey = `${PATH_PREFIX}/${perfilId}/${tipo}.${ext}`;

  // Si ya existe, leer storage_key actual para limpiar el blob anterior
  // (puede tener una extension distinta — ej. antes era .pdf y ahora .jpg).
  const { data: existingRow } = await (supabase
    .from('documentos_legales_inmobiliaria' as string) as ReturnType<typeof supabase.from>)
    .select('storage_key')
    .eq('perfil_id', perfilId)
    .eq('tipo', tipo)
    .maybeSingle();

  const existing = existingRow as { storage_key: string } | null;
  if (existing?.storage_key && existing.storage_key !== storageKey) {
    await supabase.storage.from(BUCKET).remove([existing.storage_key]);
  }

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storageKey, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });

  if (uploadErr) {
    logger.error({ error: uploadErr.message, perfilId, tipo }, 'Error subiendo documento legal');
    throw new AppError(500, 'STORAGE_ERROR', `No se pudo subir el documento: ${uploadErr.message}`);
  }

  const payload = {
    perfil_id: perfilId,
    tipo,
    storage_key: storageKey,
    nombre_archivo: file.originalname.slice(0, 255),
    tipo_mime: file.mimetype,
    tamano_bytes: file.size,
    estado: 'cargado',
    subido_por: perfilId,
    subido_en: new Date().toISOString(),
    // Limpiar campos de validacion en caso de reemplazo.
    validado_por: null,
    validado_en: null,
    notas_validacion: null,
  };

  const { data: upserted, error: upErr } = await (supabase
    .from('documentos_legales_inmobiliaria' as string) as ReturnType<typeof supabase.from>)
    .upsert(payload as never, { onConflict: 'perfil_id,tipo' })
    .select('*')
    .single();

  if (upErr || !upserted) {
    logger.error({ error: upErr?.message, perfilId, tipo }, 'Error guardando metadata documento legal');
    throw new AppError(500, 'INTERNAL_ERROR', 'Documento subido pero no se pudo registrar');
  }

  logAudit({
    usuarioId: perfilId,
    accion: AUDIT_ACTIONS.DOCUMENTO_UPLOADED,
    entidad: AUDIT_ENTITIES.DOCUMENTO,
    entidadId: (upserted as { id: string }).id,
    detalle: { tipo, size: file.size, mime: file.mimetype, ambito: 'documento_legal_inmobiliaria' },
    ip,
  });

  return upserted as DocumentoLegalRow;
}

/**
 * Genera una URL firmada para descargar el documento (10 min de TTL).
 * Validacion: solo el dueno del documento o admin pueden generar URL.
 */
export async function getSignedDownloadUrl(
  perfilId: string,
  tipo: TipoDocumentoLegal,
  isAdmin: boolean,
  targetPerfilId?: string,
): Promise<{ url: string; nombre_archivo: string }> {
  const ownerId = isAdmin && targetPerfilId ? targetPerfilId : perfilId;

  const { data: row } = await (supabase
    .from('documentos_legales_inmobiliaria' as string) as ReturnType<typeof supabase.from>)
    .select('storage_key, nombre_archivo')
    .eq('perfil_id', ownerId)
    .eq('tipo', tipo)
    .maybeSingle();

  const doc = row as { storage_key: string; nombre_archivo: string } | null;
  if (!doc) {
    throw AppError.notFound('Documento no encontrado', 'DOC_NOT_FOUND');
  }

  const { data: signed, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_key, 600, { download: doc.nombre_archivo });

  if (error || !signed) {
    throw new AppError(500, 'STORAGE_ERROR', 'No se pudo generar la URL de descarga');
  }

  return { url: signed.signedUrl, nombre_archivo: doc.nombre_archivo };
}

/**
 * Elimina el documento del storage + DB. Idempotente.
 */
export async function deleteDocumentoLegal(
  perfilId: string,
  tipo: TipoDocumentoLegal,
  ip?: string,
): Promise<void> {
  const { data: row } = await (supabase
    .from('documentos_legales_inmobiliaria' as string) as ReturnType<typeof supabase.from>)
    .select('id, storage_key')
    .eq('perfil_id', perfilId)
    .eq('tipo', tipo)
    .maybeSingle();

  const doc = row as { id: string; storage_key: string } | null;
  if (!doc) return; // idempotente

  await supabase.storage.from(BUCKET).remove([doc.storage_key]);
  await (supabase
    .from('documentos_legales_inmobiliaria' as string) as ReturnType<typeof supabase.from>)
    .delete()
    .eq('id', doc.id);

  logAudit({
    usuarioId: perfilId,
    accion: AUDIT_ACTIONS.DOCUMENTO_DELETED,
    entidad: AUDIT_ENTITIES.DOCUMENTO,
    entidadId: doc.id,
    detalle: { tipo, ambito: 'documento_legal_inmobiliaria' },
    ip,
  });
}

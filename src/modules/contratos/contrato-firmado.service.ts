import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { assertExpedienteAccess } from '@/lib/tenantScope';

// ============================================================
// Constants
// ============================================================

const BUCKET_NAME = 'documentos-expedientes';
const FIRMADO_URL_EXPIRY_SECONDS = 600; // 10 minutes

const ESTADOS_CON_FIRMADO = ['firmado', 'vigente', 'finalizado', 'cancelado'];

const FIRMADO_SELECT = `
  id, expediente_id, estado, storage_key, nombre_archivo,
  firmado_storage_key, firmado_nombre_archivo, firmado_hash_integridad,
  firmado_ip, firmado_user_agent, firmado_referencia_otp, firmado_notas,
  firmado_tamano_bytes, firmado_subido_por, firmado_subido_en,
  storage_key_firmado, nombre_archivo_firmado
`;

// ============================================================
// Helper: registrar acceso
// ============================================================

async function registrarAcceso(
  contratoId: string,
  usuarioId: string,
  tipoAccion: 'descarga' | 'visualizacion' | 'verificacion' | 'subida',
  ip?: string,
  userAgent?: string,
): Promise<void> {
  const { error } = await (supabase
    .from('contrato_accesos_firmado' as string) as ReturnType<typeof supabase.from>)
    .insert({
      contrato_id: contratoId,
      usuario_id: usuarioId,
      tipo_accion: tipoAccion,
      ip: ip || null,
      user_agent: userAgent || null,
    } as never);

  if (error) {
    logger.warn({ error: error.message, contratoId, tipoAccion }, 'Error al registrar acceso al firmado');
  }
}

// ============================================================
// Helper: fetch contrato con campos firmado
// ============================================================

async function fetchContratoFirmado(contratoId: string) {
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select(FIRMADO_SELECT)
    .eq('id', contratoId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  return data as unknown as {
    id: string;
    expediente_id: string;
    estado: string;
    storage_key: string | null;
    nombre_archivo: string | null;
    firmado_storage_key: string | null;
    firmado_nombre_archivo: string | null;
    firmado_hash_integridad: string | null;
    firmado_ip: string | null;
    firmado_user_agent: string | null;
    firmado_referencia_otp: string | null;
    firmado_notas: string | null;
    firmado_tamano_bytes: number | null;
    firmado_subido_por: string | null;
    firmado_subido_en: string | null;
    // PDF firmado ARCHIVADO DESDE AUCO (firmas estampadas + certificado).
    // OJO: columna distinta de firmado_storage_key (subida manual / combinado).
    storage_key_firmado: string | null;
    nombre_archivo_firmado: string | null;
  };
}

// ============================================================
// Subir contrato firmado
// ============================================================

interface SubirFirmadoInput {
  referencia_otp?: string;
  notas?: string;
}

export async function subirContratoFirmado(
  contratoId: string,
  file: { buffer: Buffer; originalname: string; size: number },
  input: SubirFirmadoInput,
  userId: string,
  ip?: string,
  userAgent?: string,
) {
  const contrato = await fetchContratoFirmado(contratoId);

  // Validar estado
  if (!ESTADOS_CON_FIRMADO.includes(contrato.estado)) {
    throw AppError.badRequest(
      'Solo se puede subir el contrato firmado cuando el estado es Firmado o posterior',
      'INVALID_STATE',
    );
  }

  // Validar que no tenga ya un firmado (a menos que queramos permitir reemplazo)
  if (contrato.firmado_storage_key) {
    throw AppError.conflict(
      'El contrato ya tiene un documento firmado subido',
      'FIRMADO_ALREADY_EXISTS',
    );
  }

  // Calcular hash SHA-256
  const hashIntegridad = crypto.createHash('sha256').update(file.buffer).digest('hex');

  // Upload a storage
  const storageKey = `contratos/${contrato.expediente_id}/${contratoId}/firmado.pdf`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storageKey, file.buffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadError) {
    logger.error({ error: uploadError.message, contratoId }, 'Error al subir contrato firmado a storage');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al almacenar el contrato firmado');
  }

  // Update contrato
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .update({
      firmado_storage_key: storageKey,
      firmado_nombre_archivo: file.originalname,
      firmado_hash_integridad: hashIntegridad,
      firmado_ip: ip || null,
      firmado_user_agent: userAgent || null,
      firmado_referencia_otp: input.referencia_otp || null,
      firmado_notas: input.notas || null,
      firmado_tamano_bytes: file.size,
      firmado_subido_por: userId,
      firmado_subido_en: now,
      updated_at: now,
    } as never)
    .eq('id', contratoId)
    .select(FIRMADO_SELECT)
    .single();

  if (updateError || !updated) {
    logger.error({ error: updateError?.message, contratoId }, 'Error al actualizar contrato con datos del firmado');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al registrar el contrato firmado');
  }

  // Registrar acceso
  await registrarAcceso(contratoId, userId, 'subida', ip, userAgent);

  // Audit log
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_FIRMADO_UPLOADED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: {
      storage_key: storageKey,
      hash_integridad: hashIntegridad,
      tamano_bytes: file.size,
      nombre_archivo: file.originalname,
    },
    ip,
  });

  return updated;
}

// ============================================================
// Descargar contrato firmado
// ============================================================

/**
 * Quién puede descargar el firmado. Corre ANTES de cualquier efecto (archivar
 * desde Auco): un usuario sin permiso no dispara escrituras ni
 * distingue un contrato sin firmar (404) de uno ajeno (403).
 */
async function assertPuedeDescargarFirmado(expedienteId: string, userId: string, userRol: string): Promise<void> {
  const prohibido = () =>
    AppError.forbidden('No tiene permiso para descargar este contrato firmado', 'DOWNLOAD_FORBIDDEN');
  if (userRol === 'gerencia_consulta') throw prohibido();
  // El mismo alcance que el resto del contrato (detalle, archivos, asistente):
  // internos ven todo, el arrendatario su estudio y la inmobiliaria lo que su
  // modo de visibilidad le deja ver (miembros_ven_todo=false → solo lo suyo).
  await assertExpedienteAccess(expedienteId, userId, userRol).catch(() => {
    throw prohibido();
  });
}

export async function descargarContratoFirmado(
  contratoId: string,
  userId: string,
  userRol: string,
  ip?: string,
  userAgent?: string,
  // La vista previa del detalle no es una descarga: queda como 'visualizacion'
  // y sin auditoría de descarga (si no, el log de accesos se llena de falsas).
  vista = false,
) {
  let contrato = await fetchContratoFirmado(contratoId);
  await assertPuedeDescargarFirmado(contrato.expediente_id, userId, userRol);

  // Determinar de donde sale el PDF, en orden de FIDELIDAD (y reportarlo en
  // `fuente` para que el front NO afirme "con firmas de Auco" sobre un PDF
  // que no las tiene — bug jul-2026: se servia el original bajo ese banner):
  //   1. 'manual'    → firmado_storage_key subido a mano (PDF estampado).
  //   2. 'auco'      → storage_key_firmado: el PDF real de Auco (firmas
  //                    estampadas + certificado). Si falta, se intenta
  //                    archivar AHORA (lazy) — cubre contratos donde el
  //                    archive post-firma fallo o no corrio.
  //   3. 'combinado' → el que se generaba con los acuses (ya no se genera; se sirve si quedó en caché).
  //   4. 'original'  → PDF generado sin firmas (ultimo recurso).
  const esCombinadoCacheado = !!contrato.firmado_storage_key?.endsWith('firmado-combinado.pdf');
  let usarStorageKey: string | null = null;
  let nombreArchivo = contrato.nombre_archivo || 'contrato-firmado.pdf';
  let fuente: 'manual' | 'auco' | 'combinado' | 'original';

  if (contrato.firmado_storage_key && !esCombinadoCacheado) {
    usarStorageKey = contrato.firmado_storage_key;
    nombreArchivo = contrato.firmado_nombre_archivo || nombreArchivo;
    fuente = 'manual';
  } else {
    // 2. PDF firmado de Auco (con lazy-archive si aun no esta).
    if (!contrato.storage_key_firmado && ESTADOS_CON_FIRMADO.includes(contrato.estado)) {
      try {
        const { archivarPdfFirmadoEnStorage } = await import('@/modules/firma/firma.service');
        await archivarPdfFirmadoEnStorage(contratoId);
        contrato = await fetchContratoFirmado(contratoId);
      } catch (err) {
        logger.warn(
          { contratoId, err: err instanceof Error ? err.message : String(err) },
          'Lazy archive del PDF firmado de Auco fallo',
        );
      }
    }
    if (contrato.storage_key_firmado) {
      usarStorageKey = contrato.storage_key_firmado;
      nombreArchivo = contrato.nombre_archivo_firmado || nombreArchivo;
      fuente = 'auco';
    } else if (esCombinadoCacheado && contrato.firmado_storage_key) {
      usarStorageKey = contrato.firmado_storage_key;
      nombreArchivo = contrato.firmado_nombre_archivo || nombreArchivo;
      fuente = 'combinado';
    } else if (ESTADOS_CON_FIRMADO.includes(contrato.estado) && contrato.storage_key) {
      // 3. Sin el PDF de Auco: el original, rotulado como tal (sin firmas).
      usarStorageKey = contrato.storage_key;
      fuente = 'original';
    } else {
      usarStorageKey = null;
      fuente = 'original';
    }
  }

  if (!usarStorageKey) {
    throw AppError.notFound('El contrato no tiene documento firmado', 'NO_FIRMADO');
  }

  // Generar signed URL (10 min)
  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(usarStorageKey, FIRMADO_URL_EXPIRY_SECONDS, {
      download: nombreArchivo,
    });

  if (urlError || !urlData) {
    logger.error({ error: urlError?.message, contratoId }, 'Error al generar URL de descarga del firmado');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de descarga');
  }

  // Registrar acceso
  await registrarAcceso(contratoId, userId, vista ? 'visualizacion' : 'descarga', ip, userAgent);

  // Audit log
  if (!vista) {
    logAudit({
      usuarioId: userId,
      accion: AUDIT_ACTIONS.CONTRATO_FIRMADO_DOWNLOADED,
      entidad: AUDIT_ENTITIES.CONTRATO,
      entidadId: contratoId,
      detalle: { nombre_archivo: contrato.firmado_nombre_archivo },
      ip,
    });
  }

  return {
    url: urlData.signedUrl,
    nombre_archivo: nombreArchivo,
    tipo_mime: 'application/pdf',
    expires_in: FIRMADO_URL_EXPIRY_SECONDS,
    // De dónde salió el PDF — el front adapta el banner (no afirmar "con
    // firmas de Auco" cuando fuente es 'combinado' u 'original').
    fuente,
  };
}

// ============================================================
// Info firma (metadatos)
// ============================================================

export async function getInfoFirma(contratoId: string, userId?: string, userRol?: string) {
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, expediente_id,
      firmado_storage_key, firmado_nombre_archivo, firmado_hash_integridad,
      firmado_ip, firmado_user_agent, firmado_referencia_otp, firmado_notas,
      firmado_tamano_bytes, firmado_subido_por, firmado_subido_en
    `)
    .eq('id', contratoId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  const row = data as unknown as {
    id: string;
    expediente_id: string;
    firmado_storage_key: string | null;
    firmado_nombre_archivo: string | null;
    firmado_hash_integridad: string | null;
    firmado_ip: string | null;
    firmado_user_agent: string | null;
    firmado_referencia_otp: string | null;
    firmado_notas: string | null;
    firmado_tamano_bytes: number | null;
    firmado_subido_por: string | null;
    firmado_subido_en: string | null;
  };
  // Como el resto de rutas por id del contrato: 404 si no es de su cartera.
  await assertExpedienteAccess(row.expediente_id, userId, userRol).catch(() => {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  });

  // Fetch user who uploaded
  let subidoPor = null;
  if (row.firmado_subido_por) {
    const { data: perfil } = await (supabase
      .from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('id, nombre, apellido')
      .eq('id', row.firmado_subido_por)
      .single();

    if (perfil) {
      subidoPor = perfil as unknown as { id: string; nombre: string; apellido: string };
    }
  }

  return {
    tiene_firmado: !!row.firmado_storage_key,
    firmado_nombre_archivo: row.firmado_nombre_archivo,
    firmado_hash_integridad: row.firmado_hash_integridad,
    firmado_ip: row.firmado_ip,
    firmado_user_agent: row.firmado_user_agent,
    firmado_referencia_otp: row.firmado_referencia_otp,
    firmado_notas: row.firmado_notas,
    firmado_tamano_bytes: row.firmado_tamano_bytes,
    firmado_subido_en: row.firmado_subido_en,
    firmado_subido_por: subidoPor,
  };
}

// ============================================================
// Verificar integridad
// ============================================================

export async function verificarIntegridad(
  contratoId: string,
  userId: string,
  ip?: string,
  userAgent?: string,
) {
  const contrato = await fetchContratoFirmado(contratoId);

  if (!contrato.firmado_storage_key || !contrato.firmado_hash_integridad) {
    throw AppError.notFound('El contrato no tiene documento firmado', 'NO_FIRMADO');
  }

  // Descargar archivo de storage
  const { data: fileData, error: downloadError } = await supabase.storage
    .from(BUCKET_NAME)
    .download(contrato.firmado_storage_key);

  if (downloadError || !fileData) {
    logger.error({ error: downloadError?.message, contratoId }, 'Error al descargar firmado para verificacion');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al obtener el archivo para verificacion');
  }

  // Recalcular hash
  const buffer = Buffer.from(await fileData.arrayBuffer());
  const hashRecalculado = crypto.createHash('sha256').update(buffer).digest('hex');
  const valido = hashRecalculado === contrato.firmado_hash_integridad;

  // Registrar acceso
  await registrarAcceso(contratoId, userId, 'verificacion', ip, userAgent);

  // Audit log
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_FIRMADO_VERIFIED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: {
      valido,
      hash_almacenado: contrato.firmado_hash_integridad,
      hash_recalculado: hashRecalculado,
    },
    ip,
  });

  return {
    valido,
    hash_almacenado: contrato.firmado_hash_integridad,
    hash_recalculado: hashRecalculado,
    fecha_verificacion: new Date().toISOString(),
  };
}

// ============================================================
// Log de accesos
// ============================================================

export async function getLogAccesos(contratoId: string) {
  // Verify contrato exists
  const { data: contrato } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', contratoId)
    .single();

  if (!contrato) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  const { data, error } = await (supabase
    .from('contrato_accesos_firmado' as string) as ReturnType<typeof supabase.from>)
    .select('id, tipo_accion, ip, user_agent, created_at, usuario_id, perfiles(id, nombre, apellido)')
    .eq('contrato_id', contratoId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    logger.error({ error: error.message, contratoId }, 'Error al obtener log de accesos');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener log de accesos');
  }

  // Map results
  const accesos = (data ?? []).map((row: unknown) => {
    const r = row as {
      id: string;
      tipo_accion: string;
      ip: string | null;
      user_agent: string | null;
      created_at: string;
      usuario_id: string | null;
      perfiles: { id: string; nombre: string; apellido: string } | null;
    };
    return {
      id: r.id,
      tipo_accion: r.tipo_accion,
      ip: r.ip,
      user_agent: r.user_agent,
      created_at: r.created_at,
      usuario: r.perfiles,
    };
  });

  return { accesos };
}

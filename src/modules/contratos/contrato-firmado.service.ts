import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { mergePdfs } from '@/lib/pdfMerger';

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
  firmado_tamano_bytes, firmado_subido_por, firmado_subido_en
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

/**
 * Genera el PDF "contrato firmado" al vuelo combinando el contrato
 * original con los acuses de firma electronica de cada solicitud
 * firmada. Cachea el resultado en `contratos.firmado_storage_key`
 * para no regenerar en proximas descargas. Devuelve null si no se
 * pudo generar (sin acuses disponibles, errores de descarga, etc.)
 * para que el caller caiga al PDF original como fallback.
 */
async function generarFirmadoCombinado(contrato: {
  id: string;
  expediente_id: string;
  storage_key: string | null;
  nombre_archivo: string | null;
}): Promise<{ storageKey: string; nombreArchivo: string } | null> {
  if (!contrato.storage_key) return null;

  // 1. Acuses disponibles para este contrato (vienen de evidencias_firma
  // joined con solicitudes_firma).
  const { data: acuses } = await (supabase
    .from('evidencias_firma' as string) as ReturnType<typeof supabase.from>)
    .select('acuse_storage_key, solicitudes_firma!inner(contrato_id, estado, firmado_en)')
    .eq('solicitudes_firma.contrato_id', contrato.id)
    .eq('solicitudes_firma.estado', 'firmado')
    .not('acuse_storage_key', 'is', null);

  const acuseKeys = ((acuses || []) as Array<{ acuse_storage_key: string | null; solicitudes_firma: { firmado_en: string } | null }>)
    .filter((a) => !!a.acuse_storage_key)
    // Orden por fecha de firma para que los acuses queden en orden temporal.
    .sort((a, b) => {
      const ta = a.solicitudes_firma?.firmado_en || '';
      const tb = b.solicitudes_firma?.firmado_en || '';
      return ta.localeCompare(tb);
    })
    .map((a) => a.acuse_storage_key as string);

  if (acuseKeys.length === 0) {
    // No hay acuses listos todavia (race con el fire-and-forget del
    // generateAndStoreAcuse). Caller usara el PDF original.
    return null;
  }

  // 2. Descargar contrato original + cada acuse en paralelo.
  const [contratoRes, ...acusesRes] = await Promise.all([
    supabase.storage.from(BUCKET_NAME).download(contrato.storage_key),
    ...acuseKeys.map((k) => supabase.storage.from(BUCKET_NAME).download(k)),
  ]);

  if (contratoRes.error || !contratoRes.data) {
    logger.error(
      { contratoId: contrato.id, err: contratoRes.error?.message },
      'No se pudo descargar el PDF original para mergear',
    );
    return null;
  }

  const contratoBuffer = Buffer.from(await contratoRes.data.arrayBuffer());
  const acuseBuffers: Buffer[] = [];
  for (const r of acusesRes) {
    if (r.error || !r.data) continue;
    acuseBuffers.push(Buffer.from(await r.data.arrayBuffer()));
  }

  if (acuseBuffers.length === 0) {
    return null;
  }

  // 3. Mergear contrato + acuses.
  const merged = await mergePdfs([contratoBuffer, ...acuseBuffers]);

  // 4. Subir como firmado y cachear referencia en contratos.firmado_storage_key.
  const firmadoKey = `contratos/${contrato.expediente_id}/${contrato.id}/firmado-combinado.pdf`;
  const nombreArchivo = (contrato.nombre_archivo || `contrato-${contrato.id}`).replace(/\.pdf$/i, '') + '-firmado.pdf';

  const { error: upErr } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(firmadoKey, merged, {
      contentType: 'application/pdf',
      upsert: true,
    });
  if (upErr) {
    logger.error({ contratoId: contrato.id, err: upErr.message }, 'Error subiendo firmado combinado');
    return null;
  }

  const hash = crypto.createHash('sha256').update(merged).digest('hex');
  await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .update({
      firmado_storage_key: firmadoKey,
      firmado_nombre_archivo: nombreArchivo,
      firmado_hash_integridad: hash,
      firmado_tamano_bytes: merged.length,
      firmado_subido_en: new Date().toISOString(),
    } as never)
    .eq('id', contrato.id);

  logger.info(
    { contratoId: contrato.id, acusesIncluidos: acuseBuffers.length, tamanoBytes: merged.length },
    'Firmado combinado generado y cacheado',
  );

  return { storageKey: firmadoKey, nombreArchivo };
}

// ============================================================
// Descargar contrato firmado
// ============================================================

export async function descargarContratoFirmado(
  contratoId: string,
  userId: string,
  userRol: string,
  ip?: string,
  userAgent?: string,
) {
  const contrato = await fetchContratoFirmado(contratoId);

  // Determinar de donde sale el PDF:
  //   1. firmado_storage_key (alguien subio el PDF estampado por separado,
  //      o lo generamos previamente al combinar contrato + acuses).
  //   2. Si no existe pero el contrato esta firmado/vigente y tiene
  //      acuses de firma electronica, los combinamos al vuelo con el PDF
  //      original y cacheamos el resultado en firmado_storage_key.
  //   3. Fallback: PDF original solo (sin acuse).
  let usarStorageKey: string | null = contrato.firmado_storage_key;
  let nombreArchivo =
    contrato.firmado_nombre_archivo ||
    contrato.nombre_archivo ||
    'contrato-firmado.pdf';

  if (!usarStorageKey && ESTADOS_CON_FIRMADO.includes(contrato.estado) && contrato.storage_key) {
    // Intentar generar PDF combinado: contrato original + acuses de cada
    // firma. Si falla o no hay acuses, caemos al PDF original.
    const generado = await generarFirmadoCombinado(contrato).catch((err) => {
      logger.warn(
        { contratoId, err: err instanceof Error ? err.message : String(err) },
        'Generar PDF firmado combinado: error — fallback al PDF original',
      );
      return null;
    });
    if (generado?.storageKey) {
      usarStorageKey = generado.storageKey;
      nombreArchivo = generado.nombreArchivo;
    } else {
      usarStorageKey = contrato.storage_key;
    }
  }

  if (!usarStorageKey) {
    throw AppError.notFound('El contrato no tiene documento firmado', 'NO_FIRMADO');
  }

  // Verificar permisos de descarga
  if (userRol === 'gerencia_consulta') {
    throw AppError.forbidden(
      'No tiene permiso para descargar el contrato firmado',
      'DOWNLOAD_FORBIDDEN',
    );
  }

  // Admin y operador_analista siempre pueden descargar
  // Para propietario/inmobiliaria/solicitante: verificar vinculacion
  if (userRol !== 'administrador' && userRol !== 'operador_analista') {
    const { data: expediente, error: expError } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id, solicitante_id, inmuebles(propietario_id), solicitantes(creado_por)')
      .eq('id', contrato.expediente_id)
      .single();

    if (expError || !expediente) {
      throw AppError.forbidden('No tiene permiso para descargar este contrato firmado', 'DOWNLOAD_FORBIDDEN');
    }

    const exp = expediente as unknown as {
      id: string;
      solicitante_id: string | null;
      inmuebles: { propietario_id: string | null } | null;
      solicitantes: { creado_por: string | null } | null;
    };

    const isArrendador = exp.inmuebles?.propietario_id === userId;
    // El solicitante.id es UUID interno; quien firmo el JWT es el
    // perfil cuyo id == solicitantes.creado_por en flujo self-service.
    const isArrendatario =
      exp.solicitante_id === userId || exp.solicitantes?.creado_por === userId;

    if (!isArrendatario && !isArrendador) {
      throw AppError.forbidden('No tiene permiso para descargar este contrato firmado', 'DOWNLOAD_FORBIDDEN');
    }
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
  await registrarAcceso(contratoId, userId, 'descarga', ip, userAgent);

  // Audit log
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_FIRMADO_DOWNLOADED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: { nombre_archivo: contrato.firmado_nombre_archivo },
    ip,
  });

  return {
    url: urlData.signedUrl,
    nombre_archivo: contrato.firmado_nombre_archivo || 'contrato-firmado.pdf',
    tipo_mime: 'application/pdf',
    expires_in: FIRMADO_URL_EXPIRY_SECONDS,
  };
}

// ============================================================
// Info firma (metadatos)
// ============================================================

export async function getInfoFirma(contratoId: string) {
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id,
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

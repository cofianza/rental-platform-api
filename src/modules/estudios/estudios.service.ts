import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendEstudioFormEmail } from '@/lib/email';
import { env } from '@/config';
import type { CreateEstudioInput, ListEstudiosQuery, ListAllEstudiosQuery, SubmitFormularioInput, RegistrarResultadoInput, CertificadoPresignedUrlInput } from './estudios.schema';
import { getProvider, getAllProviderIds } from './providers/factory';
import { maskDocumento } from './providers/mock.provider';
import type { ProviderSolicitudInput, ProviderHealthInfo } from './providers/types';

// ============================================================
// Constants
// ============================================================

const TOKEN_EXPIRY_HOURS = 72;
const ESTADOS_TERMINALES_EXPEDIENTE = ['cerrado', 'rechazado'];
const ESTADOS_ESTUDIO_FINALIZADOS = ['completado', 'fallido', 'cancelado'];
const ESTADOS_PERMITIDOS_RESULTADO = ['solicitado', 'en_proceso'];
const ESTADOS_PERMITIDOS_EJECUCION = ['formulario_completado', 'documentos_cargados'];
const BUCKET_NAME = 'documentos-expedientes';

// ============================================================
// List estudios for expediente
// ============================================================

export async function listEstudios(expedienteId: string, query: ListEstudiosQuery) {
  // Verify expediente exists
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  const page = query.page;
  const limit = query.limit;
  const offset = (page - 1) * limit;

  // Count total
  const { count } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .eq('expediente_id', expedienteId);

  const total = count || 0;

  // Fetch estudios
  const { data, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, tipo, proveedor, estado, resultado, score, observaciones,
      motivo_rechazo, condiciones,
      duracion_contrato_meses, pago_por, fecha_solicitud, fecha_completado,
      referencia_proveedor, certificado_url, created_at, updated_at,
      solicitado_por:perfiles!estudios_solicitado_por_fkey(id, nombre, apellido)
    `)
    .eq('expediente_id', expedienteId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error({ error, expedienteId }, 'Error al listar estudios');
    throw AppError.badRequest('Error al obtener estudios', 'ESTUDIOS_LIST_ERROR');
  }

  return {
    estudios: data || [],
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ============================================================
// List all estudios (global)
// ============================================================

export async function listAllEstudios(query: ListAllEstudiosQuery) {
  const page = query.page;
  const limit = query.limit;
  const offset = (page - 1) * limit;

  // Build base query for count
  let countQuery = (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true });

  // Build base query for data
  let dataQuery = (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, tipo, proveedor, estado, resultado, score, observaciones,
      motivo_rechazo, condiciones,
      duracion_contrato_meses, pago_por, fecha_solicitud, fecha_completado,
      referencia_proveedor, certificado_url, created_at, updated_at,
      expediente_id,
      solicitado_por:perfiles!estudios_solicitado_por_fkey(id, nombre, apellido),
      expedientes!estudios_expediente_id_fkey(
        numero,
        solicitantes!expedientes_solicitante_id_fkey(nombre, apellido)
      )
    `);

  // Apply filters to both queries
  if (query.estado) {
    const estados = query.estado.split(',').map((s) => s.trim()).filter(Boolean);
    if (estados.length > 0) {
      countQuery = countQuery.in('estado', estados);
      dataQuery = dataQuery.in('estado', estados);
    }
  }

  if (query.resultado) {
    countQuery = countQuery.eq('resultado', query.resultado);
    dataQuery = dataQuery.eq('resultado', query.resultado);
  }

  if (query.proveedor) {
    countQuery = countQuery.eq('proveedor', query.proveedor);
    dataQuery = dataQuery.eq('proveedor', query.proveedor);
  }

  if (query.fecha_desde) {
    countQuery = countQuery.gte('created_at', `${query.fecha_desde}T00:00:00`);
    dataQuery = dataQuery.gte('created_at', `${query.fecha_desde}T00:00:00`);
  }

  if (query.fecha_hasta) {
    countQuery = countQuery.lte('created_at', `${query.fecha_hasta}T23:59:59`);
    dataQuery = dataQuery.lte('created_at', `${query.fecha_hasta}T23:59:59`);
  }

  // Count
  const { count } = await countQuery;
  const total = count || 0;

  // Apply sort and pagination
  const ascending = query.sortOrder === 'asc';
  dataQuery = dataQuery.order(query.sortBy, { ascending }).range(offset, offset + limit - 1);

  const { data, error } = await dataQuery;

  if (error) {
    logger.error({ error }, 'Error al listar todos los estudios');
    throw AppError.badRequest('Error al obtener estudios', 'ESTUDIOS_LIST_ERROR');
  }

  // If search filter, do in-memory filtering on joined data
  let filteredData = data || [];
  if (query.search) {
    const searchLower = query.search.toLowerCase();
    filteredData = filteredData.filter((item: Record<string, unknown>) => {
      const exp = item.expedientes as { numero?: string; solicitantes?: { nombre?: string; apellido?: string } } | null;
      const numero = exp?.numero || '';
      const nombre = exp?.solicitantes?.nombre || '';
      const apellido = exp?.solicitantes?.apellido || '';
      const proveedor = (item.proveedor as string) || '';
      return (
        numero.toLowerCase().includes(searchLower) ||
        `${nombre} ${apellido}`.toLowerCase().includes(searchLower) ||
        proveedor.toLowerCase().includes(searchLower)
      );
    });
  }

  return {
    estudios: filteredData,
    pagination: {
      total: query.search ? filteredData.length : total,
      page,
      limit,
      totalPages: Math.ceil((query.search ? filteredData.length : total) / limit),
    },
  };
}

// ============================================================
// Get estudio by ID
// ============================================================

export async function getEstudioById(estudioId: string) {
  const { data, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, expediente_id, tipo, proveedor, estado, resultado, score,
      observaciones, motivo_rechazo, condiciones,
      duracion_contrato_meses, pago_por, fecha_solicitud,
      fecha_completado, fecha_completado_self_service, referencia_proveedor,
      certificado_url, codigo_qr, datos_formulario, token_self_service,
      expiracion_token, created_at, updated_at,
      solicitado_por:perfiles!estudios_solicitado_por_fkey(id, nombre, apellido)
    `)
    .eq('id', estudioId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  return data;
}

// ============================================================
// Create estudio
// ============================================================

export async function createEstudio(
  expedienteId: string,
  input: CreateEstudioInput,
  userId: string,
  ip?: string,
) {
  // 1. Verify expediente exists and get inmueble_id
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, inmueble_id')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  const exp = expediente as unknown as { id: string; estado: string; inmueble_id: string };

  if (ESTADOS_TERMINALES_EXPEDIENTE.includes(exp.estado)) {
    throw AppError.badRequest(
      'No se puede crear un estudio en un expediente cerrado o rechazado',
      'EXPEDIENTE_ESTADO_INVALIDO',
    );
  }

  // 2. Verify inmueble is not already "en_estudio"
  const { data: inmueble, error: inmError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('id', exp.inmueble_id)
    .single();

  if (inmError || !inmueble) {
    throw AppError.badRequest('Inmueble no encontrado', 'INMUEBLE_NOT_FOUND');
  }

  const inm = inmueble as unknown as { id: string; estado: string };

  if (inm.estado === 'en_estudio') {
    throw AppError.conflict(
      'El inmueble ya tiene un estudio en proceso. Debe finalizar o cancelar el estudio actual.',
      'INMUEBLE_EN_ESTUDIO',
    );
  }

  // 3. Verify no active estudio exists for this expediente
  const { data: activeEstudio } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .not('estado', 'in', `(${ESTADOS_ESTUDIO_FINALIZADOS.join(',')})`)
    .limit(1)
    .maybeSingle();

  if (activeEstudio) {
    throw AppError.conflict(
      'Ya existe un estudio activo para este expediente',
      'ESTUDIO_ACTIVO_EXISTENTE',
    );
  }

  // 4. Insert estudio
  const { data: estudio, error: insertError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: input.tipo,
      proveedor: input.proveedor,
      estado: 'solicitado',
      resultado: 'pendiente',
      duracion_contrato_meses: input.duracion_contrato_meses,
      pago_por: input.pago_por,
      observaciones: input.observaciones || null,
      solicitado_por: userId,
    } as never)
    .select('id')
    .single();

  if (insertError || !estudio) {
    logger.error({ error: insertError, expedienteId }, 'Error al crear estudio');
    throw AppError.badRequest('Error al crear el estudio', 'ESTUDIO_CREATE_ERROR');
  }

  const estudioId = (estudio as unknown as { id: string }).id;

  // 5. Update inmueble estado to 'en_estudio'
  await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'en_estudio' } as never)
    .eq('id', exp.inmueble_id);

  // 6. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_CREATED,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: estudioId,
    detalle: {
      expediente_id: expedienteId,
      tipo: input.tipo,
      proveedor: input.proveedor,
      duracion_contrato_meses: input.duracion_contrato_meses,
      pago_por: input.pago_por,
    },
    ip,
  });

  return getEstudioById(estudioId);
}

// ============================================================
// Cancel estudio
// ============================================================

export async function cancelEstudio(estudioId: string, userId: string, ip?: string) {
  // 1. Get estudio
  const { data: estudio, error: getError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, expediente_id')
    .eq('id', estudioId)
    .single();

  if (getError || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as { id: string; estado: string; expediente_id: string };

  if (ESTADOS_ESTUDIO_FINALIZADOS.includes(est.estado)) {
    throw AppError.badRequest(
      'Este estudio ya fue finalizado y no se puede cancelar',
      'ESTUDIO_YA_FINALIZADO',
    );
  }

  // 2. Update estado to cancelado
  const { error: updateError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'cancelado' } as never)
    .eq('id', estudioId);

  if (updateError) {
    logger.error({ error: updateError, estudioId }, 'Error al cancelar estudio');
    throw AppError.badRequest('Error al cancelar el estudio', 'ESTUDIO_CANCEL_ERROR');
  }

  // 3. Revert inmueble to 'disponible'
  const { data: expediente } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('inmueble_id')
    .eq('id', est.expediente_id)
    .single();

  if (expediente) {
    const exp = expediente as unknown as { inmueble_id: string };
    await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'disponible' } as never)
      .eq('id', exp.inmueble_id);
  }

  // 4. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_CANCELLED,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: estudioId,
    detalle: { expediente_id: est.expediente_id },
    ip,
  });

  return getEstudioById(estudioId);
}

// ============================================================
// Send self-service link
// ============================================================

export async function sendSelfServiceLink(estudioId: string, userId: string, ip?: string) {
  // 1. Get estudio with expediente + solicitante
  const { data: estudio, error: getError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, expediente_id')
    .eq('id', estudioId)
    .single();

  if (getError || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as { id: string; estado: string; expediente_id: string };

  if (ESTADOS_ESTUDIO_FINALIZADOS.includes(est.estado)) {
    throw AppError.badRequest(
      'No se puede enviar enlace para un estudio finalizado',
      'ESTUDIO_YA_FINALIZADO',
    );
  }

  // 2. Get solicitante email from expediente
  const { data: expediente } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('solicitante_id, solicitantes!expedientes_solicitante_id_fkey(nombre, apellido, email)')
    .eq('id', est.expediente_id)
    .single();

  if (!expediente) {
    throw AppError.badRequest('No se pudo obtener datos del solicitante', 'SOLICITANTE_NOT_FOUND');
  }

  const exp = expediente as unknown as {
    solicitante_id: string;
    solicitantes: { nombre: string; apellido: string; email: string };
  };

  if (!exp.solicitantes?.email) {
    throw AppError.badRequest(
      'El solicitante no tiene email registrado',
      'SOLICITANTE_SIN_EMAIL',
    );
  }

  // 3. Generate token
  const token = crypto.randomBytes(32).toString('hex');
  const expiration = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

  // 4. Update estudio with token
  const { error: updateError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .update({
      token_self_service: token,
      expiracion_token: expiration.toISOString(),
      estado: 'formulario_enviado',
    } as never)
    .eq('id', estudioId);

  if (updateError) {
    logger.error({ error: updateError, estudioId }, 'Error al generar token self-service');
    throw AppError.badRequest('Error al generar enlace', 'TOKEN_GENERATION_ERROR');
  }

  // 5. Build URL and send email
  const formUrl = `${env.FRONTEND_URL}/estudio/${token}`;
  const nombreCompleto = `${exp.solicitantes.nombre} ${exp.solicitantes.apellido}`;

  await sendEstudioFormEmail(exp.solicitantes.email, nombreCompleto, formUrl, TOKEN_EXPIRY_HOURS);

  // 6. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_LINK_SENT,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: estudioId,
    detalle: {
      email: exp.solicitantes.email,
      expiration: expiration.toISOString(),
    },
    ip,
  });

  return {
    estudio: await getEstudioById(estudioId),
    enlace_enviado: true,
    email_destino: exp.solicitantes.email,
  };
}

// ============================================================
// Get public form data (by token)
// ============================================================

export async function getFormularioByToken(token: string) {
  const { data, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, tipo, proveedor, estado, expiracion_token, datos_formulario,
      expediente_id,
      expedientes!estudios_expediente_id_fkey(
        numero,
        inmuebles!expedientes_inmueble_id_fkey(direccion, ciudad, departamento),
        solicitantes!expedientes_solicitante_id_fkey(nombre, apellido)
      )
    `)
    .eq('token_self_service', token)
    .single();

  if (error || !data) {
    throw AppError.notFound('Enlace invalido o expirado', 'TOKEN_INVALIDO');
  }

  const estudio = data as unknown as {
    id: string;
    tipo: string;
    proveedor: string;
    estado: string;
    expiracion_token: string;
    datos_formulario: Record<string, unknown> | null;
    expedientes: {
      numero: string;
      inmuebles: { direccion: string; ciudad: string; departamento: string };
      solicitantes: { nombre: string; apellido: string };
    };
  };

  // Verify not expired
  if (new Date(estudio.expiracion_token) < new Date()) {
    throw AppError.badRequest(
      'Este enlace ha expirado. Solicite uno nuevo al operador.',
      'TOKEN_EXPIRADO',
    );
  }

  // Verify estado allows form submission
  if (estudio.estado === 'formulario_completado' || ESTADOS_ESTUDIO_FINALIZADOS.includes(estudio.estado)) {
    throw AppError.badRequest(
      'Este formulario ya fue completado o el estudio fue finalizado.',
      'FORMULARIO_YA_COMPLETADO',
    );
  }

  return {
    estudio_id: estudio.id,
    tipo_estudio: estudio.tipo,
    proveedor: estudio.proveedor,
    expediente_numero: estudio.expedientes.numero,
    inmueble_direccion: estudio.expedientes.inmuebles?.direccion || '',
    inmueble_ciudad: estudio.expedientes.inmuebles?.ciudad || '',
    solicitante_nombre: `${estudio.expedientes.solicitantes?.nombre || ''} ${estudio.expedientes.solicitantes?.apellido || ''}`.trim(),
    ya_completado: estudio.datos_formulario !== null,
  };
}

// ============================================================
// Submit public form
// ============================================================

export async function submitFormulario(token: string, input: SubmitFormularioInput) {
  // Validate token (reuse getFormularioByToken for validation)
  const formData = await getFormularioByToken(token);

  if (formData.ya_completado) {
    throw AppError.badRequest(
      'Este formulario ya fue completado anteriormente.',
      'FORMULARIO_YA_COMPLETADO',
    );
  }

  // Update estudio with form data
  const { error: updateError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .update({
      datos_formulario: input as unknown as never,
      estado: 'formulario_completado',
      fecha_completado_self_service: new Date().toISOString(),
    } as never)
    .eq('token_self_service', token);

  if (updateError) {
    logger.error({ error: updateError, token: token.substring(0, 8) }, 'Error al guardar formulario');
    throw AppError.badRequest('Error al enviar el formulario', 'FORMULARIO_SUBMIT_ERROR');
  }

  // Audit (no userId since this is public)
  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.ESTUDIO_FORM_SUBMITTED,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: formData.estudio_id,
    detalle: { nombre: input.nombre_completo, email: input.email },
  });

  return { message: 'Formulario enviado correctamente. Gracias por completar la informacion.' };
}

// ============================================================
// Register resultado (irreversible)
// ============================================================

export async function registrarResultado(
  estudioId: string,
  input: RegistrarResultadoInput,
  userId: string,
  ip?: string,
) {
  // 1. Get estudio — verify exists, estado, and resultado still pendiente
  const { data: estudio, error: getError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, resultado, expediente_id')
    .eq('id', estudioId)
    .single();

  if (getError || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as {
    id: string;
    estado: string;
    resultado: string;
    expediente_id: string;
  };

  if (!ESTADOS_PERMITIDOS_RESULTADO.includes(est.estado)) {
    throw AppError.badRequest(
      `Solo se puede registrar resultado en estudios en estado: ${ESTADOS_PERMITIDOS_RESULTADO.join(', ')}. Estado actual: ${est.estado}`,
      'ESTUDIO_ESTADO_INVALIDO',
    );
  }

  if (est.resultado !== 'pendiente') {
    throw AppError.conflict(
      'Este estudio ya tiene un resultado registrado y no puede modificarse',
      'RESULTADO_YA_REGISTRADO',
    );
  }

  // 2. If certificado_storage_key provided, verify it exists in storage
  if (input.certificado_storage_key) {
    const { error: storageError } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(input.certificado_storage_key, 60);

    if (storageError) {
      throw AppError.badRequest(
        'El archivo de certificado no se encontro en el almacenamiento. Suba el archivo primero.',
        'CERTIFICADO_NOT_FOUND',
      );
    }
  }

  // 3. Build update payload
  const updatePayload: Record<string, unknown> = {
    resultado: input.resultado,
    observaciones: input.observaciones,
    estado: 'completado',
    fecha_completado: new Date().toISOString(),
  };

  if (input.score !== undefined) updatePayload.score = input.score;
  if (input.motivo_rechazo) updatePayload.motivo_rechazo = input.motivo_rechazo;
  if (input.condiciones) updatePayload.condiciones = input.condiciones;
  if (input.certificado_storage_key) updatePayload.certificado_url = input.certificado_storage_key;

  // 4. Update estudio
  const { error: updateError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .update(updatePayload as never)
    .eq('id', estudioId);

  if (updateError) {
    logger.error({ error: updateError, estudioId }, 'Error al registrar resultado del estudio');
    throw AppError.badRequest('Error al registrar el resultado', 'RESULTADO_UPDATE_ERROR');
  }

  // 5. Revert inmueble to 'disponible' (study is done)
  const { data: expediente } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('inmueble_id')
    .eq('id', est.expediente_id)
    .single();

  if (expediente) {
    const exp = expediente as unknown as { inmueble_id: string };
    await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'disponible' } as never)
      .eq('id', exp.inmueble_id);
  }

  // 6. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_RESULTADO_REGISTERED,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: estudioId,
    detalle: {
      resultado: input.resultado,
      score: input.score,
      has_certificado: !!input.certificado_storage_key,
      expediente_id: est.expediente_id,
    },
    ip,
  });

  return getEstudioById(estudioId);
}

// ============================================================
// Get presigned URL for certificado upload
// ============================================================

export async function getCertificadoPresignedUrl(
  estudioId: string,
  input: CertificadoPresignedUrlInput,
) {
  // 1. Verify estudio exists and is eligible
  const { data: estudio, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, resultado')
    .eq('id', estudioId)
    .single();

  if (error || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as { id: string; estado: string; resultado: string };

  if (!ESTADOS_PERMITIDOS_RESULTADO.includes(est.estado)) {
    throw AppError.badRequest(
      'Solo se puede subir certificado para estudios activos',
      'ESTUDIO_ESTADO_INVALIDO',
    );
  }

  // 2. Validate PDF
  if (!input.nombre_original.toLowerCase().endsWith('.pdf')) {
    throw AppError.badRequest('El certificado debe ser un archivo PDF', 'MIME_TYPE_NOT_ALLOWED');
  }

  // 3. Generate storage key and signed upload URL
  const nombreArchivo = `${crypto.randomUUID()}.pdf`;
  const storageKey = `estudios/${estudioId}/certificado/${nombreArchivo}`;

  const { data: uploadData, error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUploadUrl(storageKey);

  if (uploadError || !uploadData) {
    logger.error({ error: uploadError?.message, storageKey }, 'Error al crear URL de subida para certificado');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de subida');
  }

  return {
    signedUrl: uploadData.signedUrl,
    storage_key: storageKey,
    nombre_archivo: nombreArchivo,
    expires_in: 900,
  };
}

// ============================================================
// Get signed view URL for certificado
// ============================================================

export async function getCertificadoViewUrl(estudioId: string) {
  const { data: estudio, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, certificado_url')
    .eq('id', estudioId)
    .single();

  if (error || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as { id: string; certificado_url: string | null };

  if (!est.certificado_url) {
    throw AppError.notFound('Este estudio no tiene certificado adjunto', 'CERTIFICADO_NOT_FOUND');
  }

  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(est.certificado_url, 3600);

  if (urlError || !urlData) {
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL del certificado');
  }

  return {
    url: urlData.signedUrl,
    expires_in: 3600,
  };
}

// ============================================================
// Execute estudio via provider
// ============================================================

export async function ejecutarEstudio(estudioId: string, userId: string, ip?: string) {
  // 1. Get estudio
  const { data: estudio, error: getError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, resultado, proveedor, tipo, datos_formulario, expediente_id')
    .eq('id', estudioId)
    .single();

  if (getError || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as {
    id: string;
    estado: string;
    resultado: string;
    proveedor: string;
    tipo: string;
    datos_formulario: Record<string, unknown> | null;
    expediente_id: string;
  };

  // 2. Validate estado
  if (!ESTADOS_PERMITIDOS_EJECUCION.includes(est.estado)) {
    throw AppError.badRequest(
      `Solo se puede ejecutar via proveedor en estados: ${ESTADOS_PERMITIDOS_EJECUCION.join(', ')}. Estado actual: ${est.estado}`,
      'ESTUDIO_ESTADO_INVALIDO',
    );
  }

  // 3. Validate datos_formulario exists
  if (!est.datos_formulario) {
    throw AppError.badRequest(
      'El estudio no tiene datos de formulario. El solicitante debe completar el formulario primero.',
      'FORMULARIO_NO_COMPLETADO',
    );
  }

  const datos = est.datos_formulario as Record<string, string>;

  // 4. Build provider input
  const providerInput: ProviderSolicitudInput = {
    estudio_id: est.id,
    tipo: est.tipo as 'individual' | 'con_coarrendatario',
    nombre_completo: datos.nombre_completo || '',
    tipo_documento: datos.tipo_documento || '',
    numero_documento: datos.numero_documento || '',
    email: datos.email || '',
    telefono: datos.telefono || '',
    ingresos_mensuales: datos.ingresos_mensuales ? Number(datos.ingresos_mensuales) : undefined,
    ocupacion: (datos.ocupacion as string) || undefined,
    empresa: (datos.empresa as string) || undefined,
    direccion_residencia: (datos.direccion_residencia as string) || undefined,
  };

  // 5. Call provider
  const provider = getProvider(est.proveedor as 'transunion' | 'sifin' | 'datacredito');

  logger.info(
    { estudioId, provider: est.proveedor, documento: maskDocumento(providerInput.numero_documento) },
    'Executing credit risk study via provider',
  );

  try {
    const response = await provider.solicitar(providerInput);

    // 6. Update estudio on success
    await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({
        estado: 'en_proceso',
        referencia_proveedor: response.referencia_proveedor,
      } as never)
      .eq('id', estudioId);

    logAudit({
      usuarioId: userId,
      accion: AUDIT_ACTIONS.ESTUDIO_PROVIDER_EXECUTED,
      entidad: AUDIT_ENTITIES.ESTUDIO,
      entidadId: estudioId,
      detalle: {
        proveedor: est.proveedor,
        referencia_proveedor: response.referencia_proveedor,
        expediente_id: est.expediente_id,
      },
      ip,
    });

    return getEstudioById(estudioId);
  } catch (err) {
    // 7. On failure: mark as fallido
    const errorMsg = err instanceof Error ? err.message : 'Error desconocido del proveedor';

    await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({
        estado: 'fallido',
        observaciones: `Error de proveedor (${est.proveedor}): ${errorMsg}. Puede registrar el resultado manualmente.`,
      } as never)
      .eq('id', estudioId);

    logAudit({
      usuarioId: userId,
      accion: AUDIT_ACTIONS.ESTUDIO_PROVIDER_FAILED,
      entidad: AUDIT_ENTITIES.ESTUDIO,
      entidadId: estudioId,
      detalle: {
        proveedor: est.proveedor,
        error: errorMsg,
        expediente_id: est.expediente_id,
      },
      ip,
    });

    logger.error(
      { estudioId, provider: est.proveedor, error: errorMsg },
      'Provider execution failed',
    );

    throw AppError.badRequest(
      `El proveedor ${est.proveedor} fallo al ejecutar el estudio: ${errorMsg}. El estudio fue marcado como fallido. Puede registrar el resultado manualmente.`,
      'PROVIDER_EXECUTION_FAILED',
    );
  }
}

// ============================================================
// Check provider status and auto-register result if completed
// ============================================================

export async function consultarEstadoProveedor(estudioId: string) {
  // 1. Get estudio
  const { data: estudio, error: getError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, proveedor, referencia_proveedor, expediente_id')
    .eq('id', estudioId)
    .single();

  if (getError || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as {
    id: string;
    estado: string;
    proveedor: string;
    referencia_proveedor: string | null;
    expediente_id: string;
  };

  if (!est.referencia_proveedor) {
    throw AppError.badRequest(
      'Este estudio no ha sido enviado a un proveedor. No tiene referencia de proveedor.',
      'SIN_REFERENCIA_PROVEEDOR',
    );
  }

  // 2. Query provider
  const provider = getProvider(est.proveedor as 'transunion' | 'sifin' | 'datacredito');
  const statusResponse = await provider.consultarEstado(est.referencia_proveedor);

  // 3. If completed, auto-register result
  if (statusResponse.status === 'completed' && est.estado !== 'completado') {
    const result = await provider.obtenerResultado(est.referencia_proveedor);

    const updatePayload: Record<string, unknown> = {
      estado: 'completado',
      resultado: result.resultado,
      score: result.score,
      observaciones: result.observaciones,
      fecha_completado: new Date().toISOString(),
    };

    await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update(updatePayload as never)
      .eq('id', estudioId);

    // Revert inmueble to disponible
    const { data: expediente } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('inmueble_id')
      .eq('id', est.expediente_id)
      .single();

    if (expediente) {
      const exp = expediente as unknown as { inmueble_id: string };
      await (supabase
        .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'disponible' } as never)
        .eq('id', exp.inmueble_id);
    }

    logAudit({
      usuarioId: null,
      accion: AUDIT_ACTIONS.ESTUDIO_PROVIDER_RESULT_RECEIVED,
      entidad: AUDIT_ENTITIES.ESTUDIO,
      entidadId: estudioId,
      detalle: {
        proveedor: est.proveedor,
        resultado: result.resultado,
        score: result.score,
        referencia_proveedor: est.referencia_proveedor,
      },
    });

    return {
      provider_status: statusResponse,
      estudio: await getEstudioById(estudioId),
    };
  }

  // 4. If failed, mark as fallido
  if (statusResponse.status === 'failed' && est.estado !== 'fallido') {
    await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({
        estado: 'fallido',
        observaciones: `Proveedor reporto fallo: ${statusResponse.mensaje || 'Sin detalle'}. Puede registrar el resultado manualmente.`,
      } as never)
      .eq('id', estudioId);
  }

  return {
    provider_status: statusResponse,
    estudio: await getEstudioById(estudioId),
  };
}

// ============================================================
// Provider health check
// ============================================================

export async function getProviderHealth(): Promise<ProviderHealthInfo[]> {
  const providerIds = getAllProviderIds();

  const results = await Promise.allSettled(
    providerIds.map((id) => getProvider(id).verificarDisponibilidad()),
  );

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    return {
      proveedor: providerIds[index],
      disponible: false,
      latencia_ms: null,
      ultimo_error: result.reason instanceof Error ? result.reason.message : 'Error desconocido',
      timestamp: new Date().toISOString(),
    };
  });
}

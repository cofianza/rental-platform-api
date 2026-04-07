import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendEstudioFormEmail } from '@/lib/email';
import { env } from '@/config';
import type { CreateEstudioInput, CreateEstudioFromInmuebleInput, ListEstudiosQuery, ListAllEstudiosQuery, SubmitFormularioInput, RegistrarResultadoInput, CertificadoPresignedUrlInput, SoportePresignedUrlInput, ConfirmarSoporteInput, ReEvaluarInput } from './estudios.schema';
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
  const sortBy = query.sortBy || 'created_at';
  const ascending = (query.sortOrder || 'desc') === 'asc';
  dataQuery = dataQuery.order(sortBy, { ascending }).range(offset, offset + limit - 1);

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

// Documentos minimos requeridos para crear un estudio (codigos de tipos_documento)
const DOCUMENTOS_MINIMOS_REQUERIDOS = ['id_frontal', 'comprobante_ingresos'];

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

  // 2. Verify no active estudio exists for this expediente
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

  // 3. Verify autorizacion habeas data exists and is active
  const { data: autorizacion } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .eq('estado', 'autorizado')
    .is('fecha_revocacion', null)
    .limit(1)
    .maybeSingle();

  if (!autorizacion) {
    throw AppError.badRequest(
      'Se requiere autorizacion habeas data firmada antes de crear un estudio',
      'AUTORIZACION_HABEAS_REQUERIDA',
    );
  }

  const autorizacionId = (autorizacion as unknown as { id: string }).id;

  // 4. Verify documentos minimos (cedula + comprobante de ingresos)
  // Join tipos_documento to check by codigo (the old `tipo` enum column is deprecated)
  const { data: documentos } = await (supabase
    .from('documentos' as string) as ReturnType<typeof supabase.from>)
    .select('tipo_documento:tipos_documento!documentos_tipo_documento_id_fkey(codigo)')
    .eq('expediente_id', expedienteId)
    .eq('estado', 'aprobado');

  const tiposPresentes = (documentos ?? []).map(
    (d: unknown) => ((d as { tipo_documento: { codigo: string } }).tipo_documento?.codigo),
  ).filter(Boolean);
  const tiposFaltantes = DOCUMENTOS_MINIMOS_REQUERIDOS.filter((t) => !tiposPresentes.includes(t));

  if (tiposFaltantes.length > 0) {
    throw AppError.badRequest(
      `Documentos minimos faltantes: ${tiposFaltantes.join(', ')}. Se requiere al menos ID frontal aprobado y comprobante de ingresos aprobado.`,
      'DOCUMENTOS_MINIMOS_FALTANTES',
    );
  }

  // 5. Atomic: insert estudio + update inmueble via RPC
  const { data: estudioId, error: rpcError } = await (supabase as any).rpc('fn_crear_estudio', {
    p_expediente_id: expedienteId,
    p_inmueble_id: exp.inmueble_id,
    p_tipo: input.tipo,
    p_proveedor: input.proveedor,
    p_duracion_contrato_meses: input.duracion_contrato_meses,
    p_pago_por: input.pago_por,
    p_observaciones: input.observaciones || null,
    p_solicitado_por: userId,
    p_autorizacion_habeas_data_id: autorizacionId,
  });

  if (rpcError) {
    logger.error({ error: rpcError.message, expedienteId }, 'Error al crear estudio (RPC)');
    if (rpcError.message?.includes('en_estudio') || rpcError.message?.includes('estudio en proceso')) {
      throw AppError.conflict(
        'El inmueble ya tiene un estudio en proceso. Debe finalizar o cancelar el estudio actual.',
        'INMUEBLE_EN_ESTUDIO',
      );
    }
    throw AppError.badRequest('Error al crear el estudio', 'ESTUDIO_CREATE_ERROR');
  }

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
// Create estudio from inmueble (auto-creates expediente)
// ============================================================

export async function createEstudioFromInmueble(
  inmuebleId: string,
  input: CreateEstudioFromInmuebleInput,
  userId: string,
  ip?: string,
) {
  // Atomic: create expediente + estudio + update inmueble via RPC
  const { data, error: rpcError } = await (supabase as any).rpc('fn_crear_estudio_desde_inmueble', {
    p_inmueble_id: inmuebleId,
    p_solicitante_id: input.solicitante_id,
    p_tipo: input.tipo,
    p_proveedor: input.proveedor,
    p_duracion_contrato_meses: input.duracion_contrato_meses,
    p_pago_por: input.pago_por,
    p_observaciones: input.observaciones || null,
    p_solicitado_por: userId,
  });

  if (rpcError) {
    logger.error({ error: rpcError.message, inmuebleId }, 'Error al crear estudio desde inmueble (RPC)');
    if (rpcError.message?.includes('no encontrado')) {
      const entity = rpcError.message.includes('Inmueble') ? 'Inmueble' : 'Solicitante';
      throw AppError.notFound(`${entity} no encontrado`, `${entity.toUpperCase()}_NOT_FOUND`);
    }
    if (rpcError.message?.includes('en_estudio') || rpcError.message?.includes('estudio en proceso')) {
      throw AppError.conflict(
        'El inmueble ya tiene un estudio en proceso. Debe finalizar o cancelar el estudio actual.',
        'INMUEBLE_EN_ESTUDIO',
      );
    }
    throw AppError.badRequest('Error al crear el estudio', 'ESTUDIO_CREATE_ERROR');
  }

  const result = data as { expediente_id: string; estudio_id: string };

  // Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_CREATED,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: result.estudio_id,
    detalle: {
      inmueble_id: inmuebleId,
      expediente_id: result.expediente_id,
      tipo: input.tipo,
      proveedor: input.proveedor,
      duracion_contrato_meses: input.duracion_contrato_meses,
      pago_por: input.pago_por,
      auto_expediente: true,
    },
    ip,
  });

  return getEstudioById(result.estudio_id);
}

// ============================================================
// Cancel estudio
// ============================================================

export async function cancelEstudio(estudioId: string, userId: string, ip?: string) {
  // Atomic: cancel estudio + revert inmueble via RPC
  // RPC validates estado === 'solicitado' and handles row locking
  const { error: rpcError } = await (supabase as any).rpc('fn_cancelar_estudio', {
    p_estudio_id: estudioId,
  });

  if (rpcError) {
    logger.error({ error: rpcError.message, estudioId }, 'Error al cancelar estudio (RPC)');
    if (rpcError.message?.includes('no encontrado')) {
      throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
    }
    if (rpcError.message?.includes('No se puede cancelar')) {
      throw AppError.badRequest(
        'No se puede cancelar un estudio que ya fue completado, cancelado o fallido',
        'ESTUDIO_ESTADO_INVALIDO',
      );
    }
    throw AppError.badRequest('Error al cancelar el estudio', 'ESTUDIO_CANCEL_ERROR');
  }

  // Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_CANCELLED,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: estudioId,
    detalle: {},
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

  // Don't allow resending if form was already completed
  if (est.estado === 'formulario_completado') {
    throw AppError.badRequest(
      'El formulario ya fue completado por el solicitante. No se puede reenviar el enlace.',
      'FORMULARIO_YA_COMPLETADO',
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

  const yaCompletado =
    estudio.estado === 'formulario_completado' ||
    ESTADOS_ESTUDIO_FINALIZADOS.includes(estudio.estado) ||
    estudio.datos_formulario !== null;

  return {
    estudio_id: estudio.id,
    tipo_estudio: estudio.tipo,
    proveedor: estudio.proveedor,
    expediente_numero: estudio.expedientes.numero,
    inmueble_direccion: estudio.expedientes.inmuebles?.direccion || '',
    inmueble_ciudad: estudio.expedientes.inmuebles?.ciudad || '',
    solicitante_nombre: `${estudio.expedientes.solicitantes?.nombre || ''} ${estudio.expedientes.solicitantes?.apellido || ''}`.trim(),
    ya_completado: yaCompletado,
    datos_formulario: yaCompletado ? estudio.datos_formulario : null,
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

  // 3. Atomic RPC: update estudio + revert inmueble + insert timeline event
  const { error: rpcError } = await (supabase as any).rpc('fn_registrar_resultado_estudio', {
    p_estudio_id: estudioId,
    p_resultado: input.resultado,
    p_observaciones: input.observaciones,
    p_score: input.score ?? null,
    p_motivo_rechazo: input.motivo_rechazo ?? null,
    p_condiciones: input.condiciones ?? null,
    p_certificado_url: input.certificado_storage_key ?? null,
    p_usuario_id: userId,
  });

  if (rpcError) {
    logger.error({ error: rpcError, estudioId }, 'Error al registrar resultado del estudio');
    if (rpcError.message?.includes('ya tiene un resultado')) {
      throw AppError.conflict(rpcError.message, 'RESULTADO_YA_REGISTRADO');
    }
    if (rpcError.message?.includes('Solo se puede registrar')) {
      throw AppError.badRequest(rpcError.message, 'ESTUDIO_ESTADO_INVALIDO');
    }
    throw AppError.badRequest('Error al registrar el resultado', 'RESULTADO_UPDATE_ERROR');
  }

  // 4. Audit
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
    const { error: updateError } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({
        estado: 'en_proceso',
        referencia_proveedor: response.referencia_proveedor,
      } as never)
      .eq('id', estudioId);

    if (updateError) {
      logger.error({ error: updateError, estudioId }, 'Error al actualizar estudio tras solicitud a proveedor');
      throw AppError.badRequest('Error al actualizar el estudio tras enviar al proveedor', 'ESTUDIO_UPDATE_ERROR');
    }

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

    const { error: failError } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({
        estado: 'fallido',
        observaciones: `Error de proveedor (${est.proveedor}): ${errorMsg}. Puede registrar el resultado manualmente.`,
      } as never)
      .eq('id', estudioId);

    if (failError) {
      logger.error({ error: failError, estudioId }, 'Error al marcar estudio como fallido');
    }

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
// Re-evaluacion: get presigned URL for soporte upload
// ============================================================

const RESULTADOS_REEVALUABLES = ['rechazado', 'condicionado'];
const MAX_REEVALUACIONES = 2;

function getExtensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
  };
  return map[mimeType] || 'bin';
}

export async function getSoportePresignedUrl(
  estudioId: string,
  input: SoportePresignedUrlInput,
) {
  // 1. Validate estudio exists and is eligible for re-evaluation
  const { data: estudio, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, resultado')
    .eq('id', estudioId)
    .single();

  if (error || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as { id: string; estado: string; resultado: string };

  if (est.estado !== 'completado' || !RESULTADOS_REEVALUABLES.includes(est.resultado)) {
    throw AppError.badRequest(
      'Solo se pueden subir documentos soporte para estudios completados con resultado rechazado o condicionado',
      'ESTUDIO_NO_REEVALUABLE',
    );
  }

  // 2. Generate storage key
  const ext = getExtensionFromMime(input.tipo_mime);
  const nombreArchivo = `${crypto.randomUUID()}.${ext}`;
  const storageKey = `estudios/${estudioId}/soporte/${nombreArchivo}`;

  // 3. Create signed upload URL
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUploadUrl(storageKey);

  if (uploadError || !uploadData) {
    logger.error({ error: uploadError?.message, storageKey }, 'Error al crear URL de subida para soporte');
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
// Re-evaluacion: confirm soporte upload
// ============================================================

export async function confirmarSoporteUpload(
  estudioId: string,
  input: ConfirmarSoporteInput,
  userId: string,
  ip?: string,
) {
  // 1. Re-validate eligibility (race-condition guard)
  const { data: estudio, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, resultado')
    .eq('id', estudioId)
    .single();

  if (error || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as { id: string; estado: string; resultado: string };

  if (est.estado !== 'completado' || !RESULTADOS_REEVALUABLES.includes(est.resultado)) {
    throw AppError.badRequest(
      'Solo se pueden subir documentos soporte para estudios rechazados o condicionados',
      'ESTUDIO_NO_REEVALUABLE',
    );
  }

  // 2. Verify file exists in storage
  const { error: storageError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(input.storage_key, 60);

  if (storageError) {
    throw AppError.badRequest(
      'El archivo no se encontro en el almacenamiento. Suba el archivo primero.',
      'ARCHIVO_NOT_FOUND',
    );
  }

  // 3. Insert record
  const { data: doc, error: insertError } = await (supabase
    .from('estudios_documentos_soporte' as string) as ReturnType<typeof supabase.from>)
    .insert({
      estudio_id: estudioId,
      storage_key: input.storage_key,
      nombre_original: input.nombre_original,
      tipo_mime: input.tipo_mime,
      tamano_bytes: input.tamano_bytes,
      proposito: input.proposito,
      subido_por: userId,
    } as never)
    .select('*')
    .single();

  if (insertError || !doc) {
    logger.error({ error: insertError, estudioId }, 'Error al confirmar soporte');
    throw AppError.badRequest('Error al registrar el documento soporte', 'SOPORTE_CONFIRM_ERROR');
  }

  // 4. Generate view URL (1h)
  const { data: urlData } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(input.storage_key, 3600);

  // 5. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_SOPORTE_UPLOADED,
    entidad: AUDIT_ENTITIES.DOCUMENTO_SOPORTE,
    entidadId: (doc as unknown as { id: string }).id,
    detalle: {
      estudio_id: estudioId,
      nombre_original: input.nombre_original,
      proposito: input.proposito,
    },
    ip,
  });

  return {
    ...(doc as unknown as Record<string, unknown>),
    archivo_url: urlData?.signedUrl || null,
  };
}

// ============================================================
// Re-evaluacion: solicitar re-evaluacion
// ============================================================

export async function solicitarReEvaluacion(
  estudioId: string,
  input: ReEvaluarInput,
  userId: string,
  ip?: string,
) {
  // 1. Validate estudio completado + rechazado/condicionado
  const { data: estudio, error: getError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, resultado, tipo, proveedor, expediente_id, duracion_contrato_meses, pago_por, estudio_padre_id')
    .eq('id', estudioId)
    .single();

  if (getError || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as {
    id: string; estado: string; resultado: string;
    tipo: string; proveedor: string; expediente_id: string;
    duracion_contrato_meses: number; pago_por: string;
    estudio_padre_id: string | null;
  };

  if (est.estado !== 'completado' || !RESULTADOS_REEVALUABLES.includes(est.resultado)) {
    throw AppError.badRequest(
      'Solo se puede solicitar re-evaluacion para estudios completados con resultado rechazado o condicionado',
      'ESTUDIO_NO_REEVALUABLE',
    );
  }

  // 2. Verify at least 1 soporte doc exists
  const { count: soporteCount } = await (supabase
    .from('estudios_documentos_soporte' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .eq('estudio_id', estudioId);

  if (!soporteCount || soporteCount === 0) {
    throw AppError.badRequest(
      'Debe subir al menos un documento soporte antes de solicitar re-evaluacion',
      'SOPORTE_REQUERIDO',
    );
  }

  // 3. Determine depth in chain (walk up via estudio_padre_id) — max 2
  let depth = 0;
  let currentId: string | null = est.estudio_padre_id;
  while (currentId) {
    depth++;
    const { data: parent } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select('estudio_padre_id')
      .eq('id', currentId)
      .single();
    currentId = parent ? (parent as unknown as { estudio_padre_id: string | null }).estudio_padre_id : null;
  }

  // depth is how many ancestors exist. Total chain = depth + 1 (original) + 1 (this new one)
  // We allow max MAX_REEVALUACIONES re-evaluations total, meaning depth + 1 <= MAX_REEVALUACIONES
  if (depth + 1 > MAX_REEVALUACIONES) {
    throw AppError.badRequest(
      `Se ha alcanzado el maximo de ${MAX_REEVALUACIONES} re-evaluaciones permitidas`,
      'MAX_REEVALUACIONES',
    );
  }

  // 4. Verify no child re-evaluation already exists for this estudio
  const { data: existingChild } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('estudio_padre_id', estudioId)
    .limit(1)
    .maybeSingle();

  if (existingChild) {
    throw AppError.conflict(
      'Ya existe una re-evaluacion para este estudio',
      'REEVALUACION_YA_EXISTENTE',
    );
  }

  // 5. Insert new estudio inheriting key fields
  const { data: newEstudio, error: insertError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: est.expediente_id,
      tipo: est.tipo,
      proveedor: est.proveedor,
      estado: 'solicitado',
      resultado: 'pendiente',
      duracion_contrato_meses: est.duracion_contrato_meses,
      pago_por: est.pago_por,
      observaciones: input.observaciones || null,
      solicitado_por: userId,
      estudio_padre_id: estudioId,
    } as never)
    .select('id')
    .single();

  if (insertError || !newEstudio) {
    logger.error({ error: insertError, estudioId }, 'Error al crear re-evaluacion');
    throw AppError.badRequest('Error al solicitar re-evaluacion', 'REEVALUACION_CREATE_ERROR');
  }

  const newId = (newEstudio as unknown as { id: string }).id;

  // 6. Insert timeline event
  const { error: timelineError } = await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: est.expediente_id,
      tipo: 'estudio',
      descripcion: `Re-evaluación de estudio solicitada (${depth + 1} de ${MAX_REEVALUACIONES})`,
      usuario_id: userId,
      metadata: {
        estudio_id: newId,
        estudio_padre_id: estudioId,
        numero_reevaluacion: depth + 1,
      },
    } as never);

  if (timelineError) {
    logger.error({ error: timelineError, estudioId: newId }, 'Error al insertar evento timeline de re-evaluacion');
  }

  // 7. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_REEVALUACION_SOLICITADA,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: newId,
    detalle: {
      estudio_padre_id: estudioId,
      expediente_id: est.expediente_id,
      numero_reevaluacion: depth + 1,
    },
    ip,
  });

  return getEstudioById(newId);
}

// ============================================================
// Re-evaluacion: get historial
// ============================================================

export async function getHistorialReEvaluacion(estudioId: string) {
  // 1. Walk up to find root (the one without estudio_padre_id)
  let rootId = estudioId;
  let currentId: string | null = estudioId;

  while (currentId) {
    const { data: estudio } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select('id, estudio_padre_id')
      .eq('id', currentId)
      .single();

    if (!estudio) break;

    const est = estudio as unknown as { id: string; estudio_padre_id: string | null };
    if (!est.estudio_padre_id) {
      rootId = est.id;
      break;
    }
    rootId = est.estudio_padre_id;
    currentId = est.estudio_padre_id;
  }

  // 2. Get all estudios in chain: root + all descendants
  const { data: allEstudios, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, expediente_id, tipo, proveedor, estado, resultado, score,
      observaciones, motivo_rechazo, condiciones,
      duracion_contrato_meses, pago_por, fecha_solicitud,
      fecha_completado, referencia_proveedor, certificado_url,
      estudio_padre_id, created_at, updated_at,
      solicitado_por:perfiles!estudios_solicitado_por_fkey(id, nombre, apellido)
    `)
    .or(`id.eq.${rootId},estudio_padre_id.eq.${rootId}`)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ error, estudioId }, 'Error al obtener historial de re-evaluacion');
    throw AppError.badRequest('Error al obtener historial', 'HISTORIAL_ERROR');
  }

  // For deeper chains (> 2 levels), also fetch grandchildren
  let estudiosChain = allEstudios || [];
  const childIds = estudiosChain
    .filter((e: Record<string, unknown>) => (e as unknown as { estudio_padre_id: string | null }).estudio_padre_id === rootId)
    .map((e: Record<string, unknown>) => (e as unknown as { id: string }).id);

  if (childIds.length > 0) {
    const { data: grandchildren } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select(`
        id, expediente_id, tipo, proveedor, estado, resultado, score,
        observaciones, motivo_rechazo, condiciones,
        duracion_contrato_meses, pago_por, fecha_solicitud,
        fecha_completado, referencia_proveedor, certificado_url,
        estudio_padre_id, created_at, updated_at,
        solicitado_por:perfiles!estudios_solicitado_por_fkey(id, nombre, apellido)
      `)
      .in('estudio_padre_id', childIds)
      .order('created_at', { ascending: true });

    if (grandchildren && grandchildren.length > 0) {
      estudiosChain = [...estudiosChain, ...grandchildren];
    }
  }

  // 3. Fetch docs soporte for each estudio
  const estudioIds = estudiosChain.map((e: Record<string, unknown>) => (e as unknown as { id: string }).id);

  const { data: allDocs } = await (supabase
    .from('estudios_documentos_soporte' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .in('estudio_id', estudioIds)
    .order('created_at', { ascending: true });

  const docsByEstudio = new Map<string, Array<Record<string, unknown>>>();
  if (allDocs) {
    for (const doc of allDocs) {
      const d = doc as unknown as { estudio_id: string };
      if (!docsByEstudio.has(d.estudio_id)) {
        docsByEstudio.set(d.estudio_id, []);
      }
      docsByEstudio.get(d.estudio_id)!.push(doc as Record<string, unknown>);
    }
  }

  // 4. Build ordered historial
  const historial = estudiosChain.map((e: Record<string, unknown>, index: number) => {
    const est = e as unknown as { id: string; estudio_padre_id: string | null };
    return {
      ...e,
      numero_en_cadena: index + 1,
      es_reevaluacion: est.estudio_padre_id !== null,
      documentos_soporte: docsByEstudio.get(est.id) || [],
    };
  });

  // 5. Determine if can re-evaluate
  const lastEstudio = estudiosChain[estudiosChain.length - 1] as unknown as { estado: string; resultado: string } | undefined;
  const totalEnCadena = estudiosChain.length;
  const puedeReevaluar =
    totalEnCadena <= MAX_REEVALUACIONES &&
    lastEstudio?.estado === 'completado' &&
    RESULTADOS_REEVALUABLES.includes(lastEstudio.resultado);

  return {
    total_en_cadena: totalEnCadena,
    puede_reevaluar: puedeReevaluar,
    historial,
  };
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

  // 3. If completed, auto-register result atomically via RPC
  if (statusResponse.status === 'completed' && est.estado !== 'completado') {
    const result = await provider.obtenerResultado(est.referencia_proveedor);

    const { error: rpcError } = await (supabase as any).rpc('fn_registrar_resultado_estudio', {
      p_estudio_id: estudioId,
      p_resultado: result.resultado,
      p_observaciones: result.observaciones || 'Resultado recibido del proveedor',
      p_score: result.score ?? null,
      p_motivo_rechazo: null,
      p_condiciones: null,
      p_certificado_url: null,
      p_usuario_id: null,
    });

    if (rpcError) {
      logger.error({ error: rpcError, estudioId }, 'Error al registrar resultado del proveedor via RPC');
      throw AppError.badRequest('Error al registrar el resultado del proveedor', 'PROVIDER_RESULT_ERROR');
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

    // Orchestrator: disparar flujo automatico segun resultado
    import('@/modules/orchestrator/orchestrator.service')
      .then(({ onEstudioCompletado }) =>
        onEstudioCompletado({
          estudioId,
          expedienteId: est.expediente_id,
          resultado: result.resultado,
          score: result.score,
          solicitanteId: '', // se resuelve dentro del orquestador via expediente
        }),
      )
      .catch((err) => logger.warn({ error: err }, 'Orchestrator: error en hook post-estudio'));

    return {
      provider_status: statusResponse,
      estudio: await getEstudioById(estudioId),
    };
  }

  // 4. If failed, mark as fallido
  if (statusResponse.status === 'failed' && est.estado !== 'fallido') {
    const { error: failError } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({
        estado: 'fallido',
        observaciones: `Proveedor reporto fallo: ${statusResponse.mensaje || 'Sin detalle'}. Puede registrar el resultado manualmente.`,
      } as never)
      .eq('id', estudioId);

    if (failError) {
      logger.error({ error: failError, estudioId }, 'Error al marcar estudio como fallido tras consulta a proveedor');
    }
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

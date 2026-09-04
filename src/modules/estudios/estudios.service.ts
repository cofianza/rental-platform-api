import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendEstudioFormEmail } from '@/lib/email';
import { env } from '@/config';
import { getCompany } from '@/lib/companyConfig';
import type { CreateEstudioInput, CreateEstudioFromInmuebleInput, ListEstudiosQuery, ListAllEstudiosQuery, SubmitFormularioInput, RegistrarResultadoInput, CertificadoPresignedUrlInput, SoportePresignedUrlInput, ConfirmarSoporteInput, ReEvaluarInput } from './estudios.schema';
import { getProvider, getAllProviderIds } from './providers/factory';
import { maskDocumento } from './providers/mock.provider';
import type { ProviderSolicitudInput, ProviderHealthInfo, ProviderResult } from './providers/types';
import { notificarUsuario, findPerfilIdByEmail } from '../notificaciones/notificaciones.service';
import { enviarTemplate as enviarTemplateWhatsApp } from '../whatsapp';
import { resolveAllowedExpedienteIds, perfilEsDuenoDeInmueble, assertExpedienteAccess } from '@/lib/tenantScope';
// Motor de scorecard V4.1. Sigue en SOMBRA para todo el scorecard (puntajes,
// umbrales 85/70, resto de reglas duras): calcula y guarda en paralelo lo que
// la politica HABRIA decidido. registrarScorecardSombra es best-effort y no
// lanza — borrarlo no cambiaria ningun resultado.
import { registrarScorecardSombra } from './motor/sombra.service';
// LA EXCEPCION, autorizada por Gerencia el 2026-09-03: las dos reglas duras
// de la Politica V4.1 que YA deciden — DTI > 65% (§4.2) y canon/ingreso > 40%
// (§4.3). resolverResultadoEstudio es el punto UNICO por el que pasan los tres
// caminos que llaman a fn_registrar_resultado_estudio, y corre ANTES del RPC.
// Tampoco lanza: ante cualquier fallo devuelve el resultado del proveedor.
import {
  resolverResultadoEstudio,
  registrarReglaDuraActivada,
  motivoParaProspectoDesdeMotivoGestor,
} from './reglas-duras';
import type { VeredictoReglasDuras } from './reglas-duras';
import { assertAutorizacionVigente, AUTORIZACION_PREVIA_ERROR_CODE } from './autorizacion.guard';
// Tope de canon (flujo §4.4). Va ANTES del gate de autorizacion previa y antes
// de cualquier cobro: ver la nota de ORDEN en tope-canon.guard.ts.
import { assertCanonDentroDelTope, leerCanonDelInmueble } from './tope-canon.guard';
// Gate de PAGO (§6.3) + la señal canonica de "este estudio ya se cobro".
import {
  leerSenalPagoEstudio,
  senalIndicaPagado,
  assertPagoEstudio,
  estudioYaCobrado,
  ESTADO_ESPERANDO_PAGO,
} from './pago.guard';
// Estudios simultaneos por inmueble (Flujo §4.2). De aqui salen la definicion
// canonica de "estudio en curso" y el unico bloqueo que queda: la reserva.
import { errorNoAdmision, ESTADOS_ESTUDIO_FINALES } from './estudios-simultaneos.guard';

// ============================================================
// Constants
// ============================================================

const TOKEN_EXPIRY_HOURS = 72;
const ESTADOS_TERMINALES_EXPEDIENTE = ['cerrado', 'rechazado'];
// Misma lista que el guard de estudios simultaneos: una sola definicion de
// "estudio finalizado" para el indicador del §4.2 y para el limite de un
// estudio activo POR EXPEDIENTE (que sigue vigente y no lo toca el cambio).
const ESTADOS_ESTUDIO_FINALIZADOS: readonly string[] = ESTADOS_ESTUDIO_FINALES;
const ESTADOS_PERMITIDOS_RESULTADO = ['solicitado', 'en_proceso'];
// 'fallido' tambien se permite para que el solicitante pueda reintentar tras
// un error transitorio del proveedor (caida de TransUnion, doc invalido en el
// primer intento, etc). El estudio sigue siendo el mismo registro — no se
// crea uno nuevo — solo se vuelve a ejecutar la consulta.
const ESTADOS_PERMITIDOS_EJECUCION = ['formulario_completado', 'documentos_cargados', 'fallido'];

/**
 * Señal de pago del estudio. La lectura, las dos politicas (fail-open para el
 * tope §4.4, fail-closed para el gate de dinero) y la decision de orden del
 * §6.3 viven en pago.guard.ts — aqui solo se consumen.
 *
 * `estudioYaCobrado` sigue siendo el interruptor entre BLOQUEAR y ADVERTIR en
 * el tope de canon: la regla de Gerencia prohibe COBRAR un estudio sobre un
 * inmueble fuera de tope, no dejar sin entregar uno ya pagado. Los caminos
 * post-cobro (reintento de un 'fallido', re-consulta al otro buro,
 * re-evaluacion con soportes) tienen que poder terminar. NO es el gate de
 * pago: ese es `assertPagoEstudio`, que falla CERRADO.
 */

// Nombre legible de cada buró — se usa en las observaciones que ve el gestor.
// Con dos proveedores activos ya no se puede hardcodear "TransUnion".
const BURO_LABELS: Record<string, string> = {
  transunion: 'TransUnion',
  datacredito: 'DataCrédito',
  sifin: 'SIFIN',
};
const BUCKET_NAME = 'documentos-expedientes';

// ============================================================
// Separacion de audiencias en la RESPUESTA (Politica §2 y §11)
// ============================================================

/**
 * `estudios.motivo_rechazo` y `estudios.observaciones` son campos de GESTOR.
 * Desde que las reglas duras V4.1 deciden, `motivo_rechazo` no es texto libre:
 * lleva deterministicamente el DTI real, el ingreso inferido, la cuota, los
 * umbrales 65/40 y la version del modelo, y `observaciones` la misma nota en
 * corto.
 *
 * Y ese JSON SI llega al prospecto: el rol 'solicitante' tiene expedientes:read
 * y GET /expedientes/:id/estudios es exactamente lo que consulta su propia
 * tarjeta en cada poll. Que ninguna pantalla suya lo pinte no protege nada —
 * con DevTools, o con cualquier cliente HTTP y su propio token, lo lee. La
 * Politica §2 ("sin revelar los parametros internos del modelo") y §11
 * ("Cofianza no esta obligada a revelar los parametros internos del modelo ni
 * los puntajes especificos por variable") lo prohiben.
 *
 * Por eso la separacion se hace aqui, en el servicio, junto al guard de tenant
 * que ya corre — no en el render:
 *   - `motivo_rechazo` -> el motivo GENERAL del Flujo §10 cuando el rechazo fue
 *     por regla dura (asi la tarjeta del solicitante puede al fin decirle la
 *     causa correcta), y null en cualquier otro caso.
 *   - `observaciones`  -> null.
 *
 * No se toca nada para los demas roles: el gestor necesita el detalle.
 */
function redactarEstudioParaProspecto<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    motivo_rechazo: motivoParaProspectoDesdeMotivoGestor(
      (row.motivo_rechazo as string | null | undefined) ?? null,
    ),
    observaciones: null,
  };
}

/** No-op salvo para el rol 'solicitante' (el prospecto mirando lo suyo). */
function redactarEstudiosSegunRol<T extends Record<string, unknown>>(
  rows: T[],
  userRol?: string,
): T[] {
  if (userRol !== 'solicitante') return rows;
  return rows.map(redactarEstudioParaProspecto);
}

// ============================================================
// List estudios for expediente
// ============================================================

export async function listEstudios(
  expedienteId: string,
  query: ListEstudiosQuery,
  userId?: string,
  userRol?: string,
) {
  // Verify expediente exists
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  // Tenant guard: propietario/inmobiliaria/solicitante solo listan los estudios
  // de expedientes de su cartera. Sin esto, cualquier rol con expedientes:read
  // enumeraba los estudios de OTRA agencia por expedienteId (IDOR).
  await assertExpedienteAccess(expedienteId, userId, userRol);

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
      referencia_proveedor, certificado_url, datos_formulario,
      created_at, updated_at,
      canon_evaluado, canon_evaluado_origen,
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
    estudios: redactarEstudiosSegunRol(
      (data || []) as unknown as Record<string, unknown>[],
      userRol,
    ),
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

// Scoping por rol propietario/inmobiliaria centralizado en @/lib/tenantScope
// (resolveAllowedExpedienteIds). El scoping va en SQL, no en post-filtro, para
// que la paginación y el total sean reales.

export async function listAllEstudios(
  query: ListAllEstudiosQuery,
  userId?: string,
  userRol?: string,
) {
  const page = query.page;
  const limit = query.limit;
  const offset = (page - 1) * limit;

  // Scoping propietario/inmobiliaria: solo estudios de sus expedientes.
  const allowedExpedienteIds = await resolveAllowedExpedienteIds(userId, userRol);
  if (allowedExpedienteIds !== null && allowedExpedienteIds.length === 0) {
    return {
      estudios: [],
      pagination: { total: 0, page, limit, totalPages: 0 },
    };
  }

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
        inmueble_id,
        solicitantes!expedientes_solicitante_id_fkey(nombre, apellido)
      )
    `);

  if (allowedExpedienteIds !== null) {
    countQuery = countQuery.in('expediente_id', allowedExpedienteIds);
    dataQuery = dataQuery.in('expediente_id', allowedExpedienteIds);
  }

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

  // Sort + paginación al dataQuery ANTES de lanzar ambos en PARALELO: count y
  // data son independientes (antes iban en serie = 2 round-trips secuenciales).
  const sortBy = query.sortBy || 'created_at';
  const ascending = (query.sortOrder || 'desc') === 'asc';
  dataQuery = dataQuery.order(sortBy, { ascending }).range(offset, offset + limit - 1);

  const [{ count }, { data, error }] = await Promise.all([countQuery, dataQuery]);
  const total = count || 0;

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
    estudios: redactarEstudiosSegunRol(
      filteredData as unknown as Record<string, unknown>[],
      userRol,
    ),
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

// ============================================================
// Stats globales para los KPI cards del listado de estudios.
// Devuelve counts por estado/resultado en una sola query. La pagina
// /estudios los pinta arriba del listado (mockup Mario 12-may-2026:
// Este mes, Aprobados, En proceso, Rechazados).
// ============================================================
export interface EstudiosStats {
  total: number;
  este_mes: number;
  aprobados: number;
  rechazados: number;
  condicionados: number;
  en_proceso: number;
  pendientes: number;
  completados: number;
  // Breakdown crudo por estado/resultado por si la UI quiere mas granularidad.
  por_estado: Record<string, number>;
  por_resultado: Record<string, number>;
}

export async function getEstudiosStats(
  userId?: string,
  userRol?: string,
): Promise<EstudiosStats> {
  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);

  // Scoping propietario/inmobiliaria: sin esto, los contadores mostraban
  // datos GLOBALES de la plataforma a cuentas externas (fuga cross-tenant).
  const allowedExpedienteIds = await resolveAllowedExpedienteIds(userId, userRol);
  if (allowedExpedienteIds !== null && allowedExpedienteIds.length === 0) {
    return {
      total: 0, este_mes: 0, aprobados: 0, rechazados: 0, condicionados: 0,
      en_proceso: 0, pendientes: 0, completados: 0, por_estado: {}, por_resultado: {},
    };
  }

  // Una sola query con SELECT amplio + agregacion local. La tabla
  // estudios es pequena (~cientos en QA), no escala bien si llega a
  // millones — en ese caso pasamos a count(*) con GROUP BY via RPC.
  let statsQuery = (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('estado, resultado, created_at');
  if (allowedExpedienteIds !== null) {
    statsQuery = statsQuery.in('expediente_id', allowedExpedienteIds);
  }
  const { data, error } = await statsQuery;

  if (error) {
    logger.error({ error: error.message }, 'Error al obtener stats de estudios');
    throw AppError.badRequest('Error al obtener estadisticas de estudios', 'STATS_ERROR');
  }

  const rows = (data as Array<{ estado: string; resultado: string | null; created_at: string }>) || [];
  const por_estado: Record<string, number> = {};
  const por_resultado: Record<string, number> = {};
  let este_mes = 0;

  for (const r of rows) {
    por_estado[r.estado] = (por_estado[r.estado] ?? 0) + 1;
    if (r.resultado) {
      por_resultado[r.resultado] = (por_resultado[r.resultado] ?? 0) + 1;
    }
    if (new Date(r.created_at) >= inicioMes) este_mes++;
  }

  return {
    total: rows.length,
    este_mes,
    aprobados: por_resultado.aprobado ?? 0,
    rechazados: por_resultado.rechazado ?? 0,
    condicionados: por_resultado.condicionado ?? 0,
    en_proceso: por_estado.en_proceso ?? 0,
    pendientes: por_estado.solicitado ?? 0,
    completados: por_estado.completado ?? 0,
    por_estado,
    por_resultado,
  };
}

export async function getEstudioById(estudioId: string, userId?: string, userRol?: string) {
  const { data, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, expediente_id, tipo, proveedor, estado, resultado, score,
      observaciones, motivo_rechazo, condiciones,
      duracion_contrato_meses, pago_por, fecha_solicitud,
      fecha_completado, fecha_completado_self_service, referencia_proveedor,
      certificado_url, codigo_qr, datos_formulario, respuesta_proveedor,
      token_self_service,
      expiracion_token, created_at, updated_at,
      canon_evaluado, canon_evaluado_origen,
      solicitado_por:perfiles!estudios_solicitado_por_fkey(id, nombre, apellido)
    `)
    .eq('id', estudioId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  // Tenant guard: el detalle expone datos_formulario, respuesta_proveedor (crudo
  // del buró) y token_self_service. Sin scoping, un rol externo con
  // expedientes:read leía el estudio de OTRA agencia por UUID (IDOR). No-op para
  // roles internos y para llamadas internas sin identidad (userId/userRol undefined).
  await assertExpedienteAccess((data as { expediente_id: string }).expediente_id, userId, userRol);

  // Mismo criterio que en los listados: al prospecto no le viajan ni el motivo
  // con cifras ni las observaciones del gestor.
  if (userRol === 'solicitante') {
    return redactarEstudioParaProspecto(data as unknown as Record<string, unknown>);
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
  userRol?: string,
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

  // Tenant guard: la inmobiliaria (único rol externo con expedientes:update) solo
  // crea estudios sobre expedientes de su cartera — sin esto podría adjuntar un
  // estudio a un expediente de OTRA agencia por UUID (write-IDOR).
  await assertExpedienteAccess(expedienteId, userId, userRol);

  const exp = expediente as unknown as { id: string; estado: string; inmueble_id: string };

  if (ESTADOS_TERMINALES_EXPEDIENTE.includes(exp.estado)) {
    throw AppError.badRequest(
      'No se puede crear un estudio en un expediente cerrado o rechazado',
      'EXPEDIENTE_ESTADO_INVALIDO',
    );
  }

  // 1.5. Tope de canon (flujo §4.4). Va antes que las validaciones de
  //      documentos y que el RPC: si el inmueble excede el tope el estudio no
  //      debe nacer, y el gestor tiene que leer ESO y no "te faltan documentos".
  await assertCanonDentroDelTope({ expedienteId, origen: 'createEstudio' });

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

  // 3. Verify autorizacion habeas data exists and is active.
  //    Filtrada POR SUJETO: desde 2026-09-03 el co-arrendatario tiene su propia
  //    fila con el MISMO expediente_id, asi que buscar solo por expediente
  //    podia enlazar el estudio del TITULAR a la autorizacion de otra persona —
  //    justo el vinculo "evidencia asociada al estudio" que exige el 8.4.
  const { data: autorizacion } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .eq('estado', 'autorizado')
    .is('fecha_revocacion', null)
    .order('created_at', { ascending: false })
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // Flujo §4.2: tener otros estudios en curso ya NO bloquea — varios
    // candidatos se evaluan en paralelo. El unico bloqueo por inmueble que
    // queda es que la propiedad este reservada por un candidato aprobado que
    // avanzo al contrato (o arrendada/inactiva).
    if (rpcError.message?.includes('INMUEBLE_RESERVADO')) {
      throw errorNoAdmision({
        admite: false,
        motivo: rpcError.message.includes('inactivo') ? 'inactivo' : 'reservado',
        reservadoPorExpedienteId: null,
      });
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
  userRol?: string,
) {
  // Tenant guard: la inmobiliaria/propietario solo crea estudios (auto-creando
  // el expediente) sobre inmuebles que administra. El expediente aún no existe,
  // así que el scoping es a nivel INMUEBLE (mismo criterio que ejecutarEstudio).
  // Sin esto, un rol externo con expedientes:update adjuntaba un estudio +
  // expediente a un inmueble de OTRA agencia por UUID (write-IDOR). 404 para no
  // filtrar existencia cross-tenant. Roles internos pasan sin chequeo.
  if (userRol === 'inmobiliaria' || userRol === 'propietario') {
    const { data: inmRow } = await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .select('propietario_id, inmobiliaria_id')
      .eq('id', inmuebleId)
      .maybeSingle();
    const inm = inmRow as { propietario_id?: string | null; inmobiliaria_id?: string | null } | null;
    const esDueno = inm
      ? await perfilEsDuenoDeInmueble({
          userId,
          userRol,
          inmueblePropietarioId: inm.propietario_id,
          inmuebleInmobiliariaId: inm.inmobiliaria_id,
        })
      : false;
    if (!esDueno) {
      throw AppError.notFound('Inmueble no encontrado', 'INMUEBLE_NOT_FOUND');
    }
  }

  // Tope de canon (flujo §4.4). Aqui el expediente todavia no existe, asi que
  // se contrasta directo contra el inmueble — que es justamente el sujeto de la
  // regla ("al seleccionar la propiedad").
  await assertCanonDentroDelTope({ inmuebleId, origen: 'createEstudioFromInmueble' });

  // Atomic: create expediente + estudio + update inmueble via RPC
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // Flujo §4.2: tener otros estudios en curso ya NO bloquea — varios
    // candidatos se evaluan en paralelo. El unico bloqueo por inmueble que
    // queda es que la propiedad este reservada por un candidato aprobado que
    // avanzo al contrato (o arrendada/inactiva).
    if (rpcError.message?.includes('INMUEBLE_RESERVADO')) {
      throw errorNoAdmision({
        admite: false,
        motivo: rpcError.message.includes('inactivo') ? 'inactivo' : 'reservado',
        reservadoPorExpedienteId: null,
      });
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

export async function cancelEstudio(estudioId: string, userId: string, ip?: string, userRol?: string) {
  // Tenant guard: resolvemos el expediente del estudio y verificamos acceso antes
  // de cancelar. Sin esto, la inmobiliaria (rol externo con expedientes:update)
  // cancelaba estudios de OTRA agencia por UUID (write-IDOR); la RPC solo valida
  // el estado, no la pertenencia.
  const { data: estudioRow, error: estudioErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id')
    .eq('id', estudioId)
    .single();

  if (estudioErr || !estudioRow) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  await assertExpedienteAccess(
    (estudioRow as { expediente_id: string }).expediente_id,
    userId,
    userRol,
  );

  // Atomic: cancel estudio + revert inmueble via RPC
  // RPC validates estado === 'solicitado' and handles row locking
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

export async function sendSelfServiceLink(
  estudioId: string,
  userId: string,
  ip?: string,
  // Corrección del email del solicitante: si viene y difiere del guardado,
  // se persiste en `solicitantes` y el enlace se envía al corregido.
  emailOverride?: string,
  userRol?: string,
) {
  // 1. Get estudio with expediente + solicitante
  const { data: estudio, error: getError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, tipo, expediente_id')
    .eq('id', estudioId)
    .single();

  if (getError || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as { id: string; estado: string; tipo: string; expediente_id: string };

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

  // 2. Get solicitante email from expediente (+ inmueble para tenant guard)
  const { data: expediente } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('solicitante_id, inmuebles(propietario_id, inmobiliaria_id), solicitantes!expedientes_solicitante_id_fkey(nombre, apellido, email)')
    .eq('id', est.expediente_id)
    .single();

  if (!expediente) {
    throw AppError.badRequest('No se pudo obtener datos del solicitante', 'SOLICITANTE_NOT_FOUND');
  }

  const exp = expediente as unknown as {
    solicitante_id: string;
    inmuebles: { propietario_id: string | null; inmobiliaria_id: string | null } | null;
    solicitantes: { nombre: string; apellido: string; email: string };
  };

  // 2b. Tenant guard (mismo criterio que ejecutarEstudio): inmobiliaria/
  // propietario solo sobre estudios de inmuebles que administran — sin esto,
  // el override de email permitía reescribir el contacto de solicitantes
  // ajenos y desviar el enlace. Admin/operador pasan.
  if (userRol === 'inmobiliaria' || userRol === 'propietario') {
    const esDueno = await perfilEsDuenoDeInmueble({
      userId,
      userRol,
      inmueblePropietarioId: exp.inmuebles?.propietario_id ?? null,
      inmuebleInmobiliariaId: exp.inmuebles?.inmobiliaria_id ?? null,
    });
    if (!esDueno) {
      throw AppError.forbidden(
        'No tienes permisos para enviar el enlace de este estudio',
        'ESTUDIO_FORBIDDEN',
      );
    }
  }

  // Destino: el override (corregido por el gestor) o el registrado.
  const emailNorm = emailOverride?.trim().toLowerCase();
  const emailDestino = emailNorm || exp.solicitantes?.email;
  if (!emailDestino) {
    throw AppError.badRequest(
      'El solicitante no tiene email registrado',
      'SOLICITANTE_SIN_EMAIL',
    );
  }

  // Si el email cambió, sincronizarlo en `solicitantes` para que los envíos
  // futuros (autorización, pago, firma) también lleguen al correcto.
  // OJO: NO persistir para estudios 'con_coarrendatario' — la fila de
  // `solicitantes` es del TITULAR (mismo criterio que ejecutarEstudio); el
  // enlace igual se envía al override.
  if (
    est.tipo !== 'con_coarrendatario' &&
    emailNorm &&
    emailNorm !== (exp.solicitantes?.email ?? '').toLowerCase()
  ) {
    const { error: emailUpdError } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .update({ email: emailNorm } as never)
      .eq('id', exp.solicitante_id);
    if (emailUpdError) {
      logger.warn(
        { error: emailUpdError.message, estudioId, solicitanteId: exp.solicitante_id },
        'No se pudo actualizar el email del solicitante al enviar enlace (se envía igual al override)',
      );
    }
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

  await sendEstudioFormEmail(emailDestino, nombreCompleto, formUrl, TOKEN_EXPIRY_HOURS);

  // 6. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_LINK_SENT,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: estudioId,
    detalle: {
      email: emailDestino,
      expiration: expiration.toISOString(),
    },
    ip,
  });

  return {
    estudio: await getEstudioById(estudioId),
    enlace_enviado: true,
    email_destino: emailDestino,
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

  // Un estudio EN ESPERA DE PAGO (§6.3) no sale de esa espera por llenar el
  // formulario: este endpoint es público (token) y mandarlo a
  // 'formulario_completado' lo dejaría en un estado ejecutable antes de cobrar.
  // El único que lo despierta es la confirmación del pago (onEstudioPagado).
  const { data: estadoRow } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('estado')
    .eq('token_self_service', token)
    .maybeSingle();
  const enEsperaDePago = (estadoRow as { estado?: string } | null)?.estado === ESTADO_ESPERANDO_PAGO;

  // Update estudio with form data
  const { error: updateError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .update({
      datos_formulario: input as unknown as never,
      estado: enEsperaDePago ? ESTADO_ESPERANDO_PAGO : 'formulario_completado',
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
// Completar formulario desde flujo de onboarding (sin OTP+canvas)
//
// Usado por el orchestrator tras confirmar pago en expedientes cuyo
// `source ∈ {vitrina_publica, invitacion}`. El registro del solicitante deja
// `terminos_aceptaciones` (vitrina.service.registerSolicitante), pero eso NO
// sustituye la autorización habeas data: esa tabla no guarda el texto íntegro
// aceptado, ni su versión, ni el documento del aceptante, que es lo que exige
// el 8.4 del flujo. Desde 2026-09-03 estos flujos también pasan por el gate de
// autorización previa antes de consultar el buró; el enlace de autorización lo
// envía automáticamente orchestrator.onPagoConfirmado.
//
// Rellena `datos_formulario` desde la tabla `solicitantes`, avanza el
// estudio a `formulario_completado` y NO lo ejecuta — la ejecución la
// dispara el caller (orchestrator) para mantener separación de concerns.
// ============================================================

export async function completarFormularioDesdeOnboarding(params: {
  estudioId: string;
  expedienteId: string;
  solicitanteId: string;
  userId: string;
}): Promise<{ estudioId: string; yaCompletado: boolean }> {
  const { estudioId, expedienteId, solicitanteId, userId } = params;

  // 1. Fetch + validar estudio.
  const { data: estudioRow, error: estudioErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, proveedor, tipo, expediente_id')
    .eq('id', estudioId)
    .single();

  if (estudioErr || !estudioRow) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const estudio = estudioRow as unknown as {
    id: string;
    estado: string;
    proveedor: string;
    tipo: string;
    expediente_id: string;
  };

  if (ESTADOS_ESTUDIO_FINALIZADOS.includes(estudio.estado)) {
    throw AppError.badRequest(
      `Estudio en estado terminal (${estudio.estado}); no puede recompletarse.`,
      'ESTUDIO_ESTADO_INVALIDO',
    );
  }

  // Idempotencia: si ya avanzó, retornamos sin error.
  if (estudio.estado !== 'solicitado') {
    return { estudioId, yaCompletado: true };
  }

  // Ambos burós reales son síncronos y consumen datos_formulario igual;
  // manual/sifin siguen fuera (no ejecutables por provider).
  if (estudio.proveedor !== 'transunion' && estudio.proveedor !== 'datacredito') {
    throw AppError.badRequest(
      'Camino sin-OTP solo aplica a proveedores de buró (TransUnion / DataCrédito)',
      'PROVEEDOR_INVALIDO',
    );
  }

  // 2. Fetch solicitante.
  const { data: solicitanteRow, error: solErr } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre, apellido, email, telefono, tipo_documento, numero_documento, ocupacion, empresa, ingresos_mensuales, direccion')
    .eq('id', solicitanteId)
    .single();

  if (solErr || !solicitanteRow) {
    throw AppError.notFound('Solicitante no encontrado', 'SOLICITANTE_NOT_FOUND');
  }

  const solicitante = solicitanteRow as unknown as {
    id: string;
    nombre: string;
    apellido: string;
    email: string;
    telefono: string | null;
    tipo_documento: string;
    numero_documento: string;
    ocupacion: string | null;
    empresa: string | null;
    ingresos_mensuales: number | null;
    direccion: string | null;
  };

  // Validar requeridos por ProviderSolicitudInput (defensa en profundidad:
  // el registro vitrina ya exige estos campos en Zod).
  const faltantes: string[] = [];
  if (!solicitante.nombre) faltantes.push('nombre');
  if (!solicitante.apellido) faltantes.push('apellido');
  if (!solicitante.tipo_documento) faltantes.push('tipo_documento');
  if (!solicitante.numero_documento) faltantes.push('numero_documento');
  if (!solicitante.email) faltantes.push('email');
  if (!solicitante.telefono) faltantes.push('telefono');

  if (faltantes.length > 0) {
    throw AppError.badRequest(
      `Datos insuficientes para iniciar estudio: ${faltantes.join(', ')}`,
      'DATOS_SOLICITANTE_INSUFICIENTES',
    );
  }

  // 3. Construir payload con el shape del form + acepta_terminos (consentimiento
  //    inferido de terminos_aceptaciones; el campo vive en datos_formulario por
  //    compatibilidad con el shape existente usado por otros flujos).
  const datosFormulario = {
    nombre_completo: `${solicitante.nombre} ${solicitante.apellido}`.trim(),
    tipo_documento: solicitante.tipo_documento,
    numero_documento: solicitante.numero_documento,
    email: solicitante.email,
    telefono: solicitante.telefono || '',
    ingresos_mensuales: solicitante.ingresos_mensuales ?? undefined,
    ocupacion: solicitante.ocupacion ?? undefined,
    empresa: solicitante.empresa ?? undefined,
    direccion_residencia: solicitante.direccion ?? undefined,
    acepta_terminos: true as const,
  };

  // 4. UPDATE estudios.
  const { error: updateErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'formulario_completado',
      datos_formulario: datosFormulario,
      // NO se pisa `autorizacion_habeas_data_id`. Antes se escribía null
      // explícito con el argumento de que en vitrina/invitación bastaba
      // `terminos_aceptaciones`; esa tabla no guarda texto_autorizado, ni
      // version_terminos, ni el documento del aceptante, así que no cumple el
      // 8.4 y ademas borraba el vínculo que el orquestador ya había escrito.
      // El gate de ejecución (autorizacion.guard.ts) exige la autorización
      // firmada también en estos flujos; el enlace lo envía automáticamente
      // orchestrator.onPagoConfirmado.
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', estudioId);

  if (updateErr) {
    logger.error({ error: updateErr.message, estudioId }, 'Error al completar formulario desde onboarding');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al avanzar el estudio');
  }

  // 5. Timeline event atómico para auditar el camino sin-OTP.
  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'estudio',
      descripcion: 'Formulario de estudio completado automáticamente (flujo onboarding)',
      usuario_id: userId,
      metadata: { via: 'onboarding_sin_otp', estudio_id: estudioId },
    } as never);

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_FORM_SUBMITTED,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: estudioId,
    detalle: { via: 'onboarding_sin_otp', expediente_id: expedienteId },
  });

  logger.info(
    { estudioId, expedienteId, solicitanteId, userId },
    'Estudio avanzado a formulario_completado via onboarding',
  );

  return { estudioId, yaCompletado: false };
}

// ============================================================
// Register resultado (irreversible)
// ============================================================

/**
 * Dispara el hook post-resultado de un estudio YA marcado como 'completado'
 * (vía RPC). Ramifica por tipo de estudio:
 *  - 'con_coarrendatario' → ponderación (onCoarrendatarioEstudioCompletado):
 *    combina con el estudio del titular y resuelve el expediente.
 *  - resto → orchestrator (onEstudioCompletado): transiciona el expediente
 *    (en_revision → aprobado/condicionado/rechazado) y dispara correos/notifs.
 *
 * Es la ÚNICA forma de que el expediente avance tras un estudio, así que TODAS
 * las rutas de completado (registro manual, inline del provider y polling) deben
 * llamarla — antes divergían y la ruta manual no disparaba nada, dejando el
 * expediente atascado en su estado previo. Fire-and-forget y nunca lanza: el
 * resultado ya quedó persistido y no debe romper la respuesta HTTP.
 *
 * `veredicto` viaja EN MEMORIA a proposito. Los dos consumidores (orquestador y
 * ponderación) necesitan saber si el rechazo fue por regla dura para no
 * atribuirlo al score, y redescubrirlo releyendo `estudios.regla_dura_activada`
 * los ataba a una migración pendiente: sin la columna, el SELECT falla y los
 * textos vuelven a los genéricos — justo el mensaje contradictorio (score 773 +
 * "no cumplió los requisitos") que la activación existía para eliminar. La
 * columna queda como trazabilidad/analítica y como respaldo de los llamadores
 * que no tienen el veredicto a mano.
 */
async function dispararHookPostResultado(
  estudioId: string,
  expedienteId: string,
  resultado: string,
  score: number | null,
  veredicto?: VeredictoReglasDuras,
): Promise<void> {
  const reglasDuras = veredicto?.rechaza ? veredicto.reglas : [];
  const motivoGestorReglaDura = veredicto?.rechaza ? veredicto.motivoGestor : null;
  try {
    const tipoRow = (await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select('tipo')
      .eq('id', estudioId)
      .maybeSingle()).data as { tipo?: string } | null;

    if (tipoRow?.tipo === 'con_coarrendatario') {
      import('@/modules/coarrendatarios/coarrendatarios.service')
        .then(({ onCoarrendatarioEstudioCompletado }) =>
          onCoarrendatarioEstudioCompletado(estudioId, { reglasDuras }),
        )
        .catch((err) => logger.warn({ error: err, estudioId }, 'Hook ponderación coarrendatario falló'));
      return;
    }

    import('@/modules/orchestrator/orchestrator.service')
      .then(({ onEstudioCompletado }) =>
        onEstudioCompletado({
          estudioId,
          expedienteId,
          resultado,
          score,
          solicitanteId: '',
          reglasDuras,
          motivoGestorReglaDura,
        }),
      )
      .catch((err) => logger.warn({ error: err, estudioId }, 'Orchestrator hook post-estudio falló'));
  } catch (err) {
    logger.warn({ error: err, estudioId }, 'No se pudo disparar el hook post-resultado del estudio');
  }
}

export async function registrarResultado(
  estudioId: string,
  input: RegistrarResultadoInput,
  userId: string,
  ip?: string,
  userRol?: string,
) {
  // 1. Get estudio — verify exists, estado, and resultado still pendiente
  const { data: estudio, error: getError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, resultado, expediente_id, canon_evaluado')
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
    canon_evaluado: number | string | null;
  };

  // Tenant guard: registrar (irreversiblemente) el resultado es una mutación
  // sensible. Sin esto la inmobiliaria (rol externo con expedientes:update)
  // falseaba el resultado de estudios de OTRA agencia por UUID (write-IDOR).
  await assertExpedienteAccess(est.expediente_id, userId, userRol);

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

  // 2.5. Reglas duras V4.1. Tercer y ultimo camino que llega al RPC, asi que
  //      tambien pasa por el punto de decision: la Politica §3 no distingue si
  //      el resultado lo trajo el buro o lo escribio un gestor.
  //
  //      En la practica es casi siempre un no-op: el registro manual solo
  //      procede sobre estudios con resultado 'pendiente', que normalmente no
  //      tienen `respuesta_proveedor`, y sin payload no hay ingreso inferido y
  //      ninguna de las dos reglas es evaluable. Cuando SI hay payload (se
  //      registra a mano un estudio cuyo buro ya respondio), la regla decide.
  const decision = await resolverResultadoEstudio({
    estudioId,
    expedienteId: est.expediente_id,
    resultadoPropuesto: input.resultado,
    score: input.score ?? null,
    observaciones: input.observaciones,
    motivoRechazo: input.motivo_rechazo ?? null,
  });

  // 2.6. CANON CONGELADO — el otro camino que llega a 'completado'.
  //
  //      `ejecutarEstudio` congela el canon dentro de su CAS, pero este registro
  //      MANUAL no pasa por ahi (existe justamente porque ejecutarEstudio
  //      rechaza los proveedores no consultables: 'manual', 'sifin'). Sin esto,
  //      un estudio registrado a mano HOY quedaba 'completado' con
  //      `canon_evaluado` NULL y, por tanto, no portable para siempre — con un
  //      mensaje que ademas culpaba a que era "anterior al registro del canon".
  //      Prerequisito del §4.3, igual que en ejecutarEstudio.
  //
  //      Se usa `leerCanonDelInmueble` y NO `assertCanonDentroDelTope`: el tope
  //      del §4.4 se aplica ANTES del cobro, y este call site corre despues de
  //      que el estudio se hizo. Bloquear aqui dejaria al cliente cobrado y sin
  //      resultado, que es justo lo que el grandfathering del tope evita.
  //
  //      Solo se escribe si falta: un estudio que ya paso por ejecutarEstudio
  //      lleva el canon de la corrida que fue al buro, y ese manda. Y nunca
  //      bloquea: si el canon no se puede leer, se registra el resultado igual y
  //      la columna queda NULL (el §4.3 lo dice con claridad).
  if (est.canon_evaluado === null || est.canon_evaluado === undefined) {
    try {
      const bruto = await leerCanonDelInmueble({ expedienteId: est.expediente_id });
      const canon = typeof bruto === 'string' ? Number(bruto) : bruto;
      if (typeof canon === 'number' && Number.isFinite(canon) && canon > 0) {
        const { error: canonError } = await (supabase
          .from('estudios' as string) as ReturnType<typeof supabase.from>)
          .update({ canon_evaluado: canon, canon_evaluado_origen: 'manual' } as never)
          .eq('id', estudioId)
          .is('canon_evaluado', null);
        if (canonError) {
          logger.warn(
            { error: canonError.message, estudioId },
            'registrarResultado: no se pudo congelar el canon evaluado — el estudio no sera portable (§4.3)',
          );
        }
      } else {
        logger.warn(
          { estudioId, expedienteId: est.expediente_id },
          'registrarResultado: el inmueble no tiene canon utilizable — el estudio queda sin canon congelado (§4.3)',
        );
      }
    } catch (err) {
      logger.warn(
        { estudioId, err: err instanceof Error ? err.message : String(err) },
        'registrarResultado: excepcion leyendo el canon del inmueble — se registra el resultado igual, sin canon congelado',
      );
    }
  }

  // 3. Atomic RPC: update estudio + revert inmueble + insert timeline event
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: rpcError } = await (supabase as any).rpc('fn_registrar_resultado_estudio', {
    p_estudio_id: estudioId,
    p_resultado: decision.resultado,
    p_observaciones: decision.observaciones,
    p_score: input.score ?? null,
    p_motivo_rechazo: decision.motivoRechazo,
    // Un rechazo por regla dura no lleva condiciones: no hay nada que cumplir
    // para levantarlo dentro de este estudio.
    p_condiciones: decision.veredicto.rechaza ? null : (input.condiciones ?? null),
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

  // 3.5. Trazabilidad de la regla dura, antes del hook que la lee.
  await registrarReglaDuraActivada(estudioId, decision.veredicto);

  // 4. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_RESULTADO_REGISTERED,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: estudioId,
    detalle: {
      resultado: decision.resultado,
      resultado_solicitado: input.resultado,
      reglas_duras: decision.veredicto.rechaza ? decision.veredicto.reglas : null,
      score: input.score,
      has_certificado: !!input.certificado_storage_key,
      expediente_id: est.expediente_id,
    },
    ip,
  });

  // 5. Notificacion in-app al solicitante (fire-and-forget). Empuja el
  // campanario y badges en tiempo real; el correo formal lo manda el hook.
  notificarSolicitanteResultadoEstudio(est.expediente_id, decision.resultado).catch((e) =>
    logger.warn({ error: e, estudioId, expedienteId: est.expediente_id }, 'Error notificando resultado de estudio'),
  );

  // 6. Disparar el hook post-resultado (transiciona el expediente / pondera con
  // el coarrendatario). El registro MANUAL antes no lo hacía y el expediente
  // quedaba atascado en su estado previo sin llegar a condicionado/aprobado.
  void dispararHookPostResultado(
    estudioId,
    est.expediente_id,
    decision.resultado,
    input.score ?? null,
    decision.veredicto,
  );

  // 7. Registro sombra del scorecard completo. Va despues del RPC y de su
  //    error-check a proposito: el resultado real ya esta commiteado, asi que
  //    ni una excepcion ni un await lento pueden afectarlo. Recibe la corrida
  //    que ya hizo el punto de decision (que si tuvo que leer proveedor y
  //    payload de la fila) y sale en silencio si no habia nada que puntuar,
  //    que es el caso normal de un registro manual.
  void registrarScorecardSombra({
    estudioId,
    expedienteId: est.expediente_id,
    scorePersistido: input.score ?? null,
    salidaPrecalculada: decision.salida,
  }).catch(() => undefined);

  return getEstudioById(estudioId);
}

/**
 * Lookup ligero de email del solicitante a partir del expediente y notifica
 * via supabase realtime. Tolera ausencia de perfil (solicitante externo aun
 * sin cuenta) — la llamada se omite silenciosamente.
 */
async function notificarSolicitanteResultadoEstudio(
  expedienteId: string,
  resultado: string,
): Promise<void> {
  const { data: exp } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, solicitante_id')
    .eq('id', expedienteId)
    .single() as { data: { id: string; numero: string | null; solicitante_id: string | null } | null };

  if (!exp?.solicitante_id) return;

  const { data: sol } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('nombre, apellido, email, telefono')
    .eq('id', exp.solicitante_id)
    .single() as { data: { nombre: string; apellido: string; email: string; telefono: string | null } | null };

  const aprobado = resultado === 'aprobado';
  const condicionado = resultado === 'condicionado';
  const numeroExpediente = exp.numero ?? '';

  // 1) Notificacion in-app (campanario + badges en tiempo real)
  const userId = await findPerfilIdByEmail(sol?.email);
  if (userId) {
    await notificarUsuario({
      userId,
      tipo: aprobado ? 'estudio.aprobado' : condicionado ? 'estudio.condicionado' : 'estudio.rechazado',
      titulo: aprobado ? 'Estudio aprobado' : condicionado ? 'Estudio condicionado' : 'Resultado de tu estudio',
      mensaje: aprobado
        ? `Tu solicitud ${numeroExpediente} avanzó. Ya puedes continuar con el contrato.`
        : condicionado
          ? `Tu solicitud ${numeroExpediente} quedó condicionada. Invita a un co-arrendatario para continuar.`
          : `Tu solicitud ${numeroExpediente} no fue aprobada. Revisa los detalles.`,
      link: `/expedientes/${expedienteId}`,
      payload: { expediente_id: expedienteId, resultado },
    });
  }

  // 2) WhatsApp al solicitante via Meta (Mario 12-may-2026, provider mock
  // por ahora). Solo si tenemos telefono — fire-and-forget, no rompe el
  // flujo del estudio si el envio falla.
  const nombreCorto = sol?.nombre || 'Hola';
  const templateKey = aprobado
    ? ('ESTUDIO_APROBADO' as const)
    : condicionado
      ? ('ESTUDIO_CONDICIONADO' as const)
      : ('ESTUDIO_RECHAZADO' as const);
  await enviarTemplateWhatsApp({
    to: sol?.telefono ?? null,
    template: templateKey,
    variables: [nombreCorto, numeroExpediente],
    context: { expediente_id: expedienteId },
  });
}

// ============================================================
// Get presigned URL for certificado upload
// ============================================================

export async function getCertificadoPresignedUrl(
  estudioId: string,
  input: CertificadoPresignedUrlInput,
  userId?: string,
  userRol?: string,
) {
  // 1. Verify estudio exists and is eligible
  const { data: estudio, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, resultado, expediente_id')
    .eq('id', estudioId)
    .single();

  if (error || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as { id: string; estado: string; resultado: string; expediente_id: string };

  // Tenant guard: genera una URL de subida firmada a estudios/<id>/certificado/…
  // Sin scoping, la inmobiliaria subía certificados al storage de estudios de
  // OTRA agencia por UUID (write-IDOR).
  await assertExpedienteAccess(est.expediente_id, userId, userRol);

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

export async function getCertificadoViewUrl(estudioId: string, userId?: string, userRol?: string) {
  const { data: estudio, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, certificado_url, expediente_id')
    .eq('id', estudioId)
    .single();

  if (error || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as { id: string; certificado_url: string | null; expediente_id: string };

  // Tenant guard: devuelve una URL firmada al PDF del certificado. Sin scoping,
  // un rol externo con expedientes:read descargaba el certificado de OTRA
  // agencia por UUID (IDOR de lectura).
  await assertExpedienteAccess(est.expediente_id, userId, userRol);

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

export async function ejecutarEstudio(
  estudioId: string,
  userId: string,
  ip?: string,
  userRol?: string,
  documentoOverride?: {
    tipo_documento?: string;
    numero_documento?: string;
    proveedor?: 'transunion' | 'datacredito';
    primer_apellido?: string;
  },
) {
  // 1. Get estudio
  const { data: estudio, error: getError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, resultado, score, proveedor, tipo, datos_formulario, expediente_id')
    .eq('id', estudioId)
    .single();

  if (getError || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as {
    id: string;
    estado: string;
    resultado: string;
    score: number | null;
    proveedor: string;
    tipo: string;
    datos_formulario: Record<string, unknown> | null;
    expediente_id: string;
  };

  // 1.2. Ownership guard para solicitante: solo puede ejecutar estudios
  //      de sus propios expedientes. Admin/operador pasan sin chequeo.
  if (userRol === 'solicitante') {
    const { data: solOwnRow } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id, solicitante:solicitantes(creado_por)')
      .eq('id', est.expediente_id)
      .single();
    const solOwn = solOwnRow as unknown as {
      id: string;
      solicitante: { creado_por: string } | null;
    } | null;
    if (!solOwn?.solicitante || solOwn.solicitante.creado_por !== userId) {
      throw AppError.forbidden(
        'No tienes permisos para ejecutar este estudio',
        'ESTUDIO_FORBIDDEN',
      );
    }
  }

  // 1.3. Ownership guard para inmobiliaria / propietario: solo pueden ejecutar
  //      (o reintentar) estudios de expedientes de un inmueble que administran.
  //      La inmobiliaria es quien paga el estudio, así que debe poder
  //      relanzarlo si la consulta falló. Admin/operador pasan sin chequeo.
  if (userRol === 'inmobiliaria' || userRol === 'propietario') {
    const { data: expInmRow } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('inmueble_id')
      .eq('id', est.expediente_id)
      .single();
    const inmuebleId = (expInmRow as { inmueble_id?: string | null } | null)?.inmueble_id ?? null;
    let esDueno = false;
    if (inmuebleId) {
      const { data: inmRow } = await (supabase
        .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
        .select('propietario_id, inmobiliaria_id')
        .eq('id', inmuebleId)
        .single();
      const inm = inmRow as { propietario_id?: string | null; inmobiliaria_id?: string | null } | null;
      if (inm) {
        esDueno = await perfilEsDuenoDeInmueble({
          userId,
          userRol,
          inmueblePropietarioId: inm.propietario_id,
          inmuebleInmobiliariaId: inm.inmobiliaria_id,
        });
      }
    }
    if (!esDueno) {
      throw AppError.forbidden('No tienes permisos para ejecutar este estudio', 'ESTUDIO_FORBIDDEN');
    }
  }

  // 1.5. Guard: el expediente debe estar habilitado para estudio. Gate del
  //      paso 3 del flujo — evita consultas a TransUnion sin autorización
  //      explícita del propietario tras la cita realizada. Tambien traemos
  //      solicitante_id para sincronizar el documento del solicitante con
  //      el que se usa en el form (ver paso 3).
  const { data: expedienteRow, error: expErr } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estudio_habilitado, solicitante_id, inmueble_id')
    .eq('id', est.expediente_id)
    .single();

  if (expErr || !expedienteRow) {
    logger.warn(
      { estudioId, expedienteId: est.expediente_id, err: expErr?.message },
      'Expediente asociado al estudio no encontrado al ejecutar',
    );
    throw AppError.notFound(
      'Expediente asociado al estudio no encontrado',
      'EXPEDIENTE_NOT_FOUND',
    );
  }

  const expediente = expedienteRow as unknown as {
    id: string;
    numero: string;
    estudio_habilitado: boolean;
    solicitante_id: string | null;
    inmueble_id: string | null;
  };

  if (!expediente.estudio_habilitado) {
    logger.warn(
      { estudioId, expedienteId: expediente.id, numero: expediente.numero },
      'Intento de ejecutar estudio sin habilitación',
    );
    throw AppError.badRequest(
      'El estudio crediticio no está habilitado para este expediente. ' +
        'Se requiere que el propietario autorice el estudio después de la cita.',
      'ESTUDIO_NO_HABILITADO',
    );
  }

  // 1.6. TOPE DE CANON — flujo §4.4.
  //
  //      Última barrera antes del buró, y la que cubre los caminos que no
  //      pasan por createEstudio ni por habilitarEstudio: el estudio del
  //      co-arrendatario (coarrendatarios.service lo dispara aquí), el
  //      onboarding de vitrina/invitación (orchestrator → este mismo punto),
  //      el reintento de un 'fallido' y la re-consulta al otro buró. Todos
  //      terminan en ejecutarEstudio, así que cerrar aquí cierra todos.
  //
  //      HASTA 2026-09-04 aquí NUNCA se estaba antes del cobro: a
  //      ejecutarEstudio no se llegaba sin pago previo. Esa invariante MURIÓ
  //      con la inversión del §6.3 (opción C: primero se autoriza, después se
  //      cobra), porque la firma del prospecto puede llegar sin ningún pago.
  //      Por eso justo debajo está el gate 1.7, que es el que ahora impide
  //      consultar el buró sin cobro.
  //
  //      La lógica del grandfathering del tope NO cambia, y sigue siendo
  //      correcta con el orden nuevo: si el estudio ya se cobró, bloquear aquí
  //      deja al cliente cobrado y sin servicio —y con un mensaje que le
  //      afirma que "no se generó ningún cobro", que sería falso—, así que el
  //      guard sólo advierte. Casos reales: el reintento de un 'fallido' (que
  //      en este sistema aparece de forma espuria cuando se reinicia la API) y
  //      la re-consulta al otro buró de un condicionado sin score, que es justo
  //      el remedio documentado 70 líneas más abajo. Y si NO se cobró, el tope
  //      bloquea y su mensaje sigue siendo literalmente cierto. El bloqueo real
  //      del tope vive, como siempre, en los sitios previos al cobro
  //      (habilitarEstudio, enviarLinkPago, asumirCosto, liberarEstudioConCredito).
  //
  //      Va ANTES del gate 8.4 a propósito. Los dos son de sólo lectura, así
  //      que el orden sólo decide qué mensaje lee el gestor — y el accionable
  //      es este: si el canon excede el tope, el estudio no va a poder correr
  //      nunca, y contestar "falta la autorización" lo mandaría a perseguir
  //      una firma inútil. Además, pedir habeas data para un estudio que no
  //      se puede ejecutar sería recolectar datos sin finalidad (Ley 1581).
  //      Ver la nota de ORDEN en tope-canon.guard.ts.
  //
  //      El canon que devuelve el guard es el que se CONGELA mas abajo, en el
  //      CAS (paso 5). Ver alli por que.
  // Una sola lectura de la señal de pago para los DOS consumidores que vienen
  // (el interruptor bloquear/advertir del tope, y el gate 1.7): son la misma
  // pregunta y el camino es caliente.
  const senalPago = await leerSenalPagoEstudio(est.expediente_id);

  const { canonCop: canonEvaluado } = await assertCanonDentroDelTope({
    // El inmueble ya viene resuelto del select de arriba: no cuesta un
    // roundtrip extra.
    inmuebleId: expediente.inmueble_id,
    expedienteId: est.expediente_id,
    origen: 'ejecutarEstudio',
    soloAdvertir: senalIndicaPagado(senalPago),
  });


  // 1.8. Normalizar 'formulario_enviado' → 'formulario_completado' (igual que
  //      el orchestrator): el solicitante puede ejecutar desde su panel con el
  //      documento confirmado aunque nunca haya llenado el formulario
  //      self-service. Sin esto, la UI ofrecía "Enviar para estudio" y el
  //      backend lo rechazaba — loop muerto de reintentos.
  if (est.estado === 'formulario_enviado' && expediente.solicitante_id) {
    const { data: solRow } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .select('nombre, apellido, tipo_documento, numero_documento, email, telefono')
      .eq('id', expediente.solicitante_id)
      .maybeSingle();
    const sol = solRow as { nombre?: string; apellido?: string; tipo_documento?: string; numero_documento?: string; email?: string; telefono?: string } | null;
    if (sol) {
      const base = {
        nombre_completo: `${sol.nombre ?? ''} ${sol.apellido ?? ''}`.trim(),
        tipo_documento: sol.tipo_documento ?? '',
        numero_documento: sol.numero_documento ?? '',
        email: sol.email ?? '',
        telefono: sol.telefono ?? '',
        acepta_terminos: true,
      };
      const merged = { ...base, ...(est.datos_formulario ?? {}) };
      const { error: normError } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'formulario_completado', datos_formulario: merged } as never)
        .eq('id', estudioId)
        .eq('estado', 'formulario_enviado');
      if (!normError) {
        est.estado = 'formulario_completado';
        est.datos_formulario = merged;
      }
    }
  }

  // 2. Validate estado
  // El override de proveedor es una decisión FACTURABLE, reservada al gestor:
  // si lo manda un solicitante se ignora (la UI no se lo ofrece, pero la ruta
  // admite ese rol). Se resuelve aquí porque el guard de estado depende de él.
  const overrideProveedor = userRol === 'solicitante' ? undefined : documentoOverride?.proveedor;
  if (documentoOverride?.proveedor && userRol === 'solicitante') {
    logger.warn(
      { estudioId, userId, intento: documentoOverride.proveedor },
      'ejecutarEstudio: un solicitante intentó cambiar de buró — override ignorado',
    );
  }

  // Re-consulta al OTRO buró de un estudio ya completado.
  //
  // Un 'completado' + 'condicionado' + score null significa que el buró no
  // pudo evaluar a la persona (código 14 de DataCrédito, exclusiones -4..-7 de
  // CreditVision). Preguntarle al otro buró es la salida natural, pero no
  // existía ninguna: el reintento solo aparece en 'fallido', la re-evaluación
  // es admin/operador, exige documentos y hereda el mismo proveedor.
  //
  // Se abre SOLO para ese caso y SOLO si además se cambia de buró: re-ejecutar
  // un estudio aprobado o uno condicionado CON score (el buró sí evaluó y dio
  // banda media) seguiría prohibido.
  const esCondicionadoSinInfo =
    est.estado === 'completado' && est.resultado === 'condicionado' && est.score === null;
  const reconsultaOtroBuro =
    esCondicionadoSinInfo && !!overrideProveedor && overrideProveedor !== est.proveedor;

  const estadosPermitidos = reconsultaOtroBuro
    ? [...ESTADOS_PERMITIDOS_EJECUCION, 'completado']
    : ESTADOS_PERMITIDOS_EJECUCION;

  if (!estadosPermitidos.includes(est.estado)) {
    throw AppError.badRequest(
      `Solo se puede ejecutar via proveedor en estados: ${ESTADOS_PERMITIDOS_EJECUCION.join(', ')}. Estado actual: ${est.estado}`,
      'ESTUDIO_ESTADO_INVALIDO',
    );
  }

  // 3. Validate datos_formulario exists (o construirlo desde el override).
  const datosBase = (est.datos_formulario as Record<string, string> | null) ?? {};

  // Aplicar override del documento si viene en el body (el solicitante
  // confirmó/corrigió su CC en la card). Persistimos el cambio para que el
  // historial refleje qué documento se consultó.
  const datos: Record<string, string> = { ...datosBase };
  const overrideNumero = documentoOverride?.numero_documento?.trim();
  const overrideTipo = documentoOverride?.tipo_documento?.trim().toLowerCase();
  const overrideApellido = documentoOverride?.primer_apellido?.trim();
  if (overrideNumero) datos.numero_documento = overrideNumero;
  if (overrideTipo) datos.tipo_documento = overrideTipo;
  if (overrideApellido) datos.apellido = overrideApellido;

  if (!datos.numero_documento) {
    throw AppError.badRequest(
      'Falta el número de documento para ejecutar el estudio.',
      'DOCUMENTO_REQUERIDO',
    );
  }

  // 3.5. GATE 8.4 — autorización PREVIA para consultar centrales de riesgo.
  //
  //      Va aquí a propósito: el documento efectivo ya está resuelto (con el
  //      override del gestor aplicado) pero todavía NO se ha escrito nada —
  //      ni el lock a 'en_proceso', ni la sincronización del documento del
  //      solicitante. Un estudio bloqueado aquí no consume consulta facturable
  //      ni queda colgado en 'en_proceso'.
  //
  //      Hasta 2026-09-03 el único gate era `estudio_habilitado`, y en 4 de 7
  //      estudios completados el buró se consultó ANTES de que la persona
  //      autorizara. Ver src/modules/estudios/autorizacion.guard.ts.
  const { autorizacionId } = await assertAutorizacionVigente({
    estudioId: est.id,
    expedienteId: est.expediente_id,
    tipoEstudio: est.tipo,
    // El PAR completo: `tipo_documento` tambien viaja al buro y tambien llega
    // desde el body, asi que comparar solo el numero permitia consultar a otro
    // titular de datos (mismo numero, distinto tipo) con una firma legitima.
    numeroDocumentoConsultado: datos.numero_documento,
    tipoDocumentoConsultado: datos.tipo_documento,
  });

  // 3.6. GATE DE PAGO — flujo §6.3 ("mientras el pago no se confirme, el
  //      estudio permanece en estado de espera y no consume consultas a
  //      centrales").
  //
  //      Este es el ÚNICO cuello por el que pasan los seis caminos que llegan
  //      al buró: POST /estudios/:id/ejecutar (panel del gestor Y del
  //      solicitante), el orquestador tras la firma, la aceptación del
  //      co-arrendatario, el reintento de un 'fallido' y la re-consulta al
  //      otro buró. Ponerlo en el hook de autorización dejaría los otros cinco
  //      abiertos.
  //
  //      Es por EXPEDIENTE, no por estudio: el estudio del co-arrendatario y el
  //      hijo de re-evaluación no tienen pago propio y se amparan en el del
  //      titular (uq_pagos_estudio_activo garantiza como máximo uno). Eso es
  //      también lo que hace que los expedientes ya pagados pasen sin backfill.
  //
  //      ORDEN de los tres guards: tope de canon (1.6) → autorización previa
  //      (3.5) → pago (3.6). No es estético. Si el canon excede el tope el
  //      estudio no va a correr nunca y contestar "falta el pago" mandaría al
  //      gestor a cobrar por algo imposible; y pedirle plata a quien todavía no
  //      autorizó es exactamente lo que el §6.3 prohíbe. Como el 8.4, va antes
  //      del lock y del proveedor: un estudio bloqueado aquí no consume
  //      consulta ni queda colgado en 'en_proceso'.
  assertPagoEstudio(senalPago, { origen: 'ejecutar', expedienteNumero: expediente.numero });

  // Si el override trajo cambios respecto a datos_formulario, persistir.
  const cambioNumeroDatos = !!(overrideNumero && overrideNumero !== datosBase.numero_documento);
  const cambioTipoDatos = !!(overrideTipo && overrideTipo !== datosBase.tipo_documento);
  const cambioApellidoDatos = !!(overrideApellido && overrideApellido !== datosBase.apellido);
  if (cambioNumeroDatos || cambioTipoDatos || cambioApellidoDatos) {
    await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({ datos_formulario: datos } as never)
      .eq('id', est.id);
  }

  // Sincronizar `solicitantes.numero_documento` + tipo_documento con el
  // documento que realmente se va a consultar en TransUnion. Helper
  // extraido para llamarse ademas desde registrarResultadoInline (red de
  // seguridad post-completado).
  // OJO: NO sincronizar para estudios 'con_coarrendatario' — el documento del
  // formulario es del CO-ARRENDATARIO, no del titular; sincronizarlo
  // sobreescribiría la cédula del solicitante titular con la del co-arrendatario.
  if (est.tipo !== 'con_coarrendatario') {
    await sincronizarDocumentoSolicitante({
      estudioId,
      solicitanteId: expediente.solicitante_id,
      targetNumero: datos.numero_documento,
      targetTipo: datos.tipo_documento,
      // Solo cuando el gestor lo corrigió explícitamente: el apellido de
      // `datos_formulario` puede venir derivado del nombre completo, y
      // sobreescribir el del solicitante con una heurística sería peor que
      // dejarlo como está.
      targetApellido: overrideApellido,
      origen: 'ejecutarEstudio',
    });
  }

  // 4. Build provider input
  const providerInput: ProviderSolicitudInput = {
    estudio_id: est.id,
    tipo: est.tipo as 'individual' | 'con_coarrendatario',
    nombre_completo: datos.nombre_completo || '',
    // DataCredito valida el primer apellido contra Registraduria (codigo 10 si
    // no coincide). Si datos_formulario no lo trae por separado el provider lo
    // deriva de nombre_completo, que es menos confiable.
    primer_apellido: (datos.apellido as string) || undefined,
    tipo_documento: datos.tipo_documento || '',
    numero_documento: datos.numero_documento || '',
    email: datos.email || '',
    telefono: datos.telefono || '',
    ingresos_mensuales: datos.ingresos_mensuales ? Number(datos.ingresos_mensuales) : undefined,
    ocupacion: (datos.ocupacion as string) || undefined,
    empresa: (datos.empresa as string) || undefined,
    direccion_residencia: (datos.direccion_residencia as string) || undefined,
  };

  // 5. Marcar estudio como `en_proceso` de inmediato. Esto:
  //    (a) Permite responder al cliente HTTP rápido, sin esperar TransUnion
  //        (que puede tardar 30-60s con retries y dejar al solicitante con
  //        un spinner colgado).
  //    (b) Bloquea ejecuciones concurrentes de verdad: el UPDATE es un CAS
  //        condicionado al estado permitido — dos requests simultáneas (doble
  //        click, o reintento contra un estudio que otro flujo ya tomó) solo
  //        dejan pasar a UNA. Sin esto, cada ejecución duplicada consumía una
  //        consulta TransUnion facturada.
  // 4.5. Cambio manual de buró (reintento con el otro proveedor).
  //
  //      El override es una decisión FACTURABLE, así que se reserva a los
  //      gestores: si lo manda un solicitante se ignora en silencio (la UI no
  //      se lo ofrece, pero la ruta sí admite ese rol).
  const proveedorAnterior = est.proveedor;
  const proveedorFinal = overrideProveedor ?? est.proveedor;
  const cambioProveedor = proveedorFinal !== proveedorAnterior;

  //      Guard: solo los burós reales son ejecutables. Sin esto, (a) un
  //      estudio 'manual' con override se convertiría en una consulta
  //      facturada sin aviso, y (b) uno 'manual' SIN override tomaría el lock
  //      y luego getProvider() lanzaría, dejándolo en 'en_proceso' para
  //      siempre (el throw ocurre fuera del try de procesarEstudioAsync).
  if (proveedorFinal !== 'transunion' && proveedorFinal !== 'datacredito') {
    throw AppError.badRequest(
      `El estudio tiene proveedor "${proveedorFinal}", que no se consulta automáticamente. Elige TransUnion o DataCrédito para ejecutarlo.`,
      'PROVEEDOR_NO_EJECUTABLE',
    );
  }

  if (cambioProveedor) {
    logger.info(
      { estudioId, proveedorAnterior, proveedorFinal, userId },
      'ejecutarEstudio: cambio manual de proveedor para el reintento',
    );
  }

  //      El proveedor se escribe SIEMPRE dentro del CAS, no solo cuando
  //      cambia: `proveedorFinal` sale de un snapshot leído varios roundtrips
  //      antes, así que si otra request cambió el buró entretanto, escribirlo
  //      condicionalmente dejaría la columna con un buró distinto al que este
  //      proceso va a consultar. Quien gana el lock fija el buró que ejecuta.
  //
  //      La referencia y la respuesta del buró anterior se limpian: pertenecen
  //      a otro proveedor y `consultarEstadoProveedor` las usaría contra el
  //      nuevo (cache-miss garantizado → marcaría 'fallido' un reintento en
  //      vuelo).
  const { data: lockRows, error: lockError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'en_proceso',
      proveedor: proveedorFinal,
      // Deja el estudio atado a la evidencia concreta que lo habilitó. Antes
      // quedaba null en los caminos de habilitación, onboarding y
      // co-arrendatario, así que no había forma de reconstruir con qué firma
      // se consultó el buró.
      autorizacion_habeas_data_id: autorizacionId,
      ...(cambioProveedor ? { referencia_proveedor: null, respuesta_proveedor: null } : {}),
      // Re-consulta de un estudio ya completado: hay que devolverlo a
      // 'pendiente'. fn_registrar_resultado_estudio rechaza registrar sobre un
      // estudio que ya tiene resultado ("ya tiene un resultado registrado"),
      // así que sin este reset la consulta al otro buró se ejecutaría —
      // facturada — y su respuesta no podría guardarse.
      ...(reconsultaOtroBuro
        ? { resultado: 'pendiente', score: null, observaciones: null }
        : {}),
      // CANON CONGELADO — prerequisito de la portabilidad del §4.3.
      //
      // `inmuebles.valor_arriendo` es EDITABLE: el gestor puede moverlo
      // cualquier dia. Sin este snapshot, la tolerancia del +15% compararia la
      // propiedad destino contra un valor que pudo cambiar despues del
      // estudio, y el certificado dejaria de decir para que canon se aprobo.
      // Por eso el canon con el que se ejecuto se guarda EN EL ESTUDIO
      // (columnas de la migracion 20260903000001, que hasta hoy nadie escribia).
      //
      // Va AQUI, dentro del CAS, por tres razones: (a) es exactamente el mismo
      // numero que uso el guard del tope unas lineas arriba, no una segunda
      // lectura que podria diferir; (b) el CAS es el unico punto que gana UNO
      // solo, asi que el canon queda atado a la corrida que de verdad va al
      // buro, sin un UPDATE extra ni una carrera propia; (c) es antes del buro,
      // como pide el comentario de la migracion.
      //
      // Se SOBRESCRIBE en cada toma de lock (no es write-once): el reintento de
      // un 'fallido' y la re-consulta al otro buro reescriben `resultado`, y el
      // estudio debe llevar el canon de la corrida que produjo el resultado
      // vigente, no el de un intento abortado.
      //
      // Si el canon no se pudo resolver (caso estructural: todavia no hay
      // inmueble) no se escribe nada: la columna tiene CHECK > 0 y un cero
      // inventado seria peor que un NULL honesto.
      ...(canonEvaluado !== null
        ? { canon_evaluado: canonEvaluado, canon_evaluado_origen: 'inmueble' }
        : {}),
    } as never)
    .eq('id', estudioId)
    .in('estado', estadosPermitidos)
    .select('id');

  if (lockError) {
    logger.error({ error: lockError.message, estudioId }, 'Error tomando el lock de ejecución del estudio');
    throw fromSupabaseError(lockError);
  }
  if (!lockRows || lockRows.length === 0) {
    throw AppError.conflict(
      'El estudio ya está siendo procesado o cambió de estado — refresca para ver el estado actual',
      'ESTUDIO_EN_PROCESO',
    );
  }

  // 6. Disparar el provider en background. El frontend hace polling sobre
  //    el estudio (cada 5s) y detecta cuando pase a 'completado' o
  //    'fallido'. Si el async crash sin manejar, el estudio queda en
  //    'en_proceso' indefinido — el catch global cubre eso marcándolo
  //    como fallido para que el solicitante pueda reintentar.
  procesarEstudioAsync({
    estudioId,
    proveedor: proveedorFinal,
    proveedorAnterior: cambioProveedor ? proveedorAnterior : undefined,
    expedienteId: est.expediente_id,
    providerInput,
    userId,
    ip,
  }).catch((err) => {
    logger.error(
      { error: err, estudioId },
      'procesarEstudioAsync rejected unexpectedly — el estudio puede haber quedado en en_proceso',
    );
  });

  // 7. Responder inmediatamente con el estudio actualizado (estado=en_proceso).
  return getEstudioById(estudioId);
}

/**
 * Ejecuta el provider en background y resuelve el estudio (completado /
 * fallido) en BD. Llamado fire-and-forget desde ejecutarEstudio. NO debe
 * lanzar — todos los errores se traducen a estudio.estado='fallido' con
 * observaciones legibles para el solicitante.
 */
async function procesarEstudioAsync(args: {
  estudioId: string;
  proveedor: string;
  /** Presente solo cuando el reintento cambió de buró — queda en bitácora. */
  proveedorAnterior?: string;
  expedienteId: string;
  providerInput: ProviderSolicitudInput;
  userId: string;
  ip?: string;
}): Promise<void> {
  const { estudioId, proveedor, proveedorAnterior, expedienteId, providerInput, userId, ip } = args;
  const provider = getProvider(proveedor as 'transunion' | 'sifin' | 'datacredito');
  // Nombre legible del buró para los mensajes que ve el gestor: con dos
  // proveedores activos, hardcodear "TransUnion" muestra el buró equivocado.
  const buroLabel = BURO_LABELS[proveedor] ?? proveedor;

  logger.info(
    { estudioId, provider: proveedor, documento: maskDocumento(providerInput.numero_documento) },
    'procesarEstudioAsync: solicitando al proveedor',
  );

  try {
    // GATE 8.4, segunda capa. `ejecutarEstudio` ya lo verificó, pero esta es la
    // última línea antes del fetch al buró: cubre a cualquier caller futuro de
    // procesarEstudioAsync y cierra la ventana entre el lock y la consulta (el
    // titular pudo revocar en el intermedio). `momentoConsulta` es AHORA, que
    // es el instante que tiene que ser posterior a la firma.
    await assertAutorizacionVigente({
      estudioId,
      expedienteId,
      tipoEstudio: providerInput.tipo,
      numeroDocumentoConsultado: providerInput.numero_documento,
      tipoDocumentoConsultado: providerInput.tipo_documento,
      momentoConsulta: new Date(),
    });

    // ponytail: el gate de PAGO (§6.3) NO se repite aquí, a diferencia del 8.4.
    // El 8.4 se repite porque una autorización SE PUEDE revocar entre el lock y
    // el fetch; un pago 'completado' no se des-completa (a 'reembolsado' sí,
    // pero para entonces la consulta ya se hizo). Con el CAS a 'en_proceso' de
    // por medio la ventana es de milisegundos, y procesarEstudioAsync solo se
    // llama desde ejecutarEstudio, que ya lo verificó.

    const response = await provider.solicitar(providerInput);

    // Persistir la referencia con error-check: sin ella no hay forma de
    // recuperar/consultar el estudio después (consulta facturada perdida).
    const { error: refError } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({ referencia_proveedor: response.referencia_proveedor } as never)
      .eq('id', estudioId);
    if (refError) {
      logger.error(
        { error: refError.message, estudioId, referencia: response.referencia_proveedor },
        'CRITICO: no se pudo persistir referencia_proveedor — se continúa con el registro inline',
      );
    }

    logAudit({
      usuarioId: userId,
      accion: AUDIT_ACTIONS.ESTUDIO_PROVIDER_EXECUTED,
      entidad: AUDIT_ENTITIES.ESTUDIO,
      entidadId: estudioId,
      detalle: {
        proveedor,
        ...(proveedorAnterior ? { proveedor_anterior: proveedorAnterior } : {}),
        referencia_proveedor: response.referencia_proveedor,
        expediente_id: expedienteId,
      },
      ip,
    });

    // Proveedores síncronos (TransUnion) devuelven status='completed'.
    if (response.status === 'completed') {
      // Obtener el resultado UNA vez y persistir el crudo ANTES del RPC: el
      // resultado vive solo en el cache en memoria del provider — si el RPC
      // falla y el proceso se reinicia, sin esta persistencia la consulta
      // facturada se perdía y el estudio quedaba en_proceso sin salida.
      let result: ProviderResult | undefined;
      try {
        result = await provider.obtenerResultado(response.referencia_proveedor);
        if (result.datos_crudos) {
          const { error: rawErr } = await (supabase
            .from('estudios' as string) as ReturnType<typeof supabase.from>)
            .update({ respuesta_proveedor: result.datos_crudos as never } as never)
            .eq('id', estudioId);
          if (rawErr) {
            logger.warn({ estudioId, error: rawErr.message }, 'No se pudo persistir respuesta_proveedor (pre-RPC)');
          }
        }
      } catch (resErr) {
        logger.warn(
          { error: resErr instanceof Error ? resErr.message : String(resErr), estudioId },
          'No se pudo pre-obtener el resultado — registrarResultadoInline lo intentará desde el cache',
        );
      }

      try {
        await registrarResultadoInline(estudioId, proveedor, response.referencia_proveedor, expedienteId, result);
        logger.info({ estudioId }, 'Estudio completado exitosamente (async)');
      } catch (postErr) {
        const errMsg = postErr instanceof Error ? postErr.message : String(postErr);
        logger.error(
          { error: errMsg, estudioId },
          'Falló el registro automático del resultado — el estudio queda en en_proceso, el frontend puede disparar consultarEstadoProveedor',
        );
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Error desconocido del proveedor';
    const errorCode = err instanceof AppError ? err.errorCode : null;

    // Gate 8.4 (autorizacion previa) — se evalúa ANTES que las heurísticas de
    // proveedor. El buró no llegó a llamarse: etiquetarlo como "Error de
    // proveedor" y sugerir reintentar ocultaba el único evento que este módulo
    // tiene que registrar bien (p. ej. una revocación entre el lock y el fetch)
    // y mandaba al gestor a un bucle de reintentos que vuelven a fallar.
    const bloqueadoPorAutorizacion = errorCode === AUTORIZACION_PREVIA_ERROR_CODE;

    const lowerErr = errorMsg.toLowerCase();
    // DataCrédito lo señala con su propio errorCode; TransUnion solo con el
    // texto del mensaje, de ahí la mezcla de criterios.
    const documentoNoEncontrado = errorCode === 'PROVIDER_SUBJECT_NOT_FOUND'
      || lowerErr.includes('tercero consultado no existe')
      || lowerErr.includes('no existe en centrales')
      || lowerErr.includes('numero de identificacion invalido')
      || lowerErr.includes('tercero no encontrado');

    // El buró SÍ encontró la cédula, pero el apellido enviado no coincide con
    // Registraduría. El dato a corregir es el nombre del solicitante, no el
    // documento — decir "verifica tu documento" manda a revisar lo que está
    // bien. Solo DataCrédito valida el apellido (TransUnion lo ignora).
    const apellidoNoCoincide = errorCode === 'PROVIDER_LASTNAME_MISMATCH';

    // Buró caído / no disponible (5xx, p.ej. HTTP 520 de Cloudflare) o
    // timeout: es transitorio y del lado del proveedor, no del usuario ni un
    // rechazo de crédito. Mensaje claro para que el gestor sepa que solo hay
    // que reintentar más tarde (suele coincidir con mantenimiento / fuera de
    // horario del ambiente del buró).
    const proveedorNoDisponible =
      errorCode === 'PROVIDER_UNAVAILABLE'
      || errorCode === 'PROVIDER_TIMEOUT'
      || /http 5\d\d/.test(lowerErr)
      || lowerErr.includes('timeout');

    const observaciones = bloqueadoPorAutorizacion
      ? errorMsg
      : apellidoNoCoincide
      ? `${buroLabel} encontró la cédula, pero el PRIMER APELLIDO registrado no coincide con el que enviamos. El documento está bien: hay que corregir el apellido del solicitante para que sea igual al de la Registraduría (solo el primero, sin el segundo) y reintentar.`
      : documentoNoEncontrado
      ? `No encontramos antecedentes con este documento en ${buroLabel}. Cofianza solo puede consultar documentos colombianos: Cédula de Ciudadanía (CC), Cédula de Extranjería (CE), Tarjeta de Identidad (TI) o NIT. Verifica que tu número y tipo de documento sean correctos, o reintenta con el otro buró.`
      : proveedorNoDisponible
        ? `${buroLabel} no está disponible en este momento (posible mantenimiento o caída temporal del servicio). No es un rechazo de crédito: vuelve a intentar la consulta en unos minutos, o usa el otro buró.`
        : `Error de proveedor (${buroLabel}): ${errorMsg}. Puede reintentar o contactar a soporte.`;

    const { error: failError } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'fallido', observaciones } as never)
      .eq('id', estudioId);

    if (failError) {
      logger.error({ error: failError, estudioId }, 'Error al marcar estudio como fallido');
    }

    logAudit({
      usuarioId: userId,
      accion: bloqueadoPorAutorizacion
        ? AUDIT_ACTIONS.ESTUDIO_AUTORIZACION_BLOQUEADA
        : AUDIT_ACTIONS.ESTUDIO_PROVIDER_FAILED,
      entidad: AUDIT_ENTITIES.ESTUDIO,
      entidadId: estudioId,
      detalle: {
        proveedor,
        // Sin esto, un cambio de buró que falla al solicitar dejaba la columna
        // `proveedor` cambiada sin ningún evento que lo registrara.
        ...(proveedorAnterior ? { proveedor_anterior: proveedorAnterior } : {}),
        error: errorMsg,
        documento_no_encontrado: documentoNoEncontrado,
        expediente_id: expedienteId,
      },
      ip,
    });

    logger.error(
      { estudioId, provider: proveedor, error: errorMsg, documentoNoEncontrado, bloqueadoPorAutorizacion },
      bloqueadoPorAutorizacion
        ? 'procesarEstudioAsync: gate 8.4 bloqueó la consulta al buró — estudio marcado como fallido (NO es un fallo del proveedor)'
        : 'procesarEstudioAsync: provider falló — estudio marcado como fallido',
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
  userId?: string,
  userRol?: string,
) {
  // 1. Validate estudio exists and is eligible for re-evaluation
  const { data: estudio, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, resultado, expediente_id')
    .eq('id', estudioId)
    .single();

  if (error || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as { id: string; estado: string; resultado: string; expediente_id: string };

  // Tenant guard: URL de subida firmada a estudios/<id>/soporte/… Sin scoping,
  // la inmobiliaria subía documentos soporte al storage de estudios de OTRA
  // agencia por UUID (write-IDOR).
  await assertExpedienteAccess(est.expediente_id, userId, userRol);

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
  userRol?: string,
) {
  // 1. Re-validate eligibility (race-condition guard)
  const { data: estudio, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, resultado, expediente_id')
    .eq('id', estudioId)
    .single();

  if (error || !estudio) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  const est = estudio as unknown as { id: string; estado: string; resultado: string; expediente_id: string };

  // Tenant guard: registra una fila en estudios_documentos_soporte para este
  // estudio. Sin scoping, la inmobiliaria adjuntaba soportes a estudios de OTRA
  // agencia por UUID (write-IDOR).
  await assertExpedienteAccess(est.expediente_id, userId, userRol);

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
  userRol?: string,
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

  // Tenant guard: crea un nuevo estudio (hijo) sobre el mismo expediente. Sin
  // scoping, la inmobiliaria disparaba re-evaluaciones sobre estudios de OTRA
  // agencia por UUID (write-IDOR).
  await assertExpedienteAccess(est.expediente_id, userId, userRol);

  // Tope de canon (flujo §4.4). La re-evaluacion crea un estudio HIJO, o sea un
  // estudio nuevo: si el inmueble no esta dentro del tope no hay razon para
  // volver a consultar el buro por el.
  //
  // Salvo que el estudio YA se haya cobrado, que es el caso normal aqui: la
  // re-evaluacion se le ofrece al gestor sobre un estudio condicionado o
  // rechazado — o sea despues del pago — y no genera un cobro nuevo (no crea
  // ningun pago; solo inserta el estudio hijo). Bloquearla despues de que el
  // gestor subio los soportes seria cobrar y no entregar. Ver estudioYaCobrado.
  await assertCanonDentroDelTope({
    expedienteId: est.expediente_id,
    origen: 'solicitarReEvaluacion',
    soloAdvertir: await estudioYaCobrado(est.expediente_id),
  });

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

export async function getHistorialReEvaluacion(estudioId: string, userId?: string, userRol?: string) {
  // Tenant guard: el historial expone toda la cadena de estudios del expediente.
  // Resolvemos el expediente del estudio solicitado y verificamos acceso ANTES de
  // recorrer la cadena (las re-evaluaciones heredan el mismo expediente_id). Sin
  // esto, un rol externo con expedientes:read leía la cadena de OTRA agencia (IDOR).
  const { data: baseRow, error: baseErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('expediente_id')
    .eq('id', estudioId)
    .single();

  if (baseErr || !baseRow) {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }

  await assertExpedienteAccess((baseRow as { expediente_id: string }).expediente_id, userId, userRol);

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
// Helper: sincronizar documento del solicitante con el del estudio.
//
// Se llama desde dos puntos para defenderse de fallos silenciosos:
// 1. ejecutarEstudio (antes de disparar TransUnion) — primer intento.
// 2. registrarResultadoInline (despues de TransUnion responder) —
//    red de seguridad. Si el primero fallo, este alinea la BD.
//
// Idempotente: si solicitantes ya tiene los valores correctos, no UPDATE.
// Tolerante a errores: nunca lanza excepcion, solo logguea para no
// abortar el flujo principal del estudio.
// ============================================================
async function sincronizarDocumentoSolicitante(args: {
  estudioId: string;
  solicitanteId: string | null;
  targetNumero: string | null | undefined;
  targetTipo: string | null | undefined;
  /** Primer apellido corregido por el gestor (solo DataCrédito lo valida). */
  targetApellido?: string | null;
  origen: string;
}): Promise<void> {
  const { estudioId, solicitanteId, targetNumero, targetTipo, targetApellido, origen } = args;

  if (!solicitanteId) {
    logger.warn(
      { estudioId, origen },
      'syncDocSolicitante: skip — expediente sin solicitante_id',
    );
    return;
  }

  if (!targetNumero) {
    logger.warn(
      { estudioId, solicitanteId, origen },
      'syncDocSolicitante: skip — datos sin numero_documento',
    );
    return;
  }

  try {
    const { data: solRow, error: solReadErr } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .select('numero_documento, tipo_documento, apellido')
      .eq('id', solicitanteId)
      .maybeSingle();

    if (solReadErr) {
      logger.warn(
        { estudioId, solicitanteId, origen, err: solReadErr.message },
        'syncDocSolicitante: error leyendo solicitante actual',
      );
      return;
    }

    const sol = solRow as {
      numero_documento: string | null;
      tipo_documento: string | null;
      apellido: string | null;
    } | null;

    logger.info(
      {
        estudioId,
        solicitanteId,
        origen,
        target_numero: targetNumero,
        target_tipo: targetTipo,
        sol_numero: sol?.numero_documento,
        sol_tipo: sol?.tipo_documento,
      },
      'syncDocSolicitante: comparando',
    );

    const solUpdates: Record<string, string> = {};
    if (targetNumero && targetNumero !== sol?.numero_documento) {
      solUpdates.numero_documento = targetNumero;
    }
    if (targetTipo && targetTipo !== sol?.tipo_documento) {
      solUpdates.tipo_documento = targetTipo;
    }
    if (targetApellido && targetApellido !== sol?.apellido) {
      solUpdates.apellido = targetApellido;
    }

    if (Object.keys(solUpdates).length === 0) {
      logger.info(
        { estudioId, solicitanteId, origen },
        'syncDocSolicitante: ya estaba alineado, no se actualizo',
      );
      return;
    }

    const { error: solUpdErr, data: updatedRow } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .update(solUpdates as never)
      .eq('id', solicitanteId)
      .select('id, numero_documento, tipo_documento')
      .single();

    if (solUpdErr) {
      logger.warn(
        { estudioId, solicitanteId, origen, err: solUpdErr.message, intento: solUpdates },
        'syncDocSolicitante: UPDATE fallo',
      );
    } else {
      logger.info(
        { estudioId, solicitanteId, origen, cambios: solUpdates, updatedRow },
        'syncDocSolicitante: documento actualizado en BD',
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { estudioId, solicitanteId, origen, err: msg },
      'syncDocSolicitante: excepcion inesperada',
    );
  }
}

// ============================================================
// Registrar resultado inline tras solicitar (proveedor síncrono).
// Reusa la misma RPC + orchestrator que consultarEstadoProveedor,
// pero con logging granular para diagnosticar fallos silenciosos.
// ============================================================

async function registrarResultadoInline(
  estudioId: string,
  proveedorId: string,
  referenciaProveedor: string,
  expedienteId: string,
  resultPreObtenido?: ProviderResult,
): Promise<void> {
  const provider = getProvider(proveedorId as 'transunion' | 'sifin' | 'datacredito');

  logger.info({ estudioId }, 'registrarResultadoInline: obteniendo resultado del provider');
  const result = resultPreObtenido ?? await provider.obtenerResultado(referenciaProveedor);
  logger.info(
    { estudioId, resultado: result.resultado, score: result.score },
    'registrarResultadoInline: resultado obtenido, llamando RPC',
  );

  // Reglas duras V4.1 (§4.2 DTI > 65%, §4.3 canon/ingreso > 40%). Corre ANTES
  // del RPC porque el resultado solo se puede registrar una vez: la funcion
  // rechaza escribir sobre un estudio que ya tiene resultado.
  const decision = await resolverResultadoEstudio({
    estudioId,
    expedienteId,
    resultadoPropuesto: result.resultado,
    score: result.score,
    observaciones: result.observaciones || 'Resultado recibido del proveedor',
    proveedor: proveedorId,
    datosCrudos: result.datos_crudos,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: rpcError } = await (supabase as any).rpc('fn_registrar_resultado_estudio', {
    p_estudio_id: estudioId,
    p_resultado: decision.resultado,
    p_observaciones: decision.observaciones,
    p_score: result.score ?? null,
    p_motivo_rechazo: decision.motivoRechazo,
    p_condiciones: null,
    p_certificado_url: null,
    p_usuario_id: null,
  });

  if (rpcError) {
    logger.error(
      { error: rpcError, estudioId, rpcMessage: rpcError.message, rpcDetails: rpcError.details },
      'RPC fn_registrar_resultado_estudio falló',
    );
    throw AppError.badRequest(
      `RPC falló: ${rpcError.message || 'error desconocido'}`,
      'RPC_REGISTER_RESULT_ERROR',
    );
  }

  // Persistir la respuesta cruda del buró. Sin esto el modal "Detalle del
  // Estudio" queda vacío en cuanto Railway recicla el contenedor (el cache
  // en memoria del provider se borra). La RPC fn_registrar_resultado_estudio
  // no toca este campo — log-only en error para no abortar el flujo, pero
  // logueamos para que se note en monitoring.
  if (result.datos_crudos) {
    const { error: rawErr } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({ respuesta_proveedor: result.datos_crudos as never } as never)
      .eq('id', estudioId);
    if (rawErr) {
      logger.warn(
        { estudioId, error: rawErr.message },
        'No se pudo persistir respuesta_proveedor — el modal del estudio mostrará el reporte vacío',
      );
    }
  }

  // Trazabilidad de la regla dura. Se AWAITEA (no fire-and-forget) porque el
  // hook post-resultado lee esta columna para redactar el mensaje del prospecto.
  await registrarReglaDuraActivada(estudioId, decision.veredicto);

  logger.info({ estudioId }, 'registrarResultadoInline: RPC ejecutada, disparando orchestrator');

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.ESTUDIO_PROVIDER_RESULT_RECEIVED,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: estudioId,
    detalle: {
      proveedor: proveedorId,
      // El resultado REGISTRADO, que puede diferir del que trajo el buro si se
      // activo una regla dura. Se dejan los dos: la auditoria tiene que poder
      // reconstruir quien decidio que.
      resultado: decision.resultado,
      resultado_proveedor: result.resultado,
      reglas_duras: decision.veredicto.rechaza ? decision.veredicto.reglas : null,
      score: result.score,
      referencia_proveedor: referenciaProveedor,
    },
  });

  // Red de seguridad: si el sync de ejecutarEstudio no quedó (por timing
  // del deploy, error transitorio, etc), aqui aseguramos que solicitantes
  // tenga el documento que de verdad fue consultado. Leemos datos_formulario
  // del estudio recien completado y lo comparamos con solicitantes.
  try {
    const { data: estRow } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select('datos_formulario, expediente_id, tipo')
      .eq('id', estudioId)
      .maybeSingle();
    const estData = estRow as { datos_formulario: Record<string, string> | null; expediente_id: string; tipo: string | null } | null;

    // No sincronizar para 'con_coarrendatario': el documento del formulario es
    // del co-arrendatario y sobreescribiría la cédula del titular.
    if (estData?.tipo !== 'con_coarrendatario' && estData?.expediente_id && estData?.datos_formulario) {
      const { data: expRow } = await (supabase
        .from('expedientes' as string) as ReturnType<typeof supabase.from>)
        .select('solicitante_id')
        .eq('id', estData.expediente_id)
        .maybeSingle();
      const expData = expRow as { solicitante_id: string | null } | null;

      await sincronizarDocumentoSolicitante({
        estudioId,
        solicitanteId: expData?.solicitante_id ?? null,
        targetNumero: estData.datos_formulario.numero_documento,
        targetTipo: estData.datos_formulario.tipo_documento,
        origen: 'registrarResultadoInline',
      });
    }
  } catch (err) {
    logger.warn(
      { estudioId, err: err instanceof Error ? err.message : String(err) },
      'syncDocSolicitante (red de seguridad): excepcion preparando inputs',
    );
  }

  // Hook post-resultado. Distinguimos según el tipo de estudio:
  //   - 'individual' (titular): orchestrator normal — transiciona expediente
  //     a aprobado/condicionado/rechazado y dispara emails.
  //   - 'con_coarrendatario': lógica de ponderación que combina con el del
  //     titular. NO disparamos orchestrator porque ya el titular pasó por él
  //     (ahora estamos cerrando el ciclo del par).
  // Fire-and-forget: el resultado del estudio ya quedó persistido vía RPC.
  void dispararHookPostResultado(estudioId, expedienteId, decision.resultado, result.score, decision.veredicto);

  // Registro sombra del scorecard completo (puntajes por variable, umbrales,
  // decision hipotetica). Recibe LA MISMA corrida que decidio arriba, asi que
  // no re-evalua; y sigue siendo best-effort: si este upsert falla, el rechazo
  // por regla dura ya quedo escrito con su motivo.
  void registrarScorecardSombra({
    estudioId,
    expedienteId,
    proveedor: proveedorId,
    datosCrudos: result.datos_crudos,
    scorePersistido: result.score,
    salidaPrecalculada: decision.salida,
  }).catch(() => undefined);
}

// ============================================================
// Check provider status and auto-register result if completed
// ============================================================

export async function consultarEstadoProveedor(estudioId: string, userId?: string, userRol?: string) {
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

  // Tenant guard: además de exponer el detalle del estudio, este endpoint puede
  // consultar al proveedor y auto-registrar el resultado (side-effecting). Sin
  // scoping, un rol externo con estudios:read leía/avanzaba estudios de OTRA
  // agencia por UUID (IDOR). Se gatea ANTES de tocar el proveedor.
  await assertExpedienteAccess(est.expediente_id, userId, userRol);

  // Estudios finalizados: responder desde BD SIN consultar al provider. El
  // cache del provider vive en memoria — tras un restart respondería 'failed'
  // y la rama 4 marcaría 'fallido' un estudio COMPLETADO (revirtiendo un
  // aprobado y habilitando reintentos que facturan consultas de más).
  if (ESTADOS_ESTUDIO_FINALIZADOS.includes(est.estado)) {
    const statusFinal: 'completed' | 'cancelled' | 'failed' =
      est.estado === 'completado' ? 'completed' : est.estado === 'cancelado' ? 'cancelled' : 'failed';
    return {
      provider_status: {
        referencia_proveedor: est.referencia_proveedor ?? '',
        status: statusFinal,
        mensaje: null,
        progreso_porcentaje: null,
      },
      estudio: await getEstudioById(estudioId),
    };
  }

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

    // Reglas duras V4.1 — mismo punto de decision que el camino sincrono.
    const decision = await resolverResultadoEstudio({
      estudioId,
      expedienteId: est.expediente_id,
      resultadoPropuesto: result.resultado,
      score: result.score,
      observaciones: result.observaciones || 'Resultado recibido del proveedor',
      proveedor: est.proveedor,
      datosCrudos: result.datos_crudos,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: rpcError } = await (supabase as any).rpc('fn_registrar_resultado_estudio', {
      p_estudio_id: estudioId,
      p_resultado: decision.resultado,
      p_observaciones: decision.observaciones,
      p_score: result.score ?? null,
      p_motivo_rechazo: decision.motivoRechazo,
      p_condiciones: null,
      p_certificado_url: null,
      p_usuario_id: null,
    });

    if (rpcError) {
      logger.error({ error: rpcError, estudioId }, 'Error al registrar resultado del proveedor via RPC');
      throw AppError.badRequest('Error al registrar el resultado del proveedor', 'PROVIDER_RESULT_ERROR');
    }

    // Persistir respuesta cruda del buró para que el modal de detalle pueda
    // reconstruir el reporte aún si el cache en memoria del provider se perdió.
    if (result.datos_crudos) {
      const { error: rawErr } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .update({ respuesta_proveedor: result.datos_crudos as never } as never)
        .eq('id', estudioId);
      if (rawErr) {
        logger.warn(
          { estudioId, error: rawErr.message },
          'No se pudo persistir respuesta_proveedor (consultarEstado) — el modal del estudio mostrará el reporte vacío',
        );
      }
    }

    // Trazabilidad de la regla dura, antes del hook que la lee.
    await registrarReglaDuraActivada(estudioId, decision.veredicto);

    logAudit({
      usuarioId: null,
      accion: AUDIT_ACTIONS.ESTUDIO_PROVIDER_RESULT_RECEIVED,
      entidad: AUDIT_ENTITIES.ESTUDIO,
      entidadId: estudioId,
      detalle: {
        proveedor: est.proveedor,
        resultado: decision.resultado,
        resultado_proveedor: result.resultado,
        reglas_duras: decision.veredicto.rechaza ? decision.veredicto.reglas : null,
        score: result.score,
        referencia_proveedor: est.referencia_proveedor,
      },
    });

    // Hook post-resultado: ramifica por tipo (orchestrator del titular vs
    // ponderación del coarrendatario). Antes este camino de polling SIEMPRE
    // llamaba al orchestrator, así que un estudio de coarrendatario completado
    // por polling resolvía mal el expediente (no ponderaba con el titular).
    void dispararHookPostResultado(
      estudioId,
      est.expediente_id,
      decision.resultado,
      result.score,
      decision.veredicto,
    );

    // Registro sombra del scorecard completo. Va despues del `if (rpcError)` a
    // proposito: cuando dos pollings concurrentes pasan el guard con el mismo
    // snapshot de `est`, el segundo muere en el RPC y no llega a escribir nada.
    void registrarScorecardSombra({
      estudioId,
      expedienteId: est.expediente_id,
      proveedor: est.proveedor,
      datosCrudos: result.datos_crudos,
      scorePersistido: result.score,
      salidaPrecalculada: decision.salida,
    }).catch(() => undefined);

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
        observaciones:
          'TransUnion no está disponible en este momento (posible mantenimiento o caída temporal). ' +
          'No es un rechazo de crédito: vuelve a intentar la consulta en unos minutos.',
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

/**
 * §5.2 del Flujo de Gerencia (módulo de estudios, PASO 2 — SOLICITANTE):
 *
 *   "Si ya existe un estudio vigente para ese mismo número de documento, el
 *    sistema lo informa y ofrece consultarlo o reutilizarlo, en lugar de crear
 *    uno nuevo y cobrarlo."
 *
 * Se consulta desde el paso 2 del asistente, antes de que exista expediente y
 * antes de cualquier cobro. Devuelve `null` cuando no hay nada que reutilizar,
 * que es el camino normal.
 *
 * La vigencia se ancla en `fecha_completado` con los mismos días que el
 * certificado (`certificateValidityDays`, hoy 60), porque son la misma
 * vigencia: el §4.3 dice que "el estudio conserva su vigencia original".
 *
 * ponytail: filtra en memoria por (tipo, número) tras acotar por los
 * expedientes visibles. Con carteras de este tamaño no compensa un índice
 * nuevo ni un RPC; si algún día pesa, el sitio a mover es esta query.
 */
export async function buscarEstudioVigentePorDocumento(
  tipoDocumento: string,
  numeroDocumento: string,
  userId: string,
  userRol: string,
): Promise<{
  id: string;
  expediente_id: string;
  expediente_numero: string | null;
  resultado: string | null;
  fecha_completado: string | null;
  vigente_hasta: string;
  dias_restantes: number;
} | null> {
  // Scoping: sólo estudios de expedientes que este usuario puede ver. `null`
  // = rol interno sin filtro; `[]` = no ve nada, así que ni consultamos.
  const allowed = await resolveAllowedExpedienteIds(userId, userRol);
  if (allowed !== null && allowed.length === 0) return null;

  const { certificateValidityDays } = await getCompany();
  const validezMs = certificateValidityDays * 24 * 60 * 60 * 1000;
  const desde = new Date(Date.now() - validezMs).toISOString();

  let query = (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, resultado, fecha_completado, datos_formulario, expedientes(numero)')
    .eq('estado', 'completado')
    .gte('fecha_completado', desde)
    .order('fecha_completado', { ascending: false })
    .limit(25);

  if (allowed !== null) query = query.in('expediente_id', allowed);

  const { data, error } = await query as {
    data:
      | {
          id: string;
          expediente_id: string;
          resultado: string | null;
          fecha_completado: string | null;
          datos_formulario: Record<string, unknown> | null;
          expedientes: { numero: string | null } | null;
        }[]
      | null;
    error: { message: string } | null;
  };

  if (error) {
    // No bloqueamos el paso 2 por esto: es un aviso, no un guard.
    logger.warn({ error: error.message }, 'No se pudo buscar un estudio vigente por documento');
    return null;
  }

  const elegido = seleccionarEstudioVigente(data ?? [], tipoDocumento, numeroDocumento, validezMs, Date.now());
  if (!elegido) return null;

  return {
    ...elegido,
    expediente_numero: (data ?? []).find((e) => e.id === elegido.id)?.expedientes?.numero ?? null,
  };
}

/** Fila mínima que `seleccionarEstudioVigente` necesita. */
export interface FilaEstudioVigente {
  id: string;
  expediente_id: string;
  resultado: string | null;
  fecha_completado: string | null;
  datos_formulario: Record<string, unknown> | null;
}

/**
 * Parte PURA del §5.2: de las filas candidatas, cuál corresponde a este
 * documento y cuánta vigencia le queda. Separada de la query para poder
 * ejercitarla sin Supabase (scripts/check-estudio-vigente.ts).
 *
 * El match compara el PAR (tipo, número), no sólo el número: la misma cifra
 * puede existir como CC y como CE y son personas distintas. El tipo se compara
 * sin distinguir mayúsculas y el número se recorta, porque ambos vienen de
 * `datos_formulario`, que es JSON escrito por varios caminos (formulario
 * público, snapshot del solicitante, corrección manual).
 */
export function seleccionarEstudioVigente(
  filas: FilaEstudioVigente[],
  tipoDocumento: string,
  numeroDocumento: string,
  validezMs: number,
  ahoraMs: number,
): {
  id: string;
  expediente_id: string;
  resultado: string | null;
  fecha_completado: string | null;
  vigente_hasta: string;
  dias_restantes: number;
} | null {
  const numero = numeroDocumento.trim();
  const tipo = tipoDocumento.trim().toLowerCase();

  const hit = filas.find((e) => {
    const f = e.datos_formulario ?? {};
    return (
      String(f.numero_documento ?? '').trim() === numero &&
      String(f.tipo_documento ?? '').trim().toLowerCase() === tipo
    );
  });

  if (!hit || !hit.fecha_completado) return null;

  const venceMs = new Date(hit.fecha_completado).getTime() + validezMs;
  // Ya vencido: no es "vigente", aunque la query lo haya traído (el filtro de
  // SQL usa un `gte` sobre la misma ventana, pero el reloj puede correrse
  // entre la consulta y este cálculo).
  if (venceMs <= ahoraMs) return null;

  return {
    id: hit.id,
    expediente_id: hit.expediente_id,
    resultado: hit.resultado,
    fecha_completado: hit.fecha_completado,
    vigente_hasta: new Date(venceMs).toISOString(),
    dias_restantes: Math.max(0, Math.ceil((venceMs - ahoraMs) / (24 * 60 * 60 * 1000))),
  };
}

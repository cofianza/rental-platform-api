import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { esMiembroNoOwnerDeOrg, esOwnerDeOrg, resolveOrgMemberPerfilIds } from '@/lib/tenantScope';
import { notificarYCorreo } from '../notificaciones/notificaciones.service';
import { enviarTemplate as enviarTemplateWhatsApp } from '../whatsapp';
import type {
  CreateExpedienteInput,
  UpdateExpedienteInput,
  ListExpedientesQuery,
} from './expedientes.schema';

// ============================================================
// Types
// ============================================================

interface ExpedienteListRow {
  id: string;
  numero: string;
  estado: string;
  notas: string | null;
  coarrendatario_nombre: string | null;
  coarrendatario_tipo_documento: string | null;
  coarrendatario_documento: string | null;
  coarrendatario_parentesco: string | null;
  analista_id: string | null;
  inmueble_id: string;
  solicitante_id: string;
  creado_por: string | null;
  created_at: string;
  updated_at: string;
  inmueble: { id: string; codigo: string; direccion: string; ciudad: string; tipo: string } | null;
  solicitante: { id: string; nombre: string; apellido: string; tipo_documento: string; numero_documento: string; email: string } | null;
  analista: { id: string; nombre: string; apellido: string } | null;
  creador: { id: string; nombre: string; apellido: string } | null;
  // Computed por el RPC (EXISTS sobre citas con estado='realizada'). Lo usa el
  // frontend para distinguir "Cita previa" vs "Estudio" cuando estado='borrador'.
  cita_realizada: boolean;
}

interface RpcListResult {
  data: ExpedienteListRow[];
  total: number;
}

// Estados terminales (no cuentan como "activos")
const ESTADOS_TERMINALES = ['cerrado', 'rechazado'];

// ============================================================
// Select con relaciones para detalle
// ============================================================

const EXPEDIENTE_DETAIL_SELECT = `
  id, numero, estado, notas,
  coarrendatario_nombre, coarrendatario_tipo_documento, coarrendatario_documento, coarrendatario_parentesco,
  analista_id, inmueble_id, solicitante_id, creado_por, miembro_responsable_id,
  estudio_habilitado, estudio_rechazado, motivo_estudio_rechazado, cita_omitida,
  duracion_contrato_meses, fecha_inicio_contrato,
  cancelado_at, motivo_cancelacion, estado_pre_cancelacion, motivo_rechazo,
  created_at, updated_at,
  inmuebles(id, codigo, direccion, ciudad, departamento, tipo, estado, valor_arriendo),
  solicitantes(id, nombre, apellido, tipo_documento, numero_documento, email, telefono),
  analista:perfiles!expedientes_analista_id_fkey(id, nombre, apellido),
  creador:perfiles!expedientes_creado_por_fkey(id, nombre, apellido)
`;

// ============================================================
// List
// ============================================================

export async function listExpedientes(
  query: ListExpedientesQuery,
  /** IDs de expediente accesibles (scoping multi-tenant). null/undefined = sin
   *  filtro (roles internos). El controller NUNCA pasa [] (cortocircuita antes). */
  allowedExpedienteIds?: string[] | null,
) {
  const { search, estado, analista_id, inmueble_id, fecha_desde, fecha_hasta, estudio_filtro } = query;
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 20;
  const sortBy = query.sortBy || 'created_at';
  const sortOrder = query.sortOrder || 'desc';
  const offset = (page - 1) * limit;

  // Parsear estados comma-separated
  const estados = estado ? estado.split(',').map((s) => s.trim()).filter(Boolean) : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpcParams: Record<string, any> = {
    p_search: search || null,
    p_estados: estados,
    p_analista_id: analista_id || null,
    p_inmueble_id: inmueble_id || null,
    p_fecha_desde: fecha_desde || null,
    p_fecha_hasta: fecha_hasta || null,
    p_sort_field: sortBy,
    p_sort_direction: sortOrder,
    p_limit: limit,
    p_offset: offset,
  };
  // Solo enviamos el filtro de estudio cuando está activo: así el listado base
  // sigue resolviendo con la firma vieja del RPC si la migración del estudio
  // vigente aún no corrió (despliegue desacoplado de la migración).
  if (estudio_filtro && estudio_filtro !== 'todos') {
    rpcParams.p_estudio_filtro = estudio_filtro;
  }
  // Scoping multi-tenant en SQL: solo lo agregamos cuando hay una lista concreta
  // (roles scopeados). Roles internos llegan con null/undefined → sin filtro
  // (el RPC ve todo). Requiere la migración 20260623000003 (param nuevo).
  if (allowedExpedienteIds && allowedExpedienteIds.length > 0) {
    rpcParams.p_allowed_expediente_ids = allowedExpedienteIds;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('list_expedientes_with_relations', rpcParams);

  if (error) {
    logger.error({ error: error.message }, 'Error al listar expedientes');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener la lista de expedientes');
  }

  const result = data as RpcListResult;
  const rows = result?.data || [];
  const total = result?.total || 0;

  return {
    expedientes: rows,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ============================================================
// Check Active Expediente by Inmueble - HP-247
// ============================================================

export async function checkActiveExpedienteByInmueble(inmuebleId: string) {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado')
    .eq('inmueble_id', inmuebleId)
    .not('estado', 'in', `(${ESTADOS_TERMINALES.join(',')})`)
    .limit(1);

  if (error) {
    logger.error({ error: error.message, inmuebleId }, 'Error al verificar expediente activo');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar expediente activo');
  }

  const activeExpediente = data && data.length > 0 ? data[0] : null;

  return {
    hasActiveExpediente: !!activeExpediente,
    expediente: activeExpediente,
  };
}

// ============================================================
// Get MY expediente activo by inmueble (filtrado por solicitante)
//
// A diferencia de checkActiveExpedienteByInmueble (que ve cualquier expediente
// activo del inmueble — usado por admin), esta función filtra por el usuario
// autenticado vía solicitantes.creado_por. Sirve al frontend de vitrina para
// decidir si renderizar "Me interesa" o "Ver mi solicitud →".
// ============================================================

export async function getMiExpedientePorInmueble(inmuebleId: string, userId: string) {
  // Resolver solicitantes del usuario (puede tener varias filas si admin manual,
  // pero típicamente solo 1 desde flujo vitrina).
  const { data: misSolicitantes, error: solErr } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('creado_por', userId);

  if (solErr) {
    logger.error({ error: solErr.message, userId }, 'Error al resolver solicitantes del usuario');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar expediente activo');
  }

  const solIds = ((misSolicitantes as { id: string }[] | null) ?? []).map((s) => s.id);
  if (solIds.length === 0) {
    return { expediente: null };
  }

  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado')
    .eq('inmueble_id', inmuebleId)
    .in('solicitante_id', solIds)
    .not('estado', 'in', `(${ESTADOS_TERMINALES.join(',')})`)
    .limit(1);

  if (error) {
    logger.error({ error: error.message, inmuebleId, userId }, 'Error al consultar mi-expediente-por-inmueble');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar expediente activo');
  }

  return {
    expediente: data && data.length > 0 ? data[0] : null,
  };
}

// ============================================================
// Get by ID
// ============================================================

export async function getExpedienteById(id: string) {
  // Auto-heal de firmas (FALLBACK): si hay un contrato en `pendiente_firma`,
  // reconcilia con Auco. Es un respaldo — la fuente de verdad es el webhook de
  // Auco (reconciliarFirmantesPorWebhook), que actualiza en tiempo real. Por eso
  // se dispara FIRE-AND-FORGET (sin await): antes este sync bloqueaba CADA GET de
  // expediente hasta 5s esperando a Auco, lo que hacía lentísimo abrir un
  // expediente. El front además refresca el panel de firmas (poll + onAllSigned).
  void (async () => {
    try {
      const { syncFirmaConAucoForExpediente } = await import('@/modules/firma/firma.service');
      await syncFirmaConAucoForExpediente(id);
    } catch (err) {
      logger.error({ error: err, expedienteId: id }, 'Error en syncFirmaConAucoForExpediente (background)');
    }
  })();

  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select(EXPEDIENTE_DETAIL_SELECT)
    .eq('id', id)
    .single();

  if (error || !data) {
    if (error?.code === 'PGRST116') {
      throw AppError.notFound('Expediente no encontrado');
    }
    logger.error({ error: error?.message, id }, 'Error al obtener expediente');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el expediente');
  }

  // Mapear relaciones con nombres claros
  const raw = data as unknown as Record<string, unknown>;
  const { inmuebles, solicitantes, analista, creador, ...expediente } = raw;

  return {
    ...expediente,
    inmueble: inmuebles || null,
    solicitante: solicitantes || null,
    analista: analista || null,
    creador: creador || null,
  };
}

/**
 * Aviso por WhatsApp al miembro responsable de un expediente (fire-and-forget).
 * Requiere que su perfil tenga teléfono; si no, enviarTemplate lo omite solo.
 * Complementa el aviso in-app + correo (notificarYCorreo).
 */
async function enviarWhatsAppResponsable(responsableId: string, numero: string, expedienteId: string): Promise<void> {
  try {
    const { data: perfil } = await (supabase
      .from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('nombre, telefono')
      .eq('id', responsableId)
      .maybeSingle();
    const p = perfil as { nombre?: string | null; telefono?: string | null } | null;
    await enviarTemplateWhatsApp({
      to: p?.telefono ?? null,
      template: 'RESPONSABLE_EXPEDIENTE',
      variables: [p?.nombre || 'Hola', numero],
      context: { expediente_id: expedienteId },
    });
  } catch (err) {
    logger.warn({ error: err, responsableId, expedienteId }, 'WhatsApp de responsable de expediente falló');
  }
}

// ============================================================
// Create
// ============================================================

export async function createExpediente(input: CreateExpedienteInput, createdBy: string, ip?: string) {
  // 1. Validar que el inmueble existe
  const { data: inmueble, error: inmuebleError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id, codigo, estado, inmobiliaria_id')
    .eq('id', input.inmueble_id)
    .single();

  if (inmuebleError || !inmueble) {
    throw AppError.badRequest('Inmueble no encontrado. Verifique el ID proporcionado', 'INMUEBLE_NOT_FOUND');
  }

  // 1b. No permitir crear expediente sobre un inmueble ya arrendado o
  //     desactivado. Para volver a arrendar uno 'ocupado' hay que terminar su
  //     contrato vigente (que lo libera a 'disponible').
  const estadoInmueble = (inmueble as { estado?: string }).estado;
  if (estadoInmueble === 'ocupado' || estadoInmueble === 'inactivo') {
    throw AppError.badRequest(
      estadoInmueble === 'ocupado'
        ? 'El inmueble ya está arrendado (contrato vigente). Termina el contrato actual para volver a arrendarlo.'
        : 'El inmueble está inactivo. Actívalo antes de crear un expediente.',
      'INMUEBLE_NO_DISPONIBLE',
    );
  }

  // 2. Validar que el solicitante existe
  const { data: solicitante, error: solicitanteError } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', input.solicitante_id)
    .single();

  if (solicitanteError || !solicitante) {
    throw AppError.badRequest('Solicitante no encontrado. Verifique el ID proporcionado', 'SOLICITANTE_NOT_FOUND');
  }

  // 4. Validar analista (si se proporciona)
  if (input.analista_id) {
    const { data: analista, error: analistaError } = await (supabase
      .from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('id, rol')
      .eq('id', input.analista_id)
      .single();

    if (analistaError || !analista) {
      throw AppError.badRequest('Analista no encontrado. Verifique el ID proporcionado', 'ANALISTA_NOT_FOUND');
    }

    const rol = (analista as unknown as { rol: string }).rol;
    if (!['administrador', 'operador_analista'].includes(rol)) {
      throw AppError.badRequest('El analista debe tener rol de administrador u operador', 'ANALISTA_ROL_INVALIDO');
    }
  }

  // 5. Insertar expediente (numero auto-generado por trigger, estado='borrador')
  const insertData: Record<string, unknown> = {
    inmueble_id: input.inmueble_id,
    solicitante_id: input.solicitante_id,
    creado_por: createdBy,
  };
  // Multi-tenant: denormalizar la organización del inmueble al expediente
  // (el scoping efectivo va por inmueble, pero esto habilita filtros directos
  // y futuras fases sin re-derivar).
  const inmuebleInmobiliariaId = (inmueble as { inmobiliaria_id?: string | null }).inmobiliaria_id;
  if (inmuebleInmobiliariaId) {
    insertData.inmobiliaria_id = inmuebleInmobiliariaId;
    if (input.miembro_responsable_id !== undefined) {
      // Responsable elegido explícitamente al crear (wizard). null = sin asignar.
      if (input.miembro_responsable_id) {
        const memberIds = await resolveOrgMemberPerfilIds(inmuebleInmobiliariaId);
        if (!memberIds.includes(input.miembro_responsable_id)) {
          throw AppError.badRequest('El responsable seleccionado no es miembro activo de tu inmobiliaria', 'MIEMBRO_INVALIDO');
        }
        insertData.miembro_responsable_id = input.miembro_responsable_id;
      }
    } else if (await esMiembroNoOwnerDeOrg(createdBy, inmuebleInmobiliariaId)) {
      // Fase 3.1: sin elección explícita, si el creador es MIEMBRO (no-owner)
      // de la org, queda como responsable automáticamente.
      insertData.miembro_responsable_id = createdBy;
    }
  }
  if (input.analista_id) insertData.analista_id = input.analista_id;
  if (input.notas) insertData.notas = input.notas;
  if (input.coarrendatario_nombre) insertData.coarrendatario_nombre = input.coarrendatario_nombre;
  if (input.coarrendatario_tipo_documento) insertData.coarrendatario_tipo_documento = input.coarrendatario_tipo_documento;
  if (input.coarrendatario_documento) insertData.coarrendatario_documento = input.coarrendatario_documento;
  if (input.coarrendatario_parentesco) insertData.coarrendatario_parentesco = input.coarrendatario_parentesco;

  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .insert(insertData as never)
    .select('id, numero, estado, created_at')
    .single();

  if (error) {
    logger.error({ error: error.message, code: error.code }, 'Error al crear expediente');
    // Índice único parcial idx_expediente_activo_solicitante_inmueble: ya hay un
    // expediente activo (borrador/en_revision/info_incompleta/aprobado/condicionado)
    // para ese mismo solicitante en ese mismo inmueble.
    if (error.code === '23505') {
      if ((error.message || '').includes('idx_expediente_activo_solicitante_inmueble')) {
        throw AppError.conflict(
          'Este solicitante ya tiene un expediente activo para este inmueble. Continúa con el existente o ciérralo antes de crear otro.',
          'EXPEDIENTE_ACTIVO_DUPLICADO',
        );
      }
      throw AppError.conflict('Ya existe un expediente con esos datos.', 'EXPEDIENTE_DUPLICADO');
    }
    if (error.code === '23503') {
      throw AppError.badRequest('Referencia invalida. Verifique los datos proporcionados', 'FK_VIOLATION');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el expediente');
  }

  const created = data as unknown as { id: string; numero: string; estado: string };

  // Fase 3.1: notificar al responsable asignado al crear, salvo que sea el
  // propio creador (no tiene sentido notificarse a sí mismo).
  const responsableAsignado = insertData.miembro_responsable_id as string | undefined;
  if (responsableAsignado && responsableAsignado !== createdBy) {
    await notificarYCorreo({
      userId: responsableAsignado,
      tipo: 'expediente_asignado',
      titulo: 'Expediente asignado',
      mensaje: `Eres responsable del expediente ${created.numero}.`,
      link: `/expedientes/${created.id}`,
    });
    // WhatsApp al responsable (además del in-app + correo). Fire-and-forget.
    void enviarWhatsAppResponsable(responsableAsignado, created.numero, created.id);
  }

  logAudit({
    usuarioId: createdBy,
    accion: AUDIT_ACTIONS.EXPEDIENTE_CREATED,
    entidad: AUDIT_ENTITIES.EXPEDIENTE,
    entidadId: created.id,
    detalle: {
      numero: created.numero,
      inmueble_id: input.inmueble_id,
      solicitante_id: input.solicitante_id,
      analista_id: input.analista_id || null,
    },
    ip,
  });

  // Retornar detalle completo con relaciones
  return getExpedienteById(created.id);
}

// ============================================================
// Update
// ============================================================

export async function updateExpediente(id: string, input: UpdateExpedienteInput, updatedBy: string, ip?: string) {
  const previous = await getExpedienteById(id);

  // Construir solo campos definidos
  const updateData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      updateData[key] = value;
    }
  }

  if (Object.keys(updateData).length === 0) {
    throw AppError.badRequest('No se proporcionaron campos para actualizar');
  }

  // Si cambia analista_id, validar que exista y tenga rol adecuado
  if (updateData.analista_id !== undefined && updateData.analista_id !== null) {
    const { data: analista, error: analistaError } = await (supabase
      .from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('id, rol')
      .eq('id', updateData.analista_id as string)
      .single();

    if (analistaError || !analista) {
      throw AppError.badRequest('Analista no encontrado. Verifique el ID proporcionado', 'ANALISTA_NOT_FOUND');
    }

    const rol = (analista as unknown as { rol: string }).rol;
    if (!['administrador', 'operador_analista'].includes(rol)) {
      throw AppError.badRequest('El analista debe tener rol de administrador u operador', 'ANALISTA_ROL_INVALIDO');
    }
  }

  const { error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .update(updateData as never)
    .eq('id', id);

  if (error) {
    logger.error({ error: error.message, id }, 'Error al actualizar expediente');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al actualizar el expediente');
  }

  // Diff before/after
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(updateData)) {
    before[key] = (previous as unknown as Record<string, unknown>)[key];
  }

  logAudit({
    usuarioId: updatedBy,
    accion: AUDIT_ACTIONS.EXPEDIENTE_UPDATED,
    entidad: AUDIT_ENTITIES.EXPEDIENTE,
    entidadId: id,
    detalle: { before, after: updateData },
    ip,
  });

  return getExpedienteById(id);
}

// ============================================================
// Stats (contadores por estado)
// ============================================================

export async function getExpedienteStats() {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('estado');

  if (error) {
    logger.error({ error: error.message }, 'Error al obtener estadisticas de expedientes');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener estadisticas');
  }

  const rows = (data as unknown as Array<{ estado: string }>) || [];

  // Contar por estado
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.estado] = (counts[row.estado] || 0) + 1;
  }

  // Retornar todos los estados posibles (con 0 si no hay expedientes)
  const allStates = ['borrador', 'en_revision', 'informacion_incompleta', 'aprobado', 'rechazado', 'condicionado', 'cerrado'];
  const stats = allStates.map((estado) => ({
    estado,
    count: counts[estado] || 0,
  }));

  const total = rows.length;

  return { stats, total };
}

// ============================================================
// Asignar miembro responsable del EXPEDIENTE (Fase 3.1) — owner-only
// ============================================================

/**
 * Asigna (o quita, con miembroId=null) el miembro responsable de un expediente.
 * Sólo el TITULAR (owner) de la organización dueña del expediente puede hacerlo
 * y el miembro debe ser miembro ACTIVO de esa misma organización. En modo
 * restringido (miembros_ven_todo=false) el miembro asignado pasa a ver el
 * expediente aunque el inmueble no sea suyo.
 */
export async function asignarMiembroResponsableExpediente(
  expedienteId: string,
  miembroId: string | null,
  userId: string,
): Promise<{ expediente_id: string; miembro_responsable_id: string | null }> {
  const { data: expRow, error: expErr } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, inmobiliaria_id')
    .eq('id', expedienteId)
    .single();
  if (expErr || !expRow) {
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }
  const exp = expRow as unknown as { id: string; numero: string; inmobiliaria_id: string | null };
  if (!exp.inmobiliaria_id) {
    throw AppError.badRequest('El expediente no pertenece a una organización', 'SIN_ORGANIZACION');
  }
  if (!(await esOwnerDeOrg(userId, exp.inmobiliaria_id))) {
    throw AppError.forbidden(
      'Sólo el titular de la inmobiliaria puede asignar el responsable del expediente',
      'NO_ES_OWNER',
    );
  }
  if (miembroId) {
    const memberIds = await resolveOrgMemberPerfilIds(exp.inmobiliaria_id);
    if (!memberIds.includes(miembroId)) {
      throw AppError.badRequest('La persona seleccionada no es miembro activo de tu inmobiliaria', 'MIEMBRO_INVALIDO');
    }
  }

  const { error: updErr } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .update({ miembro_responsable_id: miembroId } as never)
    .eq('id', expedienteId);
  if (updErr) {
    logger.error({ error: updErr.message, expedienteId }, 'Error al asignar responsable de expediente');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo asignar el responsable');
  }

  if (miembroId) {
    await notificarYCorreo({
      userId: miembroId,
      tipo: 'expediente_asignado',
      titulo: 'Expediente asignado',
      mensaje: `Eres responsable del expediente ${exp.numero}.`,
      link: `/expedientes/${expedienteId}`,
    });
    // WhatsApp al responsable (además del in-app + correo). Fire-and-forget.
    void enviarWhatsAppResponsable(miembroId, exp.numero, expedienteId);
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.EXPEDIENTE_UPDATED,
    entidad: AUDIT_ENTITIES.EXPEDIENTE,
    entidadId: expedienteId,
    detalle: { accion: 'asignar_responsable_miembro', miembro_responsable_id: miembroId },
  });

  return { expediente_id: expedienteId, miembro_responsable_id: miembroId };
}

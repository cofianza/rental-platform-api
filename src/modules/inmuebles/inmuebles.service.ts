import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { resolveInmobiliariaIdForPerfil, esOwnerDeOrg, resolveOrgMemberPerfilIds, perfilEsDuenoDeInmueble, assertInmuebleAccess } from '@/lib/tenantScope';
import { notificarYCorreo } from '../notificaciones/notificaciones.service';
import { errorReservaPerdida } from '../estudios/estudios-simultaneos.guard';
import type {
  CreateInmuebleInput,
  UpdateInmuebleInput,
  ListInmueblesQuery,
  SearchInmueblesQuery,
} from './inmuebles.schema';

interface InmuebleRow {
  id: string;
  codigo: string;
  direccion: string;
  ciudad: string;
  barrio: string | null;
  departamento: string;
  tipo: string;
  uso: string;
  destinacion: string | null;
  estrato: number;
  valor_arriendo: number;
  valor_comercial: number | null;
  administracion: number;
  area_m2: number | null;
  habitaciones: number;
  banos: number;
  parqueadero: boolean;
  parqueaderos: number;
  piso: string | null;
  codigo_postal: string | null;
  latitud: number | null;
  longitud: number | null;
  descripcion: string | null;
  notas_internas: string | null;
  estado: string;
  propietario_id: string;
  miembro_responsable_id: string | null;
  /** Expediente que tiene tomada la reserva (Flujo §4.2), o null. */
  reservado_por_expediente_id: string | null;
  visible_vitrina: boolean;
  foto_fachada_url: string | null;
  created_at: string;
  updated_at: string;
  contrato_tipo_storage_key: string | null;
  contrato_tipo_nombre_archivo: string | null;
  contrato_tipo_tamano_bytes: number | null;
  contrato_tipo_subido_por: string | null;
  contrato_tipo_subido_en: string | null;
}

interface InmuebleWithOwnerRow extends InmuebleRow {
  perfiles: { id: string; nombre: string; apellido: string; telefono: string | null } | null;
}

const INMUEBLE_FIELDS = `id, codigo, direccion, ciudad, barrio, departamento, tipo, uso, destinacion, estrato, valor_arriendo, valor_comercial, administracion, area_m2, habitaciones, banos, parqueadero, parqueaderos, piso, codigo_postal, latitud, longitud, descripcion, notas_internas, estado, propietario_id, inmobiliaria_id, miembro_responsable_id, reservado_por_expediente_id, visible_vitrina, foto_fachada_url, propiedad_horizontal, cuarto_util, ubicacion_detallada, created_at, updated_at, contrato_tipo_storage_key, contrato_tipo_nombre_archivo, contrato_tipo_tamano_bytes, contrato_tipo_subido_por, contrato_tipo_subido_en`;

const INMUEBLE_WITH_OWNER = `${INMUEBLE_FIELDS}, perfiles!inmuebles_propietario_id_fkey(id, nombre, apellido, telefono)`;

interface PropietarioWithEmail {
  id: string;
  nombre: string;
  apellido: string;
  telefono: string | null;
  email?: string;
}

function mapWithOwner(row: InmuebleWithOwnerRow) {
  const { perfiles, ...inmueble } = row;
  return {
    ...inmueble,
    propietario: perfiles
      ? { id: perfiles.id, nombre: perfiles.nombre, apellido: perfiles.apellido, telefono: perfiles.telefono } as PropietarioWithEmail
      : null,
  };
}

/**
 * Indicador de estudios en curso por inmueble (Flujo de Gerencia §4.2: "se
 * muestra un indicador con el numero de estudios activos, sin impedir la
 * seleccion").
 *
 * UNA sola consulta por PAGINA de resultados, no una por fila: se pasan los
 * <= limit ids de la pagina a fn_inmuebles_estado_estudios y se mapean de
 * vuelta. Es el mismo patron "query extra + Map" que ya usa getVitrinaAdmin
 * para visitas/contactos. PostgREST no puede agregar a dos saltos
 * (inmuebles -> expedientes -> estudios) en una proyeccion utilizable.
 *
 * Best-effort: si la RPC falla (o todavia no corrio la migracion), las filas
 * salen sin contador. El indicador es informativo — no puede tumbar el listado.
 *
 * Devuelve tambien `reservado` / `arrendado` porque en `estado` las dos son
 * 'ocupado' y la UI necesita distinguir "Reservado" (contrato en proceso) de
 * "Arrendado" (contrato vigente).
 */
async function anotarEstudiosActivos<T extends { id: string }>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('fn_inmuebles_estado_estudios', {
    p_inmueble_ids: rows.map((r) => r.id),
  });

  if (error) {
    logger.warn({ error: error.message }, 'No se pudo calcular el indicador de estudios activos');
    return rows;
  }

  type AgregadoRow = {
    inmueble_id: string;
    estudios_activos: number;
    expedientes_activos: number;
    reservado: boolean;
    arrendado: boolean;
  };
  const porId = new Map<string, AgregadoRow>(
    ((data as AgregadoRow[] | null) ?? []).map((r) => [r.inmueble_id, r]),
  );

  return rows.map((r) => {
    const ag = porId.get(r.id);
    return {
      ...r,
      estudios_activos: ag?.estudios_activos ?? 0,
      expedientes_activos: ag?.expedientes_activos ?? 0,
      reservado: ag?.reservado ?? false,
      arrendado: ag?.arrendado ?? false,
    };
  });
}

export async function listInmuebles(query: ListInmueblesQuery, restrictToIds?: string[] | null) {
  const { search, tipo, uso, estado, ciudad, estrato,
    propietario_id, visible_vitrina, include_inactive } = query;
  // Express 5 req.query es read-only: los defaults de Zod no se aplican, usar fallbacks
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 10;
  const sortBy = query.sortBy || 'created_at';
  const sortOrder = query.sortOrder || 'desc';
  const offset = (page - 1) * limit;

  // Multi-tenant: scoping org-aware. restrictToIds = inmueble IDs visibles para
  // el usuario (su cartera / la de su organización). [] => no ve ninguno.
  if (restrictToIds !== undefined && restrictToIds !== null && restrictToIds.length === 0) {
    return { inmuebles: [], pagination: { total: 0, page, limit, totalPages: 0 } };
  }

  let qb = (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select(INMUEBLE_FIELDS, { count: 'exact' })
    .order(sortBy, { ascending: sortOrder === 'asc' })
    .range(offset, offset + limit - 1);

  if (restrictToIds !== undefined && restrictToIds !== null) {
    qb = qb.in('id', restrictToIds);
  }

  // Excluir inactivos por defecto
  if (estado) {
    qb = qb.eq('estado', estado);
  } else if (include_inactive !== 'true') {
    qb = qb.neq('estado', 'inactivo');
  }

  if (search) {
    // Usar RPC con unaccent() para búsqueda insensible a diacríticos
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: matchIds } = await (supabase as any).rpc('search_inmueble_ids', { p_search: search });
    if (matchIds && matchIds.length > 0) {
      qb = qb.in('id', matchIds.map((r: { id: string }) => r.id));
    } else {
      return {
        inmuebles: [],
        pagination: { total: 0, page, limit, totalPages: 0 },
      };
    }
  }
  if (tipo) qb = qb.eq('tipo', tipo);
  if (uso) qb = qb.eq('uso', uso);
  if (ciudad) qb = qb.ilike('ciudad', `%${ciudad}%`);
  if (estrato) qb = qb.eq('estrato', estrato);
  if (propietario_id) qb = qb.eq('propietario_id', propietario_id);
  if (visible_vitrina !== undefined) {
    qb = qb.eq('visible_vitrina', visible_vitrina === 'true');
  }

  const { data, error, count } = await qb;

  if (error) {
    logger.error({ error: error.message }, 'Error al listar inmuebles');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener la lista de inmuebles');
  }

  const rows = (data as unknown as InmuebleRow[]) || [];
  const total = count ?? 0;

  return {
    // Indicador §4.2: +1 query por pagina, nunca N+1.
    inmuebles: await anotarEstudiosActivos(rows),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getInmuebleById(id: string) {
  const { data, error } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select(INMUEBLE_WITH_OWNER)
    .eq('id', id)
    .single();

  if (error || !data) {
    if (error?.code === 'PGRST116') {
      throw AppError.notFound('Inmueble no encontrado');
    }
    logger.error({ error: error?.message, id }, 'Error al obtener inmueble');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el inmueble');
  }

  const inmueble = mapWithOwner(data as unknown as InmuebleWithOwnerRow);

  // Obtener email del propietario desde auth.users usando RPC
  if (inmueble.propietario) {
    const propietarioId = inmueble.propietario.id;
    try {
      const { data: userData } = await supabase
        .rpc('get_user_with_email' as never, { user_id: propietarioId } as never);

      const userRows = userData as unknown as Array<{ email: string }> | null;
      if (userRows && userRows.length > 0) {
        inmueble.propietario.email = userRows[0].email;
      }
    } catch {
      // Si falla obtener email, continuar sin él
      logger.warn({ propietarioId }, 'No se pudo obtener email del propietario');
    }
  }

  // El detalle tambien lleva el indicador §4.2: la ficha del inmueble es donde
  // el gestor decide si inicia otro estudio.
  const [conIndicador] = await anotarEstudiosActivos([inmueble]);
  return conIndicador;
}

export async function createInmueble(input: CreateInmuebleInput, createdBy: string, ip?: string) {
  // Validar que el propietario exista
  const { data: propietario, error: propError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('id, rol')
    .eq('id', input.propietario_id)
    .single();

  if (propError || !propietario) {
    throw AppError.badRequest(
      'Propietario no encontrado. Verifique el ID proporcionado',
      'PROPIETARIO_NOT_FOUND',
    );
  }

  // Validar que el perfil del propietario tenga los datos para contrato
  // completos. Sin esto, los contratos que se generen luego saldrian con
  // campos vacios. Solo aplica a roles que firman contratos (propietario,
  // inmobiliaria); admin/operador pueden crear inmuebles para terceros
  // sin pasar este check (asumiendo que el propietario asignado los tiene).
  const propRol = (propietario as { rol: string }).rol;
  if (propRol === 'propietario' || propRol === 'inmobiliaria') {
    const { checkPerfilCompletitud } = await import('@/modules/perfil-arrendador/perfil-arrendador.service');
    const { completo, faltantes } = await checkPerfilCompletitud(input.propietario_id);
    if (!completo) {
      throw new AppError(
        400,
        'PERFIL_INCOMPLETO',
        'El propietario debe completar sus Datos para contrato antes de publicar inmuebles.',
        { faltantes, redirectTo: '/configuracion/datos-contrato' },
      );
    }
  }

  // Multi-tenant: si el propietario pertenece a una organización (inmobiliaria),
  // el inmueble se etiqueta con esa organización para que toda su cartera sea
  // visible a los miembros. Propietario individual -> NULL (scoping legacy).
  const inmobiliariaId = await resolveInmobiliariaIdForPerfil(input.propietario_id);
  const insertData: Record<string, unknown> = { ...input };
  if (inmobiliariaId) insertData.inmobiliaria_id = inmobiliariaId;

  const { data, error } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .insert(insertData as never)
    .select(INMUEBLE_FIELDS)
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al crear inmueble');
    if (error.code === '23503') {
      throw AppError.badRequest('Referencia invalida. Verifique los datos proporcionados', 'FK_VIOLATION');
    }
    // 23505 = unique_violation. El unico unique es (propietario_id, codigo),
    // asi que sabemos que el codigo ya esta en uso para ese propietario.
    if (error.code === '23505') {
      throw AppError.conflict(
        `Ya tienes un inmueble con el codigo "${input.codigo}". Usa un codigo diferente.`,
        'CODIGO_DUPLICADO',
      );
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el inmueble');
  }

  const created = data as unknown as InmuebleRow;

  logAudit({
    usuarioId: createdBy,
    accion: AUDIT_ACTIONS.INMUEBLE_CREATED,
    entidad: AUDIT_ENTITIES.INMUEBLE,
    entidadId: created.id,
    detalle: {
      codigo: created.codigo,
      direccion: created.direccion,
      ciudad: created.ciudad,
      tipo: created.tipo,
      propietario_id: created.propietario_id,
    },
    ip,
  });

  return created;
}

export async function updateInmueble(id: string, input: UpdateInmuebleInput, updatedBy: string, updatedByRol?: string, ip?: string) {
  // Guard multi-tenant (por-id): propietario/inmobiliaria solo pueden mutar
  // inmuebles que administran. No-op para roles internos / llamadas sin
  // identidad. 404 cross-tenant (misma fuente de verdad que el resto de by-id).
  await assertInmuebleAccess(id, updatedBy, updatedByRol);

  // Obtener estado anterior para diff
  const previous = await getInmuebleById(id);

  // Un externo (propietario/inmobiliaria) NO puede reasignar el propietario del
  // inmueble: sería un hijack cross-tenant (recalcularía inmobiliaria_id hacia
  // otra org). El create() ya fuerza propietario_id al propio usuario; aquí se
  // rechaza cualquier cambio. Roles internos (admin/operador) sí pueden.
  if (updatedByRol === 'inmobiliaria' || updatedByRol === 'propietario') {
    const prevPropietarioId = (previous as unknown as { propietario_id?: string | null }).propietario_id;
    if (input.propietario_id && input.propietario_id !== prevPropietarioId) {
      throw AppError.forbidden('No puedes cambiar el propietario del inmueble', 'PROPIETARIO_CHANGE_FORBIDDEN');
    }
  }

  // Si cambia propietario, validar que exista
  if (input.propietario_id) {
    const { data: propietario, error: propError } = await (supabase
      .from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('id', input.propietario_id)
      .single();

    if (propError || !propietario) {
      throw AppError.badRequest(
        'Propietario no encontrado. Verifique el ID proporcionado',
        'PROPIETARIO_NOT_FOUND',
      );
    }
  }

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

  // Guard de estado (el PUT general no pasa por la máquina de estados de
  // contratos): liberar un 'ocupado' a mano solo es legítimo si el inmueble NO
  // está comprometido — la liberación real la hace el workflow del contrato
  // (terminar/cancelar). Sin esto, cualquier dueño podía re-publicar un
  // inmueble arrendado con PUT {estado:'disponible'}.
  //
  // Desde el Flujo §4.2 hay DOS formas de estar comprometido, y el guard tiene
  // que cubrir las dos:
  //   1. RESERVADO — `reservado_por_expediente_id` apunta a un expediente cuyo
  //      contrato está en curso pero todavía sin firmar. Es el caso NUEVO: ya
  //      no hay contrato vigente que detectar, así que el guard viejo lo dejaba
  //      pasar y el inmueble volvía 'disponible' CON el titular escrito ->
  //      reaparecía en la vitrina, admitía estudios nuevos, y todos ellos se
  //      estrellaban contra INMUEBLE_YA_RESERVADO al generar su contrato
  //      (callejón sin salida: solo se limpia cerrando el expediente titular).
  //   2. ARRENDADO — contrato vigente. El caso de siempre.
  const prevRow = previous as unknown as Record<string, unknown>;
  const reservadoPorExpedienteId = (prevRow.reservado_por_expediente_id as string | null) ?? null;
  if (input.estado === 'disponible' && prevRow.estado === 'ocupado') {
    if (reservadoPorExpedienteId) {
      throw AppError.conflict(
        'El inmueble está reservado para un candidato aprobado y su contrato está en proceso. ' +
          'Para liberarlo, termina o cancela ese contrato.',
        'INMUEBLE_RESERVADO',
      );
    }
    const contratoVigente = await getContratoVigenteDeInmueble(id);
    if (contratoVigente) {
      throw AppError.conflict(
        'El inmueble tiene un contrato vigente. Para liberarlo, termina o cancela el contrato.',
        'INMUEBLE_CON_CONTRATO_VIGENTE',
      );
    }
  }

  // Guard de vitrina (paridad con toggleVisibility, que este PUT general
  // permitía saltarse). Coerción silenciosa —no error— porque el form de
  // edición precarga el checkbox con el valor actual y lanzar bloquearía
  // ediciones inocentes de un inmueble con flag residual.
  //  1. ENCENDER (false→true) solo se acepta con estado final 'disponible'.
  //  2. En 'ocupado'/'inactivo' el flag no tiene ningún uso (la liberación lo
  //     fuerza a false de todas formas) → se apaga: cada edición auto-sanea
  //     filas rancias. OJO: 'en_estudio' se exime a propósito — ahí el flag
  //     en true se CONSERVA para que el inmueble vuelva solo a la vitrina si
  //     el estudio se cae. (Desde §4.2 'en_estudio' ya no se escribe; la
  //     exención sigue solo por las filas legadas sin normalizar.)
  //  3. RESERVADO (§4.2) → se apaga SIEMPRE, sea cual sea el estado final. Un
  //     inmueble con titular de reserva está comprometido aunque el PUT intente
  //     dejarlo 'disponible'; publicarlo reproduce el bug Apt-001 de la
  //     auditoría de vitrina (panel mostrando "En vitrina" sobre un inmueble
  //     que no admite candidatos nuevos).
  const estadoFinal = (input.estado ?? prevRow.estado) as string;
  if (updateData.visible_vitrina === true) {
    const encendiendo = prevRow.visible_vitrina !== true;
    if (
      (encendiendo && estadoFinal !== 'disponible') ||
      estadoFinal === 'ocupado' ||
      estadoFinal === 'inactivo' ||
      reservadoPorExpedienteId !== null
    ) {
      updateData.visible_vitrina = false;
    }
  }

  // Update atomico via RPC: actualiza inmueble + registra cambios por campo en una transaccion
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rpcResult, error: rpcError } = await (supabase as any).rpc('update_inmueble_con_cambios', {
    p_id: id,
    p_data: updateData,
    p_user_id: updatedBy,
  });

  if (rpcError) {
    logger.error({ error: rpcError, id }, 'Error al actualizar inmueble con cambios');
    if (rpcError.message?.includes('no encontrado')) {
      throw AppError.notFound('Inmueble no encontrado');
    }
    // Unique violation del constraint (propietario_id, codigo) cuando el RPC
    // intenta cambiar el codigo a uno que ya tiene el mismo propietario.
    if (rpcError.code === '23505' || rpcError.message?.includes('codigo')) {
      throw AppError.conflict(
        `El codigo "${input.codigo}" ya esta en uso por otro inmueble del mismo propietario.`,
        'CODIGO_DUPLICADO',
      );
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al actualizar el inmueble');
  }

  // Multi-tenant: si cambió el propietario, recalcular y persistir la
  // organización del inmueble. El RPC update_inmueble_con_cambios NO maneja
  // inmobiliaria_id, así que se actualiza aparte — el inmueble y sus
  // expedientes (que llevan la org denormalizada). Sin esto, un inmueble
  // reasignado seguiría visible para la organización ANTERIOR (fuga de
  // aislamiento entre tenants).
  const prevPropietarioId = (previous as unknown as { propietario_id?: string }).propietario_id;
  if (input.propietario_id && input.propietario_id !== prevPropietarioId) {
    const nuevaInmobiliariaId = await resolveInmobiliariaIdForPerfil(input.propietario_id);
    await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .update({ inmobiliaria_id: nuevaInmobiliariaId } as never)
      .eq('id', id);
    await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .update({ inmobiliaria_id: nuevaInmobiliariaId } as never)
      .eq('inmueble_id', id);
  }

  // Diff before/after para bitacora general (mantener log general)
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(updateData)) {
    before[key] = (previous as unknown as Record<string, unknown>)[key];
  }

  logAudit({
    usuarioId: updatedBy,
    accion: AUDIT_ACTIONS.INMUEBLE_UPDATED,
    entidad: AUDIT_ENTITIES.INMUEBLE,
    entidadId: id,
    detalle: { before, after: updateData, changes_count: rpcResult?.changes_count },
    ip,
  });

  return getInmuebleById(id);
}

export async function deleteInmueble(id: string, deletedBy: string, ip?: string) {
  const current = await getInmuebleById(id);

  if ((current as unknown as Record<string, unknown>).estado === 'inactivo') {
    throw AppError.badRequest('El inmueble ya se encuentra inactivo', 'ALREADY_INACTIVE');
  }

  // Desactivar también lo saca de la vitrina (visible_vitrina=false): mismo
  // criterio que bloquear/liberar — al reactivarlo, el dueño decide cuándo
  // re-publicar (sin esto, un inmueble desactivado estando publicado
  // reaparecía en la vitrina solo con reactivarlo).
  const { error } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'inactivo', visible_vitrina: false } as never)
    .eq('id', id);

  if (error) {
    logger.error({ error: error.message, id }, 'Error al desactivar inmueble');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al desactivar el inmueble');
  }

  logAudit({
    usuarioId: deletedBy,
    accion: AUDIT_ACTIONS.INMUEBLE_DELETED,
    entidad: AUDIT_ENTITIES.INMUEBLE,
    entidadId: id,
    detalle: { codigo: (current as unknown as Record<string, unknown>).codigo },
    ip,
  });

  return getInmuebleById(id);
}

// Mapeo de sortBy del API a columnas de la BD
const SORT_MAP: Record<string, string> = {
  rent_amount: 'valor_arriendo',
  created_at: 'created_at',
  area_m2: 'area_m2',
  city: 'ciudad',
};

export async function searchInmuebles(query: SearchInmueblesQuery, restrictToIds?: string[] | null) {
  const {
    keyword, city, state, property_type,
    stratum_min, stratum_max, rent_min, rent_max,
    area_min, area_max, bedrooms_min, bathrooms_min,
    neighborhood, status,
  } = query;
  // Express 5 req.query es read-only: los defaults de Zod no se aplican
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 20;
  const sortBy = query.sortBy || 'created_at';
  const sortOrder = query.sortOrder || 'desc';
  const offset = (page - 1) * limit;

  // Multi-tenant: restrictToIds = inmueble IDs visibles para el usuario (misma
  // semántica que listInmuebles). [] => no ve ninguno; null/undefined => sin
  // filtro (rol interno).
  if (restrictToIds !== undefined && restrictToIds !== null && restrictToIds.length === 0) {
    return { inmuebles: [], pagination: { total: 0, page, limit, totalPages: 0 } };
  }

  let qb = (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select(INMUEBLE_FIELDS, { count: 'exact' })
    .order(SORT_MAP[sortBy] || 'created_at', { ascending: sortOrder === 'asc' })
    .range(offset, offset + limit - 1);

  if (restrictToIds !== undefined && restrictToIds !== null) {
    qb = qb.in('id', restrictToIds); // ANDs con el .in('id', matchIds) del keyword, igual que list()
  }

  // RN-001: Nunca mostrar inactivos
  if (status) {
    qb = qb.eq('estado', status);
  } else {
    qb = qb.neq('estado', 'inactivo');
  }

  // Keyword: busca con unaccent() para ignorar diacríticos
  if (keyword) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: matchIds } = await (supabase as any).rpc('search_inmueble_ids', { p_search: keyword });
    if (matchIds && matchIds.length > 0) {
      qb = qb.in('id', matchIds.map((r: { id: string }) => r.id));
    } else {
      return {
        inmuebles: [],
        pagination: { total: 0, page, limit, totalPages: 0 },
      };
    }
  }

  if (city) qb = qb.ilike('ciudad', `%${city}%`);
  if (state) qb = qb.ilike('departamento', `%${state}%`);
  if (property_type) qb = qb.eq('tipo', property_type);
  if (neighborhood) qb = qb.ilike('barrio', `%${neighborhood}%`);

  // Rangos
  if (stratum_min) qb = qb.gte('estrato', stratum_min);
  if (stratum_max) qb = qb.lte('estrato', stratum_max);
  if (rent_min) qb = qb.gte('valor_arriendo', rent_min);
  if (rent_max) qb = qb.lte('valor_arriendo', rent_max);
  if (area_min) qb = qb.gte('area_m2', area_min);
  if (area_max) qb = qb.lte('area_m2', area_max);
  if (bedrooms_min) qb = qb.gte('habitaciones', bedrooms_min);
  if (bathrooms_min) qb = qb.gte('banos', bathrooms_min);

  const { data, error, count } = await qb;

  if (error) {
    logger.error({ error: error.message }, 'Error en busqueda de inmuebles');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al buscar inmuebles');
  }

  const rows = (data as unknown as InmuebleRow[]) || [];
  const total = count ?? 0;

  return {
    // Indicador §4.2: +1 query por pagina, nunca N+1.
    inmuebles: await anotarEstudiosActivos(rows),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ============================================================
// Estado del inmueble segun el ciclo del CONTRATO (Flujo de Gerencia §4.2).
//
// Hasta 2026-09-03 el estado seguia el ciclo del ESTUDIO: el primer candidato
// que entraba en estudio dejaba el inmueble 'en_estudio' y ahi se acababa el
// negocio para los demas. §4.2 lo cambio: varios estudios en curso conviven
// sobre la misma propiedad, y la proteccion contra el doble arriendo se corrio
// al final — la propiedad se RESERVA cuando un candidato aprobado avanza a la
// generacion del contrato.
//
// Consecuencias en este archivo:
//   - 'en_estudio' ya NO se escribe (bloquearInmuebleEnEstudio se retiro junto
//     con su unico llamador). El valor sigue en el enum por las filas
//     historicas, y las liberaciones lo siguen aceptando como origen para que
//     cualquier fila rancia se auto-sanee.
//   - validateDisponibleParaEstudio se borro: era codigo muerto (ningun
//     llamador en ninguno de los dos repos) y ademas codificaba justo la regla
//     que §4.2 elimina.
//   - La RESERVA es atomica y vive en la base (fn_reservar_inmueble_para_
//     contrato). Aqui solo esta el envoltorio.
//
// La regla canonica de vitrina NO cambia: publicado <=> visible_vitrina = true
// AND estado = 'disponible'. La reserva usa 'ocupado' precisamente para salir
// de la vitrina por esa misma regla, sin logica nueva.
//
// Fire-and-forget desde los flujos: no deben tumbar el flujo de negocio.
// EXCEPCION: reservarInmuebleParaContrato SI lanza — es la unica barrera
// contra el doble arriendo y tragarse su fallo la anularia.
// ============================================================

/**
 * Bloqueo PERMANENTE: contrato vigente. → ocupado + fuera de vitrina.
 * Simétrico con liberarInmuebleTrasContrato (que también fuerza el flag a
 * false): el dueño decide re-publicar cuando el inmueble vuelva a liberarse.
 * NO pisa un 'inactivo' (soft-delete): misma cortesía que la liberación —
 * si el dueño desactivó el inmueble a mano, ningún flujo automático lo revive.
 *
 * Desde §4.2 este ya no es el PRIMER momento en que el inmueble sale del
 * mercado: la reserva (fn_reservar_inmueble_para_contrato) lo dejó 'ocupado'
 * al generar el contrato. Esta llamada queda como confirmación idempotente al
 * quedar vigente, y sigue cubriendo los caminos que nunca pasaron por una
 * reserva (activación manual, contrato en papel).
 */
export async function bloquearInmuebleOcupado(inmuebleId: string) {
  const { error } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'ocupado', visible_vitrina: false, updated_at: new Date().toISOString() } as never)
    .eq('id', inmuebleId)
    .neq('estado', 'inactivo');
  if (error) logger.warn({ error: error.message, inmuebleId }, 'No se pudo marcar el inmueble como ocupado');
}

/**
 * RESERVA ATOMICA del inmueble de un expediente aprobado que avanza al
 * contrato (Flujo §4.2). Es el punto UNICO donde la propiedad se compromete y
 * la unica barrera contra el doble arriendo.
 *
 * Toda la atomicidad esta en la RPC: SELECT ... FOR UPDATE sobre la fila del
 * inmueble + titular escalar `reservado_por_expediente_id`. De dos aprobaciones
 * concurrentes, la segunda se bloquea en el lock y al despertar lee el titular
 * ya escrito -> pierde. No se replica ninguna decision aqui: hacerlo en JS
 * volveria a abrir la ventana entre leer y escribir.
 *
 * LANZA (no es fire-and-forget) — 409 INMUEBLE_YA_RESERVADO si otro candidato
 * llego primero. El caller debe abortar la generacion del contrato.
 *
 * Idempotente para el propio titular: regenerar el contrato del mismo
 * expediente devuelve `ya_reservado: true` sin error.
 */
export interface ReservaInmuebleResult {
  reservado: boolean;
  ya_reservado: boolean;
  sin_inmueble?: boolean;
  inmueble_id?: string | null;
  inmueble_codigo?: string | null;
  inmueble_direccion?: string | null;
  /** Los DEMAS expedientes con estudio en curso sobre la propiedad (§4.2). */
  afectados: Array<{
    expediente_id: string;
    expediente_numero: string | null;
    solicitante_id: string | null;
    solicitante_nombre: string | null;
    solicitante_apellido: string | null;
    solicitante_email: string | null;
  }>;
}

export async function reservarInmuebleParaContrato(
  expedienteId: string,
): Promise<ReservaInmuebleResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('fn_reservar_inmueble_para_contrato', {
    p_expediente_id: expedienteId,
  });

  if (error) {
    const msg = (error.message || '') as string;
    if (msg.includes('INMUEBLE_YA_RESERVADO')) {
      logger.warn({ expedienteId, detalle: msg }, 'Reserva perdida: la propiedad ya estaba comprometida');
      throw errorReservaPerdida({
        accion: 'conflicto',
        motivo: msg.includes('arrendada') ? 'ocupado' : msg.includes('inactivo') ? 'inactivo' : 'reservado',
        titular: null,
      });
    }
    if (msg.includes('no encontrado')) {
      throw AppError.notFound('Expediente o inmueble no encontrado', 'EXPEDIENTE_NOT_FOUND');
    }
    // ORDEN DE DESPLIEGUE. Si este codigo sale antes de correr la migracion
    // 20260903000005, la RPC no existe y TODA generacion de contrato se
    // detiene. Se falla igual de cerrado —seguir sin reserva es el doble
    // arriendo— pero el mensaje nombra la causa para que se diagnostique en
    // segundos en vez de parecer una caida de la base.
    const faltaMigracion =
      error.code === 'PGRST202' ||
      msg.includes('Could not find the function') ||
      msg.includes('does not exist');
    if (faltaMigracion) {
      logger.error(
        { expedienteId, error: msg },
        'fn_reservar_inmueble_para_contrato no existe — falta correr la migracion 20260903000005; no se genera ningun contrato',
      );
      throw new AppError(
        503,
        'RESERVA_NO_VERIFICABLE',
        'La reserva de propiedades no esta disponible (falta aplicar la migracion de estudios simultaneos). ' +
          'No se genero el contrato para no arriesgar un doble arriendo.',
      );
    }

    // FAIL-CLOSED. Si no podemos confirmar la reserva NO se genera el contrato:
    // seguir seria exactamente el doble arriendo que esta funcion existe para
    // impedir.
    logger.error({ expedienteId, error: msg }, 'No se pudo reservar el inmueble — se aborta la generacion del contrato');
    throw new AppError(
      503,
      'RESERVA_NO_VERIFICABLE',
      'No pudimos confirmar la reserva de la propiedad en este momento, asi que no generamos el contrato. Intenta de nuevo en un momento.',
    );
  }

  const result = (data as ReservaInmuebleResult | null) ?? {
    reservado: false,
    ya_reservado: false,
    afectados: [],
  };
  return { ...result, afectados: result.afectados ?? [] };
}

/**
 * Contrapartida de la reserva: la suelta SOLO si este expediente es su titular.
 *
 * Sustituye a liberarInmuebleEnEstudio en los tres caminos de rechazo/cierre.
 * El criterio del titular es ORTOGONAL al de la migración 20260817000002 ("no
 * liberar si el expediente ya está aprobado"), NO lo subsume: protege de que el
 * rechazo del candidato B suelte la reserva de A, pero no de que un rechazo
 * tardío del PROPIO titular (típicamente el estudio del co-arrendatario, que
 * comparte expediente_id) suelte una reserva con contrato ya en curso. Ese
 * segundo guard vive donde le corresponde, en cada caller:
 *   - fn_registrar_resultado_estudio lo aplica en SQL (estado del expediente +
 *     contrato no terminal) antes de tocar el inmueble.
 *   - liberarReservaSiNoQuedaContratoVivo (expediente-workflow.service.ts) lo
 *     aplica antes de llamar aquí.
 *
 * Fire-and-forget: liberar de menos deja un inmueble bloqueado (molesto,
 * corregible a mano); liberar de más produce doble arriendo. Se falla al lado
 * seguro y se loguea.
 */
export async function liberarReservaDeExpediente(
  expedienteId: string,
  volverDisponible = true,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('fn_liberar_reserva_expediente', {
    p_expediente_id: expedienteId,
    p_volver_disponible: volverDisponible,
  });
  if (error) {
    logger.warn({ error: error.message, expedienteId }, 'No se pudo liberar la reserva del inmueble');
    return false;
  }
  return data === true;
}

/**
 * Liberar al terminar/cancelar el contrato: el inmueble vuelve a 'disponible'.
 * `desde` acota desde qué estados se libera (default: ocupado —contrato
 * vigente terminado— o en_estudio —filas legadas—); el caller de cancelaciones
 * pre-firma pasa solo ['ocupado']. NUNCA revive un 'inactivo' (soft-delete
 * manual). Lo saca de la vitrina (visible_vitrina=false): el dueño decide
 * cuándo re-publicarlo para arrendarlo de nuevo.
 *
 * Limpia además el titular de la reserva: si no lo hiciera, el inmueble
 * quedaría 'disponible' pero con `reservado_por_expediente_id` apuntando a un
 * contrato muerto, y los guards de admisión seguirían viéndolo comprometido.
 *
 * HOLDER-AWARE, igual que su gemela SQL fn_liberar_reserva_expediente: solo
 * libera si el inmueble NO tiene titular o si el titular es `expedienteId` (el
 * expediente cuyo contrato se acaba de terminar/cancelar). Sin esto, cancelar
 * un contrato muerto del expediente A borraba la reserva de B y ponía
 * 'disponible' un inmueble que B tiene arrendado con contrato vigente — el
 * filtro por `desde` no lo evita, porque un inmueble arrendado está justamente
 * en 'ocupado'.
 */
export async function liberarInmuebleTrasContrato(
  inmuebleId: string,
  desde: string[] = ['ocupado', 'en_estudio'],
  expedienteId?: string | null,
) {
  let query = (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'disponible',
      visible_vitrina: false,
      reservado_por_expediente_id: null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', inmuebleId)
    .in('estado', desde);

  if (expedienteId) {
    query = query.or(
      `reservado_por_expediente_id.is.null,reservado_por_expediente_id.eq.${expedienteId}`,
    );
  } else {
    // Sin expediente conocido solo se libera lo que no tiene dueño de reserva:
    // fallar al lado seguro (dejar bloqueado) en vez de pisar la reserva ajena.
    query = query.is('reservado_por_expediente_id', null);
  }

  const { error } = await query;
  if (error) logger.warn({ error: error.message, inmuebleId }, 'No se pudo liberar el inmueble tras contrato');
}

/**
 * Contrato VIGENTE del inmueble (vía sus expedientes), o null. Lo usa el detalle
 * del inmueble para enlazar "Ver contrato" y la acción "Terminar contrato".
 */
export async function getContratoVigenteDeInmueble(
  inmuebleId: string,
  userId?: string,
  userRol?: string,
): Promise<{ id: string; estado: string } | null> {
  // Guard multi-tenant (por-id): externos solo sobre su cartera. No-op para
  // roles internos y para la llamada interna de updateInmueble (sin identidad).
  await assertInmuebleAccess(inmuebleId, userId, userRol);

  const { data: exps } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('inmueble_id', inmuebleId);
  const expIds = ((exps as Array<{ id: string }> | null) ?? []).map((e) => e.id);
  if (expIds.length === 0) return null;

  const { data: contrato } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .in('expediente_id', expIds)
    .eq('estado', 'vigente')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return (contrato as { id: string; estado: string } | null) ?? null;
}

// Toggle vitrina visibility — HP-369. "Pausar" = visible_vitrina=false (el
// inmueble conserva su estado 'disponible', solo deja de mostrarse en la vitrina).
export async function toggleVisibility(
  id: string,
  visible_vitrina: boolean,
  userId: string,
  userRol?: string,
  ip?: string,
) {
  // Verify inmueble exists
  const inmueble = await getInmuebleById(id);
  const row = inmueble as unknown as Record<string, unknown>;
  const estado = row.estado as string;

  // Ownership: inmobiliaria/propietario solo pueden pausar/publicar inmuebles
  // que administran (el endpoint ya no es admin-only). Admin/operador pasan.
  if (userRol === 'inmobiliaria' || userRol === 'propietario') {
    const esDueno = await perfilEsDuenoDeInmueble({
      userId,
      userRol,
      inmueblePropietarioId: (row.propietario_id as string | null) ?? null,
      inmuebleInmobiliariaId: (row.inmobiliaria_id as string | null) ?? null,
    });
    if (!esDueno) {
      throw AppError.forbidden('No tienes permisos sobre este inmueble', 'INMUEBLE_FORBIDDEN');
    }
  }

  // Only available inmuebles can be published
  if (visible_vitrina && estado !== 'disponible') {
    throw AppError.badRequest('Solo inmuebles disponibles pueden publicarse en la vitrina');
  }

  const { error } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .update({ visible_vitrina } as never)
    .eq('id', id);

  if (error) {
    logger.error({ error: error.message, id }, 'Error al actualizar visibilidad de inmueble');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al actualizar la visibilidad del inmueble');
  }

  logger.info({ id, visible_vitrina, userId }, 'Visibilidad de inmueble actualizada — HP-369');

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.INMUEBLE_UPDATED,
    entidad: AUDIT_ENTITIES.INMUEBLE,
    entidadId: id,
    detalle: { visible_vitrina, origen: 'toggle_vitrina' },
    ip,
  });

  return getInmuebleById(id);
}

export async function getFilterOptions(restrictToIds?: string[] | null) {
  // Multi-tenant: null/undefined => sin filtro (rol interno); [] => cartera
  // vacía (opciones vacías); [...] => agregar solo sobre esos inmuebles.
  if (restrictToIds !== undefined && restrictToIds !== null && restrictToIds.length === 0) {
    return {
      ciudades: [],
      departamentos: [],
      tipos: [],
      estados: [],
      estrato: { min: null, max: null },
      valor_arriendo: { min: null, max: null },
    };
  }

  let q = (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('ciudad, departamento, tipo, estrato, valor_arriendo, estado')
    .neq('estado', 'inactivo');

  if (restrictToIds !== undefined && restrictToIds !== null) {
    q = q.in('id', restrictToIds);
  }

  const { data, error } = await q;

  if (error) {
    logger.error({ error: error.message }, 'Error al obtener opciones de filtros');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener opciones de filtros');
  }

  const rows = (data as unknown as Array<{
    ciudad: string;
    departamento: string;
    tipo: string;
    estrato: number;
    valor_arriendo: number;
    estado: string;
  }>) || [];

  const ciudades = [...new Set(rows.map((r) => r.ciudad))].sort();
  const departamentos = [...new Set(rows.map((r) => r.departamento))].sort();
  const tipos = [...new Set(rows.map((r) => r.tipo))].sort();
  const estados = [...new Set(rows.map((r) => r.estado))].sort();
  const estratos = rows.map((r) => r.estrato);
  const arriendos = rows.map((r) => r.valor_arriendo);

  return {
    ciudades,
    departamentos,
    tipos,
    estados,
    estrato: {
      min: estratos.length > 0 ? Math.min(...estratos) : null,
      max: estratos.length > 0 ? Math.max(...estratos) : null,
    },
    valor_arriendo: {
      min: arriendos.length > 0 ? Math.min(...arriendos) : null,
      max: arriendos.length > 0 ? Math.max(...arriendos) : null,
    },
  };
}

// ============================================================
// Asignar miembro responsable (multi-tenant Fase 3) — owner-only
// ============================================================

/**
 * Asigna (o quita, con miembroId=null) el miembro responsable de un inmueble.
 * Sólo el TITULAR (owner) de la organización dueña del inmueble puede hacerlo,
 * y el miembro debe ser miembro ACTIVO de esa misma organización. Relevante
 * cuando miembros_ven_todo=false: el miembro asignado pasa a ver ese inmueble.
 */
export async function asignarMiembroResponsable(
  inmuebleId: string,
  miembroId: string | null,
  userId: string,
): Promise<{ inmueble_id: string; miembro_responsable_id: string | null }> {
  const { data: inmRow, error: inmErr } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id, inmobiliaria_id, codigo, direccion, ciudad')
    .eq('id', inmuebleId)
    .single();
  if (inmErr || !inmRow) {
    throw AppError.notFound('Inmueble no encontrado', 'INMUEBLE_NOT_FOUND');
  }
  const inm = inmRow as unknown as {
    id: string;
    inmobiliaria_id: string | null;
    codigo: string | null;
    direccion: string;
    ciudad: string;
  };
  if (!inm.inmobiliaria_id) {
    throw AppError.badRequest('El inmueble no pertenece a una organización', 'SIN_ORGANIZACION');
  }

  // Sólo el owner de la org dueña puede asignar.
  if (!(await esOwnerDeOrg(userId, inm.inmobiliaria_id))) {
    throw AppError.forbidden('Sólo el titular de la inmobiliaria puede asignar responsables', 'NO_ES_OWNER');
  }

  // El miembro destino debe ser miembro activo de la misma org.
  if (miembroId) {
    const memberIds = await resolveOrgMemberPerfilIds(inm.inmobiliaria_id);
    if (!memberIds.includes(miembroId)) {
      throw AppError.badRequest('La persona seleccionada no es miembro activo de tu inmobiliaria', 'MIEMBRO_INVALIDO');
    }
  }

  const { error: updErr } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .update({ miembro_responsable_id: miembroId } as never)
    .eq('id', inmuebleId);
  if (updErr) {
    logger.error({ error: updErr.message, inmuebleId }, 'Error al asignar miembro responsable');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo asignar el responsable');
  }

  // Notificar al miembro asignado (best-effort).
  if (miembroId) {
    await notificarYCorreo({
      userId: miembroId,
      tipo: 'inmueble_asignado',
      titulo: 'Inmueble asignado',
      mensaje: `Eres responsable del inmueble ${inm.codigo ?? ''} — ${inm.direccion}, ${inm.ciudad}.`.replace('  ', ' '),
      link: `/inmuebles/${inmuebleId}`,
    });
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.INMUEBLE_UPDATED,
    entidad: AUDIT_ENTITIES.INMUEBLE,
    entidadId: inmuebleId,
    detalle: { accion: 'asignar_responsable', miembro_responsable_id: miembroId },
  });

  return { inmueble_id: inmuebleId, miembro_responsable_id: miembroId };
}

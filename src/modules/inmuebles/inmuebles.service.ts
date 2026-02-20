import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
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
  visible_vitrina: boolean;
  foto_fachada_url: string | null;
  created_at: string;
  updated_at: string;
}

interface InmuebleWithOwnerRow extends InmuebleRow {
  perfiles: { id: string; nombre: string; apellido: string; telefono: string | null } | null;
}

const INMUEBLE_FIELDS = `id, codigo, direccion, ciudad, barrio, departamento, tipo, uso, destinacion, estrato, valor_arriendo, valor_comercial, administracion, area_m2, habitaciones, banos, parqueadero, parqueaderos, piso, codigo_postal, latitud, longitud, descripcion, notas_internas, estado, propietario_id, visible_vitrina, foto_fachada_url, created_at, updated_at`;

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

export async function listInmuebles(query: ListInmueblesQuery) {
  const { search, tipo, uso, estado, ciudad, estrato,
    propietario_id, visible_vitrina, include_inactive } = query;
  // Express 5 req.query es read-only: los defaults de Zod no se aplican, usar fallbacks
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 10;
  const sortBy = query.sortBy || 'created_at';
  const sortOrder = query.sortOrder || 'desc';
  const offset = (page - 1) * limit;

  let qb = (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select(INMUEBLE_FIELDS, { count: 'exact' })
    .order(sortBy, { ascending: sortOrder === 'asc' })
    .range(offset, offset + limit - 1);

  // Excluir inactivos por defecto
  if (estado) {
    qb = qb.eq('estado', estado);
  } else if (include_inactive !== 'true') {
    qb = qb.neq('estado', 'inactivo');
  }

  if (search) {
    qb = qb.or(`direccion.ilike.%${search}%,ciudad.ilike.%${search}%,barrio.ilike.%${search}%,codigo.ilike.%${search}%`);
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
    inmuebles: rows,
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
    } catch (err) {
      // Si falla obtener email, continuar sin él
      logger.warn({ propietarioId }, 'No se pudo obtener email del propietario');
    }
  }

  return inmueble;
}

export async function createInmueble(input: CreateInmuebleInput, createdBy: string, ip?: string) {
  // Validar que el propietario exista
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

  const { data, error } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .insert(input as never)
    .select(INMUEBLE_FIELDS)
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al crear inmueble');
    if (error.code === '23503') {
      throw AppError.badRequest('Referencia invalida. Verifique los datos proporcionados', 'FK_VIOLATION');
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

export async function updateInmueble(id: string, input: UpdateInmuebleInput, updatedBy: string, ip?: string) {
  // Obtener estado anterior para diff
  const previous = await getInmuebleById(id);

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
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al actualizar el inmueble');
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

  const { error } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'inactivo' } as never)
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

export async function searchInmuebles(query: SearchInmueblesQuery) {
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

  let qb = (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select(INMUEBLE_FIELDS, { count: 'exact' })
    .order(SORT_MAP[sortBy] || 'created_at', { ascending: sortOrder === 'asc' })
    .range(offset, offset + limit - 1);

  // RN-001: Nunca mostrar inactivos
  if (status) {
    qb = qb.eq('estado', status);
  } else {
    qb = qb.neq('estado', 'inactivo');
  }

  // Keyword: busca en codigo, direccion, ciudad, barrio, descripcion
  if (keyword) {
    qb = qb.or(
      `codigo.ilike.%${keyword}%,direccion.ilike.%${keyword}%,ciudad.ilike.%${keyword}%,barrio.ilike.%${keyword}%,descripcion.ilike.%${keyword}%`,
    );
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
    inmuebles: rows,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Valida que un inmueble no esté en estado 'en_estudio'.
 * Invocable desde el módulo de estudios antes de iniciar uno nuevo (AC 10).
 * @throws 409 si el inmueble ya tiene un estudio en curso.
 */
export async function validateDisponibleParaEstudio(inmuebleId: string) {
  const inmueble = await getInmuebleById(inmuebleId);
  const estado = (inmueble as unknown as Record<string, unknown>).estado;

  if (estado === 'en_estudio') {
    throw new AppError(
      409,
      'INMUEBLE_EN_ESTUDIO',
      'El inmueble ya tiene un estudio en curso. No se permite iniciar otro estudio mientras esté en estado "En Estudio"',
    );
  }

  return inmueble;
}

export async function getFilterOptions() {
  const { data, error } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('ciudad, departamento, tipo, estrato, valor_arriendo, estado')
    .neq('estado', 'inactivo');

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

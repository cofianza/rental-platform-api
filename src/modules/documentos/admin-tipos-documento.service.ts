import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type {
  ListAdminTiposQuery,
  CreateTipoDocumentoInput,
  UpdateTipoDocumentoInput,
  ReordenarTiposInput,
} from './admin-tipos-documento.schema';

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

const TIPO_FIELDS = 'id, codigo, nombre, descripcion, es_obligatorio, formatos_aceptados, tamano_maximo_mb, orden, activo, created_at, updated_at';

function tiposTable() {
  return supabase.from('tipos_documento' as string) as ReturnType<typeof supabase.from>;
}

// ============================================================
// listAllTiposDocumento
// ============================================================

export async function listAllTiposDocumento(query: ListAdminTiposQuery) {
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 20;
  const offset = (page - 1) * limit;

  let qb = tiposTable()
    .select(TIPO_FIELDS, { count: 'exact' })
    .order('orden', { ascending: true })
    .range(offset, offset + limit - 1);

  if (query.activo !== undefined) {
    qb = qb.eq('activo', query.activo === 'true');
  }

  if (query.search) {
    qb = qb.or(`nombre.ilike.%${query.search}%,codigo.ilike.%${query.search}%`);
  }

  const { data, error, count } = await qb;

  if (error) {
    logger.error({ error: error.message }, 'Error al listar tipos de documento (admin)');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener tipos de documento');
  }

  const tipos = (data as unknown as TipoDocumentoRow[]) || [];
  const total = count ?? 0;

  return {
    tipos,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ============================================================
// getTipoDocumentoById
// ============================================================

export async function getTipoDocumentoById(id: string) {
  const { data, error } = await tiposTable()
    .select(TIPO_FIELDS)
    .eq('id', id)
    .single();

  if (error || !data) {
    if (error?.code === 'PGRST116' || !data) {
      throw AppError.notFound('Tipo de documento no encontrado');
    }
    logger.error({ error: error?.message, id }, 'Error al obtener tipo de documento');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener tipo de documento');
  }

  return data as unknown as TipoDocumentoRow;
}

// ============================================================
// createTipoDocumento
// ============================================================

export async function createTipoDocumento(
  input: CreateTipoDocumentoInput,
  userId: string,
  ip?: string,
) {
  // Verificar unicidad de codigo
  const { count, error: countError } = await tiposTable()
    .select('id', { count: 'exact', head: true })
    .eq('codigo', input.codigo);

  if (countError) {
    logger.error({ error: countError.message }, 'Error al verificar codigo unico');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar codigo');
  }

  if ((count ?? 0) > 0) {
    throw AppError.conflict(`Ya existe un tipo de documento con el codigo '${input.codigo}'`);
  }

  const { data, error } = await tiposTable()
    .insert(input as never)
    .select(TIPO_FIELDS)
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al crear tipo de documento');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear tipo de documento');
  }

  const tipo = data as unknown as TipoDocumentoRow;

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.TIPO_DOCUMENTO_CREATED,
    entidad: AUDIT_ENTITIES.TIPO_DOCUMENTO,
    entidadId: tipo.id,
    detalle: { codigo: tipo.codigo, nombre: tipo.nombre },
    ip,
  });

  return tipo;
}

// ============================================================
// updateTipoDocumento
// ============================================================

export async function updateTipoDocumento(
  id: string,
  input: UpdateTipoDocumentoInput,
  userId: string,
  ip?: string,
) {
  const existing = await getTipoDocumentoById(id);

  // Si cambia codigo, verificar unicidad
  if (input.codigo && input.codigo !== existing.codigo) {
    const { count, error: countError } = await tiposTable()
      .select('id', { count: 'exact', head: true })
      .eq('codigo', input.codigo)
      .neq('id', id);

    if (countError) {
      logger.error({ error: countError.message }, 'Error al verificar codigo unico');
      throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar codigo');
    }

    if ((count ?? 0) > 0) {
      throw AppError.conflict(`Ya existe un tipo de documento con el codigo '${input.codigo}'`);
    }
  }

  const { data, error } = await tiposTable()
    .update(input as never)
    .eq('id', id)
    .select(TIPO_FIELDS)
    .single();

  if (error) {
    logger.error({ error: error.message, id }, 'Error al actualizar tipo de documento');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al actualizar tipo de documento');
  }

  const tipo = data as unknown as TipoDocumentoRow;

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.TIPO_DOCUMENTO_UPDATED,
    entidad: AUDIT_ENTITIES.TIPO_DOCUMENTO,
    entidadId: id,
    detalle: { before: existing, after: tipo },
    ip,
  });

  return tipo;
}

// ============================================================
// toggleActivo
// ============================================================

export async function toggleActivo(id: string, userId: string, ip?: string) {
  const existing = await getTipoDocumentoById(id);

  // Si va a desactivar, verificar que no haya documentos pendientes/aprobados
  if (existing.activo) {
    const { count, error: countError } = await (supabase
      .from('documentos' as string) as ReturnType<typeof supabase.from>)
      .select('id', { count: 'exact', head: true })
      .eq('tipo_documento_id', id)
      .in('estado', ['pendiente', 'aprobado']);

    if (countError) {
      logger.error({ error: countError.message, id }, 'Error al verificar documentos asociados');
      throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar documentos asociados');
    }

    if ((count ?? 0) > 0) {
      throw AppError.badRequest(
        `No se puede desactivar: hay ${count} documento(s) pendiente(s) o aprobado(s) de este tipo`,
        'TIPO_HAS_ACTIVE_DOCUMENTS',
      );
    }
  }

  const newActivo = !existing.activo;

  const { data, error } = await tiposTable()
    .update({ activo: newActivo } as never)
    .eq('id', id)
    .select(TIPO_FIELDS)
    .single();

  if (error) {
    logger.error({ error: error.message, id }, 'Error al toggle activo tipo de documento');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al cambiar estado del tipo de documento');
  }

  const tipo = data as unknown as TipoDocumentoRow;

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.TIPO_DOCUMENTO_TOGGLED,
    entidad: AUDIT_ENTITIES.TIPO_DOCUMENTO,
    entidadId: id,
    detalle: { activo_before: existing.activo, activo_after: newActivo },
    ip,
  });

  return tipo;
}

// ============================================================
// reordenarTipos
// ============================================================

export async function reordenarTipos(input: ReordenarTiposInput, userId: string, ip?: string) {
  const ids = input.items.map((i) => i.id);

  // Verificar que todos los IDs existen
  const { count, error: countError } = await tiposTable()
    .select('id', { count: 'exact', head: true })
    .in('id', ids);

  if (countError) {
    logger.error({ error: countError.message }, 'Error al verificar tipos para reordenar');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar tipos de documento');
  }

  if ((count ?? 0) !== ids.length) {
    throw AppError.badRequest('Algunos tipos de documento no existen', 'INVALID_TIPO_IDS');
  }

  // Actualizar orden de cada tipo
  for (const item of input.items) {
    await tiposTable()
      .update({ orden: item.orden } as never)
      .eq('id', item.id);
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.TIPO_DOCUMENTO_REORDERED,
    entidad: AUDIT_ENTITIES.TIPO_DOCUMENTO,
    detalle: { items: input.items },
    ip,
  });

  // Retornar lista actualizada
  const { data, error } = await tiposTable()
    .select(TIPO_FIELDS)
    .order('orden', { ascending: true });

  if (error) {
    logger.error({ error: error.message }, 'Error al obtener tipos reordenados');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener tipos reordenados');
  }

  return (data as unknown as TipoDocumentoRow[]) || [];
}

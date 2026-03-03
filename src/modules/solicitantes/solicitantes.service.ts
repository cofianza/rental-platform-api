import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type {
  CreateApplicantInput,
  UpdateApplicantInput,
  ListApplicantsQuery,
  SearchByDocumentQuery,
} from './solicitantes.schema';

// ============================================================
// Types
// ============================================================

interface ApplicantRow {
  id: string;
  tipo_persona: string;
  nombre: string;
  apellido: string;
  tipo_documento: string;
  numero_documento: string;
  email: string;
  telefono: string | null;
  direccion: string | null;
  departamento: string | null;
  ciudad: string | null;
  ocupacion: string | null;
  actividad_economica: string | null;
  empresa: string | null;
  ingresos_mensuales: number | null;
  nivel_educativo: string | null;
  parentesco: string | null;
  habitara_inmueble: boolean;
  estado: string;
  creado_por: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Constants
// ============================================================

const APPLICANT_FIELDS = `id, tipo_persona, nombre, apellido, tipo_documento, numero_documento, email, telefono, direccion, departamento, ciudad, ocupacion, actividad_economica, empresa, ingresos_mensuales, nivel_educativo, parentesco, habitara_inmueble, estado, creado_por, created_at, updated_at`;

// ============================================================
// List
// ============================================================

export async function listApplicants(query: ListApplicantsQuery) {
  const { search, include_inactive } = query;
  // Express 5 req.query es read-only: los defaults de Zod no se aplican, usar fallbacks
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 20;
  const sortBy = query.sortBy || 'created_at';
  const sortOrder = query.sortOrder || 'desc';
  const offset = (page - 1) * limit;

  let qb = (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select(APPLICANT_FIELDS, { count: 'exact' })
    .order(sortBy, { ascending: sortOrder === 'asc' })
    .range(offset, offset + limit - 1);

  // Excluir inactivos por defecto
  if (include_inactive !== 'true') {
    qb = qb.neq('estado', 'inactivo');
  }

  // Busqueda general: nombre, apellido, numero_documento, email
  if (search) {
    qb = qb.or(
      `nombre.ilike.%${search}%,apellido.ilike.%${search}%,numero_documento.ilike.%${search}%,email.ilike.%${search}%`,
    );
  }

  const { data, error, count } = await qb;

  if (error) {
    logger.error({ error: error.message }, 'Error al listar solicitantes');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener la lista de solicitantes');
  }

  const rows = (data as unknown as ApplicantRow[]) || [];
  const total = count ?? 0;

  return {
    solicitantes: rows,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ============================================================
// Get by ID
// ============================================================

export async function getApplicantById(id: string) {
  const { data, error } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select(APPLICANT_FIELDS)
    .eq('id', id)
    .single();

  if (error || !data) {
    if (error?.code === 'PGRST116') {
      throw AppError.notFound('Solicitante no encontrado');
    }
    logger.error({ error: error?.message, id }, 'Error al obtener solicitante');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el solicitante');
  }

  const applicant = data as unknown as ApplicantRow;

  // Obtener conteo de expedientes asociados
  const { count: expedientesCount, error: countError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .eq('solicitante_id', id);

  if (countError) {
    logger.warn({ error: countError.message, id }, 'Error al contar expedientes del solicitante');
  }

  return {
    ...applicant,
    expedientes_count: expedientesCount ?? 0,
  };
}

// ============================================================
// Create
// ============================================================

export async function createApplicant(input: CreateApplicantInput, createdBy: string, ip?: string) {
  // Validar unicidad tipo_documento + numero_documento
  const { data: existing } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('tipo_documento', input.tipo_documento)
    .eq('numero_documento', input.numero_documento)
    .maybeSingle();

  if (existing) {
    throw AppError.conflict(
      `Ya existe un solicitante con ${input.tipo_documento.toUpperCase()} ${input.numero_documento}`,
      'DOCUMENTO_DUPLICADO',
    );
  }

  const { data, error } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .insert({ ...input, creado_por: createdBy } as never)
    .select(APPLICANT_FIELDS)
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al crear solicitante');
    if (error.code === '23505') {
      throw AppError.conflict(
        `Ya existe un solicitante con ${input.tipo_documento.toUpperCase()} ${input.numero_documento}`,
        'DOCUMENTO_DUPLICADO',
      );
    }
    if (error.code === '23503') {
      throw AppError.badRequest('Referencia invalida. Verifique los datos proporcionados', 'FK_VIOLATION');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el solicitante');
  }

  const created = data as unknown as ApplicantRow;

  logAudit({
    usuarioId: createdBy,
    accion: AUDIT_ACTIONS.SOLICITANTE_CREATED,
    entidad: AUDIT_ENTITIES.SOLICITANTE,
    entidadId: created.id,
    detalle: {
      nombre: created.nombre,
      apellido: created.apellido,
      tipo_documento: created.tipo_documento,
      numero_documento: created.numero_documento,
      email: created.email,
    },
    ip,
  });

  return created;
}

// ============================================================
// Update
// ============================================================

export async function updateApplicant(id: string, input: UpdateApplicantInput, updatedBy: string, ip?: string) {
  // Obtener estado anterior para diff
  const previous = await getApplicantById(id);

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

  // Si cambia tipo_documento o numero_documento, validar unicidad
  const newTipoDoc = (updateData.tipo_documento as string) ?? previous.tipo_documento;
  const newNumDoc = (updateData.numero_documento as string) ?? previous.numero_documento;
  const documentChanged = updateData.tipo_documento !== undefined || updateData.numero_documento !== undefined;

  if (documentChanged) {
    const { data: existing } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('tipo_documento', newTipoDoc)
      .eq('numero_documento', newNumDoc)
      .neq('id', id)
      .maybeSingle();

    if (existing) {
      throw AppError.conflict(
        `Ya existe otro solicitante con ${newTipoDoc.toUpperCase()} ${newNumDoc}`,
        'DOCUMENTO_DUPLICADO',
      );
    }
  }

  const { error } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .update(updateData as never)
    .eq('id', id);

  if (error) {
    logger.error({ error: error.message, id }, 'Error al actualizar solicitante');
    if (error.code === '23505') {
      throw AppError.conflict(
        `Ya existe otro solicitante con ${newTipoDoc.toUpperCase()} ${newNumDoc}`,
        'DOCUMENTO_DUPLICADO',
      );
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al actualizar el solicitante');
  }

  // Diff before/after para bitacora
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(updateData)) {
    before[key] = (previous as unknown as Record<string, unknown>)[key];
  }

  logAudit({
    usuarioId: updatedBy,
    accion: AUDIT_ACTIONS.SOLICITANTE_UPDATED,
    entidad: AUDIT_ENTITIES.SOLICITANTE,
    entidadId: id,
    detalle: { before, after: updateData },
    ip,
  });

  return getApplicantById(id);
}

// ============================================================
// Deactivate (soft delete)
// ============================================================

export async function deactivateApplicant(id: string, deactivatedBy: string, ip?: string) {
  const current = await getApplicantById(id);

  if (current.estado === 'inactivo') {
    throw AppError.badRequest('El solicitante ya se encuentra inactivo', 'ALREADY_INACTIVE');
  }

  const { error } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'inactivo' } as never)
    .eq('id', id);

  if (error) {
    logger.error({ error: error.message, id }, 'Error al desactivar solicitante');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al desactivar el solicitante');
  }

  logAudit({
    usuarioId: deactivatedBy,
    accion: AUDIT_ACTIONS.SOLICITANTE_DEACTIVATED,
    entidad: AUDIT_ENTITIES.SOLICITANTE,
    entidadId: id,
    detalle: {
      nombre: current.nombre,
      apellido: current.apellido,
      tipo_documento: current.tipo_documento,
      numero_documento: current.numero_documento,
      expedientes_asociados: current.expedientes_count,
    },
    ip,
  });

  return getApplicantById(id);
}

// ============================================================
// Search by document
// ============================================================

export async function searchByDocument(query: SearchByDocumentQuery) {
  const { data, error } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select(APPLICANT_FIELDS)
    .eq('tipo_documento', query.document_type)
    .eq('numero_documento', query.document_number)
    .maybeSingle();

  if (error) {
    logger.error({ error: error.message }, 'Error al buscar solicitante por documento');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al buscar solicitante');
  }

  return (data as unknown as ApplicantRow) || null;
}

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type {
  CreatePlantillaInput,
  UpdatePlantillaInput,
  ListPlantillasQuery,
  PreviewPlantillaInput,
} from './plantillas.schema';

// ============================================================
// Helpers
// ============================================================

function extractVariables(contenido: string): string[] {
  const regex = /\{\{(\w+)\}\}/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(contenido)) !== null) {
    found.add(match[1]);
  }
  return Array.from(found);
}

function compileTemplate(contenido: string, variables: Record<string, string>): string {
  return contenido.replace(/\{\{(\w+)\}\}/g, (full, name) => variables[name] ?? full);
}

function buildSampleData(overrides?: Record<string, string>): Record<string, string> {
  const defaults: Record<string, string> = {
    arrendador_nombre: 'Juan Carlos Propietario',
    arrendador_documento: '12.345.678',
    arrendatario_nombre: 'Maria Garcia Arrendataria',
    arrendatario_documento: '87.654.321',
    inmueble_direccion: 'Cra. 15 #45-67 Apto 302',
    inmueble_ciudad: 'Bogota D.C.',
    canon_mensual: '$1.500.000',
    fecha_inicio: '01/04/2026',
    fecha_fin: '31/03/2027',
    duracion_meses: '12',
    deposito: '$1.500.000',
    clausulas_adicionales: 'Sin clausulas adicionales.',
  };
  return { ...defaults, ...(overrides ?? {}) };
}

// ============================================================
// Select string
// ============================================================

const PLANTILLA_SELECT = 'id, nombre, descripcion, contenido, variables, activa, version, creado_por, created_at, updated_at';

// ============================================================
// List
// ============================================================

export async function listPlantillas(query: ListPlantillasQuery) {
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 10;
  const sortBy = query.sortBy || 'created_at';
  const sortDir = query.sortDir || 'desc';
  const offset = (page - 1) * limit;

  // Count
  let countQ = (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true });

  if (query.search) {
    countQ = countQ.ilike('nombre', `%${query.search}%`);
  }
  if (query.activa !== undefined) {
    countQ = countQ.eq('activa', query.activa === 'true');
  }

  const { count } = await countQ;
  const total = count || 0;

  // Data
  let dataQ = (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .select(PLANTILLA_SELECT);

  if (query.search) {
    dataQ = dataQ.ilike('nombre', `%${query.search}%`);
  }
  if (query.activa !== undefined) {
    dataQ = dataQ.eq('activa', query.activa === 'true');
  }

  dataQ = dataQ
    .order(sortBy, { ascending: sortDir === 'asc' })
    .range(offset, offset + limit - 1);

  const { data, error } = await dataQ;

  if (error) {
    logger.error({ error: error.message }, 'Error al listar plantillas');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener plantillas');
  }

  return {
    plantillas: data ?? [],
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

// ============================================================
// Get by ID
// ============================================================

export async function getPlantillaById(id: string) {
  const { data, error } = await (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .select(PLANTILLA_SELECT)
    .eq('id', id)
    .single();

  if (error || !data) {
    throw AppError.notFound('Plantilla no encontrada', 'PLANTILLA_NOT_FOUND');
  }

  return data;
}

// ============================================================
// Create
// ============================================================

export async function createPlantilla(
  input: CreatePlantillaInput,
  userId: string,
  ip?: string,
) {
  const variables = extractVariables(input.contenido);

  const { data, error } = await (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .insert({
      nombre: input.nombre,
      descripcion: input.descripcion ?? null,
      contenido: input.contenido,
      variables,
      activa: input.activa ?? true,
      version: 1,
      creado_por: userId,
    } as never)
    .select('id')
    .single();

  if (error || !data) {
    logger.error({ error: error?.message }, 'Error al crear plantilla');
    if (error?.code === '23505') {
      throw AppError.conflict('Ya existe una plantilla con ese nombre', 'PLANTILLA_DUPLICATE');
    }
    throw AppError.badRequest('Error al crear la plantilla', 'PLANTILLA_CREATE_ERROR');
  }

  const created = data as unknown as { id: string };

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PLANTILLA_CREATED,
    entidad: AUDIT_ENTITIES.PLANTILLA,
    entidadId: created.id,
    detalle: { nombre: input.nombre, variables },
    ip,
  });

  return getPlantillaById(created.id);
}

// ============================================================
// Update
// ============================================================

export async function updatePlantilla(
  id: string,
  input: UpdatePlantillaInput,
  userId: string,
  ip?: string,
) {
  const previous = await getPlantillaById(id);
  const prev = previous as unknown as { contenido: string; version: number; nombre: string };

  const updateData: Record<string, unknown> = {};

  if (input.nombre !== undefined) updateData.nombre = input.nombre;
  if (input.descripcion !== undefined) updateData.descripcion = input.descripcion;
  if (input.activa !== undefined) updateData.activa = input.activa;

  if (input.contenido !== undefined) {
    updateData.contenido = input.contenido;
    updateData.variables = extractVariables(input.contenido);
    if (input.contenido !== prev.contenido) {
      updateData.version = prev.version + 1;
    }
  }

  if (Object.keys(updateData).length === 0) {
    throw AppError.badRequest('No se proporcionaron campos para actualizar', 'NO_FIELDS');
  }

  const { error } = await (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .update(updateData as never)
    .eq('id', id);

  if (error) {
    logger.error({ error: error.message, id }, 'Error al actualizar plantilla');
    if (error.code === '23505') {
      throw AppError.conflict('Ya existe una plantilla con ese nombre', 'PLANTILLA_DUPLICATE');
    }
    throw AppError.badRequest('Error al actualizar la plantilla', 'PLANTILLA_UPDATE_ERROR');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PLANTILLA_UPDATED,
    entidad: AUDIT_ENTITIES.PLANTILLA,
    entidadId: id,
    detalle: { campos_actualizados: Object.keys(updateData) },
    ip,
  });

  return getPlantillaById(id);
}

// ============================================================
// Delete (soft)
// ============================================================

export async function deletePlantilla(id: string, userId: string, ip?: string) {
  const plantilla = await getPlantillaById(id);
  const row = plantilla as unknown as { nombre: string; activa: boolean };

  if (!row.activa) {
    throw AppError.badRequest('La plantilla ya esta inactiva', 'PLANTILLA_ALREADY_INACTIVE');
  }

  // Check for contratos referencing this plantilla
  const { data: contratos } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('plantilla_id', id)
    .limit(1);

  if (contratos && contratos.length > 0) {
    throw AppError.conflict(
      'No se puede desactivar la plantilla porque tiene contratos asociados',
      'PLANTILLA_HAS_CONTRATOS',
    );
  }

  const { error } = await (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .update({ activa: false } as never)
    .eq('id', id);

  if (error) {
    logger.error({ error: error.message, id }, 'Error al desactivar plantilla');
    throw AppError.badRequest('Error al desactivar la plantilla', 'PLANTILLA_DELETE_ERROR');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PLANTILLA_DELETED,
    entidad: AUDIT_ENTITIES.PLANTILLA,
    entidadId: id,
    detalle: { nombre: row.nombre },
    ip,
  });

  return { id, activa: false };
}

// ============================================================
// Preview
// ============================================================

export async function previewPlantilla(id: string, input: PreviewPlantillaInput) {
  const plantilla = await getPlantillaById(id);
  const row = plantilla as unknown as { contenido: string; nombre: string; variables: string[] };

  const sampleData = buildSampleData(input.variables);
  const html = compileTemplate(row.contenido, sampleData);

  return {
    nombre: row.nombre,
    html,
    variables_used: row.variables,
  };
}

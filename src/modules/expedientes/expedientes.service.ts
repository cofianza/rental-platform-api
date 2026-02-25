import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
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
  codeudor_nombre: string | null;
  codeudor_tipo_documento: string | null;
  codeudor_documento: string | null;
  codeudor_parentesco: string | null;
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
  codeudor_nombre, codeudor_tipo_documento, codeudor_documento, codeudor_parentesco,
  analista_id, inmueble_id, solicitante_id, creado_por,
  created_at, updated_at,
  inmuebles(id, codigo, direccion, ciudad, departamento, tipo, estado, valor_arriendo),
  solicitantes(id, nombre, apellido, tipo_documento, numero_documento, email, telefono),
  analista:perfiles!expedientes_analista_id_fkey(id, nombre, apellido),
  creador:perfiles!expedientes_creado_por_fkey(id, nombre, apellido)
`;

// ============================================================
// List
// ============================================================

export async function listExpedientes(query: ListExpedientesQuery) {
  const { search, estado, analista_id, inmueble_id, fecha_desde, fecha_hasta } = query;
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 20;
  const sortBy = query.sortBy || 'created_at';
  const sortOrder = query.sortOrder || 'desc';
  const offset = (page - 1) * limit;

  // Parsear estados comma-separated
  const estados = estado ? estado.split(',').map((s) => s.trim()).filter(Boolean) : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('list_expedientes_with_relations', {
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
  });

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
// Get by ID
// ============================================================

export async function getExpedienteById(id: string) {
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

// ============================================================
// Create
// ============================================================

export async function createExpediente(input: CreateExpedienteInput, createdBy: string, ip?: string) {
  // 1. Validar que el inmueble existe
  const { data: inmueble, error: inmuebleError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id, codigo, estado')
    .eq('id', input.inmueble_id)
    .single();

  if (inmuebleError || !inmueble) {
    throw AppError.badRequest('Inmueble no encontrado. Verifique el ID proporcionado', 'INMUEBLE_NOT_FOUND');
  }

  // 2. Validar que el inmueble NO tiene un expediente activo
  const { data: expedienteActivo } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado')
    .eq('inmueble_id', input.inmueble_id)
    .not('estado', 'in', `(${ESTADOS_TERMINALES.join(',')})`)
    .limit(1)
    .maybeSingle();

  if (expedienteActivo) {
    const exp = expedienteActivo as unknown as { numero: string; estado: string };
    throw AppError.conflict(
      `El inmueble ya tiene un expediente activo: ${exp.numero} (estado: ${exp.estado})`,
      'INMUEBLE_CON_EXPEDIENTE_ACTIVO',
    );
  }

  // 3. Validar que el solicitante existe
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
  if (input.analista_id) insertData.analista_id = input.analista_id;
  if (input.notas) insertData.notas = input.notas;
  if (input.codeudor_nombre) insertData.codeudor_nombre = input.codeudor_nombre;
  if (input.codeudor_tipo_documento) insertData.codeudor_tipo_documento = input.codeudor_tipo_documento;
  if (input.codeudor_documento) insertData.codeudor_documento = input.codeudor_documento;
  if (input.codeudor_parentesco) insertData.codeudor_parentesco = input.codeudor_parentesco;

  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .insert(insertData as never)
    .select('id, numero, estado, created_at')
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al crear expediente');
    if (error.code === '23503') {
      throw AppError.badRequest('Referencia invalida. Verifique los datos proporcionados', 'FK_VIOLATION');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el expediente');
  }

  const created = data as unknown as { id: string; numero: string; estado: string };

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

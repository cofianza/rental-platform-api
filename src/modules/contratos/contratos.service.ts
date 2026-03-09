import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { generateContractPdf } from './contratos.pdf';
import type {
  GenerarContratoInput,
  RenovarContratoInput,
  ReGenerarContratoInput,
  ListContratosQuery,
  ListAllContratosQuery,
} from './contratos.schema';

// ============================================================
// Constants
// ============================================================

const BUCKET_NAME = 'documentos-expedientes';
const DOWNLOAD_URL_EXPIRY_SECONDS = 900; // 15 minutes

const CONTRATO_SELECT = `
  id, expediente_id, plantilla_id, version, estado,
  contenido_pdf_url, documento_firmado_url,
  fecha_inicio, fecha_fin, duracion_meses, valor_arriendo,
  datos_variables, generado_por, fecha_generacion,
  storage_key, nombre_archivo, plantilla_version,
  created_at, updated_at
`;

const CONTRATO_LIST_SELECT = `
  id, expediente_id, plantilla_id, version, estado,
  fecha_inicio, duracion_meses, valor_arriendo,
  nombre_archivo, fecha_generacion, plantilla_version,
  storage_key, created_at, updated_at
`;

const VERSION_SELECT = `
  id, contrato_id, version, datos_variables, storage_key,
  nombre_archivo, plantilla_version, generado_por,
  fecha_generacion, resumen_cambios, created_at
`;

// ============================================================
// Helpers
// ============================================================

function compileTemplate(contenido: string, variables: Record<string, string>): string {
  return contenido.replace(/\{\{(\w+)\}\}/g, (full, name) => variables[name] ?? full);
}

function formatCurrencyCOP(value: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateCO(date: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function generateResumenCambios(
  oldVars: Record<string, string>,
  newVars: Record<string, string>,
): string {
  const changes: string[] = [];
  const allKeys = new Set([...Object.keys(oldVars), ...Object.keys(newVars)]);

  for (const key of allKeys) {
    const oldVal = oldVars[key];
    const newVal = newVars[key];

    if (oldVal === undefined && newVal !== undefined) {
      changes.push(`"${key}" agregada: "${newVal}"`);
    } else if (oldVal !== undefined && newVal === undefined) {
      changes.push(`"${key}" eliminada (era: "${oldVal}")`);
    } else if (oldVal !== newVal) {
      changes.push(`"${key}" cambio de "${oldVal}" a "${newVal}"`);
    }
  }

  return changes.length === 0
    ? 'Sin cambios en variables'
    : changes.join('; ');
}

async function archiveCurrentVersion(
  contrato: {
    id: string;
    version: number;
    datos_variables: Record<string, string> | null;
    storage_key: string;
    nombre_archivo: string | null;
    plantilla_version: number | null;
    generado_por: string | null;
    fecha_generacion: string | null;
  },
  resumenCambios: string,
): Promise<void> {
  const { error } = await (supabase
    .from('contrato_versiones' as string) as ReturnType<typeof supabase.from>)
    .insert({
      contrato_id: contrato.id,
      version: contrato.version,
      datos_variables: contrato.datos_variables,
      storage_key: contrato.storage_key,
      nombre_archivo: contrato.nombre_archivo,
      plantilla_version: contrato.plantilla_version,
      generado_por: contrato.generado_por,
      fecha_generacion: contrato.fecha_generacion,
      resumen_cambios: resumenCambios,
    } as never);

  if (error) {
    logger.error({ error: error.message }, 'Error al archivar version de contrato');
    throw new AppError(500, 'ARCHIVE_ERROR', 'Error al archivar la version anterior del contrato');
  }
}

interface ExpedienteData {
  inmueble: {
    direccion: string;
    ciudad: string;
    valor_arriendo: number;
    propietario_id: string;
  };
  solicitante: {
    nombre: string;
    apellido: string;
    tipo_documento: string;
    numero_documento: string;
  };
  propietario: {
    nombre: string;
    apellido: string;
    numero_documento: string;
  };
}

function buildVariablesFromExpediente(
  data: ExpedienteData,
  fechaInicio: Date,
  duracionMeses: number,
): Record<string, string> {
  const fechaFin = addMonths(fechaInicio, duracionMeses);

  return {
    arrendador_nombre: `${data.propietario.nombre} ${data.propietario.apellido}`,
    arrendador_documento: data.propietario.numero_documento || '',
    arrendatario_nombre: `${data.solicitante.nombre} ${data.solicitante.apellido}`,
    arrendatario_documento: data.solicitante.numero_documento || '',
    inmueble_direccion: data.inmueble.direccion,
    inmueble_ciudad: data.inmueble.ciudad,
    canon_mensual: formatCurrencyCOP(data.inmueble.valor_arriendo || 0),
    fecha_inicio: formatDateCO(fechaInicio),
    fecha_fin: formatDateCO(fechaFin),
    duracion_meses: String(duracionMeses),
    deposito: formatCurrencyCOP(data.inmueble.valor_arriendo || 0),
    clausulas_adicionales: '',
  };
}

async function fetchExpedienteData(expedienteId: string): Promise<{
  expediente: Record<string, unknown>;
  data: ExpedienteData;
}> {
  // 1. Fetch expediente with inmueble + solicitante
  const { data: expediente, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, numero, estado, inmueble_id, solicitante_id,
      inmuebles(id, direccion, ciudad, valor_arriendo, propietario_id),
      solicitantes(id, nombre, apellido, tipo_documento, numero_documento)
    `)
    .eq('id', expedienteId)
    .single();

  if (error || !expediente) {
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  const exp = expediente as unknown as {
    id: string;
    numero: string;
    estado: string;
    inmueble_id: string;
    solicitante_id: string;
    inmuebles: { id: string; direccion: string; ciudad: string; valor_arriendo: number; propietario_id: string };
    solicitantes: { id: string; nombre: string; apellido: string; tipo_documento: string; numero_documento: string };
  };

  if (!exp.inmuebles) {
    throw AppError.badRequest('El expediente no tiene inmueble asociado', 'NO_INMUEBLE');
  }
  if (!exp.solicitantes) {
    throw AppError.badRequest('El expediente no tiene solicitante asociado', 'NO_SOLICITANTE');
  }

  // 2. Fetch propietario (owner) from perfiles via inmueble.propietario_id
  const { data: propietario, error: propError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre, apellido, numero_documento')
    .eq('id', exp.inmuebles.propietario_id)
    .single();

  if (propError || !propietario) {
    throw AppError.badRequest('No se encontro el propietario del inmueble', 'NO_PROPIETARIO');
  }

  const prop = propietario as unknown as { id: string; nombre: string; apellido: string; numero_documento: string };

  return {
    expediente: expediente as Record<string, unknown>,
    data: {
      inmueble: exp.inmuebles,
      solicitante: exp.solicitantes,
      propietario: prop,
    },
  };
}

// ============================================================
// List all contratos (global)
// ============================================================

const CONTRATO_LIST_WITH_RELATIONS = `
  ${CONTRATO_LIST_SELECT},
  expedientes(numero, inmuebles(direccion, ciudad))
`;

export async function listAllContratos(query: ListAllContratosQuery) {
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 10;
  const sortBy = query.sortBy || 'created_at';
  const sortDir = query.sortDir || 'desc';
  const offset = (page - 1) * limit;

  // Build filters helper
  function applyFilters(qb: ReturnType<typeof supabase.from>) {
    let q = qb as any;
    if (query.estado) {
      const estados = query.estado.split(',').map((s) => s.trim()).filter(Boolean);
      if (estados.length > 0) q = q.in('estado', estados);
    }
    if (query.search) {
      q = q.ilike('nombre_archivo', `%${query.search}%`);
    }
    if (query.fecha_desde) {
      q = q.gte('fecha_generacion', query.fecha_desde);
    }
    if (query.fecha_hasta) {
      q = q.lte('fecha_generacion', `${query.fecha_hasta}T23:59:59`);
    }
    return q;
  }

  // Count
  const countQb = (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true });
  const { count } = await applyFilters(countQb);
  const total = count || 0;

  // Data
  const dataQb = (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select(CONTRATO_LIST_WITH_RELATIONS)
    .order(sortBy, { ascending: sortDir === 'asc' })
    .range(offset, offset + limit - 1);
  const { data, error } = await applyFilters(dataQb);

  if (error) {
    logger.error({ error: error.message }, 'Error al listar contratos (global)');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener contratos');
  }

  return {
    contratos: data ?? [],
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

// ============================================================
// List contratos by expediente
// ============================================================

export async function listContratosByExpediente(
  expedienteId: string,
  query: ListContratosQuery,
) {
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 10;
  const sortBy = query.sortBy || 'created_at';
  const sortDir = query.sortDir || 'desc';
  const offset = (page - 1) * limit;

  // Count
  const { count } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .eq('expediente_id', expedienteId);

  const total = count || 0;

  // Data
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select(CONTRATO_LIST_SELECT)
    .eq('expediente_id', expedienteId)
    .order(sortBy, { ascending: sortDir === 'asc' })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error({ error: error.message }, 'Error al listar contratos');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener contratos');
  }

  return {
    contratos: data ?? [],
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

// ============================================================
// Get contrato by ID
// ============================================================

export async function getContratoById(id: string) {
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select(CONTRATO_SELECT)
    .eq('id', id)
    .single();

  if (error || !data) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  return data;
}

// ============================================================
// Generar contrato
// ============================================================

export async function generarContrato(
  expedienteId: string,
  input: GenerarContratoInput,
  userId: string,
  ip?: string,
) {
  // 1. Fetch expediente data
  const { data: expData } = await fetchExpedienteData(expedienteId);

  // 2. Fetch plantilla
  const { data: plantilla, error: plantillaError } = await (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre, contenido, variables, activa, version')
    .eq('id', input.plantilla_id)
    .single();

  if (plantillaError || !plantilla) {
    throw AppError.notFound('Plantilla no encontrada', 'PLANTILLA_NOT_FOUND');
  }

  const pl = plantilla as unknown as {
    id: string; nombre: string; contenido: string;
    variables: string[]; activa: boolean; version: number;
  };

  if (!pl.activa) {
    throw AppError.badRequest('La plantilla no esta activa', 'PLANTILLA_INACTIVE');
  }

  // 3. Build variables
  const fechaInicio = input.fecha_inicio
    ? new Date(input.fecha_inicio + 'T00:00:00')
    : new Date();
  const duracionMeses = input.duracion_meses || 12;

  const autoVariables = buildVariablesFromExpediente(expData, fechaInicio, duracionMeses);
  const finalVariables = { ...autoVariables, ...(input.variables ?? {}) };

  // 4. Compile HTML
  const compiledHtml = compileTemplate(pl.contenido, finalVariables);

  // 5. Generate PDF
  const now = new Date();
  const pdfBuffer = await generateContractPdf(compiledHtml, {
    titulo: pl.nombre,
    fecha: formatDateCO(now),
    version: 1,
  });

  // 6. Insert contrato first to get ID
  const { data: contrato, error: insertError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      plantilla_id: input.plantilla_id,
      version: 1,
      estado: 'borrador',
      fecha_inicio: input.fecha_inicio || now.toISOString().split('T')[0],
      fecha_fin: addMonths(fechaInicio, duracionMeses).toISOString().split('T')[0],
      duracion_meses: duracionMeses,
      valor_arriendo: expData.inmueble.valor_arriendo || 0,
      datos_variables: finalVariables,
      generado_por: userId,
      fecha_generacion: now.toISOString(),
      plantilla_version: pl.version,
      nombre_archivo: `contrato-${pl.nombre.toLowerCase().replace(/\s+/g, '-')}-v1.pdf`,
    } as never)
    .select('id')
    .single();

  if (insertError || !contrato) {
    logger.error({ error: insertError?.message }, 'Error al crear contrato');
    throw AppError.badRequest('Error al crear el contrato', 'CONTRATO_CREATE_ERROR');
  }

  const created = contrato as unknown as { id: string };

  // 7. Upload PDF to storage
  const storageKey = `contratos/${expedienteId}/${created.id}/v1.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storageKey, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadError) {
    logger.error({ error: uploadError.message }, 'Error al subir PDF');
    // Clean up the contrato record
    await (supabase
      .from('contratos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', created.id);
    throw new AppError(500, 'STORAGE_ERROR', 'Error al almacenar el PDF');
  }

  // 8. Update contrato with storage_key
  await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .update({ storage_key: storageKey } as never)
    .eq('id', created.id);

  // 9. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_GENERATED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: created.id,
    detalle: {
      expediente_id: expedienteId,
      plantilla_id: input.plantilla_id,
      plantilla_nombre: pl.nombre,
      variables_count: Object.keys(finalVariables).length,
    },
    ip,
  });

  return getContratoById(created.id);
}

// ============================================================
// Renovar contrato (desde vigente)
// ============================================================

export async function renovarContrato(
  contratoId: string,
  input: RenovarContratoInput,
  userId: string,
  ip?: string,
) {
  // 1. Fetch parent contract
  const { data: parent, error: parentError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, plantilla_id, estado, duracion_meses, datos_variables, plantilla_version')
    .eq('id', contratoId)
    .single();

  if (parentError || !parent) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  const p = parent as unknown as {
    id: string;
    expediente_id: string;
    plantilla_id: string;
    estado: string;
    duracion_meses: number;
    datos_variables: Record<string, string> | null;
    plantilla_version: number;
  };

  if (p.estado !== 'vigente') {
    throw AppError.badRequest(
      'Solo se puede renovar un contrato en estado vigente',
      'CONTRATO_NO_RENOVABLE',
    );
  }

  // 2. Check no existing renewal already exists
  const { data: existingRenewal } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('contrato_padre_id', contratoId)
    .limit(1)
    .maybeSingle();

  if (existingRenewal) {
    throw AppError.conflict(
      'Ya existe una renovacion para este contrato',
      'RENOVACION_YA_EXISTENTE',
    );
  }

  // 3. Fetch expediente data and plantilla (reuse generarContrato pattern)
  const { data: expData } = await fetchExpedienteData(p.expediente_id);

  const { data: plantilla, error: plantillaError } = await (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre, contenido, variables, activa, version')
    .eq('id', p.plantilla_id)
    .single();

  if (plantillaError || !plantilla) {
    throw AppError.notFound('Plantilla del contrato original no encontrada', 'PLANTILLA_NOT_FOUND');
  }

  const pl = plantilla as unknown as {
    id: string; nombre: string; contenido: string;
    variables: string[]; activa: boolean; version: number;
  };

  // 4. Build variables — start from parent variables, override with new ones
  const duracionMeses = input.duracion_meses || p.duracion_meses || 12;
  const fechaInicio = input.fecha_inicio
    ? new Date(input.fecha_inicio + 'T00:00:00')
    : new Date();

  const autoVariables = buildVariablesFromExpediente(expData, fechaInicio, duracionMeses);
  const parentVars = p.datos_variables || {};
  const finalVariables = { ...parentVars, ...autoVariables, ...(input.variables ?? {}) };

  // 5. Compile HTML and generate PDF
  const compiledHtml = compileTemplate(pl.contenido, finalVariables);
  const now = new Date();
  const pdfBuffer = await generateContractPdf(compiledHtml, {
    titulo: pl.nombre,
    fecha: formatDateCO(now),
    version: 1,
  });

  // 6. Insert new contract with contrato_padre_id
  const { data: newContrato, error: insertError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: p.expediente_id,
      plantilla_id: p.plantilla_id,
      version: 1,
      estado: 'borrador',
      fecha_inicio: input.fecha_inicio || now.toISOString().split('T')[0],
      fecha_fin: addMonths(fechaInicio, duracionMeses).toISOString().split('T')[0],
      duracion_meses: duracionMeses,
      valor_arriendo: expData.inmueble.valor_arriendo || 0,
      datos_variables: finalVariables,
      generado_por: userId,
      fecha_generacion: now.toISOString(),
      plantilla_version: pl.version,
      nombre_archivo: `contrato-renovacion-${pl.nombre.toLowerCase().replace(/\s+/g, '-')}-v1.pdf`,
      contrato_padre_id: contratoId,
    } as never)
    .select('id')
    .single();

  if (insertError || !newContrato) {
    logger.error({ error: insertError?.message }, 'Error al crear contrato de renovacion');
    throw AppError.badRequest('Error al crear el contrato de renovacion', 'RENOVACION_CREATE_ERROR');
  }

  const created = newContrato as unknown as { id: string };

  // 7. Upload PDF
  const storageKey = `contratos/${p.expediente_id}/${created.id}/v1.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storageKey, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadError) {
    logger.error({ error: uploadError.message }, 'Error al subir PDF de renovacion');
    await (supabase
      .from('contratos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', created.id);
    throw new AppError(500, 'STORAGE_ERROR', 'Error al almacenar el PDF de renovacion');
  }

  // 8. Update contrato with storage_key
  await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .update({ storage_key: storageKey } as never)
    .eq('id', created.id);

  // 9. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_RENEWED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: created.id,
    detalle: {
      contrato_padre_id: contratoId,
      expediente_id: p.expediente_id,
      plantilla_id: p.plantilla_id,
      duracion_meses: duracionMeses,
    },
    ip,
  });

  return getContratoById(created.id);
}

// ============================================================
// Regenerar contrato (solo borrador)
// ============================================================

export async function regenerarContrato(
  id: string,
  input: ReGenerarContratoInput,
  userId: string,
  ip?: string,
) {
  // 1. Get existing contrato
  const existing = await getContratoById(id);
  const row = existing as unknown as {
    id: string; expediente_id: string; plantilla_id: string;
    version: number; estado: string; storage_key: string;
    datos_variables: Record<string, string> | null;
    nombre_archivo: string | null; plantilla_version: number | null;
    generado_por: string | null; fecha_generacion: string | null;
  };

  if (row.estado !== 'borrador') {
    throw AppError.badRequest(
      'Solo se puede regenerar un contrato en estado Borrador',
      'CONTRATO_NOT_BORRADOR',
    );
  }

  // 2. Fetch expediente data
  const { data: expData } = await fetchExpedienteData(row.expediente_id);

  // 3. Fetch plantilla
  const { data: plantilla } = await (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre, contenido, variables, version')
    .eq('id', row.plantilla_id)
    .single();

  if (!plantilla) {
    throw AppError.notFound('Plantilla no encontrada', 'PLANTILLA_NOT_FOUND');
  }

  const pl = plantilla as unknown as {
    id: string; nombre: string; contenido: string;
    variables: string[]; version: number;
  };

  // 4. Build variables (merge previous + auto + new overrides)
  const fechaInicio = new Date();
  const duracionMeses = 12;
  const autoVariables = buildVariablesFromExpediente(expData, fechaInicio, duracionMeses);
  const finalVariables = {
    ...autoVariables,
    ...(row.datos_variables ?? {}),
    ...(input.variables ?? {}),
  };

  // 4b. Archive current version before regenerating
  const resumenCambios = generateResumenCambios(row.datos_variables ?? {}, finalVariables);
  await archiveCurrentVersion(row, resumenCambios);

  // 5. Compile HTML + generate PDF
  const compiledHtml = compileTemplate(pl.contenido, finalVariables);
  const newVersion = row.version + 1;
  const now = new Date();

  const pdfBuffer = await generateContractPdf(compiledHtml, {
    titulo: pl.nombre,
    fecha: formatDateCO(now),
    version: newVersion,
  });

  // 6. Upload new PDF (new version key)
  const storageKey = `contratos/${row.expediente_id}/${row.id}/v${newVersion}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storageKey, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadError) {
    logger.error({ error: uploadError.message }, 'Error al subir PDF regenerado');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al almacenar el PDF regenerado');
  }

  // 7. Update contrato (old PDF preserved in contrato_versiones)
  const { error: updateError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .update({
      version: newVersion,
      datos_variables: finalVariables,
      fecha_generacion: now.toISOString(),
      storage_key: storageKey,
      nombre_archivo: `contrato-${pl.nombre.toLowerCase().replace(/\s+/g, '-')}-v${newVersion}.pdf`,
      plantilla_version: pl.version,
    } as never)
    .eq('id', id);

  if (updateError) {
    logger.error({ error: updateError.message }, 'Error al actualizar contrato');
    throw AppError.badRequest('Error al regenerar el contrato', 'CONTRATO_REGENERATE_ERROR');
  }

  // 9. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_REGENERATED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: id,
    detalle: { version: newVersion, version_anterior: row.version, resumen_cambios: resumenCambios },
    ip,
  });

  return getContratoById(id);
}

// ============================================================
// Descargar contrato (signed URL)
// ============================================================

export async function descargarContrato(id: string, userId: string, ip?: string) {
  const contrato = await getContratoById(id);
  const row = contrato as unknown as {
    id: string; storage_key: string; nombre_archivo: string;
  };

  if (!row.storage_key) {
    throw AppError.badRequest('El contrato no tiene PDF generado', 'NO_PDF');
  }

  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(row.storage_key, DOWNLOAD_URL_EXPIRY_SECONDS, {
      download: row.nombre_archivo || 'contrato.pdf',
    });

  if (urlError || !urlData) {
    logger.error({ error: urlError?.message, id }, 'Error al generar URL de descarga');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de descarga');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_DOWNLOADED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: id,
    detalle: { nombre_archivo: row.nombre_archivo },
    ip,
  });

  return {
    url: urlData.signedUrl,
    nombre_archivo: row.nombre_archivo || 'contrato.pdf',
    tipo_mime: 'application/pdf',
    expires_in: DOWNLOAD_URL_EXPIRY_SECONDS,
  };
}

// ============================================================
// List versiones by contrato
// ============================================================

export async function listVersionesByContrato(contratoId: string) {
  // Verify contrato exists
  await getContratoById(contratoId);

  const { data, error } = await (supabase
    .from('contrato_versiones' as string) as ReturnType<typeof supabase.from>)
    .select(VERSION_SELECT)
    .eq('contrato_id', contratoId)
    .order('version', { ascending: false });

  if (error) {
    logger.error({ error: error.message }, 'Error al listar versiones');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener versiones');
  }

  return data ?? [];
}

// ============================================================
// Descargar version archivada (signed URL)
// ============================================================

export async function descargarVersion(
  contratoId: string,
  versionNum: number,
  userId: string,
  ip?: string,
) {
  const { data, error } = await (supabase
    .from('contrato_versiones' as string) as ReturnType<typeof supabase.from>)
    .select('id, storage_key, nombre_archivo')
    .eq('contrato_id', contratoId)
    .eq('version', versionNum)
    .single();

  if (error || !data) {
    throw AppError.notFound('Version no encontrada', 'VERSION_NOT_FOUND');
  }

  const row = data as unknown as { id: string; storage_key: string; nombre_archivo: string };

  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(row.storage_key, DOWNLOAD_URL_EXPIRY_SECONDS, {
      download: row.nombre_archivo || 'contrato.pdf',
    });

  if (urlError || !urlData) {
    logger.error({ error: urlError?.message }, 'Error al generar URL de descarga de version');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de descarga');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_VERSION_DOWNLOADED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: { version: versionNum, nombre_archivo: row.nombre_archivo },
    ip,
  });

  return {
    url: urlData.signedUrl,
    nombre_archivo: row.nombre_archivo || 'contrato.pdf',
    tipo_mime: 'application/pdf',
    expires_in: DOWNLOAD_URL_EXPIRY_SECONDS,
  };
}

// ============================================================
// Comparar variables entre dos versiones
// ============================================================

export async function compararVersiones(
  contratoId: string,
  v1: number,
  v2: number,
) {
  const contrato = await getContratoById(contratoId);
  const currentRow = contrato as unknown as {
    version: number; datos_variables: Record<string, string> | null;
    fecha_generacion: string | null; plantilla_version: number | null;
  };

  async function getVariablesForVersion(versionNum: number) {
    // If requesting the current version, use the contrato row
    if (versionNum === currentRow.version) {
      return {
        version: currentRow.version,
        datos_variables: currentRow.datos_variables ?? {},
        fecha_generacion: currentRow.fecha_generacion,
        plantilla_version: currentRow.plantilla_version,
      };
    }

    // Otherwise look in the archive
    const { data, error } = await (supabase
      .from('contrato_versiones' as string) as ReturnType<typeof supabase.from>)
      .select('version, datos_variables, fecha_generacion, plantilla_version')
      .eq('contrato_id', contratoId)
      .eq('version', versionNum)
      .single();

    if (error || !data) {
      throw AppError.notFound(`Version ${versionNum} no encontrada`, 'VERSION_NOT_FOUND');
    }

    const row = data as unknown as {
      version: number; datos_variables: Record<string, string> | null;
      fecha_generacion: string | null; plantilla_version: number | null;
    };

    return {
      version: row.version,
      datos_variables: row.datos_variables ?? {},
      fecha_generacion: row.fecha_generacion,
      plantilla_version: row.plantilla_version,
    };
  }

  const [version1, version2] = await Promise.all([
    getVariablesForVersion(v1),
    getVariablesForVersion(v2),
  ]);

  // Build diff
  const allKeys = new Set([
    ...Object.keys(version1.datos_variables),
    ...Object.keys(version2.datos_variables),
  ]);

  const diferencias: Array<{
    variable: string;
    valor_v1: string | null;
    valor_v2: string | null;
    cambio: 'agregada' | 'eliminada' | 'modificada' | 'sin_cambio';
  }> = [];

  for (const key of allKeys) {
    const val1 = version1.datos_variables[key] ?? null;
    const val2 = version2.datos_variables[key] ?? null;

    let cambio: 'agregada' | 'eliminada' | 'modificada' | 'sin_cambio';
    if (val1 === null) cambio = 'agregada';
    else if (val2 === null) cambio = 'eliminada';
    else if (val1 !== val2) cambio = 'modificada';
    else cambio = 'sin_cambio';

    diferencias.push({ variable: key, valor_v1: val1, valor_v2: val2, cambio });
  }

  return {
    contrato_id: contratoId,
    v1: { version: version1.version, fecha_generacion: version1.fecha_generacion, plantilla_version: version1.plantilla_version },
    v2: { version: version2.version, fecha_generacion: version2.fecha_generacion, plantilla_version: version2.plantilla_version },
    diferencias,
    total_cambios: diferencias.filter(d => d.cambio !== 'sin_cambio').length,
  };
}

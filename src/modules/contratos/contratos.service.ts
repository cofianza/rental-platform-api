import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { generateContractPdf } from './contratos.pdf';
import { renderHtmlToPdf } from '@/lib/pdfRenderer';
import { renderTemplate } from '@/lib/templateEngine';
import { numeroALetras, numeroAPesosLetras, formatearPesos } from '@/lib/numerosEnLetras';
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

// ── Helpers para la plantilla V2 (HTML rico + bloques #if) ──────────

const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function nombreMes(date: Date): string {
  return MESES_ES[date.getMonth()];
}

function fechaCompleta(date: Date): string {
  return `${date.getDate()} de ${nombreMes(date)} de ${date.getFullYear()}`;
}

function tipoDocumentoLabel(tipo: string | null | undefined): string {
  if (!tipo) return 'CC';
  const map: Record<string, string> = {
    cc: 'CC', ce: 'CE', ti: 'TI', nit: 'NIT', pasaporte: 'PASAPORTE', pas: 'PASAPORTE',
  };
  return map[tipo.toLowerCase()] || tipo.toUpperCase();
}

interface ConfiguracionSistemaRow {
  clave: string;
  valor: string;
}

async function getConfigValores(claves: string[]): Promise<Record<string, string>> {
  const { data } = await (supabase
    .from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>)
    .select('clave, valor')
    .in('clave', claves);
  const out: Record<string, string> = {};
  for (const row of (data || []) as ConfiguracionSistemaRow[]) {
    out[row.clave] = row.valor;
  }
  return out;
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
    storage_key: string | null;
    nombre_archivo: string | null;
    plantilla_version: number | null;
    generado_por: string | null;
    fecha_generacion: string | null;
  },
  resumenCambios: string,
): Promise<void> {
  // Si la version actual nunca tuvo PDF (caso de un contrato creado por
  // el orchestrator con auto-generacion fallida, o por SQL manual), no
  // hay nada que archivar. La tabla contrato_versiones exige storage_key
  // NOT NULL — saltamos el insert.
  if (!contrato.storage_key) {
    logger.info(
      { contratoId: contrato.id, version: contrato.version },
      'Contratos: archiveCurrentVersion skipped — version actual sin storage_key',
    );
    return;
  }

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

interface ArrendadorRow {
  id: string;
  nombre: string;
  apellido: string;
  rol: string;
  tipo_documento: string | null;
  numero_documento: string | null;
  razon_social: string | null;
  representante_legal: string | null;
  domicilio_direccion: string | null;
  domicilio_ciudad: string | null;
  ciudad: string | null;
  matricula_arrendador: string | null;
  logo_storage_key: string | null;
  logo_url: string | null;
  whatsapp_recaudo: string | null;
  email_recaudo: string | null;
  cuenta_recaudo_banco: string | null;
  cuenta_recaudo_tipo: string | null;
  cuenta_recaudo_numero: string | null;
  cuenta_recaudo_titular_nombre: string | null;
  cuenta_recaudo_titular_nit: string | null;
}

interface CodeudorData {
  nombre: string;
  tipo_documento: string | null;
  numero_documento: string | null;
  parentesco: string | null;
}

interface ExpedienteData {
  inmueble: {
    direccion: string;
    ciudad: string;
    barrio?: string | null;
    departamento?: string;
    valor_arriendo: number;
    parqueadero?: boolean | null;
    administracion?: number | null;
    propiedad_horizontal?: boolean | null;
    cuarto_util?: boolean | null;
    ubicacion_detallada?: string | null;
    propietario_id: string;
    contrato_tipo_storage_key?: string | null;
    contrato_tipo_nombre_archivo?: string | null;
  };
  solicitante: {
    nombre: string;
    apellido: string;
    tipo_documento: string;
    numero_documento: string;
    email?: string | null;
    telefono?: string | null;
    direccion?: string | null;
    ciudad?: string | null;
  };
  propietario: {
    nombre: string;
    apellido: string;
    numero_documento: string;
  };
  arrendador?: ArrendadorRow;
  codeudor?: CodeudorData | null;
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
  // 1. Fetch expediente with inmueble + solicitante (campos completos
  //    para alimentar la plantilla del contrato V2).
  const { data: expediente, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, numero, estado, inmueble_id, solicitante_id,
      codeudor_nombre, codeudor_tipo_documento, codeudor_documento, codeudor_parentesco,
      inmuebles(
        id, direccion, ciudad, barrio, departamento, valor_arriendo, parqueadero,
        administracion, propietario_id,
        propiedad_horizontal, cuarto_util, ubicacion_detallada,
        contrato_tipo_storage_key, contrato_tipo_nombre_archivo
      ),
      solicitantes(
        id, nombre, apellido, tipo_documento, numero_documento,
        email, telefono, direccion, ciudad
      )
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
    codeudor_nombre: string | null;
    codeudor_tipo_documento: string | null;
    codeudor_documento: string | null;
    codeudor_parentesco: string | null;
    inmuebles: {
      id: string;
      direccion: string;
      ciudad: string;
      barrio: string | null;
      departamento: string;
      valor_arriendo: number;
      parqueadero: boolean | null;
      administracion: number | null;
      propietario_id: string;
      contrato_tipo_storage_key: string | null;
      contrato_tipo_nombre_archivo: string | null;
    };
    solicitantes: {
      id: string; nombre: string; apellido: string;
      tipo_documento: string; numero_documento: string;
      email: string | null; telefono: string | null;
      direccion: string | null; ciudad: string | null;
    };
  };

  if (!exp.inmuebles) {
    throw AppError.badRequest('El expediente no tiene inmueble asociado', 'NO_INMUEBLE');
  }
  if (!exp.solicitantes) {
    throw AppError.badRequest('El expediente no tiene solicitante asociado', 'NO_SOLICITANTE');
  }

  // 2. Fetch arrendador (propietario | inmobiliaria) con todos los campos
  //    necesarios para el contrato. perfiles.rol determina si es inmobiliaria
  //    (lleva logo y cláusula de comisión) o propietario directo.
  const { data: arrendadorRow, error: arrendadorError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, nombre, apellido, rol, tipo_documento, numero_documento,
      razon_social, representante_legal,
      domicilio_direccion, domicilio_ciudad, ciudad,
      matricula_arrendador, logo_storage_key, logo_url,
      whatsapp_recaudo, email_recaudo,
      cuenta_recaudo_banco, cuenta_recaudo_tipo, cuenta_recaudo_numero,
      cuenta_recaudo_titular_nombre, cuenta_recaudo_titular_nit
    `)
    .eq('id', exp.inmuebles.propietario_id)
    .single();

  if (arrendadorError || !arrendadorRow) {
    throw AppError.badRequest('No se encontro el arrendador del inmueble', 'NO_ARRENDADOR');
  }

  const arrendador = arrendadorRow as unknown as {
    id: string; nombre: string; apellido: string; rol: string;
    tipo_documento: string | null; numero_documento: string | null;
    razon_social: string | null; representante_legal: string | null;
    domicilio_direccion: string | null; domicilio_ciudad: string | null; ciudad: string | null;
    matricula_arrendador: string | null;
    logo_storage_key: string | null; logo_url: string | null;
    whatsapp_recaudo: string | null; email_recaudo: string | null;
    cuenta_recaudo_banco: string | null; cuenta_recaudo_tipo: string | null;
    cuenta_recaudo_numero: string | null; cuenta_recaudo_titular_nombre: string | null;
    cuenta_recaudo_titular_nit: string | null;
  };

  return {
    expediente: expediente as Record<string, unknown>,
    data: {
      inmueble: exp.inmuebles,
      solicitante: exp.solicitantes,
      propietario: {
        nombre: arrendador.nombre,
        apellido: arrendador.apellido,
        numero_documento: arrendador.numero_documento || '',
      },
      arrendador,
      codeudor: exp.codeudor_nombre
        ? {
            nombre: exp.codeudor_nombre,
            tipo_documento: exp.codeudor_tipo_documento,
            numero_documento: exp.codeudor_documento,
            parentesco: exp.codeudor_parentesco,
          }
        : null,
    },
  };
}

/**
 * Construye el contexto anidado que consume la plantilla HTML V2.
 * Resuelve: arrendador, arrendatario, coarrendatario, inmueble, contrato,
 * canon, config — todo listo para `renderTemplate`.
 */
async function buildContratoContext(
  data: ExpedienteData,
  expedienteNumero: string,
  fechaInicio: Date,
  duracionMeses: number,
): Promise<Record<string, unknown>> {
  const { arrendador, solicitante, inmueble, codeudor } = data;
  const fechaFin = addMonths(fechaInicio, duracionMeses);
  const ahora = new Date();
  const monto = Number(inmueble.valor_arriendo) || 0;

  const cfg = await getConfigValores([
    'valor_afianzamiento_mensual',
    'comision_intermediacion_porcentaje',
  ]);
  const afianzamiento = Number(cfg.valor_afianzamiento_mensual) || 20000;
  const comisionPct = Number(cfg.comision_intermediacion_porcentaje) || 20;

  const esInmobiliaria = arrendador?.rol === 'inmobiliaria';

  // Razón social: si es PJ con razon_social usar esa; si no, "nombre + apellido".
  const razonSocialArrendador = arrendador?.razon_social
    || `${arrendador?.nombre || ''} ${arrendador?.apellido || ''}`.trim();

  // Resolver URL pública del logo: priorizamos logo_url si ya está
  // cacheado. Si solo hay storage_key, asumimos el bucket de documentos
  // (cuando agreguemos UI de subida en Fase 3 podemos cambiar de bucket
  // — por ahora la inmobiliaria pega la URL directa o sube por aquí).
  let logoUrl = arrendador?.logo_url || null;
  if (!logoUrl && esInmobiliaria && arrendador?.logo_storage_key) {
    const { data: signed } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(arrendador.logo_storage_key, 60 * 60);
    logoUrl = signed?.signedUrl ?? null;
  }

  return {
    arrendador: {
      razon_social: razonSocialArrendador,
      tipo_documento_label: tipoDocumentoLabel(arrendador?.tipo_documento || undefined),
      numero_documento: arrendador?.numero_documento || '',
      representante_legal: arrendador?.representante_legal || '',
      domicilio_direccion: arrendador?.domicilio_direccion || '',
      domicilio_ciudad: arrendador?.domicilio_ciudad || arrendador?.ciudad || 'Caldas',
      matricula_arrendador: esInmobiliaria ? (arrendador?.matricula_arrendador || '') : '',
      logo_url: esInmobiliaria ? (logoUrl || '') : '',
      es_inmobiliaria: esInmobiliaria,
      whatsapp_recaudo: arrendador?.whatsapp_recaudo || '',
      email_recaudo: arrendador?.email_recaudo || '',
      cuenta_banco: arrendador?.cuenta_recaudo_banco || '',
      cuenta_tipo: arrendador?.cuenta_recaudo_tipo || 'ahorros',
      cuenta_numero: arrendador?.cuenta_recaudo_numero || '',
      cuenta_titular_nombre: arrendador?.cuenta_recaudo_titular_nombre || razonSocialArrendador,
      cuenta_titular_nit: arrendador?.cuenta_recaudo_titular_nit || arrendador?.numero_documento || '',
    },
    arrendatario: {
      nombre_completo: `${solicitante.nombre} ${solicitante.apellido}`.trim(),
      numero_documento: solicitante.numero_documento || '',
      direccion: solicitante.direccion || '',
      ciudad: solicitante.ciudad || '',
      email: solicitante.email || '',
      celular: solicitante.telefono || '',
    },
    coarrendatario: codeudor
      ? {
          nombre_completo: codeudor.nombre,
          numero_documento: codeudor.numero_documento || '',
          direccion: '',
          ciudad: '',
          email: '',
          celular: '',
        }
      : null,
    inmueble: {
      direccion: inmueble.direccion,
      ciudad: inmueble.ciudad,
      // Si el propietario escribió ubicacion_detallada en el inmueble, la
      // usamos textual. Si no, la armamos con direccion + barrio + ciudad
      // + departamento.
      ubicacion_detallada: inmueble.ubicacion_detallada
        || [inmueble.direccion, inmueble.barrio, inmueble.ciudad, inmueble.departamento]
            .filter(Boolean).join(', '),
      // Si está explícito en el inmueble, lo respetamos. Si es null, caemos
      // a la heurística: paga administración → propiedad horizontal.
      es_propiedad_horizontal: inmueble.propiedad_horizontal !== null && inmueble.propiedad_horizontal !== undefined
        ? Boolean(inmueble.propiedad_horizontal)
        : Number(inmueble.administracion || 0) > 0,
      tiene_parqueadero: Boolean(inmueble.parqueadero),
      tiene_cuarto_util: Boolean(inmueble.cuarto_util),
    },
    contrato: {
      fecha_dia: ahora.getDate(),
      fecha_dia_letras: numeroALetras(ahora.getDate()),
      fecha_mes_nombre: nombreMes(ahora),
      fecha_anio: ahora.getFullYear(),
      duracion_meses: duracionMeses,
      duracion_meses_letras: numeroALetras(duracionMeses),
      fecha_inicio_completa: fechaCompleta(fechaInicio),
      fecha_fin_completa: fechaCompleta(fechaFin),
      expediente_numero: expedienteNumero,
    },
    canon: {
      valor_numerico: formatearPesos(monto),
      valor_letras: numeroAPesosLetras(monto),
    },
    config: {
      afianzamiento_mensual: formatearPesos(afianzamiento),
      afianzamiento_mensual_letras: numeroAPesosLetras(afianzamiento),
      comision_porcentaje: comisionPct,
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

export async function listAllContratos(
  query: ListAllContratosQuery,
  userId?: string,
  userRol?: string,
) {
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 10;
  const sortBy = query.sortBy || 'created_at';
  const sortDir = query.sortDir || 'desc';
  const offset = (page - 1) * limit;

  // Filtro por rol: propietario/inmobiliaria solo ven contratos cuyos
  // inmuebles les pertenecen. Resolvemos primero los expediente_ids y luego
  // filtramos `contratos.expediente_id IN (...)`.
  let allowedExpedienteIds: string[] | null = null;
  if (userId && (userRol === 'propietario' || userRol === 'inmobiliaria')) {
    const { data: misInmuebles } = await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('propietario_id', userId);
    const inmIds = ((misInmuebles as { id: string }[] | null) || []).map((i) => i.id);
    if (inmIds.length === 0) {
      return {
        contratos: [],
        pagination: { total: 0, page, limit, totalPages: 0 },
      };
    }
    const { data: expedientes } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .in('inmueble_id', inmIds);
    allowedExpedienteIds = ((expedientes as { id: string }[] | null) || []).map((e) => e.id);
    if (allowedExpedienteIds.length === 0) {
      return {
        contratos: [],
        pagination: { total: 0, page, limit, totalPages: 0 },
      };
    }
  }

  // Build filters helper
  function applyFilters(qb: ReturnType<typeof supabase.from>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q = qb as any;
    if (allowedExpedienteIds !== null) {
      q = q.in('expediente_id', allowedExpedienteIds);
    }
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
  // 1. Fetch expediente data (incluye arrendador completo + codeudor).
  const { expediente: expRow, data: expData } = await fetchExpedienteData(expedienteId);
  const expedienteNumero = (expRow as { numero?: string }).numero || expedienteId;

  const now = new Date();
  const fechaInicio = input.fecha_inicio
    ? new Date(input.fecha_inicio + 'T00:00:00')
    : new Date();
  const duracionMeses = input.duracion_meses || 12;

  // 2. Resolver plantilla: si el caller pasó plantilla_id usamos esa, si
  //    no buscamos la única activa (V2 prevé una sola plantilla maestra).
  type PlantillaRow = {
    id: string; nombre: string; contenido: string | null; contenido_html: string | null;
    variables: unknown; activa: boolean; version: number;
  };

  let plantillaQuery = (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre, contenido, contenido_html, variables, activa, version');

  plantillaQuery = input.plantilla_id
    ? plantillaQuery.eq('id', input.plantilla_id)
    : plantillaQuery.eq('activa', true).order('created_at', { ascending: false }).limit(1);

  const { data: plantillaRowRaw, error: plantillaError } = await plantillaQuery.maybeSingle();

  if (plantillaError || !plantillaRowRaw) {
    throw AppError.notFound(
      input.plantilla_id ? 'Plantilla no encontrada' : 'No hay ninguna plantilla activa configurada',
      'PLANTILLA_NOT_FOUND',
    );
  }

  const plantillaRow = plantillaRowRaw as unknown as PlantillaRow;
  if (!plantillaRow.activa) {
    throw AppError.badRequest('La plantilla no esta activa', 'PLANTILLA_INACTIVE');
  }

  // 3. Construir contexto y renderizar HTML + PDF.
  const context = await buildContratoContext(expData, expedienteNumero, fechaInicio, duracionMeses);

  // Permitir overrides explícitos desde input.variables (admin puede ajustar
  // un valor puntual antes de generar — hoy nadie llama así, pero el shape
  // del schema lo permite).
  const finalVariables: Record<string, unknown> = { ...context, ...(input.variables ?? {}) };

  let pdfBuffer: Buffer;
  let nombreArchivoContrato: string;

  if (plantillaRow.contenido_html) {
    // Plantilla V2 (HTML rico) → Puppeteer.
    const renderedHtml = renderTemplate(plantillaRow.contenido_html, finalVariables);
    pdfBuffer = await renderHtmlToPdf(renderedHtml);
    nombreArchivoContrato = `contrato-${expedienteNumero}-v1.pdf`;
  } else {
    // Fallback: plantilla legacy con `contenido` y vars planas → pdfkit.
    // Convertimos el contexto anidado a un map plano para que las viejas
    // referencias `{{arrendador_nombre}}` sigan funcionando.
    const flatVars = flattenForLegacyTemplate(context);
    const compiledHtml = compileTemplate(plantillaRow.contenido || '', flatVars);
    pdfBuffer = await generateContractPdf(compiledHtml, {
      titulo: plantillaRow.nombre,
      fecha: formatDateCO(now),
      version: 1,
    });
    nombreArchivoContrato = `contrato-${plantillaRow.nombre.toLowerCase().replace(/\s+/g, '-')}-v1.pdf`;
  }

  // Insert contrato first to get ID
  const { data: contrato, error: insertError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      plantilla_id: plantillaRow?.id ?? null,
      version: 1,
      estado: 'borrador',
      fecha_inicio: input.fecha_inicio || now.toISOString().split('T')[0],
      fecha_fin: addMonths(fechaInicio, duracionMeses).toISOString().split('T')[0],
      duracion_meses: duracionMeses,
      valor_arriendo: expData.inmueble.valor_arriendo || 0,
      datos_variables: finalVariables,
      generado_por: userId,
      fecha_generacion: now.toISOString(),
      plantilla_version: plantillaRow?.version ?? null,
      nombre_archivo: nombreArchivoContrato,
    } as never)
    .select('id')
    .single();

  if (insertError || !contrato) {
    logger.error({ error: insertError?.message }, 'Error al crear contrato');
    throw AppError.badRequest('Error al crear el contrato', 'CONTRATO_CREATE_ERROR');
  }

  const created = contrato as unknown as { id: string };

  // Upload PDF to storage
  const storageKey = `contratos/${expedienteId}/${created.id}/v1.pdf`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storageKey, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadError) {
    logger.error({ error: uploadError.message }, 'Error al subir PDF');
    await (supabase
      .from('contratos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', created.id);
    throw new AppError(500, 'STORAGE_ERROR', 'Error al almacenar el PDF');
  }

  await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .update({ storage_key: storageKey } as never)
    .eq('id', created.id);

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_GENERATED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: created.id,
    detalle: {
      expediente_id: expedienteId,
      origen: 'plantilla',
      plantilla_id: plantillaRow?.id ?? null,
      plantilla_nombre: plantillaRow?.nombre ?? null,
      arrendador_es_inmobiliaria: (context.arrendador as { es_inmobiliaria: boolean }).es_inmobiliaria,
    },
    ip,
  });

  return getContratoById(created.id);
}

/**
 * Renderiza la plantilla activa con los datos del inmueble + propietario,
 * pero con campos del arrendatario/coarrendatario como placeholders.
 * Usado para mostrar un preview visual en el detalle del inmueble (sin
 * generar PDF — solo HTML para embeber en un iframe).
 */
export async function previewPlantillaParaInmueble(inmuebleId: string): Promise<string> {
  // 1. Cargar inmueble con datos relevantes para el contrato.
  const { data: inmuebleRow, error: inmError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id, direccion, ciudad, barrio, departamento, valor_arriendo, parqueadero, administracion, propietario_id, propiedad_horizontal, cuarto_util, ubicacion_detallada')
    .eq('id', inmuebleId)
    .single();
  if (inmError || !inmuebleRow) {
    throw AppError.notFound('Inmueble no encontrado', 'INMUEBLE_NOT_FOUND');
  }
  const inmueble = inmuebleRow as unknown as ExpedienteData['inmueble'];

  // 2. Cargar arrendador (propietario o inmobiliaria) con todos los campos.
  const { data: arrendadorRow, error: arrError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, nombre, apellido, rol, tipo_documento, numero_documento,
      razon_social, representante_legal,
      domicilio_direccion, domicilio_ciudad, ciudad,
      matricula_arrendador, logo_storage_key, logo_url,
      whatsapp_recaudo, email_recaudo,
      cuenta_recaudo_banco, cuenta_recaudo_tipo, cuenta_recaudo_numero,
      cuenta_recaudo_titular_nombre, cuenta_recaudo_titular_nit
    `)
    .eq('id', inmueble.propietario_id)
    .single();
  if (arrError || !arrendadorRow) {
    throw AppError.badRequest('No se encontro el arrendador del inmueble', 'NO_ARRENDADOR');
  }

  // 3. Construir contexto con datos del inmueble + arrendador y placeholders
  //    para arrendatario/coarrendatario.
  const dataForContext: ExpedienteData = {
    inmueble,
    solicitante: {
      nombre: '[Nombre arrendatario]',
      apellido: '',
      tipo_documento: 'cc',
      numero_documento: '[CC]',
      email: '[email@arrendatario]',
      telefono: '[Celular]',
      direccion: '[Direccion arrendatario]',
      ciudad: '[Ciudad]',
    },
    propietario: {
      nombre: (arrendadorRow as { nombre: string }).nombre,
      apellido: (arrendadorRow as { apellido: string }).apellido,
      numero_documento: (arrendadorRow as { numero_documento: string | null }).numero_documento || '',
    },
    arrendador: arrendadorRow as unknown as ArrendadorRow,
    codeudor: null,
  };

  const fechaInicio = new Date();
  const ctx = await buildContratoContext(dataForContext, '[Numero expediente]', fechaInicio, 12);

  // 4. Cargar plantilla activa.
  const { data: plantilla } = await (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .select('contenido_html')
    .eq('activa', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const html = (plantilla as { contenido_html: string | null } | null)?.contenido_html;
  if (!html) {
    throw AppError.notFound('No hay plantilla activa configurada', 'PLANTILLA_NOT_FOUND');
  }

  // 5. Renderizar.
  return renderTemplate(html, ctx);
}

/**
 * Aplana el contexto anidado a {key: value} para que la plantilla legacy
 * (la que usaba {{arrendador_nombre}} sin punto) siga funcionando si por
 * algún motivo se invoca con `contenido` en vez de `contenido_html`.
 */
function flattenForLegacyTemplate(ctx: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const a = (ctx.arrendador || {}) as Record<string, unknown>;
  const t = (ctx.arrendatario || {}) as Record<string, unknown>;
  const i = (ctx.inmueble || {}) as Record<string, unknown>;
  const c = (ctx.contrato || {}) as Record<string, unknown>;
  const k = (ctx.canon || {}) as Record<string, unknown>;
  out.arrendador_nombre = String(a.razon_social ?? '');
  out.arrendador_documento = String(a.numero_documento ?? '');
  out.arrendatario_nombre = String(t.nombre_completo ?? '');
  out.arrendatario_documento = String(t.numero_documento ?? '');
  out.inmueble_direccion = String(i.direccion ?? '');
  out.inmueble_ciudad = String(i.ciudad ?? '');
  out.canon_mensual = `$${String(k.valor_numerico ?? '')}`;
  out.fecha_inicio = String(c.fecha_inicio_completa ?? '');
  out.fecha_fin = String(c.fecha_fin_completa ?? '');
  out.duracion_meses = String(c.duracion_meses ?? '');
  return out;
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
    fecha_inicio: string | null; duracion_meses: number | null;
  };

  if (row.estado !== 'borrador') {
    throw AppError.badRequest(
      'Solo se puede regenerar un contrato en estado Borrador',
      'CONTRATO_NOT_BORRADOR',
    );
  }

  // 2. Fetch expediente data
  const { data: expData } = await fetchExpedienteData(row.expediente_id);

  // 3. Fetch plantilla (incluyendo el HTML V2 si existe).
  const { data: plantilla } = await (supabase
    .from('plantillas_contrato' as string) as ReturnType<typeof supabase.from>)
    .select('id, nombre, contenido, contenido_html, variables, version')
    .eq('id', row.plantilla_id)
    .single();

  if (!plantilla) {
    throw AppError.notFound('Plantilla no encontrada', 'PLANTILLA_NOT_FOUND');
  }

  const pl = plantilla as unknown as {
    id: string; nombre: string; contenido: string | null; contenido_html: string | null;
    variables: string[]; version: number;
  };

  // 4. Construir contexto V2 anidado (igual que generarContrato).
  // Si el caller provee fecha_inicio/duracion_meses/valor_arriendo en el
  // input, los usamos para regenerar con valores nuevos. Si no, usamos
  // los del contrato actual (re-render con mismos parametros).
  const fechaInicio = input.fecha_inicio
    ? new Date(`${input.fecha_inicio}T00:00:00`)
    : row.fecha_inicio
      ? new Date(`${row.fecha_inicio}T00:00:00`)
      : new Date();
  const duracionMeses = input.duracion_meses ?? row.duracion_meses ?? 12;

  // Override del valor_arriendo en el inmueble si el caller lo provee
  // (caso: el canon negociado con el inquilino difiere del listado).
  if (input.valor_arriendo && expData.inmueble) {
    expData.inmueble.valor_arriendo = input.valor_arriendo;
  }
  const expedienteNumero = ((await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero')
    .eq('id', row.expediente_id)
    .single()).data as { numero?: string } | null)?.numero || row.expediente_id;

  const ctx = await buildContratoContext(expData, expedienteNumero, fechaInicio, duracionMeses);
  const finalVariables: Record<string, unknown> = { ...ctx, ...(input.variables ?? {}) };

  // 4b. Archive current version before regenerating (skip si NULL).
  const resumenCambios = generateResumenCambios(
    (row.datos_variables ?? {}) as Record<string, string>,
    finalVariables as Record<string, string>,
  );
  await archiveCurrentVersion(row, resumenCambios);

  // 5. Render HTML + generate PDF (V2 con Puppeteer si hay contenido_html;
  //    fallback legacy a pdfkit + compileTemplate para plantillas viejas).
  const newVersion = row.version + 1;
  const now = new Date();

  let pdfBuffer: Buffer;
  if (pl.contenido_html) {
    const renderedHtml = renderTemplate(pl.contenido_html, finalVariables);
    pdfBuffer = await renderHtmlToPdf(renderedHtml);
  } else {
    const flatVars = flattenForLegacyTemplate(ctx);
    const compiledHtml = compileTemplate(pl.contenido || '', flatVars);
    pdfBuffer = await generateContractPdf(compiledHtml, {
      titulo: pl.nombre,
      fecha: formatDateCO(now),
      version: newVersion,
    });
  }

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

  // 7. Update contrato (old PDF preserved in contrato_versiones).
  // Persistimos fecha_inicio/duracion/valor si vinieron como override en
  // el input, asi quedan reflejados en la fila para futuras regeneraciones
  // y en el detalle del contrato.
  const fechaFin = addMonths(fechaInicio, duracionMeses);
  const updatePayload: Record<string, unknown> = {
    version: newVersion,
    datos_variables: finalVariables,
    fecha_generacion: now.toISOString(),
    storage_key: storageKey,
    nombre_archivo: `contrato-${pl.nombre.toLowerCase().replace(/\s+/g, '-')}-v${newVersion}.pdf`,
    plantilla_version: pl.version,
    fecha_inicio: fechaInicio.toISOString().split('T')[0],
    fecha_fin: fechaFin.toISOString().split('T')[0],
    duracion_meses: duracionMeses,
  };
  if (input.valor_arriendo) {
    updatePayload.valor_arriendo = input.valor_arriendo;
  }

  const { error: updateError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .update(updatePayload as never)
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

export async function descargarContrato(
  id: string,
  userId: string,
  ip?: string,
  options?: { inline?: boolean },
) {
  const contrato = await getContratoById(id);
  const row = contrato as unknown as {
    id: string; storage_key: string; nombre_archivo: string;
  };

  if (!row.storage_key) {
    throw AppError.badRequest('El contrato no tiene PDF generado', 'NO_PDF');
  }

  // Si inline=true, omitimos el parámetro download para que Supabase NO
  // envíe Content-Disposition: attachment. Asi el iframe del preview puede
  // embeberlo en lugar de forzar descarga.
  const inline = options?.inline === true;
  const signOpts = inline ? undefined : { download: row.nombre_archivo || 'contrato.pdf' };
  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(row.storage_key, DOWNLOAD_URL_EXPIRY_SECONDS, signOpts);

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

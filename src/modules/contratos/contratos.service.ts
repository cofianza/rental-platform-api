import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { generateContractPdf } from './contratos.pdf';
import { renderHtmlToPdf } from '@/lib/pdfRenderer';
import { renderTemplate } from '@/lib/templateEngine';
import { numeroALetras, numeroAPesosLetras, formatearPesos } from '@/lib/numerosEnLetras';
import { notificarUsuario, findPerfilIdByEmail } from '../notificaciones/notificaciones.service';
import { resolveAllowedExpedienteIds } from '@/lib/tenantScope';
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
  storage_key_firmado, nombre_archivo_firmado,
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
    timeZone: 'America/Bogota',
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
  matricula_expedida_por: string | null;
  matricula_fecha: string | null;
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
  email?: string | null;
  telefono?: string | null;
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
    matricula_inmobiliaria?: string | null;
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
  // `coarrendatario` reemplazó a `codeudor` (5-may-2026). Misma estructura
  // de datos — solo cambió el nombre del rol contractual.
  coarrendatario?: CodeudorData | null;
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
    coarrendatario_nombre: data.coarrendatario?.nombre || '',
    coarrendatario_documento: data.coarrendatario?.numero_documento || '',
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
      coarrendatario_nombre, coarrendatario_tipo_documento, coarrendatario_documento, coarrendatario_parentesco,
      duracion_contrato_meses, fecha_inicio_contrato,
      modalidad_fianza, servicios_reparto,
      cotitular_nombre, cotitular_tipo_documento, cotitular_documento,
      cotitular_celular, cotitular_correo, cotitular_direccion, cotitular_municipio,
      inmuebles(
        id, direccion, ciudad, barrio, departamento, valor_arriendo, parqueadero,
        administracion, propietario_id,
        propiedad_horizontal, cuarto_util, ubicacion_detallada, matricula_inmobiliaria,
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
    coarrendatario_nombre: string | null;
    coarrendatario_tipo_documento: string | null;
    coarrendatario_documento: string | null;
    coarrendatario_parentesco: string | null;
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
      matricula_inmobiliaria: string | null;
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
  // El contrato es el paso posterior a la aprobación: solo se genera cuando el
  // expediente está APROBADO. En 'condicionado' NO se genera directo: primero
  // hay que aprobar explícito vía aprobarCondicionado (que transiciona
  // condicionado→aprobado y luego llama aquí) o invitar a un co-arrendatario.
  if (exp.estado !== 'aprobado') {
    throw AppError.badRequest(
      'El contrato solo puede generarse cuando el expediente está aprobado. Si el estudio quedó condicionado, primero apruébalo (o invita a un co-arrendatario).',
      'EXPEDIENTE_NO_APROBADO',
    );
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
      matricula_arrendador, matricula_expedida_por, matricula_fecha, logo_storage_key, logo_url,
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
    matricula_expedida_por: string | null;
    matricula_fecha: string | null;
    logo_storage_key: string | null; logo_url: string | null;
    whatsapp_recaudo: string | null; email_recaudo: string | null;
    cuenta_recaudo_banco: string | null; cuenta_recaudo_tipo: string | null;
    cuenta_recaudo_numero: string | null; cuenta_recaudo_titular_nombre: string | null;
    cuenta_recaudo_titular_nit: string | null;
  };

  // 3. Co-arrendatario del flujo nuevo (Mario, 5-may-2026): si el solicitante
  //    invitó a alguien y su estudio quedó APROBADO, ese par es el que
  //    apalancó la aprobación del expediente — el contrato debe llevar sus
  //    datos como co-arrendatario. Cae al campo legacy (codeudor renombrado)
  //    solo si no hay coa nuevo válido.
  const coarrendatarioNuevo = await fetchCoarrendatarioParaContrato(expedienteId);

  const coarrendatarioFinal: CodeudorData | null = coarrendatarioNuevo
    ?? (exp.coarrendatario_nombre
      ? {
          nombre: exp.coarrendatario_nombre,
          tipo_documento: exp.coarrendatario_tipo_documento,
          numero_documento: exp.coarrendatario_documento,
          parentesco: exp.coarrendatario_parentesco,
        }
      : null);

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
      coarrendatario: coarrendatarioFinal,
    },
  };
}

/**
 * Carga el co-arrendatario del flujo nuevo (tabla expediente_coarrendatarios)
 * solo si su estudio TransUnion quedó APROBADO. Esa es la condición que
 * justifica incluirlo en el contrato — si declinó, está pendiente, o salió
 * condicionado/rechazado, no participa del contrato.
 */
async function fetchCoarrendatarioParaContrato(
  expedienteId: string,
): Promise<CodeudorData | null> {
  const { data: coaRow } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .select('nombre, apellido, tipo_documento, numero_documento, email, telefono, estudio_id, estado')
    .eq('expediente_id', expedienteId)
    .eq('estado', 'estudio_completado')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const coa = coaRow as unknown as {
    nombre: string;
    apellido: string;
    tipo_documento: string;
    numero_documento: string;
    email: string;
    telefono: string | null;
    estudio_id: string | null;
    estado: string;
  } | null;

  if (!coa || !coa.estudio_id) return null;

  const { data: estudioRow } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('resultado')
    .eq('id', coa.estudio_id)
    .maybeSingle();

  const resultado = (estudioRow as { resultado?: string } | null)?.resultado;
  if (resultado !== 'aprobado') return null;

  return {
    nombre: `${coa.nombre} ${coa.apellido}`.trim(),
    tipo_documento: coa.tipo_documento,
    numero_documento: coa.numero_documento,
    parentesco: 'Co-arrendatario',
    email: coa.email,
    telefono: coa.telefono,
  };
}

/**
 * Construye el contexto anidado que consume la plantilla HTML V2.
 * Resuelve: arrendador, arrendatario, coarrendatario, inmueble, contrato,
 * canon, config — todo listo para `renderTemplate`.
 */
interface ModalidadFianza {
  codigo: string;
  nombre: string;
  comision_texto: string;
  prima_texto: string;
  cubre_canones: boolean;
  cubre_servicios: boolean;
  cubre_admin_ph: boolean;
  cubre_danos: boolean;
  cubre_penal: boolean;
}

async function buildContratoContext(
  data: ExpedienteData,
  expedienteNumero: string,
  fechaInicio: Date,
  duracionMeses: number,
  // Fase 3 (contrato V4): modalidad de fianza + el expediente (co-titular,
  // reparto de servicios). Opcional para no romper los otros callers.
  opts?: { modalidad?: ModalidadFianza | null; expediente?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const { arrendador, solicitante, inmueble, coarrendatario } = data;
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

  // Propiedad horizontal: explícito en el inmueble, o heurística (paga admin).
  // Se reutiliza para el booleano (plantilla V2) y para el texto Sí/No (V4).
  const esPH = inmueble.propiedad_horizontal !== null && inmueble.propiedad_horizontal !== undefined
    ? Boolean(inmueble.propiedad_horizontal)
    : Number(inmueble.administracion || 0) > 0;

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

  // ── Fase 3 (contrato V4) ──────────────────────────────────────────
  // Cobertura (cob.*) según la modalidad; co-titular y reparto de servicios
  // (serv.*) desde el expediente.
  const mod = opts?.modalidad ?? null;
  const exp = opts?.expediente ?? {};
  const siNo = (b: boolean) => (b ? 'Sí' : 'No');
  const cob = {
    canones: siNo(!!mod?.cubre_canones),
    servicios: siNo(!!mod?.cubre_servicios),
    admin_ph: siNo(!!mod?.cubre_admin_ph),
    danos: siNo(!!mod?.cubre_danos),
    penal: siNo(!!mod?.cubre_penal),
  };
  const cotitularNombre = (exp.cotitular_nombre as string | null) || '';
  const cotitular = cotitularNombre
    ? {
        nombre_completo: cotitularNombre,
        cedula: (exp.cotitular_documento as string | null) || '',
        celular: (exp.cotitular_celular as string | null) || '',
        correo: (exp.cotitular_correo as string | null) || '',
        direccion_notificacion: (exp.cotitular_direccion as string | null) || '',
        municipio_notificacion: (exp.cotitular_municipio as string | null) || '',
      }
    : {};
  const reparto = (exp.servicios_reparto as Record<string, string> | null) || {};
  const svc = (s: string, lado: 'arrendatario' | 'arrendador') => (reparto[s] === lado ? 'X' : '');
  const serv = {
    agua: { arrendatario: svc('agua', 'arrendatario'), arrendador: svc('agua', 'arrendador') },
    energia: { arrendatario: svc('energia', 'arrendatario'), arrendador: svc('energia', 'arrendador') },
    gas: { arrendatario: svc('gas', 'arrendatario'), arrendador: svc('gas', 'arrendador') },
    basuras: { arrendatario: svc('basuras', 'arrendatario'), arrendador: svc('basuras', 'arrendador') },
    alumbrado: { arrendatario: svc('alumbrado', 'arrendatario'), arrendador: svc('alumbrado', 'arrendador') },
    internet: { arrendatario: svc('internet', 'arrendatario'), arrendador: svc('internet', 'arrendador') },
    admin_ph: { arrendatario: svc('admin_ph', 'arrendatario'), arrendador: svc('admin_ph', 'arrendador') },
  };

  return {
    cob,
    cotitular,
    serv,
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
    // Namespace del contrato V4 (mapea el arrendador/perfil → "inmobiliaria").
    // Campos que aún no existen en el modelo (matrícula expedida/fecha) salen
    // vacíos hasta Fase 3.
    inmobiliaria: {
      razon_social: razonSocialArrendador,
      nit: arrendador?.numero_documento || '',
      matricula_arrendador: esInmobiliaria ? (arrendador?.matricula_arrendador || '') : '',
      matricula_expedida_por: arrendador?.matricula_expedida_por || '',
      matricula_fecha: arrendador?.matricula_fecha || '',
      representante_legal: arrendador?.representante_legal || '',
      direccion: arrendador?.domicilio_direccion || '',
      correo: arrendador?.email_recaudo || '',
      telefono: arrendador?.whatsapp_recaudo || '',
      banco: arrendador?.cuenta_recaudo_banco || '',
      tipo_cuenta: arrendador?.cuenta_recaudo_tipo || 'ahorros',
      numero_cuenta: arrendador?.cuenta_recaudo_numero || '',
      whatsapp_cartera: arrendador?.whatsapp_recaudo || '',
      correo_cartera: arrendador?.email_recaudo || '',
      comision_porcentaje: `${comisionPct}%`,
      logo_url: esInmobiliaria ? (logoUrl || '') : '',
    },
    arrendatario: {
      nombre_completo: `${solicitante.nombre} ${solicitante.apellido}`.trim(),
      numero_documento: solicitante.numero_documento || '',
      direccion: solicitante.direccion || '',
      ciudad: solicitante.ciudad || '',
      email: solicitante.email || '',
      celular: solicitante.telefono || '',
      // Alias para el contrato V4.
      cedula: solicitante.numero_documento || '',
      correo: solicitante.email || '',
      direccion_notificacion: solicitante.direccion || '',
      municipio_notificacion: solicitante.ciudad || '',
    },
    coarrendatario: coarrendatario
      ? {
          nombre_completo: coarrendatario.nombre,
          numero_documento: coarrendatario.numero_documento || '',
          tipo_documento_label: tipoDocumentoLabel(coarrendatario.tipo_documento || undefined),
          parentesco: coarrendatario.parentesco || '',
          direccion: '',
          ciudad: '',
          email: coarrendatario.email || '',
          celular: coarrendatario.telefono || '',
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
      es_propiedad_horizontal: esPH,
      tiene_parqueadero: Boolean(inmueble.parqueadero),
      tiene_cuarto_util: Boolean(inmueble.cuarto_util),
      // Campos del contrato V4.
      municipio: inmueble.ciudad,
      matricula_inmobiliaria: inmueble.matricula_inmobiliaria || '',
      canon_numero: formatearPesos(monto),
      canon_letras: numeroALetras(monto).toUpperCase(),
      propiedad_horizontal: esPH ? 'Sí' : 'No',
      parqueadero: inmueble.parqueadero ? 'Sí' : 'No',
      cuarto_util: inmueble.cuarto_util ? 'Sí' : 'No',
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
      // Campos del contrato V4.
      fecha_inicio: fechaCompleta(fechaInicio),
      fecha_vencimiento: fechaCompleta(fechaFin),
      dia_limite_pago: 5,
      domicilio_contractual: arrendador?.domicilio_ciudad || arrendador?.ciudad || 'Caldas',
      fecha_firma_dia: ahora.getDate(),
      fecha_firma_mes: nombreMes(ahora),
      fecha_firma_ano: ahora.getFullYear(),
      modalidad: mod?.nombre || '',
      comision_texto: mod?.comision_texto || '',
      prima_texto: mod?.prima_texto || '',
      // Resumen de cargo de servicios/PH (la tabla serv.* tiene el detalle).
      servicios_publicos_cargo: '',
      administracion_ph_cargo: '',
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
  expedientes(numero, inmuebles(codigo, direccion, ciudad), solicitantes(nombre, apellido))
`;

// Scoping por rol propietario/inmobiliaria centralizado en @/lib/tenantScope
// (resolveAllowedExpedienteIds). Compartido por listado, stats y detalle para
// que nunca diverjan.

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
  // inmuebles les pertenecen (scoping en SQL via expediente_id IN (...)).
  const allowedExpedienteIds = await resolveAllowedExpedienteIds(userId, userRol);
  if (allowedExpedienteIds !== null && allowedExpedienteIds.length === 0) {
    return {
      contratos: [],
      pagination: { total: 0, page, limit, totalPages: 0 },
    };
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

// Dedup en memoria para auto-heal: cuando varios usuarios miran el
// mismo expediente al tiempo no disparamos N veces la generacion.
// Por replica del API — si hay multi-replica, en el peor caso 1
// generacion duplicada que admin puede limpiar (raro y benigno).
const autoGenInflight = new Set<string>();

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

  // Self-heal automatico (decision Mario 5-may-2026: NO auto-generar el
  // contrato cuando hay 0; el propietario decide duracion + fecha desde
  // AccionContratoPendienteCard). Casos restantes:
  // - 1 contrato 'borrador' con PDF -> auto-disparamos la firma. La generacion
  //   fue explicita del propietario; aqui solo encadenamos al envio a Auco.
  //   dispatchAutoFirma es idempotente (chequea solicitudes_firma existentes).
  // - Contrato en 'pendiente_firma' pero todas las solicitudes ya estan
  //   firmadas -> destrabar la UI moviendo el contrato a 'firmado'.
  // - Contrato 'firmado' -> activar a 'vigente' y cerrar el expediente.
  const lista = (data ?? []) as Array<{ id: string; estado: string; storage_key?: string | null; created_at: string }>;
  if (lista.length === 1 && lista[0].estado === 'borrador' && lista[0].storage_key) {
    logger.info(
      {
        expedienteId,
        contratoId: lista[0].id,
        trigger: 'listContratosByExpediente',
      },
      'Auto-firma trigger: contrato borrador detectado en listado',
    );
    void maybeAutoFirmaExistente(expedienteId, lista[0].id, lista[0].created_at);
  } else if (lista.length > 0) {
    // Caso 3: revisar si hay contrato pendiente_firma con todas las
    // solicitudes firmadas. Solo necesitamos mirar el contrato mas reciente.
    const pendienteFirma = lista.find((c) => c.estado === 'pendiente_firma');
    if (pendienteFirma) {
      void maybeAutoTransicionarFirmado(pendienteFirma.id);
    }
    // Caso 4: contrato en 'firmado' (post-firma exitosa) -> activar a
    // 'vigente' y cerrar el expediente. El usuario quiere todo el
    // pipeline automatico hasta el final, sin intervencion manual.
    const firmado = lista.find((c) => c.estado === 'firmado');
    if (firmado) {
      void maybeAutoActivarVigente(firmado.id, expedienteId);
    }
  }

  return {
    contratos: data ?? [],
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Si el contrato esta en 'pendiente_firma' pero TODAS las solicitudes_firma
 * asociadas ya estan en estado 'firmado', transicionamos el contrato a
 * 'firmado'. Esto cubre el caso en el que post-firma.executePostFirma
 * fallo silenciosamente al ejecutar el RPC transicionar_contrato (eg.
 * por algun error transitorio o race condition con la inserción del
 * historial). Idempotente — re-llamar es seguro porque el guard inicial
 * verifica el estado actual.
 */
async function maybeAutoTransicionarFirmado(contratoId: string): Promise<void> {
  if (autoGenInflight.has(contratoId)) return;

  // 1. Confirmar estado actual del contrato.
  const { data: contratoRow } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, expediente_id')
    .eq('id', contratoId)
    .single();
  const c = contratoRow as { id: string; estado: string; expediente_id: string } | null;
  if (!c || c.estado !== 'pendiente_firma') return;

  // 2. Listar solicitudes de firma del contrato.
  const { data: solicitudesRow } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('contrato_id', contratoId);
  const solicitudes = (solicitudesRow as Array<{ id: string; estado: string }> | null) || [];
  if (solicitudes.length === 0) return;

  const todasFirmadas = solicitudes.every((s) => s.estado === 'firmado');
  if (!todasFirmadas) return;

  autoGenInflight.add(contratoId);
  logger.info(
    { contratoId, totalSolicitudes: solicitudes.length },
    'Auto-heal: contrato en pendiente_firma con todas firmas completas — transicionando a firmado',
  );

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc('transicionar_contrato', {
      p_contrato_id: contratoId,
      p_nuevo_estado: 'firmado',
      p_descripcion: 'Auto-heal: post-firma no transiciono el contrato — sincronizando estado',
      p_usuario_id: null,
      p_comentario: 'Transicion automatica detectada en list de contratos',
      p_motivo: null,
    });

    if (error) {
      logger.error(
        { contratoId, err: (error as { message?: string }).message },
        'Auto-heal: error al transicionar pendiente_firma -> firmado',
      );
      return;
    }

    await (supabase
      .from('contratos' as string) as ReturnType<typeof supabase.from>)
      .update({ fecha_firma: new Date().toISOString() } as never)
      .eq('id', contratoId);

    logger.info({ contratoId }, 'Auto-heal: contrato transicionado a firmado');
  } catch (err) {
    logger.error(
      { contratoId, err: err instanceof Error ? err.message : String(err) },
      'Auto-heal: excepcion al transicionar pendiente_firma -> firmado',
    );
  } finally {
    autoGenInflight.delete(contratoId);
  }
}

/**
 * Si el contrato esta en 'firmado', lo activamos automaticamente a
 * 'vigente' y cerramos el expediente. Esto completa el pipeline
 * auto-everything: estudio aprobado -> contrato generado -> firma
 * electronica -> contrato vigente -> expediente cerrado, sin
 * intervencion manual.
 */
async function maybeAutoActivarVigente(
  contratoId: string,
  expedienteId: string,
): Promise<void> {
  const lockKey = `activar:${contratoId}`;
  if (autoGenInflight.has(lockKey)) return;

  // 1. Confirmar estado actual.
  const { data: contratoRow } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('id', contratoId)
    .single();
  const c = contratoRow as { id: string; estado: string } | null;
  if (!c || c.estado !== 'firmado') return;

  autoGenInflight.add(lockKey);
  logger.info({ contratoId, expedienteId }, 'Auto-heal: contrato firmado — activando a vigente y cerrando expediente');

  try {
    // 2. Transicionar contrato firmado -> vigente
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: contratoErr } = await (supabase as any).rpc('transicionar_contrato', {
      p_contrato_id: contratoId,
      p_nuevo_estado: 'vigente',
      p_descripcion: 'Auto-heal: activacion automatica tras firma electronica completa',
      p_usuario_id: null,
      p_comentario: null,
      p_motivo: null,
    });

    if (contratoErr) {
      logger.error(
        { contratoId, err: (contratoErr as { message?: string }).message },
        'Auto-heal: error transicionando firmado -> vigente',
      );
      return;
    }

    // 3. Cerrar el expediente (transicion aprobado/condicionado -> cerrado).
    const { data: expRow } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('estado')
      .eq('id', expedienteId)
      .single();
    const expEstado = (expRow as { estado?: string } | null)?.estado;
    if (expEstado === 'aprobado' || expEstado === 'condicionado') {
      await (supabase
        .from('expedientes' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'cerrado', updated_at: new Date().toISOString() } as never)
        .eq('id', expedienteId);

      await (supabase
        .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
        .insert({
          expediente_id: expedienteId,
          tipo: 'contrato',
          descripcion: 'Contrato firmado por todas las partes — expediente cerrado automaticamente.',
          metadata: { automatico: true, origen: 'auto-heal-vigente' },
        } as never);
    }

    logger.info(
      { contratoId, expedienteId, expEstadoAnterior: expEstado },
      'Auto-heal: contrato vigente + expediente cerrado',
    );

    // Notificar a solicitante y propietario que el contrato esta vigente.
    notificarPartesContratoVigente(contratoId, expedienteId).catch((e) =>
      logger.warn({ error: e, contratoId }, 'Error notificando contrato vigente'),
    );
  } catch (err) {
    logger.error(
      { contratoId, expedienteId, err: err instanceof Error ? err.message : String(err) },
      'Auto-heal: excepcion al activar contrato a vigente',
    );
  } finally {
    autoGenInflight.delete(lockKey);
  }
}

/**
 * Notifica a solicitante y propietario cuando un contrato pasa a 'vigente'.
 * Resolucion de userIds:
 *   - propietario: inmueble.propietario_id (ya es perfil_id).
 *   - solicitante: lookup por email del solicitante en auth.users.
 * Tolera ausencia de perfil (caller usa .catch).
 */
async function notificarPartesContratoVigente(
  contratoId: string,
  expedienteId: string,
): Promise<void> {
  const { data: exp } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, solicitante_id, inmueble_id')
    .eq('id', expedienteId)
    .single() as { data: { id: string; numero: string | null; solicitante_id: string | null; inmueble_id: string } | null };

  if (!exp) return;

  const { data: inm } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('direccion, propietario_id')
    .eq('id', exp.inmueble_id)
    .single() as { data: { direccion: string; propietario_id: string } | null };

  const link = `/contratos/${contratoId}`;
  const direccion = inm?.direccion ?? 'el inmueble';

  if (inm?.propietario_id) {
    await notificarUsuario({
      userId: inm.propietario_id,
      tipo: 'contrato.vigente',
      titulo: 'Contrato vigente',
      mensaje: `El contrato de ${direccion} esta firmado y activo.`,
      link,
      payload: { contrato_id: contratoId, expediente_id: expedienteId },
    });
  }

  if (exp.solicitante_id) {
    const { data: sol } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .select('email')
      .eq('id', exp.solicitante_id)
      .single() as { data: { email: string } | null };
    const solicitanteUserId = await findPerfilIdByEmail(sol?.email);
    if (solicitanteUserId) {
      await notificarUsuario({
        userId: solicitanteUserId,
        tipo: 'contrato.vigente',
        titulo: 'Tu contrato esta activo',
        mensaje: `Tu contrato de ${direccion} quedo firmado y vigente.`,
        link,
        payload: { contrato_id: contratoId, expediente_id: expedienteId },
      });
    }
  }
}

async function maybeAutoFirmaExistente(
  expedienteId: string,
  contratoId: string,
  _contratoCreatedAt: string,
): Promise<void> {
  // ID unico de invocacion para correlacionar logs entre disparos concurrentes.
  // Si vemos dos invocaciones casi simultaneas con distintos invocationId, sabemos
  // exactamente cuantos hilos pasaron y cual gano la carrera del lock.
  const invocationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  // Lock ANTES del SELECT — si no, dos requests simultaneos hacen check (ambos
  // ven el lock libre) → SELECT (~100ms) → ambos llegan al `add()` → ambos
  // suben a Auco. Lo vimos en EXP-2026-0009: 2 docs Auco para el mismo
  // contrato (5DTIYSH0FO + MC7VV38CGB en 322ms de diferencia). El lock
  // memoriza por expedienteId, asi que la 2da llamada concurrente exit-early
  // mientras la 1ra termina el dispatch.
  if (autoGenInflight.has(expedienteId)) {
    logger.info(
      { expedienteId, contratoId, invocationId },
      'Auto-firma: skip — lock ya tomado por otra invocacion concurrente',
    );
    return;
  }
  autoGenInflight.add(expedienteId);
  logger.info(
    { expedienteId, contratoId, invocationId },
    'Auto-firma: lock adquirido, comenzando',
  );

  try {
    // Guard: solo expedientes 'aprobado'/'condicionado' (mismo que generacion).
    const { data: exp } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado')
      .eq('id', expedienteId)
      .maybeSingle();
    const estado = (exp as { estado?: string } | null)?.estado;
    if (estado !== 'aprobado' && estado !== 'condicionado') {
      logger.info(
        { expedienteId, contratoId, invocationId, estado },
        'Auto-firma: skip — expediente no esta en estado terminal pre-firma',
      );
      return;
    }

    logger.info(
      { expedienteId, contratoId, invocationId },
      'Auto-firma: contrato en borrador detectado — disparando envio a Auco',
    );

    await dispatchAutoFirma(contratoId, expedienteId, invocationId);

    logger.info(
      { expedienteId, contratoId, invocationId, duracionMs: Date.now() - startedAt },
      'Auto-firma: dispatch completado',
    );
  } catch (err) {
    logger.error(
      { contratoId, expedienteId, invocationId, err: err instanceof Error ? err.message : String(err) },
      'Auto-firma: error en dispatch para contrato existente',
    );
  } finally {
    autoGenInflight.delete(expedienteId);
  }
}

async function dispatchAutoFirma(contratoId: string, expedienteId: string, invocationId?: string): Promise<void> {
  const dispatchStartedAt = Date.now();
  try {
    // Guard de idempotencia: si ya existe una solicitud de firma activa
    // para este contrato, no creamos una segunda. Solo cuenta como
    // "existente" si esta en un estado activo — los terminales (cancelado/
    // firmado/expirado) si permiten re-intento.
    const { data: existingSol } = await (supabase
      .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, auco_document_code, created_at')
      .eq('contrato_id', contratoId)
      .in('estado', ['enviado', 'abierto']);
    if (existingSol && existingSol.length > 0) {
      logger.info(
        { contratoId, expedienteId, invocationId, count: existingSol.length, existing: existingSol },
        'Auto-firma: ya existe solicitud_firma activa para este contrato — skip',
      );
      return;
    }
    logger.info(
      { contratoId, expedienteId, invocationId },
      'Auto-firma: idempotency check passed (0 solicitudes activas), procediendo a Auco',
    );

    // 1. Obtener solicitante (firmante) e inmueble para mensaje a Auco
    const { data: expRow } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select(`
        id, solicitante_id, inmueble_id,
        solicitante:solicitantes!expedientes_solicitante_id_fkey(nombre, apellido, email, telefono),
        inmueble:inmuebles!expedientes_inmueble_id_fkey(propietario_id)
      `)
      .eq('id', expedienteId)
      .single();

    const exp = expRow as unknown as {
      id: string;
      solicitante_id: string | null;
      inmueble_id: string | null;
      solicitante: { nombre: string; apellido: string; email: string; telefono: string | null } | null;
      inmueble: { propietario_id: string } | null;
    } | null;

    if (!exp?.solicitante?.email) {
      logger.warn(
        { expedienteId, contratoId },
        'Auto-firma: solicitante sin email — no se puede enviar a Auco',
      );
      return;
    }
    if (!exp.inmueble?.propietario_id) {
      logger.warn(
        { expedienteId, contratoId },
        'Auto-firma: inmueble sin propietario_id — no hay enviado_por valido',
      );
      return;
    }

    // 2. Saltar contrato directamente a 'pendiente_firma'.
    //    Hacemos UPDATE directo (no via RPC executeContratoTransition)
    //    porque la state-machine exige user real con permisos. Aqui es
    //    flujo system, registramos el cambio en contrato_historial_estados.
    const { error: updErr } = await (supabase
      .from('contratos' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'pendiente_firma', updated_at: new Date().toISOString() } as never)
      .eq('id', contratoId)
      .eq('estado', 'borrador'); // guard: si alguien ya lo movio, no pisamos

    if (updErr) {
      logger.error({ contratoId, err: updErr.message }, 'Auto-firma: error transicionando contrato a pendiente_firma');
      return;
    }

    await (supabase
      .from('contrato_historial_estados' as string) as ReturnType<typeof supabase.from>)
      .insert({
        contrato_id: contratoId,
        estado_anterior: 'borrador',
        estado_nuevo: 'pendiente_firma',
        descripcion: 'Auto-envio a firma tras aprobacion de estudio (flujo system)',
        comentario: 'Generacion y envio automatico — sin intervencion del propietario',
        usuario_id: null,
      } as never);

    // 3. Crear el sobre de firma en Auco.
    //    Multi-parte (flag ON): un solo documento con arrendatario + arrendador
    //    + Cofianza. Por defecto (flag OFF): un solo firmante (arrendatario),
    //    flujo histórico intacto.
    if (env.FIRMA_MULTIPARTE_ENABLED) {
      const { crearSolicitudFirmaMultiparte } = await import('@/modules/firma/firma-multiparte.service');
      await crearSolicitudFirmaMultiparte(contratoId, exp.inmueble.propietario_id);
    } else {
      const { crearSolicitudFirma } = await import('@/modules/firma/firma.service');
      const nombreFirmante = `${exp.solicitante.nombre} ${exp.solicitante.apellido}`.trim();

      await crearSolicitudFirma(
        {
          contrato_id: contratoId,
          nombre_firmante: nombreFirmante,
          email_firmante: exp.solicitante.email,
          telefono_firmante: exp.solicitante.telefono || undefined,
          enviar_sms: false,
        },
        // El enviado_por es el propietario del inmueble (responsable
        // contractual). Cumple el FK NOT NULL a perfiles.
        exp.inmueble.propietario_id,
      );
    }

    logger.info(
      { contratoId, expedienteId, invocationId, duracionMs: Date.now() - dispatchStartedAt },
      'Auto-firma: solicitud Auco creada y email enviado al solicitante',
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Si la BD rechazo el INSERT por violacion del unique partial index
    // `solicitudes_firma_contrato_activa_unique`, otra request gano la
    // carrera y ya creo la solicitud — no es error real, downgrade a info.
    const esRaceCondition =
      errMsg.includes('solicitudes_firma_contrato_activa_unique') ||
      (errMsg.includes('duplicate key') && errMsg.includes('contrato_id'));
    if (esRaceCondition) {
      logger.info(
        { contratoId, expedienteId, invocationId, errMsg },
        'Auto-firma: race detectado — otra request ya creo la solicitud, skip',
      );
      return;
    }
    logger.error(
      { contratoId, expedienteId, invocationId, err: errMsg, duracionMs: Date.now() - dispatchStartedAt },
      'Auto-firma: fallo el envio automatico a firma — el propietario podra disparar manualmente',
    );
  }
}

// ============================================================
// Get contrato by ID
// ============================================================

// ============================================================
// Stats globales para los KPI cards del listado de contratos.
// Devuelve counts por estado. Pedido por la nueva propuesta UI
// (Mario 12-may-2026): Pendientes de generar / En proceso de firma /
// Activos.
// ============================================================
export interface ContratosStats {
  total: number
  pendientes_generar: number  // estado='borrador'
  en_proceso_firma: number    // estado='pendiente_firma'
  activos: number              // estado IN ('firmado','vigente')
  finalizados: number
  cancelados: number
  por_estado: Record<string, number>
}

export async function getContratosStats(
  userId?: string,
  userRol?: string,
): Promise<ContratosStats> {
  // Scoping propietario/inmobiliaria: sin esto los contadores mostraban
  // datos GLOBALES de la plataforma a cuentas externas (fuga cross-tenant).
  const allowedExpedienteIds = await resolveAllowedExpedienteIds(userId, userRol);
  if (allowedExpedienteIds !== null && allowedExpedienteIds.length === 0) {
    return {
      total: 0, pendientes_generar: 0, en_proceso_firma: 0,
      activos: 0, finalizados: 0, cancelados: 0, por_estado: {},
    };
  }

  let statsQuery = (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('estado');
  if (allowedExpedienteIds !== null) {
    statsQuery = statsQuery.in('expediente_id', allowedExpedienteIds);
  }
  const { data, error } = await statsQuery;

  if (error) {
    logger.error({ error: error.message }, 'Error al obtener stats de contratos');
    throw AppError.badRequest('Error al obtener estadisticas de contratos', 'STATS_ERROR');
  }

  const rows = (data as Array<{ estado: string }>) || [];
  const por_estado: Record<string, number> = {};
  for (const r of rows) {
    por_estado[r.estado] = (por_estado[r.estado] ?? 0) + 1;
  }

  return {
    total: rows.length,
    pendientes_generar: por_estado.borrador ?? 0,
    en_proceso_firma: por_estado.pendiente_firma ?? 0,
    activos: (por_estado.firmado ?? 0) + (por_estado.vigente ?? 0),
    finalizados: por_estado.finalizado ?? 0,
    cancelados: por_estado.cancelado ?? 0,
    por_estado,
  };
}

export async function getContratoById(id: string, userId?: string, userRol?: string) {
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select(CONTRATO_SELECT)
    .eq('id', id)
    .single();

  if (error || !data) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }

  // Ownership: propietario/inmobiliaria solo pueden ver contratos de sus
  // inmuebles (cierra el IDOR del detalle — mismo scope que el listado).
  // 404 en vez de 403 para no confirmar la existencia del recurso.
  const allowedExpedienteIds = await resolveAllowedExpedienteIds(userId, userRol);
  if (allowedExpedienteIds !== null) {
    const expId = (data as { expediente_id?: string | null }).expediente_id;
    if (!expId || !allowedExpedienteIds.includes(expId)) {
      throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
    }
  }

  return data;
}

// ============================================================
// Generar contrato
// ============================================================

/** Carga la modalidad de fianza (lookup) para alimentar comisión/prima/cobertura. */
async function fetchModalidadFianza(codigo: string | null | undefined): Promise<ModalidadFianza | null> {
  const { data } = await (supabase
    .from('modalidades_fianza' as string) as ReturnType<typeof supabase.from>)
    .select('codigo, nombre, comision_texto, prima_texto, cubre_canones, cubre_servicios, cubre_admin_ph, cubre_danos, cubre_penal')
    .eq('codigo', codigo || 'plena')
    .maybeSingle();
  return (data as ModalidadFianza | null) ?? null;
}

/** Regex UUID v4 — para evitar que strings como 'system' rompan la FK a perfiles. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(v: string | null | undefined): string | null {
  return v && UUID_RE.test(v) ? v : null;
}

export async function generarContrato(
  expedienteId: string,
  input: GenerarContratoInput,
  userId: string | null,
  ip?: string,
) {
  // 1. Fetch expediente data (incluye arrendador completo + coarrendatario).
  const { expediente: expRow, data: expData } = await fetchExpedienteData(expedienteId);
  const expedienteNumero = (expRow as { numero?: string }).numero || expedienteId;

  const now = new Date();
  // Prioridad: input del caller > datos persistidos en el expediente al
  // habilitar estudio > defaults (hoy + 12 meses). Asi el operador no tiene
  // que volver a digitarlos cuando el propietario ya los capturo.
  const expRecord = expRow as Record<string, unknown>;
  const fechaInicioExp = (expRecord.fecha_inicio_contrato as string | null) || null;
  const duracionMesesExp = (expRecord.duracion_contrato_meses as number | null) || null;

  const fechaInicio = input.fecha_inicio
    ? new Date(input.fecha_inicio + 'T00:00:00')
    : fechaInicioExp
      ? new Date(fechaInicioExp + 'T00:00:00')
      : new Date();
  const duracionMeses = input.duracion_meses || duracionMesesExp || 12;

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
  // Fase 3: si el caller (modal) envía condiciones de fianza, se persisten en el
  // expediente para que esta generación y futuras regeneraciones las usen.
  const condicionesUpdate: Record<string, unknown> = {};
  if (input.modalidad_fianza) condicionesUpdate.modalidad_fianza = input.modalidad_fianza;
  if (input.servicios_reparto) condicionesUpdate.servicios_reparto = input.servicios_reparto;
  if (input.cotitular) {
    const c = input.cotitular;
    condicionesUpdate.cotitular_nombre = c.nombre ?? null;
    condicionesUpdate.cotitular_tipo_documento = c.tipo_documento ?? null;
    condicionesUpdate.cotitular_documento = c.documento ?? null;
    condicionesUpdate.cotitular_celular = c.celular ?? null;
    condicionesUpdate.cotitular_correo = c.correo ?? null;
    condicionesUpdate.cotitular_direccion = c.direccion ?? null;
    condicionesUpdate.cotitular_municipio = c.municipio ?? null;
  }
  if (Object.keys(condicionesUpdate).length > 0) {
    await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .update(condicionesUpdate as never)
      .eq('id', expedienteId);
    Object.assign(expRecord, condicionesUpdate); // reflejar en el contexto de esta generación
  }

  const modalidad = await fetchModalidadFianza(expRecord.modalidad_fianza as string | null | undefined);
  const context = await buildContratoContext(expData, expedienteNumero, fechaInicio, duracionMeses, {
    modalidad,
    expediente: expRecord,
  });

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

  // Insert contrato first to get ID. Si el caller no es un usuario real
  // (ej. orchestrator pasa userId='system' o null), guardamos null en
  // generado_por: la columna es FK a perfiles(id) y un literal no-UUID
  // rompe el constraint y aborta la generacion automatica del contrato.
  const generadoPor = uuidOrNull(userId);
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
      generado_por: generadoPor,
      fecha_generacion: now.toISOString(),
      plantilla_version: plantillaRow?.version ?? null,
      nombre_archivo: nombreArchivoContrato,
    } as never)
    .select('id')
    .single();

  if (insertError || !contrato) {
    logger.error({ error: insertError?.message, expedienteId, userId }, 'Error al crear contrato');
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
      matricula_arrendador, matricula_expedida_por, matricula_fecha, logo_storage_key, logo_url,
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
    coarrendatario: null,
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
      generado_por: uuidOrNull(userId),
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
  const { data: expRowRegen } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero, modalidad_fianza, servicios_reparto, cotitular_nombre, cotitular_tipo_documento, cotitular_documento, cotitular_celular, cotitular_correo, cotitular_direccion, cotitular_municipio')
    .eq('id', row.expediente_id)
    .single();
  const expRecordRegen = (expRowRegen as Record<string, unknown> | null) ?? {};
  const expedienteNumero = (expRecordRegen.numero as string | undefined) || row.expediente_id;
  const modalidadRegen = await fetchModalidadFianza(expRecordRegen.modalidad_fianza as string | null | undefined);

  const ctx = await buildContratoContext(expData, expedienteNumero, fechaInicio, duracionMeses, {
    modalidad: modalidadRegen,
    expediente: expRecordRegen,
  });
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
    id: string;
    estado: string;
    storage_key: string;
    nombre_archivo: string;
    storage_key_firmado: string | null;
    nombre_archivo_firmado: string | null;
  };

  if (!row.storage_key) {
    throw AppError.badRequest('El contrato no tiene PDF generado', 'NO_PDF');
  }

  // Si el contrato esta firmado/vigente y todavia no tenemos archivo el
  // PDF firmado en nuestro Storage, intentamos archivarlo ahora (lazy).
  // Esto cubre contratos firmados antes de implementar el archive
  // automatico en post-firma.
  let storageKey = row.storage_key;
  let nombreArchivo = row.nombre_archivo || 'contrato.pdf';

  const esFirmado = row.estado === 'firmado' || row.estado === 'vigente';
  if (esFirmado && !row.storage_key_firmado) {
    try {
      const { archivarPdfFirmadoEnStorage } = await import('@/modules/firma/firma.service');
      await archivarPdfFirmadoEnStorage(id);
      const { data: refresh } = await (supabase
        .from('contratos' as string) as ReturnType<typeof supabase.from>)
        .select('storage_key_firmado, nombre_archivo_firmado')
        .eq('id', id)
        .single();
      const r = refresh as { storage_key_firmado: string | null; nombre_archivo_firmado: string | null } | null;
      if (r?.storage_key_firmado) {
        storageKey = r.storage_key_firmado;
        nombreArchivo = r.nombre_archivo_firmado || nombreArchivo;
      }
    } catch (err) {
      logger.warn({ error: err, contratoId: id }, 'Lazy archive del firmado fallo — sirviendo el original');
    }
  } else if (esFirmado && row.storage_key_firmado) {
    storageKey = row.storage_key_firmado;
    nombreArchivo = row.nombre_archivo_firmado || nombreArchivo;
  }

  // Si inline=true, omitimos el parámetro download para que Supabase NO
  // envíe Content-Disposition: attachment. Asi el iframe del preview puede
  // embeberlo en lugar de forzar descarga.
  const inline = options?.inline === true;
  const signOpts = inline ? undefined : { download: nombreArchivo };
  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(storageKey, DOWNLOAD_URL_EXPIRY_SECONDS, signOpts);

  if (urlError || !urlData) {
    logger.error({ error: urlError?.message, id }, 'Error al generar URL de descarga');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de descarga');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_DOWNLOADED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: id,
    detalle: { nombre_archivo: nombreArchivo, firmado: storageKey !== row.storage_key },
    ip,
  });

  return {
    url: urlData.signedUrl,
    nombre_archivo: nombreArchivo,
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

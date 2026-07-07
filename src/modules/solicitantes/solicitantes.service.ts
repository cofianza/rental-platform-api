import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { resolveInmobiliariaIdForPerfil, resolveOrgMemberPerfilIds } from '@/lib/tenantScope';
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

export async function listApplicants(query: ListApplicantsQuery, userId?: string, userRol?: string) {
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

  // Scope por rol: propietario/inmobiliaria SOLO ven los solicitantes que
  // ellos registraron (creado_por). Sin esto verían toda la base de datos
  // personales de la plataforma (fuga). Admin/operador ven todo.
  if (userId && (userRol === 'propietario' || userRol === 'inmobiliaria')) {
    qb = qb.eq('creado_por', userId);
  }

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
// Alcance de "fichas propias" (3.1)
// ============================================================

/**
 * Devuelve los creado_por que el actor puede reutilizar/buscar, o null si no
 * hay filtro (admin/operador ven toda la base). Propietario = solo las suyas.
 * Inmobiliaria = las de TODOS los miembros activos de su org: los co-miembros
 * comparten la base de solicitantes de la agencia — sin esto, el unique global
 * de documento dejaria a un miembro bloqueado (ni reutilizar ni crear) frente
 * a una ficha creada por un colega de su misma inmobiliaria.
 */
async function resolveCreadoPorScope(userId: string, userRol?: string): Promise<string[] | null> {
  if (userRol === 'propietario') return [userId];
  if (userRol === 'inmobiliaria') {
    const orgId = await resolveInmobiliariaIdForPerfil(userId);
    if (!orgId) return [userId];
    const ids = await resolveOrgMemberPerfilIds(orgId);
    if (!ids.includes(userId)) ids.push(userId);
    return ids;
  }
  return null;
}

// ============================================================
// Create
// ============================================================

export async function createApplicant(input: CreateApplicantInput, createdBy: string, ip?: string, userRol?: string) {
  // Tarea 3.1: en vez de bloquear cuando el documento ya existe, REUTILIZAMOS
  // la ficha existente (una persona = una ficha; puede tener varias solicitudes)
  // y devolvemos `reutilizado: true` para que la UI avise al gestor y verifique
  // los datos / expedientes previos. No sobrescribimos la ficha existente.
  //
  // AISLAMIENTO MULTI-TENANT (CRITICO): el documento es único POR AGENCIA (no
  // global — migración 20260707000002). El scope de dedup = el MISMO que el
  // unique key COALESCE(inmobiliaria_id, creado_por): una inmobiliaria reutiliza
  // por su ORGANIZACIÓN (inmobiliaria_id, así todos los co-miembros comparten la
  // ficha aunque la creara otro / un ex-miembro); un propietario individual por
  // su propio perfil (creado_por); admin/operador (sin org) sin filtro (ven toda
  // la base). Así, si la persona ya existe en OTRA agencia, esta agencia crea su
  // PROPIA ficha sin bloquearse y sin exponer PII ajena.
  const orgId = await resolveInmobiliariaIdForPerfil(createdBy); // null si propietario / rol interno
  const scopeIds = orgId ? null : await resolveCreadoPorScope(createdBy, userRol);

  const buildDedupQb = () => {
    let qb = (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .select(APPLICANT_FIELDS)
      .eq('tipo_documento', input.tipo_documento)
      .eq('numero_documento', input.numero_documento);
    if (orgId) qb = qb.eq('inmobiliaria_id', orgId);
    else if (scopeIds) qb = qb.in('creado_por', scopeIds);
    return qb;
  };

  const { data: existing } = await buildDedupQb().maybeSingle();

  if (existing) {
    logger.info(
      { tipo: input.tipo_documento, doc: input.numero_documento },
      'Solicitante existente reutilizado (documento duplicado en la misma agencia)',
    );
    return { ...(existing as Record<string, unknown>), reutilizado: true };
  }

  const { data, error } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .insert({ ...input, creado_por: createdBy, inmobiliaria_id: orgId } as never)
    .select(APPLICANT_FIELDS)
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al crear solicitante');
    // Carrera: otro proceso creó la misma ficha entre el SELECT y el INSERT.
    // Re-consultamos con el MISMO scope de dedup (org o creado_por): si la ficha
    // es de la propia agencia la reutilizamos; si el choque viene de otra agencia
    // (fuera de scope) NO la encontramos y caemos en DOCUMENTO_DUPLICADO sin
    // exponer su PII (no debería pasar ya con el unique por-agencia, salvo carrera
    // real dentro de la misma agencia).
    if (error.code === '23505') {
      const { data: race } = await buildDedupQb().maybeSingle();
      if (race) return { ...(race as Record<string, unknown>), reutilizado: true };
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

export async function updateApplicant(id: string, input: UpdateApplicantInput, updatedBy: string, ip?: string, userRol?: string) {
  // Obtener estado anterior para diff
  const previous = await getApplicantById(id) as { creado_por?: string | null } & Record<string, unknown>;

  // Ownership: propietario/inmobiliaria solo pueden editar los solicitantes que
  // ELLOS registraron. Sin esto, con solicitantes:update podrían modificar por
  // id el solicitante de otra inmobiliaria (IDOR de escritura). 404 para no
  // confirmar la existencia del recurso ajeno.
  if ((userRol === 'propietario' || userRol === 'inmobiliaria') && previous.creado_por !== updatedBy) {
    throw AppError.notFound('Solicitante no encontrado', 'SOLICITANTE_NOT_FOUND');
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

export async function searchByDocument(query: SearchByDocumentQuery, userId?: string, userRol?: string) {
  // AISLAMIENTO MULTI-TENANT: mismo scope que el dedup de createApplicant —
  // propietario solo encuentra sus fichas; inmobiliaria las de su org (todos
  // los miembros activos comparten la base de la agencia). Sin este filtro,
  // buscar por documento devolveria la ficha completa (PII) de un cliente de
  // otra agencia y serviria de oraculo de enumeracion de cedulas.
  // Admin/operador siguen viendo toda la base.
  const scopeIds = userId ? await resolveCreadoPorScope(userId, userRol) : null;

  let qb = (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select(APPLICANT_FIELDS)
    .eq('tipo_documento', query.document_type)
    .eq('numero_documento', query.document_number);
  if (scopeIds) qb = qb.in('creado_por', scopeIds);
  const { data, error } = await qb.maybeSingle();

  if (error) {
    logger.error({ error: error.message }, 'Error al buscar solicitante por documento');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al buscar solicitante');
  }

  return (data as unknown as ApplicantRow) || null;
}

// ============================================================
// Datos fiscales del solicitante autenticado
//
// El solicitante puede ver y actualizar SUS propios datos fiscales (tipo +
// numero documento, direccion, telefono, email, municipio_id) sin pasar por
// los endpoints admin de /:id. Lo identificamos por solicitantes.creado_por
// que apunta al perfil del usuario.
// ============================================================

export interface DatosFiscalesSolicitante {
  id: string | null;
  // Para persona natural: nombre/apellido aplican y razon_social=null.
  // Para persona juridica: razon_social aplica y nombre/apellido son secundarios.
  tipo_persona: 'natural' | 'juridica';
  nombre: string;
  apellido: string;
  razon_social: string | null;
  tipo_documento: string;
  numero_documento: string;
  /** Solo aplica cuando tipo_documento='nit' (tipicamente persona juridica). */
  digito_verificacion: string | null;
  email: string;
  telefono: string | null;
  direccion: string | null;
  municipio_id: string | null;
  municipio_nombre: string | null;
  /** Codigo DIAN de responsabilidad fiscal. ZZ=No aplica (default). */
  tribute_code: string;
  /** Lista de campos requeridos para emitir factura electronica que estan
   *  vacios o invalidos. Si len > 0 el frontend bloquea el boton de Facturar. */
  faltantes: string[];
}

export interface UpdateDatosFiscalesInput {
  tipo_persona?: 'natural' | 'juridica';
  razon_social?: string;
  tipo_documento?: string;
  numero_documento?: string;
  digito_verificacion?: string;
  email?: string;
  telefono?: string;
  direccion?: string;
  municipio_id?: string;
  municipio_nombre?: string;
  tribute_code?: string;
}

/** Tipos de documento que Colombia acepta para facturacion electronica.
 *  Pasaporte y otros documentos extranjeros NO son tributarios — se usan
 *  solo para identidad. Para Factus el solicitante debe registrar su CC,
 *  CE, TI o NIT real. */
const TIPOS_DOCUMENTO_FISCAL = ['cc', 'ce', 'ti', 'nit'] as const;

function computeFaltantes(row: {
  tipo_persona?: string | null;
  razon_social?: string | null;
  tipo_documento?: string | null;
  numero_documento?: string | null;
  digito_verificacion?: string | null;
  email?: string | null;
  telefono?: string | null;
  direccion?: string | null;
  municipio_id?: string | null;
}): string[] {
  const faltantes: string[] = [];
  // tipo_documento debe ser uno de los aceptados por Factus. Si es pasaporte
  // (registrado durante el wizard), lo marcamos como faltante para forzar al
  // solicitante a entrar a Facturacion -> Datos Fiscales y elegir su CC real.
  const tipo = row.tipo_documento?.toLowerCase();
  if (!tipo || !TIPOS_DOCUMENTO_FISCAL.includes(tipo as (typeof TIPOS_DOCUMENTO_FISCAL)[number])) {
    faltantes.push('tipo_documento');
  }
  if (!row.numero_documento) faltantes.push('numero_documento');

  // Persona juridica → razon_social obligatoria + DV requerido (NIT).
  if (row.tipo_persona === 'juridica') {
    if (!row.razon_social || row.razon_social.trim() === '') {
      faltantes.push('razon_social');
    }
    if (!row.digito_verificacion || !/^\d$/.test(row.digito_verificacion)) {
      faltantes.push('digito_verificacion');
    }
  }

  if (!row.email) faltantes.push('email');
  if (!row.telefono) faltantes.push('telefono');
  if (!row.direccion) faltantes.push('direccion');
  if (!row.municipio_id || !/^\d{5}$/.test(row.municipio_id)) faltantes.push('municipio_id');
  return faltantes;
}

export async function getMisDatosFiscales(userId: string): Promise<DatosFiscalesSolicitante> {
  // Tomamos el solicitante mas reciente del usuario (caso normal: solo 1).
  const { data, error } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, tipo_persona, nombre, apellido, razon_social, tipo_documento, numero_documento, digito_verificacion, email, telefono, direccion, municipio_id, municipio_nombre, tribute_code',
    )
    .eq('creado_por', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error({ error: error.message, userId }, 'Error al cargar datos fiscales del solicitante');
    throw new AppError(500, 'INTERNAL_ERROR', 'No pudimos cargar tus datos fiscales');
  }

  if (!data) {
    // Sin solicitante asociado — devolvemos shell vacio para que el form
    // pueda renderizar igual.
    return {
      id: null,
      tipo_persona: 'natural',
      nombre: '',
      apellido: '',
      razon_social: null,
      tipo_documento: '',
      numero_documento: '',
      digito_verificacion: null,
      email: '',
      telefono: null,
      direccion: null,
      municipio_id: null,
      municipio_nombre: null,
      tribute_code: 'ZZ',
      faltantes: ['tipo_documento', 'numero_documento', 'email', 'telefono', 'direccion', 'municipio_id'],
    };
  }

  const row = data as unknown as {
    id: string;
    tipo_persona: 'natural' | 'juridica' | null;
    nombre: string;
    apellido: string;
    razon_social: string | null;
    tipo_documento: string;
    numero_documento: string;
    digito_verificacion: string | null;
    email: string;
    telefono: string | null;
    direccion: string | null;
    municipio_id: string | null;
    municipio_nombre: string | null;
    tribute_code: string | null;
  };

  return {
    id: row.id,
    tipo_persona: row.tipo_persona ?? 'natural',
    nombre: row.nombre,
    apellido: row.apellido,
    razon_social: row.razon_social,
    tipo_documento: row.tipo_documento,
    numero_documento: row.numero_documento,
    digito_verificacion: row.digito_verificacion,
    email: row.email,
    telefono: row.telefono,
    direccion: row.direccion,
    municipio_id: row.municipio_id,
    municipio_nombre: row.municipio_nombre,
    tribute_code: row.tribute_code ?? 'ZZ',
    faltantes: computeFaltantes(row),
  };
}

export async function updateMisDatosFiscales(
  userId: string,
  input: UpdateDatosFiscalesInput,
  ip?: string,
): Promise<DatosFiscalesSolicitante> {
  // Encontrar el solicitante del usuario (validacion de pertenencia implicita).
  const { data: existente, error: findErr } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('creado_por', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findErr) {
    logger.error({ error: findErr.message, userId }, 'Error al localizar solicitante para update fiscal');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al actualizar tus datos fiscales');
  }
  if (!existente) {
    throw AppError.notFound(
      'No encontramos un solicitante asociado a tu cuenta',
      'SOLICITANTE_NOT_FOUND',
    );
  }

  const id = (existente as { id: string }).id;

  // Whitelist de campos: el solicitante NO puede cambiar nombre/apellido
  // (vienen de auth.users) ni ocupacion. SI puede cambiar tipo_persona y
  // los datos fiscales — necesarios para soportar facturacion como persona
  // juridica (empresa que arrienda).
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (input.tipo_persona !== undefined) update.tipo_persona = input.tipo_persona;
  if (input.razon_social !== undefined) update.razon_social = input.razon_social.trim() || null;
  if (input.tipo_documento !== undefined) update.tipo_documento = input.tipo_documento;
  if (input.numero_documento !== undefined) update.numero_documento = input.numero_documento.trim();
  if (input.digito_verificacion !== undefined) update.digito_verificacion = input.digito_verificacion.trim() || null;
  if (input.email !== undefined) update.email = input.email.trim();
  if (input.telefono !== undefined) update.telefono = input.telefono.trim() || null;
  if (input.direccion !== undefined) update.direccion = input.direccion.trim() || null;
  if (input.municipio_id !== undefined) update.municipio_id = input.municipio_id.trim() || null;
  if (input.municipio_nombre !== undefined) update.municipio_nombre = input.municipio_nombre.trim() || null;
  if (input.tribute_code !== undefined) update.tribute_code = input.tribute_code.trim() || 'ZZ';

  const { error: updErr } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .update(update as never)
    .eq('id', id);

  if (updErr) {
    logger.error({ error: updErr.message, id, userId }, 'Error al actualizar datos fiscales');
    throw new AppError(500, 'INTERNAL_ERROR', 'No pudimos guardar tus datos fiscales');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.SOLICITANTE_UPDATED,
    entidad: AUDIT_ENTITIES.SOLICITANTE,
    entidadId: id,
    detalle: { fields: Object.keys(input), origen: 'self_update_fiscal' },
    ip,
  });

  return getMisDatosFiscales(userId);
}

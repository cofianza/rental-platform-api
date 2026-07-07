import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';

/**
 * Scoping multi-tenant centralizado.
 *
 * Antes existían 3 copias casi idénticas de `resolveAllowedExpedienteIds`
 * (estudios, contratos, citas) que filtraban por `inmuebles.propietario_id`.
 * Con la introducción de organizaciones (tabla `inmobiliarias` +
 * `inmobiliaria_miembros`) el scoping de un usuario `inmobiliaria` pasa a ser
 * por ORGANIZACIÓN (todos los miembros comparten la cartera), no por su perfil
 * individual. Este módulo es la única fuente de verdad de ese cálculo.
 *
 * Recordatorio de arquitectura: el API usa la service_role key que bypassa
 * RLS, así que TODO el aislamiento de datos vive aquí, en la capa de app.
 */

// Roles internos: ven todos los datos (sin filtro de tenant).
const INTERNAL_ROLES = ['administrador', 'operador_analista', 'gerencia_consulta'];

/**
 * IDs de las organizaciones (inmobiliarias) a las que pertenece un perfil
 * como miembro ACTIVO. Vacío si no pertenece a ninguna.
 */
export async function resolveMembershipInmobiliariaIds(perfilId: string): Promise<string[]> {
  const { data } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .select('inmobiliaria_id')
    .eq('perfil_id', perfilId)
    .eq('estado', 'activo');
  return ((data as Array<{ inmobiliaria_id: string }> | null) || []).map((m) => m.inmobiliaria_id);
}

/**
 * Membresía ACTIVA del perfil (en Fase 1 cada perfil pertenece a lo sumo a una
 * organización) junto con el flag `miembros_ven_todo` de esa organización.
 * NULL si no pertenece a ninguna.
 */
async function getActiveMembership(
  perfilId: string,
): Promise<{ orgId: string; rolMiembro: string; venTodo: boolean } | null> {
  const { data } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .select('inmobiliaria_id, rol_miembro, inmobiliarias(miembros_ven_todo)')
    .eq('perfil_id', perfilId)
    .eq('estado', 'activo')
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as {
    inmobiliaria_id: string;
    rol_miembro: string;
    inmobiliarias: { miembros_ven_todo: boolean } | null;
  };
  return {
    orgId: row.inmobiliaria_id,
    rolMiembro: row.rol_miembro,
    venTodo: row.inmobiliarias?.miembros_ven_todo ?? true,
  };
}

/**
 * rol_miembro ('owner' | 'miembro' | 'solo_lectura') del perfil en su
 * organización activa, o null si no es miembro de ninguna (rol interno,
 * propietario, o inmobiliaria sin org). Lo usa /auth/me para que el front
 * sepa si el usuario es titular (no se gatea) o staff.
 */
export async function resolveRolMiembro(perfilId: string): Promise<string | null> {
  const m = await getActiveMembership(perfilId);
  return m?.rolMiembro ?? null;
}

/**
 * Perfil CANÓNICO que guarda los datos de arrendador de la organización
 * ("Datos para contrato" + documentos legales "Mi Inmobiliaria"). Para un
 * usuario de una inmobiliaria es SIEMPRE el titular principal de la org
 * (`inmobiliarias.owner_perfil_id`), de modo que todo el equipo comparte los
 * mismos datos y los contratos los usan sin importar quién creó el inmueble.
 * Para un propietario individual o un rol interno, es su propio perfilId.
 */
export async function resolveOrgCanonicalPerfilId(perfilId: string): Promise<string> {
  const m = await getActiveMembership(perfilId);
  if (!m) return perfilId;
  const { data } = await (supabase
    .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
    .select('owner_perfil_id')
    .eq('id', m.orgId)
    .maybeSingle();
  const ownerId = (data as { owner_perfil_id?: string | null } | null)?.owner_perfil_id ?? null;
  return ownerId ?? perfilId;
}

/**
 * Nombre del dueño para AVISOS (correo / WhatsApp / in-app). Prioridad:
 *   1) razón social del perfil (si la editó en "Datos para contrato"),
 *   2) nombre de la INMOBILIARIA (inmobiliarias.nombre, fijado al registrarse)
 *      — así no cae al nombre personal del titular cuando la razón social está
 *      vacía,
 *   3) nombre + apellido.
 * Para un propietario individual (sin organización) devuelve su nombre+apellido,
 * que es lo correcto (es una persona, no una empresa).
 */
export async function resolveNombreDueno(perfilId: string): Promise<string> {
  const { data: p } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('nombre, apellido, razon_social')
    .eq('id', perfilId)
    .maybeSingle();
  const perfil = p as { nombre?: string | null; apellido?: string | null; razon_social?: string | null } | null;

  const razon = (perfil?.razon_social || '').trim();
  if (razon) return razon;

  const m = await getActiveMembership(perfilId);
  if (m?.orgId) {
    const { data: org } = await (supabase
      .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
      .select('nombre')
      .eq('id', m.orgId)
      .maybeSingle();
    const nombreOrg = ((org as { nombre?: string | null } | null)?.nombre || '').trim();
    if (nombreOrg) return nombreOrg;
  }

  return `${perfil?.nombre ?? ''} ${perfil?.apellido ?? ''}`.trim() || 'Hola';
}

/** ¿El perfil es titular (owner) de SU organización activa? Para gatear la
 *  edición de los datos compartidos de la org (solo titulares editan). */
export async function esTitularDeSuOrg(perfilId: string): Promise<boolean> {
  const m = await getActiveMembership(perfilId);
  return m?.rolMiembro === 'owner';
}

export type VisibilityScope =
  | { kind: 'all' } // rol interno: ve todo
  | { kind: 'org'; orgIds: string[] } // owner, o miembro con miembros_ven_todo=true
  | { kind: 'own'; perfilId: string } // miembro restringido, o propietario individual
  | { kind: 'none' }; // otros roles (no scopeados por aquí)

/**
 * Alcance de visibilidad del usuario — Fase 3, única fuente de verdad de
 * "qué puede ver". El owner SIEMPRE ve toda la org; un miembro ve toda la org
 * sólo si `miembros_ven_todo=true`; si está en false, ve solo lo suyo.
 */
export async function resolveVisibilityScope(
  userId?: string,
  userRol?: string,
): Promise<VisibilityScope> {
  if (!userId || !userRol) return { kind: 'none' };
  if (INTERNAL_ROLES.includes(userRol)) return { kind: 'all' };
  if (userRol === 'inmobiliaria') {
    const m = await getActiveMembership(userId);
    if (!m) return { kind: 'own', perfilId: userId }; // inmobiliaria sin org (defensivo)
    if (m.rolMiembro === 'owner' || m.venTodo) return { kind: 'org', orgIds: [m.orgId] };
    return { kind: 'own', perfilId: userId }; // miembro restringido
  }
  if (userRol === 'propietario') return { kind: 'own', perfilId: userId };
  return { kind: 'none' };
}

/** ¿El perfil es OWNER activo de la organización dada? */
export async function esOwnerDeOrg(perfilId: string, orgId: string): Promise<boolean> {
  const { data } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('perfil_id', perfilId)
    .eq('inmobiliaria_id', orgId)
    .eq('rol_miembro', 'owner')
    .eq('estado', 'activo')
    .maybeSingle();
  return !!data;
}

/**
 * ¿El perfil es un miembro 'solo_lectura' (viewer) ACTIVO de ALGUNA organización?
 * Los viewers ven la cartera (resolveVisibilityScope les da org/own) pero no
 * pueden mutar datos — el bloqueo de escritura se aplica en authMiddleware.
 * Role-agnóstico: sólo necesita el perfilId (el caller ya sabe que es rol
 * 'inmobiliaria'). Devuelve false si no tiene ninguna membresía solo_lectura.
 */
export async function esMiembroSoloLectura(perfilId: string): Promise<boolean> {
  const { data } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('perfil_id', perfilId)
    .eq('rol_miembro', 'solo_lectura')
    .eq('estado', 'activo')
    .limit(1)
    .maybeSingle();
  return !!data;
}

/** ¿El perfil es MIEMBRO activo no-owner de la organización dada? (para auto-asignar al creador). */
export async function esMiembroNoOwnerDeOrg(perfilId: string, orgId: string): Promise<boolean> {
  const { data } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('perfil_id', perfilId)
    .eq('inmobiliaria_id', orgId)
    .eq('rol_miembro', 'miembro')
    .eq('estado', 'activo')
    .maybeSingle();
  return !!data;
}

/** perfil_ids de los miembros ACTIVOS de una organización. */
export async function resolveOrgMemberPerfilIds(orgId: string): Promise<string[]> {
  const { data } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .select('perfil_id')
    .eq('inmobiliaria_id', orgId)
    .eq('estado', 'activo')
    .not('perfil_id', 'is', null);
  return ((data as Array<{ perfil_id: string | null }> | null) || [])
    .map((m) => m.perfil_id)
    .filter((id): id is string => !!id);
}

/**
 * Inmuebles que el perfil "posee" en el modo restringido (own): los que
 * registró (propietario_id) MÁS los que tiene asignados como responsable
 * (miembro_responsable_id, Fase 3). perfilId viene del JWT (UUID validado),
 * seguro de interpolar en el .or().
 */
async function resolveOwnInmuebleIds(perfilId: string): Promise<string[]> {
  const { data } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .or(`propietario_id.eq.${perfilId},miembro_responsable_id.eq.${perfilId}`);
  return ((data as Array<{ id: string }> | null) || []).map((i) => i.id);
}

/**
 * Inmueble IDs del "portafolio" visible del perfil, respetando
 * `miembros_ven_todo`. Owner / miembro-ve-todo -> cartera de la org (+ propios);
 * miembro restringido o propietario individual -> sólo los propios. Siempre
 * devuelve lista (nunca null). Role-agnóstico (sólo necesita perfilId) — sirve
 * a los endpoints "mis-*" del dashboard.
 */
export async function resolvePortfolioInmuebleIds(perfilId: string): Promise<string[]> {
  const m = await getActiveMembership(perfilId);

  // Miembro restringido (miembros_ven_todo=false) o propietario individual.
  if (!m || (m.rolMiembro !== 'owner' && !m.venTodo)) {
    return resolveOwnInmuebleIds(perfilId);
  }

  // Ve toda la cartera de la organización (+ propios, defensivo).
  const ids = new Set<string>();
  const { data: porOrg } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .in('inmobiliaria_id', [m.orgId]);
  ((porOrg as Array<{ id: string }> | null) || []).forEach((i) => ids.add(i.id));
  (await resolveOwnInmuebleIds(perfilId)).forEach((id) => ids.add(id));
  return Array.from(ids);
}

/**
 * Reporter perfil_ids cuyas moras puede ver el usuario (Fase 3, piece 1).
 *  - null -> sin filtro (rol interno).
 *  - []   -> ninguno.
 *  - [...] -> en modo org, todos los miembros; en modo own, solo él mismo.
 */
export async function resolveAllowedReporterIds(
  userId?: string,
  userRol?: string,
): Promise<string[] | null> {
  const scope = await resolveVisibilityScope(userId, userRol);
  if (scope.kind === 'all') return null;
  if (scope.kind === 'own') return [scope.perfilId];
  if (scope.kind === 'org') {
    const ids = new Set<string>();
    for (const orgId of scope.orgIds) {
      (await resolveOrgMemberPerfilIds(orgId)).forEach((id) => ids.add(id));
    }
    return Array.from(ids);
  }
  return [];
}

/**
 * Inmueble IDs visibles para el usuario según su rol / organización.
 *  - null  -> rol interno (admin/operador/gerencia): sin filtro, ve todo.
 *  - []    -> propietario/inmobiliaria sin inmuebles: respuesta vacía.
 *  - [...] -> inmueble IDs accesibles.
 *
 * `inmobiliaria`: ve la cartera de TODAS sus organizaciones
 *   (inmuebles.inmobiliaria_id) más, defensivamente, los inmuebles
 *   registrados directamente a su propio perfil (propietario_id) por si
 *   quedara alguna fila sin etiquetar tras el backfill.
 * `propietario`: ve solo sus inmuebles (propietario_id = userId).
 * Otros roles (p.ej. solicitante) no se scopean por inmueble aquí -> [].
 */
export async function resolveAllowedInmuebleIds(
  userId?: string,
  userRol?: string,
): Promise<string[] | null> {
  if (!userId || !userRol) return null;
  if (INTERNAL_ROLES.includes(userRol)) return null;

  if (userRol === 'inmobiliaria') {
    return resolvePortfolioInmuebleIds(userId);
  }

  if (userRol === 'propietario') {
    const { data } = await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('propietario_id', userId);
    return ((data as Array<{ id: string }> | null) || []).map((i) => i.id);
  }

  return [];
}

/**
 * Expediente IDs accesibles por el usuario (scoping vía inmueble).
 *  - null  -> sin filtro (rol interno).
 *  - []    -> respuesta vacía.
 *  - [...] -> expediente IDs accesibles.
 *
 * Mantiene la firma `(userId?, userRol?)` y el contrato (null | [] | ids) de
 * las antiguas copias locales para no tocar los call-sites de estudios /
 * contratos / citas.
 */
export async function resolveAllowedExpedienteIds(
  userId?: string,
  userRol?: string,
): Promise<string[] | null> {
  const inmuebleIds = await resolveAllowedInmuebleIds(userId, userRol);
  if (inmuebleIds === null) return null; // rol interno: sin filtro

  const ids = new Set<string>();

  // Expedientes de los inmuebles visibles (cartera de la org, o propios).
  if (inmuebleIds.length > 0) {
    const { data } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .in('inmueble_id', inmuebleIds);
    ((data as Array<{ id: string }> | null) || []).forEach((e) => ids.add(e.id));
  }

  // Modo restringido (Fase 3.1): sumar los expedientes asignados directamente
  // al miembro como responsable, aunque el inmueble no sea suyo.
  const scope = await resolveVisibilityScope(userId, userRol);
  if (scope.kind === 'own') {
    const { data } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('miembro_responsable_id', scope.perfilId);
    ((data as Array<{ id: string }> | null) || []).forEach((e) => ids.add(e.id));
  }

  return Array.from(ids);
}

/**
 * Organización (inmobiliaria_id) a la que debe asociarse un dato nuevo
 * creado por / para el perfil dado. NULL si el perfil no pertenece a ninguna
 * organización (p.ej. propietario individual). En Fase 1 cada perfil
 * pertenece a lo sumo a una organización, así que se toma la primera activa.
 */
export async function resolveInmobiliariaIdForPerfil(perfilId: string): Promise<string | null> {
  const orgIds = await resolveMembershipInmobiliariaIds(perfilId);
  return orgIds[0] ?? null;
}

/**
 * ¿El perfil puede acceder a un inmueble como "dueño"? True si es el
 * propietario_id directo, o (rol 'inmobiliaria') si es miembro activo de la
 * organización dueña del inmueble. Única fuente de verdad del chequeo de
 * ownership que antes estaba duplicado como `propietario_id === userId` en
 * cada guard (citas, habilitación, soportes, workflow, contratos, etc.).
 */
export async function perfilEsDuenoDeInmueble(params: {
  userId: string;
  userRol: string;
  inmueblePropietarioId: string | null | undefined;
  inmuebleInmobiliariaId?: string | null;
}): Promise<boolean> {
  const { userId, userRol, inmueblePropietarioId, inmuebleInmobiliariaId } = params;
  if (inmueblePropietarioId && inmueblePropietarioId === userId) return true;
  if (userRol === 'inmobiliaria' && inmuebleInmobiliariaId) {
    const orgIds = await resolveMembershipInmobiliariaIds(userId);
    return orgIds.includes(inmuebleInmobiliariaId);
  }
  return false;
}

/**
 * Guard de propiedad a nivel EXPEDIENTE para endpoints por-id. Lanza 404 si el
 * usuario NO puede acceder al expediente (mismo trato que "no existe", para no
 * filtrar existencia cross-tenant). No hace nada para llamadas SIN identidad
 * (procesos internos/sistema que pasan userId/userRol undefined) ni para roles
 * internos (admin/operador/gerencia: ven todo).
 *
 * Es la contraparte a nivel-expediente de getContratoById(id, userId, userRol):
 * úsalo en cualquier endpoint por-id que devuelva o mute un recurso ligado a un
 * expediente (pagos, firma, facturas, timeline, transiciones...). El caller
 * resuelve el expediente_id del recurso y llama a este guard antes de exponer/
 * mutar datos. NO re-derives el scoping inline (única fuente de verdad aquí).
 */
export async function assertExpedienteAccess(
  expedienteId: string,
  userId?: string,
  userRol?: string,
): Promise<void> {
  if (!userId || !userRol) return; // sin identidad: no gatear (llamadas de sistema)
  if (INTERNAL_ROLES.includes(userRol)) return; // ve todo

  // Solicitante: dueño vía solicitantes.creado_por → expedientes.solicitante_id
  // (mismo criterio que list()/getMyExpedienteByInmueble; resolveAllowedExpedienteIds
  // NO cubre al solicitante, cuyo scope es 'none').
  if (userRol === 'solicitante') {
    const { data: exp } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('solicitante_id')
      .eq('id', expedienteId)
      .maybeSingle();
    const solicitanteId = (exp as { solicitante_id?: string } | null)?.solicitante_id;
    if (solicitanteId) {
      const { data: sol } = await (supabase
        .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
        .select('id')
        .eq('id', solicitanteId)
        .eq('creado_por', userId)
        .maybeSingle();
      if (sol) return;
    }
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  // propietario / inmobiliaria: cartera de inmuebles (+ responsable asignado).
  const allowed = await resolveAllowedExpedienteIds(userId, userRol);
  if (allowed !== null && !allowed.includes(expedienteId)) {
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }
}

/**
 * Garantiza que un perfil (rol 'inmobiliaria') tenga SU organización con
 * membresía 'owner' activa. Idempotente: si ya existe la org del owner, la
 * devuelve sin duplicar. Se usa al registrar una inmobiliaria NUEVA, porque
 * el backfill de la migración sólo creó orgs para las inmobiliarias que ya
 * existían en su momento; sin esto, una inmobiliaria registrada después no
 * podría invitar miembros (no sería owner de ninguna org).
 */
export async function ensureOrgConOwner(perfilId: string, nombre: string): Promise<string> {
  const { data: existing } = await (supabase
    .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('owner_perfil_id', perfilId)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;

  const { data: created, error } = await (supabase
    .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
    .insert({ nombre: nombre?.trim() || 'Inmobiliaria', owner_perfil_id: perfilId } as never)
    .select('id')
    .single();
  if (error || !created) {
    throw error ?? new Error('No se pudo crear la organización');
  }
  const inmobiliariaId = (created as { id: string }).id;

  await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .insert({
      inmobiliaria_id: inmobiliariaId,
      perfil_id: perfilId,
      rol_miembro: 'owner',
      estado: 'activo',
    } as never);

  return inmobiliariaId;
}

import { supabase } from '@/lib/supabase';

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
  if (inmuebleIds === null) return null;
  if (inmuebleIds.length === 0) return [];

  const { data } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .in('inmueble_id', inmuebleIds);
  return ((data as Array<{ id: string }> | null) || []).map((e) => e.id);
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

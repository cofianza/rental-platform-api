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
 * Inmueble IDs que conforman el "portafolio" de un perfil: los suyos
 * (propietario_id) MÁS los de las organizaciones donde es miembro activo.
 * Para un propietario individual = sus inmuebles; para un miembro de una
 * inmobiliaria = la cartera completa de su organización. Siempre devuelve
 * lista (nunca null); [] si no tiene ninguno. Role-agnóstico — sirve para los
 * endpoints "mis-*" del dashboard que sólo reciben el perfilId.
 */
export async function resolvePortfolioInmuebleIds(perfilId: string): Promise<string[]> {
  const ids = new Set<string>();

  const orgIds = await resolveMembershipInmobiliariaIds(perfilId);
  if (orgIds.length > 0) {
    const { data: porOrg } = await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .in('inmobiliaria_id', orgIds);
    ((porOrg as Array<{ id: string }> | null) || []).forEach((i) => ids.add(i.id));
  }

  // Inmuebles registrados directamente a su perfil (propietario individual o
  // inmobiliaria de un solo usuario; también cubre filas sin etiquetar).
  const { data: porPerfil } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('propietario_id', perfilId);
  ((porPerfil as Array<{ id: string }> | null) || []).forEach((i) => ids.add(i.id));

  return Array.from(ids);
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

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

// ── Membresias activas por perfil, cacheadas ───────────────────
// Cada listado resolvia la membresia 2-3 veces (resolveAllowedInmuebleIds +
// resolveVisibilityScope + permisos) con la misma consulta. Una sola query
// por perfil, cacheada con el mismo horizonte que authCache (auth.ts).
// Las rutas que mutan membresias llaman invalidateMembresiasCache() al
// responder (inmobiliaria-miembros.routes.ts).
// ponytail: cache por replica; con multi-replica el otro nodo tarda hasta
// TTL en ver un cambio (mismo trade-off que el auth cache).
const MEMBRESIAS_TTL_MS = 30_000;
type FilaMembresia = {
  inmobiliaria_id: string;
  rol_miembro: string;
  inmobiliarias: { nombre: string | null; miembros_ven_todo: boolean } | null;
};
const membresiasCache = new Map<string, { expira: number; filas: FilaMembresia[] }>();

async function loadMembresiasActivas(perfilId: string): Promise<FilaMembresia[]> {
  const hit = membresiasCache.get(perfilId);
  if (hit && hit.expira > Date.now()) return hit.filas;
  const { data, error } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .select('inmobiliaria_id, rol_miembro, inmobiliarias(nombre, miembros_ven_todo)')
    .eq('perfil_id', perfilId)
    .eq('estado', 'activo')
    // Sin este orden, getActiveMembership toma el [0] de un conjunto que
    // Postgres no garantiza estable: un perfil en dos organizaciones obtendria
    // un rol_miembro / venTodo / orgId distinto entre peticiones, y los bugs de
    // permisos saldrian irreproducibles. Gana la membresia mas antigua.
    // Hoy ningun perfil tiene dos (verificado en produccion, 2026-09-15); si
    // eso cambia y hace falta priorizar 'owner', se ordena aqui.
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  const filas = (data as unknown as FilaMembresia[] | null) ?? [];
  if (!error) membresiasCache.set(perfilId, { expira: Date.now() + MEMBRESIAS_TTL_MS, filas });
  return filas;
}

export function invalidateMembresiasCache(perfilId?: string): void {
  if (perfilId) membresiasCache.delete(perfilId);
  else membresiasCache.clear();
}

/**
 * IDs de las organizaciones (inmobiliarias) a las que pertenece un perfil
 * como miembro ACTIVO. Vacío si no pertenece a ninguna.
 */
export async function resolveMembershipInmobiliariaIds(perfilId: string): Promise<string[]> {
  return (await loadMembresiasActivas(perfilId)).map((m) => m.inmobiliaria_id);
}

/** Membresía activa (cacheada) del perfil; la usa también el listado del equipo. */
export async function getActiveMembership(
  perfilId: string,
): Promise<{ orgId: string; rolMiembro: string; venTodo: boolean; nombreOrg: string | null } | null> {
  const row = (await loadMembresiasActivas(perfilId))[0];
  if (!row) return null;
  return {
    orgId: row.inmobiliaria_id,
    rolMiembro: row.rol_miembro,
    venTodo: row.inmobiliarias?.miembros_ven_todo ?? true,
    nombreOrg: row.inmobiliarias?.nombre ?? null,
  };
}

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
  return (await nombreDelDueno(perfilId)) || 'Hola';
}

/** El nombre de resolveNombreDueno, o '' si el perfil no tiene ninguno. */
async function nombreDelDueno(perfilId: string): Promise<string> {
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

  return `${perfil?.nombre ?? ''} ${perfil?.apellido ?? ''}`.trim();
}

/**
 * Perfil canónico del INMUEBLE: el titular principal de su inmobiliaria o, sin
 * organización, su propietario. Va por el inmueble y no por quien lo registró:
 * un asesor que sale del equipo no se lleva la agenda ni los avisos.
 */
export async function resolvePerfilCanonicoDeInmueble(inm: {
  propietario_id: string;
  inmobiliaria_id: string | null;
}): Promise<string> {
  if (!inm.inmobiliaria_id) return inm.propietario_id;
  const { data } = await (supabase
    .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
    .select('owner_perfil_id')
    .eq('id', inm.inmobiliaria_id)
    .maybeSingle();
  return (data as { owner_perfil_id?: string | null } | null)?.owner_perfil_id ?? inm.propietario_id;
}

/**
 * Nombre y WhatsApp (el de recaudo o, si no hay, el teléfono) del dueño, para
 * escribirle. `nombre` null si no tiene ninguno: el llamador pone su texto
 * (nunca el «Hola» de resolveNombreDueno, que es para saludos).
 */
export async function resolveContactoDueno(
  perfilId: string,
): Promise<{ nombre: string | null; whatsapp: string | null }> {
  const { data } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('whatsapp_recaudo, telefono')
    .eq('id', perfilId)
    .maybeSingle();
  const p = data as { whatsapp_recaudo?: string | null; telefono?: string | null } | null;
  return { nombre: (await nombreDelDueno(perfilId)) || null, whatsapp: p?.whatsapp_recaudo || p?.telefono || null };
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
 * La cartera de un perfil como CONDICIÓN (no como lista de ids), para decidir
 * en una sola consulta. Es la misma regla de siempre:
 *  - inmueble visible: lo registró él (propietario_id), o lo tiene asignado
 *    (miembro_responsable_id, salvo el propietario por rol), o es de una org
 *    que ve completa (owner, o miembro con miembros_ven_todo);
 *  - expediente visible: su inmueble es visible, o (modo restringido /
 *    propietario) se lo asignaron a él como responsable.
 * null = el rol no tiene cartera (no ve nada por aquí).
 */
interface Cartera {
  perfilId: string;
  orgIds: string[];
  inmueblesAsignados: boolean;
  expedientesAsignados: boolean;
}

async function carteraDe(perfilId: string, rol: 'inmobiliaria' | 'propietario' | 'portafolio'): Promise<Cartera | null> {
  if (rol === 'propietario') return { perfilId, orgIds: [], inmueblesAsignados: false, expedientesAsignados: true };
  // 'inmobiliaria' y 'portafolio' (resolvePortfolioInmuebleIds, agnóstico de rol) siguen la membresía.
  const m = await getActiveMembership(perfilId);
  const completa = !!m && (m.rolMiembro === 'owner' || m.venTodo);
  return { perfilId, orgIds: completa ? [m!.orgId] : [], inmueblesAsignados: true, expedientesAsignados: !completa };
}

/**
 * La condición de inmueble visible en sintaxis de PostgREST (`.or()`). perfilId
 * viene del JWT y orgIds de la BD (UUID), seguros de interpolar.
 */
function filtroInmuebles(c: Cartera): string {
  return [
    `propietario_id.eq.${c.perfilId}`,
    ...(c.inmueblesAsignados ? [`miembro_responsable_id.eq.${c.perfilId}`] : []),
    ...(c.orgIds.length ? [`inmobiliaria_id.in.(${c.orgIds.join(',')})`] : []),
  ].join(',');
}

interface FilaInmuebleScope {
  propietario_id: string | null;
  inmobiliaria_id: string | null;
  miembro_responsable_id: string | null;
}

/** La misma condición que filtroInmuebles, evaluada sobre una fila (para los guards por id). */
export function inmuebleVisible(c: Cartera, i: FilaInmuebleScope): boolean {
  return (
    i.propietario_id === c.perfilId ||
    (c.inmueblesAsignados && i.miembro_responsable_id === c.perfilId) ||
    (!!i.inmobiliaria_id && c.orgIds.includes(i.inmobiliaria_id))
  );
}

/** ¿Ve el expediente? Mismo criterio que resolveAllowedExpedienteIds, sin traer la cartera entera. */
export function expedienteVisible(
  c: Cartera,
  e: { miembro_responsable_id: string | null; inmueble: FilaInmuebleScope | null },
): boolean {
  return (!!e.inmueble && inmuebleVisible(c, e.inmueble)) || (c.expedientesAsignados && e.miembro_responsable_id === c.perfilId);
}

/**
 * Inmueble IDs del "portafolio" visible del perfil, respetando
 * `miembros_ven_todo`. Owner / miembro-ve-todo -> cartera de la org (+ propios);
 * miembro restringido o propietario individual -> sólo los propios. Siempre
 * devuelve lista (nunca null). Role-agnóstico (sólo necesita perfilId) — sirve
 * a los endpoints "mis-*" del dashboard.
 */
export async function resolvePortfolioInmuebleIds(perfilId: string): Promise<string[]> {
  const { data } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .or(await filtroPortafolio(perfilId));
  return ((data as Array<{ id: string }> | null) || []).map((i) => i.id);
}

/**
 * La misma cartera que resolvePortfolioInmuebleIds, como condición para un
 * `.or()` sobre `inmuebles`: la lista filtra en su propia consulta, sin traer
 * antes todos los ids (una ida menos y sin la lista en la URL).
 */
export async function filtroPortafolio(perfilId: string): Promise<string> {
  return filtroInmuebles((await carteraDe(perfilId, 'portafolio'))!);
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
 * ponytail: la lista viaja en la URL (.in()) en contratos, estudios, moras,
 * citas, facturas, dashboard y export; a ~39 bytes por uuid PostgREST la
 * rechaza hacia 200-400 ids (y sin paginar se corta en 1000 filas). Producción
 * está muy lejos (2026-09-23: 6 estudios en la org más grande). Antes de ese
 * tamaño: filtrar en la misma consulta con un embed !inner a inmuebles +
 * .or(filtroInmuebles) (como hace esta función) o con un RPC.
 *  - null  -> sin filtro (rol interno).
 *  - []    -> respuesta vacía.
 *  - [...] -> expediente IDs accesibles.
 *
 * Una sola ida a la BD: los expedientes cuyo inmueble cumple la condición de
 * cartera (join con el inmueble) y, en paralelo, los asignados como responsable.
 * Antes eran tres consultas en serie (inmuebles de la org, los propios y los
 * expedientes de esa lista de ids).
 */
export async function resolveAllowedExpedienteIds(
  userId?: string,
  userRol?: string,
): Promise<string[] | null> {
  if (!userId || !userRol) return null;
  if (INTERNAL_ROLES.includes(userRol)) return null;
  if (userRol !== 'inmobiliaria' && userRol !== 'propietario') return [];

  const c = (await carteraDe(userId, userRol))!;
  const [porInmueble, asignados] = await Promise.all([
    (supabase.from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id, inmuebles!expedientes_inmueble_id_fkey!inner(id)')
      .or(filtroInmuebles(c), { referencedTable: 'inmuebles' }),
    c.expedientesAsignados
      ? (supabase.from('expedientes' as string) as ReturnType<typeof supabase.from>)
          .select('id')
          .eq('miembro_responsable_id', userId)
      : Promise.resolve({ data: [] }),
  ]);
  const ids = new Set<string>();
  for (const r of [porInmueble, asignados])
    ((r.data as Array<{ id: string }> | null) || []).forEach((e) => ids.add(e.id));
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
 * ¿El perfil es "dueño" del inmueble a nivel de ORGANIZACIÓN? True si es el
 * propietario_id directo, o (rol 'inmobiliaria') si es miembro activo de la
 * organización dueña, sin mirar miembros_ven_todo. Solo para guards que ya
 * pasaron por assertExpedienteAccess o que por diseño son de toda la org
 * (liberar con crédito). Para abrir o tocar un inmueble por id, usar
 * assertInmuebleAccess: esta dejaba al miembro restringido abrir la cartera
 * de sus compañeros.
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
 * Guard a nivel INMUEBLE para endpoints por-id (detalle, edición, fotos,
 * cambios, contrato vigente, vitrina, contrato tipo, crear estudios...). Lanza
 * 404 si el inmueble no está en la cartera del usuario: la misma regla que la
 * lista, decidida sobre ESTA fila (una consulta, en paralelo con la membresía).
 * Así el miembro restringido (miembros_ven_todo = false) tampoco abre por
 * enlace lo que su lista le oculta: solo lo que registró o le asignaron.
 * No-op para roles internos y llamadas sin identidad. Contraparte a
 * nivel-inmueble de assertExpedienteAccess.
 */
export async function assertInmuebleAccess(
  inmuebleId: string,
  userId?: string,
  userRol?: string,
): Promise<void> {
  if (!userId || !userRol) return; // sin identidad: no gatear (sistema)
  if (INTERNAL_ROLES.includes(userRol)) return; // ve todo
  if (userRol !== 'inmobiliaria' && userRol !== 'propietario')
    throw AppError.notFound('Inmueble no encontrado', 'INMUEBLE_NOT_FOUND');
  const [c, { data }] = await Promise.all([
    carteraDe(userId, userRol),
    (supabase.from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .select('propietario_id, inmobiliaria_id, miembro_responsable_id')
      .eq('id', inmuebleId)
      .maybeSingle(),
  ]);
  if (!c || !data || !inmuebleVisible(c, data as FilaInmuebleScope))
    throw AppError.notFound('Inmueble no encontrado', 'INMUEBLE_NOT_FOUND');
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
    throw AppError.notFound('Estudio no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  // propietario / inmobiliaria: se decide sobre ESTE expediente (una consulta,
  // en paralelo con la membresía), no trayendo la cartera entera.
  if (userRol !== 'inmobiliaria' && userRol !== 'propietario')
    throw AppError.notFound('Estudio no encontrado', 'EXPEDIENTE_NOT_FOUND');
  const [c, { data }] = await Promise.all([
    carteraDe(userId, userRol),
    (supabase.from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select(
        'miembro_responsable_id, inmueble:inmuebles!expedientes_inmueble_id_fkey(propietario_id, inmobiliaria_id, miembro_responsable_id)',
      )
      .eq('id', expedienteId)
      .maybeSingle(),
  ]);
  const fila = data as { miembro_responsable_id: string | null; inmueble: FilaInmuebleScope | null } | null;
  if (!c || !fila || !expedienteVisible(c, fila)) {
    throw AppError.notFound('Estudio no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }
}

/**
 * ¿Ve el expediente de una fila ya leída (p.ej. embebida en el contrato)? Mismo
 * criterio que resolveAllowedExpedienteIds, sin bajar la cartera entera: true
 * sin identidad o rol interno; false para roles sin cartera (solicitante
 * incluido, a diferencia de assertExpedienteAccess).
 */
export async function puedeVerFilaExpediente(
  userId: string | undefined,
  userRol: string | undefined,
  fila: { miembro_responsable_id: string | null; inmueble: FilaInmuebleScope | null } | null,
): Promise<boolean> {
  if (!userId || !userRol || INTERNAL_ROLES.includes(userRol)) return true;
  if (userRol !== 'inmobiliaria' && userRol !== 'propietario') return false;
  const c = await carteraDe(userId, userRol);
  return !!c && !!fila && expedienteVisible(c, fila);
}

/**
 * Garantiza que un perfil (rol 'inmobiliaria') tenga SU organización con
 * membresía 'owner' activa. Idempotente: si ya existe la org del owner, la
 * devuelve sin duplicar. Se usa al registrar una inmobiliaria NUEVA, porque
 * el backfill de la migración sólo creó orgs para las inmobiliarias que ya
 * existían en su momento; sin esto, una inmobiliaria registrada después no
 * podría invitar miembros (no sería owner de ninguna org).
 */
/**
 * Deja al titular con su membresía 'owner' activa en la organización. Es el
 * paso reparador: si una creación anterior dejó la organización sin membresía,
 * el early-return por `owner_perfil_id` impedía para siempre arreglarla y la
 * cuenta quedaba inservible (no podía invitar a nadie y su scope caía a 'own').
 * No toca una membresía que ya exista, ni siquiera revocada: eso es una
 * decisión de negocio (ver reapuntarTitularPrincipalSiNecesario), no un error.
 */
async function asegurarMembresiaOwner(inmobiliariaId: string, perfilId: string): Promise<void> {
  const { data: yaEsta } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('inmobiliaria_id', inmobiliariaId)
    .eq('perfil_id', perfilId)
    .maybeSingle();
  if (yaEsta) return;

  const { error } = await (supabase
    .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
    .insert({
      inmobiliaria_id: inmobiliariaId,
      perfil_id: perfilId,
      rol_miembro: 'owner',
      estado: 'activo',
    } as never);
  if (error) throw error;

  // Sin esto, una lectura previa deja al perfil cacheado con lista vacía hasta
  // 30 s y el titular no ve su organización.
  invalidateMembresiasCache(perfilId);
}

export async function ensureOrgConOwner(perfilId: string, nombre: string): Promise<string> {
  const { data: existing } = await (supabase
    .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('owner_perfil_id', perfilId)
    .maybeSingle();
  if (existing) {
    const id = (existing as { id: string }).id;
    await asegurarMembresiaOwner(id, perfilId);
    return id;
  }

  const { data: created, error } = await (supabase
    .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
    .insert({ nombre: nombre?.trim() || 'Inmobiliaria', owner_perfil_id: perfilId } as never)
    .select('id')
    .single();
  if (error || !created) {
    throw error ?? new Error('No se pudo crear la organización');
  }
  const inmobiliariaId = (created as { id: string }).id;

  // Si esto falla lanza, pero la organización ya existe: el siguiente intento
  // entra por la rama de arriba y la repara. El caller (registro) se traga el
  // error a propósito, así que sin esa reparación la cuenta quedaba rota para
  // siempre.
  await asegurarMembresiaOwner(inmobiliariaId, perfilId);

  return inmobiliariaId;
}

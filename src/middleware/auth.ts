import { Request, Response, NextFunction } from 'express';
import { supabase, supabaseAuth } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
import { hasPermission, type Resource, type Action } from '@/config/permissions';
import { resolveRolMiembro } from '@/lib/tenantScope';
import type { UserRole } from '@/types/auth';

// Métodos que mutan estado — sujetos al bloqueo de miembros 'solo_lectura'.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Rutas que un miembro 'solo_lectura' (viewer) SÍ puede mutar pese al bloqueo
 * global de escritura: autogestión de su cuenta y su pertenencia. Deny-by-default
 * (cualquier ruta de escritura nueva queda bloqueada para viewers salvo que se
 * agregue aquí) — sesgo seguro para un rol de sólo lectura.
 */
function viewerPuedeMutar(path: string): boolean {
  return (
    path.startsWith('/api/v1/notificaciones') || // marcar leídas
    path.startsWith('/api/v1/auth') || // logout, cambio de contraseña, refresh, perfil propio (/auth/me/perfil)
    path.startsWith('/api/v1/users') || // perfil propio (con RBAC adicional)
    path === '/api/v1/inmobiliaria/miembros/salir' // salir de la organización
  );
}

/**
 * ¿El perfil personal del usuario está incompleto? Datos mínimos que un
 * miembro del equipo debe tener para administrar expedientes: nombre,
 * apellido, teléfono y documento (tipo + número). Si falta cualquiera,
 * devuelve true. Se consulta sólo en mutaciones de miembros 'miembro'.
 */
async function perfilPersonalIncompleto(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('perfiles')
    .select('nombre, apellido, telefono, tipo_documento, numero_documento')
    .eq('id', userId)
    .single();
  if (!data) return false;
  const p = data as {
    nombre: string | null; apellido: string | null; telefono: string | null;
    tipo_documento: string | null; numero_documento: string | null;
  };
  return ![p.nombre, p.apellido, p.telefono, p.tipo_documento, p.numero_documento].every(
    (v) => v != null && String(v).trim().length > 0,
  );
}

// ── Caché de autenticación por token (perf) ────────────────────────────────
// Cada request autenticado costaba 2 round-trips SECUENCIALES a Supabase
// (getUser remoto + query a perfiles). Como el front dispara varias llamadas a
// la vez por pantalla, eso multiplicaba la latencia de TODA la app. Cacheamos el
// resultado (user + perfil) por token con TTL corto y deduplicamos peticiones
// concurrentes con el mismo token (evita el "thundering herd" en la ráfaga
// inicial de una pantalla). TTL corto = un cambio de rol/desactivación se
// refleja en ≤TTL; se puede invalidar explícitamente con invalidateAuthCache.
interface AuthResolved {
  userId: string;
  email: string;
  rol: UserRole;
  estado: string;
}
const AUTH_CACHE_TTL_MS = 30_000;
const authCache = new Map<string, { value: AuthResolved; expiresAt: number }>();
const authInflight = new Map<string, Promise<AuthResolved>>();

/** Invalida el caché de auth de un usuario (llamar al cambiar rol/estado/revocar). */
export function invalidateAuthCache(userId: string): void {
  for (const [token, entry] of authCache) {
    if (entry.value.userId === userId) authCache.delete(token);
  }
}

async function resolveAuth(token: string): Promise<AuthResolved> {
  const now = Date.now();
  const cached = authCache.get(token);
  if (cached && cached.expiresAt > now) return cached.value;

  const existing = authInflight.get(token);
  if (existing) return existing;

  const promise = (async (): Promise<AuthResolved> => {
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
    if (error || !user) {
      logger.warn({ error }, 'Token invalido o expirado');
      throw AppError.unauthorized('Token invalido o expirado');
    }

    const { data: perfil, error: perfilError } = await supabase
      .from('perfiles')
      .select('id, rol, estado')
      .eq('id', user.id)
      .single();

    if (perfilError || !perfil) {
      logger.warn({ userId: user.id, error: perfilError }, 'Perfil no encontrado para usuario autenticado');
      throw AppError.unauthorized('Perfil de usuario no encontrado');
    }

    const pd = perfil as { id: string; rol: UserRole; estado: string };
    const value: AuthResolved = { userId: pd.id, email: user.email || '', rol: pd.rol, estado: pd.estado };
    // Cota de memoria: ante muchísimos tokens distintos, reseteamos el caché.
    if (authCache.size > 1000) authCache.clear();
    authCache.set(token, { value, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    return value;
  })();

  authInflight.set(token, promise);
  try {
    return await promise;
  } finally {
    authInflight.delete(token);
  }
}

/**
 * Middleware que verifica el JWT de Supabase Auth.
 * Extrae el token del header Authorization: Bearer <token>,
 * consulta la tabla perfiles para verificar rol y estado activo,
 * y adjunta la info del usuario a req.user.
 */
export async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Token de acceso requerido');
  }

  const token = authHeader.slice(7);

  const auth = await resolveAuth(token);

  if (auth.estado !== 'activo') {
    throw AppError.forbidden('Cuenta desactivada', 'ACCOUNT_INACTIVE');
  }

  // El email viene de auth.users (del token JWT), no de perfiles
  req.user = {
    id: auth.userId,
    email: auth.email,
    rol: auth.rol,
    activo: auth.estado === 'activo',
  };

  // Bloqueos de escritura para miembros de una inmobiliaria. Sólo se consulta
  // la membresía en peticiones mutantes de un usuario 'inmobiliaria' fuera de
  // la allowlist (las lecturas y otros roles no pagan el query extra). La
  // allowlist deja siempre pasar la autogestión de la cuenta — incluido
  // completar el propio perfil — para que el miembro pueda desbloquearse.
  if (req.user.rol === 'inmobiliaria' && MUTATING_METHODS.has(req.method)) {
    const path = req.originalUrl.split('?')[0];
    if (!viewerPuedeMutar(path)) {
      const rolMiembro = await resolveRolMiembro(req.user.id);

      // 1. Viewer (solo_lectura): nunca puede mutar datos de la org.
      if (rolMiembro === 'solo_lectura') {
        logger.warn({ userId: req.user.id, method: req.method, path }, 'Escritura bloqueada para miembro solo_lectura');
        throw AppError.forbidden(
          'Tu rol en la inmobiliaria es de sólo lectura: no puedes crear ni modificar datos.',
          'MIEMBRO_SOLO_LECTURA',
        );
      }

      // 2. Miembro (staff, no titular) con perfil personal incompleto: no puede
      // administrar hasta completar sus datos. El titular (owner) no se bloquea.
      if (rolMiembro === 'miembro' && (await perfilPersonalIncompleto(req.user.id))) {
        logger.warn({ userId: req.user.id, method: req.method, path }, 'Escritura bloqueada para miembro con perfil incompleto');
        throw AppError.forbidden(
          'Completá tus datos personales (nombre, apellido, teléfono y documento) en tu perfil antes de administrar expedientes.',
          'PERFIL_PERSONAL_INCOMPLETO',
        );
      }
    }
  }

  next();
}

/**
 * Middleware factory que verifica que el usuario tenga uno de los roles permitidos.
 * Debe usarse DESPUES de authMiddleware.
 */
export function roleGuard(rolesPermitidos: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw AppError.unauthorized('Autenticacion requerida');
    }

    if (!rolesPermitidos.includes(req.user.rol)) {
      logger.warn(
        { userId: req.user.id, rol: req.user.rol, rolesPermitidos },
        'Acceso denegado por rol',
      );
      throw AppError.forbidden(
        `Rol '${req.user.rol}' no tiene permisos para esta accion. Roles permitidos: ${rolesPermitidos.join(', ')}`,
      );
    }

    next();
  };
}

/**
 * Middleware factory que verifica permisos granulares por recurso y accion.
 * Debe usarse DESPUES de authMiddleware.
 *
 * @param resource - El recurso al que se accede (e.g. 'expedientes', 'usuarios')
 * @param action - La accion a realizar (e.g. 'create', 'read', 'update', 'delete')
 */
export function authorize(resource: Resource, action: Action) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw AppError.unauthorized('Autenticacion requerida');
    }

    if (!hasPermission(req.user.rol, resource, action)) {
      logger.warn(
        { userId: req.user.id, rol: req.user.rol, resource, action },
        'Acceso denegado por permisos insuficientes',
      );
      throw AppError.forbidden(
        `Sin permisos para '${action}' en '${resource}'`,
        'INSUFFICIENT_PERMISSIONS',
      );
    }

    next();
  };
}

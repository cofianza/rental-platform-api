import { Request, Response, NextFunction } from 'express';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export interface AuthUser {
  id: string;
  email: string;
  rol: string;
  activo: boolean;
}

// Extender Request de Express con el usuario autenticado
// eslint-disable-next-line @typescript-eslint/no-namespace
declare global { namespace Express { interface Request { user?: AuthUser } } }

/**
 * Middleware que verifica el JWT de Supabase Auth.
 * Extrae el token del header Authorization: Bearer <token>
 * y adjunta la info del usuario a req.user.
 */
export async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Token de acceso requerido');
  }

  const token = authHeader.slice(7);

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    logger.warn({ error }, 'Token invalido o expirado');
    throw AppError.unauthorized('Token invalido o expirado');
  }

  // Buscar perfil en tabla perfiles para verificar estado activo y rol
  const { data: perfil, error: perfilError } = await supabase
    .from('perfiles' as string)
    .select('id, email, rol, activo')
    .eq('id', data.user.id)
    .single<{ id: string; email: string; rol: string; activo: boolean }>();

  if (perfilError || !perfil) {
    logger.warn({ userId: data.user.id }, 'Perfil no encontrado para usuario autenticado');
    throw AppError.unauthorized('Perfil de usuario no encontrado');
  }

  if (!perfil.activo) {
    throw AppError.forbidden('Cuenta desactivada', 'ACCOUNT_INACTIVE');
  }

  req.user = {
    id: perfil.id,
    email: perfil.email,
    rol: perfil.rol,
    activo: perfil.activo,
  };

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

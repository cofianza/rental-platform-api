import { Request, Response, NextFunction } from 'express';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
import type { UserRole } from '@/types/auth';

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    throw new AppError(401, 'AUTH_MISSING', 'Authorization header with Bearer token is required');
  }

  const token = header.slice(7);

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    logger.debug({ error }, 'Auth token verification failed');
    throw new AppError(401, 'AUTH_INVALID', 'Invalid or expired authentication token');
  }

  // Query perfiles table to get role and verify active status
  const { data: perfil, error: perfilError } = await supabase
    .from('perfiles')
    .select('rol, estado')
    .eq('id', user.id)
    .single();

  if (perfilError || !perfil) {
    logger.debug({ error: perfilError, userId: user.id }, 'Failed to fetch user profile');
    throw new AppError(403, 'AUTH_NO_PROFILE', 'User profile not found');
  }

  const perfilData = perfil as { rol: UserRole; estado: 'activo' | 'inactivo' };

  if (perfilData.estado !== 'activo') {
    logger.debug({ userId: user.id, estado: perfilData.estado }, 'Inactive user attempted authentication');
    throw new AppError(403, 'AUTH_INACTIVE', 'User account is inactive');
  }

  if (!perfilData.rol) {
    throw new AppError(403, 'AUTH_NO_ROLE', 'User has no assigned role');
  }

  req.user = {
    id: user.id,
    email: user.email ?? '',
    role: perfilData.rol,
  };

  next();
}

export function authorize(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }

    if (!roles.includes(req.user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
    }

    next();
  };
}

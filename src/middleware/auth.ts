import { Request, Response, NextFunction } from 'express';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/errors';
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

  const role = user.app_metadata?.role as UserRole | undefined;

  if (!role) {
    throw new AppError(403, 'AUTH_NO_ROLE', 'User has no assigned role');
  }

  req.user = {
    id: user.id,
    email: user.email ?? '',
    role,
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

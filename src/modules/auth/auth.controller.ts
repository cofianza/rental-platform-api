import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import { AppError } from '@/lib/errors';
import { getPermissionsForRole, INTERNAL_ROLES, type InternalRole } from '@/config/permissions';
import * as authService from './auth.service';
import type { LoginInput, RefreshInput, ForgotPasswordInput, ResetPasswordInput, ResetTokenParams } from './auth.schema';

export async function login(req: Request, res: Response) {
  const result = await authService.loginWithEmail(req.body as LoginInput);
  sendSuccess(res, result);
}

export async function googleOAuth(_req: Request, res: Response) {
  const result = authService.getGoogleOAuthUrl();
  sendSuccess(res, result);
}

export async function refresh(req: Request, res: Response) {
  const result = await authService.refreshSession(req.body as RefreshInput);
  sendSuccess(res, result);
}

export async function logout(req: Request, res: Response) {
  const token = req.headers.authorization?.slice(7) ?? '';
  await authService.logout(token);
  sendSuccess(res, { message: 'Sesion cerrada correctamente' });
}

export async function me(req: Request, res: Response) {
  const profile = await authService.getProfile(req.user!.id);
  sendSuccess(res, profile);
}

export async function forgotPassword(req: Request, res: Response) {
  await authService.forgotPassword(req.body as ForgotPasswordInput);
  sendSuccess(res, {
    message: 'Si el email existe en nuestro sistema, recibiras un enlace de recuperacion',
  });
}

export async function validateResetToken(req: Request, res: Response) {
  const { token } = req.params as unknown as ResetTokenParams;
  const result = await authService.validateResetToken(token);
  sendSuccess(res, result);
}

export async function resetPassword(req: Request, res: Response) {
  const result = await authService.resetPassword(req.body as ResetPasswordInput);
  sendSuccess(res, result);
}

export async function permissions(req: Request, res: Response) {
  const userRole = req.user!.rol as InternalRole;

  if (!INTERNAL_ROLES.includes(userRole)) {
    throw AppError.forbidden('Rol sin permisos definidos en el sistema');
  }

  const rolePermissions = getPermissionsForRole(userRole);
  sendSuccess(res, { rol: userRole, permissions: rolePermissions });
}

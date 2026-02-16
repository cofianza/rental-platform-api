import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as authService from './auth.service';
import type { LoginInput, RefreshInput } from './auth.schema';

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

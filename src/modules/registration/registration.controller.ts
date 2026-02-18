import { Request, Response } from 'express';
import { sendCreated, sendSuccess } from '@/lib/response';
import * as registrationService from './registration.service';
import type {
  RegisterPropietarioInput,
  RegisterInmobiliariaInput,
  ResendVerificationInput,
  VerifyEmailParams,
} from './registration.schema';

export async function registerPropietario(req: Request, res: Response) {
  const input = req.body as RegisterPropietarioInput;
  const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  const result = await registrationService.registerPropietario(input, ipAddress, userAgent);
  sendCreated(res, result);
}

export async function registerInmobiliaria(req: Request, res: Response) {
  const input = req.body as RegisterInmobiliariaInput;
  const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  const result = await registrationService.registerInmobiliaria(input, ipAddress, userAgent);
  sendCreated(res, result);
}

export async function verifyEmail(req: Request, res: Response) {
  const { token } = req.params as unknown as VerifyEmailParams;
  const result = await registrationService.verifyEmail(token);
  sendSuccess(res, result);
}

export async function resendVerification(req: Request, res: Response) {
  const input = req.body as ResendVerificationInput;
  const result = await registrationService.resendVerification(input);
  sendSuccess(res, result);
}

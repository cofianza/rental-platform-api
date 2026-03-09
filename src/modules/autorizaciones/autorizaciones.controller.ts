import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as autorizacionesService from './autorizaciones.service';
import type { FirmarInput, RevocarInput, VerificarOtpInput } from './autorizaciones.schema';

// ============================================================
// Authenticated endpoints
// ============================================================

export async function getAutorizacionStatus(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const autorizacion = await autorizacionesService.getAutorizacionForExpediente(expedienteId);
  sendSuccess(res, autorizacion);
}

export async function enviarEnlace(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const result = await autorizacionesService.enviarEnlaceAutorizacion(
    expedienteId,
    req.user!.id,
    req.ip,
  );
  sendCreated(res, result);
}

export async function revocarAutorizacion(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const input = req.body as RevocarInput;
  const result = await autorizacionesService.revocarAutorizacion(
    expedienteId,
    input,
    req.user!.id,
    req.ip,
  );
  sendSuccess(res, result);
}

// ============================================================
// Public endpoints
// ============================================================

export async function getAutorizacionPublic(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const data = await autorizacionesService.getAutorizacionByToken(token);
  sendSuccess(res, data);
}

export async function firmar(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const input = req.body as FirmarInput;
  const result = await autorizacionesService.firmarAutorizacion(
    token,
    input,
    req.ip,
    req.headers['user-agent'],
  );
  sendSuccess(res, result);
}

export async function enviarOtp(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const result = await autorizacionesService.enviarOtpCode(token);
  sendSuccess(res, result);
}

export async function verificarOtp(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const { codigo } = req.body as VerificarOtpInput;
  const result = await autorizacionesService.verificarOtpCode(token, codigo);
  sendSuccess(res, result);
}

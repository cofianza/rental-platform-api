import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import { logger } from '@/lib/logger';
import { env } from '@/config';
import * as firmaService from './firma.service';
import * as otpService from './otp.service';
import * as evidenciaService from './evidencia.service';
import type { AucoWebhookPayload } from '@/lib/auco';
import type { CrearSolicitudFirmaInput, OtpVerificarInput, CompletarFirmaInput } from './firma.schema';

export async function crear(req: Request, res: Response) {
  const input = req.body as CrearSolicitudFirmaInput;
  const result = await firmaService.crearSolicitudFirma(
    input,
    req.user!.id,
    req.ip as string | undefined,
  );
  sendSuccess(res, result, 201);
}

export async function reenviar(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await firmaService.reenviarSolicitudFirma(
    id,
    req.user!.id,
    req.ip as string | undefined,
  );
  sendSuccess(res, result);
}

export async function getById(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await firmaService.getSolicitud(id);
  sendSuccess(res, result);
}

export async function listarPorContrato(req: Request, res: Response) {
  const contratoId = req.params.contratoId as string;
  const result = await firmaService.listarSolicitudes(contratoId);
  sendSuccess(res, result);
}

export async function cancelar(req: Request, res: Response) {
  const id = req.params.id as string;
  await firmaService.cancelarSolicitud(
    id,
    req.user!.id,
    req.ip as string | undefined,
  );
  sendSuccess(res, { cancelled: true });
}

export async function validarToken(req: Request, res: Response) {
  const token = req.params.token as string;
  const result = await firmaService.validarToken(token);
  sendSuccess(res, result);
}

/**
 * Auco webhook handler — receives signature status updates.
 * Validates webhook secret if configured.
 */
export async function aucoWebhook(req: Request, res: Response) {
  // Validate webhook secret if configured
  const webhookSecret = env.AUCO_WEBHOOK_SECRET;
  if (webhookSecret) {
    const authHeader = req.headers.authorization || req.headers['x-webhook-secret'];
    if (authHeader !== webhookSecret) {
      logger.warn({ ip: req.ip }, 'Auco webhook: invalid secret');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const payload = req.body as AucoWebhookPayload;

  if (!payload.code || !payload.status) {
    res.status(400).json({ error: 'Missing code or status' });
    return;
  }

  try {
    await firmaService.handleAucoWebhook(payload);
    res.status(200).json({ received: true });
  } catch (error) {
    logger.error({ error, code: payload.code }, 'Error processing Auco webhook');
    res.status(500).json({ error: 'Internal error' });
  }
}

// ============================================================
// OTP endpoints (public, protected by firma token)
// ============================================================

export async function solicitarOtp(req: Request, res: Response) {
  const token = req.params.token as string;
  const result = await otpService.solicitarOtp(token);
  sendSuccess(res, result);
}

export async function verificarOtp(req: Request, res: Response) {
  const token = req.params.token as string;
  const { codigo } = req.body as OtpVerificarInput;
  const result = await otpService.verificarOtp(token, codigo);
  sendSuccess(res, result);
}

// ============================================================
// Evidencia endpoints
// ============================================================

export async function completarFirma(req: Request, res: Response) {
  const token = req.params.token as string;
  const input = req.body as CompletarFirmaInput;
  const ip = req.headers['x-forwarded-for'] as string || req.ip || '0.0.0.0';
  const result = await evidenciaService.completarFirma(token, input, ip);
  sendSuccess(res, result);
}

export async function expirarCron(req: Request, res: Response) {
  const result = await firmaService.expirarSolicitudesVencidas();
  sendSuccess(res, result);
}

export async function getEvidencia(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await evidenciaService.getEvidencia(id);
  sendSuccess(res, result);
}

export async function downloadAcuse(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await evidenciaService.downloadAcuse(id);
  sendSuccess(res, result);
}

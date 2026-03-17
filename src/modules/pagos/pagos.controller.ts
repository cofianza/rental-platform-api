import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import { logger } from '@/lib/logger';
import * as pagosService from './pagos.service';
import type {
  CreatePaymentLinkInput,
  RegisterManualPaymentInput,
  ComprobantePresignedUrlInput,
  ListPagosQuery,
  PagoIdParams,
  ExpedienteIdParams,
} from './pagos.schema';

// ============================================================
// GET /api/v1/expedientes/:expedienteId/pagos — List pagos by expediente
// ============================================================

export async function listByExpediente(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as ExpedienteIdParams;
  const query = req.query as unknown as ListPagosQuery;
  const result = await pagosService.listPagosByExpediente(expedienteId, query);
  sendSuccess(res, result.pagos, 200, result.pagination);
}

// ============================================================
// POST /api/v1/expedientes/:expedienteId/pagos — Create payment link
// ============================================================

export async function createPaymentLink(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as ExpedienteIdParams;
  const input = req.body as CreatePaymentLinkInput;
  const pago = await pagosService.createPaymentLink(expedienteId, input, req.user!.id, req.ip);
  sendCreated(res, pago);
}

// ============================================================
// GET /api/v1/pagos/:pagoId — Get pago detail with events
// ============================================================

export async function getById(req: Request, res: Response) {
  const { pagoId } = req.params as unknown as PagoIdParams;
  const pago = await pagosService.getPagoDetailWithEvents(pagoId);
  sendSuccess(res, pago);
}

// ============================================================
// PATCH /api/v1/pagos/:pagoId/cancelar — Cancel pending payment
// ============================================================

export async function cancel(req: Request, res: Response) {
  const { pagoId } = req.params as unknown as PagoIdParams;
  const pago = await pagosService.cancelPago(pagoId, req.user!.id, req.ip);
  sendSuccess(res, pago);
}

// ============================================================
// POST /api/v1/pagos/:pagoId/reenviar-link — Resend payment link email
// ============================================================

export async function resendLink(req: Request, res: Response) {
  const { pagoId } = req.params as unknown as PagoIdParams;
  const result = await pagosService.resendPaymentLink(pagoId, req.user!.id, req.ip);
  sendSuccess(res, result);
}

// ============================================================
// POST /api/v1/expedientes/:expedienteId/pagos/manual — Register manual payment
// ============================================================

export async function registerManualPayment(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as ExpedienteIdParams;
  const input = req.body as RegisterManualPaymentInput;
  const pago = await pagosService.registerManualPayment(expedienteId, input, req.user!.id, req.ip);
  sendCreated(res, pago);
}

// ============================================================
// POST /api/v1/pagos/comprobante/presigned-url — Get presigned URL for comprobante
// ============================================================

export async function comprobantePresignedUrl(req: Request, res: Response) {
  const input = req.body as ComprobantePresignedUrlInput;
  const result = await pagosService.generateComprobantePresignedUrl(input, req.user!.id);
  sendSuccess(res, result);
}

// ============================================================
// GET /api/v1/pagos/:pagoId/comprobante — Get comprobante download URL
// ============================================================

export async function getComprobante(req: Request, res: Response) {
  const { pagoId } = req.params as unknown as PagoIdParams;
  const result = await pagosService.getComprobanteUrl(pagoId);
  sendSuccess(res, result);
}

// ============================================================
// GET /api/v1/pagos/config — Public gateway config (publishable key)
// ============================================================

export async function getConfig(_req: Request, res: Response) {
  const config = pagosService.getGatewayConfig();
  sendSuccess(res, config);
}

// ============================================================
// GET /api/v1/pagos/gateway/status — Gateway health check
// ============================================================

export async function getGatewayStatus(_req: Request, res: Response) {
  const status = await pagosService.getGatewayStatus();
  sendSuccess(res, status);
}

// ============================================================
// POST /api/v1/webhooks/pagos — Payment gateway webhook (HP-349)
// Always responds 200 to avoid gateway retries, except on invalid signature (400).
// ============================================================

export async function handleWebhook(req: Request, res: Response) {
  const signature = req.headers['stripe-signature'] as string;

  if (!signature) {
    logger.warn({ ip: req.ip }, 'Webhook request without stripe-signature header');
    res.status(400).json({ success: false, message: 'Missing signature' });
    return;
  }

  try {
    const result = await pagosService.processWebhookEvent(req.body, signature);
    sendSuccess(res, result);
  } catch (error) {
    // Signature validation errors → 400 (reject invalid requests)
    if (error && typeof error === 'object' && 'errorCode' in error && (error as { errorCode: string }).errorCode === 'WEBHOOK_SIGNATURE_INVALID') {
      logger.warn({ ip: req.ip }, 'Webhook rejected: invalid HMAC signature');
      res.status(400).json({ success: false, message: 'Invalid signature' });
      return;
    }

    // Any other internal error → still respond 200 to avoid retries
    logger.error({ error, ip: req.ip }, 'Webhook internal error — responding 200 to prevent retries');
    sendSuccess(res, { received: true });
  }
}

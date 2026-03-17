import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as pagosService from './pagos.service';
import type {
  CreatePaymentLinkInput,
  RegisterManualPaymentInput,
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
// POST /api/v1/pagos/manual — Register manual payment
// ============================================================

export async function registerManualPayment(req: Request, res: Response) {
  const input = req.body as RegisterManualPaymentInput;
  const pago = await pagosService.registerManualPayment(input, req.user!.id, req.ip);
  sendCreated(res, pago);
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
// POST /api/v1/webhooks/stripe — Stripe webhook
// ============================================================

export async function handleWebhook(req: Request, res: Response) {
  const signature = req.headers['stripe-signature'] as string;
  const result = await pagosService.processWebhookEvent(req.body, signature);
  sendSuccess(res, result);
}

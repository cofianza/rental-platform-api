import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as pagosService from './pagos.service';
import type {
  CreatePaymentLinkInput,
  RegisterManualPaymentInput,
  ListPagosQuery,
  PagoIdParams,
} from './pagos.schema';

// ============================================================
// GET /api/v1/pagos — List pagos
// ============================================================

export async function list(req: Request, res: Response) {
  const query = req.query as unknown as ListPagosQuery;
  const result = await pagosService.listPagos(query);
  sendSuccess(res, result.pagos, 200, result.pagination);
}

// ============================================================
// GET /api/v1/pagos/:id — Get pago by ID
// ============================================================

export async function getById(req: Request, res: Response) {
  const { id } = req.params as unknown as PagoIdParams;
  const pago = await pagosService.getPagoById(id);
  sendSuccess(res, pago);
}

// ============================================================
// GET /api/v1/pagos/:id/eventos — Get pago events
// ============================================================

export async function getEventos(req: Request, res: Response) {
  const { id } = req.params as unknown as PagoIdParams;
  // Verify pago exists
  await pagosService.getPagoById(id);
  const eventos = await pagosService.getEventosByPagoId(id);
  sendSuccess(res, eventos);
}

// ============================================================
// POST /api/v1/pagos/payment-link — Create payment link
// ============================================================

export async function createPaymentLink(req: Request, res: Response) {
  const input = req.body as CreatePaymentLinkInput;
  const pago = await pagosService.createPaymentLink(input, req.user!.id, req.ip);
  sendCreated(res, pago);
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

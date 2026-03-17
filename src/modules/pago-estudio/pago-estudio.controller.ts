import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as pagoEstudioService from './pago-estudio.service';
import type { ExpedienteIdParams, EnviarLinkInput, PagoIdParams } from './pago-estudio.schema';

// GET /expedientes/:expedienteId/pago-estudio/estado
export async function getEstado(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as ExpedienteIdParams;
  const result = await pagoEstudioService.getEstadoPagoEstudio(expedienteId);
  sendSuccess(res, result);
}

// POST /expedientes/:expedienteId/pago-estudio/asumir
export async function asumir(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as ExpedienteIdParams;
  const pago = await pagoEstudioService.asumirCosto(expedienteId, req.user!.id, req.ip);
  sendCreated(res, pago);
}

// POST /expedientes/:expedienteId/pago-estudio/enviar-link
export async function enviarLink(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as ExpedienteIdParams;
  const input = req.body as EnviarLinkInput;
  const pago = await pagoEstudioService.enviarLinkPago(expedienteId, input, req.user!.id, req.ip);
  sendCreated(res, pago);
}

// POST /expedientes/:expedienteId/pago-estudio/reenviar
export async function reenviar(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as ExpedienteIdParams;
  const result = await pagoEstudioService.reenviarLink(expedienteId, req.user!.id, req.ip);
  sendSuccess(res, result);
}

// POST /expedientes/:expedienteId/pago-estudio/cancelar-y-asumir
export async function cancelarYAsumir(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as ExpedienteIdParams;
  const pago = await pagoEstudioService.cancelarYAsumir(expedienteId, req.user!.id, req.ip);
  sendCreated(res, pago);
}

// GET /publico/pago-resultado/:pagoId
export async function resultadoPublico(req: Request, res: Response) {
  const { pagoId } = req.params as unknown as PagoIdParams;
  const result = await pagoEstudioService.getResultadoPagoPublico(pagoId);
  sendSuccess(res, result);
}

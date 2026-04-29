import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as service from './creditos-estudios.service';
import type {
  ComprarPaqueteInput,
  CreatePaqueteInput,
  UpdatePaqueteInput,
  ListMovimientosQuery,
  PaqueteIdParams,
  LiberarEstudioCreditoInput,
} from './creditos-estudios.schema';

// ============================================================
// Inmobiliaria
// ============================================================

export async function listPaquetes(_req: Request, res: Response) {
  const data = await service.listPaquetesActivos();
  sendSuccess(res, data);
}

export async function getMiSaldo(req: Request, res: Response) {
  const data = await service.getSaldoCreditos(req.user!.id);
  sendSuccess(res, data);
}

export async function getMisMovimientos(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: ListMovimientosQuery }).validatedQuery;
  const result = await service.listMovimientos(req.user!.id, query);
  sendSuccess(res, result.movimientos, 200, result.pagination);
}

export async function getMisCompras(req: Request, res: Response) {
  const data = await service.listCompras(req.user!.id);
  sendSuccess(res, data);
}

export async function comprarPaquete(req: Request, res: Response) {
  const input = req.body as ComprarPaqueteInput;
  const result = await service.comprarPaquete(req.user!.id, input.paquete_id, req.user!.id, req.ip);
  sendCreated(res, result);
}

// ============================================================
// Liberar estudio (consumir credito) — POST /expedientes/:id/liberar-estudio-credito
// ============================================================

export async function liberarEstudio(req: Request, res: Response) {
  const expedienteId = (req.params as { expedienteId: string }).expedienteId;
  const input = (req.body || {}) as LiberarEstudioCreditoInput;
  const result = await service.liberarEstudioConCredito(
    expedienteId,
    req.user!.id,
    req.user!.id,
    req.ip,
    input.notas,
  );
  sendCreated(res, result);
}

// ============================================================
// Super admin — CRUD paquetes
// ============================================================

export async function adminListPaquetes(_req: Request, res: Response) {
  const data = await service.listAllPaquetes();
  sendSuccess(res, data);
}

export async function adminCreatePaquete(req: Request, res: Response) {
  const input = req.body as CreatePaqueteInput;
  const data = await service.createPaquete(input, req.user!.id);
  sendCreated(res, data);
}

export async function adminUpdatePaquete(req: Request, res: Response) {
  const { id } = req.params as unknown as PaqueteIdParams;
  const input = req.body as UpdatePaqueteInput;
  const data = await service.updatePaquete(id, input, req.user!.id);
  sendSuccess(res, data);
}

export async function adminDeletePaquete(req: Request, res: Response) {
  const { id } = req.params as unknown as PaqueteIdParams;
  await service.deletePaquete(id, req.user!.id);
  sendSuccess(res, { ok: true });
}

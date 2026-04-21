import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as service from './disponibilidad.service';
import type {
  UpsertDisponibilidadInput,
  PropietarioIdParams,
  SlotsQuery,
} from './disponibilidad.schema';

// ── Propietario autenticado: su propia disponibilidad ──────

export async function getMiDisponibilidad(req: Request, res: Response) {
  const result = await service.getDisponibilidad(req.user!.id);
  sendSuccess(res, result);
}

export async function putMiDisponibilidad(req: Request, res: Response) {
  const input = req.body as UpsertDisponibilidadInput;
  const result = await service.upsertDisponibilidad(req.user!.id, input);
  sendSuccess(res, result);
}

// ── Admin/operador: disponibilidad de cualquier propietario ──

export async function getDisponibilidadAjena(req: Request, res: Response) {
  const { propietarioId } = req.params as unknown as PropietarioIdParams;
  const result = await service.getDisponibilidad(propietarioId);
  sendSuccess(res, result);
}

// ── Solicitante: slots desde inmueble ──────────────────────

export async function getSlots(req: Request, res: Response) {
  const query = req.query as unknown as SlotsQuery;
  const result = await service.getSlotsPorInmueble(query.inmueble_id, query.desde, query.hasta);
  sendSuccess(res, result);
}

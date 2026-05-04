import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as service from './expediente-habilitacion.service';
import type { ExpedienteIdParams } from './expedientes.schema';

export async function habilitarEstudio(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const body = req.body as {
    duracion_contrato_meses: number;
    fecha_inicio_contrato: string;
  };
  const result = await service.habilitarEstudio(id, req.user!.id, req.user!.rol, body);
  sendSuccess(res, result);
}

export async function rechazarEstudio(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const motivo = (req.body as { motivo?: string } | undefined)?.motivo;
  const result = await service.rechazarEstudio(id, motivo, req.user!.id, req.user!.rol);
  sendSuccess(res, result);
}

export async function aprobarCondicionado(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await service.aprobarCondicionado(id, req.user!.id, req.user!.rol);
  sendSuccess(res, result);
}

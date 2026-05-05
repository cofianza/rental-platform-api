import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as service from './expediente-soportes.service';
import type { ExpedienteIdParams } from './expedientes.schema';

export async function presignedUrl(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await service.generarPresignedUrlSoporte(
    id,
    req.user!.id,
    req.user!.rol,
    req.body,
  );
  sendSuccess(res, result);
}

export async function confirmar(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await service.confirmarSoporte(
    id,
    req.user!.id,
    req.user!.rol,
    req.body,
  );
  sendSuccess(res, result);
}

export async function listar(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await service.listarSoportes(id, req.user!.id, req.user!.rol);
  sendSuccess(res, result);
}

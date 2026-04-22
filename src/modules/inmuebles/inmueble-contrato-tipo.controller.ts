import { Request, Response } from 'express';
import { AppError } from '@/lib/errors';
import { sendSuccess } from '@/utils/response';
import * as service from './inmueble-contrato-tipo.service';

export async function subir(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  if (!req.file) {
    throw AppError.badRequest('Archivo requerido (campo "archivo")', 'FILE_REQUIRED');
  }
  const result = await service.subirContratoTipo(
    id,
    {
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    },
    req.user!.id,
    req.user!.rol,
    req.ip,
  );
  sendSuccess(res, result, undefined, 201);
}

export async function obtenerUrl(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const result = await service.obtenerUrlContratoTipo(id, req.user!.id, req.user!.rol);
  sendSuccess(res, result);
}

export async function eliminar(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const result = await service.eliminarContratoTipo(id, req.user!.id, req.user!.rol, req.ip);
  sendSuccess(res, result);
}

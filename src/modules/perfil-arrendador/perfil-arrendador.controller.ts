import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import { AppError } from '@/lib/errors';
import * as service from './perfil-arrendador.service';

export async function getMe(req: Request, res: Response) {
  const data = await service.getMiPerfilArrendador(req.user!.id);
  sendSuccess(res, data);
}

export async function getCompletitud(req: Request, res: Response) {
  const data = await service.checkPerfilCompletitud(req.user!.id);
  sendSuccess(res, data);
}

export async function updateMe(req: Request, res: Response) {
  const data = await service.updateMiPerfilArrendador(
    req.user!.id,
    req.user!.rol,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req.body as any,
    req.ip,
  );
  sendSuccess(res, data);
}

export async function uploadLogo(req: Request, res: Response) {
  // Multer pone el archivo en req.file. Validamos presencia.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const file = (req as any).file as
    | { buffer: Buffer; mimetype: string; originalname: string; size: number }
    | undefined;
  if (!file) {
    throw AppError.badRequest('Falta el archivo del logo (campo "logo")', 'NO_FILE');
  }
  const data = await service.uploadLogo(req.user!.id, req.user!.rol, file, req.ip);
  sendSuccess(res, data);
}

export async function deleteLogo(req: Request, res: Response) {
  const data = await service.deleteLogo(req.user!.id, req.ip);
  sendSuccess(res, data);
}

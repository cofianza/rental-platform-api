import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import { AppError } from '@/lib/errors';
import * as service from './documentos-legales.service';
import type { TipoDocumentoLegal } from './documentos-legales.schema';

export async function listMine(req: Request, res: Response) {
  const data = await service.listMisDocumentosLegales(req.user!.id);
  sendSuccess(res, data);
}

export async function upload(req: Request, res: Response) {
  const { tipo } = req.params as { tipo: TipoDocumentoLegal };
  if (!req.file) {
    throw AppError.badRequest('Falta el archivo en el campo "archivo"', 'MISSING_FILE');
  }
  const result = await service.uploadDocumentoLegal(
    req.user!.id,
    tipo,
    {
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      size: req.file.size,
      originalname: req.file.originalname,
    },
    req.ip,
  );
  sendSuccess(res, result);
}

export async function download(req: Request, res: Response) {
  const { tipo } = req.params as { tipo: TipoDocumentoLegal };
  const isAdmin = req.user!.rol === 'administrador';
  // Admin puede descargar de otros perfiles via ?perfilId=xxx.
  const targetPerfilId = isAdmin ? (req.query.perfilId as string | undefined) : undefined;
  const result = await service.getSignedDownloadUrl(req.user!.id, tipo, isAdmin, targetPerfilId);
  sendSuccess(res, result);
}

export async function remove(req: Request, res: Response) {
  const { tipo } = req.params as { tipo: TipoDocumentoLegal };
  await service.deleteDocumentoLegal(req.user!.id, tipo, req.ip);
  sendSuccess(res, { tipo, deleted: true });
}

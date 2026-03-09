import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import { AppError } from '@/lib/errors';
import * as firmadoService from './contrato-firmado.service';

export async function subir(req: Request, res: Response) {
  const id = req.params.id as string;

  if (!req.file) {
    throw AppError.badRequest('El archivo PDF es obligatorio', 'FILE_REQUIRED');
  }

  const result = await firmadoService.subirContratoFirmado(
    id,
    {
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      size: req.file.size,
    },
    {
      referencia_otp: req.body.referencia_otp,
      notas: req.body.notas,
    },
    req.user!.id,
    req.ip as string | undefined,
    req.headers['user-agent'] as string | undefined,
  );

  sendSuccess(res, result);
}

export async function descargar(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await firmadoService.descargarContratoFirmado(
    id,
    req.user!.id,
    req.user!.rol,
    req.ip as string | undefined,
    req.headers['user-agent'] as string | undefined,
  );
  sendSuccess(res, result);
}

export async function infoFirma(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await firmadoService.getInfoFirma(id);
  sendSuccess(res, result);
}

export async function verificarIntegridad(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await firmadoService.verificarIntegridad(
    id,
    req.user!.id,
    req.ip as string | undefined,
    req.headers['user-agent'] as string | undefined,
  );
  sendSuccess(res, result);
}

export async function logAccesos(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await firmadoService.getLogAccesos(id);
  sendSuccess(res, result);
}

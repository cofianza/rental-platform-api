import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import { AppError } from '@/lib/errors';
import * as archivosService from './contrato-archivos.service';
import type { TipoArchivoContrato } from './contrato-archivos.schema';

export async function subir(req: Request, res: Response) {
  const id = req.params.id as string;

  if (!req.file) {
    throw AppError.badRequest('El archivo es obligatorio', 'FILE_REQUIRED');
  }

  const tipoArchivo = req.body.tipo_archivo as TipoArchivoContrato;

  const result = await archivosService.subirArchivo(
    id,
    tipoArchivo,
    {
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    },
    req.user!.id,
    req.ip as string | undefined,
  );

  sendSuccess(res, result, 201);
}

export async function listar(req: Request, res: Response) {
  const id = req.params.id as string;
  const result = await archivosService.listarArchivos(id);
  sendSuccess(res, result);
}

export async function descargar(req: Request, res: Response) {
  const id = req.params.id as string;
  const archivoId = req.params.archivoId as string;
  const result = await archivosService.descargarArchivo(
    id,
    archivoId,
    req.user!.id,
    req.ip as string | undefined,
  );
  sendSuccess(res, result);
}

export async function eliminar(req: Request, res: Response) {
  const id = req.params.id as string;
  const archivoId = req.params.archivoId as string;
  await archivosService.eliminarArchivo(
    id,
    archivoId,
    req.user!.id,
    req.ip as string | undefined,
  );
  sendSuccess(res, { deleted: true });
}

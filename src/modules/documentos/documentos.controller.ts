import type { Request, Response } from 'express';
import { sendSuccess, sendCreated, sendNoContent } from '@/lib/response';
import * as documentosService from './documentos.service';
import type {
  PresignedUrlInput,
  ConfirmarSubidaInput,
  ListDocumentosQuery,
  DocumentoIdParams,
  ExpedienteIdParams,
} from './documentos.schema';

// POST /api/v1/documentos/presigned-url
export async function presignedUrl(req: Request, res: Response) {
  const input = req.body as PresignedUrlInput;
  const result = await documentosService.generatePresignedUrl(input, req.user!.id);
  sendSuccess(res, result);
}

// POST /api/v1/documentos/confirmar-subida
export async function confirmarSubida(req: Request, res: Response) {
  const input = req.body as ConfirmarSubidaInput;
  const documento = await documentosService.confirmarSubida(input, req.user!.id, req.ip);
  sendCreated(res, documento);
}

// GET /api/v1/expedientes/:expedienteId/documentos
export async function listByExpediente(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as ExpedienteIdParams;
  const query = req.query as unknown as ListDocumentosQuery;
  const result = await documentosService.listDocumentosByExpediente(expedienteId, query);
  sendSuccess(res, result.documentos, 200, result.pagination);
}

// GET /api/v1/documentos/:id
export async function getById(req: Request, res: Response) {
  const { id } = req.params as unknown as DocumentoIdParams;
  const documento = await documentosService.getDocumentoById(id);
  sendSuccess(res, documento);
}

// DELETE /api/v1/documentos/:id
export async function remove(req: Request, res: Response) {
  const { id } = req.params as unknown as DocumentoIdParams;
  await documentosService.deleteDocumento(id, req.user!.id, req.user!.rol, req.ip);
  sendNoContent(res);
}

// GET /api/v1/tipos-documento
export async function listTipos(_req: Request, res: Response) {
  const tipos = await documentosService.listTiposDocumento();
  sendSuccess(res, tipos);
}

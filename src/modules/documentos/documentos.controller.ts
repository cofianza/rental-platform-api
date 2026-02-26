import type { Request, Response } from 'express';
import { sendSuccess, sendCreated, sendNoContent } from '@/lib/response';
import * as documentosService from './documentos.service';
import type {
  PresignedUrlInput,
  ConfirmarSubidaInput,
  ListDocumentosQuery,
  DocumentoIdParams,
  ExpedienteIdParams,
  RechazarDocumentoInput,
  ReemplazarDocumentoInput,
  ConfirmarReemplazoInput,
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

// PATCH /api/v1/documentos/:id/aprobar
export async function aprobar(req: Request, res: Response) {
  const { id } = req.params as unknown as DocumentoIdParams;
  const documento = await documentosService.aprobarDocumento(id, req.user!.id, req.ip);
  sendSuccess(res, documento);
}

// PATCH /api/v1/documentos/:id/rechazar
export async function rechazar(req: Request, res: Response) {
  const { id } = req.params as unknown as DocumentoIdParams;
  const { motivo_rechazo } = req.body as RechazarDocumentoInput;
  const documento = await documentosService.rechazarDocumento(id, motivo_rechazo, req.user!.id, req.ip);
  sendSuccess(res, documento);
}

// GET /api/v1/expedientes/:expedienteId/documentos/pendientes-revision
export async function pendientesRevision(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as ExpedienteIdParams;
  const result = await documentosService.getPendientesRevision(expedienteId);
  sendSuccess(res, result);
}

// GET /api/v1/documentos/:id/historial-revision
export async function historialRevision(req: Request, res: Response) {
  const { id } = req.params as unknown as DocumentoIdParams;
  const historial = await documentosService.getHistorialRevision(id);
  sendSuccess(res, historial);
}

// GET /api/v1/documentos/:id/url-visualizacion
export async function urlVisualizacion(req: Request, res: Response) {
  const { id } = req.params as unknown as DocumentoIdParams;
  const result = await documentosService.generateViewUrlForViewer(id, req.user!.id);
  sendSuccess(res, result);
}

// GET /api/v1/documentos/:id/url-descarga
export async function urlDescarga(req: Request, res: Response) {
  const { id } = req.params as unknown as DocumentoIdParams;
  const result = await documentosService.generateDownloadUrl(id, req.user!.id, req.ip);
  sendSuccess(res, result);
}

// POST /api/v1/documentos/:id/reemplazar
export async function reemplazar(req: Request, res: Response) {
  const { id } = req.params as unknown as DocumentoIdParams;
  const input = req.body as ReemplazarDocumentoInput;
  const result = await documentosService.iniciarReemplazo(id, input, req.user!.id, req.user!.rol);
  sendSuccess(res, result);
}

// POST /api/v1/documentos/:id/confirmar-reemplazo
export async function confirmarReemplazo(req: Request, res: Response) {
  const { id } = req.params as unknown as DocumentoIdParams;
  const input = req.body as ConfirmarReemplazoInput;
  const doc = await documentosService.confirmarReemplazo(id, input, req.user!.id, req.ip);
  sendCreated(res, doc);
}

// GET /api/v1/documentos/:id/versiones
export async function versiones(req: Request, res: Response) {
  const { id } = req.params as unknown as DocumentoIdParams;
  const result = await documentosService.getVersiones(id);
  sendSuccess(res, result);
}

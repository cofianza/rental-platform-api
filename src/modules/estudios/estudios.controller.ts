import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as estudiosService from './estudios.service';
import type {
  CreateEstudioInput,
  ListEstudiosQuery,
  SubmitFormularioInput,
  RegistrarResultadoInput,
  CertificadoPresignedUrlInput,
} from './estudios.schema';

// ============================================================
// Authenticated endpoints
// ============================================================

export async function listByExpediente(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const query = req.query as unknown as ListEstudiosQuery;
  const result = await estudiosService.listEstudios(expedienteId, query);
  sendSuccess(res, result.estudios, 200, result.pagination);
}

export async function getById(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const estudio = await estudiosService.getEstudioById(estudioId);
  sendSuccess(res, estudio);
}

export async function create(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const input = req.body as CreateEstudioInput;
  const estudio = await estudiosService.createEstudio(expedienteId, input, req.user!.id, req.ip);
  sendCreated(res, estudio);
}

export async function cancel(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const estudio = await estudiosService.cancelEstudio(estudioId, req.user!.id, req.ip);
  sendSuccess(res, estudio);
}

export async function sendLink(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const result = await estudiosService.sendSelfServiceLink(estudioId, req.user!.id, req.ip);
  sendSuccess(res, result);
}

export async function registrarResultado(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const input = req.body as RegistrarResultadoInput;
  const estudio = await estudiosService.registrarResultado(estudioId, input, req.user!.id, req.ip);
  sendSuccess(res, estudio);
}

export async function getCertificadoPresignedUrl(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const input = req.body as CertificadoPresignedUrlInput;
  const result = await estudiosService.getCertificadoPresignedUrl(estudioId, input);
  sendSuccess(res, result);
}

export async function getCertificadoUrl(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const result = await estudiosService.getCertificadoViewUrl(estudioId);
  sendSuccess(res, result);
}

// ============================================================
// Public endpoints (no auth)
// ============================================================

export async function getFormulario(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const data = await estudiosService.getFormularioByToken(token);
  sendSuccess(res, data);
}

export async function submitFormulario(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const input = req.body as SubmitFormularioInput;
  const result = await estudiosService.submitFormulario(token, input);
  sendSuccess(res, result);
}

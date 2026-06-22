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

// ── Enlace público de carga (autenticado: la inmobiliaria lo envía) ──────────
export async function enviarEnlaceDocumentos(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await service.enviarEnlaceDocumentos(id, req.user!.id, req.user!.rol);
  sendSuccess(res, result);
}

// ── Endpoints PÚBLICOS por token (sin auth) ──────────────────────────────────
export async function getContextoPublico(req: Request, res: Response) {
  const { token } = req.params as { token: string };
  const result = await service.getContextoDocumentosPublico(token);
  sendSuccess(res, result);
}

export async function presignedUrlPublico(req: Request, res: Response) {
  const { token } = req.params as { token: string };
  const result = await service.presignedUrlSoportePublico(token, req.body);
  sendSuccess(res, result);
}

export async function confirmarPublico(req: Request, res: Response) {
  const { token } = req.params as { token: string };
  const result = await service.confirmarSoportePublico(token, req.body);
  sendSuccess(res, result);
}

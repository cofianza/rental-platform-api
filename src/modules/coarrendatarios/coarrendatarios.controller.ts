import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as service from './coarrendatarios.service';
import type { ExpedienteIdParams } from '../expedientes/expedientes.schema';
import type { TokenParam } from './coarrendatarios.schema';

// ── Privado: solicitante / propietario invita ──────────────────────

export async function invitar(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await service.invitarCoarrendatario(id, req.user!.id, req.user!.rol, req.body);
  sendSuccess(res, result);
}

export async function getDelExpediente(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await service.getCoarrendatarioPorExpediente(id, req.user!.id, req.user!.rol);
  sendSuccess(res, result);
}

// ── Público: el invitado abre el link y decide ─────────────────────

export async function getPublic(req: Request, res: Response) {
  const { token } = req.params as unknown as TokenParam;
  const result = await service.getPublicByToken(token);
  sendSuccess(res, result);
}

export async function aceptar(req: Request, res: Response) {
  const { token } = req.params as unknown as TokenParam;
  const ip = (req.ip ?? '').toString();
  const userAgent = (req.headers['user-agent'] ?? '').toString();
  const result = await service.aceptarInvitacion(token, ip, userAgent, req.body);
  sendSuccess(res, result);
}

export async function rechazar(req: Request, res: Response) {
  const { token } = req.params as unknown as TokenParam;
  const result = await service.rechazarInvitacion(token);
  sendSuccess(res, result);
}

import type { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import { AppError } from '@/lib/errors';
import * as service from './inmobiliaria-miembros.service';
import type {
  InvitarMiembroInput,
  RegistrarMiembroInput,
  TokenParam,
  MiembroIdParam,
} from './inmobiliaria-miembros.schema';

// ── Autenticado (owner / miembro de la inmobiliaria) ──────────

export async function list(req: Request, res: Response) {
  const data = await service.listMiembros(req.user!.id);
  sendSuccess(res, data);
}

export async function invitar(req: Request, res: Response) {
  const data = await service.invitarMiembro(req.user!.id, req.body as InvitarMiembroInput);
  sendSuccess(res, data, undefined, 201);
}

export async function reenviar(req: Request, res: Response) {
  const { id } = req.params as unknown as MiembroIdParam;
  const data = await service.reenviarInvitacion(req.user!.id, id);
  sendSuccess(res, data);
}

export async function revocar(req: Request, res: Response) {
  const { id } = req.params as unknown as MiembroIdParam;
  const data = await service.revocarMiembro(req.user!.id, id);
  sendSuccess(res, data);
}

// ── Público (por token) ───────────────────────────────────────

export async function getPublic(req: Request, res: Response) {
  const { token } = req.params as unknown as TokenParam;
  const data = await service.getInvitacionMiembroPublic(token);
  sendSuccess(res, data);
}

export async function aceptar(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthorized('Autenticación requerida');
  const { token } = req.params as unknown as TokenParam;
  const data = await service.aceptarInvitacionMiembro(token, req.user);
  sendSuccess(res, data);
}

export async function registrar(req: Request, res: Response) {
  const { token } = req.params as unknown as TokenParam;
  const data = await service.registrarMiembro(token, req.body as RegistrarMiembroInput);
  sendSuccess(res, data, undefined, 201);
}

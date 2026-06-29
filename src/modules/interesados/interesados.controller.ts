// ============================================================
// Interesados de la vitrina — Controller
// ============================================================

import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import * as service from './interesados.service';
import type { ListInteresadosQuery } from './interesados.schema';

/** Público (sin auth): registrar interés desde la vitrina. */
export async function registrarInteres(req: Request, res: Response) {
  const id = req.params.id as string;
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || null;
  const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;

  await service.registrarInteresPublico(id, req.body, { ip, userAgent });
  sendSuccess(res, { ok: true }, undefined, 201);
}

/** Autenticado: listar interesados de los inmuebles del usuario. */
export async function list(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery?: ListInteresadosQuery }).validatedQuery
    || (req.query as unknown as ListInteresadosQuery);
  const { data, pagination } = await service.listInteresados(req.user!.id, req.user!.rol, query);
  sendSuccess(res, data, pagination);
}

/** Autenticado: conteo de interesados 'nuevo' (para el badge de la pestaña). */
export async function countNuevos(req: Request, res: Response) {
  const nuevos = await service.contarInteresadosNuevos(req.user!.id, req.user!.rol);
  sendSuccess(res, { nuevos });
}

/** Autenticado: cambiar el estado de un interesado (nuevo/contactado/descartado). */
export async function updateEstado(req: Request, res: Response) {
  const id = req.params.id as string;
  await service.updateEstadoInteresado(id, req.user!.id, req.user!.rol, req.body.estado);
  sendSuccess(res, { ok: true });
}

import { Request, Response } from 'express';
import { AppError } from '@/lib/errors';
import { sendSuccess } from '@/utils/response';
import * as morasService from './moras.service';
import type {
  ReportarMoraInput,
  ListMorasQuery,
  EscalarMoraInput,
  MarcarPagadaInput,
  CancelarMoraInput,
  AgregarMensajeInput,
} from './moras.schema';

function userOr401(req: Request) {
  if (!req.user) throw AppError.unauthorized('Autenticación requerida');
  return req.user;
}

export async function reportar(req: Request, res: Response) {
  const user = userOr401(req);
  const mora = await morasService.reportarMora(req.body as ReportarMoraInput, user.id);
  sendSuccess(res, mora, undefined, 201);
}

export async function list(req: Request, res: Response) {
  const user = userOr401(req);
  const query = (req as Request & { validatedQuery: ListMorasQuery }).validatedQuery
    ?? (req.query as unknown as ListMorasQuery);
  const result = await morasService.listMoras(query, user.id, user.rol);
  sendSuccess(res, result.data, result.pagination);
}

export async function detail(req: Request, res: Response) {
  userOr401(req);
  const mora = await morasService.getMoraById(String(req.params.id));
  sendSuccess(res, mora);
}

export async function escalar(req: Request, res: Response) {
  const user = userOr401(req);
  const mora = await morasService.escalarMora(
    String(req.params.id),
    req.body as EscalarMoraInput,
    user.id,
    user.rol,
  );
  sendSuccess(res, mora);
}

export async function pagar(req: Request, res: Response) {
  const user = userOr401(req);
  const mora = await morasService.marcarPagada(
    String(req.params.id),
    req.body as MarcarPagadaInput,
    user.id,
    user.rol,
  );
  sendSuccess(res, mora);
}

export async function cancelar(req: Request, res: Response) {
  const user = userOr401(req);
  const mora = await morasService.cancelarMora(
    String(req.params.id),
    req.body as CancelarMoraInput,
    user.id,
    user.rol,
  );
  sendSuccess(res, mora);
}

export async function postMensaje(req: Request, res: Response) {
  const user = userOr401(req);
  const mensaje = await morasService.agregarMensaje(
    String(req.params.id),
    req.body as AgregarMensajeInput,
    user.id,
    user.rol,
  );
  sendSuccess(res, mensaje, undefined, 201);
}

export async function stats(req: Request, res: Response) {
  const user = userOr401(req);
  const data = await morasService.getStats(user.id, user.rol);
  sendSuccess(res, data);
}

export async function cronAutoEscalar(_req: Request, res: Response) {
  const result = await morasService.autoEscalar();
  sendSuccess(res, result);
}

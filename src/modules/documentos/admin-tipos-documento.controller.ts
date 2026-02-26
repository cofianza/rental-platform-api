import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as adminTiposService from './admin-tipos-documento.service';
import type {
  ListAdminTiposQuery,
  TipoDocumentoIdParams,
  CreateTipoDocumentoInput,
  UpdateTipoDocumentoInput,
  ReordenarTiposInput,
} from './admin-tipos-documento.schema';

export async function list(req: Request, res: Response) {
  const query = req.query as unknown as ListAdminTiposQuery;
  const result = await adminTiposService.listAllTiposDocumento(query);
  sendSuccess(res, result.tipos, 200, result.pagination);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as unknown as TipoDocumentoIdParams;
  const tipo = await adminTiposService.getTipoDocumentoById(id);
  sendSuccess(res, tipo);
}

export async function create(req: Request, res: Response) {
  const input = req.body as CreateTipoDocumentoInput;
  const tipo = await adminTiposService.createTipoDocumento(input, req.user!.id, req.ip);
  sendCreated(res, tipo);
}

export async function update(req: Request, res: Response) {
  const { id } = req.params as unknown as TipoDocumentoIdParams;
  const input = req.body as UpdateTipoDocumentoInput;
  const tipo = await adminTiposService.updateTipoDocumento(id, input, req.user!.id, req.ip);
  sendSuccess(res, tipo);
}

export async function toggleActivo(req: Request, res: Response) {
  const { id } = req.params as unknown as TipoDocumentoIdParams;
  const tipo = await adminTiposService.toggleActivo(id, req.user!.id, req.ip);
  sendSuccess(res, tipo);
}

export async function reordenar(req: Request, res: Response) {
  const input = req.body as ReordenarTiposInput;
  const tipos = await adminTiposService.reordenarTipos(input, req.user!.id, req.ip);
  sendSuccess(res, tipos);
}

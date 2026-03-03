import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as inmueblesService from './inmuebles.service';
import * as cambiosService from './inmuebles-cambios.service';
import type {
  ListInmueblesQuery,
  InmuebleIdParams,
  CreateInmuebleInput,
  UpdateInmuebleInput,
  SearchInmueblesQuery,
  ListCambiosQuery,
} from './inmuebles.schema';

export async function list(req: Request, res: Response) {
  const query = req.query as unknown as ListInmueblesQuery;
  const result = await inmueblesService.listInmuebles(query);
  sendSuccess(res, result.inmuebles, 200, result.pagination);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as unknown as InmuebleIdParams;
  const inmueble = await inmueblesService.getInmuebleById(id);
  sendSuccess(res, inmueble);
}

export async function create(req: Request, res: Response) {
  const input = req.body as CreateInmuebleInput;
  const inmueble = await inmueblesService.createInmueble(input, req.user!.id, req.ip);
  sendCreated(res, inmueble);
}

export async function update(req: Request, res: Response) {
  const { id } = req.params as unknown as InmuebleIdParams;
  const input = req.body as UpdateInmuebleInput;
  const inmueble = await inmueblesService.updateInmueble(id, input, req.user!.id, req.ip);
  sendSuccess(res, inmueble);
}

export async function remove(req: Request, res: Response) {
  const { id } = req.params as unknown as InmuebleIdParams;
  const inmueble = await inmueblesService.deleteInmueble(id, req.user!.id, req.ip);
  sendSuccess(res, inmueble);
}

export async function search(req: Request, res: Response) {
  const query = req.query as unknown as SearchInmueblesQuery;
  const result = await inmueblesService.searchInmuebles(query);
  sendSuccess(res, result.inmuebles, 200, result.pagination);
}

export async function filterOptions(_req: Request, res: Response) {
  const options = await inmueblesService.getFilterOptions();
  sendSuccess(res, options);
}

export async function listCambios(req: Request, res: Response) {
  const { id } = req.params as unknown as InmuebleIdParams;
  const query = req.query as unknown as ListCambiosQuery;
  const result = await cambiosService.listCambios(id, query);
  sendSuccess(res, result.cambios, 200, result.pagination);
}

export async function getCambiosResumen(req: Request, res: Response) {
  const { id } = req.params as unknown as InmuebleIdParams;
  const result = await cambiosService.getCambiosResumen(id);
  sendSuccess(res, result);
}

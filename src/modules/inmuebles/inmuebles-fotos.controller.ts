/**
 * Controladores de fotos de inmuebles - HP-203
 */
import { Request, Response } from 'express';
import { sendSuccess, sendCreated, sendNoContent } from '@/lib/response';
import * as fotosService from './inmuebles-fotos.service';
import type {
  FotoIdParams,
  InmuebleIdOnlyParams,
  CreateFotoInput,
  UpdateFotoInput,
  ReordenarFotosInput,
  SetFachadaInput,
} from './inmuebles-fotos.schema';

/**
 * GET /api/v1/inmuebles/:id/fotos
 * Obtener todas las fotos de un inmueble
 */
export async function list(req: Request, res: Response) {
  const { id } = req.params as unknown as InmuebleIdOnlyParams;
  const fotos = await fotosService.getFotosByInmuebleId(id);
  sendSuccess(res, fotos);
}

/**
 * POST /api/v1/inmuebles/:id/fotos
 * Crear una nueva foto
 */
export async function create(req: Request, res: Response) {
  const { id } = req.params as unknown as InmuebleIdOnlyParams;
  const input = req.body as CreateFotoInput;
  const foto = await fotosService.createFoto(id, input, req.user!.id, req.ip);
  sendCreated(res, foto);
}

/**
 * PATCH /api/v1/inmuebles/:id/fotos/:fotoId
 * Actualizar una foto
 */
export async function update(req: Request, res: Response) {
  const { id, fotoId } = req.params as unknown as FotoIdParams;
  const input = req.body as UpdateFotoInput;
  const foto = await fotosService.updateFoto(id, fotoId, input, req.user!.id, req.ip);
  sendSuccess(res, foto);
}

/**
 * DELETE /api/v1/inmuebles/:id/fotos/:fotoId
 * Eliminar una foto
 */
export async function remove(req: Request, res: Response) {
  const { id, fotoId } = req.params as unknown as FotoIdParams;
  await fotosService.deleteFoto(id, fotoId, req.user!.id, req.ip);
  sendNoContent(res);
}

/**
 * PATCH /api/v1/inmuebles/:id/fotos/reordenar
 * Reordenar fotos
 */
export async function reordenar(req: Request, res: Response) {
  const { id } = req.params as unknown as InmuebleIdOnlyParams;
  const { foto_ids } = req.body as ReordenarFotosInput;
  const fotos = await fotosService.reordenarFotos(id, foto_ids, req.user!.id, req.ip);
  sendSuccess(res, fotos);
}

/**
 * PATCH /api/v1/inmuebles/:id/fotos/:fotoId/fachada
 * Establecer foto como fachada
 */
export async function setFachada(req: Request, res: Response) {
  const { id, fotoId } = req.params as unknown as FotoIdParams;
  const foto = await fotosService.setFotoFachada(id, fotoId, req.user!.id, req.ip);
  sendSuccess(res, foto);
}

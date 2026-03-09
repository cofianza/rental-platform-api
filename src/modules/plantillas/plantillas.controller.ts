import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as plantillasService from './plantillas.service';
import type {
  CreatePlantillaInput,
  UpdatePlantillaInput,
  ListPlantillasQuery,
  PreviewPlantillaInput,
} from './plantillas.schema';

export async function list(req: Request, res: Response) {
  const query = req.query as unknown as ListPlantillasQuery;
  const result = await plantillasService.listPlantillas(query);
  sendSuccess(res, result.plantillas, 200, result.pagination);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: string };
  const plantilla = await plantillasService.getPlantillaById(id);
  sendSuccess(res, plantilla);
}

export async function create(req: Request, res: Response) {
  const input = req.body as CreatePlantillaInput;
  const plantilla = await plantillasService.createPlantilla(input, req.user!.id, req.ip);
  sendCreated(res, plantilla);
}

export async function update(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: string };
  const input = req.body as UpdatePlantillaInput;
  const plantilla = await plantillasService.updatePlantilla(id, input, req.user!.id, req.ip);
  sendSuccess(res, plantilla);
}

export async function remove(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: string };
  const result = await plantillasService.deletePlantilla(id, req.user!.id, req.ip);
  sendSuccess(res, result);
}

export async function preview(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: string };
  const input = req.body as PreviewPlantillaInput;
  const result = await plantillasService.previewPlantilla(id, input);
  sendSuccess(res, result);
}

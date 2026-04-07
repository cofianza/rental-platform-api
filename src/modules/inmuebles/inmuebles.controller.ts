import { Request, Response } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { sendSuccess, sendCreated } from '@/lib/response';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import * as inmueblesService from './inmuebles.service';
import * as cambiosService from './inmuebles-cambios.service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
import type {
  ListInmueblesQuery,
  InmuebleIdParams,
  CreateInmuebleInput,
  UpdateInmuebleInput,
  SearchInmueblesQuery,
  ListCambiosQuery,
  VisibilityInput,
} from './inmuebles.schema';

export async function list(req: Request, res: Response) {
  const query = req.query as unknown as ListInmueblesQuery;
  // Propietario only sees their own inmuebles
  if (req.user?.rol === 'propietario') {
    (query as Record<string, unknown>).propietario_id = req.user.id;
  }
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
  // Propietario: force propietario_id to their own user ID
  if (req.user?.rol === 'propietario') {
    (input as Record<string, unknown>).propietario_id = req.user.id;
  }
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

// Toggle vitrina visibility — HP-369
export async function toggleVisibility(req: Request, res: Response) {
  const { id } = req.params as unknown as InmuebleIdParams;
  const { visible_vitrina } = req.body as VisibilityInput;
  const inmueble = await inmueblesService.toggleVisibility(id, visible_vitrina, req.user!.id);
  sendSuccess(res, inmueble);
}

// Upload fachada image via backend Storage
export const uploadFachadaMiddleware = upload.single('file');

export async function uploadFachada(req: Request, res: Response) {
  // Apply multer middleware manually
  await new Promise<void>((resolve, reject) => {
    uploadFachadaMiddleware(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    throw AppError.badRequest('No se envio archivo', 'FILE_REQUIRED');
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.mimetype)) {
    throw AppError.badRequest('Tipo de archivo no permitido. Solo JPEG, PNG y WebP.', 'INVALID_FILE_TYPE');
  }

  const inmuebleId = req.body?.inmueble_id || 'temp';
  const ext = file.originalname.split('.').pop() || 'jpg';
  const fileName = `${inmuebleId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

  const { data, error } = await supabase.storage
    .from('inmuebles')
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
      cacheControl: '3600',
      upsert: false,
    });

  if (error) {
    throw AppError.badRequest(`Error al subir imagen: ${error.message}`, 'UPLOAD_ERROR');
  }

  const { data: urlData } = supabase.storage
    .from('inmuebles')
    .getPublicUrl(data.path);

  sendSuccess(res, { url: urlData.publicUrl, path: data.path });
}

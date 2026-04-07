import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import { supabase } from '@/lib/supabase';
import * as expedientesService from './expedientes.service';
import type {
  ListExpedientesQuery,
  CreateExpedienteInput,
  UpdateExpedienteInput,
} from './expedientes.schema';
import type { ExpedienteIdParams } from './expediente-workflow.schema';

export async function list(req: Request, res: Response) {
  const query = req.query as unknown as ListExpedientesQuery;

  // Propietario: only show expedientes for their inmuebles
  if (req.user?.rol === 'propietario') {
    const { data: myInmuebles } = await supabase
      .from('inmuebles')
      .select('id')
      .eq('propietario_id', req.user.id);
    const myIds = new Set((myInmuebles || []).map((i: { id: string }) => i.id));
    if (myIds.size === 0) {
      sendSuccess(res, [], 200, { total: 0, page: 1, limit: 10, totalPages: 0 });
      return;
    }
    const result = await expedientesService.listExpedientes(query);
    // Post-filter: only expedientes whose inmueble belongs to propietario
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filtered = result.expedientes.filter((exp: any) => {
      const inmId = exp.inmueble_id || exp.inmueble?.id;
      return inmId && myIds.has(inmId);
    });
    sendSuccess(res, filtered, 200, { ...result.pagination, total: filtered.length, totalPages: Math.ceil(filtered.length / (Number(query.limit) || 20)) });
    return;
  }

  const result = await expedientesService.listExpedientes(query);
  sendSuccess(res, result.expedientes, 200, result.pagination);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const expediente = await expedientesService.getExpedienteById(id);
  sendSuccess(res, expediente);
}

export async function create(req: Request, res: Response) {
  const input = req.body as CreateExpedienteInput;
  const expediente = await expedientesService.createExpediente(input, req.user!.id, req.ip);
  sendCreated(res, expediente);
}

export async function update(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const input = req.body as UpdateExpedienteInput;
  const expediente = await expedientesService.updateExpediente(id, input, req.user!.id, req.ip);
  sendSuccess(res, expediente);
}

export async function stats(_req: Request, res: Response) {
  const result = await expedientesService.getExpedienteStats();
  sendSuccess(res, result);
}

// HP-247: Verificar si un inmueble tiene expediente activo
export async function checkByInmueble(req: Request, res: Response) {
  const { inmuebleId } = req.params as { inmuebleId: string };
  const result = await expedientesService.checkActiveExpedienteByInmueble(inmuebleId);
  sendSuccess(res, result);
}

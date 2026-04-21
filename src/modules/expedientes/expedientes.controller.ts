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

  // Solicitante: only show expedientes where they are the solicitante
  if (req.user?.rol === 'solicitante') {
    // Find solicitante records linked to this user (by email or creado_por)
    const { data: mySolicitantes } = await supabase
      .from('solicitantes')
      .select('id')
      .eq('creado_por', req.user.id);
    const solIds = new Set((mySolicitantes || []).map((s: { id: string }) => s.id));
    if (solIds.size === 0) {
      sendSuccess(res, [], 200, { total: 0, page: 1, limit: 10, totalPages: 0 });
      return;
    }
    const result = await expedientesService.listExpedientes(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filtered = result.expedientes.filter((exp: any) => {
      const solId = exp.solicitante_id || exp.solicitante?.id;
      return solId && solIds.has(solId);
    });
    sendSuccess(res, filtered, 200, { ...result.pagination, total: filtered.length, totalPages: Math.ceil(filtered.length / (Number(query.limit) || 20)) });
    return;
  }

  // Propietario: only show expedientes for their inmuebles
  if (req.user?.rol === 'propietario' || req.user?.rol === 'inmobiliaria') {
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

export async function stats(req: Request, res: Response) {
  // Solicitante: stats for their expedientes only
  if (req.user?.rol === 'solicitante') {
    const { data: mySol } = await supabase.from('solicitantes').select('id').eq('creado_por', req.user.id);
    const solIds = (mySol || []).map((s: { id: string }) => s.id);
    if (solIds.length === 0) {
      sendSuccess(res, { total: 0, stats: [] });
      return;
    }
    const { data: myExps } = await supabase.from('expedientes').select('estado').in('solicitante_id', solIds);
    const rows = myExps || [];
    const counts: Record<string, number> = {};
    for (const r of rows) { const e = (r as { estado: string }).estado; counts[e] = (counts[e] || 0) + 1; }
    sendSuccess(res, { total: rows.length, stats: Object.entries(counts).map(([estado, count]) => ({ estado, count })) });
    return;
  }

  // Propietario/Inmobiliaria: only stats for their inmuebles
  if (req.user?.rol === 'propietario' || req.user?.rol === 'inmobiliaria') {
    const { data: myInmuebles } = await supabase
      .from('inmuebles')
      .select('id')
      .eq('propietario_id', req.user.id);
    const myIds = (myInmuebles || []).map((i: { id: string }) => i.id);
    if (myIds.length === 0) {
      sendSuccess(res, { total: 0, stats: [] });
      return;
    }
    const result = await expedientesService.getExpedienteStats();
    // Filter stats — recalculate from filtered expedientes
    const { data: myExps } = await supabase
      .from('expedientes')
      .select('estado')
      .in('inmueble_id', myIds);
    const rows = myExps || [];
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const estado = (r as { estado: string }).estado;
      counts[estado] = (counts[estado] || 0) + 1;
    }
    const filteredStats = Object.entries(counts).map(([estado, count]) => ({ estado, count }));
    sendSuccess(res, { total: rows.length, stats: filteredStats });
    return;
  }
  const result = await expedientesService.getExpedienteStats();
  sendSuccess(res, result);
}

// HP-247: Verificar si un inmueble tiene expediente activo
export async function checkByInmueble(req: Request, res: Response) {
  const { inmuebleId } = req.params as { inmuebleId: string };
  const result = await expedientesService.checkActiveExpedienteByInmueble(inmuebleId);
  sendSuccess(res, result);
}

// MeInteresa flow: ¿el solicitante autenticado tiene expediente activo
// sobre este inmueble? Filtra por solicitantes.creado_por = req.user.id.
// Devuelve siempre 200 con { expediente: null | {id,numero,estado} }.
export async function miExpedientePorInmueble(req: Request, res: Response) {
  const { inmuebleId } = req.params as { inmuebleId: string };
  const result = await expedientesService.getMiExpedientePorInmueble(inmuebleId, req.user!.id);
  sendSuccess(res, result);
}

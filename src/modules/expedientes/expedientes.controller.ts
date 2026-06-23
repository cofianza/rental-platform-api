import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import { supabase } from '@/lib/supabase';
import { resolveAllowedExpedienteIds } from '@/lib/tenantScope';
import * as expedientesService from './expedientes.service';
import type {
  ListExpedientesQuery,
  CreateExpedienteInput,
  UpdateExpedienteInput,
  AsignarResponsableExpedienteInput,
} from './expedientes.schema';
import type { ExpedienteIdParams } from './expediente-workflow.schema';

export async function list(req: Request, res: Response) {
  const query = req.query as unknown as ListExpedientesQuery;
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 20;
  const rol = req.user?.rol;

  // Scoping multi-tenant: resolvemos los expediente IDs accesibles y se los
  // pasamos al RPC, que filtra + cuenta + pagina en SQL. Antes esto se hacía
  // post-filtrando en JS sobre una página GLOBAL y recalculando el total sobre
  // el slice → paginación rota (pedías 20 y veías 0-3, total incorrecto) +
  // RPC caro desperdiciado. null = sin filtro (roles internos ven todo).
  let allowedExpedienteIds: string[] | null = null;

  if (rol === 'solicitante') {
    // El solicitante ve solo SUS expedientes (vía sus filas de solicitante).
    const { data: mySolicitantes } = await supabase
      .from('solicitantes')
      .select('id')
      .eq('creado_por', req.user!.id);
    const solIds = (mySolicitantes || []).map((s: { id: string }) => s.id);
    if (solIds.length === 0) {
      sendSuccess(res, [], 200, { total: 0, page, limit, totalPages: 0 });
      return;
    }
    const { data: exps } = await supabase
      .from('expedientes')
      .select('id')
      .in('solicitante_id', solIds);
    allowedExpedienteIds = (exps || []).map((e: { id: string }) => e.id);
  } else if (rol === 'propietario' || rol === 'inmobiliaria') {
    // Org-aware: cartera de la organización (no solo propietario_id) + los
    // expedientes asignados al miembro como responsable (modo restringido).
    allowedExpedienteIds = await resolveAllowedExpedienteIds(req.user!.id, rol);
  }

  // Roles scopeados sin expedientes accesibles → respuesta vacía SIN llamar al
  // RPC. Además, así nunca pasamos [] al RPC (evita cualquier ambigüedad de
  // serialización array-vacío→NULL que pudiera saltarse el filtro).
  if (Array.isArray(allowedExpedienteIds) && allowedExpedienteIds.length === 0) {
    sendSuccess(res, [], 200, { total: 0, page, limit, totalPages: 0 });
    return;
  }

  const result = await expedientesService.listExpedientes(query, allowedExpedienteIds);
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

export async function asignarResponsable(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const { miembro_id } = req.body as AsignarResponsableExpedienteInput;
  const result = await expedientesService.asignarMiembroResponsableExpediente(id, miembro_id, req.user!.id);
  sendSuccess(res, result);
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
    await expedientesService.getExpedienteStats();
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

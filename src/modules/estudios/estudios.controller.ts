import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import { supabase } from '@/lib/supabase';
import * as estudiosService from './estudios.service';
import * as certificadoService from './certificado.service';
import type {
  CreateEstudioInput,
  CreateEstudioFromInmuebleInput,
  ListEstudiosQuery,
  ListAllEstudiosQuery,
  SubmitFormularioInput,
  RegistrarResultadoInput,
  CertificadoPresignedUrlInput,
  SoportePresignedUrlInput,
  ConfirmarSoporteInput,
  ReEvaluarInput,
} from './estudios.schema';

// ============================================================
// Authenticated endpoints
// ============================================================

export async function listAll(req: Request, res: Response) {
  const query = req.query as unknown as ListAllEstudiosQuery;
  const result = await estudiosService.listAllEstudios(query);

  // Propietario: only their inmuebles' estudios
  if (req.user?.rol === 'propietario' || req.user?.rol === 'inmobiliaria') {
    const { data: myInm } = await supabase.from('inmuebles').select('id').eq('propietario_id', req.user.id);
    const myIds = new Set((myInm || []).map((i: { id: string }) => i.id));
    const filtered = result.estudios.filter((e: Record<string, unknown>) => {
      const expInm = ((e as { expedientes?: { inmueble_id?: string } }).expedientes as Record<string, unknown>);
      return expInm && myIds.has(expInm.inmueble_id as string);
    });
    sendSuccess(res, filtered, 200, { ...result.pagination, total: filtered.length });
    return;
  }

  sendSuccess(res, result.estudios, 200, result.pagination);
}

export async function listByExpediente(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const query = req.query as unknown as ListEstudiosQuery;
  const result = await estudiosService.listEstudios(expedienteId, query);
  sendSuccess(res, result.estudios, 200, result.pagination);
}

export async function getById(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const estudio = await estudiosService.getEstudioById(estudioId);
  sendSuccess(res, estudio);
}

export async function create(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const input = req.body as CreateEstudioInput;
  const estudio = await estudiosService.createEstudio(expedienteId, input, req.user!.id, req.ip);
  sendCreated(res, estudio);
}

export async function createFromInmueble(req: Request, res: Response) {
  const { inmuebleId } = req.params as unknown as { inmuebleId: string };
  const input = req.body as CreateEstudioFromInmuebleInput;
  const estudio = await estudiosService.createEstudioFromInmueble(inmuebleId, input, req.user!.id, req.ip);
  sendCreated(res, estudio);
}

export async function cancel(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const estudio = await estudiosService.cancelEstudio(estudioId, req.user!.id, req.ip);
  sendSuccess(res, estudio);
}

export async function sendLink(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const result = await estudiosService.sendSelfServiceLink(estudioId, req.user!.id, req.ip);
  sendSuccess(res, result);
}

export async function registrarResultado(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const input = req.body as RegistrarResultadoInput;
  const estudio = await estudiosService.registrarResultado(estudioId, input, req.user!.id, req.ip);
  sendSuccess(res, estudio);
}

export async function getCertificadoPresignedUrl(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const input = req.body as CertificadoPresignedUrlInput;
  const result = await estudiosService.getCertificadoPresignedUrl(estudioId, input);
  sendSuccess(res, result);
}

export async function getCertificadoUrl(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const result = await estudiosService.getCertificadoViewUrl(estudioId);
  sendSuccess(res, result);
}

// ============================================================
// Re-evaluacion endpoints
// ============================================================

export async function getSoportePresignedUrl(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const input = req.body as SoportePresignedUrlInput;
  const result = await estudiosService.getSoportePresignedUrl(estudioId, input);
  sendSuccess(res, result);
}

export async function confirmarSoporte(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const input = req.body as ConfirmarSoporteInput;
  const result = await estudiosService.confirmarSoporteUpload(estudioId, input, req.user!.id, req.ip);
  sendCreated(res, result);
}

export async function reEvaluar(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const input = req.body as ReEvaluarInput;
  const result = await estudiosService.solicitarReEvaluacion(estudioId, input, req.user!.id, req.ip);
  sendCreated(res, result);
}

export async function getHistorial(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const result = await estudiosService.getHistorialReEvaluacion(estudioId);
  sendSuccess(res, result);
}

// ============================================================
// Certificado PDF endpoints
// ============================================================

export async function generarCertificado(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const result = await certificadoService.generarCertificado(estudioId, req.user!.id, req.ip);
  sendCreated(res, result);
}

export async function descargarCertificado(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const result = await certificadoService.descargarCertificado(estudioId);
  sendSuccess(res, result);
}

export async function verificarCertificadoPublic(req: Request, res: Response) {
  const { codigo } = req.params as unknown as { codigo: string };
  const result = await certificadoService.verificarCertificado(codigo);
  sendSuccess(res, result);
}

// ============================================================
// Provider endpoints
// ============================================================

export async function ejecutarEstudio(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const result = await estudiosService.ejecutarEstudio(estudioId, req.user!.id, req.ip);
  sendSuccess(res, result);
}

export async function getEstadoProveedor(req: Request, res: Response) {
  const { estudioId } = req.params as unknown as { estudioId: string };
  const result = await estudiosService.consultarEstadoProveedor(estudioId);
  sendSuccess(res, result);
}

export async function getProviderHealth(_req: Request, res: Response) {
  const result = await estudiosService.getProviderHealth();
  sendSuccess(res, result);
}

// ============================================================
// Public endpoints (no auth)
// ============================================================

export async function getFormulario(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const data = await estudiosService.getFormularioByToken(token);
  sendSuccess(res, data);
}

export async function submitFormulario(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const input = req.body as SubmitFormularioInput;
  const result = await estudiosService.submitFormulario(token, input);
  sendSuccess(res, result);
}

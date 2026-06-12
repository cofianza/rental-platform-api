import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as contratosService from './contratos.service';
import type {
  GenerarContratoInput,
  RenovarContratoInput,
  ReGenerarContratoInput,
  ListContratosQuery,
  ListAllContratosQuery,
  VersionDescargarParams,
  CompararVersionesQuery,
} from './contratos.schema';

/**
 * Devuelve el HTML de la plantilla activa renderizado con datos del
 * inmueble + propietario, y placeholders para arrendatario/coarrendatario.
 * Sirve para el preview en el detalle del inmueble — no genera PDF.
 */
export async function previewByInmueble(req: Request, res: Response) {
  const { inmuebleId } = req.params as { inmuebleId: string };
  const html = await contratosService.previewPlantillaParaInmueble(inmuebleId);
  // Devolvemos texto/html directo para que el frontend lo embeba en un
  // iframe via srcdoc o data URL.
  res.type('html').send(html);
}

export async function listAll(req: Request, res: Response) {
  const query = req.query as unknown as ListAllContratosQuery;
  // El service filtra en SQL segun rol: propietario/inmobiliaria solo
  // ven contratos de sus inmuebles, admin/operador/gerencia ven todos.
  const result = await contratosService.listAllContratos(
    query,
    req.user?.id,
    req.user?.rol,
  );
  sendSuccess(res, result.contratos, 200, result.pagination);
}

export async function listByExpediente(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const query = req.query as unknown as ListContratosQuery;
  const result = await contratosService.listContratosByExpediente(expedienteId, query);
  sendSuccess(res, result.contratos, 200, result.pagination);
}

export async function stats(req: Request, res: Response) {
  // Scopea por rol: propietario/inmobiliaria solo ven SUS contadores.
  const data = await contratosService.getContratosStats(req.user?.id, req.user?.rol);
  sendSuccess(res, data);
}

export async function getDetalle(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: string };
  // Pasa identidad para el ownership check (propietario/inmobiliaria).
  const contrato = await contratosService.getContratoById(id, req.user?.id, req.user?.rol);
  sendSuccess(res, contrato);
}

export async function generar(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const input = req.body as GenerarContratoInput;
  const contrato = await contratosService.generarContrato(
    expedienteId,
    input,
    req.user!.id,
    req.ip,
  );
  sendCreated(res, contrato);
}

export async function regenerar(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: string };
  const input = req.body as ReGenerarContratoInput;
  const contrato = await contratosService.regenerarContrato(id, input, req.user!.id, req.ip);
  sendSuccess(res, contrato);
}

export async function descargar(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: string };
  const inline = req.query.inline === 'true';
  const result = await contratosService.descargarContrato(id, req.user!.id, req.ip, { inline });
  sendSuccess(res, result);
}

export async function listVersiones(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: string };
  const versiones = await contratosService.listVersionesByContrato(id);
  sendSuccess(res, versiones);
}

export async function descargarVersion(req: Request, res: Response) {
  const { id, versionNum } = req.params as unknown as VersionDescargarParams;
  const result = await contratosService.descargarVersion(id, versionNum, req.user!.id, req.ip);
  sendSuccess(res, result);
}

export async function compararVersiones(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: string };
  const { v1, v2 } = req.query as unknown as CompararVersionesQuery;
  const result = await contratosService.compararVersiones(id, v1, v2);
  sendSuccess(res, result);
}

export async function renovar(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: string };
  const input = req.body as RenovarContratoInput;
  const contrato = await contratosService.renovarContrato(id, input, req.user!.id, req.ip);
  sendCreated(res, contrato);
}

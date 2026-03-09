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

export async function listAll(req: Request, res: Response) {
  const query = req.query as unknown as ListAllContratosQuery;
  const result = await contratosService.listAllContratos(query);
  sendSuccess(res, result.contratos, 200, result.pagination);
}

export async function listByExpediente(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const query = req.query as unknown as ListContratosQuery;
  const result = await contratosService.listContratosByExpediente(expedienteId, query);
  sendSuccess(res, result.contratos, 200, result.pagination);
}

export async function getDetalle(req: Request, res: Response) {
  const { id } = req.params as unknown as { id: string };
  const contrato = await contratosService.getContratoById(id);
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
  const result = await contratosService.descargarContrato(id, req.user!.id, req.ip);
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

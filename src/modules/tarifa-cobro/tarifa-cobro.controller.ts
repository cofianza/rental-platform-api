import type { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import { CONTENT_TYPE_XLSX } from '@/modules/migracion/plantilla';
import { emitirCuenta } from './tarifa-cobro.service';
import * as gestion from './tarifa-cobro.gestion.service';

const id = (req: Request) => (req.params as { id: string }).id;
const query = <T>(req: Request) => (req as Request & { validatedQuery: T }).validatedQuery;

export async function listarCuentas(req: Request, res: Response) {
  sendSuccess(res, await gestion.listarCuentas(req.user!, query(req)));
}

export async function obtenerCuenta(req: Request, res: Response) {
  sendSuccess(res, await gestion.obtenerCuenta(id(req), req.user!));
}

export async function emitir(req: Request, res: Response) {
  sendSuccess(res, await emitirCuenta(id(req), req.user!.id));
}

export async function pagarCuenta(req: Request, res: Response) {
  sendSuccess(res, await gestion.pagarCuenta(id(req), req.body, req.user!.id, req.ip));
}

export async function pagarLinea(req: Request, res: Response) {
  sendSuccess(res, await gestion.pagarLinea(id(req), req.body, req.user!.id, req.ip));
}

export async function anularLinea(req: Request, res: Response) {
  sendSuccess(res, await gestion.anularLinea(id(req), req.body.motivo, req.user!, req.ip));
}

export async function marcarNoRecaudada(req: Request, res: Response) {
  sendSuccess(res, await gestion.marcarNoRecaudada(id(req), req.user!, req.ip));
}

export async function terminacionEfectiva(req: Request, res: Response) {
  sendSuccess(res, await gestion.registrarTerminacionEfectiva(id(req), req.body.fecha, req.user!.id, req.ip));
}

export async function registrarCondicion(req: Request, res: Response) {
  sendSuccess(res, await gestion.registrarCondicion(id(req), req.body, req.user!, req.ip));
}

export async function liquidacionXlsx(req: Request, res: Response) {
  const { periodo } = query<{ periodo: string }>(req);
  const { buffer } = await gestion.liquidacionXlsx(periodo);
  res.set('Content-Type', CONTENT_TYPE_XLSX);
  res.set('Content-Disposition', `attachment; filename="tarifa-mensual-${periodo.slice(0, 7)}.xlsx"`);
  res.send(buffer);
}

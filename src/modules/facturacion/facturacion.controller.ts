import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import * as service from './facturacion.service';
import * as factus from '@/lib/factus';

export async function list(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await service.listFacturas(req.query as any, req.user!.id, req.user!.rol);
  sendSuccess(res, result.facturas, { pagination: result.pagination } as never);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const result = await service.getFacturaById(id);
  sendSuccess(res, result);
}

export async function facturarPago(req: Request, res: Response) {
  const { pagoId } = req.params as { pagoId: string };
  const result = await service.crearFacturaDesdePago(pagoId, req.user!.id, req.ip);
  sendSuccess(res, result, undefined, 201);
}

export async function searchMunicipalities(req: Request, res: Response) {
  const name = String(req.query.name || '').trim();
  if (name.length < 2) {
    sendSuccess(res, []);
    return;
  }
  const result = await factus.searchMunicipalities(name);
  sendSuccess(res, result);
}

export async function getTarifasIva(_req: Request, res: Response) {
  const result = await service.listTarifasIva();
  sendSuccess(res, result);
}

export async function updateTarifasIva(req: Request, res: Response) {
  const body = req.body as { tarifas: { concepto: string; tasa: number }[] };
  const result = await service.updateTarifasIva(body.tarifas, req.user!.id, req.ip);
  sendSuccess(res, result);
}

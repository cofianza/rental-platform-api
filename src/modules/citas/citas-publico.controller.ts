import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as service from './citas-publico.service';
import type { VisitaSlotsQuery, VisitaTokenParams } from './citas-publico.schema';

export async function getVisita(req: Request, res: Response) {
  const { token } = req.params as unknown as VisitaTokenParams;
  sendSuccess(res, await service.getCitaPublica(token));
}

export async function getSlots(req: Request, res: Response) {
  const { token } = req.params as unknown as VisitaTokenParams;
  const { desde, hasta } = req.query as unknown as VisitaSlotsQuery;
  sendSuccess(res, await service.getSlotsPublicos(token, desde, hasta));
}

export async function reprogramar(req: Request, res: Response) {
  const { token } = req.params as unknown as VisitaTokenParams;
  const { fecha } = req.body as { fecha: string };
  sendSuccess(res, await service.reprogramarCitaPublica(token, fecha));
}

export async function cancelar(req: Request, res: Response) {
  const { token } = req.params as unknown as VisitaTokenParams;
  const { motivo } = req.body as { motivo?: string };
  sendSuccess(res, await service.cancelarCitaPublica(token, motivo));
}

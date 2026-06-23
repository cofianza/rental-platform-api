import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as service from './citas-publico.service';
import type { VisitaSlotsQuery, VisitaTokenParams } from './citas-publico.schema';

// Meta antepone el placeholder literal "{{1}}" al sufijo dinámico del botón URL
// (lo deja literal y le pega el token detrás), así que el token puede llegar
// como "{{1}}<token>" — o incluso URL-codificado ("%7B%7B1%7D%7D<token>") si el
// cliente no lo decodifica. Limpiamos todo lo no-hex y tomamos los ÚLTIMOS 64
// (el token real va al final), robusto en ambas formas.
function extractToken(raw: string): string {
  const hex = raw.replace(/[^a-f0-9]/gi, '');
  return hex.length >= 64 ? hex.slice(-64) : raw;
}

export async function getVisita(req: Request, res: Response) {
  const { token } = req.params as unknown as VisitaTokenParams;
  sendSuccess(res, await service.getCitaPublica(extractToken(token)));
}

export async function getSlots(req: Request, res: Response) {
  const { token } = req.params as unknown as VisitaTokenParams;
  const { desde, hasta } = req.query as unknown as VisitaSlotsQuery;
  sendSuccess(res, await service.getSlotsPublicos(extractToken(token), desde, hasta));
}

export async function reprogramar(req: Request, res: Response) {
  const { token } = req.params as unknown as VisitaTokenParams;
  const { fecha } = req.body as { fecha: string };
  sendSuccess(res, await service.reprogramarCitaPublica(extractToken(token), fecha));
}

export async function cancelar(req: Request, res: Response) {
  const { token } = req.params as unknown as VisitaTokenParams;
  const { motivo } = req.body as { motivo?: string };
  sendSuccess(res, await service.cancelarCitaPublica(extractToken(token), motivo));
}

export async function confirmar(req: Request, res: Response) {
  const { token } = req.params as unknown as VisitaTokenParams;
  sendSuccess(res, await service.confirmarAsistenciaPublica(extractToken(token)));
}

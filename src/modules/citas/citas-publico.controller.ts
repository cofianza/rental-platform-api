import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as service from './citas-publico.service';
import type { VisitaSlotsQuery, VisitaTokenParams } from './citas-publico.schema';

// Meta antepone el placeholder literal "{{1}}" al sufijo dinámico del botón URL
// (lo deja literal y le pega el token detrás), así que el token puede llegar
// como "{{1}}<token>". Extraemos los 64 hex reales antes de usarlo.
function extractToken(raw: string): string {
  return raw.match(/[a-f0-9]{64}/i)?.[0] ?? raw;
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

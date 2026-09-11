import type { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import { AppError } from '@/lib/errors';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { listarParametros, listarHistorial, setParametro, validarParametro } from '@/lib/calibracion';
import { resumenCascada, resumenRevisionManual } from './calibracion.service';

export async function listar(_req: Request, res: Response) {
  sendSuccess(res, await listarParametros());
}

export async function historial(_req: Request, res: Response) {
  sendSuccess(res, await listarHistorial());
}

export async function cascada(req: Request, res: Response) {
  // Express 5: req.query es de solo lectura; validate deja lo parseado aqui.
  const query = (req as Request & { validatedQuery?: { dias: number } }).validatedQuery;
  sendSuccess(res, await resumenCascada(query?.dias ?? 30));
}

export async function revisionManual(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery?: { dias: number } }).validatedQuery;
  sendSuccess(res, await resumenRevisionManual(query?.dias ?? 30));
}

export async function actualizar(req: Request, res: Response) {
  const { clave } = req.params as { clave: string };
  const { valor, motivo } = req.body as { valor: number; motivo?: string };

  const v = validarParametro(clave, valor);
  if (!v) throw AppError.notFound(`Parametro desconocido: ${clave}`, 'PARAMETRO_NOT_FOUND');
  if (v.error) throw AppError.badRequest(v.error, 'PARAMETRO_INVALIDO');

  const fila = await setParametro(clave, valor, req.user!.id, motivo);

  logAudit({
    usuarioId: req.user!.id,
    accion: AUDIT_ACTIONS.CALIBRACION_PARAMETRO_CAMBIADO,
    entidad: AUDIT_ENTITIES.CALIBRACION,
    entidadId: clave,
    detalle: { valor_nuevo: valor, motivo: motivo ?? null },
    ip: req.ip,
  });

  sendSuccess(res, fila);
}

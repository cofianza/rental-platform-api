import type { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import { AppError } from '@/lib/errors';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import {
  listarParametros,
  listarHistorial,
  nivelDe,
  puedeEditarParametro,
  setParametro,
  validarParametro,
} from '@/lib/calibracion';
import { resumenCascada, resumenRevisionManual } from './calibracion.service';

export async function listar(req: Request, res: Response) {
  // Adenda 1 contratos, resp. 17: la web muestra de solo lectura lo que este usuario no puede cambiar.
  const filas = await listarParametros();
  sendSuccess(
    res,
    filas.map((p) => ({ ...p, nivel: nivelDe(p.clave), editable: puedeEditarParametro(p.clave, req.user!) })),
  );
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
  if (!puedeEditarParametro(clave, req.user!))
    throw AppError.forbidden(
      'Este parámetro afecta el riesgo: solo la Gerencia General puede cambiarlo.',
      'SOLO_GERENCIA_GENERAL',
    );
  if (v.error) throw AppError.badRequest(v.error, 'PARAMETRO_INVALIDO');

  const fila = await setParametro(clave, valor, req.user!.id, motivo);

  // Traza completa (resp. 17): valor anterior, nuevo, usuario (id y correo) y fecha (la de la fila).
  logAudit({
    usuarioId: req.user!.id,
    accion: AUDIT_ACTIONS.CALIBRACION_PARAMETRO_CAMBIADO,
    entidad: AUDIT_ENTITIES.CALIBRACION,
    entidadId: clave,
    detalle: {
      valor_anterior: fila.valor_anterior,
      valor_nuevo: valor,
      nivel: nivelDe(clave),
      email: req.user!.email,
      motivo: motivo ?? null,
    },
    ip: req.ip,
  });

  sendSuccess(res, fila);
}

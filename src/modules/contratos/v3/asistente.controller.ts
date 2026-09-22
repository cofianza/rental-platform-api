import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as asistente from './asistente.service';
import type { GuardarPasoBody } from './asistente.types';

// Cada acción devuelve el estado completo del asistente: la web solo pinta la última respuesta.

const expedienteId = (req: Request) => (req.params as { expedienteId: string }).expedienteId;

export async function obtener(req: Request, res: Response) {
  sendSuccess(res, await asistente.obtenerEstado(expedienteId(req), req.user!.id, req.user!.rol));
}

/** 201 al crear el borrador; 200 si ya había uno vivo (Iniciar es idempotente). */
export async function iniciar(req: Request, res: Response) {
  const { estado, creado } = await asistente.iniciarContrato(expedienteId(req), req.user!.id, req.user!.rol, req.ip);
  sendSuccess(res, estado, creado ? 201 : 200);
}

export async function guardarPaso(req: Request, res: Response) {
  const body = req.body as GuardarPasoBody;
  // ip y email van a la aceptación del aviso de las cláusulas adicionales (paso 4).
  sendSuccess(
    res,
    await asistente.guardarPaso(expedienteId(req), body, req.user!.id, req.user!.rol, req.ip, req.user!.email),
  );
}

export async function generar(req: Request, res: Response) {
  sendSuccess(res, await asistente.generarVistaPrevia(expedienteId(req), req.user!.id, req.user!.rol, req.ip));
}

export async function autorizarExceso(req: Request, res: Response) {
  const { huella } = req.body as { huella: string };
  sendSuccess(res, await asistente.autorizarExceso(expedienteId(req), huella, req.user!.id, req.user!.rol, req.ip));
}

import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as asistente from './asistente.service';
import type { GuardarPasoBody, MarcaFirma } from './asistente.types';

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
  sendSuccess(res, await asistente.autorizarExceso(expedienteId(req), huella, req.user!.id, req.user!.rol, req.user!.email, req.ip));
}

// ── Entrega 5 ──

export async function cargarPropio(req: Request, res: Response) {
  sendSuccess(res, await asistente.cargarPropio(expedienteId(req), req.file, req.user!.id, req.user!.rol));
}

export async function guardarFirmasPropio(req: Request, res: Response) {
  const body = req.body as { propioSha256: string; firmas: MarcaFirma[] };
  sendSuccess(res, await asistente.guardarFirmasPropio(expedienteId(req), body, req.user!.id, req.user!.rol, req.ip));
}

export async function propioUrl(req: Request, res: Response) {
  sendSuccess(res, await asistente.propioUrl(expedienteId(req), req.user!.id, req.user!.rol));
}

export async function crcUrl(req: Request, res: Response) {
  sendSuccess(res, await asistente.crcUrl(expedienteId(req), req.user!.id, req.user!.rol));
}

export async function enviar(req: Request, res: Response) {
  const body = req.body as { generacion: number; propioSha256?: string; firmasHuella?: string };
  sendSuccess(res, await asistente.enviarAFirma(expedienteId(req), body, req.user!.id, req.user!.rol, req.ip));
}

export async function reenviar(req: Request, res: Response) {
  sendSuccess(res, await asistente.reenviarFirma(expedienteId(req), req.user!.id, req.user!.rol));
}

export async function reintentar(req: Request, res: Response) {
  sendSuccess(res, await asistente.reintentarFirma(expedienteId(req), req.user!.id, req.user!.rol));
}

export async function reenviarIdentidad(req: Request, res: Response) {
  sendSuccess(res, await asistente.reenviarIdentidadFirma(expedienteId(req), req.user!.id, req.user!.rol));
}

export async function actualizarFirma(req: Request, res: Response) {
  sendSuccess(res, await asistente.actualizarFirmaV3(expedienteId(req), req.user!.id, req.user!.rol));
}

// ── Adenda 1 del módulo de contratos ──

export async function prorrogarPlazo(req: Request, res: Response) {
  sendSuccess(res, await asistente.prorrogarPlazoFirma(expedienteId(req), req.user!.id, req.user!.rol));
}

export async function aceptarAviso(req: Request, res: Response) {
  const u = req.user!;
  sendSuccess(res, await asistente.aceptarAvisoFirma(expedienteId(req), { id: u.id, rol: u.rol, email: u.email }, req.ip));
}

import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as autorizacionesService from './autorizaciones.service';
import type {
  EnviarEnlaceAutorizacionInput,
  FirmarInput,
  RevocarInput,
  VerificarOtpInput,
  PerfilProspectoInput,
  ReportarIdentidadInput,
  BiometriaInput,
} from './autorizaciones.schema';

// ============================================================
// Authenticated endpoints
// ============================================================

export async function getAutorizacionStatus(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const autorizacion = await autorizacionesService.getAutorizacionForExpediente(
    expedienteId,
    req.user?.id,
    req.user?.rol,
  );
  sendSuccess(res, autorizacion);
}

export async function enviarEnlace(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const contacto = req.body as EnviarEnlaceAutorizacionInput;
  const result = await autorizacionesService.enviarEnlaceAutorizacion(
    expedienteId,
    req.user!.id,
    req.ip,
    contacto,
    req.user!.rol,
  );
  sendCreated(res, result);
}

export async function revocarAutorizacion(req: Request, res: Response) {
  const { expedienteId } = req.params as unknown as { expedienteId: string };
  const input = req.body as RevocarInput;
  const result = await autorizacionesService.revocarAutorizacion(
    expedienteId,
    input,
    req.user!.id,
    req.user!.rol,
    req.ip,
  );
  sendSuccess(res, result);
}

// ============================================================
// Public endpoints
// ============================================================

export async function getAutorizacionPublic(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const data = await autorizacionesService.getAutorizacionByToken(token);
  sendSuccess(res, data);
}

export async function getPagoProspecto(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  sendSuccess(res, await autorizacionesService.getPagoProspectoPorToken(token));
}

export async function firmar(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const input = req.body as FirmarInput;
  const result = await autorizacionesService.firmarAutorizacion(
    token,
    input,
    req.ip,
    req.headers['user-agent'],
  );
  sendSuccess(res, result);
}

export async function enviarOtp(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const result = await autorizacionesService.enviarOtpCode(token);
  sendSuccess(res, result);
}

export async function verificarOtp(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const { codigo } = req.body as VerificarOtpInput;
  const result = await autorizacionesService.verificarOtpCode(token, codigo);
  sendSuccess(res, result);
}

// PASO 5 (Flujo §8): perfil declarado por el prospecto y reporte de identidad.
export async function guardarPerfil(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const input = req.body as PerfilProspectoInput;
  const result = await autorizacionesService.guardarPerfilProspecto(token, input);
  sendSuccess(res, result);
}

// Cotejo biometrico (Politica Anexo A + §14). NUNCA responde error por un
// cotejo fallido: el veredicto viaja en el 200 y el prospecto puede seguir.
export async function verificarBiometria(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const input = req.body as BiometriaInput;
  const result = await autorizacionesService.verificarBiometriaProspecto(token, input);
  sendSuccess(res, result);
}

// El prospecto ejerce su derecho a no dar el dato sensible (Ley 1581, art. 6).
export async function omitirBiometria(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const result = await autorizacionesService.omitirBiometriaProspecto(token);
  sendSuccess(res, result);
}

export async function reportarIdentidad(req: Request, res: Response) {
  const { token } = req.params as unknown as { token: string };
  const input = req.body as ReportarIdentidadInput;
  const result = await autorizacionesService.reportarIdentidadProspecto(
    token,
    input,
    req.ip,
    req.headers['user-agent'],
  );
  sendSuccess(res, result);
}

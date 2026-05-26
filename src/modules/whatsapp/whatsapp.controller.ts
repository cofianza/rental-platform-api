import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import * as whatsappService from './whatsapp.service';
import type { EnviarWhatsappInput } from './whatsapp.schema';

export async function enviar(req: Request, res: Response) {
  const input = req.body as EnviarWhatsappInput;
  const result = await whatsappService.enviarMensaje(input);
  sendSuccess(res, result);
}

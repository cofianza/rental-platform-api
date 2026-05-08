// ============================================================
// Admin Tools — Controller (TEMPORAL)
// ============================================================

import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import { registerWebhook } from '@/lib/auco';
import { logger } from '@/lib/logger';
import * as adminToolsService from './admin-tools.service';

export async function wipeTestData(req: Request, res: Response) {
  const confirm = (req.body?.confirm ?? '') as string;
  const user = req.user!;
  const result = await adminToolsService.wipeTestData(confirm, {
    id: user.id,
    email: user.email,
  });
  sendSuccess(res, result);
}

// Registra el webhook 'default' de Auco apuntando a la URL publica de
// nuestra API. Body: { url } requerido — pasa la URL completa del
// webhook handler (ej. "https://rental-platform-api-production-4f8d
// .up.railway.app/api/v1/webhooks/auco/firma").
export async function registerAucoWebhook(req: Request, res: Response) {
  const url = (req.body?.url ?? '').toString().trim();
  if (!url || !url.startsWith('https://')) {
    res.status(400).json({
      success: false,
      errorCode: 'INVALID_URL',
      message: 'Pasa el URL completo del webhook en body.url (debe ser HTTPS)',
    });
    return;
  }

  logger.info({ webhookUrl: url, userId: req.user!.id }, 'Registrando webhook de Auco');
  await registerWebhook(url);
  sendSuccess(res, { url, registered: true });
}

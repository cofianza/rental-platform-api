import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { enviarWhatsappSchema } from './whatsapp.schema';
import * as controller from './whatsapp.controller';

const router = Router();

router.use(authMiddleware);

// Solo roles con derecho a iniciar conversaciones por WhatsApp
// (notificación de estudio, mora, recordatorio de cita, etc.).
router.use(
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
);

// POST /api/v1/whatsapp/enviar — encola un mensaje de WhatsApp.
// Actualmente el provider activo es mock (loguea sin enviar). La
// integración con Meta Business Cloud queda pendiente — ver
// providers/meta.provider.ts.
router.post(
  '/enviar',
  validate({ body: enviarWhatsappSchema }),
  controller.enviar,
);

export default router;

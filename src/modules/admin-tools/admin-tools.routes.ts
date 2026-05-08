// ============================================================
// Admin Tools — Routes (TEMPORAL)
//
// Mario (7-may-2026): boton "Borrar datos de prueba" en el dashboard del
// administrador. Solo accesible para rol='administrador'. ELIMINAR antes
// de produccion (junto con la migracion 20260507000005).
// ============================================================

import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import * as controller from './admin-tools.controller';

const router = Router();

router.post(
  '/wipe-test-data',
  authMiddleware,
  roleGuard(['administrador']),
  controller.wipeTestData,
);

// Registra el webhook de Auco para notificaciones de firma. One-shot
// que sobreescribe el webhook 'default' apuntando a nuestra API.
router.post(
  '/auco/register-webhook',
  authMiddleware,
  roleGuard(['administrador']),
  controller.registerAucoWebhook,
);

export default router;

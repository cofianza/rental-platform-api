// ============================================================
// Admin Tools — Routes
//
// Solo queda el registro del webhook de Auco. "Borrar datos de prueba"
// (fn_wipe_test_data) y "seed-test-users" (cuentas con clave fija en el
// repo) se retiraron el 2026-09-22: eran herramientas de QA y seguían vivas
// en producción.
// ============================================================

import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import * as controller from './admin-tools.controller';

const router = Router();

// Registra el webhook de Auco para notificaciones de firma. One-shot
// que sobreescribe el webhook 'default' apuntando a nuestra API.
router.post(
  '/auco/register-webhook',
  authMiddleware,
  roleGuard(['administrador']),
  controller.registerAucoWebhook,
);

export default router;

// ============================================================
// Panel de calibracion — Adenda 1 §11
//
// "unicamente por la Gerencia General". En el RBAC de la plataforma no existe
// un rol 'gerencia_general' con escritura (gerencia_consulta es de solo
// lectura), asi que el gate es rol='administrador' — el mismo que administra
// paquetes y organizaciones. Cada cambio queda con usuario, fecha, valor
// anterior y nuevo en parametros_calibracion_historial.
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import * as controller from './calibracion.controller';

const router = Router();
router.use(authMiddleware, roleGuard(['administrador']));

router.get('/', controller.listar);
router.get('/historial', controller.historial);
router.patch(
  '/:clave',
  validate({
    params: z.object({ clave: z.string().min(1).max(60) }),
    body: z.object({
      valor: z.number().finite(),
      motivo: z.string().max(500).optional(),
    }),
  }),
  controller.actualizar,
);

export default router;

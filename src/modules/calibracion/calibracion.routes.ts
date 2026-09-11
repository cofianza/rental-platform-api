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
// Adenda §2.4: "el tablero de calibracion debe mostrar el porcentaje de
// estudios resueltos con una sola central y con dos". Ventana en dias.
router.get(
  '/cascada',
  validate({
    query: z.object({ dias: z.coerce.number().int().min(1).max(365).default(30) }),
  }),
  controller.cascada,
);
// Adenda 2 §5.1 y §8: revision manual (volumen, tiempo vs SLA), escalados
// por falta de ingreso y tasa de caida de DataCredito. Ventana en dias.
router.get(
  '/revision-manual',
  validate({
    query: z.object({ dias: z.coerce.number().int().min(1).max(365).default(30) }),
  }),
  controller.revisionManual,
);
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

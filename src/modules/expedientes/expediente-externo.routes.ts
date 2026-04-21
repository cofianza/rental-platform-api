import { Router, Request, Response } from 'express';
import { authMiddleware, authorize } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { sendSuccess, sendCreated } from '@/lib/response';
import {
  crearExpedienteExternoSchema,
  type CrearExpedienteExternoInput,
} from './expediente-externo.schema';
import { crearExpedienteExterno } from './expediente-externo.service';

const router = Router();

// POST /expedientes/externo — Crear expediente externo y enviar invitacion
router.post(
  '/externo',
  authMiddleware,
  authorize('expedientes', 'create'),
  validate({ body: crearExpedienteExternoSchema }),
  async (req: Request, res: Response) => {
    const input = req.body as CrearExpedienteExternoInput;
    const ip = req.ip;
    const expediente = await crearExpedienteExterno(input, req.user!.id, ip);
    sendCreated(res, expediente);
  },
);

export default router;

// Adenda de precios §4.3: beneficio acumulado sin liquidar, SOLO LECTURA para
// administrador y gerencia_consulta. La inmobiliaria no lo ve (decisión 7).
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { sendSuccess } from '@/lib/response';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { listarBeneficios } from './beneficios.service';

export const adminBeneficiosRouter = Router();
adminBeneficiosRouter.use(authMiddleware, roleGuard(['administrador', 'gerencia_consulta']));

adminBeneficiosRouter.get(
  '/',
  validate({ query: z.object({ inmobiliaria_id: z.uuid().optional() }) }),
  async (req: Request, res: Response) => {
    const q = (req as Request & { validatedQuery?: { inmobiliaria_id?: string } }).validatedQuery;
    sendSuccess(res, await listarBeneficios(q?.inmobiliaria_id));
  },
);

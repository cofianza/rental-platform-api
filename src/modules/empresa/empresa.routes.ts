import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { updateEmpresaSchema } from './empresa.schema';
import * as controller from './empresa.controller';

// /api/v1/empresa — datos de la empresa (Cofianza). Solo el administrador.
export const empresaRouter = Router();

empresaRouter.use(authMiddleware, roleGuard(['administrador']));

empresaRouter.get('/', controller.get);
empresaRouter.put('/', validate({ body: updateEmpresaSchema }), controller.update);

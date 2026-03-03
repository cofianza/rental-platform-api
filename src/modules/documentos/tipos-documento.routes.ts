/**
 * Rutas de tipos de documento - /api/v1/tipos-documento
 * Listado de tipos activos
 */

import { Router } from 'express';
import { authMiddleware, authorize } from '@/middleware/auth';
import * as documentosController from './documentos.controller';

const router = Router();

router.use(authMiddleware);

// GET / - Listar tipos de documento activos
router.get(
  '/',
  authorize('documentos', 'read'),
  documentosController.listTipos,
);

export default router;

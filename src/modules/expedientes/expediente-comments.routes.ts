import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  expedienteIdParamsSchema,
  commentParamsSchema,
  createCommentSchema,
  updateCommentSchema,
} from './expediente-comments.schema';
import * as commentsController from './expediente-comments.controller';

const router = Router();

// Auth a nivel router (authMiddleware no distingue rol).
// IMPORTANTE: roleGuard debe ir POR-RUTA, no con router.use(), porque
// varios routers están mounted en /api/v1/expedientes y Express ejecuta
// router.use() para TODO request que entre al prefix — incluso los que
// no matchean ninguna ruta del router. Un router-level guard bloquearía
// requests que deberían ir a otros routers (ej. habilitar-estudio).
router.use(authMiddleware);

const commentsRoleGuard = roleGuard(['administrador', 'operador_analista']);

// GET /api/v1/expedientes/:id/comments
router.get(
  '/:id/comments',
  commentsRoleGuard,
  validate({ params: expedienteIdParamsSchema }),
  commentsController.list,
);

// POST /api/v1/expedientes/:id/comments
router.post(
  '/:id/comments',
  commentsRoleGuard,
  validate({ params: expedienteIdParamsSchema, body: createCommentSchema }),
  commentsController.create,
);

// PUT /api/v1/expedientes/:id/comments/:commentId
router.put(
  '/:id/comments/:commentId',
  commentsRoleGuard,
  validate({ params: commentParamsSchema, body: updateCommentSchema }),
  commentsController.update,
);

// DELETE /api/v1/expedientes/:id/comments/:commentId
router.delete(
  '/:id/comments/:commentId',
  commentsRoleGuard,
  validate({ params: commentParamsSchema }),
  commentsController.remove,
);

export default router;

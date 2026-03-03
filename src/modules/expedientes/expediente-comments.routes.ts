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

// All comment routes require auth + role
router.use(authMiddleware);
router.use(roleGuard(['administrador', 'operador_analista']));

// GET /api/v1/expedientes/:id/comments
router.get(
  '/:id/comments',
  validate({ params: expedienteIdParamsSchema }),
  commentsController.list,
);

// POST /api/v1/expedientes/:id/comments
router.post(
  '/:id/comments',
  validate({ params: expedienteIdParamsSchema, body: createCommentSchema }),
  commentsController.create,
);

// PUT /api/v1/expedientes/:id/comments/:commentId
router.put(
  '/:id/comments/:commentId',
  validate({ params: commentParamsSchema, body: updateCommentSchema }),
  commentsController.update,
);

// DELETE /api/v1/expedientes/:id/comments/:commentId
router.delete(
  '/:id/comments/:commentId',
  validate({ params: commentParamsSchema }),
  commentsController.remove,
);

export default router;

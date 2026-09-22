import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import {
  cambiarEstadoSchema,
  clausulaIdParamsSchema,
  clausulaSchema,
  editarClausulaSchema,
  registroQuerySchema,
} from './clausulas.schema';
import * as controller from './clausulas.controller';

// ============================================================
// Cláusulas adicionales — Contratos V3, Entrega 4 (diseño §5.1).
// /api/v1/clausulas-adicionales: catálogo de la inmobiliaria (biblioteca +
//   propias). El service responde 404 con CONTRATOS_V3_ENABLED apagado. Los
//   miembros solo_lectura quedan fuera de POST/PUT/DELETE por el middleware de auth.
// /api/v1/admin/clausulas-adicionales: biblioteca y registro, solo
//   administrador y sin compuerta de flag (Cofianza carga la biblioteca antes).
// ============================================================

export const clausulasRouter = Router();
clausulasRouter.use(authMiddleware, roleGuard(['inmobiliaria']));

clausulasRouter.get('/', controller.catalogo);
clausulasRouter.post('/', validate({ body: clausulaSchema }), controller.crear);
clausulasRouter.put('/:id', validate({ params: clausulaIdParamsSchema, body: editarClausulaSchema }), controller.editar);
clausulasRouter.delete('/:id', validate({ params: clausulaIdParamsSchema }), controller.eliminar);

export const adminClausulasRouter = Router();
adminClausulasRouter.use(authMiddleware, roleGuard(['administrador']));

adminClausulasRouter.get('/', validate({ query: registroQuerySchema }), controller.registro);
adminClausulasRouter.get('/:id/usos', validate({ params: clausulaIdParamsSchema }), controller.usos);
adminClausulasRouter.post('/', validate({ body: clausulaSchema }), controller.crearBiblioteca);
adminClausulasRouter.put(
  '/:id',
  validate({ params: clausulaIdParamsSchema, body: editarClausulaSchema }),
  controller.editarBiblioteca,
);
adminClausulasRouter.patch(
  '/:id/estado',
  validate({ params: clausulaIdParamsSchema, body: cambiarEstadoSchema }),
  controller.cambiarEstado,
);

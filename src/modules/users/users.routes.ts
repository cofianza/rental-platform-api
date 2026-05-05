import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { listUsersQuerySchema, userIdParamsSchema, createUserSchema, updateUserSchema } from './users.schema';
import * as usersController from './users.controller';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// GET /users/operators — accessible to admin + operador_analista (HP-285)
router.get('/operators', roleGuard(['administrador', 'operador_analista']), usersController.listOperators);

// All remaining routes require administrador role
router.use(roleGuard(['administrador']));

// GET /users/orphans — auth.users sin entrada en perfiles. Para el panel
// super-admin de limpieza de cuentas huérfanas (registros fallidos).
// IMPORTANTE: registrarla antes de /:id, si no Express la matchea como :id.
router.get('/orphans', usersController.listOrphans);

router.get('/', validate({ query: listUsersQuerySchema }), usersController.list);
router.get('/:id', validate({ params: userIdParamsSchema }), usersController.getById);
router.post('/', validate({ body: createUserSchema }), usersController.create);
router.put('/:id', validate({ params: userIdParamsSchema, body: updateUserSchema }), usersController.update);
router.patch('/:id/deactivate', validate({ params: userIdParamsSchema }), usersController.deactivate);
router.patch('/:id/activate', validate({ params: userIdParamsSchema }), usersController.activate);

// DELETE /users/:id?force=true — Borrado completo (super-admin).
// Pre-flight check: si tiene relaciones bloqueantes responde 400 con detalle.
// El admin puede reintentar con ?force=true para que el RDBMS resuelva las
// FKs según ON DELETE policy de cada tabla.
router.delete('/:id', validate({ params: userIdParamsSchema }), usersController.remove);

export default router;

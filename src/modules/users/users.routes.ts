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

router.get('/', validate({ query: listUsersQuerySchema }), usersController.list);
router.get('/:id', validate({ params: userIdParamsSchema }), usersController.getById);
router.post('/', validate({ body: createUserSchema }), usersController.create);
router.put('/:id', validate({ params: userIdParamsSchema, body: updateUserSchema }), usersController.update);
router.patch('/:id/deactivate', validate({ params: userIdParamsSchema }), usersController.deactivate);
router.patch('/:id/activate', validate({ params: userIdParamsSchema }), usersController.activate);

export default router;

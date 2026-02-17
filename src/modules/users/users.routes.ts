import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { listUsersQuerySchema, userIdParamsSchema, createUserSchema, updateUserSchema } from './users.schema';
import * as usersController from './users.controller';

const router = Router();

// Todas las rutas requieren autenticacion + rol administrador
router.use(authMiddleware, roleGuard(['administrador']));

router.get('/', validate({ query: listUsersQuerySchema }), usersController.list);
router.get('/:id', validate({ params: userIdParamsSchema }), usersController.getById);
router.post('/', validate({ body: createUserSchema }), usersController.create);
router.put('/:id', validate({ params: userIdParamsSchema, body: updateUserSchema }), usersController.update);
router.patch('/:id/deactivate', validate({ params: userIdParamsSchema }), usersController.deactivate);
router.patch('/:id/activate', validate({ params: userIdParamsSchema }), usersController.activate);

export default router;

import { Router } from 'express';
import { authMiddleware, authorize } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import * as bitacoraController from './bitacora.controller';
import { listAuditLogsQuerySchema, auditLogIdParamsSchema } from './bitacora.schema';

const router = Router();

router.use(authMiddleware, authorize('bitacora', 'read'));

router.get('/', validate({ query: listAuditLogsQuerySchema }), bitacoraController.list);
router.get('/stats', bitacoraController.stats);
router.get('/:id', validate({ params: auditLogIdParamsSchema }), bitacoraController.getById);

export { router as bitacoraRouter };

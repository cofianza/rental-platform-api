import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  reportarMoraSchema,
  listMorasQuerySchema,
  moraIdParamsSchema,
  escalarMoraSchema,
  marcarPagadaSchema,
  cancelarMoraSchema,
  agregarMensajeSchema,
} from './moras.schema';
import * as controller from './moras.controller';

// ============================================================
// Rutas autenticadas — moras del propietario/inmobiliaria + admin
// ============================================================
const router = Router();
router.use(authMiddleware);
router.use(
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
);

// GET /moras/stats — antes de /:id para que no choque con el param
router.get('/stats', controller.stats);

// POST /moras — reportar nueva
router.post('/', validate({ body: reportarMoraSchema }), controller.reportar);

// GET /moras — listar (filtros por estado / contrato / paginación)
router.get('/', validate({ query: listMorasQuerySchema }), controller.list);

// GET /moras/:id — detalle + mensajes
router.get('/:id', validate({ params: moraIdParamsSchema }), controller.detail);

// PATCH /moras/:id/escalar — Fase 1→2 o 2→3 manual
router.patch(
  '/:id/escalar',
  validate({ params: moraIdParamsSchema, body: escalarMoraSchema }),
  controller.escalar,
);

// PATCH /moras/:id/pagar — marca pagada
router.patch(
  '/:id/pagar',
  validate({ params: moraIdParamsSchema, body: marcarPagadaSchema }),
  controller.pagar,
);

// PATCH /moras/:id/cancelar — cancela el caso
router.patch(
  '/:id/cancelar',
  validate({ params: moraIdParamsSchema, body: cancelarMoraSchema }),
  controller.cancelar,
);

// POST /moras/:id/mensajes — agregar mensaje al chat
router.post(
  '/:id/mensajes',
  validate({ params: moraIdParamsSchema, body: agregarMensajeSchema }),
  controller.postMensaje,
);

export default router;

// ============================================================
// Cron router — corre escalado automático periódicamente
// (Mario 12-may-2026). Sin auth: Railway/Vercel cron lo invoca con
// secret en header. En MVP usamos solo header check.
// ============================================================
export const morasCronRouter = Router();

morasCronRouter.post('/auto-escalar', (req, res, next) => {
  const secret = req.header('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ success: false, message: 'Cron secret inválido' });
    return;
  }
  controller.cronAutoEscalar(req, res).catch(next);
});

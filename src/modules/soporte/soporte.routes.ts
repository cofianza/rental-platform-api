// ============================================================
// Soporte — Routes
//
// - POST /tickets: cualquier usuario autenticado puede abrir un ticket.
// - GET /tickets:  solo administrador (vista del Centro de Control).
// - PATCH /tickets/:id/estado: solo administrador.
// ============================================================

import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import * as controller from './soporte.controller';
import {
  createTicketSoporteSchema,
  listTicketsSoporteQuerySchema,
  ticketIdParamsSchema,
  updateTicketEstadoSchema,
} from './soporte.schema';

const router = Router();

router.use(authMiddleware);

router.post(
  '/tickets',
  validate({ body: createTicketSoporteSchema }),
  controller.createTicket,
);

router.get(
  '/tickets',
  roleGuard(['administrador']),
  validate({ query: listTicketsSoporteQuerySchema }),
  controller.listTickets,
);

router.get(
  '/tickets/:id',
  roleGuard(['administrador']),
  validate({ params: ticketIdParamsSchema }),
  controller.getTicket,
);

router.patch(
  '/tickets/:id/estado',
  roleGuard(['administrador']),
  validate({ params: ticketIdParamsSchema, body: updateTicketEstadoSchema }),
  controller.updateEstado,
);

export default router;

// ============================================================
// Soporte — Controller
// ============================================================

import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import { AppError } from '@/lib/errors';
import * as soporteService from './soporte.service';
import type {
  CreateTicketSoporteInput,
  ListTicketsSoporteQuery,
  UpdateTicketEstadoInput,
} from './soporte.schema';

export async function createTicket(req: Request, res: Response) {
  if (!req.user) {
    throw AppError.unauthorized();
  }
  const body = req.body as CreateTicketSoporteInput;
  const ticket = await soporteService.createTicket(req.user.id, body);
  sendSuccess(res, ticket, undefined, 201);
}

export async function listTickets(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: ListTicketsSoporteQuery }).validatedQuery
    || req.query as ListTicketsSoporteQuery;
  const result = await soporteService.listTickets(query);
  sendSuccess(res, result.tickets, {
    total: result.total,
    page: result.page,
    limit: result.limit,
    totalPages: Math.ceil(result.total / result.limit),
  });
}

export async function getTicket(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const ticket = await soporteService.getById(id);
  sendSuccess(res, ticket);
}

export async function updateEstado(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const body = req.body as UpdateTicketEstadoInput;
  const ticket = await soporteService.updateEstado(id, body);
  sendSuccess(res, ticket);
}

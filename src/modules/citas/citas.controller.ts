import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as citasService from './citas.service';
import type {
  CreateCitaInput,
  ConfirmarCitaInput,
  RealizarCitaInput,
  CancelarCitaInput,
  CitaIdParams,
  ListCitasQuery,
} from './citas.schema';

export async function create(req: Request, res: Response) {
  const input = req.body as CreateCitaInput;
  const cita = await citasService.createCita(input, req.user!.id, req.user!.rol);
  sendCreated(res, cita);
}

export async function listByExpediente(req: Request, res: Response) {
  const query = req.query as unknown as ListCitasQuery;
  const result = await citasService.getCitasByExpediente(query, req.user!.id, req.user!.rol);
  sendSuccess(res, result.citas, 200, result.pagination);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as unknown as CitaIdParams;
  const cita = await citasService.getCitaById(id, req.user!.id, req.user!.rol);
  sendSuccess(res, cita);
}

export async function confirmar(req: Request, res: Response) {
  const { id } = req.params as unknown as CitaIdParams;
  const input = req.body as ConfirmarCitaInput;
  const cita = await citasService.confirmarCita(id, input, req.user!.id, req.user!.rol);
  sendSuccess(res, cita);
}

export async function realizar(req: Request, res: Response) {
  const { id } = req.params as unknown as CitaIdParams;
  const input = req.body as RealizarCitaInput;
  const cita = await citasService.realizarCita(id, input, req.user!.id, req.user!.rol);
  sendSuccess(res, cita);
}

export async function cancelar(req: Request, res: Response) {
  const { id } = req.params as unknown as CitaIdParams;
  const input = req.body as CancelarCitaInput;
  const cita = await citasService.cancelarCita(id, input, req.user!.id, req.user!.rol);
  sendSuccess(res, cita);
}

export async function noAsistio(req: Request, res: Response) {
  const { id } = req.params as unknown as CitaIdParams;
  const cita = await citasService.marcarNoAsistio(id, req.user!.id, req.user!.rol);
  sendSuccess(res, cita);
}

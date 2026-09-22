import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as clausulas from './clausulas.service';
import type { CambiarEstadoBody, ClausulaBody, EditarClausulaBody, RegistroQuery } from './clausulas.schema';

// Cláusulas adicionales (Entrega 4): la org y el rol salen de req.user, nunca del cuerpo.

const id = (req: Request) => (req.params as { id: string }).id;

// ── Inmobiliaria ──

export async function catalogo(req: Request, res: Response) {
  sendSuccess(res, await clausulas.catalogo(req.user!.id));
}

export async function crear(req: Request, res: Response) {
  sendSuccess(res, await clausulas.crear(req.user!.id, req.body as ClausulaBody, req.ip), 201);
}

export async function editar(req: Request, res: Response) {
  sendSuccess(res, await clausulas.editar(req.user!.id, id(req), req.body as EditarClausulaBody, req.ip));
}

export async function eliminar(req: Request, res: Response) {
  await clausulas.eliminar(req.user!.id, id(req), req.ip);
  sendSuccess(res, null);
}

// ── Administrador ──

export async function registro(req: Request, res: Response) {
  sendSuccess(res, await clausulas.registro((req as Request & { validatedQuery: RegistroQuery }).validatedQuery));
}

export async function usos(req: Request, res: Response) {
  sendSuccess(res, await clausulas.usos(id(req)));
}

export async function crearBiblioteca(req: Request, res: Response) {
  sendSuccess(res, await clausulas.crearBiblioteca(req.user!.id, req.body as ClausulaBody, req.ip), 201);
}

export async function editarBiblioteca(req: Request, res: Response) {
  sendSuccess(res, await clausulas.editarBiblioteca(req.user!.id, id(req), req.body as EditarClausulaBody, req.ip));
}

export async function cambiarEstado(req: Request, res: Response) {
  sendSuccess(res, await clausulas.cambiarEstado(req.user!.id, id(req), req.body as CambiarEstadoBody, req.ip));
}

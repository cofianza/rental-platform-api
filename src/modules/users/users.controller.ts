import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as usersService from './users.service';
import type { ListUsersQuery, UserIdParams, CreateUserInput, UpdateUserInput } from './users.schema';

export async function list(req: Request, res: Response) {
  const query = req.query as unknown as ListUsersQuery;
  const result = await usersService.listUsers(query);
  sendSuccess(res, result.users, 200, result.pagination);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as unknown as UserIdParams;
  const user = await usersService.getUserById(id);
  sendSuccess(res, user);
}

export async function create(req: Request, res: Response) {
  const input = req.body as CreateUserInput;
  const user = await usersService.createUser(input, req.user!.id, req.ip);
  sendCreated(res, user);
}

export async function update(req: Request, res: Response) {
  const { id } = req.params as unknown as UserIdParams;
  const input = req.body as UpdateUserInput;
  const user = await usersService.updateUser(id, input, req.user!.id, req.ip);
  sendSuccess(res, user);
}

export async function deactivate(req: Request, res: Response) {
  const { id } = req.params as unknown as UserIdParams;
  const user = await usersService.deactivateUser(id, req.user!.id, req.ip);
  sendSuccess(res, user);
}

export async function activate(req: Request, res: Response) {
  const { id } = req.params as unknown as UserIdParams;
  const user = await usersService.activateUser(id, req.user!.id, req.ip);
  sendSuccess(res, user);
}

export async function listOperators(_req: Request, res: Response) {
  const operators = await usersService.listOperators();
  sendSuccess(res, operators);
}

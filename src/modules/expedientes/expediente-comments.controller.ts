import { Request, Response } from 'express';
import { sendSuccess, sendCreated, sendNoContent } from '@/lib/response';
import * as commentsService from './expediente-comments.service';
import type { CommentParams, CreateCommentInput, UpdateCommentInput } from './expediente-comments.schema';
import type { ExpedienteIdParams } from './expediente-workflow.schema';

export async function list(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const comments = await commentsService.listComments(id);
  sendSuccess(res, comments);
}

export async function create(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const input = req.body as CreateCommentInput;
  const comment = await commentsService.createComment(id, input, req.user!.id, req.ip);
  sendCreated(res, comment);
}

export async function update(req: Request, res: Response) {
  const { id, commentId } = req.params as unknown as CommentParams;
  const input = req.body as UpdateCommentInput;
  const comment = await commentsService.updateComment(id, commentId, input, req.user!.id, req.ip);
  sendSuccess(res, comment);
}

export async function remove(req: Request, res: Response) {
  const { id, commentId } = req.params as unknown as CommentParams;
  await commentsService.deleteComment(id, commentId, req.user!.id, req.user!.rol, req.ip);
  sendNoContent(res);
}

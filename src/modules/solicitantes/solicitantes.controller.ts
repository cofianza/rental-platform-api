import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as solicitantesService from './solicitantes.service';
import type {
  ListApplicantsQuery,
  ApplicantIdParams,
  CreateApplicantInput,
  UpdateApplicantInput,
  SearchByDocumentQuery,
} from './solicitantes.schema';

export async function list(req: Request, res: Response) {
  const query = req.query as unknown as ListApplicantsQuery;
  const result = await solicitantesService.listApplicants(query);
  sendSuccess(res, result.solicitantes, 200, result.pagination);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as unknown as ApplicantIdParams;
  const applicant = await solicitantesService.getApplicantById(id);
  sendSuccess(res, applicant);
}

export async function create(req: Request, res: Response) {
  const input = req.body as CreateApplicantInput;
  const applicant = await solicitantesService.createApplicant(input, req.user!.id, req.ip);
  sendCreated(res, applicant);
}

export async function update(req: Request, res: Response) {
  const { id } = req.params as unknown as ApplicantIdParams;
  const input = req.body as UpdateApplicantInput;
  const applicant = await solicitantesService.updateApplicant(id, input, req.user!.id, req.ip);
  sendSuccess(res, applicant);
}

export async function deactivate(req: Request, res: Response) {
  const { id } = req.params as unknown as ApplicantIdParams;
  const applicant = await solicitantesService.deactivateApplicant(id, req.user!.id, req.ip);
  sendSuccess(res, applicant);
}

export async function searchByDocument(req: Request, res: Response) {
  const query = req.query as unknown as SearchByDocumentQuery;
  const applicant = await solicitantesService.searchByDocument(query);
  sendSuccess(res, applicant);
}

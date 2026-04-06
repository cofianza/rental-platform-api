// ============================================================
// Public Properties — Controller (HP-365)
// ============================================================

import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import * as service from './public-properties.service';
import type { ListPublicPropertiesQuery } from './public-properties.schema';

export async function listProperties(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: ListPublicPropertiesQuery }).validatedQuery || req.query;

  const { data, pagination } = await service.listPublicProperties(query as ListPublicPropertiesQuery);

  res.set('Cache-Control', 'public, max-age=60'); // 1 minute cache for public listings
  sendSuccess(res, data, pagination);
}

export async function getPropertyById(req: Request, res: Response) {
  const id = req.params.id as string;

  const property = await service.getPublicPropertyById(id);

  res.set('Cache-Control', 'public, max-age=60');
  sendSuccess(res, property);
}

export async function getFilters(_req: Request, res: Response) {
  const filters = await service.getPublicPropertyFilters();

  res.set('Cache-Control', 'public, max-age=300'); // 5 min cache for filter options
  sendSuccess(res, filters);
}

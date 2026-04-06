// ============================================================
// Public Properties — Routes (HP-365)
// NO authentication required — public API
// ============================================================

import { Router } from 'express';
import { publicFormLimiter } from '@/middleware/rateLimiter';
import { validate } from '@/middleware/validate';
import { listPublicPropertiesSchema, propertyIdParamsSchema } from './public-properties.schema';
import * as controller from './public-properties.controller';

const router = Router();

// Rate limiting for public endpoints
router.use(publicFormLimiter);

// GET /api/v1/public/properties/filters — must be before /:id to avoid matching "filters" as uuid
router.get(
  '/filters',
  controller.getFilters,
);

// GET /api/v1/public/properties — list with pagination and filters
router.get(
  '/',
  validate({ query: listPublicPropertiesSchema }),
  controller.listProperties,
);

// GET /api/v1/public/properties/:id — single property detail
router.get(
  '/:id',
  validate({ params: propertyIdParamsSchema }),
  controller.getPropertyById,
);

export { router as publicPropertiesRouter };

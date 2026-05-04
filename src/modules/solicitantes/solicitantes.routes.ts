import { Router } from 'express';
import { z } from 'zod';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import {
  applicantIdParamsSchema,
  createApplicantSchema,
  updateApplicantSchema,
  listApplicantsQuerySchema,
  searchByDocumentQuerySchema,
} from './solicitantes.schema';
import * as solicitantesController from './solicitantes.controller';

const router = Router();

// Todas las rutas requieren autenticacion JWT
router.use(authMiddleware);

// GET /me/datos-fiscales — datos fiscales del solicitante autenticado.
// Sirve a la pantalla de Facturacion -> Datos Fiscales del solicitante para
// que vea/edite lo que se usara al emitir su factura electronica. Va antes
// de /:id para que Express no capture 'me' como UUID.
router.get(
  '/me/datos-fiscales',
  roleGuard(['solicitante']),
  solicitantesController.getMisDatosFiscales,
);

router.patch(
  '/me/datos-fiscales',
  roleGuard(['solicitante']),
  validate({
    body: z.object({
      tipo_persona: z.enum(['natural', 'juridica']).optional(),
      razon_social: z.string().min(0).max(300).optional(),
      tipo_documento: z.string().min(1).max(20).optional(),
      numero_documento: z.string().min(3).max(40).optional(),
      // DV del NIT colombiano: 1 digito (0-9). Vacio borra el valor.
      digito_verificacion: z.string().regex(/^\d?$/).optional(),
      email: z.string().email().optional(),
      telefono: z.string().min(0).max(40).optional(),
      direccion: z.string().min(0).max(300).optional(),
      municipio_id: z.string().regex(/^\d{5}$/).or(z.literal('')).optional(),
      municipio_nombre: z.string().min(0).max(120).optional(),
      // Codigo DIAN de responsabilidad fiscal. ZZ=No aplica (default).
      tribute_code: z.string().min(1).max(2).optional(),
    }),
  }),
  solicitantesController.updateMisDatosFiscales,
);

// GET /search — Buscar por tipo + numero de documento (ANTES de /:id)
router.get(
  '/search',
  authorize('solicitantes', 'read'),
  validate({ query: searchByDocumentQuerySchema }),
  solicitantesController.searchByDocument,
);

// GET / — Listar con paginacion y busqueda
router.get(
  '/',
  authorize('solicitantes', 'read'),
  validate({ query: listApplicantsQuerySchema }),
  solicitantesController.list,
);

// GET /:id — Obtener detalle por ID
router.get(
  '/:id',
  authorize('solicitantes', 'read'),
  validate({ params: applicantIdParamsSchema }),
  solicitantesController.getById,
);

// POST / — Crear nuevo solicitante
router.post(
  '/',
  authorize('solicitantes', 'create'),
  validate({ body: createApplicantSchema }),
  solicitantesController.create,
);

// PATCH /:id — Actualizar solicitante (parcial)
router.patch(
  '/:id',
  authorize('solicitantes', 'update'),
  validate({ params: applicantIdParamsSchema, body: updateApplicantSchema }),
  solicitantesController.update,
);

// DELETE /:id — Desactivar solicitante (solo administrador)
router.delete(
  '/:id',
  roleGuard(['administrador']),
  validate({ params: applicantIdParamsSchema }),
  solicitantesController.deactivate,
);

export default router;

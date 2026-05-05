import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema } from './expedientes.schema';
import * as controller from './expediente-soportes.controller';

const router = Router();

const PROPOSITOS = [
  'certificacion_laboral',
  'extractos_bancarios',
  'declaracion_renta',
  'carta_referencia',
  'codeudor',
  'poliza',
  'otros_soportes',
] as const;

const MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

const presignedUrlBody = z.object({
  nombre_original: z.string().min(1).max(255),
  tipo_mime: z.enum(MIME_TYPES, {
    message: `Tipo de archivo invalido. Permitidos: ${MIME_TYPES.join(', ')}`,
  }),
  tamano_bytes: z.coerce.number().int().positive().max(10 * 1024 * 1024, 'Maximo 10MB'),
  proposito: z.enum(PROPOSITOS, {
    message: `Proposito invalido. Valores: ${PROPOSITOS.join(', ')}`,
  }),
});

const confirmarBody = z.object({
  storage_key: z.string().min(1),
  nombre_original: z.string().min(1).max(255),
  tipo_mime: z.enum(MIME_TYPES),
  tamano_bytes: z.coerce.number().int().positive().max(10 * 1024 * 1024),
  proposito: z.enum(PROPOSITOS),
});

// Roles que pueden tocar soportes — el service hace ownership fine-grained.
// Importante: solicitante INCLUIDO (es el principal beneficiario del flujo).
const SOPORTE_ROLES = [
  'administrador',
  'operador_analista',
  'propietario',
  'inmobiliaria',
  'solicitante',
] as const;

// POST /api/v1/expedientes/:id/soportes/presigned-url — Solicitante o
// propietario solicitan URL para subir un documento adicional (codeudor,
// póliza, etc.) cuando el expediente está condicionado.
router.post(
  '/:id/soportes/presigned-url',
  authMiddleware,
  roleGuard([...SOPORTE_ROLES]),
  validate({ params: expedienteIdParamsSchema, body: presignedUrlBody }),
  controller.presignedUrl,
);

// POST /api/v1/expedientes/:id/soportes — Confirmar subida (registra en DB).
router.post(
  '/:id/soportes',
  authMiddleware,
  roleGuard([...SOPORTE_ROLES]),
  validate({ params: expedienteIdParamsSchema, body: confirmarBody }),
  controller.confirmar,
);

// GET /api/v1/expedientes/:id/soportes — Listar soportes (signed URLs incluidos).
router.get(
  '/:id/soportes',
  authMiddleware,
  roleGuard([...SOPORTE_ROLES]),
  validate({ params: expedienteIdParamsSchema }),
  controller.listar,
);

export default router;

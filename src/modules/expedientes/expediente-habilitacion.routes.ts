import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema } from './expedientes.schema';
import * as controller from './expediente-habilitacion.controller';

const router = Router();

// PATCH /api/v1/expedientes/:id/habilitar-estudio — Paso 3 del flujo.
// roleGuard filtra solicitante/gerencia_consulta a nivel coarse-grained;
// el service aplica ownership fine-grained para propietario/inmobiliaria.
// Antes este endpoint pedia duracion + fecha del contrato, pero esos datos
// no son necesarios para correr el estudio crediticio — se piden solo cuando
// se va a generar el contrato (post-aprobacion). Por eso ahora no requiere body.
// El body ahora acepta `proveedor` opcional: el gestor elige con qué buró se
// consulta. Se omite → TransUnion, que era el comportamiento fijo anterior.
const habilitarEstudioBodySchema = z
  .object({
    proveedor: z.enum(['transunion', 'datacredito']).optional(),
  })
  .optional();

router.patch(
  '/:id/habilitar-estudio',
  authMiddleware,
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
  validate({ params: expedienteIdParamsSchema, body: habilitarEstudioBodySchema }),
  controller.habilitarEstudio,
);

// POST /api/v1/expedientes/:id/rechazar-estudio — Caso opuesto: el propietario
// decide tras la visita no proceder con el candidato. body.motivo es opcional
// y aparece en el aviso al solicitante.
router.post(
  '/:id/rechazar-estudio',
  authMiddleware,
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
  validate({
    params: expedienteIdParamsSchema,
    body: z.object({ motivo: z.string().max(2000).optional() }),
  }),
  controller.rechazarEstudio,
);

// POST /api/v1/expedientes/:id/omitir-cita — el gestor indica que la visita ya
// se coordinó por fuera (WhatsApp), así se puede habilitar el estudio sin exigir
// una cita 'realizada'. body.motivo opcional (queda en el timeline).
router.post(
  '/:id/omitir-cita',
  authMiddleware,
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
  validate({
    params: expedienteIdParamsSchema,
    body: z.object({ motivo: z.string().max(2000).optional() }),
  }),
  controller.omitirCita,
);

// Body común para el momento de generar el contrato: duración + fecha de inicio.
// Antes vivía en `habilitar-estudio` pero la regla de negocio (Mario, 5-may-2026)
// es pedirlos justo antes de generar el contrato — no del estudio.
const datosContratoBody = z.object({
  duracion_contrato_meses: z.coerce.number().int().min(1).max(120),
  fecha_inicio_contrato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato fecha invalido (YYYY-MM-DD)'),
});

// Aprobar condicionado: los datos del contrato son OPCIONALES. Sin ellos solo
// se aprueba (transición condicionado→aprobado) y el contrato se genera luego
// desde la pestaña Contratos con el formulario completo (modalidad de fianza +
// servicios públicos). Con ellos, se aprueba y genera en un paso.
const aprobarCondicionadoBody = z.object({
  duracion_contrato_meses: z.coerce.number().int().min(1).max(120).optional(),
  fecha_inicio_contrato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato fecha invalido (YYYY-MM-DD)').optional(),
});

// POST /api/v1/expedientes/:id/aprobar-condicionado — Tras revisar la
// documentación adicional pedida (codeudor, póliza, etc.) el propietario
// decide proceder. Transicionamos expediente a 'aprobado' y disparamos la
// generación del contrato con los datos enviados.
router.post(
  '/:id/aprobar-condicionado',
  authMiddleware,
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
  validate({ params: expedienteIdParamsSchema, body: aprobarCondicionadoBody }),
  controller.aprobarCondicionado,
);

// POST /api/v1/expedientes/:id/generar-contrato — Para el flujo "estudio
// aprobado por el buró": el orchestrator ya no auto-genera, deja que el
// propietario decida los datos del contrato y lo dispare desde el panel.
router.post(
  '/:id/generar-contrato',
  authMiddleware,
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
  validate({ params: expedienteIdParamsSchema, body: datosContratoBody }),
  controller.generarContratoExpediente,
);

export default router;

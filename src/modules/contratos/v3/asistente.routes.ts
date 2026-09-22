import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { uploadPdf } from '@/middleware/upload';
import { expedienteIdParamsSchema } from '../contratos.schema';
import { autorizarExcesoSchema, enviarSchema, guardarPasoSchema } from './asistente.schema';
import * as asistenteController from './asistente.controller';

// ============================================================
// Asistente de contratos V3: /api/v1/expedientes/:expedienteId/contrato-v3
// El service verifica el acceso al estudio (assertExpedienteAccess). Los
// miembros solo_lectura quedan fuera de PUT/POST por el middleware de auth.
// ============================================================

export const asistenteV3Router = Router({ mergeParams: true });
asistenteV3Router.use(authMiddleware);

// GET / — bloqueos, avisos, resumen y borrador (sin efectos).
asistenteV3Router.get(
  '/',
  roleGuard(['administrador', 'operador_analista', 'gerencia_consulta', 'inmobiliaria']),
  validate({ params: expedienteIdParamsSchema }),
  asistenteController.obtener,
);

// POST / — Iniciar: número, reserva del inmueble y aviso a los demás candidatos.
asistenteV3Router.post(
  '/',
  authorize('contratos', 'create'),
  validate({ params: expedienteIdParamsSchema }),
  asistenteController.iniciar,
);

// PUT /pasos — guarda un paso en el borrador.
asistenteV3Router.put(
  '/pasos',
  authorize('contratos', 'create'),
  validate({ params: expedienteIdParamsSchema, body: guardarPasoSchema }),
  asistenteController.guardarPaso,
);

// POST /generar — vista previa en modo revisión.
asistenteV3Router.post(
  '/generar',
  authorize('contratos', 'create'),
  validate({ params: expedienteIdParamsSchema }),
  asistenteController.generar,
);

// POST /clausulas/autorizar-exceso — un administrador autoriza el conjunto exacto
// de adicionales que supera el máximo (Entrega 4, D6).
asistenteV3Router.post(
  '/clausulas/autorizar-exceso',
  roleGuard(['administrador']),
  validate({ params: expedienteIdParamsSchema, body: autorizarExcesoSchema }),
  asistenteController.autorizarExceso,
);

// ── Entrega 5: Ruta B y firma ──

// POST /propio — Ruta B: carga (o reemplaza) el contrato propio de la inmobiliaria (multipart "archivo").
asistenteV3Router.post(
  '/propio',
  authorize('contratos', 'create'),
  validate({ params: expedienteIdParamsSchema }),
  uploadPdf,
  asistenteController.cargarPropio,
);

// GET /propio — URL firmada del contrato propio (1 h), en cualquier estado.
asistenteV3Router.get(
  '/propio',
  roleGuard(['administrador', 'operador_analista', 'gerencia_consulta', 'inmobiliaria']),
  validate({ params: expedienteIdParamsSchema }),
  asistenteController.propioUrl,
);

// GET /crc — URL firmada del CRC que se envió a firma (null en borrador).
asistenteV3Router.get(
  '/crc',
  roleGuard(['administrador', 'operador_analista', 'gerencia_consulta', 'inmobiliaria']),
  validate({ params: expedienteIdParamsSchema }),
  asistenteController.crcUrl,
);

// POST /enviar — saca el contrato de borrador y lo manda a Auco (V3 §8.7.5, §10).
asistenteV3Router.post(
  '/enviar',
  authorize('contratos', 'create'),
  validate({ params: expedienteIdParamsSchema, body: enviarSchema }),
  asistenteController.enviar,
);

// POST /reenviar — nuevo proceso de firma desde FIRMA INCOMPLETA (V3 §11.7.5).
asistenteV3Router.post(
  '/reenviar',
  authorize('contratos', 'create'),
  validate({ params: expedienteIdParamsSchema }),
  asistenteController.reenviar,
);

// POST /firma/reintentar — EN FIRMA sin sobre: vuelve a crear el proceso en Auco.
asistenteV3Router.post(
  '/firma/reintentar',
  authorize('contratos', 'create'),
  validate({ params: expedienteIdParamsSchema }),
  asistenteController.reintentar,
);

// POST /firma/actualizar — pregunta a Auco el estado ya (sin esperar el webhook).
asistenteV3Router.post(
  '/firma/actualizar',
  roleGuard(['administrador', 'operador_analista', 'inmobiliaria']),
  validate({ params: expedienteIdParamsSchema }),
  asistenteController.actualizarFirma,
);

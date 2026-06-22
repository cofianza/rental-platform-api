import { Router } from 'express';
import { authMiddleware, roleGuard, authorize } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { otpLimiter, otpVerifyLimiter } from '@/middleware/rateLimiter';
import {
  crearSolicitudFirmaSchema,
  solicitudIdParamsSchema,
  contratoIdParamsSchema,
  tokenParamsSchema,
  otpVerificarSchema,
  completarFirmaSchema,
  reenviarFirmaSchema,
} from './firma.schema';
import * as firmaController from './firma.controller';

// ============================================================
// Authenticated routes: /api/v1/firma/solicitudes
// ============================================================

export const firmaRouter = Router();
firmaRouter.use(authMiddleware);

// POST / — Create solicitud and send link.
// inmobiliaria/propietario pueden enviar a firma sus propios contratos (igual
// que el botón coral "Enviar a firma" del workflow). El bloqueo de solo_lectura
// se aplica en el chokepoint de auth (viewers no mutan). El scoping por
// pertenencia del contrato es backlog (ver pendiente-scoping-idor).
firmaRouter.post(
  '/',
  roleGuard(['administrador', 'operador_analista', 'inmobiliaria', 'propietario']),
  validate({ body: crearSolicitudFirmaSchema }),
  firmaController.crear,
);

// GET /:id — Get solicitud detail
firmaRouter.get(
  '/:id',
  authorize('contratos', 'read'),
  validate({ params: solicitudIdParamsSchema }),
  firmaController.getById,
);

// POST /:id/reenviar — Resend link (new token). Acepta body opcional
// { email_alternativo } para redirigir el correo a otra direccion.
firmaRouter.post(
  '/:id/reenviar',
  roleGuard(['administrador', 'operador_analista', 'inmobiliaria', 'propietario']),
  validate({ params: solicitudIdParamsSchema, body: reenviarFirmaSchema }),
  firmaController.reenviar,
);

// POST /:id/reenviar-self — El solicitante dueno del expediente puede
// reenviarse el correo de firma (al mismo o a otra direccion). El service
// valida pertenencia.
firmaRouter.post(
  '/:id/reenviar-self',
  roleGuard(['solicitante']),
  validate({ params: solicitudIdParamsSchema, body: reenviarFirmaSchema }),
  firmaController.reenviarSelf,
);

// POST /:id/cancelar — Cancel solicitud (inmobiliaria/propietario sobre sus
// propios contratos; viewers bloqueados en el chokepoint de auth).
firmaRouter.post(
  '/:id/cancelar',
  roleGuard(['administrador', 'operador_analista', 'inmobiliaria', 'propietario']),
  validate({ params: solicitudIdParamsSchema }),
  firmaController.cancelar,
);

// GET /:id/evidencia — Get firma evidence (admin, operador, gerencia)
firmaRouter.get(
  '/:id/evidencia',
  authorize('contratos', 'read'),
  validate({ params: solicitudIdParamsSchema }),
  firmaController.getEvidencia,
);

// GET /:id/evidencia/pdf — Download acuse PDF (admin, operador)
firmaRouter.get(
  '/:id/evidencia/pdf',
  roleGuard(['administrador', 'operador_analista']),
  validate({ params: solicitudIdParamsSchema }),
  firmaController.downloadAcuse,
);

// ============================================================
// Contract-scoped routes: /api/v1/contratos/:contratoId/firma/solicitudes
// ============================================================

export const contratoFirmaSolicitudesRouter = Router({ mergeParams: true });
contratoFirmaSolicitudesRouter.use(authMiddleware);

// GET / — List solicitudes for contrato
contratoFirmaSolicitudesRouter.get(
  '/',
  authorize('contratos', 'read'),
  validate({ params: contratoIdParamsSchema }),
  firmaController.listarPorContrato,
);

// ── Router: /api/v1/contratos/:contratoId/firma/firmantes ──────
// Firmantes multi-parte (arrendatario/arrendador/cofianza) del contrato.
export const contratoFirmantesRouter = Router({ mergeParams: true });
contratoFirmantesRouter.use(authMiddleware);
contratoFirmantesRouter.get(
  '/',
  authorize('contratos', 'read'),
  validate({ params: contratoIdParamsSchema }),
  firmaController.listarFirmantes,
);

// ============================================================
// Public routes: /api/v1/public/firma
// ============================================================

export const publicFirmaRouter = Router();

// GET /:token — Validate token and get info (public, no auth)
publicFirmaRouter.get(
  '/:token',
  validate({ params: tokenParamsSchema }),
  firmaController.validarToken,
);

// GET /:token/pdf — Get signed URL for contract PDF (HP-342, read-only)
publicFirmaRouter.get(
  '/:token/pdf',
  validate({ params: tokenParamsSchema }),
  firmaController.getContratoPdf,
);

// POST /:token/otp/solicitar — Request OTP code (public, rate-limited)
publicFirmaRouter.post(
  '/:token/otp/solicitar',
  otpLimiter,
  validate({ params: tokenParamsSchema }),
  firmaController.solicitarOtp,
);

// POST /:token/otp/verificar — Verify OTP code (public, rate-limited)
publicFirmaRouter.post(
  '/:token/otp/verificar',
  otpVerifyLimiter,
  validate({ params: tokenParamsSchema, body: otpVerificarSchema }),
  firmaController.verificarOtp,
);

// POST /:token/completar — Complete signature with evidence (public, rate-limited)
publicFirmaRouter.post(
  '/:token/completar',
  otpVerifyLimiter,
  validate({ params: tokenParamsSchema, body: completarFirmaSchema }),
  firmaController.completarFirma,
);

// ============================================================
// Cron route: /api/v1/cron/firma/expirar
// ============================================================

export const firmaCronRouter = Router();

// POST / — Bulk expire solicitudes with expired tokens (protected by CRON_SECRET)
firmaCronRouter.post('/', (req, res, next) => {
  const secret = req.headers['x-cron-secret'] || req.headers.authorization;
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  next();
}, firmaController.expirarCron);

// ============================================================
// Auco webhook: /api/v1/webhooks/auco/firma
// ============================================================

export const aucoWebhookRouter = Router();

// POST / — Receive Auco signature status notifications (no auth — validated via secret)
aucoWebhookRouter.post('/', firmaController.aucoWebhook);

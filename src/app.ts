import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from '@/config';
import { logger } from '@/lib/logger';
import { errorHandler } from '@/middleware/errorHandler';
import { generalLimiter } from '@/middleware/rateLimiter';
import healthRouter from '@/modules/health/health.routes';
import authRouter from '@/modules/auth/auth.routes';
import expedientesRouter from '@/modules/expedientes/expedientes.routes';
import expedienteWorkflowRouter from '@/modules/expedientes/expediente-workflow.routes';
import expedienteCommentsRouter from '@/modules/expedientes/expediente-comments.routes';
import expedienteTimelineRouter from '@/modules/expedientes/expediente-timeline.routes';
import expedienteAssignmentsRouter from '@/modules/expedientes/expediente-assignments.routes';
import expedienteHabilitacionRouter from '@/modules/expedientes/expediente-habilitacion.routes';
import expedienteSoportesRouter, { publicCargarDocumentosRouter } from '@/modules/expedientes/expediente-soportes.routes';
import {
  expedienteCoarrendatariosRouter,
  publicCoarrendatarioRouter,
} from '@/modules/coarrendatarios/coarrendatarios.routes';
import usersRouter from '@/modules/users/users.routes';
import perfilArrendadorRouter from '@/modules/perfil-arrendador/perfil-arrendador.routes';
import registrationRouter from '@/modules/registration/registration.routes';
import { bitacoraRouter } from '@/modules/bitacora/bitacora.routes';
import inmueblesRouter from '@/modules/inmuebles/inmuebles.routes';
import applicantsRouter from '@/modules/solicitantes/solicitantes.routes';
import documentosRouter from '@/modules/documentos/documentos.routes';
import expedienteDocumentosRouter from '@/modules/documentos/expediente-documentos.routes';
import tiposDocumentoRouter from '@/modules/documentos/tipos-documento.routes';
import adminTiposDocumentoRouter from '@/modules/documentos/admin-tipos-documento.routes';
import { expedienteEstudiosRouter, estudiosRouter, publicEstudiosRouter, proveedoresRiesgoRouter, publicVerificarRouter, inmuebleEstudiosRouter } from '@/modules/estudios/estudios.routes';
import { expedienteAutorizacionRouter, publicAutorizacionRouter } from '@/modules/autorizaciones/autorizaciones.routes';
import plantillasRouter from '@/modules/plantillas/plantillas.routes';
import { expedienteContratosRouter, contratosRouter, inmuebleContratoPreviewRouter } from '@/modules/contratos/contratos.routes';
import contratoWorkflowRouter from '@/modules/contratos/contrato-workflow.routes';
import contratoFirmadoRouter from '@/modules/contratos/contrato-firmado.routes';
import contratoArchivosRouter from '@/modules/contratos/contrato-archivos.routes';
import { firmaRouter, contratoFirmaSolicitudesRouter, contratoFirmantesRouter, publicFirmaRouter, aucoWebhookRouter, firmaCronRouter } from '@/modules/firma/firma.routes';
import { expedientePagosRouter, pagosRouter, pagosWebhookRouter, devWebhookRouter } from '@/modules/pagos/pagos.routes';
import { pagoEstudioRouter, publicPagoResultadoRouter } from '@/modules/pago-estudio/pago-estudio.routes';
import dashboardRouter from '@/modules/dashboard/dashboard.routes';
import reportesRouter from '@/modules/reportes/reportes.routes';
// TEMPORAL (Mario 7-may-2026): herramienta de QA "Borrar datos de prueba".
// Eliminar antes de produccion junto con la migracion 20260507000005.
import adminToolsRouter from '@/modules/admin-tools/admin-tools.routes';
import documentosLegalesRouter from '@/modules/documentos-legales/documentos-legales.routes';
import whatsappRouter from '@/modules/whatsapp/whatsapp.routes';
import morasRouter, { morasCronRouter } from '@/modules/moras/moras.routes';
import { publicPropertiesRouter } from '@/modules/inmuebles/public-properties.routes';
import { vitrinaRouter } from '@/modules/vitrina/vitrina.routes';
import exportRouter from '@/modules/export/export.routes';
import citasRouter from '@/modules/citas/citas.routes';
import { publicVisitaRouter } from '@/modules/citas/citas-publico.routes';
import expedienteExternoRouter from '@/modules/expedientes/expediente-externo.routes';
import { publicInvitacionRouter } from '@/modules/invitacion/invitacion.routes';
import { miembrosRouter, publicInvitacionMiembroRouter, adminInmobiliariasRouter } from '@/modules/inmobiliaria-miembros/inmobiliaria-miembros.routes';
import { empresaRouter } from '@/modules/empresa/empresa.routes';
import disponibilidadRouter from '@/modules/disponibilidad/disponibilidad.routes';
import { facturasRouter, pagoFacturarRouter, factusHelpersRouter, factusPublicHelpersRouter } from '@/modules/facturacion/facturacion.routes';
import { creditosEstudiosRouter, expedienteLiberarRouter, adminPaquetesRouter } from '@/modules/creditos-estudios/creditos-estudios.routes';
import notificacionesRouter from '@/modules/notificaciones/notificaciones.routes';
import soporteRouter from '@/modules/soporte/soporte.routes';

const app = express();

// Trust proxy: Railway pone el request detras de su edge y añade
// X-Forwarded-For. Confiar en 1 hop le permite a express-rate-limit
// identificar al cliente real sin emitir el warning "ERR_ERL_UNEXPECTED_X_FORWARDED_FOR".
app.set('trust proxy', 1);

// Security
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  }),
);

// Rate limiting
app.use(generalLimiter);

// Logging with request ID tracing
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => {
      const existing = req.headers['x-request-id'];
      return typeof existing === 'string' ? existing : crypto.randomUUID();
    },
  }),
);

// Payment webhook needs raw body BEFORE json parser (HMAC signature verification)
app.use('/api/v1/webhooks/pagos', pagosWebhookRouter);

// Body parsing
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/auth/register', registrationRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/expedientes', expedientesRouter);
app.use('/api/v1/expedientes', expedienteWorkflowRouter);
app.use('/api/v1/expedientes', expedienteCommentsRouter);
app.use('/api/v1/expedientes', expedienteTimelineRouter);
app.use('/api/v1/expedientes', expedienteAssignmentsRouter);
app.use('/api/v1/expedientes', expedienteHabilitacionRouter);
app.use('/api/v1/expedientes', expedienteSoportesRouter);
app.use('/api/v1/public/cargar-documentos', publicCargarDocumentosRouter);
app.use('/api/v1/expedientes', expedienteCoarrendatariosRouter);
app.use('/api/v1/public/coarrendatario', publicCoarrendatarioRouter);
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/perfil-arrendador', perfilArrendadorRouter);
app.use('/api/v1/inmuebles', inmueblesRouter);
app.use('/api/v1/audit-logs', bitacoraRouter);
app.use('/api/v1/applicants', applicantsRouter);
app.use('/api/v1/documentos', documentosRouter);
app.use('/api/v1/expedientes', expedienteDocumentosRouter);
app.use('/api/v1/tipos-documento', tiposDocumentoRouter);
app.use('/api/v1/admin/tipos-documento', adminTiposDocumentoRouter);
app.use('/api/v1/expedientes/:expedienteId/estudios', expedienteEstudiosRouter);
app.use('/api/v1/estudios', estudiosRouter);
app.use('/api/v1/public/estudios', publicEstudiosRouter);
app.use('/api/v1/public/verificar', publicVerificarRouter);
app.use('/api/v1/proveedores-riesgo', proveedoresRiesgoRouter);
app.use('/api/v1/inmuebles/:inmuebleId/estudios', inmuebleEstudiosRouter);
app.use('/api/v1/expedientes/:expedienteId/autorizacion-riesgo', expedienteAutorizacionRouter);
app.use('/api/v1/public/autorizar', publicAutorizacionRouter);
app.use('/api/v1/public/invitacion', publicInvitacionRouter);
app.use('/api/v1/inmobiliaria/miembros', miembrosRouter);
app.use('/api/v1/public/invitacion-miembro', publicInvitacionMiembroRouter);
app.use('/api/v1/admin/inmobiliarias', adminInmobiliariasRouter);
app.use('/api/v1/empresa', empresaRouter);
app.use('/api/v1/plantillas-contrato', plantillasRouter);
app.use('/api/v1/expedientes/:expedienteId/contratos', expedienteContratosRouter);
app.use('/api/v1/inmuebles/:inmuebleId', inmuebleContratoPreviewRouter);
app.use('/api/v1/contratos', contratoWorkflowRouter);
app.use('/api/v1/contratos', contratoFirmadoRouter);
app.use('/api/v1/contratos', contratoArchivosRouter);
app.use('/api/v1/contratos', contratosRouter);
app.use('/api/v1/firma/solicitudes', firmaRouter);
app.use('/api/v1/contratos/:contratoId/firma/solicitudes', contratoFirmaSolicitudesRouter);
app.use('/api/v1/contratos/:contratoId/firma/firmantes', contratoFirmantesRouter);
app.use('/api/v1/public/firma', publicFirmaRouter);
app.use('/api/v1/webhooks/auco/firma', aucoWebhookRouter);
app.use('/api/v1/cron/firma/expirar', firmaCronRouter);
app.use('/api/v1/expedientes/:expedienteId/pagos', expedientePagosRouter);
app.use('/api/v1/expedientes/:expedienteId/pago-estudio', pagoEstudioRouter);
app.use('/api/v1/pagos', pagosRouter);
app.use('/api/v1/publico/pago-resultado', publicPagoResultadoRouter);
app.use('/api/v1/dev/webhooks/pagos', devWebhookRouter);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/api/v1/reportes', reportesRouter);
app.use('/api/v1/admin-tools', adminToolsRouter);
app.use('/api/v1/public/properties', publicPropertiesRouter);
app.use('/api/v1/vitrina', vitrinaRouter);
app.use('/api/v1/export', exportRouter);
app.use('/api/v1/citas', citasRouter);
app.use('/api/v1/public/visita', publicVisitaRouter);
app.use('/api/v1/disponibilidad', disponibilidadRouter);
app.use('/api/v1/expedientes', expedienteExternoRouter);

// Facturación electrónica (Factus / DIAN)
app.use('/api/v1/facturas', facturasRouter);
app.use('/api/v1/pagos', pagoFacturarRouter); // POST /pagos/:pagoId/facturar
app.use('/api/v1/factus', factusHelpersRouter); // /factus/municipalities (auth)
app.use('/api/v1/public/factus', factusPublicHelpersRouter); // /public/factus/municipalities (sin auth, para wizard registro)

// Creditos de estudios (paquetes pre-comprados por inmobiliarias)
app.use('/api/v1/creditos-estudios', creditosEstudiosRouter);
app.use('/api/v1/expedientes/:expedienteId/liberar-estudio-credito', expedienteLiberarRouter);
app.use('/api/v1/admin/paquetes-creditos-estudios', adminPaquetesRouter);

// Notificaciones in-app (Realtime via Supabase)
app.use('/api/v1/notificaciones', notificacionesRouter);

// Soporte — tickets funcionales (separados de moras_tickets).
app.use('/api/v1/soporte', soporteRouter);

// Documentos legales de la inmobiliaria/propietario (camara comercio,
// RUT, matricula, cedula RL, poder, poliza, contrato marco).
app.use('/api/v1/documentos-legales', documentosLegalesRouter);

// WhatsApp (Meta Business Cloud) — provider mock por ahora, integracion
// real pendiente. (Mario 12-may-2026)
app.use('/api/v1/whatsapp', whatsappRouter);

// Reportar Mora — modulo de 3 fases (Mario 12-may-2026, mockup 13_*propietario.html).
app.use('/api/v1/moras', morasRouter);
app.use('/api/v1/cron/moras', morasCronRouter);

// Error handler (must be last)
app.use(errorHandler);

export default app;

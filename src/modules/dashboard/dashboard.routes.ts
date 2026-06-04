// ============================================================
// Dashboard — Routes (HP-358)
// ============================================================

import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { dashboardQuerySchema, perfilIdParamsSchema, updateTesoreriaSchema } from './dashboard.schema';
import * as controller from './dashboard.controller';

const router = Router();

// Todas las rutas de dashboard requieren auth
router.use(authMiddleware);

// Portfolio stats — disponible para propietario/inmobiliaria (su propio
// portafolio) y admin/operador (con su propio user.id como propietario, lo
// que da 0 a menos que el admin sea tambien propietario; el caso de admin
// viendo portfolio ajeno no aplica al hero del dashboard).
router.get(
  '/portfolio-stats',
  roleGuard(['propietario', 'inmobiliaria', 'administrador', 'operador_analista']),
  controller.getPortfolioStats,
);

// Mis Inmuebles del propietario (tarjetas con inquilino/contrato/pago).
// Disponible para propietario/inmobiliaria (su propio portafolio).
router.get(
  '/mis-inmuebles',
  roleGuard(['propietario', 'inmobiliaria', 'administrador', 'operador_analista']),
  controller.getMisInmuebles,
);

// Pagos a Cofianza — comisión por contrato del aliado (inmobiliaria).
router.get(
  '/mis-pagos-cofianza',
  roleGuard(['inmobiliaria', 'administrador', 'operador_analista']),
  controller.getMisPagosCofianza,
);

// Analítica de cartera del aliado (inmobiliaria).
router.get(
  '/mi-cartera-analitica',
  roleGuard(['inmobiliaria', 'administrador', 'operador_analista']),
  controller.getMiCarteraAnalitica,
);

// Resto: solo roles con permiso dashboard:read (admin/operador/gerencia)
router.use(authorize('dashboard', 'read'));

router.get(
  '/summary',
  validate({ query: dashboardQuerySchema }),
  controller.getSummary,
);

router.get(
  '/expedientes-por-estado',
  validate({ query: dashboardQuerySchema }),
  controller.getExpedientesPorEstado,
);

// Centro de Control (admin) — vista agregada del mockup
// htmls/15_COFIANZA_Dashboard_Interno_v2.html. Solo administrador.
router.get(
  '/admin/overview',
  roleGuard(['administrador']),
  controller.getAdminOverview,
);

// Tesorería — capital disponible / reserva mínima (alimenta "Capital libre").
// Solo administrador. GET para precargar el form, PUT para guardar.
router.get(
  '/admin/tesoreria',
  roleGuard(['administrador']),
  controller.getTesoreria,
);

router.put(
  '/admin/tesoreria',
  roleGuard(['administrador']),
  validate({ body: updateTesoreriaSchema }),
  controller.updateTesoreria,
);

// Secciones del Centro de Control (admin). Solo administrador.
router.get('/admin/inmobiliarias', roleGuard(['administrador']), controller.getInmobiliarias);
router.get('/admin/propietarios', roleGuard(['administrador']), controller.getPropietarios);
router.get('/admin/inquilinos', roleGuard(['administrador']), controller.getInquilinos);
router.get('/admin/contratos', roleGuard(['administrador']), controller.getContratos);
router.get('/admin/vitrina', roleGuard(['administrador']), controller.getVitrina);
router.get('/admin/ingresos', roleGuard(['administrador']), controller.getIngresos);
router.get(
  '/admin/perfiles/:id/detalle',
  roleGuard(['administrador']),
  validate({ params: perfilIdParamsSchema }),
  controller.getPerfilDetalle,
);

export default router;

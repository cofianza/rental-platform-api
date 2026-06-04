// ============================================================
// Dashboard — Controller (HP-358)
// ============================================================

import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import * as dashboardService from './dashboard.service';
import * as seccionesService from './dashboard-secciones.service';
import type { DashboardQuery, UpdateTesoreriaInput } from './dashboard.schema';

const CACHE_CONTROL_HEADER = 'public, max-age=300'; // 5 minutes

export async function getSummary(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: DashboardQuery }).validatedQuery || req.query;
  const { dateFrom, dateTo } = query as DashboardQuery;

  const summary = await dashboardService.getSummary(dateFrom, dateTo);

  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, summary);
}

export async function getExpedientesPorEstado(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: DashboardQuery }).validatedQuery || req.query;
  const { dateFrom, dateTo } = query as DashboardQuery;

  const data = await dashboardService.getExpedientesPorEstado(dateFrom, dateTo);

  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}

// Portfolio stats para el hero "Tu Oficina Virtual" — propietario/inmobiliaria.
// No cachea: cada usuario tiene su propio portafolio.
export async function getPortfolioStats(req: Request, res: Response) {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Autenticacion requerida' });
    return;
  }
  const stats = await dashboardService.getPortfolioStats(req.user.id);
  sendSuccess(res, stats);
}

// Mis Inmuebles (propietario) — tarjetas con inquilino/contrato/pago.
// No cachea: cada propietario tiene su propio portafolio.
export async function getMisInmuebles(req: Request, res: Response) {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Autenticacion requerida' });
    return;
  }
  const data = await dashboardService.getMisInmuebles(req.user.id);
  sendSuccess(res, data);
}

// Pagos a Cofianza (inmobiliaria) — comisión por contrato del propio aliado.
export async function getMisPagosCofianza(req: Request, res: Response) {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Autenticacion requerida' });
    return;
  }
  const data = await dashboardService.getMisPagosCofianza(req.user.id);
  sendSuccess(res, data);
}

// Analítica de cartera (inmobiliaria) — salud + desempeño de estudios.
export async function getMiCarteraAnalitica(req: Request, res: Response) {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Autenticacion requerida' });
    return;
  }
  const data = await dashboardService.getMiCarteraAnalitica(req.user.id);
  sendSuccess(res, data);
}

// Admin Overview — Centro de Control (mockup htmls/15_*).
// Endpoint pesado: aggrega contratos + moras + bitácora + config + counts.
// El service cachea 5min.
export async function getAdminOverview(_req: Request, res: Response) {
  const overview = await dashboardService.getAdminOverview();
  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, overview);
}

// Tesorería — leer config de capital (admin).
export async function getTesoreria(_req: Request, res: Response) {
  const tesoreria = await dashboardService.getTesoreria();
  sendSuccess(res, tesoreria);
}

// Tesorería — actualizar capital disponible y reserva mínima (admin).
export async function updateTesoreria(req: Request, res: Response) {
  const body = req.body as UpdateTesoreriaInput;
  const tesoreria = await dashboardService.updateTesoreria(body);
  sendSuccess(res, tesoreria);
}

// ── Secciones del Centro de Control (admin) ─────────────────

export async function getInmobiliarias(_req: Request, res: Response) {
  const data = await seccionesService.listInmobiliarias();
  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}

export async function getPropietarios(_req: Request, res: Response) {
  const data = await seccionesService.listPropietarios();
  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}

export async function getInquilinos(_req: Request, res: Response) {
  const data = await seccionesService.listInquilinos();
  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}

export async function getContratos(_req: Request, res: Response) {
  const data = await seccionesService.listContratosAdmin();
  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}

export async function getVitrina(_req: Request, res: Response) {
  const data = await seccionesService.getVitrinaAdmin();
  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}

export async function getIngresos(_req: Request, res: Response) {
  const data = await seccionesService.getIngresosAdmin();
  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}

// Detalle 360° de un aliado (inmobiliaria/propietario) + su cartera.
export async function getPerfilDetalle(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const data = await seccionesService.getPerfilDetalle(id);
  sendSuccess(res, data);
}

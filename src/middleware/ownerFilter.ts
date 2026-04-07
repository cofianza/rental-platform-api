// ============================================================
// Owner Filter Middleware
// Automatically filters data for propietario/inmobiliaria users
// Injects propietario_id into query params so they only see their data
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

/**
 * For propietario users: adds propietario_id filter to queries
 * This ensures they only see inmuebles they own and related expedientes/contratos
 */
export async function ownerFilterMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next();

  const { rol, id: userId } = req.user;

  if (rol === 'propietario') {
    // Inject propietario filter — the user IS the propietario
    (req as Request & { ownerFilter: { propietarioId: string; inmuebleIds: string[] } }).ownerFilter = {
      propietarioId: userId,
      inmuebleIds: [],
    };

    // Pre-fetch inmueble IDs owned by this user for expediente/contrato filtering
    const { data: inmuebles } = await supabase
      .from('inmuebles')
      .select('id')
      .eq('propietario_id', userId);

    if (inmuebles) {
      (req as Request & { ownerFilter: { propietarioId: string; inmuebleIds: string[] } }).ownerFilter.inmuebleIds =
        inmuebles.map((i: { id: string }) => i.id);
    }
  }

  next();
}

/**
 * Helper: get owner filter from request (if exists)
 */
export function getOwnerFilter(req: Request): { propietarioId: string; inmuebleIds: string[] } | null {
  return (req as Request & { ownerFilter?: { propietarioId: string; inmuebleIds: string[] } }).ownerFilter ?? null;
}

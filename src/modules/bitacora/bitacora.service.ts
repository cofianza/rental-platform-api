import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { ListAuditLogsQuery } from './bitacora.schema';

interface AuditLogRow {
  id: string;
  usuario_id: string | null;
  accion: string;
  entidad: string;
  entidad_id: string | null;
  detalle: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
  perfiles: { nombre: string; apellido: string } | null;
}

interface AuditLogResponse {
  id: string;
  usuario_id: string | null;
  usuario_nombre: string | null;
  accion: string;
  entidad: string;
  entidad_id: string | null;
  detalle: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}

function mapRow(row: AuditLogRow): AuditLogResponse {
  const perfil = row.perfiles;
  return {
    id: row.id,
    usuario_id: row.usuario_id,
    usuario_nombre: perfil
      ? `${perfil.nombre} ${perfil.apellido}`.trim()
      : null,
    accion: row.accion,
    entidad: row.entidad,
    entidad_id: row.entidad_id,
    detalle: row.detalle,
    ip: row.ip,
    created_at: row.created_at,
  };
}

export async function listAuditLogs(query: ListAuditLogsQuery) {
  const { page, limit, userId, action, entityType, dateFrom, dateTo, sortOrder } = query;
  const offset = (page - 1) * limit;

  let qb = supabase
    .from('bitacora' as string)
    .select('id, usuario_id, accion, entidad, entidad_id, detalle, ip, created_at, perfiles!bitacora_usuario_id_fkey(nombre, apellido)', { count: 'exact' })
    .order('created_at', { ascending: sortOrder === 'asc' })
    .range(offset, offset + limit - 1);

  if (userId) {
    qb = qb.eq('usuario_id', userId);
  }
  if (action) {
    qb = qb.eq('accion', action);
  }
  if (entityType) {
    qb = qb.eq('entidad', entityType);
  }
  if (dateFrom) {
    qb = qb.gte('created_at', dateFrom);
  }
  if (dateTo) {
    qb = qb.lte('created_at', dateTo);
  }

  const { data, error, count } = await qb;

  if (error) {
    logger.error({ error: error.message }, 'Error al listar bitacora');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener la bitacora');
  }

  const rows = (data as unknown as AuditLogRow[]) || [];
  const total = count ?? 0;

  return {
    logs: rows.map(mapRow),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getAuditLogById(id: string) {
  const { data, error } = await supabase
    .from('bitacora' as string)
    .select('id, usuario_id, accion, entidad, entidad_id, detalle, ip, created_at, perfiles!bitacora_usuario_id_fkey(nombre, apellido)')
    .eq('id', id)
    .single();

  if (error || !data) {
    throw AppError.notFound('Registro de bitacora no encontrado');
  }

  return mapRow(data as unknown as AuditLogRow);
}

export async function getAuditStats() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Conteo por accion (ultimos 30 dias)
  const { data: actionData, error: actionError } = await supabase
    .from('bitacora' as string)
    .select('accion')
    .gte('created_at', thirtyDaysAgo);

  if (actionError) {
    logger.error({ error: actionError.message }, 'Error al obtener stats de bitacora');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener estadisticas');
  }

  const actionCounts: Record<string, number> = {};
  for (const row of (actionData as { accion: string }[]) || []) {
    actionCounts[row.accion] = (actionCounts[row.accion] || 0) + 1;
  }

  const byAction = Object.entries(actionCounts)
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count);

  // Conteo por dia (ultimos 7 dias)
  const { data: dayData, error: dayError } = await supabase
    .from('bitacora' as string)
    .select('created_at')
    .gte('created_at', sevenDaysAgo);

  if (dayError) {
    logger.error({ error: dayError.message }, 'Error al obtener stats diarios de bitacora');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener estadisticas');
  }

  const dayCounts: Record<string, number> = {};
  for (const row of (dayData as { created_at: string }[]) || []) {
    const date = row.created_at.slice(0, 10);
    dayCounts[date] = (dayCounts[date] || 0) + 1;
  }

  const byDay = Object.entries(dayCounts)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Total general
  const { count: total, error: totalError } = await supabase
    .from('bitacora' as string)
    .select('id', { count: 'exact', head: true });

  if (totalError) {
    logger.error({ error: totalError.message }, 'Error al obtener total de bitacora');
  }

  return {
    byAction,
    byDay,
    total: total ?? 0,
  };
}

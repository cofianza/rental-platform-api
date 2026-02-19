import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getFieldLabel } from './inmuebles.field-labels';
import type { ListCambiosQuery } from './inmuebles.schema';

interface CambioRow {
  id: string;
  inmueble_id: string;
  usuario_id: string;
  campo: string;
  valor_anterior: string | null;
  valor_nuevo: string | null;
  created_at: string;
  perfiles: { nombre: string; apellido: string } | null;
}

interface CambioResponse {
  id: string;
  inmueble_id: string;
  usuario_id: string;
  usuario_nombre: string | null;
  campo: string;
  campo_label: string;
  valor_anterior: string | null;
  valor_nuevo: string | null;
  created_at: string;
}

function mapCambioRow(row: CambioRow): CambioResponse {
  const perfil = row.perfiles;
  return {
    id: row.id,
    inmueble_id: row.inmueble_id,
    usuario_id: row.usuario_id,
    usuario_nombre: perfil ? `${perfil.nombre} ${perfil.apellido}`.trim() : null,
    campo: row.campo,
    campo_label: getFieldLabel(row.campo),
    valor_anterior: row.valor_anterior,
    valor_nuevo: row.valor_nuevo,
    created_at: row.created_at,
  };
}

export async function listCambios(inmuebleId: string, query: ListCambiosQuery) {
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 20;
  const sortOrder = query.sortOrder || 'desc';
  const offset = (page - 1) * limit;

  // Verificar que el inmueble exista
  const { data: inmueble, error: inmError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', inmuebleId)
    .single();

  if (inmError || !inmueble) {
    throw AppError.notFound('Inmueble no encontrado');
  }

  let qb = (supabase
    .from('cambios_inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, inmueble_id, usuario_id, campo, valor_anterior, valor_nuevo, created_at, perfiles!cambios_inmuebles_usuario_id_fkey(nombre, apellido)',
      { count: 'exact' },
    )
    .eq('inmueble_id', inmuebleId)
    .order('created_at', { ascending: sortOrder === 'asc' })
    .range(offset, offset + limit - 1);

  if (query.campo) qb = qb.eq('campo', query.campo);
  if (query.usuario_id) qb = qb.eq('usuario_id', query.usuario_id);
  if (query.date_from) qb = qb.gte('created_at', query.date_from);
  if (query.date_to) qb = qb.lte('created_at', query.date_to);

  const { data, error, count } = await qb;

  if (error) {
    logger.error({ error: error.message, code: error.code, details: error.details, hint: error.hint, inmuebleId }, 'Error al listar cambios de inmueble');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el historial de cambios');
  }

  const rows = (data as unknown as CambioRow[]) || [];
  const total = count ?? 0;

  return {
    cambios: rows.map(mapCambioRow),
    pagination: {
      total,
      page,
      size: limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getCambiosResumen(inmuebleId: string) {
  // Verificar que el inmueble exista
  const { data: inmueble, error: inmError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', inmuebleId)
    .single();

  if (inmError || !inmueble) {
    throw AppError.notFound('Inmueble no encontrado');
  }

  // Total de cambios
  const { count: totalCambios, error: countError } = await (supabase
    .from('cambios_inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .eq('inmueble_id', inmuebleId);

  if (countError) {
    logger.error({ error: countError.message, inmuebleId }, 'Error al contar cambios');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener resumen de cambios');
  }

  // Ultimo cambio
  const { data: lastChangeData, error: lastError } = await (supabase
    .from('cambios_inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, inmueble_id, usuario_id, campo, valor_anterior, valor_nuevo, created_at, perfiles!cambios_inmuebles_usuario_id_fkey(nombre, apellido)',
    )
    .eq('inmueble_id', inmuebleId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (lastError) {
    logger.error({ error: lastError.message, inmuebleId }, 'Error al obtener ultimo cambio');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener resumen de cambios');
  }

  const lastRows = (lastChangeData as unknown as CambioRow[]) || [];
  const ultimoCambio = lastRows.length > 0 ? mapCambioRow(lastRows[0]) : null;

  // Campos mas modificados
  const { data: campoData, error: campoError } = await (supabase
    .from('cambios_inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('campo')
    .eq('inmueble_id', inmuebleId);

  if (campoError) {
    logger.error({ error: campoError.message, inmuebleId }, 'Error al obtener campos modificados');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener resumen de cambios');
  }

  const campoCounts: Record<string, number> = {};
  for (const row of (campoData as { campo: string }[]) || []) {
    campoCounts[row.campo] = (campoCounts[row.campo] || 0) + 1;
  }

  const camposMasModificados = Object.entries(campoCounts)
    .map(([campo, count]) => ({
      campo,
      campo_label: getFieldLabel(campo),
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    total_cambios: totalCambios ?? 0,
    ultimo_cambio: ultimoCambio,
    campos_mas_modificados: camposMasModificados,
  };
}

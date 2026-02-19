/**
 * Servicio de fotos de inmuebles - HP-203
 */
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { FOTO_LIMITS } from './inmuebles-fotos.schema';
import type { CreateFotoInput, UpdateFotoInput } from './inmuebles-fotos.schema';

interface FotoRow {
  id: string;
  inmueble_id: string;
  url: string;
  url_thumbnail: string | null;
  descripcion: string | null;
  orden: number;
  es_fachada: boolean;
  tamaño_archivo: number | null;
  tipo_archivo: string | null;
  created_at: string;
}

const FOTO_FIELDS = `id, inmueble_id, url, url_thumbnail, descripcion, orden, es_fachada, tamaño_archivo, tipo_archivo, created_at`;

/**
 * Obtener todas las fotos de un inmueble
 */
export async function getFotosByInmuebleId(inmuebleId: string): Promise<FotoRow[]> {
  // Verificar que el inmueble existe
  const { data: inmueble, error: inmuebleError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', inmuebleId)
    .single();

  if (inmuebleError || !inmueble) {
    throw AppError.notFound('Inmueble no encontrado');
  }

  const { data, error } = await (supabase
    .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
    .select(FOTO_FIELDS)
    .eq('inmueble_id', inmuebleId)
    .order('orden', { ascending: true });

  if (error) {
    logger.error({ error: error.message, inmuebleId }, 'Error al obtener fotos del inmueble');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener las fotos del inmueble');
  }

  return (data as unknown as FotoRow[]) || [];
}

/**
 * Crear una nueva foto
 */
export async function createFoto(
  inmuebleId: string,
  input: CreateFotoInput,
  createdBy: string,
  ip?: string,
): Promise<FotoRow> {
  // Verificar que el inmueble existe
  const { data: inmueble, error: inmuebleError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', inmuebleId)
    .single();

  if (inmuebleError || !inmueble) {
    throw AppError.notFound('Inmueble no encontrado');
  }

  // Verificar límite de fotos
  const { count, error: countError } = await (supabase
    .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .eq('inmueble_id', inmuebleId);

  if (countError) {
    logger.error({ error: countError.message, inmuebleId }, 'Error al contar fotos');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar límite de fotos');
  }

  if ((count ?? 0) >= FOTO_LIMITS.MAX_FOTOS_PER_INMUEBLE) {
    throw AppError.badRequest(
      `El inmueble ya tiene el máximo de ${FOTO_LIMITS.MAX_FOTOS_PER_INMUEBLE} fotos`,
      'MAX_FOTOS_REACHED',
    );
  }

  // Si esta foto es fachada, quitar fachada de las otras
  if (input.es_fachada) {
    await (supabase
      .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
      .update({ es_fachada: false } as never)
      .eq('inmueble_id', inmuebleId)
      .eq('es_fachada', true);
  }

  // Calcular orden si no se proporciona
  let orden = input.orden;
  if (orden === 0) {
    const { data: lastFoto } = await (supabase
      .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
      .select('orden')
      .eq('inmueble_id', inmuebleId)
      .order('orden', { ascending: false })
      .limit(1)
      .single();

    orden = lastFoto ? (lastFoto as { orden: number }).orden + 1 : 0;
  }

  const { data, error } = await (supabase
    .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
    .insert({
      inmueble_id: inmuebleId,
      url: input.url,
      url_thumbnail: input.url_thumbnail || null,
      descripcion: input.descripcion || null,
      orden,
      es_fachada: input.es_fachada || false,
      tamaño_archivo: input.tamaño_archivo || null,
      tipo_archivo: input.tipo_archivo || null,
    } as never)
    .select(FOTO_FIELDS)
    .single();

  if (error) {
    logger.error({ error: error.message, inmuebleId }, 'Error al crear foto');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear la foto');
  }

  const foto = data as unknown as FotoRow;

  // Si es fachada, actualizar foto_fachada_url del inmueble
  if (input.es_fachada) {
    await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .update({ foto_fachada_url: input.url } as never)
      .eq('id', inmuebleId);
  }

  logAudit({
    usuarioId: createdBy,
    accion: AUDIT_ACTIONS.FOTO_CREATED,
    entidad: AUDIT_ENTITIES.FOTO_INMUEBLE,
    entidadId: foto.id,
    detalle: {
      inmueble_id: inmuebleId,
      es_fachada: input.es_fachada,
    },
    ip,
  });

  return foto;
}

/**
 * Actualizar una foto
 */
export async function updateFoto(
  inmuebleId: string,
  fotoId: string,
  input: UpdateFotoInput,
  updatedBy: string,
  ip?: string,
): Promise<FotoRow> {
  // Verificar que la foto existe y pertenece al inmueble
  const { data: existing, error: existingError } = await (supabase
    .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
    .select(FOTO_FIELDS)
    .eq('id', fotoId)
    .eq('inmueble_id', inmuebleId)
    .single();

  if (existingError || !existing) {
    throw AppError.notFound('Foto no encontrada');
  }

  // Si se establece como fachada, quitar fachada de las otras
  if (input.es_fachada) {
    await (supabase
      .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
      .update({ es_fachada: false } as never)
      .eq('inmueble_id', inmuebleId)
      .eq('es_fachada', true)
      .neq('id', fotoId);
  }

  // Construir datos de actualización
  const updateData: Record<string, unknown> = {};
  if (input.descripcion !== undefined) updateData.descripcion = input.descripcion;
  if (input.orden !== undefined) updateData.orden = input.orden;
  if (input.es_fachada !== undefined) updateData.es_fachada = input.es_fachada;

  if (Object.keys(updateData).length === 0) {
    return existing as unknown as FotoRow;
  }

  const { data, error } = await (supabase
    .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
    .update(updateData as never)
    .eq('id', fotoId)
    .select(FOTO_FIELDS)
    .single();

  if (error) {
    logger.error({ error: error.message, fotoId }, 'Error al actualizar foto');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al actualizar la foto');
  }

  const foto = data as unknown as FotoRow;

  // Si se establece como fachada, actualizar foto_fachada_url del inmueble
  if (input.es_fachada) {
    await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .update({ foto_fachada_url: foto.url } as never)
      .eq('id', inmuebleId);
  }

  logAudit({
    usuarioId: updatedBy,
    accion: AUDIT_ACTIONS.FOTO_UPDATED,
    entidad: AUDIT_ENTITIES.FOTO_INMUEBLE,
    entidadId: fotoId,
    detalle: {
      inmueble_id: inmuebleId,
      changes: updateData,
    },
    ip,
  });

  return foto;
}

/**
 * Eliminar una foto
 */
export async function deleteFoto(
  inmuebleId: string,
  fotoId: string,
  deletedBy: string,
  ip?: string,
): Promise<void> {
  // Verificar que la foto existe y pertenece al inmueble
  const { data: existing, error: existingError } = await (supabase
    .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
    .select(FOTO_FIELDS)
    .eq('id', fotoId)
    .eq('inmueble_id', inmuebleId)
    .single();

  if (existingError || !existing) {
    throw AppError.notFound('Foto no encontrada');
  }

  const foto = existing as unknown as FotoRow;

  const { error } = await (supabase
    .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
    .delete()
    .eq('id', fotoId);

  if (error) {
    logger.error({ error: error.message, fotoId }, 'Error al eliminar foto');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al eliminar la foto');
  }

  // Si era fachada, quitar foto_fachada_url del inmueble
  if (foto.es_fachada) {
    await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .update({ foto_fachada_url: null } as never)
      .eq('id', inmuebleId);
  }

  logAudit({
    usuarioId: deletedBy,
    accion: AUDIT_ACTIONS.FOTO_DELETED,
    entidad: AUDIT_ENTITIES.FOTO_INMUEBLE,
    entidadId: fotoId,
    detalle: {
      inmueble_id: inmuebleId,
      url: foto.url,
    },
    ip,
  });
}

/**
 * Reordenar fotos
 */
export async function reordenarFotos(
  inmuebleId: string,
  fotoIds: string[],
  updatedBy: string,
  ip?: string,
): Promise<FotoRow[]> {
  // Verificar que todas las fotos existen y pertenecen al inmueble
  const { data: existingFotos, error: existingError } = await (supabase
    .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('inmueble_id', inmuebleId)
    .in('id', fotoIds);

  if (existingError) {
    logger.error({ error: existingError.message, inmuebleId }, 'Error al verificar fotos');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al verificar fotos');
  }

  const existingIds = new Set((existingFotos as unknown as Array<{ id: string }>).map((f) => f.id));
  const invalidIds = fotoIds.filter((id) => !existingIds.has(id));

  if (invalidIds.length > 0) {
    throw AppError.badRequest(
      `Las siguientes fotos no pertenecen al inmueble: ${invalidIds.join(', ')}`,
      'INVALID_FOTO_IDS',
    );
  }

  // Actualizar orden de cada foto
  for (let i = 0; i < fotoIds.length; i++) {
    await (supabase
      .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
      .update({ orden: i } as never)
      .eq('id', fotoIds[i]);
  }

  logAudit({
    usuarioId: updatedBy,
    accion: AUDIT_ACTIONS.FOTOS_REORDERED,
    entidad: AUDIT_ENTITIES.INMUEBLE,
    entidadId: inmuebleId,
    detalle: {
      foto_ids: fotoIds,
    },
    ip,
  });

  // Retornar fotos actualizadas
  return getFotosByInmuebleId(inmuebleId);
}

/**
 * Establecer foto como fachada
 */
export async function setFotoFachada(
  inmuebleId: string,
  fotoId: string,
  updatedBy: string,
  ip?: string,
): Promise<FotoRow> {
  // Verificar que la foto existe y pertenece al inmueble
  const { data: existing, error: existingError } = await (supabase
    .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
    .select(FOTO_FIELDS)
    .eq('id', fotoId)
    .eq('inmueble_id', inmuebleId)
    .single();

  if (existingError || !existing) {
    throw AppError.notFound('Foto no encontrada');
  }

  // Quitar fachada de todas las fotos del inmueble
  await (supabase
    .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
    .update({ es_fachada: false } as never)
    .eq('inmueble_id', inmuebleId);

  // Establecer esta foto como fachada
  const { data, error } = await (supabase
    .from('fotos_inmueble' as string) as ReturnType<typeof supabase.from>)
    .update({ es_fachada: true } as never)
    .eq('id', fotoId)
    .select(FOTO_FIELDS)
    .single();

  if (error) {
    logger.error({ error: error.message, fotoId }, 'Error al establecer fachada');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al establecer la foto como fachada');
  }

  const foto = data as unknown as FotoRow;

  // Actualizar foto_fachada_url del inmueble
  await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .update({ foto_fachada_url: foto.url } as never)
    .eq('id', inmuebleId);

  logAudit({
    usuarioId: updatedBy,
    accion: AUDIT_ACTIONS.FOTO_SET_FACHADA,
    entidad: AUDIT_ENTITIES.FOTO_INMUEBLE,
    entidadId: fotoId,
    detalle: {
      inmueble_id: inmuebleId,
    },
    ip,
  });

  return foto;
}

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { TimelineQuery } from './expediente-timeline.schema';

// ============================================================
// Types
// ============================================================

type TimelineTipo = 'creacion' | 'transicion' | 'comentario' | 'asignacion' | 'estudio' | 'firma';

interface TimelineEvent {
  id: string;
  expediente_id: string;
  tipo: TimelineTipo;
  descripcion: string;
  detalle: Record<string, unknown> | null;
  usuario_id: string;
  usuario: { id: string; nombre: string; apellido: string };
  created_at: string;
}

// DB row shapes
interface EventoTimelineRow {
  id: string;
  expediente_id: string;
  tipo: string;
  descripcion: string;
  estado_anterior: string | null;
  estado_nuevo: string | null;
  comentario: string | null;
  metadata: Record<string, unknown> | null;
  usuario_id: string;
  created_at: string;
  usuario: { id: string; nombre: string; apellido: string } | null;
}

interface ComentarioRow {
  id: string;
  expediente_id: string;
  usuario_id: string;
  texto: string;
  created_at: string;
  usuario: { id: string; nombre: string; apellido: string };
}

interface ExpedienteRow {
  id: string;
  created_at: string;
  creado_por: string | null;
  creador: { id: string; nombre: string; apellido: string } | null;
}

// ============================================================
// Unified timeline
// ============================================================

export async function getUnifiedTimeline(expedienteId: string, query: TimelineQuery) {
  await verifyExpedienteExists(expedienteId);

  const { page, limit, tipo } = query;
  const allEvents: TimelineEvent[] = [];

  // Determine which sources to query based on tipo filter
  const fetchTransitions = !tipo || tipo === 'transicion';
  const fetchAsignaciones = !tipo || tipo === 'asignacion';
  const fetchEstudios = !tipo || tipo === 'estudio';
  const fetchFirma = !tipo || tipo === 'firma';
  const fetchComments = !tipo || tipo === 'comentario';
  const fetchCreation = !tipo || tipo === 'creacion';

  // Query all sources in parallel
  const promises: Promise<void>[] = [];

  if (fetchTransitions || fetchAsignaciones || fetchEstudios || fetchFirma) {
    promises.push(
      queryEventosTimeline(expedienteId, fetchTransitions, fetchAsignaciones, fetchEstudios, fetchFirma).then((events) => {
        allEvents.push(...events);
      }),
    );
  }

  if (fetchComments) {
    promises.push(
      queryComentarios(expedienteId).then((events) => {
        allEvents.push(...events);
      }),
    );
  }

  if (fetchCreation) {
    promises.push(
      queryCreacion(expedienteId).then((event) => {
        if (event) allEvents.push(event);
      }),
    );
  }

  await Promise.all(promises);

  // Sort unified: newest first
  allEvents.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // Paginate
  const total = allEvents.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const eventos = allEvents.slice(offset, offset + limit);

  return {
    eventos,
    pagination: { page, limit, total, totalPages },
  };
}

// ============================================================
// Source queries
// ============================================================

async function queryEventosTimeline(
  expedienteId: string,
  includeTransitions: boolean,
  includeAsignaciones: boolean,
  includeEstudios: boolean = false,
  includeFirma: boolean = false,
): Promise<TimelineEvent[]> {
  // Build tipo filter
  const tipos: string[] = [];
  if (includeTransitions) tipos.push('estado');
  if (includeAsignaciones) tipos.push('asignacion');
  if (includeEstudios) tipos.push('estudio');
  if (includeFirma) tipos.push('firma');

  if (tipos.length === 0) return [];

  const { data, error } = await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, expediente_id, tipo, descripcion, estado_anterior, estado_nuevo, comentario, metadata,
      usuario_id, created_at,
      usuario:perfiles!eventos_timeline_usuario_id_fkey(id, nombre, apellido)
    `)
    .eq('expediente_id', expedienteId)
    .in('tipo', tipos)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al consultar eventos_timeline');
    return [];
  }

  const rows = (data as unknown as EventoTimelineRow[]) || [];

  return rows.map((row) => {
    let tipo: TimelineTipo;
    let detalle: Record<string, unknown> | null;

    if (row.tipo === 'estado') {
      tipo = 'transicion';
      detalle = { estado_anterior: row.estado_anterior, estado_nuevo: row.estado_nuevo, comentario: row.comentario };
    } else if (row.tipo === 'estudio') {
      tipo = 'estudio';
      detalle = row.metadata || null;
    } else if (row.tipo === 'firma') {
      tipo = 'firma';
      detalle = row.metadata || null;
    } else {
      tipo = 'asignacion';
      detalle = row.metadata
        ? {
            analista_anterior: row.metadata.analista_anterior || null,
            analista_nuevo: row.metadata.analista_nuevo || null,
            analista_anterior_id: row.metadata.analista_anterior_id || null,
            analista_nuevo_id: row.metadata.analista_nuevo_id || null,
          }
        : null;
    }

    return {
      id: row.id,
      expediente_id: row.expediente_id,
      tipo,
      descripcion: row.descripcion,
      detalle,
      usuario_id: row.usuario_id,
      usuario: row.usuario || { id: row.usuario_id, nombre: 'Usuario', apellido: '' },
      created_at: row.created_at,
    };
  });
}

async function queryComentarios(expedienteId: string): Promise<TimelineEvent[]> {
  const { data, error } = await (supabase
    .from('comentarios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, expediente_id, usuario_id, texto, created_at,
      usuario:perfiles!comentarios_usuario_id_fkey(id, nombre, apellido)
    `)
    .eq('expediente_id', expedienteId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al consultar comentarios para timeline');
    return [];
  }

  const rows = (data as unknown as ComentarioRow[]) || [];

  return rows.map((row) => ({
    id: `comment-${row.id}`,
    expediente_id: row.expediente_id,
    tipo: 'comentario' as const,
    descripcion: 'Comentario interno agregado',
    detalle: { contenido: row.texto },
    usuario_id: row.usuario_id,
    usuario: row.usuario || { id: row.usuario_id, nombre: 'Usuario', apellido: '' },
    created_at: row.created_at,
  }));
}

async function queryCreacion(expedienteId: string): Promise<TimelineEvent | null> {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, created_at, creado_por,
      creador:perfiles!expedientes_creado_por_fkey(id, nombre, apellido)
    `)
    .eq('id', expedienteId)
    .single();

  if (error || !data) return null;

  const row = data as unknown as ExpedienteRow;

  return {
    id: `creation-${row.id}`,
    expediente_id: row.id,
    tipo: 'creacion',
    descripcion: 'Expediente creado',
    detalle: null,
    usuario_id: row.creado_por || '',
    usuario: row.creador || { id: row.creado_por || '', nombre: 'Sistema', apellido: '' },
    created_at: row.created_at,
  };
}

// ============================================================
// Helpers
// ============================================================

async function verifyExpedienteExists(id: string): Promise<void> {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', id)
    .single();

  if (error || !data) {
    throw AppError.notFound('Expediente no encontrado');
  }
}

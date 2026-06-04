// ============================================================
// Soporte — Service
// CRUD mínimo de tickets_soporte. La pantalla detallada del mockup
// (filtros, SLA tracking, asignación) queda como iteración futura.
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import type {
  CreateTicketSoporteInput,
  ListTicketsSoporteQuery,
  UpdateTicketEstadoInput,
} from './soporte.schema';

export interface TicketSoporte {
  id: string;
  ticketNumero: string;
  remitenteId: string;
  remitente: { nombre: string; apellido: string } | null;
  asignadoA: string | null;
  tipo: string;
  asunto: string;
  descripcion: string | null;
  prioridad: 'alta' | 'media' | 'baja';
  estado: 'abierto' | 'en_proceso' | 'resuelto';
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

interface TicketRow {
  id: string;
  ticket_numero: string;
  remitente_id: string;
  asignado_a: string | null;
  tipo: string;
  asunto: string;
  descripcion: string | null;
  prioridad: TicketSoporte['prioridad'];
  estado: TicketSoporte['estado'];
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  perfiles?: { nombre: string | null; apellido: string | null } | null;
}

function mapTicket(row: TicketRow): TicketSoporte {
  return {
    id: row.id,
    ticketNumero: row.ticket_numero,
    remitenteId: row.remitente_id,
    remitente: row.perfiles
      ? { nombre: row.perfiles.nombre ?? '', apellido: row.perfiles.apellido ?? '' }
      : null,
    asignadoA: row.asignado_a,
    tipo: row.tipo,
    asunto: row.asunto,
    descripcion: row.descripcion,
    prioridad: row.prioridad,
    estado: row.estado,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

export async function createTicket(
  remitenteId: string,
  input: CreateTicketSoporteInput,
): Promise<TicketSoporte> {
  const { data, error } = await (
    supabase.from('tickets_soporte' as string) as ReturnType<typeof supabase.from>
  )
    .insert({
      remitente_id: remitenteId,
      tipo: input.tipo,
      asunto: input.asunto,
      descripcion: input.descripcion ?? null,
      prioridad: input.prioridad ?? 'media',
    })
    .select(
      'id, ticket_numero, remitente_id, asignado_a, tipo, asunto, descripcion, prioridad, estado, created_at, updated_at, resolved_at',
    )
    .single();

  if (error) throw fromSupabaseError(error);
  if (!data) throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo crear el ticket');
  return mapTicket(data as unknown as TicketRow);
}

export async function listTickets(
  query: ListTicketsSoporteQuery,
): Promise<{ tickets: TicketSoporte[]; total: number; page: number; limit: number }> {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  let qb = (
    supabase.from('tickets_soporte' as string) as ReturnType<typeof supabase.from>
  )
    .select(
      'id, ticket_numero, remitente_id, asignado_a, tipo, asunto, descripcion, prioridad, estado, created_at, updated_at, resolved_at, perfiles!tickets_soporte_remitente_id_fkey(nombre, apellido)',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (query.estado) qb = qb.eq('estado', query.estado);
  if (query.prioridad) qb = qb.eq('prioridad', query.prioridad);

  const { data, error, count } = await qb;
  if (error) throw fromSupabaseError(error);

  const rows = ((data ?? []) as unknown as TicketRow[]).map(mapTicket);
  return { tickets: rows, total: count ?? 0, page, limit };
}

export async function getById(id: string): Promise<TicketSoporte> {
  const { data, error } = await (
    supabase.from('tickets_soporte' as string) as ReturnType<typeof supabase.from>
  )
    .select(
      'id, ticket_numero, remitente_id, asignado_a, tipo, asunto, descripcion, prioridad, estado, created_at, updated_at, resolved_at, perfiles!tickets_soporte_remitente_id_fkey(nombre, apellido)',
    )
    .eq('id', id)
    .single();

  if (error) throw fromSupabaseError(error);
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Ticket no encontrado');
  return mapTicket(data as unknown as TicketRow);
}

export async function updateEstado(
  id: string,
  input: UpdateTicketEstadoInput,
): Promise<TicketSoporte> {
  const { data, error } = await (
    supabase.from('tickets_soporte' as string) as ReturnType<typeof supabase.from>
  )
    .update({ estado: input.estado })
    .eq('id', id)
    .select(
      'id, ticket_numero, remitente_id, asignado_a, tipo, asunto, descripcion, prioridad, estado, created_at, updated_at, resolved_at',
    )
    .single();

  if (error) throw fromSupabaseError(error);
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Ticket no encontrado');
  return mapTicket(data as unknown as TicketRow);
}

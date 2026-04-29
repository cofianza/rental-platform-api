/**
 * Notificaciones in-app — escritura desde el backend, lectura via Realtime.
 *
 * El backend escribe filas con service-role; el frontend se suscribe a la
 * tabla via supabase.channel() y aplica RLS para que cada usuario solo
 * vea las suyas.
 *
 * Patron de uso desde otros modulos:
 *   import { notificarUsuario } from '@/modules/notificaciones/notificaciones.service';
 *   notificarUsuario({
 *     userId, tipo: 'cita.creada', titulo: '...', mensaje: '...', link: '/expedientes/X',
 *   }).catch((e) => logger.warn({ error: e }, 'Error notificando usuario'));
 *
 * Las llamadas son fire-and-forget para no bloquear el flujo principal.
 */

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

// ============================================================
// Types
// ============================================================

export interface NotificarUsuarioInput {
  userId: string;
  tipo: string;
  titulo: string;
  mensaje: string;
  link?: string;
  payload?: Record<string, unknown>;
}

export interface NotificacionRow {
  id: string;
  user_id: string;
  tipo: string;
  titulo: string;
  mensaje: string;
  link: string | null;
  payload: Record<string, unknown> | null;
  leida_at: string | null;
  created_at: string;
}

// ============================================================
// Escritura — invocado desde otros modulos
// ============================================================

/**
 * Crea una notificacion para un usuario. Idempotente solo en el sentido
 * de que un mismo evento puede generar varias filas — el caller decide.
 *
 * Si userId es null/undefined la llamada se ignora silenciosamente. Esto
 * permite usar lookups que pueden no resolver sin que rompa el flujo
 * principal (eg. solicitante sin perfil aun no tiene notificaciones).
 */
export async function notificarUsuario(input: NotificarUsuarioInput): Promise<void> {
  if (!input.userId) {
    return;
  }
  const { error } = await db('notificaciones').insert({
    user_id: input.userId,
    tipo: input.tipo,
    titulo: input.titulo,
    mensaje: input.mensaje,
    link: input.link ?? null,
    payload: input.payload ?? null,
  } as never);

  if (error) {
    logger.warn(
      { error: error.message, userId: input.userId, tipo: input.tipo },
      'Error al crear notificacion',
    );
  }
}

/**
 * Resuelve el perfil_id correspondiente a un email. Util cuando solo
 * tenemos la entidad `solicitantes` (que no tiene FK directo a perfiles)
 * y queremos notificar al usuario propietario de ese email.
 *
 * perfiles NO almacena email — vive en auth.users. Devuelve null si no
 * hay un usuario registrado con ese email; el caller debe tolerarlo
 * (eg. solicitante que aun no se registra → no recibe notificacion in-app).
 */
export async function findPerfilIdByEmail(email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  try {
    // listUsers + filter local. Para volumenes grandes conviene cachear o
    // exponer un RPC server-side, pero para el flujo actual (decenas de
    // usuarios activos) es aceptable y se invoca solo en fan-out de eventos.
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (error) {
      logger.warn({ error: error.message, email }, 'findPerfilIdByEmail listUsers fallo');
      return null;
    }
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    return match?.id ?? null;
  } catch (e) {
    logger.warn({ error: e, email }, 'findPerfilIdByEmail excepcion');
    return null;
  }
}

// ============================================================
// Lectura — endpoints autenticados
// ============================================================

export async function listMisNotificaciones(
  userId: string,
  opts: { page?: number; limit?: number; soloNoLeidas?: boolean } = {},
): Promise<{ data: NotificacionRow[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = db('notificaciones')
    .select('id, user_id, tipo, titulo, mensaje, link, payload, leida_at, created_at', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (opts.soloNoLeidas) {
    query = query.is('leida_at', null);
  }

  const { data, count, error } = await query as unknown as {
    data: NotificacionRow[] | null;
    count: number | null;
    error: { message: string } | null;
  };

  if (error) {
    logger.error({ error: error.message }, 'Error listando notificaciones');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudieron cargar las notificaciones');
  }

  return {
    data: data ?? [],
    total: count ?? 0,
    page,
    limit,
  };
}

export async function contarNoLeidas(userId: string): Promise<number> {
  const { count, error } = await db('notificaciones')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('leida_at', null) as unknown as { count: number | null; error: { message: string } | null };

  if (error) {
    logger.warn({ error: error.message, userId }, 'Error contando no-leidas');
    return 0;
  }
  return count ?? 0;
}

export async function marcarLeida(id: string, userId: string): Promise<NotificacionRow> {
  const { data, error } = await db('notificaciones')
    .update({ leida_at: new Date().toISOString() } as never)
    .eq('id', id)
    .eq('user_id', userId) // defensa adicional aunque RLS ya lo aplica
    .select('id, user_id, tipo, titulo, mensaje, link, payload, leida_at, created_at')
    .single() as unknown as { data: NotificacionRow | null; error: { message: string; code?: string } | null };

  if (error || !data) {
    if (error?.code === 'PGRST116') {
      throw AppError.notFound('Notificacion no encontrada', 'NOTIFICACION_NOT_FOUND');
    }
    logger.error({ error: error?.message, id }, 'Error marcando notificacion como leida');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo marcar como leida');
  }

  return data;
}

export async function marcarTodasLeidas(userId: string): Promise<{ count: number }> {
  const { count, error } = await db('notificaciones')
    .update({ leida_at: new Date().toISOString() } as never, { count: 'exact' })
    .eq('user_id', userId)
    .is('leida_at', null) as unknown as { count: number | null; error: { message: string } | null };

  if (error) {
    logger.error({ error: error.message, userId }, 'Error marcando todas como leidas');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudieron marcar todas');
  }
  return { count: count ?? 0 };
}

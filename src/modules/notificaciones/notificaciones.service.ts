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
import { env } from '@/config';
import { sendResponsableAsignadoEmail } from '../orchestrator/orchestrator.emails';
import type { WhatsappTemplateKey } from '@/modules/whatsapp';

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
 * Igual que notificarUsuario pero ADEMÁS manda un email (best-effort) al
 * usuario. Para avisos importantes (ej. asignación de responsable) donde el
 * miembro puede no estar conectado. La parte email es defensiva: si falla
 * (sin email, Resend caído), la notificación in-app ya quedó y no se rompe el
 * flujo. perfiles NO guarda email → se resuelve de auth.users vía RPC.
 */
export async function notificarYCorreo(input: NotificarUsuarioInput): Promise<void> {
  await notificarUsuario(input);
  if (!input.userId) return;
  try {
    const { data } = await supabase.rpc('get_user_with_email' as never, { user_id: input.userId } as never);
    const email = (data as unknown as Array<{ email: string }> | null)?.[0]?.email;
    if (!email) return;

    const { data: perfilRow } = await db('perfiles')
      .select('nombre, apellido')
      .eq('id', input.userId)
      .maybeSingle();
    const perfil = perfilRow as { nombre: string | null; apellido: string | null } | null;
    const nombre = perfil ? `${perfil.nombre ?? ''} ${perfil.apellido ?? ''}`.trim() || null : null;

    await sendResponsableAsignadoEmail({
      email,
      nombre,
      titulo: input.titulo,
      mensaje: input.mensaje,
      link: input.link ?? '/',
      frontend_url: env.FRONTEND_URL,
    });
  } catch (err) {
    logger.warn(
      { error: (err as Error).message, userId: input.userId },
      'No se pudo enviar email de notificacion (in-app ya enviada)',
    );
  }
}

/**
 * Notifica al MIEMBRO RESPONSABLE de un expediente (in-app + WhatsApp opcional),
 * replicando lo que recibe el dueño en un evento operativo (cita, estudio, pago).
 * Se llama ADEMÁS de la notificación al dueño, para que quien gestiona el
 * expediente también se entere.
 *
 * - No-op si el expediente no tiene `miembro_responsable_id`, o si coincide con
 *   `excluirPerfilId` (el dueño — evita duplicar cuando el responsable es el
 *   mismo titular).
 * - El WhatsApp reusa la MISMA plantilla `_DUENO` del dueño: su primera variable
 *   es el nombre del destinatario, así que la sustituimos por la del miembro.
 *   Solo se envía si el miembro tiene teléfono.
 * - Fire-and-forget defensivo: nunca lanza (el aviso al dueño ya ocurrió).
 */
export async function notificarResponsableExpediente(params: {
  expedienteId: string;
  excluirPerfilId?: string | null;
  tipo: string;
  titulo: string;
  mensaje: string;
  link?: string;
  payload?: Record<string, unknown>;
  whatsapp?: { template: WhatsappTemplateKey; variables: string[] };
}): Promise<void> {
  try {
    const { data: exp } = await db('expedientes')
      .select('miembro_responsable_id')
      .eq('id', params.expedienteId)
      .maybeSingle();
    const miembroId = (exp as { miembro_responsable_id?: string | null } | null)?.miembro_responsable_id ?? null;
    if (!miembroId || miembroId === params.excluirPerfilId) return;

    const { data: perfilRow } = await db('perfiles')
      .select('nombre, apellido, razon_social, telefono')
      .eq('id', miembroId)
      .maybeSingle();
    const p = perfilRow as {
      nombre?: string | null; apellido?: string | null; razon_social?: string | null; telefono?: string | null;
    } | null;
    const nombreMiembro = p?.razon_social || `${p?.nombre ?? ''} ${p?.apellido ?? ''}`.trim() || 'Hola';

    await notificarUsuario({
      userId: miembroId,
      tipo: params.tipo,
      titulo: params.titulo,
      mensaje: params.mensaje,
      link: params.link,
      payload: params.payload,
    });

    if (params.whatsapp && p?.telefono) {
      const variables = [nombreMiembro, ...params.whatsapp.variables.slice(1)];
      const { enviarTemplate } = await import('@/modules/whatsapp');
      await enviarTemplate({
        to: p.telefono,
        template: params.whatsapp.template,
        variables,
        context: { expediente_id: params.expedienteId },
      });
    }
  } catch (err) {
    logger.warn(
      { error: err, expedienteId: params.expedienteId },
      'No se pudo notificar al miembro responsable del expediente',
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

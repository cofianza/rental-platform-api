// ============================================================
// Interesados de la vitrina (leads pre-expediente) — Service
// ------------------------------------------------------------
// Captura de leads desde "Me interesa este inmueble" SIN cuenta (datos de
// contacto + autorización) y aviso al dueño/inmobiliaria (in-app + WhatsApp +
// correo). Lectura scopeada por los inmuebles que el usuario puede ver.
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config';
import { buildPaginationMeta } from '@/utils/pagination';
import { resolveAllowedInmuebleIds, resolveOrgCanonicalPerfilId, resolveNombreDueno } from '@/lib/tenantScope';
import { notificarUsuario } from '../notificaciones/notificaciones.service';
import { sendNuevoInteresadoEmail } from '@/lib/email';
import type { ListInteresadosQuery, RegistrarInteresInput } from './interesados.schema';

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

const TIPO_LABEL: Record<string, string> = {
  apartamento: 'Apartamento',
  casa: 'Casa',
  oficina: 'Oficina',
  local: 'Local',
  bodega: 'Bodega',
};

function inmuebleLabel(inm: { tipo: string; barrio: string | null; ciudad: string }): string {
  const tipo = TIPO_LABEL[inm.tipo] || inm.tipo;
  const lugar = inm.barrio ? `${inm.barrio}, ${inm.ciudad}` : inm.ciudad;
  return `${tipo} en ${lugar}`;
}

interface InmuebleRow {
  id: string;
  propietario_id: string | null;
  inmobiliaria_id: string | null;
  tipo: string;
  ciudad: string;
  barrio: string | null;
  visible_vitrina: boolean;
  estado: string;
}

// ── Público: registrar interés (sin auth) ────────────────────────────

export async function registrarInteresPublico(
  inmuebleId: string,
  input: RegistrarInteresInput,
  meta: { ip: string | null; userAgent: string | null },
): Promise<void> {
  // 1. El inmueble debe existir y estar publicado/disponible (igual que la vitrina).
  const { data: inmRow } = await db('inmuebles')
    .select('id, propietario_id, inmobiliaria_id, tipo, ciudad, barrio, visible_vitrina, estado')
    .eq('id', inmuebleId)
    .maybeSingle();
  const inm = inmRow as InmuebleRow | null;
  if (!inm || !inm.visible_vitrina || inm.estado !== 'disponible') {
    throw AppError.notFound('Inmueble no encontrado o no disponible', 'INMUEBLE_NOT_FOUND');
  }

  // 2. Guardar el lead.
  const now = new Date().toISOString();
  const { error } = await db('inmueble_interesados').insert({
    inmueble_id: inmuebleId,
    propietario_id: inm.propietario_id,
    inmobiliaria_id: inm.inmobiliaria_id,
    nombre: input.nombre.trim(),
    telefono: input.telefono.trim(),
    email: input.email.trim().toLowerCase(),
    acepta_datos: true,
    acepta_datos_at: now,
    ip: meta.ip ? meta.ip.slice(0, 45) : null,
    user_agent: meta.userAgent ? meta.userAgent.slice(0, 500) : null,
    estado: 'nuevo',
  } as never);
  if (error) throw fromSupabaseError(error);

  // 3. Avisar al dueño. Best-effort: si falla, el lead ya quedó guardado.
  await notificarDueno(inm, input).catch((err) =>
    logger.warn({ err, inmuebleId }, 'No se pudo notificar al dueño del nuevo interesado'),
  );
}

async function notificarDueno(inm: InmuebleRow, input: RegistrarInteresInput): Promise<void> {
  if (!inm.propietario_id) return;
  const label = inmuebleLabel(inm);

  // Contacto del dueño = perfil canónico de la org (titular) para inmobiliaria;
  // el propio propietario para individual.
  const canonicalId = await resolveOrgCanonicalPerfilId(inm.propietario_id);
  const { data: pf } = await db('perfiles')
    .select('nombre, apellido, razon_social, telefono, whatsapp_recaudo, email_recaudo')
    .eq('id', canonicalId)
    .maybeSingle();
  const p = pf as {
    nombre: string | null; apellido: string | null; razon_social: string | null;
    telefono: string | null; whatsapp_recaudo: string | null; email_recaudo: string | null;
  } | null;

  // Nombre del dueño: razón social → nombre de la inmobiliaria → nombre+apellido.
  const duenoNombre = await resolveNombreDueno(inm.propietario_id);
  const duenoWhatsapp = p?.whatsapp_recaudo || p?.telefono || null;
  let duenoEmail = p?.email_recaudo || null;
  if (!duenoEmail) {
    try {
      const { data } = await supabase.rpc('get_user_with_email' as never, { user_id: canonicalId } as never);
      duenoEmail = (data as unknown as Array<{ email: string }> | null)?.[0]?.email ?? null;
    } catch {
      /* perfiles no guarda email; si el RPC falla, seguimos sin correo */
    }
  }

  // In-app: al dueño del inmueble (propietario_id) — lo ve en su panel.
  await notificarUsuario({
    userId: inm.propietario_id,
    tipo: 'interesado.vitrina',
    titulo: 'Nuevo interesado en tu inmueble',
    mensaje: `${input.nombre} está interesado en ${label}. WhatsApp: ${input.telefono}.`,
    link: '/interesados',
    payload: { inmueble: label, nombre: input.nombre, telefono: input.telefono, email: input.email },
  });

  // WhatsApp al dueño (si tiene número).
  if (duenoWhatsapp) {
    const { enviarTemplate } = await import('@/modules/whatsapp');
    await enviarTemplate({
      to: duenoWhatsapp,
      template: 'INTERESADO_VITRINA_DUENO',
      variables: [duenoNombre, label, input.nombre, input.telefono, input.email],
    });
  }

  // Correo al dueño (si se resolvió email).
  if (duenoEmail) {
    await sendNuevoInteresadoEmail(duenoEmail, {
      duenoNombre,
      interesadoNombre: input.nombre,
      interesadoTelefono: input.telefono,
      interesadoEmail: input.email,
      inmuebleLabel: label,
      panelUrl: `${env.FRONTEND_URL}/interesados`,
    });
  }
}

// ── Autenticado: listar / gestionar (scopeado por inmueble) ───────────

export async function listInteresados(userId: string, rol: string, query: ListInteresadosQuery) {
  const allowed = await resolveAllowedInmuebleIds(userId, rol);
  // null = rol interno (sin filtro); [] = no ve nada; [...] = solo esos inmuebles.
  if (allowed && allowed.length === 0) {
    return { data: [], pagination: buildPaginationMeta(0, query.page, query.limit) };
  }

  const offset = (query.page - 1) * query.limit;
  let qb = db('inmueble_interesados').select(
    'id, inmueble_id, nombre, telefono, email, estado, created_at, inmuebles(tipo, ciudad, barrio, direccion, foto_fachada_url)',
    { count: 'exact' },
  );
  if (allowed) qb = qb.in('inmueble_id', allowed);
  if (query.estado) qb = qb.eq('estado', query.estado);
  if (query.inmueble_id) qb = qb.eq('inmueble_id', query.inmueble_id);
  qb = qb.order('created_at', { ascending: false }).range(offset, offset + query.limit - 1);

  const { data, error, count } = await qb;
  if (error) throw fromSupabaseError(error);
  return { data: data ?? [], pagination: buildPaginationMeta(count ?? 0, query.page, query.limit) };
}

export async function updateEstadoInteresado(
  id: string,
  userId: string,
  rol: string,
  estado: string,
): Promise<void> {
  const { data: row } = await db('inmueble_interesados')
    .select('id, inmueble_id')
    .eq('id', id)
    .maybeSingle();
  const lead = row as { id: string; inmueble_id: string } | null;
  if (!lead) throw AppError.notFound('Interesado no encontrado', 'INTERESADO_NOT_FOUND');

  const allowed = await resolveAllowedInmuebleIds(userId, rol);
  if (allowed && !allowed.includes(lead.inmueble_id)) {
    throw AppError.forbidden('No tienes acceso a este interesado', 'FORBIDDEN');
  }

  const { error } = await db('inmueble_interesados')
    .update({ estado, updated_at: new Date().toISOString() } as never)
    .eq('id', id);
  if (error) throw fromSupabaseError(error);
}

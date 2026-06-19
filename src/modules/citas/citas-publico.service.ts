// ============================================================
// Gestión pública de la visita (sin login) — el solicitante abre
// cofianza.co/visita/<accion>/<token> desde los botones del WhatsApp y
// puede reprogramar (elige un horario real de la disponibilidad) o
// cancelar su visita. El token opaco de la cita es la autorización.
//
// Solo importa "hacia abajo" (citas.service, disponibilidad, notificaciones)
// para no crear ciclos: citas.service NO importa este archivo.
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  slotEstaDisponible,
  getSlotsPorInmueble,
  type SlotsDia,
} from '../disponibilidad/disponibilidad.service';
import { notificarCitaCreada, notificarCitaCancelada } from './citas.service';

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

// Solo estas citas pueden gestionarse desde el link público.
const ACCIONABLES = ['solicitada', 'confirmada'];

interface CitaPublicaRow {
  id: string;
  estado: string;
  fecha_propuesta: string | null;
  fecha_confirmada: string | null;
  expediente_id: string;
  expediente: {
    inmueble: { id: string; direccion: string; ciudad: string; propietario_id: string } | null;
    solicitante: { nombre: string; apellido: string } | null;
  } | null;
}

async function fetchCitaByToken(token: string): Promise<CitaPublicaRow> {
  const { data, error } = await db('citas')
    .select(`
      id, estado, fecha_propuesta, fecha_confirmada, expediente_id,
      expediente:expedientes (
        inmueble:inmuebles (id, direccion, ciudad, propietario_id),
        solicitante:solicitantes (nombre, apellido)
      )
    `)
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ error: error.message }, 'Error al resolver cita por token público');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al cargar la visita');
  }
  if (!data) {
    throw AppError.notFound('Visita no encontrada o enlace inválido');
  }
  return data as unknown as CitaPublicaRow;
}

export interface CitaPublicaDTO {
  estado: string;
  accionable: boolean;
  fecha: string | null;
  inmueble: { direccion: string; ciudad: string } | null;
  nombre: string;
}

function toDTO(c: CitaPublicaRow): CitaPublicaDTO {
  const inm = c.expediente?.inmueble;
  const primerNombre = (c.expediente?.solicitante?.nombre ?? '').split(' ')[0] || '';
  return {
    estado: c.estado,
    accionable: ACCIONABLES.includes(c.estado),
    fecha: c.fecha_confirmada || c.fecha_propuesta,
    inmueble: inm ? { direccion: inm.direccion, ciudad: inm.ciudad } : null,
    nombre: primerNombre,
  };
}

/** Detalle público de la visita (para mostrar en la página). */
export async function getCitaPublica(token: string): Promise<CitaPublicaDTO> {
  return toDTO(await fetchCitaByToken(token));
}

/** Slots disponibles del inmueble de la visita, para reprogramar. */
export async function getSlotsPublicos(
  token: string,
  desde: string,
  hasta: string,
): Promise<SlotsDia[]> {
  const c = await fetchCitaByToken(token);
  const inmuebleId = c.expediente?.inmueble?.id;
  if (!inmuebleId) throw AppError.notFound('Inmueble de la visita no encontrado');
  return getSlotsPorInmueble(inmuebleId, desde, hasta);
}

/**
 * Reprogramar desde el link público: la visita vuelve a 'solicitada' con la
 * nueva fecha propuesta (el propietario debe re-confirmarla, igual que cuando
 * el solicitante reprograma con login). Valida el slot contra la disponibilidad.
 */
export async function reprogramarCitaPublica(token: string, fechaIso: string): Promise<CitaPublicaDTO> {
  const c = await fetchCitaByToken(token);
  if (!ACCIONABLES.includes(c.estado)) {
    throw AppError.badRequest('Esta visita ya no se puede reprogramar', 'CITA_NO_ACCIONABLE');
  }

  const propietarioId = c.expediente?.inmueble?.propietario_id;
  if (propietarioId) {
    const disponible = await slotEstaDisponible(propietarioId, fechaIso);
    if (!disponible) {
      throw AppError.badRequest(
        'El horario seleccionado ya no está disponible. Elige otro.',
        'SLOT_NO_DISPONIBLE',
      );
    }
  }

  const { error } = await db('citas')
    .update({
      estado: 'solicitada',
      fecha_propuesta: fechaIso,
      fecha_confirmada: null,
      // Vuelve a "pendiente de confirmación": el invariante del propietario es
      // (estado='solicitada' AND confirmado_por IS NULL). Igual que el flujo
      // autenticado del solicitante (citas.service.ts).
      confirmado_por: null,
      acuse_solicitante_at: null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('token', token);

  if (error) {
    logger.error({ error: error.message, citaId: c.id }, 'Error al reprogramar cita (público)');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo reprogramar la visita');
  }

  // Avisa al propietario/inmobiliaria (email + in-app) para que confirme la
  // nueva fecha — mismo flujo que cuando el solicitante reprograma con login
  // (queda como "nueva visita solicitada"). Fire-and-forget.
  notificarCitaCreada(c.id, c.expediente_id, fechaIso, false, true).catch((e) =>
    logger.warn({ error: e, citaId: c.id }, 'Error al notificar reprogramación pública'),
  );

  logger.info({ citaId: c.id }, 'Cita reprogramada desde link público');
  return toDTO(await fetchCitaByToken(token));
}

/** Cancelar desde el link público. */
export async function cancelarCitaPublica(token: string, motivo?: string): Promise<CitaPublicaDTO> {
  const c = await fetchCitaByToken(token);
  if (!ACCIONABLES.includes(c.estado)) {
    throw AppError.badRequest('Esta visita ya no se puede cancelar', 'CITA_NO_ACCIONABLE');
  }

  const { error } = await db('citas')
    .update({
      estado: 'cancelada',
      motivo_cancelacion: motivo?.trim() || 'Cancelada por el solicitante desde WhatsApp',
      updated_at: new Date().toISOString(),
    } as never)
    .eq('token', token);

  if (error) {
    logger.error({ error: error.message, citaId: c.id }, 'Error al cancelar cita (público)');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo cancelar la visita');
  }

  // Avisa al propietario/inmobiliaria (email + in-app) que el solicitante canceló.
  const fechaCita = c.fecha_confirmada || c.fecha_propuesta || new Date().toISOString();
  const motivoFinal = motivo?.trim() || 'Cancelada por el solicitante desde WhatsApp';
  notificarCitaCancelada(c.expediente_id, fechaCita, motivoFinal, 'solicitante').catch((e) =>
    logger.warn({ error: e, citaId: c.id }, 'Error al notificar cancelación pública'),
  );

  logger.info({ citaId: c.id }, 'Cita cancelada desde link público');
  return toDTO(await fetchCitaByToken(token));
}

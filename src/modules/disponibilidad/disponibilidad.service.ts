import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { UpsertDisponibilidadInput } from './disponibilidad.schema';

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

// ============================================================
// Tipos de respuesta
// ============================================================

export interface HorarioDia {
  dia_semana: number;
  hora_inicio: string; // HH:MM
  hora_fin: string; // HH:MM
  activo: boolean;
}

export interface ConfiguracionDisponibilidad {
  slot_duracion_minutos: 30 | 60 | 120;
  antelacion_minima_horas: number;
  activa: boolean;
}

export interface DisponibilidadResponse {
  horarios: HorarioDia[];
  configuracion: ConfiguracionDisponibilidad;
}

// Defaults usados en el response cuando no hay filas reales en DB.
// Coinciden con los defaults del RPC fn_slots_disponibles (L-V 9-17, 60min, 24h).
const DEFAULTS: ConfiguracionDisponibilidad = {
  slot_duracion_minutos: 60,
  antelacion_minima_horas: 24,
  activa: true,
};

// ============================================================
// GET disponibilidad (propio o ajeno)
// ============================================================

/**
 * Devuelve horarios + configuración de un propietario. Si no hay filas
 * reales, marca `tiene_config_explicita = false` para que el frontend
 * pueda mostrar "Usando horarios por defecto (L-V 9-17, 60 min)".
 */
export async function getDisponibilidad(propietarioId: string): Promise<
  DisponibilidadResponse & { tiene_config_explicita: boolean }
> {
  const { data: horariosRows, error: horariosErr } = await db('disponibilidad_propietario')
    .select('dia_semana, hora_inicio, hora_fin, activo')
    .eq('propietario_id', propietarioId)
    .order('dia_semana', { ascending: true });

  if (horariosErr) {
    logger.error({ error: horariosErr.message, propietarioId }, 'Error al cargar disponibilidad');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al cargar la disponibilidad');
  }

  const { data: configRow } = await db('configuracion_disponibilidad')
    .select('slot_duracion_minutos, antelacion_minima_horas, activa')
    .eq('propietario_id', propietarioId)
    .maybeSingle();

  const horarios = (horariosRows as HorarioDia[] | null) ?? [];
  const configuracion: ConfiguracionDisponibilidad =
    (configRow as ConfiguracionDisponibilidad | null) ?? DEFAULTS;

  return {
    horarios,
    configuracion,
    tiene_config_explicita: horarios.length > 0,
  };
}

// ============================================================
// PUT: replace atómico de disponibilidad
// ============================================================

/**
 * Reemplaza la disponibilidad del propietario en una "transacción lógica":
 *   1. Upsert de configuracion_disponibilidad.
 *   2. DELETE de filas no presentes en el input.
 *   3. UPSERT de los horarios enviados.
 *
 * NOTA: supabase-js no ofrece transacciones multi-statement. El orden
 * elegido minimiza el daño si falla a mitad (el paso 2 es el destructivo;
 * si falla antes del 3, el propietario queda "sin disponibilidad" y debe
 * reintentar — mejor que un estado inconsistente persistente).
 * Para garantía total sería necesario un RPC con BEGIN/COMMIT — fuera de
 * scope aquí; el flujo lo usa el propietario y es raro que falle.
 */
export async function upsertDisponibilidad(
  propietarioId: string,
  input: UpsertDisponibilidadInput,
): Promise<DisponibilidadResponse> {
  // 1. Upsert config.
  const { error: configErr } = await db('configuracion_disponibilidad')
    .upsert(
      {
        propietario_id: propietarioId,
        slot_duracion_minutos: input.slot_duracion_minutos,
        antelacion_minima_horas: input.antelacion_minima_horas,
        activa: true,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: 'propietario_id' },
    );

  if (configErr) {
    logger.error({ error: configErr.message, propietarioId }, 'Error al upsert configuracion_disponibilidad');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al guardar la configuración');
  }

  // 2. DELETE de días no enviados (respeta "día ausente = no disponible").
  const diasEnviados = input.horarios.map((h) => h.dia_semana);
  if (diasEnviados.length === 0) {
    // Borrar todos
    const { error: delAllErr } = await db('disponibilidad_propietario')
      .delete()
      .eq('propietario_id', propietarioId);
    if (delAllErr) {
      logger.error({ error: delAllErr.message, propietarioId }, 'Error al borrar disponibilidad');
      throw new AppError(500, 'INTERNAL_ERROR', 'Error al limpiar horarios');
    }
  } else {
    const { error: delErr } = await db('disponibilidad_propietario')
      .delete()
      .eq('propietario_id', propietarioId)
      .not('dia_semana', 'in', `(${diasEnviados.join(',')})`);
    if (delErr) {
      logger.error({ error: delErr.message, propietarioId }, 'Error al borrar horarios no enviados');
      throw new AppError(500, 'INTERNAL_ERROR', 'Error al actualizar horarios');
    }
  }

  // 3. Upsert de los horarios enviados.
  if (input.horarios.length > 0) {
    const payload = input.horarios.map((h) => ({
      propietario_id: propietarioId,
      dia_semana: h.dia_semana,
      hora_inicio: h.hora_inicio,
      hora_fin: h.hora_fin,
      activo: h.activo ?? true,
      updated_at: new Date().toISOString(),
    }));

    const { error: upsertErr } = await db('disponibilidad_propietario')
      .upsert(payload as never, { onConflict: 'propietario_id,dia_semana' });

    if (upsertErr) {
      logger.error({ error: upsertErr.message, propietarioId }, 'Error al upsert horarios');
      throw new AppError(500, 'INTERNAL_ERROR', 'Error al guardar los horarios');
    }
  }

  logger.info({ propietarioId, dias: diasEnviados }, 'Disponibilidad actualizada');

  // Devolver el estado actualizado
  const refreshed = await getDisponibilidad(propietarioId);
  return {
    horarios: refreshed.horarios,
    configuracion: refreshed.configuracion,
  };
}

// ============================================================
// GET slots — desde inmueble (resuelve propietario internamente)
// ============================================================

export interface SlotEntry {
  inicio: string; // ISO
  fin: string; // ISO
}

export interface SlotsDia {
  fecha: string; // YYYY-MM-DD
  slots: SlotEntry[];
}

export async function getSlotsPorInmueble(
  inmuebleId: string,
  desde: string,
  hasta: string,
): Promise<SlotsDia[]> {
  // Resolver propietario del inmueble.
  const { data: inmuebleRow, error: inmErr } = await db('inmuebles')
    .select('propietario_id')
    .eq('id', inmuebleId)
    .maybeSingle();

  if (inmErr) {
    logger.error({ error: inmErr.message, inmuebleId }, 'Error al cargar inmueble para slots');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al cargar el inmueble');
  }

  if (!inmuebleRow) {
    throw AppError.notFound('Inmueble no encontrado');
  }

  const { propietario_id } = inmuebleRow as { propietario_id: string };

  // Invocar el RPC.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('fn_slots_disponibles', {
    p_propietario_id: propietario_id,
    p_fecha_desde: desde,
    p_fecha_hasta: hasta,
  });

  if (error) {
    logger.error(
      { error: error.message, inmuebleId, propietarioId: propietario_id, desde, hasta },
      'Error al calcular slots disponibles',
    );
    const msg = (error.message || '') as string;
    if (msg.includes('fecha_hasta') || msg.includes('Ventana')) {
      throw AppError.badRequest(msg, 'RANGO_INVALIDO');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al calcular los slots disponibles');
  }

  return (data as SlotsDia[]) ?? [];
}

// ============================================================
// Helper: ¿el slot está disponible? (anti-race para createCita)
// ============================================================

export async function slotEstaDisponible(
  propietarioId: string,
  inicioIso: string,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('fn_slot_esta_disponible', {
    p_propietario_id: propietarioId,
    p_inicio: inicioIso,
  });

  if (error) {
    logger.error(
      { error: error.message, propietarioId, inicioIso },
      'Error al verificar slot disponible',
    );
    // Fail-safe: si el RPC falla, rechazamos la cita (no dejamos pasar
    // por incertidumbre). Cliente ve el mismo mensaje que si el slot
    // realmente estuviera ocupado.
    return false;
  }

  return data === true;
}

/**
 * Contratos V3 — plazo de la reserva del inmueble mientras se elabora el
 * contrato (Adenda 1 del módulo de contratos, respuesta 15 y §5.6: cinco días
 * hábiles, con liberación automática y aviso a la inmobiliaria).
 *
 * El borrador ES la reserva: «Iniciar contrato» reserva el inmueble y crea la
 * fila, así que el plazo corre desde su created_at (reservaHasta). Vencido sin
 * enviar a firma, el barrido lo cancela por el camino de siempre (libera el
 * inmueble, historial y timeline) y avisa a quien lo inició y al responsable.
 * Al volver a iniciar, el asistente precarga lo que llevaba (Fuentes.anterior).
 */

import { getCalibracion } from '@/lib/calibracion';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { notificarYCorreo } from '@/modules/notificaciones/notificaciones.service';
import { cancelarBorradorV3PorSistema } from '../contrato-workflow.service';
import { reservaHasta } from './asistente.reglas';
import { fechaBogota } from './formato';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
const ddmmaaaa = (iso: string) => iso.split('-').reverse().join('/');

interface Borrador {
  id: string;
  numero: string;
  expediente_id: string;
  generado_por: string | null;
  created_at: string;
}

/** Cada hora (server.ts). Idempotente: la cancelación es un CAS sobre el estado. */
export async function barrerReservasV3(ahora = new Date()): Promise<void> {
  const dias = (await getCalibracion()).DIAS_RESERVA_INMUEBLE;
  const hoy = fechaBogota(ahora);
  // n días hábiles son al menos n calendario: lo iniciado después no puede estar vencido.
  const { data, error } = await db('contratos')
    .select('id, numero, expediente_id, generado_por, created_at')
    .not('destinacion', 'is', null)
    .eq('estado', 'borrador')
    .lt('created_at', new Date(ahora.getTime() - dias * 86_400_000).toISOString())
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) {
    logger.warn({ error: error.message }, 'barrerReservasV3: no se pudieron leer los borradores');
    return;
  }
  const plazo = `${dias} ${dias === 1 ? 'día hábil' : 'días hábiles'}`;
  for (const c of (data as Borrador[] | null) ?? []) {
    const hasta = reservaHasta(c.created_at, dias);
    if (hoy <= hasta) continue;
    try {
      if (await cancelarBorradorV3PorSistema(c.id, `Reserva del inmueble vencida: ${plazo} sin enviar a firma`))
        await avisar(c, hasta, plazo);
    } catch (e) {
      logger.warn({ contratoId: c.id, error: e instanceof Error ? e.message : String(e) }, 'barrerReservasV3: borrador sin cancelar');
    }
  }
}

/**
 * A quien inició el contrato y al responsable del estudio, si siguen activos en
 * la inmobiliaria (un exmiembro no recibe datos de la org); si no queda ninguno,
 * a los titulares. In-app y correo. Best-effort: el borrador ya se canceló.
 * ponytail: si el proceso cae entre la cancelación y este aviso, el aviso se pierde (queda el timeline).
 */
async function avisar(c: Borrador, hasta: string, plazo: string): Promise<void> {
  try {
    const { data: exp } = await db('expedientes')
      .select('numero, inmobiliaria_id, miembro_responsable_id')
      .eq('id', c.expediente_id)
      .maybeSingle();
    const e = exp as { numero: string; inmobiliaria_id: string | null; miembro_responsable_id: string | null } | null;
    if (!e?.inmobiliaria_id) return;
    const { data: miembros } = await db('inmobiliaria_miembros')
      .select('perfil_id, rol_miembro')
      .eq('inmobiliaria_id', e.inmobiliaria_id)
      .eq('estado', 'activo')
      .not('perfil_id', 'is', null);
    const activos = (miembros as { perfil_id: string; rol_miembro: string }[] | null) ?? [];
    const esActivo = (id: string | null): id is string => !!id && activos.some((m) => m.perfil_id === id);
    let ids = [...new Set([c.generado_por, e.miembro_responsable_id].filter(esActivo))];
    if (!ids.length) ids = activos.filter((m) => m.rol_miembro === 'owner').map((m) => m.perfil_id);
    for (const userId of ids)
      await notificarYCorreo({
        userId,
        tipo: 'contrato.reserva_vencida',
        titulo: `Se venció la reserva del inmueble — contrato ${c.numero}`,
        mensaje:
          `El contrato ${c.numero} del estudio ${e.numero} no se envió a firma en ${plazo} (la reserva iba hasta el ${ddmmaaaa(hasta)}). ` +
          'El borrador se canceló y el inmueble quedó libre, fuera de la vitrina. Si el arriendo sigue, inicia el contrato de nuevo: el asistente trae lo que ya llenaste.',
        link: `/expedientes/${c.expediente_id}/contrato`,
        payload: { contrato_id: c.id, expediente_id: c.expediente_id },
      });
  } catch (err) {
    logger.warn({ contratoId: c.id, error: err instanceof Error ? err.message : String(err) }, 'barrerReservasV3: no se pudo avisar');
  }
}

// ============================================================
// Coarrendatario VINCULADO a un expediente — lectura compartida
// ------------------------------------------------------------
// La prima de vinculacion (Adenda 1 §5.2: 20% solo / 10% con coarrendatario)
// y la fila de 2,5% (§5.1: zona gris con coarrendatario >= 80) dependen de si
// el expediente TIENE un coarrendatario, no del `tipo` de la fila de estudios:
// 'con_coarrendatario' es el tipo del estudio PROPIO del coarrendatario, asi
// que mirar el tipo del estudio del titular siempre decia "solo" y el CRC
// imprimia prima 20% aun con acompañante vinculado.
//
// Una sola lectura para el CRC (certificado.service) y para
// GET /estudios/:id/tarifa (tarifa-override.service). No importa nada de
// coarrendatarios.service para no cerrar un ciclo con el modulo de estudios.
// ============================================================

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

export interface CoarrendatarioVinculado {
  /** Fila de expediente_coarrendatarios. */
  id: string;
  nombre: string;
  /** Su estudio propio (tipo='con_coarrendatario'); null si aun no se creo. */
  estudioId: string | null;
  /**
   * Ultimo puntaje normalizado del scorecard de SU estudio. null si no hay
   * corrida, si su estudio no termino, o si termino rechazado (un
   * coarrendatario rechazado no es "coarrendatario >= 80 por flujo
   * automatico", que es lo que la fila de 2,5% exige).
   */
  puntaje: number | null;
}

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

/**
 * El coarrendatario vinculado al expediente: acepto la invitacion (tiene su
 * propia autorizacion y su estudio) y no la declino. Una invitacion todavia
 * pendiente NO vincula a nadie. Best-effort: ante un error de lectura devuelve
 * null (= "solo"), que es la cifra conservadora, y lo deja en el log.
 */
export async function coarrendatarioVinculado(expedienteId: string): Promise<CoarrendatarioVinculado | null> {
  try {
    const { data, error } = await db('expediente_coarrendatarios')
      .select('id, nombre, estudio_id')
      .eq('expediente_id', expedienteId)
      .in('estado', ['aceptado', 'estudio_completado'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      logger.warn({ expedienteId, error: error.message }, 'No se pudo leer el coarrendatario vinculado — se asume sin coarrendatario');
      return null;
    }
    const row = data as { id: string; nombre: string; estudio_id: string | null } | null;
    if (!row) return null;

    let puntaje: number | null = null;
    if (row.estudio_id) {
      const { data: est } = await db('estudios')
        .select('estado, resultado')
        .eq('id', row.estudio_id)
        .maybeSingle();
      const e = est as { estado?: string | null; resultado?: string | null } | null;
      if (e?.estado === 'completado' && e.resultado !== 'rechazado') {
        const { data: sombra } = await db('estudios_scorecard_sombra')
          .select('puntaje_normalizado')
          .eq('estudio_id', row.estudio_id)
          .order('fecha_calculo', { ascending: false })
          .limit(1)
          .maybeSingle();
        const raw = (sombra as { puntaje_normalizado?: number | string | null } | null)?.puntaje_normalizado;
        const n = raw === null || raw === undefined ? null : Number(raw);
        puntaje = n !== null && Number.isFinite(n) ? n : null;
      }
    }

    return { id: row.id, nombre: row.nombre, estudioId: row.estudio_id, puntaje };
  } catch (err) {
    logger.warn(
      { expedienteId, err: err instanceof Error ? err.message : String(err) },
      'Excepcion leyendo el coarrendatario vinculado — se asume sin coarrendatario',
    );
    return null;
  }
}

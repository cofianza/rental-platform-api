/**
 * Adenda 1 del módulo de contratos §2.4: por encima del tope de canon el
 * contrato se bloquea y el caso se escala a la Gerencia General para evaluar
 * coafianzamiento. El bloqueo vive en el asistente V3 (evaluarCanon) y en el
 * contrato del flujo anterior (assertCanonContratable); aquí va el aviso: una
 * sola vez por estudio a los administradores de Cofianza, con enlace al
 * estudio. La marca que deduplica es un evento del timeline del estudio, que
 * además deja a la vista de la inmobiliaria que el caso pasó a la Gerencia.
 * Nunca lanza: el bloqueo no depende del aviso.
 */

import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { formatearCOP } from '@/modules/estudios/tope-canon.guard';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;

// ponytail: exclusión solo dentro del proceso; con dos réplicas, dos cargas simultáneas del
// mismo estudio podrían avisar dos veces. Un índice único sobre la marca lo cerraría.
const enCurso = new Set<string>();

export async function escalarTopeCanon(expedienteId: string, canonCop: number, topeCop: number): Promise<void> {
  if (enCurso.has(expedienteId)) return;
  enCurso.add(expedienteId);
  try {
    const { data: ya, error } = await db('eventos_timeline')
      .select('id')
      .eq('expediente_id', expedienteId)
      .eq('metadata->>escalamiento', 'tope_canon')
      .limit(1);
    // Ya escalado, o no se pudo verificar: se reintenta en la próxima carga.
    if (error || (ya as unknown[] | null)?.length) return;

    const [expR, adminsR] = await Promise.all([
      db('expedientes').select('numero').eq('id', expedienteId).maybeSingle(),
      db('perfiles').select('id').eq('rol', 'administrador').eq('estado', 'activo'),
    ]);
    if (adminsR.error) throw new Error(adminsR.error.message);
    const numero = (expR.data as { numero?: string } | null)?.numero ?? '';
    const cifras = `un canon de ${formatearCOP(canonCop)}, por encima del tope de ${formatearCOP(topeCop)}`;
    const avisos = ((adminsR.data as { id: string }[] | null) ?? []).map(({ id }) => ({
      user_id: id,
      tipo: 'contrato.tope_canon',
      titulo: `Canon por encima del tope — estudio ${numero}`,
      mensaje: `El contrato del estudio ${numero} pacta ${cifras} que Cofianza afianza sin coafianzamiento. La inmobiliaria quedó bloqueada: la Gerencia General debe evaluar un coafianzamiento.`,
      link: `/expedientes/${expedienteId}`,
      payload: { expediente_id: expedienteId, canon_cop: canonCop, tope_cop: topeCop },
    }));
    // Sin aviso entregado no se marca: la próxima carga lo reintenta.
    if (!avisos.length) throw new Error('no hay administradores activos a quien avisar');
    const { error: nError } = await db('notificaciones').insert(avisos as never);
    if (nError) throw new Error(nError.message);
    const { error: tError } = await db('eventos_timeline').insert({
      expediente_id: expedienteId,
      tipo: 'contrato',
      descripcion: `El contrato pacta ${cifras}: el caso se envió a la Gerencia General de Cofianza para evaluar un coafianzamiento.`,
      usuario_id: null,
      metadata: { escalamiento: 'tope_canon', canon_cop: canonCop, tope_cop: topeCop },
    } as never);
    if (tError) throw new Error(tError.message);
  } catch (e) {
    logger.warn({ expedienteId, error: e instanceof Error ? e.message : String(e) }, 'Tope de canon: no se pudo escalar a la Gerencia');
  } finally {
    enCurso.delete(expedienteId);
  }
}

/**
 * Adenda 1 del módulo de contratos §2.4: por encima del tope de canon se
 * bloquea y el caso se escala a la Gerencia General para evaluar
 * coafianzamiento. Este es el escalamiento común, una vez por estudio, cuando
 * alguien intenta avanzar con ese canon: generar o enviar el contrato (asistente
 * V3 y flujo anterior) o habilitar o pagar la evaluación (assertCanonDentroDelTope).
 * Nunca al solo consultar o guardar un paso: un error de digitación no avisa a nadie.
 *
 * Orden: primero la marca en la línea de tiempo del estudio (deduplica y le
 * muestra a la inmobiliaria que el caso pasó a la Gerencia); sin marca no hay
 * aviso. Después el aviso a los administradores activos de Cofianza, en la app
 * y por correo; si no se pudo guardar, se retira la marca y el siguiente
 * intento lo repite. Responde si el caso está en la Gerencia (ahora o de
 * antes): de eso depende el mensaje del bloqueo. Nunca lanza.
 */

import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { enviarCorreoNotificacion } from '@/modules/notificaciones/notificaciones.service';
import { formatearCOP } from '@/modules/estudios/tope-canon.guard';
import { formatNumeroEstudio } from '@/lib/numeroEstudio';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;

/** Dónde chocó con el tope: el contrato, o la evaluación (habilitar o pagar). */
export type AmbitoTope = 'contrato' | 'estudio';

async function marcaExiste(expedienteId: string): Promise<boolean> {
  const { data, error } = await db('eventos_timeline')
    .select('id')
    .eq('expediente_id', expedienteId)
    .eq('metadata->>escalamiento', 'tope_canon')
    .limit(1);
  if (error) throw new Error(`no se pudo leer la marca: ${error.message}`);
  return !!(data as unknown[] | null)?.length;
}

/** ¿El caso ya se envió a la Gerencia? Solo lectura (GET, guardar un paso); ante un error, false. */
export async function topeYaEscalado(expedienteId: string): Promise<boolean> {
  return marcaExiste(expedienteId).catch(() => false);
}

// ponytail: exclusión solo dentro del proceso (dos intentos simultáneos comparten el mismo
// escalamiento); con dos réplicas podrían avisar dos veces. Un índice único sobre la marca lo cerraría.
const enCurso = new Map<string, Promise<boolean>>();

export function escalarTopeCanon(expedienteId: string, canonCop: number, topeCop: number, ambito: AmbitoTope): Promise<boolean> {
  let p = enCurso.get(expedienteId);
  if (!p) {
    p = escalar(expedienteId, canonCop, topeCop, ambito).finally(() => enCurso.delete(expedienteId));
    enCurso.set(expedienteId, p);
  }
  return p;
}

async function escalar(expedienteId: string, canonCop: number, topeCop: number, ambito: AmbitoTope): Promise<boolean> {
  try {
    if (await marcaExiste(expedienteId)) return true;
    const cifras = `${formatearCOP(canonCop)}, por encima del tope de ${formatearCOP(topeCop)} que Cofianza afianza sin coafianzamiento`;
    const { data: marca, error } = await db('eventos_timeline')
      .insert({
        expediente_id: expedienteId,
        tipo: 'contrato',
        descripcion: `Canon de ${cifras}: el caso se envió a la Gerencia General de Cofianza para evaluar un coafianzamiento.`,
        usuario_id: null,
        metadata: { escalamiento: 'tope_canon', canon_cop: canonCop, tope_cop: topeCop, ambito },
      } as never)
      .select('id')
      .single();
    if (error || !marca) throw new Error(`no se pudo dejar la marca: ${error?.message ?? 'sin fila'}`);

    let avisos: Array<{ user_id: string; tipo: string; titulo: string; mensaje: string; link: string; payload: Record<string, unknown> }>;
    try {
      const [expR, adminsR] = await Promise.all([
        db('expedientes').select('numero').eq('id', expedienteId).maybeSingle(),
        db('perfiles').select('id').eq('rol', 'administrador').eq('estado', 'activo'),
      ]);
      if (adminsR.error) throw new Error(adminsR.error.message);
      const numero = formatNumeroEstudio((expR.data as { numero?: string } | null)?.numero);
      const que =
        ambito === 'contrato'
          ? `El contrato del estudio ${numero} pacta un canon de ${cifras}.`
          : `La evaluación del estudio ${numero} es sobre un inmueble con canon de ${cifras}.`;
      avisos = ((adminsR.data as { id: string }[] | null) ?? []).map(({ id }) => ({
        user_id: id,
        tipo: 'contrato.tope_canon',
        titulo: `Canon por encima del tope — estudio ${numero}`,
        mensaje: `${que} Quedó bloqueado: la Gerencia General debe evaluar un coafianzamiento.`,
        link: `/expedientes/${expedienteId}`,
        payload: { expediente_id: expedienteId, canon_cop: canonCop, tope_cop: topeCop, ambito },
      }));
      if (!avisos.length) throw new Error('no hay administradores activos a quien avisar');
      const { error: nError } = await db('notificaciones').insert(avisos as never);
      if (nError) throw new Error(nError.message);
    } catch (e) {
      // Sin aviso no queda marca: el caso no está en la Gerencia y el siguiente intento lo repite.
      const { error: delError } = await db('eventos_timeline').delete().eq('id', (marca as { id: string }).id);
      if (delError) logger.error({ expedienteId, error: delError.message }, 'Tope de canon: quedó la marca sin aviso a la Gerencia');
      throw e;
    }
    for (const { user_id: userId, ...aviso } of avisos) await enviarCorreoNotificacion({ userId, ...aviso });
    return true;
  } catch (e) {
    logger.warn({ expedienteId, error: e instanceof Error ? e.message : String(e) }, 'Tope de canon: no se pudo escalar a la Gerencia');
    return false;
  }
}

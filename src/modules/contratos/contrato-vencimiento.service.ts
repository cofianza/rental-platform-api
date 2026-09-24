import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { notificarUsuario, findPerfilIdByEmail } from '../notificaciones/notificaciones.service';
import { fechaBogota, periodoVigente } from './v3/formato';

// Tope de contratos por ciclo. Si se alcanza, el resto se procesa en el
// siguiente ciclo (se loguea para no esconder el truncamiento).
const BATCH_LIMIT = 200;

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

interface ContratoVencido {
  id: string;
  expediente_id: string;
  fecha_inicio: string | null;
  fecha_fin: string;
  duracion_meses: number | null;
}

/**
 * Job de vencimiento (P11/P20): un contrato 'vigente' del flujo anterior cuya
 * fecha_fin (DATE) ya pasó en hora Colombia se PRORROGA por el mismo término
 * con la fianza vigente (plantilla V4, Cláusula Cuarta Parágrafo Primero; Ley
 * 820 de 2003, art. 6): corre fecha_fin, deja constancia en el historial del
 * contrato y avisa. Terminarlo es la transición manual vigente → finalizado,
 * con motivo; mientras siga vigente se le puede reportar mora. Los V3 no pasan
 * por aquí (se prorrogan solos por período).
 *
 * Estrictamente menor que hoy: un contrato que termina HOY sigue en su período
 * hasta fin del día. Cada contrato va aislado en try-catch.
 */
export async function prorrogarContratosVencidos(): Promise<{ revisados: number; prorrogados: number }> {
  const hoy = fechaBogota(new Date());

  const { data, error } = await db('contratos')
    .select('id, expediente_id, fecha_inicio, fecha_fin, duracion_meses')
    .eq('estado', 'vigente')
    .is('destinacion', null)
    .not('fecha_fin', 'is', null)
    .lt('fecha_fin', hoy)
    .order('fecha_fin', { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    logger.error({ error: error.message }, 'prorrogarContratosVencidos: error consultando contratos');
    return { revisados: 0, prorrogados: 0 };
  }

  const vencidos = (data ?? []) as ContratoVencido[];
  let prorrogados = 0;
  for (const c of vencidos) {
    try {
      if (await prorrogarContrato(c, hoy)) prorrogados += 1;
    } catch (err) {
      logger.warn({ err, contratoId: c.id }, 'prorrogarContratosVencidos: error prorrogando contrato');
    }
  }

  if (vencidos.length === BATCH_LIMIT) {
    logger.warn(
      { batch: BATCH_LIMIT },
      'prorrogarContratosVencidos: se alcanzo el limite de lote; el resto se procesara en el proximo ciclo',
    );
  }

  logger.info({ revisados: vencidos.length, prorrogados, hoy }, 'prorrogarContratosVencidos: ciclo completado');
  return { revisados: vencidos.length, prorrogados };
}

/** true si lo prorrogó; false si otro proceso lo terminó o ya lo corrió. */
async function prorrogarContrato(c: ContratoVencido, hoy: string): Promise<boolean> {
  // Desde el inicio con múltiplos del término (art. 67 C.C.): encadenar desde
  // fecha_fin volvería un 31 en 28 para siempre. Sin inicio o término válido
  // lanza y el contrato queda como está (nunca se finaliza por esto).
  const { hasta, prorrogas } = periodoVigente(c.fecha_inicio ?? '', c.duracion_meses ?? 0, hoy);

  // CAS: si entretanto lo terminaron o ya lo corrió otra instancia, no se toca.
  const { data, error } = await db('contratos')
    .update({ fecha_fin: hasta } as never)
    .eq('id', c.id)
    .eq('estado', 'vigente')
    .eq('fecha_fin', c.fecha_fin)
    .select('id');
  if (error) throw new Error(error.message);
  if (!(data as unknown[] | null)?.length) return false;

  const fecha = hasta.split('-').reverse().join('/');
  const constancia =
    `Prórroga automática por el mismo término (${c.duracion_meses} meses): el contrato vence ahora el ${fecha}. ` +
    'Cláusula Cuarta, Parágrafo Primero; Ley 820 de 2003, art. 6.';
  const { error: histError } = await db('contrato_historial_estados').insert({
    contrato_id: c.id,
    estado_anterior: 'vigente',
    estado_nuevo: 'vigente',
    descripcion: constancia,
    comentario: constancia,
    usuario_id: null,
  } as never);
  if (histError) logger.warn({ contratoId: c.id, error: histError.message }, 'No se registró la prórroga en el historial');

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.CONTRATO_PRORROGADO,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: c.id,
    detalle: { fecha_fin_anterior: c.fecha_fin, fecha_fin: hasta, prorrogas, automatico: true },
  });

  avisarProrroga(c, fecha).catch((e) => logger.warn({ error: e, contratoId: c.id }, 'Error avisando la prórroga del contrato'));
  logger.info({ contratoId: c.id, desde: c.fecha_fin, hasta }, 'Contrato prorrogado automáticamente');
  return true;
}

/** Al dueño del inmueble y al arrendatario, como el aviso de «Contrato vigente». */
async function avisarProrroga(c: ContratoVencido, fecha: string): Promise<void> {
  const { data: exp } = await db('expedientes').select('solicitante_id, inmueble_id').eq('id', c.expediente_id).maybeSingle();
  const e = exp as { solicitante_id: string | null; inmueble_id: string | null } | null;
  if (!e) return;
  const { data: inm } = await db('inmuebles').select('direccion, propietario_id').eq('id', e.inmueble_id).maybeSingle();
  const i = inm as { direccion: string | null; propietario_id: string | null } | null;
  const direccion = i?.direccion ?? 'el inmueble';
  const aviso = { tipo: 'contrato.prorrogado', link: `/contratos/${c.id}`, payload: { contrato_id: c.id, expediente_id: c.expediente_id } };

  if (i?.propietario_id) {
    await notificarUsuario({
      ...aviso,
      userId: i.propietario_id,
      titulo: 'Contrato prorrogado',
      mensaje: `El contrato de ${direccion} llegó a su vencimiento y se prorrogó automáticamente por el mismo término, hasta el ${fecha}. Si no debe continuar, termínalo indicando el motivo.`,
    });
  }
  if (e.solicitante_id) {
    const { data: sol } = await db('solicitantes').select('email').eq('id', e.solicitante_id).maybeSingle();
    const userId = await findPerfilIdByEmail((sol as { email: string | null } | null)?.email);
    if (userId) {
      await notificarUsuario({
        ...aviso,
        userId,
        titulo: 'Tu contrato se prorrogó',
        mensaje: `Tu contrato de ${direccion} se prorrogó automáticamente por el mismo término, hasta el ${fecha}.`,
      });
    }
  }
}

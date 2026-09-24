/**
 * Devolución de la evaluación (P1; Flujo §4.3, §11 y §12; C. Civil 1546; Ley
 * 1480 art. 47 y 51): el estudio que se cierra o se rechaza ya pagado y sin
 * consulta al buró se le devuelve a quien pagó, por el mismo medio. El crédito
 * del paquete vuelve solo al saldo. Lo demás no se devuelve sin una persona:
 * queda en la cola de reembolsos (pagos_no_conciliados, la misma del dinero que
 * entra sin cobro), donde un administrador lo reembolsa en Mercado Pago o lo
 * marca resuelto con una nota. Si ya hubo consulta no se devuelve: para
 * conservar el pago está la reasignación a otro inmueble (§4.3).
 *
 * Estados de una fila de la cola (estado_proveedor): 'completed' = por
 * resolver; 'reembolso_en_proceso' = reembolso pedido a Mercado Pago que aún no
 * se aprueba; 'refunded' = Mercado Pago confirmó el reembolso (resuelta).
 */

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { getPaymentGateway } from './gateway';
import { transitionPagoStateChecked } from './pago-state-machine';
import {
  avisarAdministradores,
  avisarNotaCredito,
  cancelarPagosPendientesDeExpediente,
  MOTIVO_NO_CONCILIADO,
  MOTIVOS_SIN_REEMBOLSO,
  reconcileMercadoPagoPayment,
  registrarPagoNoConciliado,
} from './pagos.service';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
const cop = (n: number) => `$${n.toLocaleString('es-CO')}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ahoraBogota = () => new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

// ============================================================
// ¿Se consultó el buró?
// ============================================================

/** Estados de la evaluación en los que el buró todavía no se consultó. */
const ESTADOS_PREVIOS_A_LA_CONSULTA = [
  'solicitado',
  'pago_pendiente',
  'pagado',
  'autorizado',
  'formulario_enviado',
  'formulario_completado',
  'documentos_cargados',
];

/**
 * 'si': alguna evaluación llegó al buró (en proceso, completada o con
 * referencia del proveedor); 'dudosa': solo hay evaluaciones fallidas sin
 * referencia (no se sabe si la central cobró); 'no': ninguna llegó.
 */
export type Consulta = 'si' | 'no' | 'dudosa';

export function consultaDe(estudios: Array<{ estado: string; referencia_proveedor: string | null }>): Consulta {
  if (estudios.some((e) => e.estado === 'en_proceso' || e.estado === 'completado' || !!e.referencia_proveedor)) return 'si';
  return estudios.some((e) => e.estado === 'fallido') ? 'dudosa' : 'no';
}

async function leerEstudios(expedienteId: string) {
  const { data, error } = await db('estudios').select('id, estado, referencia_proveedor').eq('expediente_id', expedienteId);
  if (error) throw fromSupabaseError(error);
  return (data ?? []) as Array<{ id: string; estado: string; referencia_proveedor: string | null }>;
}

export async function huboConsultaAlBuro(expedienteId: string): Promise<Consulta> {
  return consultaDe(await leerEstudios(expedienteId));
}

/**
 * Cancela, con compare-and-set, las evaluaciones del expediente que todavía no
 * llegaron al buró, y la fallida sin referencia (así no se reintenta después de
 * devolverla): es lo que excluye a ejecutarEstudio, cuyo bloqueo a 'en_proceso'
 * falla si la evaluación ya se movió. Si alguna se movió mientras tanto se
 * vuelve a leer; si nunca se estabiliza, queda como dudosa. La fallida sigue
 * siendo dudosa aunque ya esté cancelada: no se sabe si la central cobró.
 */
async function cancelarEvaluacionesSinConsulta(expedienteId: string): Promise<Consulta> {
  let huboFallida = false;
  for (let intento = 0; intento < 3; intento++) {
    const estudios = await leerEstudios(expedienteId);
    const consulta = consultaDe(estudios);
    if (consulta === 'si') return consulta;
    if (consulta === 'dudosa') huboFallida = true;
    let seMovio = false;
    const sinConsulta = estudios.filter(
      (x) => ESTADOS_PREVIOS_A_LA_CONSULTA.includes(x.estado) || (x.estado === 'fallido' && !x.referencia_proveedor),
    );
    for (const e of sinConsulta) {
      const { data } = await db('estudios')
        .update({ estado: 'cancelado' } as never)
        .eq('id', e.id)
        .eq('estado', e.estado)
        .select('id');
      if (!(data as unknown[] | null)?.length) seMovio = true;
    }
    if (!seMovio) return huboFallida ? 'dudosa' : consulta;
  }
  return 'dudosa';
}

// ============================================================
// Al cerrar o rechazar un estudio
// ============================================================

interface PagoEstudio {
  id: string;
  monto: number | string;
  metodo: string | null;
  transaction_ref: string | null;
  gateway_response: unknown;
}

const PAGO_SELECT = 'id, monto, metodo, transaction_ref, gateway_response';

async function timeline(expedienteId: string, descripcion: string, metadata: Record<string, unknown>): Promise<void> {
  const { error } = await db('eventos_timeline').insert({
    expediente_id: expedienteId,
    tipo: 'pago',
    descripcion,
    metadata: { ...metadata, origen: 'system' },
  } as never);
  if (error) logger.warn({ expedienteId, error: error.message }, 'No se pudo dejar la devolución en el timeline');
}

/**
 * Deja el cobro de la evaluación en la cola de reembolsos y avisa a los
 * administradores la primera vez. El de Mercado Pago queda con su payment; el
 * de crédito o el registrado a mano, con `pago:<id>` (se resuelve a mano).
 */
async function encolar(pago: PagoEstudio, expedienteId: string, motivo: string, esCredito = false): Promise<void> {
  const raw = (pago.gateway_response && typeof pago.gateway_response === 'object' ? pago.gateway_response : {}) as Record<
    string,
    unknown
  >;
  const enMp = pago.metodo === 'pasarela' && !!pago.transaction_ref;
  const ok = await registrarPagoNoConciliado(
    enMp ? (pago.transaction_ref as string) : `pago:${pago.id}`,
    (typeof raw.external_reference === 'string' && raw.external_reference) || `estudio:${expedienteId}:${pago.id}`,
    {
      status: 'completed',
      rawResponse: { ...raw, transaction_amount: typeof raw.transaction_amount === 'number' ? raw.transaction_amount : Number(pago.monto) },
    },
    motivo,
    enMp ? 'mercadopago' : esCredito ? 'credito' : 'manual',
  );
  if (!ok) throw new AppError(500, 'REEMBOLSO_NO_REGISTRADO', 'No se pudo dejar el pago en la cola de reembolsos');
}

/**
 * Al cerrar o rechazar un estudio: los cobros de la evaluación que siguen vivos
 * se cancelan (su enlace deja de ser pagable) y, si ya se pagó, se cancelan las
 * evaluaciones que no llegaron al buró y se devuelve. Si la única consulta
 * falló, queda en la cola para revisión. Nunca lanza: la transición ya quedó;
 * si algo falla, se avisa a los administradores para revisarlo a mano.
 * Idempotente: el crédito y la cola no se repiten.
 */
export async function devolverEvaluacionSinConsulta(
  expedienteId: string,
  motivo: string,
  usuarioId: string | null,
  /** El barrido no avisa si falla (lo reintentaría y avisaría cada 15 min): solo lo registra. */
  avisarSiFalla = true,
): Promise<void> {
  try {
    await cancelarPagosPendientesDeExpediente(expedienteId, motivo, ['estudio'], ['pendiente', 'procesando', 'fallido']);
    const { data, error } = await db('pagos')
      .select(PAGO_SELECT)
      .eq('expediente_id', expedienteId)
      .eq('concepto', 'estudio')
      .eq('estado', 'completado')
      .maybeSingle();
    if (error) throw fromSupabaseError(error);
    const pago = data as PagoEstudio | null;
    if (!pago) return;

    const consulta = await cancelarEvaluacionesSinConsulta(expedienteId);
    if (consulta === 'si') return;

    const { devolverCreditoDePago, esPagoConCredito } = await import('@/modules/creditos-estudios/creditos-estudios.service');
    if (consulta === 'dudosa') {
      await encolar(pago, expedienteId, 'estudio_fallido_revisar', await esPagoConCredito(pago.id));
      await timeline(
        expedienteId,
        'El estudio terminó con la consulta al buró fallida: Cofianza revisa si se devuelve la evaluación.',
        { pago_id: pago.id, evento: 'reembolso_en_revision' },
      );
      return;
    }

    const credito = await devolverCreditoDePago(pago.id, motivo, usuarioId);
    if (credito === 'ya_devuelto') return;
    if (credito === 'devuelto') {
      await timeline(
        expedienteId,
        'El crédito con que se pagó la evaluación volvió al saldo de la inmobiliaria: el estudio terminó sin consultar el buró.',
        { pago_id: pago.id, evento: 'evaluacion_devuelta', medio: 'credito' },
      );
      return;
    }
    // Mercado Pago: la reembolsa un administrador. A mano (transferencia,
    // efectivo o cheque): se devuelve por el mismo medio y se marca resuelta.
    await encolar(pago, expedienteId, 'estudio_cerrado_sin_consulta');
    await timeline(
      expedienteId,
      pago.metodo === 'pasarela'
        ? 'La evaluación estaba pagada y el estudio terminó sin consultar el buró: Cofianza le devolverá el pago a quien pagó, por Mercado Pago.'
        : 'La evaluación estaba pagada y el estudio terminó sin consultar el buró: Cofianza le devolverá el pago a quien pagó.',
      { pago_id: pago.id, evento: 'reembolso_pendiente', medio: pago.metodo },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, expedienteId }, 'No se pudo revisar la devolución de la evaluación del estudio');
    if (!avisarSiFalla) return;
    await avisarAdministradores({
      tipo: 'pago.reembolso_pendiente',
      titulo: 'Revisar la devolución de una evaluación',
      mensaje: `El estudio terminó y no se pudo revisar si hay que devolver su evaluación (${msg}). Si estaba pagada y el buró no se consultó, hay que devolvérsela a quien pagó.`,
      link: `/expedientes/${expedienteId}`,
      payload: { expediente_id: expedienteId },
    }).catch((e) => logger.warn({ e, expedienteId }, 'No se pudo avisar de la devolución'));
  }
}

/**
 * El pago de la evaluación entró con el estudio ya cerrado o rechazado y sin
 * consulta al buró: queda para devolver en vez de seguir al orquestador (que lo
 * facturaría). true si lo retuvo.
 */
export async function retenerPagoTardio(pagoId: string, expedienteId: string): Promise<boolean> {
  const { data: exp } = await db('expedientes').select('estado').eq('id', expedienteId).maybeSingle();
  const estado = (exp as { estado?: string } | null)?.estado;
  if (estado !== 'cerrado' && estado !== 'rechazado') return false;
  try {
    const consulta = await cancelarEvaluacionesSinConsulta(expedienteId);
    if (consulta === 'si') return false;
    const { data } = await db('pagos').select(PAGO_SELECT).eq('id', pagoId).maybeSingle();
    const pago = data as PagoEstudio | null;
    if (!pago?.transaction_ref) return false;
    await encolar(pago, expedienteId, consulta === 'dudosa' ? 'estudio_fallido_revisar' : 'estudio_cerrado_sin_consulta');
    await timeline(
      expedienteId,
      'Entró el pago de la evaluación con el estudio ya terminado y sin consultar el buró: Cofianza se lo devolverá a quien pagó.',
      { pago_id: pagoId, evento: 'reembolso_pendiente', medio: 'pasarela', pago_tardio: true },
    );
  } catch (err) {
    logger.error({ err, pagoId, expedienteId }, 'Pago tardío de una evaluación: no se pudo dejar para devolver');
    await avisarAdministradores({
      tipo: 'pago.reembolso_pendiente',
      titulo: 'Revisar un pago tardío de evaluación',
      mensaje: 'Entró el pago de la evaluación de un estudio ya terminado y no quedó en la cola de reembolsos. Revísalo en Mercado Pago y devuélvelo si el buró no se consultó.',
      link: `/expedientes/${expedienteId}`,
      payload: { expediente_id: expedienteId, pago_id: pagoId },
    }).catch((e) => logger.warn({ e, pagoId }, 'No se pudo avisar del pago tardío'));
  }
  return true;
}

// ============================================================
// Cola de reembolsos del administrador
// ============================================================

interface FilaReembolso {
  id: string;
  proveedor: string;
  provider_payment_id: string;
  external_reference: string | null;
  monto: number | string | null;
  motivo: string;
  notas: string | null;
  resuelto: boolean;
  estado_proveedor: string | null;
  created_at: string;
}

const FILA_SELECT =
  'id, proveedor, provider_payment_id, external_reference, monto, motivo, notas, resuelto, estado_proveedor, created_at';
const EN_PROCESO = 'reembolso_en_proceso';

const puedeReembolsar = (f: FilaReembolso) =>
  f.proveedor === 'mercadopago' && f.estado_proveedor === 'completed' && !MOTIVOS_SIN_REEMBOLSO.includes(f.motivo);

/** Lo que hay que devolver o resolver, lo más nuevo primero. */
export async function listReembolsosPendientes() {
  const { data, error } = await db('pagos_no_conciliados')
    .select(FILA_SELECT)
    .eq('resuelto', false)
    .in('estado_proveedor', ['completed', EN_PROCESO])
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw fromSupabaseError(error);
  const filas = (data ?? []) as FilaReembolso[];

  const expIds = [...new Set(filas.map((f) => f.external_reference?.split(':')[1] ?? '').filter((id) => UUID.test(id)))];
  const numeros = new Map<string, string>();
  if (expIds.length > 0) {
    const { data: exps } = await db('expedientes').select('id, numero').in('id', expIds);
    for (const e of (exps ?? []) as Array<{ id: string; numero: string }>) numeros.set(e.id, e.numero);
  }

  return filas.map((f) => {
    const [concepto, expId] = (f.external_reference ?? '').split(':');
    return {
      id: f.id,
      proveedor: f.proveedor,
      monto: f.monto === null ? null : Number(f.monto),
      motivo: f.motivo,
      motivo_texto: MOTIVO_NO_CONCILIADO[f.motivo] ?? f.motivo,
      provider_payment_id: f.provider_payment_id,
      concepto: concepto || null,
      expediente: expId && numeros.has(expId) ? { id: expId, numero: numeros.get(expId)! } : null,
      notas: f.notas,
      en_proceso: f.estado_proveedor === EN_PROCESO,
      puede_reembolsar: puedeReembolsar(f),
      created_at: f.created_at,
    };
  });
}

async function leerFila(filaId: string): Promise<FilaReembolso> {
  const { data, error } = await db('pagos_no_conciliados').select(FILA_SELECT).eq('id', filaId).maybeSingle();
  if (error) throw fromSupabaseError(error);
  const fila = data as FilaReembolso | null;
  if (!fila) throw AppError.notFound('Reembolso no encontrado');
  if (fila.resuelto) throw AppError.conflict('Este pago ya se reembolsó o se resolvió.', 'REEMBOLSO_RESUELTO');
  if (fila.estado_proveedor === EN_PROCESO) {
    throw AppError.conflict('El reembolso de este pago está en proceso en Mercado Pago.', 'REEMBOLSO_EN_CURSO');
  }
  return fila;
}

/**
 * El cobro de la fila: el que se pagó con ESTE payment de Mercado Pago, o el de
 * `pago:<id>`. Un pago duplicado o de otro estudio trae en la referencia un
 * cobro que se pagó con otro payment: ese cobro no se toca.
 */
async function pagoDeLaFila(f: FilaReembolso) {
  const pagoId = f.provider_payment_id.startsWith('pago:') ? f.provider_payment_id.slice(5) : null;
  const q = db('pagos').select('id, expediente_id, estado');
  const { data } = await (pagoId ? q.eq('id', pagoId) : q.eq('transaction_ref', f.provider_payment_id)).limit(1).maybeSingle();
  return data as { id: string; expediente_id: string; estado: string } | null;
}

/** La consulta al buró del estudio de la fila; sin estudio que mirar, se asume que sí hubo. */
async function consultaDeLaFila(f: FilaReembolso, pago: { expediente_id: string } | null): Promise<Consulta> {
  const expedienteId = pago?.expediente_id ?? f.external_reference?.split(':')[1];
  return expedienteId && UUID.test(expedienteId) ? huboConsultaAlBuro(expedienteId) : 'si';
}

/** El cobro pasa a 'reembolsado'; si ya tenía factura, queda el aviso de su nota crédito. */
async function reembolsarCobro(
  pago: { id: string; expediente_id: string; estado: string },
  detalles: Record<string, unknown>,
  descripcion: string,
  user: { id: string },
  ip?: string,
): Promise<string | null> {
  if (pago.estado !== 'completado') return null;
  const { transitioned } = await transitionPagoStateChecked({
    pagoId: pago.id,
    targetEstado: 'reembolsado',
    origen: 'manual',
    detalles,
    userId: user.id,
    ip,
  });
  if (!transitioned) return null;
  await timeline(pago.expediente_id, descripcion, { pago_id: pago.id, evento: 'reembolsado' });
  return avisarNotaCredito(pago.id, user.id);
}

/**
 * «Reembolsar en Mercado Pago»: devuelve el pago completo por el refund del
 * adaptador. Toma la fila con compare-and-set (un solo administrador a la vez)
 * y Mercado Pago recibe siempre la misma llave de idempotencia para el pago.
 * La fila queda resuelta cuando el reembolso se aprueba; si queda en proceso,
 * la cierra el webhook o la conciliación. Queda en la fila (quién, cuándo, id
 * del reembolso), en la bitácora y en el historial del cobro.
 */
export async function reembolsarEnMercadoPago(filaId: string, user: { id: string; email?: string }, ip?: string) {
  const fila = await leerFila(filaId);
  const gateway = getPaymentGateway();
  if (gateway.provider !== 'mercadopago' || !puedeReembolsar(fila)) {
    throw AppError.conflict('Este pago no se reembolsa por Mercado Pago: resuélvelo a mano y márcalo resuelto.', 'REEMBOLSO_NO_APLICA');
  }
  const pago = await pagoDeLaFila(fila);
  // Si la evaluación llegó al buró después de encolarse, ya no se devuelve. La
  // dudosa (la única consulta había fallido) tampoco si al final sí se consultó.
  if (fila.motivo === 'estudio_cerrado_sin_consulta' || fila.motivo === 'estudio_fallido_revisar') {
    const consulta = await consultaDeLaFila(fila, pago);
    if (consulta === 'si' || (fila.motivo === 'estudio_cerrado_sin_consulta' && consulta !== 'no')) {
      throw AppError.conflict(
        'La evaluación de este estudio llegó al buró: no se devuelve. Revísalo y márcalo resuelto con una nota.',
        'CONSULTA_AL_BURO',
      );
    }
  }

  // Manda el estado real. Lo que Mercado Pago ya devolvió (desde su panel, con
  // el webhook perdido) se procesa como su webhook: cierra la fila y, si es el
  // payment del cobro, el cobro pasa a reembolsado (y no queda por facturar).
  const status = await gateway.getPaymentStatus(fila.provider_payment_id);
  if (status.status === 'refunded') {
    await reconcileMercadoPagoPayment(fila.provider_payment_id);
    return { estado: 'ya_reembolsado' as const, refund_id: null, factura_numero: null };
  }
  if (status.status !== 'completed') {
    throw AppError.conflict('Mercado Pago no tiene este pago aprobado: no hay nada que reembolsar.', 'PAGO_NO_REEMBOLSABLE');
  }

  const quien = user.email ?? user.id;
  const { data: tomada } = await db('pagos_no_conciliados')
    .update({ estado_proveedor: EN_PROCESO, notas: `Reembolso solicitado por ${quien} el ${ahoraBogota()}.`, updated_at: new Date().toISOString() } as never)
    .eq('id', fila.id)
    .eq('resuelto', false)
    .eq('estado_proveedor', 'completed')
    .select('id');
  if (!(tomada as unknown[] | null)?.length) {
    throw AppError.conflict('Otro administrador ya está reembolsando este pago.', 'REEMBOLSO_EN_CURSO');
  }

  // ponytail: la llave de idempotencia es fija por payment (refund-<id>-full):
  // si Mercado Pago rechaza un reembolso, repetirlo devuelve el mismo rechazo;
  // el segundo intento se hace desde su panel.
  let refund;
  try {
    refund = await gateway.refund(fila.provider_payment_id);
    if (refund.status === 'failed') throw new Error(`Mercado Pago no aprobó el reembolso ${refund.refundId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db('pagos_no_conciliados')
      .update({ estado_proveedor: 'completed', notas: `Falló el reembolso (${quien}): ${msg}`, updated_at: new Date().toISOString() } as never)
      .eq('id', fila.id);
    throw new AppError(502, 'REEMBOLSO_FALLIDO', `No se pudo reembolsar en Mercado Pago: ${msg}`);
  }

  const enProceso = refund.status === 'pending';
  await db('pagos_no_conciliados')
    .update({
      ...(enProceso ? {} : { resuelto: true, estado_proveedor: 'refunded' }),
      notas: `${enProceso ? 'Reembolso en proceso en Mercado Pago' : 'Reembolsado en Mercado Pago'} (reembolso ${refund.refundId}), pedido por ${quien} el ${ahoraBogota()}.`,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', fila.id);

  logAudit({
    usuarioId: user.id,
    accion: AUDIT_ACTIONS.PAGO_REFUNDED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago?.id ?? fila.id,
    detalle: {
      pago_no_conciliado_id: fila.id,
      provider_payment_id: fila.provider_payment_id,
      refund_id: refund.refundId,
      estado_reembolso: refund.status,
      monto: fila.monto,
      motivo: fila.motivo,
    },
    ip,
  });

  // Con el reembolso en proceso, el cobro cambia cuando Mercado Pago lo confirme.
  const facturaNumero =
    pago && !enProceso
      ? await reembolsarCobro(
          pago,
          { refund_id: refund.refundId, reembolsado_por: user.id },
          `Cofianza reembolsó ${fila.monto === null ? 'el pago' : cop(Number(fila.monto))} en Mercado Pago a quien pagó.`,
          user,
          ip,
        )
      : null;

  return { estado: enProceso ? ('en_proceso' as const) : ('reembolsado' as const), refund_id: refund.refundId, factura_numero: facturaNumero };
}

/**
 * «Marcar resuelto»: cierra una fila sin llamar a Mercado Pago, con una nota
 * (devolución hecha a mano o desde el panel de Mercado Pago, pago conciliado a
 * mano, caso revisado). Si la fila era la evaluación de un estudio que terminó
 * sin consulta, su cobro pasa a reembolsado.
 */
export async function resolverReembolso(filaId: string, nota: string, user: { id: string; email?: string }, ip?: string) {
  const fila = await leerFila(filaId);
  const quien = user.email ?? user.id;
  const { data: tomada } = await db('pagos_no_conciliados')
    .update({
      resuelto: true,
      notas: `Resuelto a mano por ${quien} el ${ahoraBogota()}: ${nota}`,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', fila.id)
    .eq('resuelto', false)
    .eq('estado_proveedor', 'completed')
    .select('id');
  if (!(tomada as unknown[] | null)?.length) {
    throw AppError.conflict('Otro administrador ya está resolviendo este pago.', 'REEMBOLSO_EN_CURSO');
  }
  const pago = await pagoDeLaFila(fila);
  logAudit({
    usuarioId: user.id,
    accion: AUDIT_ACTIONS.PAGO_REEMBOLSO_RESUELTO,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago?.id ?? fila.id,
    detalle: { pago_no_conciliado_id: fila.id, motivo: fila.motivo, nota },
    ip,
  });
  // El cobro pasa a reembolsado solo si es la evaluación de un estudio que no
  // llegó al buró: si al final se consultó, la fila se cierra y el cobro queda.
  const devolvioLaEvaluacion =
    !!pago && fila.motivo === 'estudio_cerrado_sin_consulta' && (await consultaDeLaFila(fila, pago)) !== 'si';
  const facturaNumero =
    pago && devolvioLaEvaluacion
      ? await reembolsarCobro(
          pago,
          { resuelto_a_mano_por: user.id, nota },
          `Cofianza devolvió la evaluación a quien pagó: ${nota}`,
          user,
          ip,
        )
      : null;
  return { estado: 'resuelto' as const, factura_numero: facturaNumero };
}

// ============================================================
// Barridos (corren con la conciliación de pagos)
// ============================================================

/**
 * Reembolsos que quedaron en proceso: si Mercado Pago ya lo devolvió, se
 * procesa como el webhook (cierra la fila y el cobro); si lo rechazó o nunca
 * llegó, la fila vuelve a quedar por resolver y se avisa.
 */
export async function revisarReembolsosEnProceso(): Promise<number> {
  const gateway = getPaymentGateway();
  if (gateway.provider !== 'mercadopago') return 0;
  const hace15 = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data, error } = await db('pagos_no_conciliados')
    .select(FILA_SELECT)
    .eq('resuelto', false)
    .eq('estado_proveedor', EN_PROCESO)
    .lte('updated_at', hace15)
    .limit(50);
  if (error) {
    logger.error({ error: error.message }, 'revisarReembolsosEnProceso: no se pudo leer la cola');
    return 0;
  }
  let revisadas = 0;
  for (const f of (data ?? []) as FilaReembolso[]) {
    try {
      const status = await gateway.getPaymentStatus(f.provider_payment_id);
      if (status.status === 'refunded') {
        await reconcileMercadoPagoPayment(f.provider_payment_id);
        revisadas++;
        continue;
      }
      const refunds = ((status.rawResponse as { refunds?: Array<{ id?: unknown; status?: string }> }).refunds ?? []);
      const ultimo = refunds[refunds.length - 1];
      if (ultimo && ultimo.status !== 'rejected' && ultimo.status !== 'cancelled') continue; // sigue en proceso
      const porque = ultimo ? `Mercado Pago ${ultimo.status === 'rejected' ? 'rechazó' : 'canceló'} el reembolso ${String(ultimo.id ?? '')}` : 'El reembolso no quedó en Mercado Pago';
      await db('pagos_no_conciliados')
        .update({ estado_proveedor: 'completed', notas: `${porque}: el pago sigue por devolver.`, updated_at: new Date().toISOString() } as never)
        .eq('id', f.id)
        .eq('estado_proveedor', EN_PROCESO);
      await avisarAdministradores({
        tipo: 'pago.reembolso_pendiente',
        titulo: 'Un reembolso no se completó',
        mensaje: `${porque} (pago ${f.provider_payment_id}${f.monto === null ? '' : `, ${cop(Number(f.monto))}`}). Sigue por devolver en Pagos a Cofianza › Reembolsos.`,
        link: '/facturacion?tab=reembolsos',
        payload: { pago_no_conciliado_id: f.id, provider_payment_id: f.provider_payment_id },
      });
      revisadas++;
    } catch (err) {
      logger.warn({ err, filaId: f.id }, 'revisarReembolsosEnProceso: no se pudo revisar la fila');
    }
  }
  return revisadas;
}

/** Q5b-6: el barrido no actúa hacia atrás: solo estudios terminados desde este cambio. */
const CORTE_BARRIDO = '2026-09-24T00:00:00-05:00';

/**
 * Red de seguridad de P1: estudios cerrados o rechazados hace poco con la
 * evaluación pagada, sin consulta al buró y sin fila en la cola (el gancho del
 * cierre se cayó). Idempotente. Los que sí consultaron y los que ya tienen fila
 * se descartan con dos consultas en total, no con varias por estudio.
 * ponytail: mira los estudios tocados en los últimos 30 días (y no antes del
 * corte), por su updated_at; uno más viejo, o uno que alguien tocó después, se
 * revisa a mano o entra igual.
 */
export async function barrerDevolucionesPendientes(): Promise<number> {
  const hace30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const desde = new Date(Math.max(hace30, Date.parse(CORTE_BARRIDO))).toISOString();
  const { data, error } = await db('pagos')
    .select('id, expediente_id, transaction_ref, expedientes!inner(estado, updated_at, estudios(estado, referencia_proveedor))')
    .eq('concepto', 'estudio')
    .eq('estado', 'completado')
    .in('expedientes.estado', ['cerrado', 'rechazado'])
    .gte('expedientes.updated_at', desde)
    .order('expedientes(updated_at)', { ascending: false })
    .limit(200);
  if (error) {
    logger.error({ error: error.message }, 'barrerDevolucionesPendientes: no se pudieron leer los pagos');
    return 0;
  }
  type Candidato = {
    id: string;
    expediente_id: string;
    transaction_ref: string | null;
    expedientes: { estudios?: Array<{ estado: string; referencia_proveedor: string | null }> | null } | null;
  };
  const sinConsulta = ((data ?? []) as Candidato[]).filter((p) => consultaDe(p.expedientes?.estudios ?? []) !== 'si');
  if (sinConsulta.length === 0) return 0;

  const ids = sinConsulta.flatMap((p) => [`pago:${p.id}`, ...(p.transaction_ref ? [p.transaction_ref] : [])]);
  const { data: filas, error: filasErr } = await db('pagos_no_conciliados').select('provider_payment_id').in('provider_payment_id', ids);
  if (filasErr) {
    logger.error({ error: filasErr.message }, 'barrerDevolucionesPendientes: no se pudo leer la cola');
    return 0;
  }
  const enCola = new Set(((filas ?? []) as Array<{ provider_payment_id: string }>).map((f) => f.provider_payment_id));

  let revisados = 0;
  for (const p of sinConsulta) {
    if (enCola.has(`pago:${p.id}`) || (p.transaction_ref && enCola.has(p.transaction_ref))) continue;
    await devolverEvaluacionSinConsulta(p.expediente_id, 'Estudio terminado sin consulta al buró', null, false);
    revisados++;
  }
  return revisados;
}

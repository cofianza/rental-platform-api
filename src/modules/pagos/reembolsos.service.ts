/**
 * Devolución de la evaluación (P1; Flujo §4.3, §11 y §12; C. Civil 1546; Ley
 * 1480 art. 47 y 51): el estudio que se cierra o se rechaza ya pagado y sin
 * consulta al buró se le devuelve a quien pagó, por el mismo medio. El crédito
 * del paquete vuelve solo al saldo. Lo de Mercado Pago no se reembolsa sin una
 * persona: queda en la cola de reembolsos (pagos_no_conciliados, la misma del
 * dinero que entra sin cobro) y un administrador lo devuelve con «Reembolsar en
 * Mercado Pago». Si ya hubo consulta no se devuelve: para conservar el pago
 * está la reasignación a otro inmueble (§4.3).
 */

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { getPaymentGateway } from './gateway';
import { transitionPagoState } from './pago-state-machine';
import {
  avisarAdministradores,
  cancelarPagosPendientesDeExpediente,
  MOTIVO_NO_CONCILIADO,
  registrarPagoNoConciliado,
} from './pagos.service';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
const cop = (n: number) => `$${n.toLocaleString('es-CO')}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Desde el lock a 'en_proceso' el buró ya se pudo consultar. 'fallido' cuenta:
 * no se sabe si la central cobró la consulta (el caso se revisa a mano).
 */
const ESTADOS_CON_CONSULTA = ['en_proceso', 'completado', 'fallido'];

export async function huboConsultaAlBuro(expedienteId: string): Promise<boolean> {
  const { data, error } = await db('estudios').select('estado, referencia_proveedor').eq('expediente_id', expedienteId);
  if (error) throw fromSupabaseError(error);
  return ((data ?? []) as Array<{ estado: string; referencia_proveedor: string | null }>).some(
    (e) => ESTADOS_CON_CONSULTA.includes(e.estado) || !!e.referencia_proveedor,
  );
}

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

/** Deja el pago de Mercado Pago en la cola de reembolsos; avisa a los administradores la primera vez. */
async function marcarReembolsoPendiente(pago: PagoEstudio, expedienteId: string): Promise<void> {
  const raw = (pago.gateway_response && typeof pago.gateway_response === 'object' ? pago.gateway_response : {}) as Record<
    string,
    unknown
  >;
  const ok = await registrarPagoNoConciliado(
    pago.transaction_ref as string,
    (typeof raw.external_reference === 'string' && raw.external_reference) || `estudio:${expedienteId}:${pago.id}`,
    {
      status: 'completed',
      rawResponse: { ...raw, transaction_amount: typeof raw.transaction_amount === 'number' ? raw.transaction_amount : Number(pago.monto) },
    },
    'estudio_cerrado_sin_consulta',
  );
  if (!ok) throw new AppError(500, 'REEMBOLSO_NO_REGISTRADO', 'No se pudo dejar el pago en la cola de reembolsos');
}

/**
 * Al cerrar o rechazar un estudio: los cobros de la evaluación que siguen vivos
 * se cancelan (su enlace deja de ser pagable) y, si ya se pagó y el buró no se
 * consultó, se devuelve. Nunca lanza: la transición ya quedó; si algo falla,
 * se avisa a los administradores para revisarlo a mano.
 */
export async function devolverEvaluacionSinConsulta(
  expedienteId: string,
  motivo: string,
  usuarioId: string | null,
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
    if (!pago || (await huboConsultaAlBuro(expedienteId))) return;

    const { devolverCreditoDePago } = await import('@/modules/creditos-estudios/creditos-estudios.service');
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
    if (pago.metodo === 'pasarela' && pago.transaction_ref) {
      await marcarReembolsoPendiente(pago, expedienteId);
      await timeline(
        expedienteId,
        'La evaluación estaba pagada y el estudio terminó sin consultar el buró: Cofianza le devolverá el pago a quien pagó, por Mercado Pago.',
        { pago_id: pago.id, evento: 'reembolso_pendiente', medio: 'pasarela' },
      );
      return;
    }
    // Registrado a mano (transferencia, efectivo o cheque) o sin id de Mercado
    // Pago: la plataforma no lo puede reembolsar; se devuelve a mano, por el mismo medio.
    await avisarAdministradores({
      tipo: 'pago.reembolso_pendiente',
      titulo: 'Devolver una evaluación a mano',
      mensaje: `El estudio terminó sin consultar el buró y su evaluación ya estaba pagada (${pago.metodo ?? 'sin método'}, ${cop(Number(pago.monto))}), pero no se puede reembolsar desde la plataforma: devuélvela a quien pagó por el mismo medio.`,
      link: `/expedientes/${expedienteId}`,
      payload: { expediente_id: expedienteId, pago_id: pago.id },
    });
    await timeline(
      expedienteId,
      'La evaluación estaba pagada y el estudio terminó sin consultar el buró: Cofianza le devolverá el pago a quien pagó.',
      { pago_id: pago.id, evento: 'reembolso_pendiente', medio: pago.metodo },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, expedienteId }, 'No se pudo revisar la devolución de la evaluación del estudio');
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
    if (await huboConsultaAlBuro(expedienteId)) return false;
    const { data } = await db('pagos').select(PAGO_SELECT).eq('id', pagoId).maybeSingle();
    const pago = data as PagoEstudio | null;
    if (!pago?.transaction_ref) return false;
    await marcarReembolsoPendiente(pago, expedienteId);
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
      mensaje: `Entró el pago de la evaluación de un estudio ya terminado y no quedó en la cola de reembolsos. Revísalo en Mercado Pago y devuélvelo si el buró no se consultó.`,
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
  created_at: string;
}

/** Lo que Mercado Pago aprobó y hay que devolver (o conciliar), lo más nuevo primero. */
export async function listReembolsosPendientes() {
  const { data, error } = await db('pagos_no_conciliados')
    .select('id, proveedor, provider_payment_id, external_reference, monto, motivo, notas, resuelto, created_at')
    .eq('resuelto', false)
    .eq('estado_proveedor', 'completed')
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
      monto: f.monto === null ? null : Number(f.monto),
      motivo: f.motivo,
      motivo_texto: MOTIVO_NO_CONCILIADO[f.motivo] ?? f.motivo,
      provider_payment_id: f.provider_payment_id,
      concepto: concepto || null,
      expediente: expId && numeros.has(expId) ? { id: expId, numero: numeros.get(expId)! } : null,
      notas: f.notas,
      created_at: f.created_at,
    };
  });
}

/**
 * El cobro que se pagó con ESTE payment de Mercado Pago. Un pago duplicado o de
 * otro estudio trae en la referencia un cobro que se pagó con otro payment: ese
 * cobro no se toca.
 */
async function pagoDeLaFila(f: FilaReembolso) {
  const { data } = await db('pagos')
    .select('id, expediente_id, estado')
    .eq('transaction_ref', f.provider_payment_id)
    .limit(1)
    .maybeSingle();
  return data as { id: string; expediente_id: string; estado: string } | null;
}

/**
 * «Reembolsar en Mercado Pago»: devuelve el pago completo por el refund del
 * adaptador. Idempotente: toma la fila con compare-and-set (un solo
 * administrador a la vez) y Mercado Pago recibe siempre la misma llave de
 * idempotencia para ese pago. Queda en la fila (quién, cuándo, id del
 * reembolso), en la bitácora y, si casa con un cobro, en su historial.
 */
export async function reembolsarEnMercadoPago(filaId: string, user: { id: string; email?: string }, ip?: string) {
  const { data, error } = await db('pagos_no_conciliados')
    .select('id, proveedor, provider_payment_id, external_reference, monto, motivo, notas, resuelto, created_at')
    .eq('id', filaId)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  const fila = data as FilaReembolso | null;
  if (!fila) throw AppError.notFound('Reembolso no encontrado');
  if (fila.resuelto) throw AppError.conflict('Este pago ya se reembolsó o se resolvió.', 'REEMBOLSO_RESUELTO');

  const gateway = getPaymentGateway();
  if (gateway.provider !== 'mercadopago' || fila.proveedor !== 'mercadopago') {
    throw AppError.conflict('Este pago no es de Mercado Pago: se devuelve a mano.', 'PASARELA_NO_SOPORTADA');
  }

  // Manda el estado real: no se reembolsa lo que Mercado Pago ya devolvió o no aprobó.
  const status = await gateway.getPaymentStatus(fila.provider_payment_id);
  if (status.status === 'refunded') {
    await db('pagos_no_conciliados')
      .update({ resuelto: true, notas: 'Mercado Pago ya lo tenía reembolsado o contracargado.' } as never)
      .eq('id', fila.id)
      .eq('resuelto', false);
    return { estado: 'ya_reembolsado' as const, refund_id: null, factura_numero: null };
  }
  if (status.status !== 'completed') {
    throw AppError.conflict('Mercado Pago no tiene este pago aprobado: no hay nada que reembolsar.', 'PAGO_NO_REEMBOLSABLE');
  }

  const quien = user.email ?? user.id;
  const { data: tomada } = await db('pagos_no_conciliados')
    .update({ resuelto: true, notas: `Reembolso en curso (${quien})` } as never)
    .eq('id', fila.id)
    .eq('resuelto', false)
    .select('id');
  if (!(tomada as unknown[] | null)?.length) {
    throw AppError.conflict('Otro administrador ya está reembolsando este pago.', 'REEMBOLSO_EN_CURSO');
  }

  let refund;
  try {
    refund = await gateway.refund(fila.provider_payment_id);
    if (refund.status === 'failed') throw new Error(`Mercado Pago no aprobó el reembolso ${refund.refundId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db('pagos_no_conciliados')
      .update({ resuelto: false, notas: `Falló el reembolso (${quien}): ${msg}` } as never)
      .eq('id', fila.id);
    throw new AppError(502, 'REEMBOLSO_FALLIDO', `No se pudo reembolsar en Mercado Pago: ${msg}`);
  }

  const enProceso = refund.status === 'pending';
  const fecha = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  await db('pagos_no_conciliados')
    .update({
      notas: `Reembolsado en Mercado Pago por ${quien} el ${fecha} (reembolso ${refund.refundId}${enProceso ? ', en proceso' : ''}).`,
    } as never)
    .eq('id', fila.id);

  const pago = await pagoDeLaFila(fila);
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

  let facturaNumero: string | null = null;
  if (pago) {
    // Con el reembolso en proceso, el cobro pasa a 'reembolsado' cuando llegue el webhook.
    if (!enProceso && pago.estado === 'completado') {
      await transitionPagoState({
        pagoId: pago.id,
        targetEstado: 'reembolsado',
        origen: 'manual',
        detalles: { refund_id: refund.refundId, reembolsado_por: user.id },
        userId: user.id,
        ip,
      }).catch((err) => logger.warn({ err, pagoId: pago.id }, 'Reembolso hecho pero el cobro no pasó a reembolsado (lo hará el webhook)'));
    }
    await timeline(
      pago.expediente_id,
      `Cofianza reembolsó ${fila.monto === null ? 'el pago' : cop(Number(fila.monto))} en Mercado Pago a quien pagó.`,
      { pago_id: pago.id, evento: 'reembolsado', refund_id: refund.refundId },
    );
    const { data: factura } = await db('facturas')
      .select('factus_number')
      .eq('pago_id', pago.id)
      .eq('estado', 'emitida')
      .limit(1)
      .maybeSingle();
    facturaNumero = (factura as { factus_number: string | null } | null)?.factus_number ?? null;
  }

  return { estado: enProceso ? ('en_proceso' as const) : ('reembolsado' as const), refund_id: refund.refundId, factura_numero: facturaNumero };
}

/**
 * Creditos de Estudios Service
 *
 * Permite a las inmobiliarias:
 * - Comprar paquetes de estudios via Stripe Checkout
 * - Consultar saldo y movimientos
 * - Liberar manualmente un estudio para un solicitante consumiendo 1 credito
 *
 * Webhook Stripe: cuando llega checkout.session.completed con
 * metadata.concepto = 'creditos_estudios', se acredita el lote.
 */

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { getPaymentGateway } from '@/modules/pagos/gateway';
import { perfilEsDuenoDeInmueble, resolveOrgCanonicalPerfilId } from '@/lib/tenantScope';
import { assertCanonDentroDelTope } from '@/modules/estudios/tope-canon.guard';
import { faltaColumna } from '@/modules/expedientes/cierre-sin-acta';
import type { ListMovimientosQuery } from './creditos-estudios.schema';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;

// ============================================================
// Types
// ============================================================

interface PaqueteRow {
  id: string;
  nombre: string;
  descripcion: string | null;
  cantidad_estudios: number;
  precio_cop: number;
  vence_en_dias: number | null;
  activo: boolean;
  orden: number;
  created_at: string;
  updated_at: string;
}

interface CompraRow {
  id: string;
  perfil_id: string;
  paquete_id: string;
  cantidad_estudios: number;
  precio_cop: number;
  vence_en_dias: number | null;
  estado: 'pendiente' | 'completado' | 'fallido' | 'cancelado';
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  payment_link_url: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LoteRow {
  id: string;
  perfil_id: string;
  compra_id: string | null;
  cantidad_inicial: number;
  cantidad_disponible: number;
  vence_en: string | null;
  origen: 'compra' | 'ajuste_admin';
  notas: string | null;
  created_at: string;
}

// ============================================================
// Public: list active paquetes
// ============================================================

export async function listPaquetesActivos(): Promise<PaqueteRow[]> {
  const { data, error } = await (supabase
    .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('activo', true)
    .order('orden', { ascending: true });

  if (error) throw fromSupabaseError(error);
  return (data || []) as PaqueteRow[];
}

// ============================================================
// Saldo + lotes activos
//
// Los créditos son de la ORGANIZACIÓN, no de quien los compró: viven a nombre
// del titular principal (perfil canónico). Las funciones de abajo reciben el
// perfil de quien llama y lo resuelven al canónico; sin eso un miembro veía
// saldo 0 con el paquete del titular sin usar y volvía a pagar.
// ============================================================

export interface SaldoCreditos {
  saldo_total: number;
  saldo_perpetuo: number;
  saldo_con_vencimiento: number;
  proximo_vencimiento: string | null;
  /** P22: créditos usados de una compra contracargada; se descuentan de la próxima compra. */
  creditos_en_contra: number;
  /** P22: lo que se puede gastar (saldo_total menos creditos_en_contra). */
  saldo_efectivo: number;
  lotes: Array<{
    id: string;
    cantidad_disponible: number;
    cantidad_inicial: number;
    vence_en: string | null;
    origen: string;
    created_at: string;
  }>;
}

export async function getSaldoCreditos(perfilId: string): Promise<SaldoCreditos> {
  const nowIso = new Date().toISOString();
  const dueno = await resolveOrgCanonicalPerfilId(perfilId);

  const [{ data, error }, enContra] = await Promise.all([
    (supabase
      .from('lotes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .select('id, cantidad_disponible, cantidad_inicial, vence_en, origen, created_at')
      .eq('perfil_id', dueno)
      .gt('cantidad_disponible', 0)
      .or(`vence_en.is.null,vence_en.gt.${nowIso}`)
      .order('created_at', { ascending: true }),
    // Solo se muestra: pagar con créditos lo vuelve a leer y ahí sí bloquea.
    creditosEnContra(dueno).catch((err) => {
      logger.warn({ err, dueno }, 'No se pudo leer el saldo en contra de créditos');
      return 0;
    }),
  ]);

  if (error) throw fromSupabaseError(error);

  const lotes = (data || []) as Array<{
    id: string;
    cantidad_disponible: number;
    cantidad_inicial: number;
    vence_en: string | null;
    origen: string;
    created_at: string;
  }>;

  let saldoPerpetuo = 0;
  let saldoConVencimiento = 0;
  let proximoVencimiento: string | null = null;

  for (const l of lotes) {
    if (l.vence_en === null) {
      saldoPerpetuo += l.cantidad_disponible;
    } else {
      saldoConVencimiento += l.cantidad_disponible;
      if (proximoVencimiento === null || l.vence_en < proximoVencimiento) {
        proximoVencimiento = l.vence_en;
      }
    }
  }

  return {
    saldo_total: saldoPerpetuo + saldoConVencimiento,
    saldo_perpetuo: saldoPerpetuo,
    saldo_con_vencimiento: saldoConVencimiento,
    proximo_vencimiento: proximoVencimiento,
    creditos_en_contra: enContra,
    saldo_efectivo: saldoEfectivo(saldoPerpetuo + saldoConVencimiento, enContra),
    lotes,
  };
}

/**
 * P22: créditos usados de compras contracargadas que todavía no cubre una
 * compra nueva (el saldo en contra de la organización). Sin la migración
 * 20261001000005 no hay columna ni, por lo tanto, saldo en contra registrado.
 */
export async function creditosEnContra(perfilCanonico: string): Promise<number> {
  const { data, error } = await db('compras_creditos_estudios')
    .select('creditos_en_contra')
    .eq('perfil_id', perfilCanonico)
    .gt('creditos_en_contra', 0);
  if (error) {
    if (faltaColumna(error)) return 0;
    throw fromSupabaseError(error);
  }
  return ((data ?? []) as Array<{ creditos_en_contra: number }>).reduce((s, c) => s + c.creditos_en_contra, 0);
}

/**
 * P22: el 409 de quien intenta pagar con créditos sin saldo efectivo (lo
 * disponible menos lo que quedó en contra por el contracargo de una compra).
 */
export function errorCreditosEnContra(enContra: number): AppError {
  const uno = enContra === 1;
  return AppError.conflict(
    `Tu organización tiene ${enContra} ${uno ? 'crédito' : 'créditos'} en contra por el contracargo de una compra y no le queda saldo para pagar con créditos: ` +
      `se ${uno ? 'descuenta' : 'descuentan'} de tu próxima compra. Mientras tanto paga la evaluación de inmediato o envía el enlace al prospecto.`,
    'CREDITOS_EN_CONTRA',
  );
}

/** P22: lo que de verdad se puede gastar: lo disponible menos lo que quedó en contra. */
export function saldoEfectivo(disponible: number, enContra: number): number {
  return Math.max(0, disponible - enContra);
}

/** Saldo vigente del perfil (lotes sin vencer), el que queda en cada movimiento. */
async function saldoVigente(perfilId: string): Promise<number> {
  const { data } = await db('lotes_creditos_estudios')
    .select('cantidad_disponible')
    .eq('perfil_id', perfilId)
    .or(`vence_en.is.null,vence_en.gt.${new Date().toISOString()}`);
  return ((data || []) as Array<{ cantidad_disponible: number }>).reduce((sum, l) => sum + l.cantidad_disponible, 0);
}

/**
 * Suma `delta` al disponible de un lote con compare-and-set (un consumo puede
 * cruzarse). Devuelve false si tras unos reintentos no pudo, o si el resultado
 * saldría del rango del lote.
 */
async function moverDisponible(loteId: string, delta: number): Promise<boolean> {
  for (let intento = 0; intento < 5; intento++) {
    const { data: lote } = await db('lotes_creditos_estudios')
      .select('cantidad_disponible, cantidad_inicial')
      .eq('id', loteId)
      .maybeSingle();
    const l = lote as { cantidad_disponible: number; cantidad_inicial: number } | null;
    if (!l) return false;
    const nuevo = l.cantidad_disponible + delta;
    if (nuevo < 0 || nuevo > l.cantidad_inicial) return false;
    const { data: ok } = await db('lotes_creditos_estudios')
      .update({ cantidad_disponible: nuevo } as never)
      .eq('id', loteId)
      .eq('cantidad_disponible', l.cantidad_disponible)
      .select('id');
    if ((ok as unknown[] | null)?.length) return true;
  }
  return false;
}

// ============================================================
// Movimientos (historial)
// ============================================================

export async function listMovimientos(perfilId: string, query: ListMovimientosQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;
  const dueno = await resolveOrgCanonicalPerfilId(perfilId);

  let q = (supabase
    .from('movimientos_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, tipo, cantidad, saldo_resultante, expediente_id, solicitante_id, lote_id, notas, created_at',
      { count: 'exact' },
    )
    .eq('perfil_id', dueno);

  if (query.tipo) q = q.eq('tipo', query.tipo);

  q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw fromSupabaseError(error);

  const movimientos = (data || []) as Array<Record<string, unknown>>;

  // Enriquecer con compra_id + factura_id para los movimientos tipo 'compra'.
  // Se hace en 2 queries planos (sin embed de PostgREST que a veces rompe
  // por schema cache):
  //   movimiento.lote_id -> lote.compra_id -> factura.compra_creditos_id
  const loteIds = movimientos
    .filter((m) => m.tipo === 'compra' && m.lote_id)
    .map((m) => m.lote_id as string);

  const compraByLote = new Map<string, string>();
  if (loteIds.length > 0) {
    const { data: lotes } = await (supabase
      .from('lotes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .select('id, compra_id')
      .in('id', loteIds);
    for (const l of (lotes || []) as Array<{ id: string; compra_id: string | null }>) {
      if (l.compra_id) compraByLote.set(l.id, l.compra_id);
    }
  }

  const compraIds = Array.from(new Set(compraByLote.values()));
  const facturaByCompra = new Map<string, { id: string; factus_number: string | null; estado: string }>();
  if (compraIds.length > 0) {
    const { data: facturas } = await (supabase
      .from('facturas' as string) as ReturnType<typeof supabase.from>)
      .select('id, compra_creditos_id, factus_number, estado')
      .in('compra_creditos_id', compraIds)
      .eq('estado', 'emitida');
    for (const f of (facturas || []) as Array<{ id: string; compra_creditos_id: string; factus_number: string | null; estado: string }>) {
      facturaByCompra.set(f.compra_creditos_id, {
        id: f.id,
        factus_number: f.factus_number,
        estado: f.estado,
      });
    }
  }

  for (const m of movimientos) {
    if (m.tipo === 'compra' && m.lote_id) {
      const compraId = compraByLote.get(m.lote_id as string);
      if (compraId) {
        m.compra_id = compraId;
        const factura = facturaByCompra.get(compraId);
        m.factura = factura || null;
      }
    }
  }

  return {
    movimientos,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.max(1, Math.ceil((count || 0) / limit)),
    },
  };
}

// ============================================================
// Compras (historial de compras)
// ============================================================

export async function listCompras(perfilId: string) {
  const dueno = await resolveOrgCanonicalPerfilId(perfilId);
  const { data, error } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, paquete_id, cantidad_estudios, precio_cop, vence_en_dias,
      estado, stripe_session_id, payment_link_url, completed_at, created_at
    `)
    .eq('perfil_id', dueno)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw fromSupabaseError(error);
  return data || [];
}

// ============================================================
// Comprar paquete (crea Stripe Checkout)
// ============================================================

export async function comprarPaquete(
  perfilId: string,
  paqueteId: string,
  userId: string,
  ip?: string,
): Promise<{ checkout_url: string; compra_id: string }> {
  // 1. Validar paquete activo
  const { data: pkgData, error: pkgErr } = await (supabase
    .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('id', paqueteId)
    .eq('activo', true)
    .single();

  if (pkgErr || !pkgData) {
    throw AppError.notFound('Paquete no encontrado o inactivo');
  }

  const paquete = pkgData as PaqueteRow;
  // La compra (y el lote que acredita el webhook) queda a nombre de la
  // organización; creado_por guarda quién la hizo.
  const dueno = await resolveOrgCanonicalPerfilId(perfilId);

  // 2. Crear registro de compra (estado pendiente)
  const { data: compraData, error: compraErr } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      perfil_id: dueno,
      paquete_id: paquete.id,
      cantidad_estudios: paquete.cantidad_estudios,
      precio_cop: paquete.precio_cop,
      vence_en_dias: paquete.vence_en_dias,
      estado: 'pendiente',
      creado_por: userId,
    } as never)
    .select('*')
    .single();

  if (compraErr || !compraData) {
    logger.error({ error: compraErr }, 'Error creando compra de creditos');
    throw fromSupabaseError(compraErr!);
  }

  const compra = compraData as CompraRow;

  // 3. Crear Stripe Checkout
  const successUrl = `${env.FRONTEND_URL}/configuracion/creditos-estudios?compra=${compra.id}&status=success`;
  const cancelUrl = `${env.FRONTEND_URL}/configuracion/creditos-estudios?compra=${compra.id}&status=cancelled`;
  // Un rechazo del banco NO es una cancelacion voluntaria: sin esta URL aparte
  // aterrizaba con status=cancelled y la web decia "Has cancelado el proceso de
  // pago" a quien le rechazaron la tarjeta.
  const failureUrl = `${env.FRONTEND_URL}/configuracion/creditos-estudios?compra=${compra.id}&status=failed`;

  try {
    const gateway = getPaymentGateway();
    const linkResult = await gateway.createPaymentLink({
      amount: paquete.precio_cop,
      concept: paquete.nombre,
      description: paquete.descripcion || `Compra de ${paquete.cantidad_estudios} estudios de arrendamiento`,
      metadata: {
        concepto: 'creditos_estudios',
        compra_id: compra.id,
        perfil_id: dueno,
        paquete_id: paquete.id,
      },
      successUrl,
      cancelUrl,
      failureUrl,
    });

    // 4. Guardar Stripe session ID en la compra
    const { error: updErr } = await (supabase
      .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .update({
        stripe_session_id: linkResult.externalId,
        payment_link_url: linkResult.url,
      } as never)
      .eq('id', compra.id);

    if (updErr) {
      // Sin el session_id el webhook jamás podrá acreditar la compra: si
      // dejáramos pagar, sería dinero por créditos que nunca llegan. Marcar
      // fallida y abortar — el comprador reintenta y se crea una compra nueva.
      logger.error({ updErr, compraId: compra.id }, 'No se pudo guardar el session de pasarela — compra abortada');
      throw fromSupabaseError(updErr);
    }

    logAudit({
      usuarioId: userId,
      accion: AUDIT_ACTIONS.PAGO_CREATED,
      entidad: AUDIT_ENTITIES.PAGO,
      entidadId: compra.id,
      detalle: {
        tipo: 'creditos_estudios',
        paquete_id: paquete.id,
        cantidad: paquete.cantidad_estudios,
        precio_cop: paquete.precio_cop,
      },
      ip,
    });

    return {
      checkout_url: linkResult.url,
      compra_id: compra.id,
    };
  } catch (err) {
    // Si falló Stripe, marcar compra como fallida
    await (supabase
      .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'fallido' } as never)
      .eq('id', compra.id);
    throw err;
  }
}

// ============================================================
// Webhook handler — acreditar lote cuando Stripe confirma pago
// ============================================================

/**
 * Marca una compra como completada (idempotente: solo toca filas no completadas).
 * Si `throwOnError`, propaga el fallo para que el retry del webhook lo repare.
 * Sin payment no se toca el registrado (P22: es el que acreditó la compra).
 */
async function marcarCompraCompletada(
  compraId: string,
  paymentIntentId: string | null,
  rawResponse: Record<string, unknown>,
  throwOnError = false,
): Promise<void> {
  const { error } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'completado',
      ...(paymentIntentId ? { stripe_payment_intent_id: paymentIntentId } : {}),
      gateway_response: rawResponse,
      completed_at: new Date().toISOString(),
    } as never)
    .eq('id', compraId)
    .neq('estado', 'completado');

  if (error) {
    logger.error({ error: error.message, compraId }, 'Error marcando compra de créditos como completada');
    if (throwOnError) throw fromSupabaseError(error);
  }
}

export async function acreditarCompraDesdeWebhook(
  stripeSessionId: string,
  paymentIntentId: string | null,
  rawResponse: Record<string, unknown>,
): Promise<{ ok: boolean; ya_acreditado?: boolean; lote_id?: string; duplicado?: boolean }> {
  // 1. Buscar compra por session ID
  const { data: compraData, error: findErr } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('stripe_session_id', stripeSessionId)
    .single();

  if (findErr || !compraData) {
    logger.warn({ stripeSessionId, error: findErr }, 'Compra de creditos no encontrada para session');
    return { ok: false };
  }

  const compra = compraData as CompraRow;

  // 2. Idempotencia: si ya esta completada, no hacer nada. Si la completó OTRO
  //    payment (terminó entre la lectura del webhook y esta), este es un pago
  //    duplicado: queda para devolver, no se absorbe como «ya acreditado».
  if (compra.estado === 'completado') {
    if (paymentIntentId && compra.stripe_payment_intent_id !== paymentIntentId) {
      logger.warn(
        { compraId: compra.id, paymentIntentId, acredito: compra.stripe_payment_intent_id },
        'Compra de créditos completada por otro payment — pago duplicado',
      );
      return { ok: false, duplicado: true };
    }
    logger.info({ compraId: compra.id }, 'Compra ya estaba completada — idempotent skip');
    return { ok: true, ya_acreditado: true };
  }

  // 2.5. P22: la compra se reclama para ESTE payment antes de crear el lote. Con
  //      dos payments aprobados a la vez (dos pestañas; webhook y conciliación)
  //      el segundo chocaba con el lote y salía como «ya acreditado», sin
  //      quedar para devolver. El reintento del mismo payment pasa; el de otro,
  //      es un pago duplicado.
  if (paymentIntentId) {
    const { data: reclamada } = await db('compras_creditos_estudios')
      .update({ stripe_payment_intent_id: paymentIntentId } as never)
      .eq('id', compra.id)
      .is('stripe_payment_intent_id', null)
      .select('id');
    if (!(reclamada as unknown[] | null)?.length) {
      const { data: fresca, error: frescaErr } = await db('compras_creditos_estudios')
        .select('stripe_payment_intent_id')
        .eq('id', compra.id)
        .maybeSingle();
      if (frescaErr) throw fromSupabaseError(frescaErr);
      const acredito = (fresca as { stripe_payment_intent_id: string | null } | null)?.stripe_payment_intent_id;
      if (acredito !== paymentIntentId) {
        logger.warn({ compraId: compra.id, paymentIntentId, acredito }, 'Compra de créditos reclamada por otro payment — pago duplicado');
        return { ok: false, duplicado: true };
      }
    }
  }

  // 3. Calcular vencimiento del lote
  const venceEn =
    compra.vence_en_dias && compra.vence_en_dias > 0
      ? new Date(Date.now() + compra.vence_en_dias * 24 * 60 * 60 * 1000).toISOString()
      : null;

  // 3.5. P22: el saldo en contra (créditos usados de una compra contracargada)
  //      se descuenta de esta compra. El lote nace ya descontado y la deuda se
  //      cubre después: si el lote ya existía (reintento), no se descuenta dos veces.
  const descuento = Math.min(await creditosEnContra(compra.perfil_id), compra.cantidad_estudios);

  // 4. Crear lote
  const { data: loteData, error: loteErr } = await (supabase
    .from('lotes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      perfil_id: compra.perfil_id,
      compra_id: compra.id,
      cantidad_inicial: compra.cantidad_estudios,
      cantidad_disponible: compra.cantidad_estudios - descuento,
      vence_en: venceEn,
      origen: 'compra',
    } as never)
    .select('*')
    .single();

  if (loteErr || !loteData) {
    // 23505 = uq_lotes_creditos_compra: otro retry/concurrente ya creó el lote.
    // Reparar la compra si quedó sin marcar y salir idempotente (sin duplicar créditos).
    if (loteErr?.code === '23505') {
      logger.info({ compraId: compra.id }, 'Lote ya existía (retry concurrente) — idempotent skip');
      // Sin pisar el payment registrado: es el que creó el lote.
      await marcarCompraCompletada(compra.id, null, rawResponse);
      return { ok: true, ya_acreditado: true };
    }
    logger.error({ loteErr, compraId: compra.id }, 'Error creando lote tras pago confirmado');
    throw fromSupabaseError(loteErr!);
  }

  const lote = loteData as LoteRow;

  // 4.5. P22: se cubre la deuda con lo descontado. Si otra compra de la misma
  //      organización cubrió una parte a la vez, lo que sobra vuelve al lote.
  const descontados = descuento > 0 ? await cubrirSaldoEnContra(compra.perfil_id, descuento) : 0;
  if (descontados < descuento && !(await moverDisponible(lote.id, descuento - descontados))) {
    logger.error(
      { compraId: compra.id, loteId: lote.id, faltan: descuento - descontados },
      'CRITICO: se descontaron créditos del saldo en contra que no se cubrieron — devolverlos al lote a mano',
    );
  }

  // 5. Actualizar compra a completado. Si falla, lanzamos para que el retry del
  // webhook lo repare (el lote ya existe: el retry cae en el skip idempotente
  // de arriba, que vuelve a intentar marcar la compra).
  await marcarCompraCompletada(compra.id, paymentIntentId, rawResponse, true);

  // 6. Registrar movimiento
  const saldoTotal = await saldoVigente(compra.perfil_id);

  await (supabase
    .from('movimientos_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      perfil_id: compra.perfil_id,
      lote_id: lote.id,
      tipo: 'compra',
      cantidad: compra.cantidad_estudios,
      saldo_resultante: saldoTotal + descontados,
      notas: `Compra de ${compra.cantidad_estudios} estudios — sesion ${stripeSessionId}`,
    } as never);
  if (descontados > 0) {
    await db('movimientos_creditos_estudios').insert({
      perfil_id: compra.perfil_id,
      lote_id: lote.id,
      tipo: 'ajuste',
      cantidad: -descontados,
      saldo_resultante: saldoTotal,
      notas: `Se descontaron ${descontados} créditos del saldo en contra (compra contracargada)`,
    } as never);
  }

  logger.info(
    { compraId: compra.id, perfilId: compra.perfil_id, cantidad: compra.cantidad_estudios },
    'Compra de creditos acreditada',
  );

  // Factura electrónica del paquete, fire-and-forget como la del pago del
  // estudio (orchestrator.onPagoConfirmado). Antes solo salía si el comprador
  // pulsaba "Facturar": ingreso cobrado sin factura DIAN. Si falla (Factus o
  // datos fiscales incompletos) la compra sigue en Pendientes de facturación.
  import('@/modules/facturacion/facturacion.service')
    .then(({ crearFacturaDesdeCompraCreditos }) =>
      crearFacturaDesdeCompraCreditos(compra.id, null, undefined, null),
    )
    .catch((err) =>
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), compraId: compra.id },
        'Facturación automática de la compra de créditos falló — pendiente de facturar a mano',
      ),
    );

  return { ok: true, lote_id: lote.id };
}

// ============================================================
// Liberar estudio (consumir 1 credito)
//
// Usado por la inmobiliaria para asumir el costo de un estudio
// con sus creditos pre-comprados. Crea un registro de pago
// 'completado' con metodo 'transferencia' para que el flow
// de estudio pueda continuar normal.
// ============================================================

export async function liberarEstudioConCredito(
  expedienteId: string,
  perfilId: string,
  userId: string,
  ip?: string,
  notas?: string,
): Promise<{ pago_id: string; saldo_restante: number; lote_id: string }> {
  // 1. Obtener expediente y verificar inmueble
  const { data: expData, error: expErr } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, inmueble_id, solicitante_id')
    .eq('id', expedienteId)
    .single();

  if (expErr || !expData) throw AppError.notFound('Estudio no encontrado');
  const exp = expData as { id: string; numero: string; estado: string; inmueble_id: string | null; solicitante_id: string | null };
  // P1: un estudio cerrado o rechazado no se cobra (el crédito no se podría usar ni devolver).
  if (exp.estado === 'cerrado' || exp.estado === 'rechazado') {
    throw AppError.conflict(`El estudio está ${exp.estado}: no se cobra la evaluación.`, 'EXPEDIENTE_CERRADO');
  }

  // 2. Validar que el inmueble pertenece al perfil que libera (la inmobiliaria figura como propietario_id)
  if (!exp.inmueble_id) {
    throw AppError.badRequest('Estudio sin inmueble asociado', 'EXPEDIENTE_SIN_INMUEBLE');
  }
  const { data: inmData } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('propietario_id, inmobiliaria_id, direccion, ciudad')
    .eq('id', exp.inmueble_id)
    .single();
  const inm = inmData as { propietario_id: string; inmobiliaria_id: string | null; direccion: string; ciudad: string } | null;
  if (!inm) throw AppError.notFound('Inmueble no encontrado');
  // Org-aware: dueño directo o miembro de la organización dueña (los créditos
  // son de la inmobiliaria; cualquier miembro activo puede liberarlos).
  const esDueno = await perfilEsDuenoDeInmueble({
    userId: perfilId,
    userRol: 'inmobiliaria',
    inmueblePropietarioId: inm.propietario_id,
    inmuebleInmobiliariaId: inm.inmobiliaria_id,
  });
  if (!esDueno) {
    throw AppError.forbidden('Este inmueble no le pertenece', 'INMUEBLE_NO_PROPIO');
  }
  // El crédito sale del saldo de la organización (perfil canónico); el
  // movimiento guarda en usuario_id quién lo liberó.
  const dueno = await resolveOrgCanonicalPerfilId(perfilId);

  // 2.5. TOPE DE CANON — flujo §4.4: "no se cobra el estudio". Descontar un
  //      credito ES el cobro (es un estudio ya pagado que se consume), asi que
  //      el tope se verifica ANTES del INSERT en `pagos` y ANTES del RPC
  //      consume_credito_estudio. Si se bloquea aqui, el saldo de la
  //      inmobiliaria queda intacto.
  await assertCanonDentroDelTope({ expedienteId, origen: 'liberarEstudioConCredito' });

  // P22: el saldo en contra se descuenta de lo disponible; sin saldo efectivo no
  // se paga con créditos hasta que una compra nueva lo cubra (pagar de
  // inmediato y el enlace al prospecto siguen abiertos).
  const enContra = await creditosEnContra(dueno);
  if (enContra > 0 && saldoEfectivo(await saldoVigente(dueno), enContra) < 1) throw errorCreditosEnContra(enContra);

  // 3. Validar que no exista ya un pago de estudio vivo. 'fallido' tambien
  //    cuenta: no es terminal (fallido→completado, Mercado Pago deja reintentar
  //    en el mismo checkout), asi que el prospecto aun podia pagar el enlace
  //    viejo despues de consumido el credito = cobro doble. Se cierra con la
  //    misma funcion que usa la pasarela antes de abrir otro cobro.
  const { data: existingPago, error: existingErr } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, external_id, metodo')
    .eq('expediente_id', expedienteId)
    .eq('concepto', 'estudio')
    .in('estado', ['completado', 'pendiente', 'procesando', 'fallido'])
    .order('created_at', { ascending: false });
  // Fail closed: sin saber si hay un cobro vivo no se consume el credito.
  if (existingErr) throw fromSupabaseError(existingErr);

  const vivos = (existingPago as Array<{ id: string; estado: string }> | null) ?? [];
  if (vivos.some((p) => p.estado === 'completado')) {
    throw AppError.conflict('Ya existe un pago de estudio completado', 'PAGO_ESTUDIO_YA_COMPLETADO');
  }
  if (vivos.some((p) => p.estado !== 'fallido')) {
    throw AppError.conflict('Ya existe un pago de estudio pendiente — cancelelo primero', 'PAGO_ESTUDIO_PENDIENTE');
  }
  if (vivos.length > 0) {
    const { cerrarCobroEstudioFallido } = await import('@/modules/pago-estudio/pago-estudio.service');
    for (const fallido of vivos) await cerrarCobroEstudioFallido(fallido, userId);
  }

  // 4. Obtener monto del estudio
  const { data: cfgData } = await (supabase
    .from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>)
    .select('valor')
    .eq('clave', 'monto_estudio')
    .single();
  const monto = parseInt(((cfgData as { valor: string } | null)?.valor) || '80000', 10);

  const direccion = `${inm.direccion}${inm.ciudad ? `, ${inm.ciudad}` : ''}`;

  // 5. Crear pago en estado completado (asumido con credito)
  const { data: pagoData, error: pagoErr } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      concepto: 'estudio',
      descripcion: `Estudio de arrendamiento - ${direccion} (liberado con credito de inmobiliaria)`,
      monto,
      metodo: 'transferencia',
      estado: 'completado',
      fecha_pago: new Date().toISOString(),
      creado_por: userId,
      notas: notas || 'Liberado consumiendo credito pre-comprado',
    } as never)
    .select('id')
    .single();

  if (pagoErr || !pagoData) {
    // 23505 = uq_pagos_estudio_activo: otro click/flujo concurrente ya creó el
    // pago del estudio — sin esto se consumían DOS créditos por un estudio.
    if (pagoErr?.code === '23505') {
      throw AppError.conflict('Ya existe un pago de evaluación activo para este estudio', 'PAGO_ESTUDIO_PENDIENTE');
    }
    logger.error({ pagoErr }, 'Error creando pago al liberar credito');
    throw fromSupabaseError(pagoErr!);
  }
  const pago = pagoData as { id: string };

  // 6. Consumir el credito via RPC (atomico, FIFO, con lock)
  const { data: rpcData, error: rpcErr } = await (supabase as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{
      data: Array<{ lote_id: string; saldo_restante: number }> | null;
      error: { code?: string; message?: string } | null;
    }>;
  }).rpc('consume_credito_estudio', {
    p_perfil_id: dueno,
    p_expediente_id: expedienteId,
    p_solicitante_id: exp.solicitante_id,
    p_pago_id: pago.id,
    p_usuario_id: userId,
    p_notas: notas || null,
  });

  if (rpcErr || !rpcData || rpcData.length === 0) {
    // Rollback: borrar el pago creado. Si el delete falla, queda un pago
    // completado SIN crédito consumido — hay que verlo en los logs.
    const { error: rollbackErr } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', pago.id);
    if (rollbackErr) {
      logger.error(
        { error: rollbackErr.message, pagoId: pago.id, expedienteId },
        'CRITICO: no se pudo revertir el pago tras fallar el consumo de crédito — revisar manualmente',
      );
    }

    if (rpcErr?.message?.includes('SIN_SALDO_CREDITOS')) {
      throw AppError.badRequest('No tienes créditos disponibles. Compra un paquete primero.', 'SIN_SALDO_CREDITOS');
    }

    logger.error({ rpcErr }, 'Error consumiendo credito');
    throw new AppError(500, 'CREDITO_CONSUME_ERROR', 'Error consumiendo credito');
  }

  const { lote_id, saldo_restante } = rpcData[0];

  // 7. Evento + timeline
  await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .insert({
      pago_id: pago.id,
      tipo: 'completed',
      origen: 'manual',
      detalles: {
        metodo: 'credito_inmobiliaria',
        lote_id,
        saldo_restante,
        liberado_por: userId,
      },
    } as never);

  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'pago',
      descripcion: 'Estudio liberado consumiendo credito pre-comprado',
      usuario_id: userId,
      metadata: {
        pago_id: pago.id,
        concepto: 'estudio',
        metodo: 'credito_inmobiliaria',
        lote_id,
        saldo_restante,
      },
    } as never);

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_MANUAL_REGISTERED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: {
      expediente_id: expedienteId,
      concepto: 'estudio',
      metodo: 'credito_inmobiliaria',
      lote_id,
      saldo_restante,
      monto,
    },
    ip,
  });

  // El pago quedó completado (el crédito consumido SÍ deja fila en `pagos`): el
  // dueño único de ese evento es onEstudioPagado.
  //
  // Antes aquí se llamaba directo a `enviarEnlaceAutorizacion`, "igual que el
  // flujo de pago por Stripe (que lo hace vía onPagoConfirmado)". Con el §6.3
  // esa analogía dejó de ser cierta: al entrar por cancelar-y-liberar-crédito
  // sobre una opción C el prospecto YA firmó, esa función lanza
  // AUTORIZACION_YA_FIRMADA y el .catch la degradaba a un warn — la agencia
  // pagaba y nadie ejecutaba el estudio. La OPCIÓN A no cambia de orden: su
  // pago nace 'completado' antes de pedir la autorización, así que cuando el
  // prospecto firme el gate de pago lo deja pasar sin tocar nada de arriba.
  // Fire-and-forget, como antes.
  import('@/modules/orchestrator/orchestrator.service')
    .then(({ onEstudioPagado }) => onEstudioPagado(expedienteId, userId))
    .catch((err) =>
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), expedienteId },
        'No se pudo continuar el flujo tras liberar con crédito (reenviable manualmente)',
      ),
    );

  return { pago_id: pago.id, saldo_restante, lote_id };
}

// ============================================================
// Devolución y contracargo (P1, P22)
// ============================================================

/**
 * P22: cubre hasta `cantidad` del saldo en contra de la organización, las
 * compras contracargadas más viejas primero (compare-and-set: otra compra puede
 * cubrir la misma deuda a la vez). Devuelve cuánto cubrió. Nunca lanza.
 */
async function cubrirSaldoEnContra(perfilId: string, cantidad: number): Promise<number> {
  let cubiertos = 0;
  try {
    const { data, error } = await db('compras_creditos_estudios')
      .select('id, creditos_en_contra')
      .eq('perfil_id', perfilId)
      .gt('creditos_en_contra', 0)
      .order('created_at', { ascending: true });
    if (error) throw error;
    for (const d of (data ?? []) as Array<{ id: string; creditos_en_contra: number }>) {
      const t = Math.min(d.creditos_en_contra, cantidad - cubiertos);
      if (t <= 0) break;
      const { data: ok, error: updErr } = await db('compras_creditos_estudios')
        .update({ creditos_en_contra: d.creditos_en_contra - t } as never)
        .eq('id', d.id)
        .eq('creditos_en_contra', d.creditos_en_contra)
        .select('id');
      if (updErr) throw updErr;
      if ((ok as unknown[] | null)?.length) cubiertos += t;
    }
  } catch (err) {
    logger.error({ err, perfilId, cubiertos, cantidad }, 'No se pudo cubrir todo el saldo en contra con la compra');
  }
  return cubiertos;
}

/**
 * ¿La compra del lote se contracargó y todavía debe créditos? Entonces un
 * crédito devuelto baja esa deuda en vez de volver a un lote que no se pagó.
 */
async function compraConDeuda(compraId: string | null): Promise<{ id: string; creditos_en_contra: number } | null> {
  if (!compraId) return null;
  const { data, error: cErr } = await db('compras_creditos_estudios')
    .select('id, estado, creditos_en_contra')
    .eq('id', compraId)
    .maybeSingle();
  if (cErr) {
    if (faltaColumna(cErr)) return null;
    throw fromSupabaseError(cErr);
  }
  const c = data as { id: string; estado: string; creditos_en_contra: number } | null;
  return c && c.estado === 'cancelado' && c.creditos_en_contra > 0 ? c : null;
}

export type DevolucionCredito = 'no_es_credito' | 'devuelto' | 'ya_devuelto';

/** ¿El pago de la evaluación salió de un crédito prepagado? (su consumo guarda el pago_id). */
export async function esPagoConCredito(pagoId: string): Promise<boolean> {
  const { data, error } = await db('movimientos_creditos_estudios')
    .select('id')
    .eq('pago_id', pagoId)
    .eq('tipo', 'consumo')
    .limit(1);
  if (error) throw fromSupabaseError(error);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * P1: el crédito con que se pagó una evaluación que no llegó al buró vuelve al
 * saldo de la organización, con un movimiento de ajuste, al lote de donde
 * salió (devolverlo es deshacer el consumo). Si ese lote ya venció, vuelve en
 * un lote de 1 con la misma vigencia que tenía el original, contada desde hoy.
 * El pago pasa a 'reembolsado' con compare-and-set: solo una llamada devuelve.
 */
export async function devolverCreditoDePago(
  pagoId: string,
  motivo: string,
  usuarioId: string | null,
): Promise<DevolucionCredito> {
  const { data, error } = await db('movimientos_creditos_estudios')
    .select('perfil_id, lote_id, expediente_id, solicitante_id')
    .eq('pago_id', pagoId)
    .eq('tipo', 'consumo')
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  const consumo = data as {
    perfil_id: string;
    lote_id: string | null;
    expediente_id: string | null;
    solicitante_id: string | null;
  } | null;
  if (!consumo) return 'no_es_credito';
  if (!consumo.lote_id) {
    throw new AppError(500, 'CREDITO_NO_DEVUELTO', 'El consumo del crédito no conserva su lote: hay que devolverlo a mano.');
  }
  // Se decide antes de escribir nada: si una lectura falla, el pago no cambia.
  const { data: loteRow, error: loteErr } = await db('lotes_creditos_estudios')
    .select('id, compra_id, vence_en, created_at')
    .eq('id', consumo.lote_id)
    .maybeSingle();
  if (loteErr) throw fromSupabaseError(loteErr);
  const lote = loteRow as { id: string; compra_id: string | null; vence_en: string | null; created_at: string } | null;
  if (!lote) throw new AppError(500, 'CREDITO_NO_DEVUELTO', 'El lote del crédito ya no existe: hay que devolverlo a mano.');
  const deuda = await compraConDeuda(lote.compra_id);

  // ponytail: sin transacción. Si la API se reinicia entre pasar el pago a
  // reembolsado (abajo) y devolver el crédito, el crédito no vuelve y el
  // reintento responde «ya devuelto»; se corrige a mano en la base. Pasarlo a
  // una RPC transaccional si ocurre.
  // Import dinámico: la máquina de estados arrastra las notificaciones.
  const { transitionPagoStateChecked } = await import('@/modules/pagos/pago-state-machine');
  const { transitioned } = await transitionPagoStateChecked({
    pagoId,
    targetEstado: 'reembolsado',
    origen: 'system',
    detalles: { motivo, devolucion: 'credito' },
    userId: usuarioId,
  });
  if (!transitioned) return 'ya_devuelto';

  let aDeuda = false;
  if (deuda) {
    const { data: ok } = await db('compras_creditos_estudios')
      .update({ creditos_en_contra: deuda.creditos_en_contra - 1 } as never)
      .eq('id', deuda.id)
      .eq('creditos_en_contra', deuda.creditos_en_contra)
      .select('id');
    aDeuda = !!(ok as unknown[] | null)?.length;
  }

  let loteDestino = lote.id;
  let devuelto = aDeuda;
  const vencido = !!lote.vence_en && Date.parse(lote.vence_en) <= Date.now();
  if (!devuelto && vencido) {
    const vigenciaMs = Date.parse(lote.vence_en!) - Date.parse(lote.created_at);
    const { data: nuevo } = await db('lotes_creditos_estudios')
      .insert({
        perfil_id: consumo.perfil_id,
        cantidad_inicial: 1,
        cantidad_disponible: 1,
        vence_en: new Date(Date.now() + Math.max(vigenciaMs, 0)).toISOString(),
        origen: 'ajuste_admin',
        notas: `Crédito devuelto (${motivo}): el lote original ya había vencido`,
      } as never)
      .select('id')
      .maybeSingle();
    loteDestino = (nuevo as { id: string } | null)?.id ?? lote.id;
    devuelto = !!nuevo;
  } else if (!devuelto) {
    devuelto = await moverDisponible(lote.id, 1);
  }
  if (!devuelto) {
    logger.error({ pagoId, loteId: lote.id }, 'CRITICO: el pago quedó reembolsado pero el crédito no volvió al saldo');
    throw new AppError(500, 'CREDITO_NO_DEVUELTO', 'El pago quedó reembolsado pero el crédito no volvió al saldo: hay que devolverlo a mano.');
  }

  await db('movimientos_creditos_estudios').insert({
    perfil_id: consumo.perfil_id,
    lote_id: loteDestino,
    tipo: 'ajuste',
    cantidad: 1,
    saldo_resultante: await saldoVigente(consumo.perfil_id),
    expediente_id: consumo.expediente_id,
    solicitante_id: consumo.solicitante_id,
    pago_id: pagoId,
    usuario_id: usuarioId,
    notas: aDeuda
      ? `Devolución: ${motivo}. Bajó el saldo en contra.`
      : vencido
        ? `Devolución: ${motivo}. El lote había vencido: el crédito vuelve con vigencia nueva.`
        : `Devolución: ${motivo}.`,
  } as never);
  return 'devuelto';
}

export interface CompraRevertida {
  compra_id: string;
  perfil_id: string;
  /** Créditos sin usar que se retiraron. */
  retirados: number;
  /** Créditos ya usados: quedan como saldo en contra. */
  en_contra: number;
  /** null si quedaron registrados como saldo en contra; si no, por qué no (hay que descontarlos a mano). */
  en_contra_error: string | null;
  /** Números de los estudios donde se usaron: el registro para disputar el contracargo. */
  consumos: string[];
}

/**
 * P22 (Adenda 2 §7: Cofianza no le da crédito a las inmobiliarias): si Mercado
 * Pago reembolsa o contracarga una compra de créditos, se retiran los que no se
 * usaron y los usados quedan como saldo en contra, que bloquea solo pagar con
 * créditos y se descuenta de la próxima compra. La cuenta no se bloquea. Solo
 * la primera llamada revierte (compare-and-set sobre el estado de la compra).
 */
export async function revertirCompraCreditos(compraId: string): Promise<CompraRevertida | null> {
  const { data, error } = await db('compras_creditos_estudios')
    .select('id, perfil_id, estado')
    .eq('id', compraId)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  const compra = data as { id: string; perfil_id: string; estado: string } | null;
  if (!compra || (compra.estado !== 'completado' && compra.estado !== 'pendiente')) return null;
  // El lote se lee ANTES de cancelar: si la lectura falla, la compra no cambia y
  // el reintento del webhook vuelve a empezar.
  const { data: loteRow, error: loteErr } = await db('lotes_creditos_estudios')
    .select('id, cantidad_inicial, cantidad_disponible')
    .eq('compra_id', compraId)
    .maybeSingle();
  if (loteErr) throw fromSupabaseError(loteErr);
  const lote = loteRow as { id: string; cantidad_inicial: number; cantidad_disponible: number } | null;
  const { data: cancelada, error: cErr } = await db('compras_creditos_estudios')
    .update({ estado: 'cancelado' } as never)
    .eq('id', compraId)
    .eq('estado', compra.estado)
    .select('id');
  if (cErr) throw fromSupabaseError(cErr);
  if (!(cancelada as unknown[] | null)?.length) return null;
  // ponytail: sin transacción. Si la API se reinicia entre cancelar la compra y
  // retirar el lote (o dejar el saldo en contra), el reintento ve la compra ya
  // cancelada y no hace nada: los créditos quedan sin retirar y se ajustan a
  // mano. Pasarlo a una RPC transaccional si ocurre.

  const resultado: CompraRevertida = {
    compra_id: compraId,
    perfil_id: compra.perfil_id,
    retirados: 0,
    en_contra: 0,
    en_contra_error: null,
    consumos: [],
  };
  if (!lote) return resultado; // no se alcanzó a acreditar: no hay nada que retirar

  // Lo no usado se retira (compare-and-set: un consumo puede cruzarse).
  let retirados = lote.cantidad_disponible;
  for (let intento = 0; ; intento++) {
    const { data: ok } = await db('lotes_creditos_estudios')
      .update({ cantidad_disponible: 0 } as never)
      .eq('id', lote.id)
      .eq('cantidad_disponible', retirados)
      .select('id');
    if ((ok as unknown[] | null)?.length) break;
    if (intento >= 4) throw new AppError(409, 'LOTE_CAMBIANDO', 'No se pudieron retirar los créditos: el lote cambió mientras tanto.');
    const { data: fresco } = await db('lotes_creditos_estudios').select('cantidad_disponible').eq('id', lote.id).maybeSingle();
    retirados = (fresco as { cantidad_disponible: number } | null)?.cantidad_disponible ?? 0;
  }
  resultado.retirados = retirados;
  resultado.en_contra = lote.cantidad_inicial - retirados;

  if (resultado.en_contra > 0) {
    const { error: dErr } = await db('compras_creditos_estudios')
      .update({ creditos_en_contra: resultado.en_contra } as never)
      .eq('id', compraId);
    if (dErr) {
      logger.error({ compraId, error: dErr.message }, 'Contracargo: los créditos usados no quedaron como saldo en contra');
      resultado.en_contra_error = faltaColumna(dErr) ? 'falta la migración 20261001000005' : dErr.message;
    }
  }
  if (retirados > 0) {
    await db('movimientos_creditos_estudios').insert({
      perfil_id: compra.perfil_id,
      lote_id: lote.id,
      tipo: 'ajuste',
      cantidad: -retirados,
      saldo_resultante: await saldoVigente(compra.perfil_id),
      notas: `Compra contracargada o reembolsada: se retiraron ${retirados} créditos sin usar`,
    } as never);
  }

  const { data: movs } = await db('movimientos_creditos_estudios')
    .select('expediente_id')
    .eq('lote_id', lote.id)
    .eq('tipo', 'consumo');
  const ids = [...new Set(((movs ?? []) as Array<{ expediente_id: string | null }>).map((m) => m.expediente_id))].filter(
    (id): id is string => !!id,
  );
  if (ids.length > 0) {
    const { data: exps } = await db('expedientes').select('numero').in('id', ids.slice(0, 100));
    resultado.consumos = ((exps ?? []) as Array<{ numero: string }>).map((e) => e.numero);
  }
  return resultado;
}

// ============================================================
// Super admin — CRUD paquetes
// ============================================================

export async function listAllPaquetes(): Promise<PaqueteRow[]> {
  const { data, error } = await (supabase
    .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .order('orden', { ascending: true });

  if (error) throw fromSupabaseError(error);
  return (data || []) as PaqueteRow[];
}

export async function createPaquete(input: Record<string, unknown>, userId: string): Promise<PaqueteRow> {
  const { data, error } = await (supabase
    .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .insert(input as never)
    .select('*')
    .single();

  if (error) throw fromSupabaseError(error);

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONFIG_CHANGED,
    entidad: AUDIT_ENTITIES.CONFIG,
    entidadId: (data as PaqueteRow).id,
    detalle: { tipo: 'paquete_creditos_creado', ...input },
  });

  return data as PaqueteRow;
}

export async function updatePaquete(
  paqueteId: string,
  input: Record<string, unknown>,
  userId: string,
): Promise<PaqueteRow> {
  const { data, error } = await (supabase
    .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .update(input as never)
    .eq('id', paqueteId)
    .select('*')
    .single();

  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.notFound('Paquete no encontrado');

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONFIG_CHANGED,
    entidad: AUDIT_ENTITIES.CONFIG,
    entidadId: paqueteId,
    detalle: { tipo: 'paquete_creditos_actualizado', ...input },
  });

  return data as PaqueteRow;
}

export async function deletePaquete(paqueteId: string, userId: string): Promise<void> {
  // Soft delete: marcar inactivo (no borrar — hay FKs en compras)
  const { error } = await (supabase
    .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .update({ activo: false } as never)
    .eq('id', paqueteId);

  if (error) throw fromSupabaseError(error);

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONFIG_CHANGED,
    entidad: AUDIT_ENTITIES.CONFIG,
    entidadId: paqueteId,
    detalle: { tipo: 'paquete_creditos_desactivado' },
  });
}

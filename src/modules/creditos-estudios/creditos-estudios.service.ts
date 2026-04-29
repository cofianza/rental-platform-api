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
import type { ListMovimientosQuery } from './creditos-estudios.schema';

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
// ============================================================

export interface SaldoCreditos {
  saldo_total: number;
  saldo_perpetuo: number;
  saldo_con_vencimiento: number;
  proximo_vencimiento: string | null;
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

  const { data, error } = await (supabase
    .from('lotes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, cantidad_disponible, cantidad_inicial, vence_en, origen, created_at')
    .eq('perfil_id', perfilId)
    .gt('cantidad_disponible', 0)
    .or(`vence_en.is.null,vence_en.gt.${nowIso}`)
    .order('created_at', { ascending: true });

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
    lotes,
  };
}

// ============================================================
// Movimientos (historial)
// ============================================================

export async function listMovimientos(perfilId: string, query: ListMovimientosQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  let q = (supabase
    .from('movimientos_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, tipo, cantidad, saldo_resultante, expediente_id, solicitante_id, lote_id, notas, created_at',
      { count: 'exact' },
    )
    .eq('perfil_id', perfilId);

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
  const { data, error } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, paquete_id, cantidad_estudios, precio_cop, vence_en_dias,
      estado, stripe_session_id, payment_link_url, completed_at, created_at
    `)
    .eq('perfil_id', perfilId)
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

  // 2. Crear registro de compra (estado pendiente)
  const { data: compraData, error: compraErr } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      perfil_id: perfilId,
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

  try {
    const gateway = getPaymentGateway();
    const linkResult = await gateway.createPaymentLink({
      amount: paquete.precio_cop,
      concept: paquete.nombre,
      description: paquete.descripcion || `Compra de ${paquete.cantidad_estudios} estudios de arrendamiento`,
      metadata: {
        concepto: 'creditos_estudios',
        compra_id: compra.id,
        perfil_id: perfilId,
        paquete_id: paquete.id,
      },
      successUrl,
      cancelUrl,
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
      logger.warn({ updErr, compraId: compra.id }, 'No se pudo guardar Stripe session en compra');
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

export async function acreditarCompraDesdeWebhook(
  stripeSessionId: string,
  paymentIntentId: string | null,
  rawResponse: Record<string, unknown>,
): Promise<{ ok: boolean; ya_acreditado?: boolean; lote_id?: string }> {
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

  // 2. Idempotencia: si ya esta completada, no hacer nada
  if (compra.estado === 'completado') {
    logger.info({ compraId: compra.id }, 'Compra ya estaba completada — idempotent skip');
    return { ok: true, ya_acreditado: true };
  }

  // 3. Calcular vencimiento del lote
  const venceEn =
    compra.vence_en_dias && compra.vence_en_dias > 0
      ? new Date(Date.now() + compra.vence_en_dias * 24 * 60 * 60 * 1000).toISOString()
      : null;

  // 4. Crear lote
  const { data: loteData, error: loteErr } = await (supabase
    .from('lotes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      perfil_id: compra.perfil_id,
      compra_id: compra.id,
      cantidad_inicial: compra.cantidad_estudios,
      cantidad_disponible: compra.cantidad_estudios,
      vence_en: venceEn,
      origen: 'compra',
    } as never)
    .select('*')
    .single();

  if (loteErr || !loteData) {
    logger.error({ loteErr, compraId: compra.id }, 'Error creando lote tras pago confirmado');
    throw fromSupabaseError(loteErr!);
  }

  const lote = loteData as LoteRow;

  // 5. Actualizar compra a completado
  await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'completado',
      stripe_payment_intent_id: paymentIntentId,
      gateway_response: rawResponse,
      completed_at: new Date().toISOString(),
    } as never)
    .eq('id', compra.id);

  // 6. Registrar movimiento
  const { data: saldoAct } = await (supabase
    .from('lotes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('cantidad_disponible')
    .eq('perfil_id', compra.perfil_id)
    .or(`vence_en.is.null,vence_en.gt.${new Date().toISOString()}`);

  const saldoTotal = ((saldoAct || []) as Array<{ cantidad_disponible: number }>)
    .reduce((sum, l) => sum + l.cantidad_disponible, 0);

  await (supabase
    .from('movimientos_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      perfil_id: compra.perfil_id,
      lote_id: lote.id,
      tipo: 'compra',
      cantidad: compra.cantidad_estudios,
      saldo_resultante: saldoTotal,
      notas: `Compra de ${compra.cantidad_estudios} estudios — sesion ${stripeSessionId}`,
    } as never);

  logger.info(
    { compraId: compra.id, perfilId: compra.perfil_id, cantidad: compra.cantidad_estudios },
    'Compra de creditos acreditada',
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
    .select('id, numero, inmueble_id, solicitante_id')
    .eq('id', expedienteId)
    .single();

  if (expErr || !expData) throw AppError.notFound('Expediente no encontrado');
  const exp = expData as { id: string; numero: string; inmueble_id: string | null; solicitante_id: string | null };

  // 2. Validar que el inmueble pertenece al perfil que libera (la inmobiliaria figura como propietario_id)
  if (!exp.inmueble_id) {
    throw AppError.badRequest('Expediente sin inmueble asociado', 'EXPEDIENTE_SIN_INMUEBLE');
  }
  const { data: inmData } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('propietario_id, direccion, ciudad')
    .eq('id', exp.inmueble_id)
    .single();
  const inm = inmData as { propietario_id: string; direccion: string; ciudad: string } | null;
  if (!inm) throw AppError.notFound('Inmueble no encontrado');
  if (inm.propietario_id !== perfilId) {
    throw AppError.forbidden('Este inmueble no le pertenece', 'INMUEBLE_NO_PROPIO');
  }

  // 3. Validar que no exista ya un pago de estudio completado
  const { data: existingPago } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .eq('concepto', 'estudio')
    .in('estado', ['completado', 'pendiente', 'procesando'])
    .order('created_at', { ascending: false })
    .limit(1);

  if (existingPago && existingPago.length > 0) {
    const e = existingPago[0] as { estado: string };
    if (e.estado === 'completado') {
      throw AppError.conflict('Ya existe un pago de estudio completado', 'PAGO_ESTUDIO_YA_COMPLETADO');
    }
    throw AppError.conflict('Ya existe un pago de estudio pendiente — cancelelo primero', 'PAGO_ESTUDIO_PENDIENTE');
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
    p_perfil_id: perfilId,
    p_expediente_id: expedienteId,
    p_solicitante_id: exp.solicitante_id,
    p_pago_id: pago.id,
    p_usuario_id: userId,
    p_notas: notas || null,
  });

  if (rpcErr || !rpcData || rpcData.length === 0) {
    // Rollback: borrar el pago creado
    await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', pago.id);

    if (rpcErr?.message?.includes('SIN_SALDO_CREDITOS')) {
      throw AppError.badRequest('No tiene creditos disponibles. Compre un paquete primero.', 'SIN_SALDO_CREDITOS');
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

  return { pago_id: pago.id, saldo_restante, lote_id };
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

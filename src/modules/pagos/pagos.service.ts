import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { sendPaymentLinkEmail } from '@/lib/email';
import { getPaymentGateway } from './gateway';
import { transitionPagoState, transitionPagoStateChecked, isValidTransition, CONCEPTO_LABELS } from './pago-state-machine';
import type { EstadoPago } from './pago-state-machine';
import type { CreatePaymentLinkInput, RegisterManualPaymentInput, ComprobantePresignedUrlInput, ListPagosQuery } from './pagos.schema';
import { notificarYCorreo, type NotificarUsuarioInput } from '../notificaciones/notificaciones.service';
import { assertExpedienteAccess } from '@/lib/tenantScope';
// Tope de canon (flujo del modulo de estudios §4.4): este endpoint generico
// tambien puede cobrar el estudio (concepto='estudio'), asi que necesita el
// mismo guard que /pago-estudio. Ver tope-canon.guard.ts.
import { assertCanonDentroDelTope } from '@/modules/estudios/tope-canon.guard';
import { sobreCanon } from '@/modules/estudios/tarifas';
import { coarrendatarioVinculado } from '@/modules/estudios/coarrendatario-vinculado';
import { destinacionDeUso } from '@/modules/inmuebles/destinacion';

// ============================================================
// Helpers
// ============================================================

const PAGO_SELECT = `
  id, expediente_id, concepto, descripcion, monto, moneda, metodo, estado,
  payment_link_url, external_id, transaction_ref, gateway_response,
  comprobante_url, comprobante_storage_key, comprobante_nombre_original,
  comprobante_tipo_mime, comprobante_tamano_bytes, referencia_bancaria,
  notas, fecha_pago, created_at, updated_at, creado_por,
  email_pagador, nombre_pagador
`;

/**
 * Anexa a cada pago la última factura emitida (si existe). Usamos un
 * segundo query en lugar de embed PostgREST porque el schema cache de
 * Supabase a veces no detecta la FK pago_id→pagos y rompe el endpoint.
 *
 * Exportado para que otros modulos (pago-estudio, etc.) puedan reutilizar
 * la misma logica al devolver pagos al frontend — asi el flag
 * facturaExistente en la UI sigue siendo confiable tras refresh.
 */
export async function attachFacturas<T extends Record<string, unknown> & { id: string }>(
  pagos: T[],
): Promise<(T & { factura: { id: string; numero: string | null; estado: string } | null })[]> {
  if (pagos.length === 0) return [];
  const ids = pagos.map((p) => p.id);
  const { data: facturas } = await (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .select('id, pago_id, factus_number, estado, created_at')
    .in('pago_id', ids)
    .eq('estado', 'emitida')
    .order('created_at', { ascending: false });

  const byPago = new Map<string, { id: string; factus_number: string | null; estado: string }>();
  for (const f of (facturas || []) as {
    id: string;
    pago_id: string;
    factus_number: string | null;
    estado: string;
  }[]) {
    if (!byPago.has(f.pago_id)) {
      byPago.set(f.pago_id, { id: f.id, factus_number: f.factus_number, estado: f.estado });
    }
  }

  return pagos.map((p) => {
    const f = byPago.get(p.id);
    return {
      ...p,
      factura: f ? { id: f.id, numero: f.factus_number, estado: f.estado } : null,
    };
  });
}

const COMPROBANTE_BUCKET = 'pagos-comprobantes';
const PRESIGNED_URL_EXPIRY = 900; // 15 minutes

async function recordEvent(
  pagoId: string,
  tipo: string,
  origen: 'system' | 'webhook' | 'manual' = 'system',
  detalles?: Record<string, unknown>,
) {
  const { error } = await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .insert({ pago_id: pagoId, tipo, origen, detalles: detalles || null } as never);

  if (error) {
    logger.warn({ error: error.message, pagoId, tipo }, 'Error al registrar evento de pago');
  }
}

function formatCOP(amount: number): string {
  return `$${amount.toLocaleString('es-CO')}`;
}

// ============================================================
// List pagos by expediente
// ============================================================

export async function listPagosByExpediente(
  expedienteId: string,
  query: ListPagosQuery,
  userId?: string,
  userRol?: string,
) {
  // Apply defaults defensively in case validation middleware didn't run
  const page = query.page ?? 1;
  const limit = query.limit ?? 10;
  const sortBy = query.sortBy ?? 'created_at';
  const sortDir = query.sortDir ?? 'desc';
  const { concepto, estado } = query;
  const offset = (page - 1) * limit;

  let builder = (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select(PAGO_SELECT, { count: 'exact' })
    .eq('expediente_id', expedienteId);

  if (concepto) builder = builder.eq('concepto', concepto);
  if (estado) {
    const estados = estado.split(',').map((s) => s.trim()).filter(Boolean);
    builder = builder.in('estado', estados);
  }

  builder = builder.order(sortBy, { ascending: sortDir === 'asc' });
  builder = builder.range(offset, offset + limit - 1);

  // Ownership multi-tenant (cierra IDOR): roles tenant-scopeados solo ven pagos
  // de expedientes de su cartera. 404 fuera de scope (no confirma existencia).
  // Guard y lectura en paralelo (antes en serie): si el guard da 404,
  // Promise.all rechaza y lo leído se descarta.
  const [, { data, count, error }] = await Promise.all([
    assertExpedienteAccess(expedienteId, userId, userRol),
    builder,
  ]);

  if (error) {
    logger.error({ error: error.message }, 'Error al listar pagos');
    throw fromSupabaseError(error);
  }

  return {
    pagos: await attachFacturas(
      (data ?? []) as unknown as (Record<string, unknown> & { id: string })[],
    ),
    pagination: {
      total: count ?? 0,
      page,
      limit,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
  };
}

// ============================================================
// Get pago by ID (with events)
// ============================================================

export async function getPagoById(id: string) {
  const { data, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select(PAGO_SELECT)
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') throw AppError.notFound('Pago no encontrado');
    throw fromSupabaseError(error);
  }

  const [withFactura] = await attachFacturas([
    data as unknown as Record<string, unknown> & { id: string },
  ]);
  return withFactura;
}

// ============================================================
// Get pago detail with events
// ============================================================

export async function getPagoDetailWithEvents(id: string, userId?: string, userRol?: string) {
  const pago = await getPagoById(id);

  // Ownership multi-tenant (cierra IDOR del detalle): resolvemos el expediente
  // del pago y gateamos por cartera. 404 fuera de scope (no confirma existencia).
  await assertExpedienteAccess((pago as unknown as { expediente_id: string }).expediente_id, userId, userRol);

  const { data: eventos, error } = await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .select('id, pago_id, tipo, detalles, origen, created_at')
    .eq('pago_id', id)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ error: error.message, id }, 'Error al obtener eventos de pago');
  }

  return {
    ...pago,
    eventos: eventos ?? [],
  };
}

// ============================================================
// Prima sugerida — GET /expedientes/:expedienteId/pagos/prima-sugerida
// ============================================================

/**
 * Lo que los modales de cobro sugieren para la garantía, que es la prima de
 * vinculación: el % del estudio (el del CRC u override de Gerencia) sobre el
 * canon del contrato —Adenda 1 de contratos, respuesta 9: rige el canon
 * pactado— o, sin contrato todavía, sobre el evaluado; más IVA (§1.1). Solo
 * sugiere: el monto lo sigue poniendo el gestor y el API no lo cambia. Si no
 * se puede sugerir, `sin_sugerencia` dice por qué y los montos van en null.
 */
export async function getPrimaSugerida(expedienteId: string, userId?: string, userRol?: string) {
  await assertExpedienteAccess(expedienteId, userId, userRol);
  const { tarifasParaContrato } = await import('@/modules/contratos/contratos.service');
  const db = (tabla: string) => supabase.from(tabla as string) as ReturnType<typeof supabase.from>;
  const [tarifas, { data: contrato, error }, coa] = await Promise.all([
    tarifasParaContrato(expedienteId),
    db('contratos')
      .select('valor_arriendo')
      .eq('expediente_id', expedienteId)
      .neq('estado', 'cancelado')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // tarifasParaContrato da "firma solo" (20 %) si no logra leer el
    // coarrendatario; aquí se relee estricto (null = no se pudo leer) para no
    // sugerir el doble del 10 %.
    coarrendatarioVinculado(expedienteId, { estricto: true }).then(
      (c) => c !== null,
      () => null,
    ),
  ]);
  if (error) throw fromSupabaseError(error);
  const canonContrato = Number((contrato as { valor_arriendo?: unknown } | null)?.valor_arriendo) || null;
  const t = canonContrato ? sobreCanon(tarifas, canonContrato) : tarifas;
  // Con la prima negociada por Gerencia el coarrendatario ya no cambia la cifra.
  const coaConfirmado = t.override?.prima_vinculacion_pct != null || coa === t.con_coarrendatario;
  const sinSugerencia = !coaConfirmado
    ? 'No se pudo confirmar si el estudio tiene coarrendatario, y con él la prima baja del 20 % al 10 %: escribe el monto a mano.'
    : t.prima_vinculacion_con_iva_cop === null
      ? 'No hay canon ni en el contrato ni en el estudio: escribe el monto a mano.'
      : null;
  return {
    canon: canonContrato ? ('contrato' as const) : ('estudio' as const),
    prima_vinculacion_pct: coaConfirmado ? t.prima_vinculacion_pct : null,
    prima_vinculacion_cop: sinSugerencia ? null : t.prima_vinculacion_cop,
    iva_pct: t.iva_pct,
    prima_vinculacion_con_iva_cop: sinSugerencia ? null : t.prima_vinculacion_con_iva_cop,
    sin_sugerencia: sinSugerencia,
  };
}

// ============================================================
// Create payment link (via Stripe) — POST /expedientes/:expedienteId/pagos
// ============================================================

export async function createPaymentLink(
  expedienteId: string,
  input: CreatePaymentLinkInput,
  userId: string,
  userRol?: string,
  ip?: string,
) {
  // 1. Verify expediente exists
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Estudio no encontrado');
  }

  // Ownership multi-tenant (cierra IDOR): propietario/inmobiliaria solo crean
  // pagos sobre expedientes de su cartera. 404 fuera de scope.
  await assertExpedienteAccess(expedienteId, userId, userRol);

  // P1: la evaluación de un estudio cerrado o rechazado no se cobra (se tendría
  // que devolver; la re-evaluación con soportes no genera cobro).
  const estadoExp = (expediente as { estado: string }).estado;
  if (input.concepto === 'estudio' && (estadoExp === 'cerrado' || estadoExp === 'rechazado')) {
    throw AppError.conflict(`El estudio está ${estadoExp}: no se cobra la evaluación.`, 'EXPEDIENTE_CERRADO');
  }

  // 1a. FIRMA INCOMPLETA (contratos V3, §11.7.3). Depósito: no en vivienda.
  await assertFianzaOperando(expedienteId, input.concepto);
  await assertDepositoPermitido(expedienteId, input.concepto);

  // 1b. TOPE DE CANON — flujo §4.4: "ANTES de avanzar y de generar cualquier
  //     cobro... no se cobra el estudio". Esta ruta generica es el OTRO camino
  //     por el que se cobra un estudio: la UI ofrece "Generar Link de Pago" con
  //     'Estudio de riesgo crediticio' como primer concepto, y desde aqui se
  //     creaba el pago pendiente + la preference de la pasarela + el correo al
  //     arrendatario sin pasar nunca por /pago-estudio/enviar-link, que si tiene
  //     el guard. Sin esto el tope solo aparecia en ejecutarEstudio, con la
  //     plata ya capturada.
  //
  //     Solo aplica a concepto='estudio': garantia, primer_canon, deposito y
  //     otro no son el cobro que el §4.4 regula.
  //     Y el MONTO no puede venir del cliente: el gate de ejecucion (§6.3)
  //     solo comprueba que exista una fila 'estudio'+'completado', nunca su
  //     valor, asi que un link de $1.000 pagaba una consulta al buro entera.
  //     El precio canonico lo manda configuracion_sistema, igual que
  //     /pago-estudio/enviar-link. Import dinamico: pago-estudio.service ya
  //     importa de aqui (attachFacturas) y un import estatico cerraria el ciclo.
  let monto = input.monto;
  if (input.concepto === 'estudio') {
    await assertCanonDentroDelTope({ expedienteId, origen: 'createPaymentLink' });
    const { getMontoEstudio, cerrarCobroEstudioFallido } = await import(
      '@/modules/pago-estudio/pago-estudio.service'
    );
    monto = await getMontoEstudio();

    // Esta es la TERCERA puerta que abre un cobro de estudio, y tenia el mismo
    // hueco que crearCobroPasarela: el chequeo de duplicados de abajo solo mira
    // 'pendiente' y 'procesando', asi que un cobro anterior en 'fallido' se
    // colaba con su link todavia pagable y quedaban dos checkouts vivos.
    const { data: fallidos } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, external_id, metodo')
      .eq('expediente_id', expedienteId)
      .eq('concepto', 'estudio')
      .eq('estado', 'fallido');
    for (const previo of ((fallidos as Array<Record<string, unknown>> | null) ?? [])) {
      await cerrarCobroEstudioFallido(previo, userId);
    }
  }

  // 2. Check for duplicate: no pendiente/procesando for same expediente+concepto
  const { data: existing } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .eq('concepto', input.concepto)
    .in('estado', ['pendiente', 'procesando']);

  if (existing && existing.length > 0) {
    throw AppError.conflict(
      `Ya existe un pago ${input.concepto.replace(/_/g, ' ')} pendiente o en proceso para este estudio`,
      'PAGO_DUPLICADO',
    );
  }

  // 3. Build success/cancel/pending URLs (pending: PSE/efectivo no debe verse como éxito)
  //    El id va PRE-generado y viaja en las URLs: sin `&pago=` la pantalla de
  //    resultado no puede consultar el pago, asi que para garantia, canon y
  //    deposito no habia ni concepto, ni monto, ni boton de reintento — cosa que
  //    la ruta de /pago-estudio si hacia.
  const pagoId = crypto.randomUUID();
  const resultUrl = `${env.FRONTEND_URL}/pago/resultado`;
  const successUrl = `${resultUrl}?status=success&expediente=${expedienteId}&pago=${pagoId}`;
  const cancelUrl = `${resultUrl}?status=cancelled&expediente=${expedienteId}&pago=${pagoId}`;
  // Un rechazo del banco NO es una cancelacion voluntaria: sin esta URL aparte
  // aterrizaba con status=cancelled y la web decia "Has cancelado el proceso de
  // pago" a quien le rechazaron la tarjeta.
  const failureUrl = `${resultUrl}?status=failed&expediente=${expedienteId}&pago=${pagoId}`;
  const pendingUrl = `${resultUrl}?status=pending&expediente=${expedienteId}&pago=${pagoId}`;

  const gateway = getPaymentGateway();
  const conceptLabel = CONCEPTO_LABELS[input.concepto] || input.concepto;
  const expNumero = (expediente as { numero: string }).numero;

  // 4. Insert pago record ANTES de crear el checkout, con el id pre-generado
  // arriba: así la preference lleva el pago_id en external_reference/metadata y
  // el webhook puede casar el pago EXACTO (no "el más reciente del expediente").
  const { error: insertError } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      id: pagoId,
      expediente_id: expedienteId,
      concepto: input.concepto,
      descripcion: input.descripcion,
      monto,
      metodo: 'pasarela',
      estado: 'pendiente',
      email_pagador: input.email_pagador,
      nombre_pagador: input.nombre_pagador,
      creado_por: userId,
    } as never);

  if (insertError) {
    // 23505 = índice único uq_pagos_estudio_activo (carrera de doble click).
    if (insertError.code === '23505') {
      throw AppError.conflict(
        `Ya existe un pago ${input.concepto.replace(/_/g, ' ')} activo para este estudio`,
        'PAGO_DUPLICADO',
      );
    }
    logger.error({ error: insertError.message }, 'Error al crear registro de pago');
    throw fromSupabaseError(insertError);
  }

  // 5. Create checkout session in the gateway; si falla, no dejamos fila huérfana.
  let linkResult: { url: string; externalId: string };
  try {
    linkResult = await gateway.createPaymentLink({
      amount: monto,
      concept: `${conceptLabel} - Estudio ${expNumero}`,
      description: input.descripcion,
      metadata: {
        expediente_id: expedienteId,
        concepto: input.concepto,
        email_pagador: input.email_pagador,
        pago_id: pagoId,
      },
      successUrl,
      cancelUrl,
      failureUrl,
      pendingUrl,
    });
  } catch (gatewayError) {
    await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', pagoId);
    throw gatewayError;
  }

  // 5b. Persistir el link en la fila — CAS sobre 'pendiente': si el pago fue
  // cancelado concurrentemente mientras creábamos el checkout, NO adjuntamos un
  // link pagable a un pago cancelado (expiramos la preference y abortamos).
  const { data: pago, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .update({
      payment_link_url: linkResult.url,
      external_id: linkResult.externalId,
    } as never)
    .eq('id', pagoId)
    .eq('estado', 'pendiente')
    .select(PAGO_SELECT)
    .maybeSingle();

  if (error) {
    logger.error({ error: error.message, pagoId }, 'Error al guardar el link en el pago — se revierte');
    await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', pagoId);
    if (gateway.cancelPaymentLink) {
      gateway.cancelPaymentLink(linkResult.externalId).catch((err) =>
        logger.warn({ err, externalId: linkResult.externalId }, 'No se pudo expirar la preference tras revertir'),
      );
    }
    throw fromSupabaseError(error);
  }

  if (!pago) {
    // 0 filas: cancelación concurrente. La fila es historial (ya 'cancelado') —
    // no se borra; el link recién creado se invalida para que no sea pagable.
    if (gateway.cancelPaymentLink) {
      gateway.cancelPaymentLink(linkResult.externalId).catch((err) =>
        logger.warn({ err, externalId: linkResult.externalId }, 'No se pudo expirar la preference tras cancelación concurrente'),
      );
    }
    throw AppError.conflict('El pago fue cancelado mientras se creaba el link', 'PAGO_CANCELADO_CONCURRENTE');
  }

  // 6. Record event
  await recordEvent(pago.id, 'created', 'system', {
    gateway: gateway.provider,
    external_id: linkResult.externalId,
    email_pagador: input.email_pagador,
  });

  // 7. Send email if requested
  if (input.enviar_email) {
    try {
      await sendPaymentLinkEmail(
        input.email_pagador,
        input.nombre_pagador,
        linkResult.url,
        {
          concepto: conceptLabel,
          monto: formatCOP(monto),
          expediente_numero: expNumero,
        },
      );

      await recordEvent(pago.id, 'link_sent', 'system', {
        email: input.email_pagador,
      });
    } catch (emailError) {
      logger.error({ emailError, pagoId: pago.id }, 'Error al enviar email de pago (pago creado correctamente)');
    }
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_CREATED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: {
      expediente_id: expedienteId,
      concepto: input.concepto,
      monto,
      email_pagador: input.email_pagador,
    },
    ip,
  });

  return pago;
}

// ============================================================
// Cancel pago — PATCH /pagos/:pagoId/cancelar
// Uses centralized state machine (HP-352)
// ============================================================

export async function cancelPago(pagoId: string, userId: string, userRol?: string, ip?: string) {
  // Ownership multi-tenant (cierra IDOR): resolvemos el expediente del pago y
  // gateamos por cartera antes de mutar. 404 fuera de scope; si el pago no
  // existe, la transición de abajo lanza el 404 habitual.
  const { data: row } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('expediente_id')
    .eq('id', pagoId)
    .maybeSingle();
  const expId = (row as { expediente_id?: string } | null)?.expediente_id;
  if (expId) await assertExpedienteAccess(expId, userId, userRol);

  const pago = await transitionPagoState({
    pagoId,
    targetEstado: 'cancelado',
    origen: 'manual',
    detalles: { cancelado_por: userId },
    userId,
    ip,
  });

  // Expirar el link en la pasarela (best-effort): un pago cancelado no debe
  // seguir siendo pagable desde el email del arrendatario.
  const p = pago as { external_id?: string | null; metodo?: string | null } | null;
  if (p?.metodo === 'pasarela' && p.external_id) {
    const gateway = getPaymentGateway();
    if (gateway.cancelPaymentLink) {
      gateway.cancelPaymentLink(p.external_id).catch((err) =>
        logger.warn({ err, pagoId }, 'No se pudo expirar el link en la pasarela (pago ya cancelado en BD)'),
      );
    }
  }

  return pago;
}

/**
 * Cancela TODOS los pagos pendientes/en proceso de un expediente. Variante de
 * SISTEMA (userId null) para los side-effects de "Terminar/Cancelar contrato".
 * ALCANCE: `pagos` NO tiene `contrato_id` (solo `expediente_id`), así que esto
 * cancela CUALQUIER pago pendiente del expediente sin importar concepto/contrato.
 * En el modelo normal (1 expediente ≈ 1 relación de arriendo) es correcto; el
 * caller ya gatea con `inmuebleLiberado` (no se llama si hay renovación en curso
 * que podría financiarse con esos links).
 * sin esto, un link de pago pendiente seguía siendo pagable y un webhook tardío
 * lo completaba, mandaba "¡recibimos tu pago!" y facturaba en Factus sobre un
 * contrato ya terminado. LOG-ONLY: nunca lanza — la transición del contrato ya
 * quedó confirmada. Un pago 'procesando' (PSE) que luego aprueba cae a
 * pagos_no_conciliados (fail-safe existente) para conciliación/reembolso manual.
 * Expira además el link en la pasarela (best-effort). Devuelve cuántos anuló.
 */
export async function cancelarPagosPendientesDeExpediente(
  expedienteId: string,
  motivo: string,
  /** Solo estos conceptos (p. ej. garantía y primer canon en FIRMA INCOMPLETA); sin él, todos. */
  conceptos?: string[],
  /** 'fallido' también se puede pagar después: Mercado Pago deja reintentar en el mismo checkout. */
  estados: string[] = ['pendiente', 'procesando'],
): Promise<number> {
  let cancelados = 0;
  try {
    let q = (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, metodo, external_id')
      .eq('expediente_id', expedienteId)
      .in('estado', estados);
    if (conceptos) q = q.in('concepto', conceptos);
    const { data } = await q;
    const pagos = (data as Array<{ id: string; estado: string; metodo: string | null; external_id: string | null }> | null) ?? [];

    for (const pago of pagos) {
      try {
        await transitionPagoState({
          pagoId: pago.id,
          targetEstado: 'cancelado',
          origen: 'system',
          detalles: { motivo, cancelado_por: 'sistema' },
          userId: null,
        });
        cancelados++;
        // Expirar el link en la pasarela (best-effort): un pago cancelado no
        // debe seguir siendo pagable desde el email del arrendatario.
        if (pago.metodo === 'pasarela' && pago.external_id) {
          const gateway = getPaymentGateway();
          if (gateway.cancelPaymentLink) {
            gateway.cancelPaymentLink(pago.external_id).catch((err) =>
              logger.warn({ err, pagoId: pago.id }, 'No se pudo expirar el link en la pasarela'),
            );
          }
        }
      } catch (err) {
        logger.warn({ err, pagoId: pago.id, expedienteId, motivo }, 'No se pudo cancelar un pago pendiente');
      }
    }
    if (pagos.length > 0) {
      logger.info({ expedienteId, cancelados, motivo }, 'Pagos pendientes cancelados');
    }
  } catch (err) {
    logger.error({ err, expedienteId }, 'Error cancelando pagos pendientes del estudio');
  }
  return cancelados;
}

/**
 * Ley 820 de 2003 art. 16 (Técnico V3 §2.5): en la vivienda urbana no se exige
 * depósito ni garantía en dinero, así que ni se cobra ni se factura. La
 * destinación sale de inmuebles.uso (destinacionDeUso). Solo lo comercial lo
 * admite: mixto (tiene vivienda) o sin uso reconocido se trata como vivienda.
 * Vale al crear el link, al reenviarlo y al registrar un pago a mano.
 */
async function assertDepositoPermitido(expedienteId: string, concepto: string): Promise<void> {
  if (concepto !== 'deposito') return;
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('inmuebles!expedientes_inmueble_id_fkey(uso)')
    .eq('id', expedienteId)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  const uso = (data as { inmuebles?: { uso?: string | null } | null } | null)?.inmuebles?.uso;
  if (destinacionDeUso(uso) !== 'comercial') {
    throw AppError.badRequest(
      'En un arrendamiento de vivienda no se cobra depósito de garantía (Ley 820 de 2003, art. 16): el cumplimiento del arrendatario lo respalda la fianza.',
      'DEPOSITO_NO_PERMITIDO_VIVIENDA',
    );
  }
}

/**
 * Contratos V3 (§11.7.1-11.7.3 y Adenda 1 del módulo de contratos, respuesta
 * 12): mientras el contrato no esté firmado por todas las partes (borrador, EN
 * FIRMA o FIRMA INCOMPLETA) la fianza no opera, así que no se cobra garantía
 * ni primer canon (cada pago es una factura real ante la DIAN). Vale al crear
 * el link, al reenviarlo y al registrar un pago a mano. Solo mira filas V3, y
 * filtra el estado aquí y no en la consulta para no depender del valor nuevo del enum.
 */
const V3_SIN_FIRMA_COMPLETA = ['borrador', 'pendiente_firma', 'firma_incompleta'];

async function assertFianzaOperando(expedienteId: string, concepto: string): Promise<void> {
  if (concepto !== 'garantia' && concepto !== 'primer_canon') return;
  const { data: v3, error: v3Error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('estado')
    .eq('expediente_id', expedienteId)
    .not('destinacion', 'is', null);
  if (v3Error) throw fromSupabaseError(v3Error);
  const sinFirma = ((v3 as Array<{ estado: string }> | null) ?? []).find((c) => V3_SIN_FIRMA_COMPLETA.includes(c.estado));
  if (sinFirma) {
    throw AppError.conflict(
      sinFirma.estado === 'firma_incompleta'
        ? 'La firma del contrato está incompleta: la fianza no está operando. Reenvíalo a firma antes de cobrar la prima de vinculación o el primer canon.'
        : 'El contrato todavía no está firmado por todas las partes: la prima de vinculación y el primer canon se cobran cuando firmen todos.',
      'FIANZA_NO_OPERANDO',
    );
  }
}

// ============================================================
// Resend payment link email — POST /pagos/:pagoId/reenviar-link
// ============================================================

export async function resendPaymentLink(pagoId: string, userId: string, userRol?: string, ip?: string) {
  const pago = await getPagoById(pagoId) as unknown as {
    id: string;
    estado: string;
    payment_link_url: string | null;
    email_pagador: string | null;
    nombre_pagador: string | null;
    concepto: string;
    monto: number;
    expediente_id: string;
  };

  // Ownership multi-tenant (cierra IDOR): gateamos por cartera antes de
  // reenviar el email y devolver el email_pagador. 404 fuera de scope.
  await assertExpedienteAccess(pago.expediente_id, userId, userRol);
  await assertFianzaOperando(pago.expediente_id, pago.concepto);
  await assertDepositoPermitido(pago.expediente_id, pago.concepto);

  if (pago.estado !== 'pendiente') {
    throw AppError.badRequest(
      'Solo se puede reenviar el link de pagos en estado pendiente',
      'PAGO_NO_REENVIABLE',
    );
  }

  if (!pago.payment_link_url) {
    throw AppError.badRequest('Este pago no tiene un link de pago asociado', 'NO_PAYMENT_LINK');
  }

  if (!pago.email_pagador) {
    throw AppError.badRequest('Este pago no tiene email del pagador', 'NO_EMAIL_PAGADOR');
  }

  // Get expediente numero for email context
  const { data: expediente } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero')
    .eq('id', pago.expediente_id)
    .single();

  const conceptLabel = CONCEPTO_LABELS[pago.concepto] || pago.concepto;
  const expNumero = (expediente as { numero: string } | null)?.numero || '';

  await sendPaymentLinkEmail(
    pago.email_pagador,
    pago.nombre_pagador || '',
    pago.payment_link_url,
    {
      concepto: conceptLabel,
      monto: formatCOP(pago.monto),
      expediente_numero: expNumero,
    },
  );

  await recordEvent(pagoId, 'link_sent', 'system', {
    email: pago.email_pagador,
    reenviado_por: userId,
  });

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_LINK_RESENT,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pagoId,
    detalle: { email: pago.email_pagador },
    ip,
  });

  return { message: `Link de pago reenviado a ${pago.email_pagador}` };
}

// ============================================================
// Presigned URL for comprobante upload (HP-350)
// ============================================================

export async function generateComprobantePresignedUrl(
  input: ComprobantePresignedUrlInput,
  userId: string,
) {
  const ext = input.nombre_original.split('.').pop()?.toLowerCase() || 'bin';
  const storageKey = `comprobantes/${userId}/${crypto.randomUUID()}.${ext}`;

  const { data, error } = await supabase.storage
    .from(COMPROBANTE_BUCKET)
    .createSignedUploadUrl(storageKey);

  if (error) {
    logger.error({ error: error.message }, 'Error generating comprobante presigned URL');
    throw AppError.badRequest('Error al generar URL de carga', 'STORAGE_ERROR');
  }

  return {
    signedUrl: data.signedUrl,
    storage_key: storageKey,
    token: data.token,
    expires_in: PRESIGNED_URL_EXPIRY,
  };
}

// ============================================================
// Get comprobante download URL (HP-350)
// ============================================================

export async function getComprobanteUrl(pagoId: string, userId?: string, userRol?: string) {
  const pago = await getPagoById(pagoId) as unknown as {
    expediente_id: string;
    comprobante_storage_key: string | null;
    comprobante_nombre_original: string | null;
  };

  // Ownership multi-tenant (cierra IDOR): gateamos por cartera antes de firmar
  // la URL de descarga del comprobante. 404 fuera de scope.
  await assertExpedienteAccess(pago.expediente_id, userId, userRol);

  if (!pago.comprobante_storage_key) {
    throw AppError.notFound('Este pago no tiene comprobante adjunto');
  }

  const { data, error } = await supabase.storage
    .from(COMPROBANTE_BUCKET)
    .createSignedUrl(pago.comprobante_storage_key, PRESIGNED_URL_EXPIRY, {
      download: pago.comprobante_nombre_original || 'comprobante',
    });

  if (error) {
    logger.error({ error: error.message, pagoId }, 'Error generating comprobante download URL');
    throw AppError.badRequest('Error al generar URL de descarga', 'STORAGE_ERROR');
  }

  return {
    url: data.signedUrl,
    nombre_original: pago.comprobante_nombre_original,
    expires_in: PRESIGNED_URL_EXPIRY,
  };
}

// ============================================================
// Register manual payment — POST /expedientes/:expedienteId/pagos/manual (HP-350)
// ============================================================

export async function registerManualPayment(
  expedienteId: string,
  input: RegisterManualPaymentInput,
  userId: string,
  userRol?: string,
  ip?: string,
) {
  // Verify expediente exists
  const { data: expRow, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('id', expedienteId)
    .single();

  if (expError) {
    throw AppError.notFound('Estudio no encontrado');
  }

  // Ownership multi-tenant (cierra IDOR): propietario/inmobiliaria solo
  // registran pagos sobre expedientes de su cartera. 404 fuera de scope.
  await assertExpedienteAccess(expedienteId, userId, userRol);
  // P1: la evaluación de un estudio cerrado o rechazado no se cobra (se tendría que devolver).
  const estadoExp = (expRow as { estado?: string } | null)?.estado;
  if (input.concepto === 'estudio' && (estadoExp === 'cerrado' || estadoExp === 'rechazado')) {
    throw AppError.conflict(`El estudio está ${estadoExp}: no se cobra la evaluación.`, 'EXPEDIENTE_CERRADO');
  }
  // §11.7.3: la misma puerta que el link de pago; a mano tampoco se cobra con la firma incompleta.
  await assertFianzaOperando(expedienteId, input.concepto);
  await assertDepositoPermitido(expedienteId, input.concepto);

  // Un enlace vivo del mismo concepto se podría pagar después: doble cobro y
  // doble factura (la del webhook sale sola). 'fallido' cuenta porque MP deja
  // reintentar en el mismo checkout.
  const { data: vivos } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .eq('concepto', input.concepto)
    .in('estado', ['pendiente', 'procesando', 'fallido']);
  const estadosVivos = ((vivos as Array<{ estado: string }> | null) ?? []).map((p) => p.estado);
  if (estadosVivos.includes('procesando')) {
    throw AppError.conflict(
      'Hay un pago por PSE o en efectivo en proceso para este concepto. Espera a que se confirme o venza antes de registrar el pago manual.',
      'PAGO_EN_PROCESO',
    );
  }
  if (estadosVivos.length > 0) {
    throw AppError.conflict(
      'Hay un enlace de pago vivo para este concepto. Cancélalo en la lista de pagos antes de registrar el pago manual.',
      'PAGO_DUPLICADO',
    );
  }

  // Validate fecha_pago is not in the future
  const fechaPago = new Date(input.fecha_pago);
  if (fechaPago > new Date()) {
    throw AppError.badRequest('La fecha de pago no puede ser una fecha futura', 'FECHA_FUTURA');
  }

  // If comprobante was provided, verify file exists in storage
  if (input.comprobante_storage_key) {
    const { data: fileCheck } = await supabase.storage
      .from(COMPROBANTE_BUCKET)
      .createSignedUrl(input.comprobante_storage_key, 60);

    if (!fileCheck) {
      throw AppError.badRequest('El comprobante no se encontro en el almacenamiento', 'COMPROBANTE_NOT_FOUND');
    }
  }

  const { data: pago, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      concepto: input.concepto,
      descripcion: input.descripcion || null,
      monto: input.monto,
      metodo: input.metodo,
      estado: 'completado',
      referencia_bancaria: input.referencia_bancaria || null,
      comprobante_storage_key: input.comprobante_storage_key || null,
      comprobante_nombre_original: input.comprobante_nombre_original || null,
      comprobante_tipo_mime: input.comprobante_tipo_mime || null,
      comprobante_tamano_bytes: input.comprobante_tamano_bytes || null,
      notas: input.notas || null,
      fecha_pago: fechaPago.toISOString(),
      creado_por: userId,
    } as never)
    .select(PAGO_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al registrar pago manual');
    throw fromSupabaseError(error);
  }

  await recordEvent(pago.id, 'completed', 'manual', {
    metodo: input.metodo,
    registrado_por: userId,
    tiene_comprobante: !!input.comprobante_storage_key,
  });

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_MANUAL_REGISTERED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: {
      expediente_id: expedienteId,
      concepto: input.concepto,
      monto: input.monto,
      metodo: input.metodo,
    },
    ip,
  });

  // §6.3: este pago satisface el gate de ejecución, pero como NO pasa por
  // dispatchPagoCompletado nadie despertaría el estudio aparcado en espera de
  // pago — quedaría pagado y parado esperando un click manual. Se avisa al
  // dueño del evento (que es idempotente). NO se enruta por
  // dispatchPagoCompletado a propósito: eso le agregaría de golpe el WhatsApp
  // de pago y la facturación electrónica automática, que estos pagos manuales
  // no tienen (se facturan a mano) — riesgo de doble facturación.
  if (input.concepto === 'estudio') {
    import('@/modules/orchestrator/orchestrator.service')
      .then(({ onEstudioPagado }) => onEstudioPagado(expedienteId, userId))
      .catch((err) =>
        logger.warn(
          { error: err instanceof Error ? err.message : String(err), expedienteId },
          'No se pudo continuar el flujo del estudio tras el pago manual',
        ),
      );
  }

  return pago;
}

// ============================================================
// Process webhook event (HP-349 + HP-352)
// Always returns { received: true } — never throws to the gateway.
// Idempotent: duplicate events are silently ignored.
// All state changes go through the centralized state machine.
// ============================================================

/** Map of Stripe event types we handle → target pago estado */
const WEBHOOK_EVENT_MAP: Record<string, EstadoPago> = {
  'checkout.session.completed': 'completado',
  'checkout.session.expired': 'cancelado',
  'checkout.session.async_payment_succeeded': 'completado',
  'checkout.session.async_payment_failed': 'fallido',
  'payment_intent.succeeded': 'completado',
  'payment_intent.payment_failed': 'fallido',
  'charge.refunded': 'reembolsado',
};

export async function processWebhookEvent(
  payload: Buffer,
  headers: Record<string, string | string[] | undefined>,
  query?: Record<string, unknown>,
) {
  // 1. Verify signature (throws 400 on invalid — this is the ONLY case we reject)
  const gateway = getPaymentGateway();
  const { event, type, eventId } = gateway.verifyWebhook(payload, headers, query);

  logger.info({ provider: gateway.provider, type, eventId }, 'Webhook event received');

  // Mercado Pago usa un modelo de webhook distinto a Stripe (el evento es solo un
  // aviso con un payment id; el estado real se consulta y el cruce va por
  // external_reference). Se maneja en su propia ruta.
  if (gateway.provider === 'mercadopago') {
    return processMercadoPagoWebhook(eventId, type, gateway);
  }

  // 2. Check if this is an event type we handle
  const targetEstado = WEBHOOK_EVENT_MAP[type];
  if (!targetEstado) {
    logger.info({ type, eventId }, 'Webhook event type not handled — ignoring');
    return { received: true };
  }

  // 3. Extract external ID from the event
  const eventObj = (event as { data?: { object?: Record<string, unknown> } }).data?.object;
  const externalId = eventObj?.id as string | undefined;

  if (!externalId) {
    logger.warn({ type, eventId }, 'Webhook event missing object ID');
    return { received: true };
  }

  // 3.5. Dispatch alterno: compras de creditos de estudios (no usan tabla pagos).
  //      La compra se identifica por metadata.concepto = 'creditos_estudios' y
  //      se despacha a creditos-estudios.service para crear el lote.
  const metadata = eventObj?.metadata as Record<string, string> | undefined;
  if (metadata?.concepto === 'creditos_estudios' && type === 'checkout.session.completed') {
    try {
      const { acreditarCompraDesdeWebhook } = await import('@/modules/creditos-estudios/creditos-estudios.service');
      const paymentIntentId = (eventObj?.payment_intent as string | null) ?? null;
      const result = await acreditarCompraDesdeWebhook(externalId, paymentIntentId, eventObj || {});
      logger.info({ externalId, eventId, result }, 'Creditos estudios: compra acreditada via webhook');
    } catch (err) {
      logger.error({ err, externalId, eventId }, 'Error acreditando compra de creditos via webhook');
    }
    return { received: true };
  }

  // 4. Find pago — try external_id first, then transaction_ref as fallback.
  //    For checkout.session.* events: external_id = session ID
  //    For payment_intent.* events: try transaction_ref first, then check
  //    if a checkout session stored this payment_intent via metadata.
  let pago: Record<string, unknown> | null = null;

  if (type.startsWith('checkout.session.')) {
    // Checkout events — session ID is our external_id
    const { data } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado')
      .eq('external_id', externalId)
      .single();
    pago = data as Record<string, unknown> | null;
  } else {
    // payment_intent.* or charge.* — try transaction_ref first
    const { data: byRef } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado')
      .eq('transaction_ref', externalId)
      .single();

    if (byRef) {
      pago = byRef as Record<string, unknown>;
    } else {
      // Fallback: for payment_intent events, Stripe includes the checkout session
      // metadata. Try to find pago by matching the payment_intent's metadata.expediente_id
      // or by fetching the checkout session that created this intent.
      const expId = metadata?.expediente_id;
      if (expId) {
        const { data: byMeta } = await (supabase
          .from('pagos' as string) as ReturnType<typeof supabase.from>)
          .select('id, estado')
          .eq('expediente_id', expId)
          .eq('metodo', 'pasarela')
          .in('estado', ['pendiente', 'procesando'])
          .order('created_at', { ascending: false })
          .limit(1);
        if (byMeta && byMeta.length > 0) {
          pago = byMeta[0] as Record<string, unknown>;
        }
      }
    }
  }

  if (!pago) {
    logger.warn({ externalId, type, eventId }, 'Pago not found for webhook event');
    return { received: true };
  }

  const pagoId = (pago as { id: string }).id;

  // 5. Idempotency: check if this eventId was already recorded
  const { data: existingEvent } = await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('pago_id', pagoId)
    .eq('detalles->>stripe_event_id', eventId)
    .limit(1);

  if (existingEvent && existingEvent.length > 0) {
    logger.info({ pagoId, eventId }, 'Duplicate webhook eventId — idempotent skip');
    return { received: true };
  }

  // 6. Build extra update data for completado (fetch Stripe details)
  let extraUpdate: Record<string, unknown> | undefined;
  if (targetEstado === 'completado') {
    try {
      // For checkout.session.* events, externalId is the session ID → use directly.
      // For payment_intent.* events, externalId is the PI ID → use pago's external_id
      // (which is the checkout session ID) to fetch full status.
      let lookupId = externalId;
      if (type.startsWith('payment_intent.')) {
        // Fetch the pago's stored external_id (checkout session ID) for status lookup
        const { data: fullPago } = await (supabase
          .from('pagos' as string) as ReturnType<typeof supabase.from>)
          .select('external_id')
          .eq('id', pagoId)
          .single();
        const storedExternalId = (fullPago as { external_id: string } | null)?.external_id;
        if (storedExternalId) {
          lookupId = storedExternalId;
        } else {
          // No session ID available — store the PI ID as transaction_ref directly
          extraUpdate = { transaction_ref: externalId };
        }
      }

      if (!extraUpdate) {
        const status = await gateway.getPaymentStatus(lookupId);
        extraUpdate = {
          transaction_ref: status.transactionRef,
          gateway_response: status.rawResponse,
        };
      }
    } catch (err) {
      logger.warn({ err, pagoId }, 'Failed to fetch Stripe payment status — proceeding without');
    }
  }

  // 7. Capturar estado previo para guard de idempotencia del orchestrator.
  //    Si el pago ya estaba 'completado' por un evento anterior (posible con
  //    Stripe enviando checkout.session.completed + payment_intent.succeeded
  //    para el mismo pago con eventIds distintos), transitionPagoState hace
  //    idempotent-skip internamente pero NO podemos disparar onPagoConfirmado
  //    de nuevo — ejecutarEstudio cuesta dinero real en TransUnion.
  const estadoAntes = (pago as { estado: string }).estado;

  // 8. Execute transition via state machine
  try {
    await transitionPagoState({
      pagoId,
      targetEstado,
      origen: 'webhook',
      detalles: {
        stripe_event_id: eventId,
        stripe_event_type: type,
        transaction_ref: extraUpdate?.transaction_ref ?? null,
      },
      extraUpdate,
    });

    logger.info({ pagoId, targetEstado, eventId }, 'Webhook state transition completed');
  } catch (processingError) {
    // Log but never throw — always return 200 to the gateway
    logger.error({ processingError, pagoId, eventId, type }, 'Error processing webhook event internally');
    return { received: true };
  }

  // 9. Dispatch al orchestrator solo si la transición fue efectiva.
  //    Guard: targetEstado='completado' + el pago NO estaba ya en 'completado'.
  //    Mantiene 1 única ejecución de TransUnion por pago exitoso.
  if (targetEstado === 'completado' && estadoAntes !== 'completado') {
    // Dispatch reutilizable (mismo camino que el endpoint dev de simulación),
    // para que webhook real y simulación no se desincronicen.
    await dispatchPagoCompletado(pagoId);
  }

  return { received: true };
}

/**
 * Despacha el orquestador tras un pago que ACABA de transicionar a 'completado'
 * (estudio automático + auto-envío del link de autorización + facturación). El
 * aviso in-app lo manda la máquina de estados (notifyPagoConfirmado). Best-effort: registra el error pero nunca relanza
 * (un 500 al webhook dispararía retry de Stripe). Llamar SOLO en la primera
 * transición a 'completado' para no duplicar el dispatch.
 */
export async function dispatchPagoCompletado(pagoId: string): Promise<void> {
  try {
    const { data: pagoFull } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, expediente_id, concepto')
      .eq('id', pagoId)
      .single();

    if (!pagoFull) {
      logger.error({ pagoId }, 'dispatchPagoCompletado: pago no encontrado tras transición');
      return;
    }

    const p = pagoFull as unknown as { id: string; expediente_id: string; concepto: string };

    // P1: la evaluación que se paga con el estudio ya cerrado o rechazado, sin
    // consulta al buró, queda para devolver: ni se factura ni se ejecuta.
    if (p.concepto === 'estudio') {
      const { retenerPagoTardio } = await import('./reembolsos.service');
      if (await retenerPagoTardio(p.id, p.expediente_id)) return;
    }

    // Import dinámico: evita el ciclo pagos ↔ orchestrator.
    const { onPagoConfirmado } = await import('@/modules/orchestrator/orchestrator.service');
    await onPagoConfirmado({ pagoId: p.id, expedienteId: p.expediente_id, concepto: p.concepto });
  } catch (err) {
    logger.error({ pagoId, err }, 'dispatchPagoCompletado: onPagoConfirmado falló — requiere intervención manual');
  }
}

// ============================================================
// Mercado Pago webhook handler
// El webhook de MP es solo un aviso (type=payment + data.id). Consultamos el
// pago real, mapeamos su estado y cruzamos con NUESTRO registro vía
// external_reference = "<concepto>:<expediente_id|compra_id>".
// Siempre responde 200 (salvo firma inválida, que se rechaza antes en verifyWebhook).
// ============================================================

async function processMercadoPagoWebhook(
  paymentId: string,
  type: string,
  gateway: ReturnType<typeof getPaymentGateway>,
): Promise<{ received: true }> {
  // Solo nos interesan notificaciones de pagos (MP también manda merchant_order, etc.).
  if (type !== 'payment') {
    logger.info({ type, paymentId }, 'MP webhook: tipo no manejado — ignorado');
    return { received: true };
  }

  // 1. Consultar el pago real (el webhook no trae el estado).
  let status;
  try {
    status = await gateway.getPaymentStatus(paymentId);
  } catch (err) {
    logger.error({ err, paymentId }, 'MP webhook: no se pudo consultar el pago — 200 para evitar reintentos infinitos');
    return { received: true };
  }

  // external_reference: "<concepto>:<refId>[:<pago_id>]" — el 3er segmento (si
  // existe) identifica el pago EXACTO; el formato de 2 segmentos es legacy.
  const externalReference = (status.rawResponse as { external_reference?: string | null }).external_reference ?? '';
  const refParts = externalReference.split(':');
  const concepto = refParts[0] ?? '';
  const refId = refParts[1] ?? '';
  const pagoIdRef = refParts[2] ?? '';

  // Contracargo ganado: Mercado Pago le devolvió la plata a Cofianza. Ni la
  // compra ni el cobro se restituyen solos: aviso persistente para hacerlo a mano.
  const rawMp = status.rawResponse as { status?: string; status_detail?: string; transaction_amount?: number };
  if (rawMp.status === 'charged_back' && rawMp.status_detail === 'reimbursed') {
    await avisarContracargoGanado(paymentId, externalReference, rawMp.transaction_amount);
    return { received: true };
  }

  // 2. Mapear estado normalizado del adapter → estado del pago (solo terminales).
  // 'cancelled' es un INTENTO vencido (PSE o efectivo sin pagar), no el cobro:
  // la preference sigue viva y el prospecto puede volver al enlace y pagar con
  // tarjeta. Con 'cancelado' (estado final) ese pago aprobado chocaba contra
  // la máquina de estados y el estudio no avanzaba. 'fallido' admite pasar a
  // completado, entra en la reconciliación y el panel ofrece reenviar el link.
  const estadoMap: Record<string, EstadoPago | undefined> = {
    completed: 'completado',
    failed: 'fallido',
    cancelled: 'fallido',
    refunded: 'reembolsado',
  };
  const targetEstado = estadoMap[status.status];
  if (!targetEstado && status.status !== 'pending') {
    logger.info({ paymentId, status: status.status }, 'MP webhook: estado no terminal — sin transición');
    return { received: true };
  }

  // 3a. Compra de créditos de estudios (no usa la tabla pagos).
  if (concepto === 'creditos_estudios') {
    await webhookCompraCreditos(refId, paymentId, externalReference, status);
    return { received: true };
  }

  // P1: un payment reembolsado cierra su fila de la cola de reembolsos, venga
  // de la plataforma o del panel de Mercado Pago.
  if (targetEstado === 'reembolsado') await cerrarFilaReembolsada(paymentId);

  // 3b. Localizar NUESTRO pago. Preferimos el match exacto por pago_id (3er
  // segmento de external_reference); el fallback legacy filtra también por
  // concepto — sin eso, pagar el estudio podía "completar" la garantía.
  if (!refId && !pagoIdRef) {
    logger.warn({ paymentId, externalReference }, 'MP webhook: external_reference sin estudio — ignorado');
    await registrarPagoNoConciliado(paymentId, externalReference, status, 'referencia_desconocida');
    return { received: true };
  }

  type PagoLookup = { id: string; estado: string; monto: number | string | null; expediente_id: string | null; transaction_ref: string | null };
  let pago: PagoLookup | null = null;

  if (pagoIdRef) {
    const { data } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, monto, expediente_id, transaction_ref')
      .eq('id', pagoIdRef)
      .maybeSingle();
    pago = data as PagoLookup | null;
    if (pago && refId && pago.expediente_id !== refId) {
      logger.error({ paymentId, pagoIdRef, refId }, 'MP webhook: pago_id no corresponde al estudio de la referencia');
      await registrarPagoNoConciliado(paymentId, externalReference, status, 'pago_id_expediente_mismatch');
      return { received: true };
    }
  }

  if (!pago) {
    // Legacy: preferences emitidas antes de codificar pago_id en la referencia.
    const { data: pagoRow } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, monto, expediente_id, transaction_ref')
      .eq('expediente_id', refId)
      .eq('concepto', concepto)
      .eq('metodo', 'pasarela')
      .in('estado', ['pendiente', 'procesando', 'completado'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    pago = pagoRow as PagoLookup | null;
  }

  // El reembolso de OTRO payment con la misma referencia (un pago duplicado que
  // se devolvió) no es del cobro: el cobro legítimo no se toca.
  if (targetEstado === 'reembolsado' && (!pago || pago.transaction_ref !== status.transactionRef)) {
    logger.info({ paymentId, pagoId: pago?.id }, 'MP webhook: reembolso de un payment que no es el del cobro — el cobro no cambia');
    return { received: true };
  }

  if (!pago) {
    logger.error({ expedienteId: refId, paymentId, concepto }, 'MP webhook: pago no encontrado — dinero sin conciliar');
    // El dinero entró a MP pero no hay pago casable (link cancelado pagado,
    // referencia vieja). Queda registrado para reembolso/conciliación manual.
    if (status.status === 'completed') {
      await registrarPagoNoConciliado(paymentId, externalReference, status, 'pago_no_encontrado');
    }
    return { received: true };
  }

  // Reembolso parcial (Mercado Pago devolvió una parte del pago): el cobro no se
  // ajusta solo. Queda en la cola con aviso, como en las compras de créditos, y
  // el pago sigue su curso normal.
  if (targetEstado === 'completado' && rawMp.status_detail === 'partially_refunded') {
    await registrarPagoNoConciliado(paymentId, externalReference, status, 'reembolso_parcial');
  }

  // 3c. Estado no terminal 'pending' (PSE/efectivo): persistir el payment_id y
  // pasar a 'procesando' para que la reconciliación periódica pueda seguirlo.
  if (!targetEstado) {
    if (pago.estado === 'pendiente') {
      try {
        await transitionPagoStateChecked({
          pagoId: pago.id,
          targetEstado: 'procesando',
          origen: 'webhook',
          detalles: { provider: 'mercadopago', mp_payment_id: paymentId, mp_status: 'pending' },
          extraUpdate: { transaction_ref: status.transactionRef, gateway_response: status.rawResponse },
        });
      } catch (err) {
        logger.warn({ err, pagoId: pago.id }, 'MP webhook: no se pudo marcar procesando (pending)');
      }
    }
    return { received: true };
  }

  // 3d. Validar el monto antes de completar: un pago aprobado por un monto
  // distinto al nuestro NO debe marcar el pago como completado.
  const mpAmount = (status.rawResponse as { transaction_amount?: number }).transaction_amount;
  if (
    targetEstado === 'completado'
    && typeof mpAmount === 'number'
    && pago.monto != null
    && Number(pago.monto) !== mpAmount
  ) {
    logger.error(
      { paymentId, pagoId: pago.id, esperado: Number(pago.monto), recibido: mpAmount },
      'MP webhook: monto del pago no coincide — NO se completa (queda para conciliación manual)',
    );
    await registrarPagoNoConciliado(paymentId, externalReference, status, 'amount_mismatch');
    return { received: true };
  }

  if (pago.estado === targetEstado) {
    // Doble cobro: un SEGUNDO payment aprobado sobre un pago ya completado
    // (reintento del comprador) no debe desaparecer en el skip — se registra
    // para reembolso manual. El upsert idempotente absorbe los retries del
    // MISMO payment sin duplicar.
    if (
      targetEstado === 'completado'
      && status.transactionRef
      && pago.transaction_ref
      && status.transactionRef !== pago.transaction_ref
    ) {
      logger.error(
        { pagoId: pago.id, paymentId, previo: pago.transaction_ref },
        'MP webhook: pago duplicado (segundo payment aprobado sobre pago completado) — registrado para reembolso',
      );
      await registrarPagoNoConciliado(paymentId, externalReference, status, 'pago_duplicado');
      return { received: true };
    }
    logger.info({ pagoId: pago.id, estado: targetEstado }, 'MP webhook: pago ya en estado objetivo — idempotent skip');
    return { received: true };
  }

  // Pre-check: dinero aprobado sobre un pago en estado sin camino a 'completado'
  // (cancelado/reembolsado) NO debe perderse en un error de transición — queda
  // registrado para conciliación/reembolso manual.
  if (targetEstado === 'completado' && !isValidTransition(pago.estado as EstadoPago, 'completado')) {
    logger.error(
      { pagoId: pago.id, paymentId, estadoActual: pago.estado },
      'MP webhook: payment aprobado sobre pago no completable — registrado para conciliación',
    );
    // El mismo payment del cobro reembolsado vuelve aprobado (contracargo
    // ganado): va a la cola sin «Reembolsar» de un clic, para restituirlo a mano.
    const vuelveAprobado = pago.estado === 'reembolsado' && !!pago.transaction_ref && pago.transaction_ref === status.transactionRef;
    await registrarPagoNoConciliado(paymentId, externalReference, status, vuelveAprobado ? 'contracargo_ganado' : 'transicion_invalida');
    return { received: true };
  }

  // 3e. Transición atómica (CAS): si webhook y reconciliación llegan a la vez,
  // solo UNA gana `transitioned=true` — el dispatch corre exactamente una vez.
  let transitioned = false;
  try {
    const result = await transitionPagoStateChecked({
      pagoId: pago.id,
      targetEstado,
      origen: 'webhook',
      detalles: { provider: 'mercadopago', mp_payment_id: paymentId, transaction_ref: status.transactionRef },
      extraUpdate: { transaction_ref: status.transactionRef, gateway_response: status.rawResponse },
    });
    transitioned = result.transitioned;
  } catch (err) {
    logger.error({ err, pagoId: pago.id }, 'MP webhook: error en transición de estado');
    // Backstop: si era dinero aprobado (carrera TOCTOU, índice único, etc.),
    // que no se pierda sin rastro.
    if (status.status === 'completed') {
      await registrarPagoNoConciliado(paymentId, externalReference, status, 'transicion_fallida');
    }
    return { received: true };
  }

  // 4. Dispatch al orquestador SOLO en la transición efectiva a completado.
  if (targetEstado === 'completado' && transitioned) {
    await dispatchPagoCompletado(pago.id);
  }
  // P1: el cobro reembolsado que ya tenía factura necesita su nota crédito.
  if (targetEstado === 'reembolsado' && transitioned) {
    await avisarNotaCredito(pago.id, null).catch((err) => logger.warn({ err, pagoId: pago.id }, 'No se pudo avisar la nota crédito'));
  }

  return { received: true };
}

/**
 * Webhook de una compra de créditos. Solo el payment que acreditó la compra la
 * mueve (queda en stripe_payment_intent_id):
 * - aprobado, con la compra sin acreditar → se acredita;
 * - aprobado con otro payment → a la cola como pago duplicado (P22), no se absorbe;
 * - aprobado con un reembolso parcial → a la cola para manejarlo a mano (P22);
 * - reembolsado o contracargado el que acreditó → se revierte la compra (P22);
 *   el de otro payment no revierte nada: solo se cierra su fila de la cola.
 */
async function webhookCompraCreditos(
  compraId: string,
  paymentId: string,
  externalReference: string,
  status: { status: string; transactionRef: string | null; rawResponse: Record<string, unknown> },
): Promise<void> {
  try {
    const { data, error } = await (supabase
      .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, stripe_session_id, stripe_payment_intent_id')
      .eq('id', compraId)
      .maybeSingle();
    if (error) throw error;
    const compra = data as {
      id: string;
      estado: string;
      stripe_session_id: string | null;
      stripe_payment_intent_id: string | null;
    } | null;
    if (!compra) {
      logger.warn({ compraId, paymentId }, 'MP webhook: compra de créditos no encontrada');
      if (status.status === 'completed') await registrarPagoNoConciliado(paymentId, externalReference, status, 'referencia_desconocida');
      return;
    }
    const raw = status.rawResponse as { status?: string; status_detail?: string };

    if (status.status === 'refunded') {
      await cerrarFilaReembolsada(paymentId);
      if (compra.stripe_payment_intent_id === paymentId) await contracargoDeCompra(compra.id, paymentId, raw.status);
      else logger.info({ compraId, paymentId }, 'MP webhook: reembolso de un payment que no acreditó la compra — no se revierte');
      return;
    }
    if (status.status !== 'completed') return;

    if (raw.status_detail === 'partially_refunded') {
      await registrarPagoNoConciliado(paymentId, externalReference, status, 'reembolso_parcial');
      return;
    }
    if (compra.estado === 'cancelado' && compra.stripe_payment_intent_id === paymentId) {
      // ponytail: la compra ya se revirtió por el contracargo; si Mercado Pago
      // vuelve a aprobar el payment (contracargo ganado) no se restituye sola:
      // se avisa para hacerlo a mano. Automatizarlo si deja de ser raro.
      logger.warn({ compraId, paymentId }, 'MP webhook: payment aprobado de una compra revertida — revisar a mano');
      await avisarContracargoGanado(paymentId, externalReference, (status.rawResponse as { transaction_amount?: number }).transaction_amount);
      return;
    }
    if (compra.estado !== 'pendiente' && compra.stripe_payment_intent_id !== paymentId) {
      await registrarPagoNoConciliado(paymentId, externalReference, status, 'pago_duplicado');
      return;
    }
    if (!compra.stripe_session_id) {
      logger.warn({ compraId, paymentId }, 'MP webhook: compra de créditos sin sesión de pasarela');
      return;
    }
    // La compra se reclama para este payment antes de crear el lote: si otro
    // payment aprobado la tomó a la vez, este es un pago duplicado.
    const { acreditarCompraDesdeWebhook } = await import('@/modules/creditos-estudios/creditos-estudios.service');
    const r = await acreditarCompraDesdeWebhook(compra.stripe_session_id, paymentId, status.rawResponse);
    if (r.duplicado) await registrarPagoNoConciliado(paymentId, externalReference, status, 'pago_duplicado');
  } catch (err) {
    logger.error({ err, compraId, paymentId }, 'MP webhook: error procesando la compra de créditos');
  }
}

/**
 * P1: el payment se reembolsó en Mercado Pago; su fila de la cola de
 * reembolsos, si la tenía, queda resuelta. Nunca lanza.
 */
export async function cerrarFilaReembolsada(paymentId: string): Promise<void> {
  try {
    const { data } = await (supabase
      .from('pagos_no_conciliados' as string) as ReturnType<typeof supabase.from>)
      .select('id, notas')
      .eq('proveedor', 'mercadopago')
      .eq('provider_payment_id', paymentId)
      .eq('resuelto', false)
      .maybeSingle();
    const fila = data as { id: string; notas: string | null } | null;
    if (!fila) return;
    const fecha = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    await (supabase
      .from('pagos_no_conciliados' as string) as ReturnType<typeof supabase.from>)
      .update({
        resuelto: true,
        estado_proveedor: 'refunded',
        notas: `${fila.notas ? `${fila.notas} ` : ''}Mercado Pago confirmó el reembolso el ${fecha}.`,
        updated_at: new Date().toISOString(),
      } as never)
      .eq('id', fila.id)
      .eq('resuelto', false);
  } catch (err) {
    logger.warn({ err, paymentId }, 'No se pudo cerrar la fila del pago reembolsado');
  }
}

/**
 * P1: el cobro reembolsado que ya tenía factura DIAN necesita nota crédito en
 * Factus (se hace a mano). Deja rastro en la bitácora y en las notificaciones
 * de los administradores. Devuelve el número de la factura, si la había.
 */
export async function avisarNotaCredito(pagoId: string, usuarioId: string | null): Promise<string | null> {
  const { data } = await (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .select('id, factus_number')
    .eq('pago_id', pagoId)
    .eq('estado', 'emitida')
    .limit(1)
    .maybeSingle();
  const factura = data as { id: string; factus_number: string | null } | null;
  if (!factura) return null;
  const numero = factura.factus_number ?? factura.id;
  logAudit({
    usuarioId,
    accion: AUDIT_ACTIONS.PAGO_NOTA_CREDITO_PENDIENTE,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pagoId,
    detalle: { factura_id: factura.id, factura_numero: factura.factus_number },
  });
  await avisarAdministradores({
    tipo: 'factura.nota_credito',
    titulo: 'Emitir nota crédito en Factus',
    mensaje: `Emitir nota crédito en Factus para la factura ${numero}: el pago se reembolsó.`,
    link: `/facturacion/${factura.id}`,
    payload: { factura_id: factura.id, pago_id: pagoId },
  });
  return numero;
}

/**
 * Registra un pago del proveedor que no se pudo conciliar con un pago en BD
 * (link cancelado pagado, monto distinto, referencia desconocida) o que hay que
 * devolver (P1: evaluación de un estudio cerrado sin consulta al buró). Es la
 * cola de «Reembolsos» del administrador. Idempotente por (proveedor,
 * provider_payment_id) — los retries del webhook no duplican. false si no se
 * pudo registrar.
 */
export async function registrarPagoNoConciliado(
  paymentId: string,
  externalReference: string,
  status: { status: string; rawResponse: Record<string, unknown> },
  motivo: string,
  /** 'mercadopago', o 'manual'/'credito' para un cobro que no pasó por la pasarela (id `pago:<uuid>`). */
  proveedor = 'mercadopago',
): Promise<boolean> {
  const mpAmount = (status.rawResponse as { transaction_amount?: number }).transaction_amount;
  const { data, error } = await (supabase
    .from('pagos_no_conciliados' as string) as ReturnType<typeof supabase.from>)
    .upsert(
      {
        proveedor,
        provider_payment_id: paymentId,
        external_reference: externalReference || null,
        monto: typeof mpAmount === 'number' ? mpAmount : null,
        estado_proveedor: status.status,
        motivo,
        raw_response: status.rawResponse,
      } as never,
      { onConflict: 'proveedor,provider_payment_id', ignoreDuplicates: true } as never,
    )
    .select('id');
  if (error) {
    logger.error({ error: error.message, paymentId, motivo }, 'No se pudo registrar el pago no conciliado');
    return false;
  }
  // Solo la primera vez: un reintento del webhook cae en ignoreDuplicates y no
  // devuelve fila. Sin este aviso la plata quedaba en la tabla sin que nadie lo
  // supiera.
  let filaId = (data as Array<{ id: string }> | null)?.[0]?.id;
  if (!filaId && status.status === 'completed') {
    // Ya estaba registrada sin aprobar (PSE o efectivo que entraron como
    // pendientes, o rechazados): ahora es plata, pasa a la cola con su aviso.
    const { data: aprobada } = await (supabase
      .from('pagos_no_conciliados' as string) as ReturnType<typeof supabase.from>)
      .update({
        estado_proveedor: 'completed',
        monto: typeof mpAmount === 'number' ? mpAmount : null,
        raw_response: status.rawResponse,
        updated_at: new Date().toISOString(),
      } as never)
      .eq('proveedor', proveedor)
      .eq('provider_payment_id', paymentId)
      .eq('resuelto', false)
      .in('estado_proveedor', ['pending', 'processing', 'failed', 'cancelled'])
      .select('id');
    filaId = (aprobada as Array<{ id: string }> | null)?.[0]?.id;
  }
  if (filaId) {
    avisarPagoNoConciliado({ filaId, paymentId, externalReference, estado: status.status, motivo, monto: mpAmount, proveedor }).catch((err) =>
      logger.warn({ err, paymentId }, 'No se pudo avisar del pago no conciliado'),
    );
  }
  return true;
}

export const MOTIVO_NO_CONCILIADO: Record<string, string> = {
  referencia_desconocida: 'la referencia no corresponde a ningún estudio',
  pago_id_expediente_mismatch: 'el cobro de la referencia es de otro estudio',
  pago_no_encontrado: 'no hay un cobro abierto con esa referencia (enlace cancelado o viejo)',
  amount_mismatch: 'el monto no coincide con el del cobro',
  pago_duplicado: 'es un segundo pago sobre un cobro que ya estaba pagado',
  transicion_invalida: 'el cobro ya estaba cancelado o reembolsado',
  transicion_fallida: 'no se pudo marcar el cobro como pagado',
  estudio_cerrado_sin_consulta: 'es la evaluación de un estudio que terminó sin consultar el buró, y se devuelve',
  estudio_fallido_revisar:
    'es la evaluación de un estudio que terminó con la consulta al buró fallida: no se sabe si la central la cobró',
  reembolso_parcial: 'Mercado Pago reembolsó una parte del pago, y ni el cobro ni los créditos se ajustan solos',
  contracargo_ganado: 'Mercado Pago volvió a aprobar un pago que se había contracargado: el cobro quedó reembolsado y no se restituye solo',
};

/** Motivos que no se resuelven reembolsando el pago completo: se cierran a mano. */
export const MOTIVOS_SIN_REEMBOLSO = ['transicion_fallida', 'reembolso_parcial', 'contracargo_ganado'];

const ESTADO_MP: Record<string, string> = {
  completed: 'aprobado',
  pending: 'pendiente',
  failed: 'rechazado',
  cancelled: 'cancelado',
  refunded: 'reembolsado',
};

/**
 * Contracargo ganado: Mercado Pago le devolvió a Cofianza un pago que se había
 * contracargado (o lo volvió a aprobar). La compra o el cobro quedaron
 * revertidos y no se restituyen solos: aviso persistente para hacerlo a mano.
 */
async function avisarContracargoGanado(paymentId: string, externalReference: string, monto: number | undefined): Promise<void> {
  const [concepto, refId] = externalReference.split(':');
  const esCompra = concepto === 'creditos_estudios';
  await avisarAdministradores({
    tipo: 'pago.contracargo_ganado',
    titulo: 'Contracargo ganado: restituir a mano',
    mensaje:
      `Mercado Pago le devolvió a Cofianza el pago ${paymentId}${typeof monto === 'number' ? ` (${formatCOP(monto)})` : ''}, que se había contracargado. ` +
      (esCompra
        ? 'Revisa la compra de créditos: si quedó revertida, restitúyela a mano (créditos retirados y saldo en contra).'
        : 'Revisa el cobro: si quedó reembolsado, restitúyelo a mano.') +
      ` Referencia: ${externalReference || 'sin referencia'}.`,
    link: !esCompra && refId ? `/expedientes/${refId}` : undefined,
    payload: { provider_payment_id: paymentId, external_reference: externalReference || null },
  }).catch((err) => logger.warn({ err, paymentId }, 'No se pudo avisar del contracargo ganado'));
}

/** Aviso in-app y por correo a cada administrador activo. */
export async function avisarAdministradores(aviso: Omit<NotificarUsuarioInput, 'userId'>): Promise<void> {
  const { data } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('rol', 'administrador')
    .eq('estado', 'activo');
  const admins = ((data as Array<{ id: string }> | null) ?? []).map((p) => p.id);
  await Promise.all(admins.map((userId) => notificarYCorreo({ userId, ...aviso })));
}

/**
 * Aviso a los administradores (in-app + correo) de un pago de Mercado Pago que
 * quedó en la cola de reembolsos: se devuelve con «Reembolsar en Mercado Pago»
 * (Pagos a Cofianza › Reembolsos) o se concilia a mano.
 */
async function avisarPagoNoConciliado(args: {
  filaId: string;
  paymentId: string;
  externalReference: string;
  estado: string;
  motivo: string;
  monto: number | undefined;
  proveedor: string;
}): Promise<void> {
  const monto = typeof args.monto === 'number' ? formatCOP(args.monto) : 'monto desconocido';
  const porque = MOTIVO_NO_CONCILIADO[args.motivo] ?? args.motivo;
  const enMp = args.proveedor === 'mercadopago';
  const titulos: Record<string, string> = {
    estudio_cerrado_sin_consulta: enMp ? 'Evaluación por devolver en Mercado Pago' : 'Evaluación por devolver a mano',
    estudio_fallido_revisar: 'Revisar la devolución de una evaluación',
    reembolso_parcial: args.externalReference.startsWith('creditos_estudios:')
      ? 'Reembolso parcial de una compra de créditos'
      : 'Reembolso parcial de un pago',
    contracargo_ganado: 'Contracargo ganado: restituir a mano',
  };
  const accion = MOTIVOS_SIN_REEMBOLSO.includes(args.motivo) || !enMp
    ? 'Resuélvelo a mano y márcalo resuelto en Pagos a Cofianza › Reembolsos.'
    : 'Reembólsalo con «Reembolsar en Mercado Pago» en Pagos a Cofianza › Reembolsos, o márcalo resuelto con una nota.';
  const mensaje =
    `${enMp ? `Pago de ${monto} en Mercado Pago (${ESTADO_MP[args.estado] ?? args.estado})` : `Pago de ${monto}`}: ${porque}. ` +
    (enMp ? `ID del pago en Mercado Pago: ${args.paymentId}; referencia: ${args.externalReference || 'sin referencia'}. ` : '') +
    accion;

  await avisarAdministradores({
    tipo: 'pago.no_conciliado',
    titulo: titulos[args.motivo] ?? 'Pago sin conciliar en Mercado Pago',
    mensaje,
    link: '/facturacion?tab=reembolsos',
    payload: {
      pago_no_conciliado_id: args.filaId,
      provider_payment_id: args.paymentId,
      external_reference: args.externalReference || null,
      motivo: args.motivo,
    },
  });
}

/**
 * P22: Mercado Pago reembolsó o contracargó una compra de créditos. Se retiran
 * los créditos (los usados quedan como saldo en contra) y se avisa a los
 * administradores con el registro de consumos, para disputar el contracargo en
 * Mercado Pago. Nunca lanza.
 */
async function contracargoDeCompra(compraId: string, paymentId: string, estadoMp: string | undefined): Promise<void> {
  // ponytail: un contracargo que Cofianza gana en la disputa no restituye los
  // créditos solo (la compra queda cancelada con su saldo en contra): a mano.
  const que = estadoMp === 'charged_back' ? 'un contracargo' : 'un reembolso';
  try {
    const { revertirCompraCreditos } = await import('@/modules/creditos-estudios/creditos-estudios.service');
    const r = await revertirCompraCreditos(compraId);
    if (!r) return; // ya revertida (reintento del webhook) o nunca acreditada
    const [{ data: perfil }, { data: factura }] = await Promise.all([
      (supabase.from('perfiles' as string) as ReturnType<typeof supabase.from>)
        .select('razon_social, nombre, apellido')
        .eq('id', r.perfil_id)
        .maybeSingle(),
      (supabase.from('facturas' as string) as ReturnType<typeof supabase.from>)
        .select('factus_number')
        .eq('compra_creditos_id', compraId)
        .eq('estado', 'emitida')
        .limit(1)
        .maybeSingle(),
    ]);
    const p = perfil as { razon_social: string | null; nombre: string | null; apellido: string | null } | null;
    const quien = p?.razon_social || `${p?.nombre ?? ''} ${p?.apellido ?? ''}`.trim() || r.perfil_id;
    const numeroFactura = (factura as { factus_number: string | null } | null)?.factus_number;
    const partes = [
      `Mercado Pago reportó ${que} de la compra de créditos de ${quien} (pago ${paymentId}).`,
      `Se retiraron ${r.retirados} créditos sin usar.`,
      r.en_contra > 0
        ? r.en_contra_error
          ? `${r.en_contra} ya usados NO quedaron como saldo en contra (${r.en_contra_error}): descuéntalos a mano.`
          : `${r.en_contra} ya usados quedan como saldo en contra: se restan del saldo para pagar con créditos y la próxima compra los descuenta.`
        : null,
      r.consumos.length > 0 ? `Se usaron en los estudios ${r.consumos.join(', ')}: es el registro para disputarlo en Mercado Pago.` : null,
      numeroFactura ? `Falta la nota crédito de la factura ${numeroFactura} en Factus.` : null,
    ];
    await avisarAdministradores({
      tipo: 'creditos.contracargo',
      titulo: `${estadoMp === 'charged_back' ? 'Contracargo' : 'Reembolso'} de una compra de créditos`,
      mensaje: partes.filter(Boolean).join(' '),
      payload: { compra_id: compraId, provider_payment_id: paymentId, retirados: r.retirados, en_contra: r.en_contra },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, compraId, paymentId }, 'Contracargo de compra de créditos: no se pudo revertir');
    await avisarAdministradores({
      tipo: 'creditos.contracargo',
      titulo: 'Revisar un contracargo de créditos',
      mensaje: `Mercado Pago reportó ${que} de la compra de créditos ${compraId} (pago ${paymentId}) y no se pudo terminar de revertir la compra: ${msg}. Revisa a mano sus créditos y su estado.`,
      payload: { compra_id: compraId, provider_payment_id: paymentId },
    }).catch((e) => logger.warn({ e, compraId }, 'No se pudo avisar del contracargo'));
  }
}

/**
 * Reconciliación periódica: pagos pasarela que llevan rato en pendiente o
 * procesando (PSE/efectivo, o webhooks que nunca llegaron). Busca en MP por
 * external_reference y procesa cada payment encontrado por la misma vía
 * idempotente del webhook. Pensada para correr en un setInterval del server.
 */
export async function reconcilePendingPagos(): Promise<{ revisados: number; conciliados: number }> {
  const gateway = getPaymentGateway();
  if (gateway.provider !== 'mercadopago' || !gateway.searchPaymentsByReference) {
    return { revisados: 0, conciliados: 0 };
  }

  const DIA_MS = 24 * 60 * 60 * 1000;
  const desde = new Date(Date.now() - 7 * DIA_MS).toISOString();
  const hasta = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // deja respirar a los recién creados
  // Un PSE o un recibo de efectivo ('procesando') bloquea abrir otro cobro del
  // mismo concepto: con la ventana de 7 días nadie lo volvía a mirar y el gestor
  // quedaba sin salida. Se siguen hasta 30 días (el recibo del estudio vence a
  // los 15: date_of_expiration en el adaptador de Mercado Pago).
  const desdeProcesando = new Date(Date.now() - 30 * DIA_MS).toISOString();
  const pagosPasarela = () =>
    (supabase.from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, expediente_id, concepto, estado, transaction_ref, created_at')
      .eq('metodo', 'pasarela');

  // Incluye 'fallido': MP permite reintentar en el mismo checkout — si el
  // reintento fue APROBADO y su webhook se perdió, el job lo rescata
  // (fallido→completado es transición válida).
  const [recientes, viejos] = await Promise.all([
    pagosPasarela()
      .in('estado', ['pendiente', 'procesando', 'fallido'])
      .gte('created_at', desde)
      .lte('created_at', hasta)
      // Los más recientes primero: sin orden, 50 cobros abandonados o fallidos
      // de la semana podían dejar fuera el pago que acaba de entrar.
      .order('created_at', { ascending: false })
      .limit(50),
    // Consulta aparte (con su propio tope) para que los recientes no los tapen.
    pagosPasarela()
      .eq('estado', 'procesando')
      .gte('created_at', desdeProcesando)
      .lt('created_at', desde)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  if (recientes.error || viejos.error) {
    logger.error({ error: (recientes.error ?? viejos.error)?.message }, 'reconcilePendingPagos: error consultando pagos');
    return { revisados: 0, conciliados: 0 };
  }

  type PagoPorConciliar = {
    id: string; expediente_id: string; concepto: string; estado: string; transaction_ref: string | null;
  };
  const pendientes = [...(recientes.data ?? []), ...(viejos.data ?? [])] as PagoPorConciliar[];
  if ((recientes.data ?? []).length === 50 || (viejos.data ?? []).length === 50) {
    logger.warn('reconcilePendingPagos: se llegó al tope de 50 pagos; los más viejos quedan para otra corrida');
  }

  let conciliados = 0;
  for (const p of pendientes) {
    try {
      // SIEMPRE buscar por referencia (no solo el transaction_ref guardado): un
      // checkout de MP admite varios intentos — el transaction_ref puede ser de
      // un intento rechazado mientras un reintento posterior fue APROBADO.
      const ref = `${p.concepto}:${p.expediente_id}:${p.id}`;
      let found = await gateway.searchPaymentsByReference(ref);
      if (found.length === 0) {
        // Legacy: preferences sin pago_id en la referencia.
        found = await gateway.searchPaymentsByReference(`${p.concepto}:${p.expediente_id}`);
      }
      if (found.length === 0 && p.transaction_ref) {
        // Fallback: consultar el payment conocido (quedó de un webhook 'pending').
        await processMercadoPagoWebhook(p.transaction_ref, 'payment', gateway);
      } else {
        // Procesar primero los aprobados: así el pago llega a 'completado' antes
        // de que un intento rechazado lo mande a 'fallido'.
        const ordenados = [...found].sort((a, b) =>
          (a.status === 'completed' ? -1 : 0) - (b.status === 'completed' ? -1 : 0),
        );
        for (const payment of ordenados) {
          if (payment.transactionRef) {
            await processMercadoPagoWebhook(payment.transactionRef, 'payment', gateway);
          }
        }
      }
      const { data: after } = await (supabase
        .from('pagos' as string) as ReturnType<typeof supabase.from>)
        .select('estado')
        .eq('id', p.id)
        .single();
      if ((after as { estado?: string } | null)?.estado !== p.estado) conciliados += 1;
    } catch (err) {
      logger.warn({ err, pagoId: p.id }, 'reconcilePendingPagos: error reconciliando pago');
    }
  }

  // Compras de créditos pendientes (no viven en `pagos`): mismo rescate por
  // external_reference — sin esto, una compra pagada sin webhook quedaba
  // 'pendiente' para siempre y los créditos nunca se acreditaban.
  const { data: comprasData, error: comprasError } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, created_at')
    .eq('estado', 'pendiente')
    .gte('created_at', desde)
    .lte('created_at', hasta)
    .order('created_at', { ascending: false })
    .limit(50);

  if (comprasError) {
    logger.error({ error: comprasError.message }, 'reconcilePendingPagos: error consultando compras de créditos');
  }

  const compras = (comprasData ?? []) as Array<{ id: string; estado: string }>;
  if (compras.length === 50) {
    logger.warn('reconcilePendingPagos: se llegó al tope de 50 compras de créditos; las más viejas quedan para otra corrida');
  }
  let comprasConciliadas = 0;
  for (const c of compras) {
    try {
      const found = await gateway.searchPaymentsByReference(`creditos_estudios:${c.id}`);
      // P22: acredita el primer payment aprobado (el que queda registrado en la
      // compra); los otros aprobados caen como duplicados en la cola.
      const fecha = (p: { rawResponse: Record<string, unknown> }) => String(p.rawResponse.date_created ?? '');
      found.sort(
        (a, b) =>
          (a.status === 'completed' ? 0 : 1) - (b.status === 'completed' ? 0 : 1) || fecha(a).localeCompare(fecha(b)),
      );
      for (const payment of found) {
        if (payment.transactionRef) {
          await processMercadoPagoWebhook(payment.transactionRef, 'payment', gateway);
        }
      }
      const { data: after } = await (supabase
        .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
        .select('estado')
        .eq('id', c.id)
        .single();
      if ((after as { estado?: string } | null)?.estado === 'completado') comprasConciliadas += 1;
    } catch (err) {
      logger.warn({ err, compraId: c.id }, 'reconcilePendingPagos: error reconciliando compra de créditos');
    }
  }

  if (pendientes.length > 0 || compras.length > 0) {
    logger.info(
      { revisados: pendientes.length, conciliados, comprasRevisadas: compras.length, comprasConciliadas },
      'reconcilePendingPagos: ciclo terminado',
    );
  }
  return { revisados: pendientes.length + compras.length, conciliados: conciliados + comprasConciliadas };
}

/**
 * Reconciliación: confirma un pago consultándolo directo en la pasarela, SIN
 * depender de que llegue el webhook. La usa la página pública de resultado tras
 * el retorno del comprador (MP redirige con el payment_id). Así el pago se
 * confirma aunque el webhook nunca llegue (red de seguridad). Reusa la lógica
 * del webhook, que es idempotente (si ya está completado, no hace nada).
 */
export async function reconcileMercadoPagoPayment(paymentId: string): Promise<void> {
  const gateway = getPaymentGateway();
  if (gateway.provider !== 'mercadopago') return;
  await processMercadoPagoWebhook(paymentId, 'payment', gateway);
}

// ============================================================
// Gateway config (public key)
// ============================================================

export function getGatewayConfig() {
  const gateway = getPaymentGateway();
  return {
    provider: gateway.provider,
    publishable_key: gateway.getPublicKey(),
  };
}

// ============================================================
// Gateway health check
// ============================================================

export async function getGatewayStatus() {
  const gateway = getPaymentGateway();
  return gateway.healthCheck();
}

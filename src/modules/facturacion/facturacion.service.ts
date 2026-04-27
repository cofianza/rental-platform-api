/**
 * Facturación electrónica (DIAN) vía Factus.com.co.
 *
 * Hoy: solo facturamos el pago del estudio crediticio. El servicio se
 * dispara desde:
 *   1. Manual: POST /api/v1/pagos/:pagoId/facturar (botón en panel admin/inmo).
 *   2. Auto: orchestrator.onPagoConfirmado, fire-and-forget al confirmar el
 *      pago de Stripe.
 *
 * Idempotencia: usamos pago.id como referencia única por pago. Si Factus
 * responde 409 (documento duplicado), buscamos por reference_code y vinculamos.
 */

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import * as factus from '@/lib/factus';
import type { ListFacturasQuery } from './facturacion.schema';
import type { UserRole } from '@/types/auth';

// ── Constants ──────────────────────────────────────────────────────

const VALOR_ESTUDIO_DEFAULT = 80_000; // COP, sin IVA

// Defaults para clientes persona natural sin todos los datos fiscales
// configurados (edge cases). Se sobreescriben con datos reales si están.
const DEFAULTS_CLIENTE = {
  legal_organization_id: '2', // Persona natural
  tribute_id: '21', // No aplica (régimen ordinario)
  identification_document_id: '3', // CC
  municipality_id: '149', // Bogotá D.C. (Factus catalog)
};

const ITEM_DEFAULTS = {
  unit_measure_id: 70, // unidad
  standard_code_id: 1, // Estándar adoptado contribuyente
  is_excluded: 1 as const, // Estudio crediticio NO grava IVA — servicio financiero
  tribute_id: 1, // IVA (aún si is_excluded=1, hay que mandar el ID del tributo)
  tax_rate: '0.00',
};

// ── Tipos para la integración ──────────────────────────────────────

interface PagoConContexto {
  id: string;
  expediente_id: string;
  concepto: string;
  monto: number;
  email_pagador: string | null;
  nombre_pagador: string | null;
  expediente: {
    numero: string;
    solicitante: {
      id: string;
      nombre: string;
      apellido: string;
      email: string;
      telefono: string | null;
      tipo_documento: string;
      numero_documento: string;
      direccion: string | null;
      municipio_id: number | null;
      municipio_nombre: string | null;
    } | null;
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function mapTipoDocumentoToFactus(tipo: string): string {
  // Factus IDs tipos de documento (ver tabla referencia):
  // 1 = RC, 2 = TI, 3 = CC, 4 = TE, 5 = CE, 6 = NIT, 7 = PAS
  switch (tipo.toUpperCase()) {
    case 'CC': return '3';
    case 'TI': return '2';
    case 'CE': return '5';
    case 'NIT': return '6';
    case 'PA':
    case 'PAS':
    case 'PASAPORTE': return '7';
    default: return '3';
  }
}

async function fetchPagoContext(pagoId: string): Promise<PagoConContexto> {
  const { data, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, expediente_id, concepto, monto, email_pagador, nombre_pagador,
      expediente:expedientes(
        numero,
        solicitante:solicitantes(
          id, nombre, apellido, email, telefono,
          tipo_documento, numero_documento, direccion,
          municipio_id, municipio_nombre
        )
      )
    `)
    .eq('id', pagoId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Pago no encontrado', 'PAGO_NOT_FOUND');
  }
  return data as unknown as PagoConContexto;
}

async function findFacturaExistente(pagoId: string) {
  const { data } = await (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, factus_number, cufe, factus_reference_code')
    .eq('pago_id', pagoId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as { id: string; estado: string; factus_number: string | null; cufe: string | null; factus_reference_code: string | null } | null;
}

function buildReferenceCode(pagoId: string): string {
  // Factus usa este código para detectar duplicados — debe ser único por pago.
  const short = pagoId.replace(/-/g, '').slice(0, 12).toUpperCase();
  return `COFIANZA-PAGO-${short}`;
}

function inferConceptoLabel(concepto: string): string {
  switch (concepto) {
    case 'estudio': return 'Estudio crediticio de arrendamiento';
    case 'garantia': return 'Garantía de arrendamiento';
    case 'primer_canon': return 'Primer canon de arrendamiento';
    case 'deposito': return 'Depósito de arrendamiento';
    default: return `Servicio Cofianza (${concepto})`;
  }
}

// ── crearFacturaDesdePago ──────────────────────────────────────────

export async function crearFacturaDesdePago(
  pagoId: string,
  userId: string | null,
  ip?: string,
): Promise<{ id: string; factus_number: string | null; cufe: string | null; estado: string }> {
  // 1. Idempotencia: si ya existe factura emitida, devolverla.
  const existente = await findFacturaExistente(pagoId);
  if (existente && existente.estado === 'emitida') {
    return {
      id: existente.id,
      factus_number: existente.factus_number,
      cufe: existente.cufe,
      estado: existente.estado,
    };
  }

  // 2. Cargar pago + expediente + solicitante.
  const ctx = await fetchPagoContext(pagoId);
  const sol = ctx.expediente?.solicitante;
  if (!sol) {
    throw AppError.badRequest(
      'El expediente del pago no tiene solicitante asociado — no se puede facturar.',
      'NO_SOLICITANTE',
    );
  }

  // 3. Validar datos mínimos del cliente.
  if (!sol.numero_documento) {
    throw AppError.badRequest(
      'El solicitante no tiene número de documento — completa sus datos antes de facturar.',
      'CLIENTE_DATOS_INCOMPLETOS',
    );
  }

  // 4. Auto-discover rango de numeración (cache 1h).
  const numberingRangeId = await factus.discoverNumberingRangeId();

  // 5. Construir payload Factus.
  const referenceCode = existente?.factus_reference_code || buildReferenceCode(pagoId);
  const conceptoLabel = inferConceptoLabel(ctx.concepto);
  const monto = Number(ctx.monto) || VALOR_ESTUDIO_DEFAULT;

  const payload: factus.CreateBillInput = {
    numbering_range_id: numberingRangeId,
    reference_code: referenceCode,
    payment_form: '1', // contado
    payment_method_code: '10', // efectivo (genérico — Stripe procesó por fuera)
    send_email: true,
    customer: {
      identification: sol.numero_documento,
      names: `${sol.nombre} ${sol.apellido}`.trim(),
      address: sol.direccion || undefined,
      email: sol.email || undefined,
      phone: sol.telefono || undefined,
      legal_organization_id: DEFAULTS_CLIENTE.legal_organization_id,
      tribute_id: DEFAULTS_CLIENTE.tribute_id,
      identification_document_id: mapTipoDocumentoToFactus(sol.tipo_documento),
      municipality_id: sol.municipio_id ? String(sol.municipio_id) : DEFAULTS_CLIENTE.municipality_id,
    },
    items: [
      {
        code_reference: ctx.concepto,
        name: `${conceptoLabel} - ${ctx.expediente.numero}`,
        quantity: 1,
        price: monto,
        tax_rate: ITEM_DEFAULTS.tax_rate,
        unit_measure_id: ITEM_DEFAULTS.unit_measure_id,
        standard_code_id: ITEM_DEFAULTS.standard_code_id,
        is_excluded: ITEM_DEFAULTS.is_excluded,
        tribute_id: ITEM_DEFAULTS.tribute_id,
      },
    ],
  };

  logger.info(
    { pagoId, expedienteId: ctx.expediente_id, referenceCode, numberingRangeId },
    'Factus: enviando factura',
  );

  // 6. Llamar a Factus (síncrono — DIAN valida en la misma request).
  let factusRes: factus.CreateBillResponse;
  try {
    factusRes = await factus.createBill(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ pagoId, error: msg }, 'Factus: error al crear factura');

    // Persistir el intento fallido para retry manual.
    await persistFailedAttempt({
      pagoId,
      expedienteId: ctx.expediente_id,
      referenceCode,
      concepto: ctx.concepto,
      total: monto,
      error: msg,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      respuestaProveedor: (err as any).factusBody ?? { error: msg },
    });

    throw err;
  }

  const bill = factusRes.data.bill;

  // 7. Persistir factura emitida.
  const facturaPersisted = await persistFacturaEmitida({
    pagoId,
    expedienteId: ctx.expediente_id,
    sol,
    factusRes,
    referenceCode,
    concepto: ctx.concepto,
  });

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_CREATED, // Reutilizamos hasta que añadan FACTURA_CREATED al enum
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: facturaPersisted.id,
    detalle: {
      tipo: 'factura_emitida',
      pago_id: pagoId,
      factus_number: bill.number,
      cufe: bill.cufe,
      total: bill.total,
    },
    ip,
  });

  return {
    id: facturaPersisted.id,
    factus_number: bill.number,
    cufe: bill.cufe,
    estado: 'emitida',
  };
}

async function persistFacturaEmitida(params: {
  pagoId: string;
  expedienteId: string;
  sol: NonNullable<PagoConContexto['expediente']['solicitante']>;
  factusRes: factus.CreateBillResponse;
  referenceCode: string;
  concepto: string;
}) {
  const { pagoId, expedienteId, sol, factusRes, referenceCode, concepto } = params;
  const bill = factusRes.data.bill;

  // Si ya hay un intento previo (fallido), actualizamos en vez de insertar.
  const existente = await findFacturaExistente(pagoId);

  const data = {
    pago_id: pagoId,
    expediente_id: expedienteId,
    numero_factura: bill.number,
    razon_social: `${sol.nombre} ${sol.apellido}`.trim(),
    nit: sol.numero_documento,
    direccion_fiscal: sol.direccion,
    estado: 'emitida' as const,
    factus_bill_id: bill.id,
    factus_reference_code: referenceCode,
    factus_number: bill.number,
    cufe: bill.cufe,
    qr_url: bill.qr,
    qr_image_base64: bill.qr_image,
    respuesta_proveedor: factusRes,
    concepto,
    total: Number(bill.total),
    tax_amount: Number(bill.tax_amount),
    error_mensaje: null,
    validada_en: new Date().toISOString(),
  };

  if (existente) {
    const { data: updated, error } = await (supabase
      .from('facturas' as string) as ReturnType<typeof supabase.from>)
      .update(data as never)
      .eq('id', existente.id)
      .select('id')
      .single();
    if (error || !updated) {
      logger.error({ error: error?.message, pagoId }, 'Error al actualizar factura emitida');
      throw new AppError(500, 'INTERNAL_ERROR', 'Error al persistir la factura');
    }
    return updated as { id: string };
  }

  const { data: inserted, error } = await (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .insert(data as never)
    .select('id')
    .single();
  if (error || !inserted) {
    logger.error({ error: error?.message, pagoId }, 'Error al insertar factura emitida');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al persistir la factura');
  }
  return inserted as { id: string };
}

async function persistFailedAttempt(params: {
  pagoId: string;
  expedienteId: string;
  referenceCode: string;
  concepto: string;
  total: number;
  error: string;
  respuestaProveedor: unknown;
}) {
  const existente = await findFacturaExistente(params.pagoId);

  const data = {
    pago_id: params.pagoId,
    expediente_id: params.expedienteId,
    estado: 'solicitada' as const,
    factus_reference_code: params.referenceCode,
    concepto: params.concepto,
    total: params.total,
    error_mensaje: params.error,
    respuesta_proveedor: params.respuestaProveedor,
  };

  if (existente) {
    await (supabase
      .from('facturas' as string) as ReturnType<typeof supabase.from>)
      .update(data as never)
      .eq('id', existente.id);
    return;
  }

  await (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .insert(data as never);
}

// ── Listar / ver ───────────────────────────────────────────────────

export async function listFacturas(query: ListFacturasQuery, userId: string, userRol: string) {
  const offset = (query.page - 1) * query.limit;

  let qb = (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, expediente_id, pago_id, numero_factura, factus_number, cufe, qr_url, total, tax_amount, concepto, estado, error_mensaje, validada_en, created_at',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + query.limit - 1);

  if (query.estado) qb = qb.eq('estado', query.estado);
  if (query.expediente_id) qb = qb.eq('expediente_id', query.expediente_id);

  // Solicitante solo ve facturas de sus propios expedientes.
  if (userRol === 'solicitante') {
    const { data: solRow } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('creado_por', userId as UserRole)
      .single();
    const solId = (solRow as { id: string } | null)?.id;
    if (!solId) {
      return { facturas: [], pagination: { total: 0, page: query.page, limit: query.limit, totalPages: 0 } };
    }
    const { data: expedientesRow } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('solicitante_id', solId);
    const expedienteIds = ((expedientesRow as { id: string }[] | null) || []).map((e) => e.id);
    if (expedienteIds.length === 0) {
      return { facturas: [], pagination: { total: 0, page: query.page, limit: query.limit, totalPages: 0 } };
    }
    qb = qb.in('expediente_id', expedienteIds);
  }

  const { data, error, count } = await qb;
  if (error) {
    logger.error({ error: error.message }, 'Error listando facturas');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al listar facturas');
  }

  return {
    facturas: data || [],
    pagination: {
      total: count || 0,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil((count || 0) / query.limit),
    },
  };
}

export async function getFacturaById(id: string) {
  const { data, error } = await (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('id', id)
    .single();
  if (error || !data) {
    throw AppError.notFound('Factura no encontrada', 'FACTURA_NOT_FOUND');
  }
  return data;
}

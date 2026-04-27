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

// Defaults V2 (códigos DIAN + DANE).
const DEFAULTS_CLIENTE = {
  legal_organization_code: '2', // 2=Persona natural, 1=Jurídica
  tribute_code: 'ZZ', // No aplica (régimen ordinario)
  identification_document_code: '13', // 13=CC en DIAN
  municipality_code: '11001', // Bogotá D.C. (DANE)
};

const ITEM_DEFAULTS = {
  unit_measure_code: '94', // unidad
  standard_code: '999', // Estándar adoptado contribuyente
  // Estudio crediticio = servicio financiero exento de IVA. V2 exige al menos
  // un tax; usamos { is_excluded: true } para indicar servicio excluido.
  taxes: [{ is_excluded: true }] as { is_excluded: boolean }[],
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
      municipio_id: string | null; // V2: código DANE (5 dígitos, ej. "11001")
      municipio_nombre: string | null;
    } | null;
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function mapTipoDocumentoToFactus(tipo: string): string {
  // V2 usa códigos DIAN estándar:
  // 11=RC, 12=TI, 13=CC, 21=TE, 22=CE, 31=NIT, 41=Pasaporte, 91=NUIP
  switch (tipo.toUpperCase()) {
    case 'CC': return '13';
    case 'TI': return '12';
    case 'CE': return '22';
    case 'TE': return '21';
    case 'NIT': return '31';
    case 'PA':
    case 'PAS':
    case 'PASAPORTE': return '41';
    case 'RC': return '11';
    default: return '13';
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

/**
 * Extrae el bill validado de la respuesta de Factus, sin asumir estructura
 * exacta. V2 ha mostrado al menos dos formas: { data: { bill: {...} } } y
 * { data: {...campos del bill...} }. Devolvemos null si no encontramos
 * número + cufe (los dos campos mínimos para considerar válida la factura).
 */
type FactusBillSnapshot = {
  id?: number | null;
  number?: string | null;
  cufe?: string | null;
  qr?: string | null;
  qr_image?: string | null;
  total?: string | number | null;
  tax_amount?: string | number | null;
};

function extractBill(factusRes: unknown): FactusBillSnapshot | null {
  if (!factusRes || typeof factusRes !== 'object') return null;
  const root = factusRes as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  // Probar primero data.bill, después data plano, después root.bill.
  const candidates: unknown[] = [
    (data as Record<string, unknown>)?.bill,
    data,
    (root as Record<string, unknown>).bill,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      const b = c as FactusBillSnapshot;
      if (b.number && b.cufe) return b;
    }
  }
  return null;
}

/**
 * Lee la tarifa de IVA configurada para un concepto. La fila vive en
 * configuracion_sistema con clave `iva_concepto_<concepto>`. Si no existe
 * o el valor es inválido, devuelve 0 (exento) — fail-safe.
 */
async function getTarifaIvaPorConcepto(concepto: string): Promise<number> {
  const clave = `iva_concepto_${concepto}`;
  const { data } = await (supabase
    .from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>)
    .select('valor')
    .eq('clave', clave)
    .maybeSingle();
  if (!data) return 0;
  const n = Number((data as { valor: string }).valor);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0;
}

export async function listTarifasIva(): Promise<{ concepto: string; tasa: number }[]> {
  const conceptos = ['estudio', 'garantia', 'primer_canon', 'deposito', 'otro'];
  const { data } = await (supabase
    .from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>)
    .select('clave, valor')
    .in('clave', conceptos.map((c) => `iva_concepto_${c}`));
  const map = new Map<string, string>();
  for (const row of (data || []) as { clave: string; valor: string }[]) {
    map.set(row.clave, row.valor);
  }
  return conceptos.map((c) => {
    const raw = map.get(`iva_concepto_${c}`) ?? '0';
    const n = Number(raw);
    return { concepto: c, tasa: Number.isFinite(n) ? n : 0 };
  });
}

export async function updateTarifasIva(
  input: { concepto: string; tasa: number }[],
  userId: string,
  ip?: string,
): Promise<{ concepto: string; tasa: number }[]> {
  const allowedConceptos = new Set(['estudio', 'garantia', 'primer_canon', 'deposito', 'otro']);
  for (const item of input) {
    if (!allowedConceptos.has(item.concepto)) {
      throw AppError.badRequest(`Concepto inválido: ${item.concepto}`, 'CONCEPTO_INVALIDO');
    }
    if (typeof item.tasa !== 'number' || item.tasa < 0 || item.tasa > 100) {
      throw AppError.badRequest('La tasa debe estar entre 0 y 100', 'TASA_INVALIDA');
    }
  }

  for (const item of input) {
    const clave = `iva_concepto_${item.concepto}`;
    await (supabase
      .from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>)
      .upsert(
        {
          clave,
          valor: String(item.tasa),
          descripcion: `Tasa de IVA (%) para ${item.concepto}. 0 = exento.`,
        } as never,
        { onConflict: 'clave' },
      );
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_CREATED, // reutilizamos hasta que añadan CONFIG_UPDATED
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: 'tarifas_iva',
    detalle: { tipo: 'tarifas_iva_actualizadas', input },
    ip,
  });

  return listTarifasIva();
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

  // 4. Auto-discover rango de numeración (cache 1h). Devuelve null si la
  //    cuenta de Factus no expone el endpoint de listado — en ese caso
  //    omitimos el campo y Factus selecciona el rango activo automáticamente.
  const numberingRangeId = await factus.discoverNumberingRangeId();

  // 5. Construir payload Factus.
  const referenceCode = existente?.factus_reference_code || buildReferenceCode(pagoId);
  const conceptoLabel = inferConceptoLabel(ctx.concepto);
  const monto = Number(ctx.monto) || VALOR_ESTUDIO_DEFAULT;

  // Para Factus V2 quantity y price van como string con 2 decimales.
  const fullName = `${sol.nombre} ${sol.apellido}`.trim();

  // Lee la tasa de IVA configurada para este concepto (admin la edita en
  // /facturacion). Si tasa>0, monto del pago es total con IVA incluido y
  // calculamos el price (base) para Factus. Si tasa=0, price = monto.
  const tasaIva = await getTarifaIvaPorConcepto(ctx.concepto);
  const priceBase = tasaIva > 0 ? monto / (1 + tasaIva / 100) : monto;
  const priceStr = priceBase.toFixed(2);

  // V2: code DANE = 5 dígitos. Si el solicitante tiene un valor que no
  // matchea (legacy V1 con ID interno Factus, o vacío), caemos al default.
  const dane = sol.municipio_id && /^\d{5}$/.test(sol.municipio_id)
    ? sol.municipio_id
    : DEFAULTS_CLIENTE.municipality_code;

  const payload: factus.CreateBillInput = {
    reference_code: referenceCode,
    document: '01', // Factura electrónica de Venta
    ...(numberingRangeId !== null ? { numbering_range_id: numberingRangeId } : {}),
    operation_type: '10', // Estándar
    send_email: true,
    payment_details: [
      {
        payment_form: 1, // contado
        payment_method_code: '10', // efectivo (Stripe procesó por fuera)
        reference_code: pagoId.replace(/-/g, '').slice(0, 12).toUpperCase(),
        amount: monto.toFixed(2), // total con IVA si aplica
      },
    ],
    customer: {
      identification: sol.numero_documento,
      // V2: persona natural (legal_organization_code=2) usa 'names'.
      // Jurídica (=1) usa 'company' + 'trade_name'.
      names: fullName,
      address: sol.direccion || undefined,
      email: sol.email || undefined,
      phone: sol.telefono || undefined,
      legal_organization_code: DEFAULTS_CLIENTE.legal_organization_code,
      tribute_code: DEFAULTS_CLIENTE.tribute_code,
      identification_document_code: mapTipoDocumentoToFactus(sol.tipo_documento),
      municipality_code: dane,
    },
    items: [
      {
        code_reference: ctx.concepto,
        name: `${conceptoLabel} - ${ctx.expediente.numero}`,
        quantity: '1.00',
        discount_rate: '0.00',
        price: priceStr,
        unit_measure_code: ITEM_DEFAULTS.unit_measure_code,
        standard_code: ITEM_DEFAULTS.standard_code,
        taxes:
          tasaIva > 0
            ? [{ code: '01', rate: tasaIva.toFixed(2) }]
            : [{ is_excluded: true }],
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

  // Log de las claves top-level — Factus V2 puede envolver la respuesta
  // distinto a V1 (data.bill vs data directo vs data.data, etc.). Esto nos
  // deja diagnosticar si el extractor falla.
  logger.info(
    {
      pagoId,
      topKeys: Object.keys(factusRes || {}),
      dataKeys: factusRes && typeof factusRes === 'object' && 'data' in factusRes
        ? Object.keys((factusRes as { data?: object }).data || {})
        : null,
    },
    'Factus: respuesta recibida',
  );

  const bill = extractBill(factusRes);
  if (!bill) {
    // Persistimos como intento fallido con la respuesta cruda para
    // diagnóstico, en lugar de devolver 500 sin trazabilidad.
    await persistFailedAttempt({
      pagoId,
      expedienteId: ctx.expediente_id,
      referenceCode,
      concepto: ctx.concepto,
      total: monto,
      error: 'Factus respondió 200 pero la estructura no coincide con bill esperado',
      respuestaProveedor: factusRes,
    });
    throw new AppError(
      502,
      'FACTUS_UNEXPECTED_RESPONSE',
      'Factus respondió 200 pero el formato es inesperado. Revisa el log y respuesta_proveedor.',
    );
  }

  // 7. Persistir factura emitida.
  const facturaPersisted = await persistFacturaEmitida({
    pagoId,
    expedienteId: ctx.expediente_id,
    sol,
    factusRes,
    bill,
    referenceCode,
    concepto: ctx.concepto,
    montoFallback: monto, // si Factus no devolvió total, caemos al monto del pago
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
    factus_number: bill.number ?? null,
    cufe: bill.cufe ?? null,
    estado: 'emitida',
  };
}

async function persistFacturaEmitida(params: {
  pagoId: string;
  expedienteId: string;
  sol: NonNullable<PagoConContexto['expediente']['solicitante']>;
  factusRes: factus.CreateBillResponse;
  bill: FactusBillSnapshot;
  referenceCode: string;
  concepto: string;
  montoFallback: number;
}) {
  const { pagoId, expedienteId, sol, factusRes, bill, referenceCode, concepto, montoFallback } = params;

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
    total: bill.total != null ? Number(bill.total) : montoFallback,
    tax_amount: bill.tax_amount != null ? Number(bill.tax_amount) : 0,
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

  const f = data as Record<string, unknown>;
  const totalDb = f.total != null ? Number(f.total) : null;
  const taxDb = f.tax_amount != null ? Number(f.tax_amount) : null;

  // Si la fila tiene total en null/0 (caso histórico antes del fallback al
  // monto del pago), leemos el monto del pago asociado para mostrarlo.
  let totalEffective = totalDb;
  let taxEffective = taxDb ?? 0;
  if ((!totalEffective || totalEffective === 0) && f.pago_id) {
    const { data: pago } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('monto')
      .eq('id', f.pago_id as string)
      .maybeSingle();
    if (pago) totalEffective = Number((pago as { monto: number }).monto) || 0;
  }

  // Subtotal = total - IVA. Si no hay IVA, subtotal = total.
  const subtotal = (totalEffective ?? 0) - taxEffective;
  // Porcentaje real de IVA en la factura (para mostrar en UI). Si subtotal
  // es 0, evitamos NaN. Si tax=0, devolvemos 0 (mostrará "Exento" en UI).
  const ivaPorcentaje =
    taxEffective > 0 && subtotal > 0
      ? Math.round((taxEffective / subtotal) * 10000) / 100
      : 0;

  // Mapear a la forma esperada por el frontend (IFactura).
  return {
    ...f,
    numero: f.factus_number ?? f.numero_factura ?? null,
    fecha: f.validada_en ?? f.created_at,
    subtotal: subtotal > 0 ? subtotal : (totalEffective ?? 0),
    iva: taxEffective,
    iva_porcentaje: ivaPorcentaje,
    total: totalEffective ?? 0,
    emisor_razon_social: 'Cofianza S.A.S.',
    emisor_nit: '901.000.000-0',
    emisor_direccion: 'Medellín, Colombia',
    receptor_razon_social: f.razon_social ?? '',
    receptor_documento: f.nit ?? '',
    receptor_direccion: f.direccion_fiscal ?? '',
    receptor_email: '',
  };
}

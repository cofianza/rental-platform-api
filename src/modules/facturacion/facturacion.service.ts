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
      tipo_persona: 'natural' | 'juridica' | null;
      nombre: string;
      apellido: string;
      razon_social: string | null;
      email: string;
      telefono: string | null;
      tipo_documento: string;
      numero_documento: string;
      digito_verificacion: string | null;
      direccion: string | null;
      municipio_id: string | null; // V2: código DANE (5 dígitos, ej. "11001")
      municipio_nombre: string | null;
      tribute_code: string | null;
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
          id, tipo_persona, nombre, apellido, razon_social,
          email, telefono,
          tipo_documento, numero_documento, digito_verificacion, direccion,
          municipio_id, municipio_nombre, tribute_code
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

export interface DatosFiscalesPagoOverride {
  numero_documento?: string;
  tipo_documento?: string;
  nombre_completo?: string;
  direccion?: string;
  email?: string;
  telefono?: string;
  /** Codigo DANE (5 digitos). */
  municipio_codigo?: string;
}

/**
 * Devuelve los datos fiscales que se usarian para emitir la factura, sin
 * tocar Factus. Sirve al frontend para mostrar un modal de confirmacion
 * "vamos a facturar a estos datos — confirma o ajusta" antes de emitir.
 *
 * Si ya hay factura emitida, devuelve { ya_emitida: true, factura_id }.
 * Si faltan datos requeridos, devuelve la lista de faltantes para que el
 * frontend abra el form de captura — mismo shape que el error real.
 */
export async function previewFacturaPago(pagoId: string): Promise<{
  ya_emitida: boolean;
  factura_id?: string;
  factura_numero?: string | null;
  datos_actuales: {
    tipo_persona: 'natural' | 'juridica';
    nombre_completo: string;
    razon_social: string;
    tipo_documento: string;
    numero_documento: string;
    digito_verificacion: string;
    email: string;
    telefono: string;
    direccion: string;
    municipio_codigo: string;
    municipio_nombre: string;
  };
  faltantes: string[];
  monto: number;
  concepto: string;
}> {
  const existente = await findFacturaExistente(pagoId);
  if (existente && existente.estado === 'emitida') {
    return {
      ya_emitida: true,
      factura_id: existente.id,
      factura_numero: existente.factus_number,
      datos_actuales: {
        tipo_persona: 'natural',
        nombre_completo: '',
        razon_social: '',
        tipo_documento: '',
        numero_documento: '',
        digito_verificacion: '',
        email: '',
        telefono: '',
        direccion: '',
        municipio_codigo: '',
        municipio_nombre: '',
      },
      faltantes: [],
      monto: 0,
      concepto: '',
    };
  }

  const ctx = await fetchPagoContext(pagoId);
  const sol = ctx.expediente?.solicitante;
  if (!sol) {
    throw AppError.badRequest(
      'El expediente del pago no tiene solicitante asociado — no se puede facturar.',
      'NO_SOLICITANTE',
    );
  }

  const tipoPersona: 'natural' | 'juridica' = sol.tipo_persona ?? 'natural';
  const datos = {
    tipo_persona: tipoPersona,
    nombre_completo: `${sol.nombre} ${sol.apellido}`.trim(),
    razon_social: sol.razon_social ?? '',
    tipo_documento: sol.tipo_documento || '',
    numero_documento: sol.numero_documento || '',
    digito_verificacion: sol.digito_verificacion ?? '',
    email: sol.email || '',
    telefono: sol.telefono || '',
    direccion: sol.direccion || '',
    municipio_codigo: sol.municipio_id || '',
    municipio_nombre: sol.municipio_nombre || '',
  };

  // Mismas validaciones que crearFacturaDesdePago. tipo_documento debe ser
  // tributario colombiano (CC/CE/TI/NIT) — pasaporte y otros extranjeros
  // van en 'identidad' del registro pero NO sirven para Factus.
  const TIPOS_FISCALES = ['cc', 'ce', 'ti', 'nit'];
  const faltantes: string[] = [];
  const tipoLower = (datos.tipo_documento || '').toLowerCase();
  if (!tipoLower || !TIPOS_FISCALES.includes(tipoLower)) faltantes.push('tipo_documento');
  if (!datos.numero_documento) faltantes.push('numero_documento');
  if (!datos.email) faltantes.push('email');
  if (!datos.direccion) faltantes.push('direccion');
  if (!datos.telefono) faltantes.push('telefono');
  if (!datos.municipio_codigo || !/^\d{5}$/.test(datos.municipio_codigo)) {
    faltantes.push('municipio_codigo');
  }
  if (tipoPersona === 'juridica') {
    if (!datos.razon_social.trim()) faltantes.push('razon_social');
    if (!/^\d$/.test(datos.digito_verificacion)) faltantes.push('digito_verificacion');
  }

  return {
    ya_emitida: false,
    datos_actuales: datos,
    faltantes,
    monto: Number(ctx.monto) || 0,
    concepto: ctx.concepto,
  };
}

export async function crearFacturaDesdePago(
  pagoId: string,
  userId: string | null,
  ip?: string,
  override?: DatosFiscalesPagoOverride,
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

  // 3. Combinar datos del solicitante con override del body.
  const numeroDocumento = override?.numero_documento?.trim() || sol.numero_documento;
  const tipoDocumento = override?.tipo_documento?.trim() || sol.tipo_documento;
  const nombreCompletoOverride = override?.nombre_completo?.trim();
  const direccion = override?.direccion?.trim() || sol.direccion || '';
  const email = override?.email?.trim() || sol.email || '';
  const telefono = override?.telefono?.trim() || sol.telefono || '';
  const municipioCodigo = override?.municipio_codigo?.trim() || sol.municipio_id || '';
  const tipoPersona: 'natural' | 'juridica' = sol.tipo_persona ?? 'natural';
  const razonSocial = sol.razon_social?.trim() || '';
  const digitoVerificacion = sol.digito_verificacion?.trim() || '';
  const tributeCode = sol.tribute_code?.trim() || 'ZZ';

  // 3.5. Validacion estricta SIEMPRE — mismo set de faltantes que el preview.
  // Bloquea cualquier emision con datos incompletos. Defense in depth contra
  // clientes que saltaron la pantalla de Datos Fiscales o que tienen un
  // tipo_documento no tributario (eg. pasaporte del wizard de registro).
  const TIPOS_FISCALES = ['cc', 'ce', 'ti', 'nit'];
  const faltantes: string[] = [];
  const tipoLower = (tipoDocumento || '').toLowerCase();
  if (!tipoLower || !TIPOS_FISCALES.includes(tipoLower)) faltantes.push('tipo_documento');
  if (!numeroDocumento) faltantes.push('numero_documento');
  if (!email) faltantes.push('email');
  if (!direccion) faltantes.push('direccion');
  if (!telefono) faltantes.push('telefono');
  if (!municipioCodigo || !/^\d{5}$/.test(municipioCodigo)) faltantes.push('municipio_codigo');
  // Persona juridica: razon_social y DV son obligatorios para Factus/DIAN.
  if (tipoPersona === 'juridica') {
    if (!razonSocial) faltantes.push('razon_social');
    if (!/^\d$/.test(digitoVerificacion)) faltantes.push('digito_verificacion');
  }
  if (faltantes.length > 0) {
    throw new AppError(
      400,
      'CLIENTE_DATOS_INCOMPLETOS',
      'Faltan datos fiscales para emitir la factura. Completalos en Facturacion → Datos Fiscales.',
      { faltantes },
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
  const fullName = nombreCompletoOverride || `${sol.nombre} ${sol.apellido}`.trim();

  // Lee la tasa de IVA configurada para este concepto (admin la edita en
  // /facturacion). Si tasa>0, monto del pago es total con IVA incluido y
  // calculamos el price (base) para Factus. Si tasa=0, price = monto.
  const tasaIva = await getTarifaIvaPorConcepto(ctx.concepto);
  const priceBase = tasaIva > 0 ? monto / (1 + tasaIva / 100) : monto;
  const priceStr = priceBase.toFixed(2);

  // V2: code DANE = 5 dígitos. Si no matchea (legacy V1 con ID interno
  // Factus, o vacio), caemos al default.
  const dane = municipioCodigo && /^\d{5}$/.test(municipioCodigo)
    ? municipioCodigo
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
      identification: numeroDocumento,
      // Persona juridica: company + trade_name + dv (DV del NIT). Persona
      // natural: names. legal_organization_code 1=Jurídica, 2=Natural.
      ...(tipoPersona === 'juridica'
        ? {
            company: razonSocial,
            trade_name: razonSocial,
            ...(digitoVerificacion ? { dv: digitoVerificacion } : {}),
          }
        : { names: fullName }),
      address: direccion || undefined,
      email: email || undefined,
      phone: telefono || undefined,
      legal_organization_code: tipoPersona === 'juridica' ? '1' : '2',
      tribute_code: tributeCode,
      identification_document_code: mapTipoDocumentoToFactus(tipoDocumento),
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

  // Para persona juridica el campo razon_social en `facturas` guarda la
  // razon social real (no el nombre del representante). Para natural usa
  // nombre completo.
  const facturaRazonSocial =
    sol.tipo_persona === 'juridica' && sol.razon_social
      ? sol.razon_social.trim()
      : `${sol.nombre} ${sol.apellido}`.trim();

  // Si es NIT con DV, lo persistimos con el sufijo (eg. "900123456-7") para
  // que el listado de facturas y el PDF muestren el documento completo.
  const facturaNit =
    sol.digito_verificacion && sol.tipo_documento.toLowerCase() === 'nit'
      ? `${sol.numero_documento}-${sol.digito_verificacion}`
      : sol.numero_documento;

  const data = {
    pago_id: pagoId,
    expediente_id: expedienteId,
    numero_factura: bill.number,
    razon_social: facturaRazonSocial,
    nit: facturaNit,
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

// ============================================================
// crearFacturaDesdeCompraCreditos
//
// Factura una compra de paquete de creditos hecha por una inmobiliaria.
// La compra NO esta atada a un expediente — el "cliente" Factus es la
// inmobiliaria, no un solicitante. Datos fiscales:
// 1. Se intenta cargar del perfil de la inmobiliaria (perfiles.razon_social,
//    nit, direccion_comercial, ciudad, telefono, etc.).
// 2. Si el caller proporciona `datosFiscalesOverride`, se usa eso.
// 3. Si despues de combinar siguen faltando campos requeridos, lanza
//    error CLIENTE_DATOS_INCOMPLETOS con la lista en details.faltantes
//    para que el frontend muestre un form pidiendolos.
// ============================================================

export interface DatosFiscalesInmobiliaria {
  razon_social?: string;
  nit?: string;
  direccion?: string;
  email?: string;
  telefono?: string;
  /** Codigo DANE de 5 digitos. */
  municipio_codigo?: string;
  municipio_nombre?: string;
  /** '13'=CC, '31'=NIT, etc. Si no viene, se infiere. */
  tipo_documento?: string;
}

async function findFacturaExistentePorCompra(compraId: string) {
  const { data } = await (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, factus_number, cufe, factus_reference_code')
    .eq('compra_creditos_id', compraId)
    .maybeSingle();
  return data as { id: string; estado: string; factus_number: string | null; cufe: string | null; factus_reference_code: string | null } | null;
}

export async function crearFacturaDesdeCompraCreditos(
  compraId: string,
  perfilId: string,
  override: DatosFiscalesInmobiliaria | undefined,
  userId: string,
  ip?: string,
): Promise<{ id: string; factus_number: string | null; cufe: string | null; estado: string }> {
  // 1. Idempotencia: si ya hay factura emitida para esta compra, devolverla.
  const existente = await findFacturaExistentePorCompra(compraId);
  if (existente && existente.estado === 'emitida') {
    return {
      id: existente.id,
      factus_number: existente.factus_number,
      cufe: existente.cufe,
      estado: existente.estado,
    };
  }

  // 2. Cargar la compra y validar pertenencia + estado.
  const { data: compraRow, error: compraErr } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, perfil_id, cantidad_estudios, precio_cop, estado, stripe_session_id, stripe_payment_intent_id, completed_at, paquete_id')
    .eq('id', compraId)
    .single();

  if (compraErr || !compraRow) {
    throw AppError.notFound('Compra no encontrada', 'COMPRA_NOT_FOUND');
  }

  const compra = compraRow as unknown as {
    id: string;
    perfil_id: string;
    cantidad_estudios: number;
    precio_cop: number;
    estado: string;
    stripe_session_id: string | null;
    stripe_payment_intent_id: string | null;
    completed_at: string | null;
    paquete_id: string;
  };

  if (compra.perfil_id !== perfilId) {
    throw AppError.forbidden('Esta compra no le pertenece', 'NOT_OWNER');
  }
  if (compra.estado !== 'completado') {
    throw AppError.badRequest(
      'La compra no esta en estado completado — no se puede facturar',
      'COMPRA_NO_COMPLETADA',
    );
  }

  // 3. Cargar perfil + email del auth.users.
  const { data: perfilRow, error: perfErr } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, nombre, apellido, rol, tipo_documento, numero_documento,
      razon_social, nit, direccion, direccion_comercial, ciudad,
      nombre_representante, telefono, email_recaudo
    `)
    .eq('id', perfilId)
    .single();
  if (perfErr || !perfilRow) {
    throw AppError.notFound('Perfil no encontrado', 'PERFIL_NOT_FOUND');
  }
  const perfil = perfilRow as unknown as {
    id: string;
    nombre: string;
    apellido: string;
    rol: string;
    tipo_documento: string | null;
    numero_documento: string | null;
    razon_social: string | null;
    nit: string | null;
    direccion: string | null;
    direccion_comercial: string | null;
    ciudad: string | null;
    nombre_representante: string | null;
    telefono: string | null;
    email_recaudo: string | null;
  };

  const { data: authUserData } = await supabase.auth.admin.getUserById(perfilId);
  const emailAuth = authUserData?.user?.email || null;

  // 4. Combinar perfil + override. El override gana (lo que el usuario
  //    acaba de capturar en el modal de facturacion).
  const datos: Required<DatosFiscalesInmobiliaria> = {
    razon_social:
      override?.razon_social?.trim() ||
      perfil.razon_social ||
      `${perfil.nombre} ${perfil.apellido}`.trim(),
    nit: override?.nit?.trim() || perfil.nit || perfil.numero_documento || '',
    direccion:
      override?.direccion?.trim() ||
      perfil.direccion_comercial ||
      perfil.direccion ||
      '',
    email: override?.email?.trim() || perfil.email_recaudo || emailAuth || '',
    telefono: override?.telefono?.trim() || perfil.telefono || '',
    municipio_codigo: override?.municipio_codigo?.trim() || '',
    municipio_nombre: override?.municipio_nombre?.trim() || perfil.ciudad || '',
    tipo_documento:
      override?.tipo_documento?.trim() ||
      mapTipoDocumentoToFactus(perfil.nit ? 'NIT' : perfil.tipo_documento || 'CC'),
  };

  // 5. Validar campos requeridos. Si faltan, lanzamos error con la lista
  //    para que el frontend abra el modal pidiendolos.
  const faltantes: string[] = [];
  if (!datos.razon_social) faltantes.push('razon_social');
  if (!datos.nit) faltantes.push('nit');
  if (!datos.direccion) faltantes.push('direccion');
  if (!datos.email) faltantes.push('email');
  if (!datos.telefono) faltantes.push('telefono');
  if (!datos.municipio_codigo || !/^\d{5}$/.test(datos.municipio_codigo)) {
    faltantes.push('municipio_codigo');
  }
  if (faltantes.length > 0) {
    throw new AppError(
      400,
      'CLIENTE_DATOS_INCOMPLETOS',
      'Faltan datos fiscales para emitir la factura',
      { faltantes },
    );
  }

  // 6. Construir payload Factus.
  const numberingRangeId = await factus.discoverNumberingRangeId();
  const referenceCode = existente?.factus_reference_code || `CR-${compraId.replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const monto = Number(compra.precio_cop);

  // Para creditos de estudios consideramos el servicio exento de IVA
  // (reuso la convencion del estudio que tambien va exento). Si en
  // el futuro se decide cargar IVA, se configura via configuracion_sistema.
  const tasaIva = await getTarifaIvaPorConcepto('creditos_estudios');
  const priceBase = tasaIva > 0 ? monto / (1 + tasaIva / 100) : monto;
  const priceStr = priceBase.toFixed(2);

  // legal_organization_code: si tipo_documento es NIT (31) -> juridica (1).
  const isJuridica = datos.tipo_documento === '31';

  const payload: factus.CreateBillInput = {
    reference_code: referenceCode,
    document: '01',
    ...(numberingRangeId !== null ? { numbering_range_id: numberingRangeId } : {}),
    operation_type: '10',
    send_email: true,
    payment_details: [
      {
        payment_form: 1,
        payment_method_code: '10',
        reference_code: (compra.stripe_session_id || compraId).replace(/[^A-Z0-9]/gi, '').slice(0, 12).toUpperCase(),
        amount: monto.toFixed(2),
      },
    ],
    customer: {
      identification: datos.nit,
      ...(isJuridica
        ? { company: datos.razon_social, trade_name: datos.razon_social }
        : { names: datos.razon_social }),
      address: datos.direccion,
      email: datos.email,
      phone: datos.telefono,
      legal_organization_code: isJuridica ? '1' : '2',
      tribute_code: 'ZZ',
      identification_document_code: datos.tipo_documento,
      municipality_code: datos.municipio_codigo,
    },
    items: [
      {
        code_reference: 'creditos_estudios',
        name: `Paquete de ${compra.cantidad_estudios} estudios de arrendamiento`,
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

  logger.info({ compraId, referenceCode, perfilId }, 'Factus: enviando factura de compra de creditos');

  // 7. Llamar a Factus.
  let factusRes: factus.CreateBillResponse;
  try {
    factusRes = await factus.createBill(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ compraId, error: msg }, 'Factus: error al crear factura de compra');
    await persistFailedAttemptCompra({
      compraId,
      referenceCode,
      total: monto,
      error: msg,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      respuestaProveedor: (err as any).factusBody ?? { error: msg },
    });
    throw err;
  }

  const bill = extractBill(factusRes);
  if (!bill) {
    await persistFailedAttemptCompra({
      compraId,
      referenceCode,
      total: monto,
      error: 'Factus respondio 200 pero la estructura no es la esperada',
      respuestaProveedor: factusRes,
    });
    throw new AppError(
      502,
      'FACTUS_UNEXPECTED_RESPONSE',
      'Factus respondio 200 pero el formato es inesperado.',
    );
  }

  // 8. Persistir factura emitida.
  const facturaPersisted = await persistFacturaCompraEmitida({
    compraId,
    datos,
    factusRes,
    bill,
    referenceCode,
    montoFallback: monto,
  });

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_CREATED, // reuso hasta tener accion FACTURA_CREATED
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: facturaPersisted.id,
    detalle: {
      tipo: 'factura_compra_creditos',
      compra_id: compraId,
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

async function persistFacturaCompraEmitida(params: {
  compraId: string;
  datos: Required<DatosFiscalesInmobiliaria>;
  factusRes: factus.CreateBillResponse;
  bill: FactusBillSnapshot;
  referenceCode: string;
  montoFallback: number;
}) {
  const { compraId, datos, factusRes, bill, referenceCode, montoFallback } = params;
  const existente = await findFacturaExistentePorCompra(compraId);

  const data = {
    pago_id: null,
    compra_creditos_id: compraId,
    expediente_id: null,
    numero_factura: bill.number,
    razon_social: datos.razon_social,
    nit: datos.nit,
    direccion_fiscal: datos.direccion,
    estado: 'emitida' as const,
    factus_bill_id: bill.id,
    factus_reference_code: referenceCode,
    factus_number: bill.number,
    cufe: bill.cufe,
    qr_url: bill.qr,
    qr_image_base64: bill.qr_image,
    respuesta_proveedor: factusRes,
    concepto: 'creditos_estudios',
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
      logger.error({ error: error?.message, compraId }, 'Error al actualizar factura de compra');
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
    logger.error({ error: error?.message, compraId }, 'Error al insertar factura de compra');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al persistir la factura');
  }
  return inserted as { id: string };
}

async function persistFailedAttemptCompra(params: {
  compraId: string;
  referenceCode: string;
  total: number;
  error: string;
  respuestaProveedor: unknown;
}) {
  const existente = await findFacturaExistentePorCompra(params.compraId);
  const data = {
    pago_id: null,
    compra_creditos_id: params.compraId,
    expediente_id: null,
    estado: 'solicitada' as const,
    factus_reference_code: params.referenceCode,
    concepto: 'creditos_estudios',
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
  } else if (userRol === 'propietario' || userRol === 'inmobiliaria') {
    // Propietario/inmobiliaria solo ven facturas de expedientes de SUS
    // inmuebles — sin esto veían TODAS las facturas de la plataforma
    // (mismo scope que listPendientesFacturar).
    const { data: inmuebles } = await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('propietario_id', userId);
    const inmuebleIds = ((inmuebles as { id: string }[] | null) || []).map((i) => i.id);
    if (inmuebleIds.length === 0) {
      return { facturas: [], pagination: { total: 0, page: query.page, limit: query.limit, totalPages: 0 } };
    }
    const { data: expRows } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .in('inmueble_id', inmuebleIds);
    const expedienteIds = ((expRows as { id: string }[] | null) || []).map((e) => e.id);
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

// ── Pendientes de facturar ────────────────────────────────────────
// Lista pagos en estado 'completado' que aun NO tienen factura emitida.
// Filtrado por rol:
// - admin/operador: todos los pagos completados sin factura.
// - inmobiliaria/propietario: pagos de expedientes asociados a sus inmuebles.
// - solicitante: pagos de sus propios expedientes.

export interface PagoPendienteFacturar {
  pago_id: string;
  expediente_id: string;
  expediente_numero: string;
  concepto: string;
  monto: number;
  fecha_pago: string | null;
  // Estado de la factura (si hay un intento previo): null si no existe,
  // 'pendiente'/'fallida'/etc si hubo intento que no quedo emitida.
  factura_estado: string | null;
  factura_error: string | null;
}

export async function listPendientesFacturar(
  userId: string,
  userRol: string,
): Promise<PagoPendienteFacturar[]> {
  // 1. Resolver alcance: que expediente_ids puede ver este usuario.
  let expedienteIdsScope: string[] | null = null; // null = sin filtro (admin/operador)

  if (userRol === 'solicitante') {
    const { data: solRows } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('creado_por', userId);
    const solIds = ((solRows as { id: string }[] | null) || []).map((s) => s.id);
    if (solIds.length === 0) return [];

    const { data: expRows } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .in('solicitante_id', solIds);
    expedienteIdsScope = ((expRows as { id: string }[] | null) || []).map((e) => e.id);
    if (expedienteIdsScope.length === 0) return [];
  } else if (userRol === 'propietario' || userRol === 'inmobiliaria') {
    // Filtrar expedientes cuyo inmueble pertenece al usuario.
    const { data: inmuebles } = await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('propietario_id', userId);
    const inmuebleIds = ((inmuebles as { id: string }[] | null) || []).map((i) => i.id);
    if (inmuebleIds.length === 0) return [];

    const { data: expRows } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .in('inmueble_id', inmuebleIds);
    expedienteIdsScope = ((expRows as { id: string }[] | null) || []).map((e) => e.id);
    if (expedienteIdsScope.length === 0) return [];
  }

  // 2. Pagos completados en el alcance.
  let qb = (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, expediente_id, concepto, monto, fecha_pago, expediente:expedientes(numero)',
    )
    .eq('estado', 'completado')
    .order('fecha_pago', { ascending: false, nullsFirst: false });

  if (expedienteIdsScope !== null) {
    qb = qb.in('expediente_id', expedienteIdsScope);
  }

  const { data: pagos, error: pagosErr } = await qb;
  if (pagosErr) {
    logger.error({ error: pagosErr.message, userId, userRol }, 'Error listando pagos pendientes facturar');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al listar pagos pendientes de facturacion');
  }

  const pagosTyped =
    (pagos as unknown as Array<{
      id: string;
      expediente_id: string;
      concepto: string;
      monto: number | string;
      fecha_pago: string | null;
      expediente: { numero: string } | null;
    }>) || [];

  if (pagosTyped.length === 0) return [];

  // 3. Cruzar con facturas para excluir las que ya estan emitidas.
  const pagoIds = pagosTyped.map((p) => p.id);
  const { data: facturasRows } = await (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .select('pago_id, estado, error_mensaje')
    .in('pago_id', pagoIds);

  const facturasByPago = new Map<string, { estado: string; error_mensaje: string | null }>();
  for (const f of (facturasRows as Array<{ pago_id: string; estado: string; error_mensaje: string | null }> | null) || []) {
    // Si hay multiples filas (caso reintento), nos quedamos con la mas
    // "fuerte": emitida > pendiente > fallida. Aqui basta con guardarla,
    // un pago con factura emitida lo excluimos de todas formas.
    facturasByPago.set(f.pago_id, { estado: f.estado, error_mensaje: f.error_mensaje });
  }

  return pagosTyped
    .filter((p) => {
      const f = facturasByPago.get(p.id);
      // Excluir si ya hay factura emitida.
      return !f || f.estado !== 'emitida';
    })
    .map((p) => {
      const f = facturasByPago.get(p.id);
      return {
        pago_id: p.id,
        expediente_id: p.expediente_id,
        expediente_numero: p.expediente?.numero || '',
        concepto: p.concepto,
        monto: Number(p.monto) || 0,
        fecha_pago: p.fecha_pago,
        factura_estado: f?.estado ?? null,
        factura_error: f?.error_mensaje ?? null,
      };
    });
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
  const taxEffective = taxDb ?? 0;
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

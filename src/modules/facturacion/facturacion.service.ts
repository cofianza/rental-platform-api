/**
 * Facturación electrónica (DIAN) vía Factus.com.co.
 *
 * Hoy: solo facturamos el pago del estudio crediticio. El servicio se
 * dispara desde:
 *   1. Manual: POST /api/v1/pagos/:pagoId/facturar (botón en panel admin/inmo).
 *   2. Auto: orchestrator.onPagoConfirmado, fire-and-forget al confirmar el
 *      pago de Stripe.
 *
 * Idempotencia: el reference_code sale fijo del pago.id (UNIQUE en facturas) y
 * Factus rechaza uno repetido. Si el disparo automático y el clic manual se
 * cruzan, el que falla no pisa la factura emitida y devuelve la que ya quedó.
 */

import { supabase } from '@/lib/supabase';
import { getCompany } from '@/lib/companyConfig';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import * as factus from '@/lib/factus';
import type { ListFacturasQuery } from './facturacion.schema';
import type { UserRole } from '@/types/auth';
import {
  resolveAllowedExpedienteIds,
  assertExpedienteAccess,
  resolveVisibilityScope,
  resolveMembershipInmobiliariaIds,
  resolveOrgMemberPerfilIds,
  resolveOrgCanonicalPerfilId,
} from '@/lib/tenantScope';
import {
  aplicarOverride,
  clienteDesdePerfil,
  clienteDesdeSolicitante,
  faltantesFiscales,
  type ClienteFiscal,
  type DatosFiscalesPagoOverride,
  type PerfilFiscal,
  type SolicitanteFiscal,
} from './cliente-fiscal';

export type { DatosFiscalesPagoOverride } from './cliente-fiscal';

// ── Constants ──────────────────────────────────────────────────────

const VALOR_ESTUDIO_DEFAULT = 80_000; // COP, sin IVA

const ITEM_DEFAULTS = {
  unit_measure_code: '94', // unidad
  standard_code: '999', // Estándar adoptado contribuyente
  // Estudio crediticio = servicio financiero exento de IVA. V2 exige al menos
  // un tax; usamos { is_excluded: true } para indicar servicio excluido.
  taxes: [{ is_excluded: true }] as { is_excluded: boolean }[],
};

// Adenda 1 del modulo de contratos §1.6: la prima (el cobro 'garantia') y la
// tarifa se facturan GRAVADAS, con TARIFA_IVA: la misma tasa con la que se
// cobraron (§1.1). Su fila iva_concepto_garantia es solo reflejo. En 0 no se
// emite: una factura DIAN emitida como excluida solo se corrige con nota credito.
const CONCEPTOS_GRAVADOS = new Set(['garantia']);

async function tarifaIvaGravados(): Promise<number> {
  const { getCalibracion } = await import('@/lib/calibracion');
  return (await getCalibracion()).TARIFA_IVA;
}

/**
 * Parte un total cobrado (IVA incluido) como lo pide Factus V2: price sin
 * impuestos con 2 decimales, y Factus le calcula el IVA redondeado a 2. En
 * ~16 % de los montos enteros no cuadra (53.000 -> 44.537,82 + 8.462,19 =
 * 53.000,01): la diferencia va en cash_rounding_amount (pagado - total, ±500),
 * el campo de Factus que "reconcilia la diferencia entre la suma de los montos
 * en payment_details y el total" (en la DIAN, PayableRoundingAmount).
 * OJO: probarlo en el sandbox de Factus antes del primer cobro real de la prima.
 */
export function partirTotalConIva(monto: number, tasaIva: number): { price: string; cashRounding: string | null } {
  const totalCent = Math.round(monto * 100);
  const priceCent = Math.round(totalCent / (1 + tasaIva / 100));
  const ajusteCent = totalCent - priceCent - Math.round((priceCent * tasaIva) / 100);
  return { price: (priceCent / 100).toFixed(2), cashRounding: ajusteCent === 0 ? null : (ajusteCent / 100).toFixed(2) };
}

// ── Tipos para la integración ──────────────────────────────────────

interface PagoConContexto {
  id: string;
  expediente_id: string;
  concepto: string;
  monto: number;
  estado: string;
  email_pagador: string | null;
  nombre_pagador: string | null;
  /** Quien creó el cobro. En la opción B es el gestor que pagó. */
  creado_por: string | null;
  metodo: string | null;
  gateway_response: unknown;
  transaction_ref: string | null;
  expediente: {
    numero: string;
    // municipio_id: código DANE (5 dígitos, ej. "11001").
    solicitante: (SolicitanteFiscal & { id: string }) | null;
  };
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Medio de pago de la factura (tabla de medios de pago del anexo técnico DIAN)
 * según cómo entró la plata: tarjeta crédito 48, débito 49, PSE 47, Efecty 10,
 * transferencia 47, cheque 20, efectivo 10; cualquier otro, 1 (instrumento no
 * definido). En la pasarela lo dice el payment_type_id de Mercado Pago.
 */
export function medioPagoDian(metodo: string | null | undefined, gatewayResponse: unknown): string {
  if (metodo === 'transferencia') return '47';
  if (metodo === 'cheque') return '20';
  if (metodo === 'efectivo') return '10';
  if (metodo !== 'pasarela') return '1';
  switch ((gatewayResponse as { payment_type_id?: unknown } | null)?.payment_type_id) {
    case 'credit_card': return '48';
    case 'debit_card': return '49';
    case 'bank_transfer': return '47'; // PSE
    case 'ticket': return '10'; // Efecty: efectivo en un punto de pago
    default: return '1';
  }
}

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
      id, expediente_id, concepto, monto, estado, email_pagador, nombre_pagador, creado_por,
      metodo, gateway_response, transaction_ref,
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
  // Solo se factura dinero que entró: el id de un pago pendiente viaja en la
  // URL de retorno de la pasarela, y una factura DIAN "contado" por él sería
  // un comprobante de un pago que nunca ocurrió.
  if ((data as { estado: string }).estado !== 'completado') {
    throw AppError.conflict('Solo se puede facturar un pago completado.', 'PAGO_NO_COMPLETADO');
  }
  return data as unknown as PagoConContexto;
}

/**
 * Adenda 2 §7, opción B: el cobro lo pagó el gestor con SU correo, no el
 * solicitante. La factura va a quien pagó: la ORGANIZACIÓN (perfil canónico,
 * con el NIT y la razón social del titular) o el propietario individual.
 * null = pagó el solicitante. Lanza si pagó otra persona que no se identifica.
 */
async function clientePagador(ctx: PagoConContexto, solEmail: string | null): Promise<ClienteFiscal | null> {
  const pagador = ctx.email_pagador?.trim().toLowerCase();
  if (!pagador || !solEmail || pagador === solEmail.trim().toLowerCase()) return null;

  const emailCreador = ctx.creado_por
    ? ((await supabase.auth.admin.getUserById(ctx.creado_por)).data?.user?.email ?? null)
    : null;
  if (!ctx.creado_por || emailCreador?.trim().toLowerCase() !== pagador) {
    throw new AppError(
      409,
      'PAGADOR_NO_ES_SOLICITANTE',
      'El pago lo hizo alguien distinto al solicitante y no se pudo identificar su cuenta: la factura se emite a mano con los datos de quien pagó.',
    );
  }

  const perfilId = await resolveOrgCanonicalPerfilId(ctx.creado_por);
  const { data } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select(
      'nombre, apellido, tipo_documento, numero_documento, razon_social, nit, domicilio_direccion, ' +
        'direccion_comercial, direccion, telefono, whatsapp_recaudo, email_recaudo, municipio_codigo, municipio_nombre',
    )
    .eq('id', perfilId)
    .maybeSingle();
  if (!data) throw AppError.notFound('No se encontró el perfil de quien pagó', 'PERFIL_NOT_FOUND');
  return clienteDesdePerfil(data as unknown as PerfilFiscal, emailCreador);
}

/**
 * Pagos de estudio que salieron de un crédito prepagado (liberarEstudioConCredito):
 * el `pagos` del consumo no se distingue de una transferencia; la marca es su
 * movimiento en movimientos_creditos_estudios. Ese dinero ya se factura en la
 * compra del paquete — facturar el consumo le mandaba al arrendatario una
 * factura DIAN por un estudio que pagó la inmobiliaria, y duplicaba el ingreso.
 */
async function pagosConsumoDeCredito(pagoIds: string[]): Promise<Set<string>> {
  const filas = await selectInEnLotes<{ pago_id: string }>('movimientos_creditos_estudios', 'pago_id', 'pago_id', pagoIds);
  return new Set(filas.map((m) => m.pago_id));
}

/**
 * P1: motivos de la cola de reembolsos que dejan un pago de evaluación para
 * devolver (o en revisión para devolverlo): mientras la fila siga sin resolver
 * no se factura — sería una factura DIAN que luego necesita nota crédito.
 */
const MOTIVOS_POR_DEVOLVER = ['estudio_cerrado_sin_consulta', 'estudio_fallido_revisar'];

/**
 * P1: pagos de la evaluación que quedaron para devolver (el estudio terminó sin
 * consulta al buró y el pago entró después): no se facturan. Son pocos, así
 * que se lee la cola entera en vez de cruzar por lotes.
 */
async function pagosPorDevolver(): Promise<Set<string>> {
  const { data, error } = await (supabase.from('pagos_no_conciliados' as string) as ReturnType<typeof supabase.from>)
    .select('external_reference')
    .eq('resuelto', false)
    .in('motivo', MOTIVOS_POR_DEVOLVER);
  if (error) {
    logger.error({ error: error.message }, 'Error leyendo los pagos por devolver');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al consultar la facturación de los pagos');
  }
  return new Set(
    ((data ?? []) as Array<{ external_reference: string | null }>)
      .map((r) => r.external_reference?.split(':')[2])
      .filter((id): id is string => !!id),
  );
}

/**
 * `.select(columnas).in(columna, ids)` en lotes: con cientos de UUID la URL de
 * PostgREST pasa del límite y la consulta falla. El error se lanza: devolver
 * vacío hacía ver como pendientes (o facturables) pagos ya facturados o de crédito.
 */
const IN_LOTE = 150;
async function selectInEnLotes<T>(tabla: string, columnas: string, columna: string, ids: string[]): Promise<T[]> {
  const lotes: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_LOTE) lotes.push(ids.slice(i, i + IN_LOTE));
  const res = await Promise.all(
    lotes.map((lote) =>
      (supabase.from(tabla as string) as ReturnType<typeof supabase.from>).select(columnas).in(columna, lote),
    ),
  );
  const conError = res.find((r) => r.error);
  if (conError?.error) {
    logger.error({ error: conError.error.message, tabla }, 'Error consultando en lotes');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al consultar la facturación de los pagos');
  }
  return res.flatMap((r) => (r.data || []) as T[]);
}

/**
 * El pago está en la cola de reembolsos para devolverse (o en revisión): 409.
 * La fila se identifica como la encola reembolsos.service (encolar): por el
 * payment de Mercado Pago o por `pago:<id>` si no pasó por la pasarela.
 */
async function assertNoEstaPorDevolver(ctx: PagoConContexto): Promise<void> {
  const ids = [`pago:${ctx.id}`, ...(ctx.transaction_ref ? [ctx.transaction_ref] : [])];
  const { data, error } = await (supabase.from('pagos_no_conciliados' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .in('provider_payment_id', ids)
    .in('motivo', MOTIVOS_POR_DEVOLVER)
    .eq('resuelto', false)
    .limit(1)
    .maybeSingle();
  // Fail closed: sin saber si se devuelve, no se emite una factura DIAN.
  if (error) throw fromSupabaseError(error);
  if (data) {
    throw AppError.conflict(
      'Este pago está en la cola de reembolsos para devolverse: no se factura mientras Cofianza no lo resuelva.',
      'PAGO_POR_DEVOLVER',
    );
  }
}

async function assertNoEsConsumoDeCredito(pagoId: string): Promise<void> {
  if ((await pagosConsumoDeCredito([pagoId])).has(pagoId)) {
    throw new AppError(
      409,
      'PAGO_CON_CREDITO',
      'Esta evaluación se pagó con un crédito prepagado: se facturó con la compra del paquete.',
    );
  }
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

/**
 * `derivada`: la tasa no se edita aquí. La prima sale de TARIFA_IVA; los
 * paquetes de créditos (`derivada_de: 'estudio'`) llevan la de la evaluación.
 */
export async function listTarifasIva(): Promise<
  { concepto: string; tasa: number; derivada?: boolean; derivada_de?: 'estudio' }[]
> {
  const conceptos = ['estudio', 'garantia', 'primer_canon', 'deposito', 'otro'];
  const [{ data }, tasaGravados] = await Promise.all([
    (supabase.from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>)
      .select('clave, valor')
      .in('clave', conceptos.map((c) => `iva_concepto_${c}`)),
    tarifaIvaGravados(),
  ]);
  const map = new Map<string, string>();
  for (const row of (data || []) as { clave: string; valor: string }[]) {
    map.set(row.clave, row.valor);
  }
  const tarifas = conceptos.map((c) => {
    if (CONCEPTOS_GRAVADOS.has(c)) return { concepto: c, tasa: tasaGravados, derivada: true };
    const raw = map.get(`iva_concepto_${c}`) ?? '0';
    const n = Number(raw);
    return { concepto: c, tasa: Number.isFinite(n) ? n : 0 };
  });
  const estudio = tarifas.find((t) => t.concepto === 'estudio')?.tasa ?? 0;
  return [...tarifas, { concepto: 'creditos_estudios', tasa: estudio, derivada: true, derivada_de: 'estudio' as const }];
}

export async function updateTarifasIva(
  input: { concepto: string; tasa: number }[],
  userId: string,
  ip?: string,
): Promise<{ concepto: string; tasa: number }[]> {
  const allowedConceptos = new Set(['estudio', 'garantia', 'primer_canon', 'deposito', 'otro']);
  const tasaGravados = input.some((i) => CONCEPTOS_GRAVADOS.has(i.concepto)) ? await tarifaIvaGravados() : null;
  for (const item of input) {
    if (!allowedConceptos.has(item.concepto)) {
      throw AppError.badRequest(`Concepto inválido: ${item.concepto}`, 'CONCEPTO_INVALIDO');
    }
    if (typeof item.tasa !== 'number' || item.tasa < 0 || item.tasa > 100) {
      throw AppError.badRequest('La tasa debe estar entre 0 y 100', 'TASA_INVALIDA');
    }
    // Factus recibe la tasa con 2 decimales: 0,001 viajaría como "0.00".
    if (Math.round(item.tasa * 100) / 100 !== item.tasa) {
      throw AppError.badRequest('La tasa admite máximo 2 decimales (0 o desde 0,01).', 'TASA_INVALIDA');
    }
    if (tasaGravados !== null && CONCEPTOS_GRAVADOS.has(item.concepto) && item.tasa !== tasaGravados) {
      throw AppError.badRequest(
        `La prima de vinculación se factura con TARIFA_IVA (hoy ${tasaGravados} %), la misma tasa con la que se cobra: cámbiala en Calibración, no aquí.`,
        'CONCEPTO_GRAVADO',
      );
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
          descripcion: CONCEPTOS_GRAVADOS.has(item.concepto)
            ? 'Tasa de IVA (%) de la prima de vinculación (concepto garantia): gravada, la fija TARIFA_IVA (Adenda 1 de contratos §1.6).'
            : `Tasa de IVA (%) para ${item.concepto}. 0 = exento.`,
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
    case 'garantia': return 'Prima de vinculación de la fianza';
    case 'primer_canon': return 'Primer canon de arrendamiento';
    case 'deposito': return 'Depósito de arrendamiento';
    default: return `Servicio Cofianza (${concepto})`;
  }
}

// ── crearFacturaDesdePago ──────────────────────────────────────────

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
  datos_actuales: ClienteFiscal | null;
  /** Opción B: la factura va a la inmobiliaria o al propietario que pagó. */
  a_nombre_de_quien_pago: boolean;
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
      datos_actuales: null,
      a_nombre_de_quien_pago: false,
      faltantes: [],
      monto: 0,
      concepto: '',
    };
  }

  await assertNoEsConsumoDeCredito(pagoId);
  const ctx = await fetchPagoContext(pagoId);
  await assertNoEstaPorDevolver(ctx);
  const sol = ctx.expediente?.solicitante;
  if (!sol) {
    throw AppError.badRequest(
      'El estudio del pago no tiene solicitante asociado — no se puede facturar.',
      'NO_SOLICITANTE',
    );
  }

  // Mismas reglas que crearFacturaDesdePago (faltantesFiscales).
  const pagador = await clientePagador(ctx, sol.email);
  const datos = pagador ?? clienteDesdeSolicitante(sol);
  return {
    ya_emitida: false,
    datos_actuales: datos,
    a_nombre_de_quien_pago: pagador !== null,
    faltantes: faltantesFiscales(datos),
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
  await assertNoEsConsumoDeCredito(pagoId);
  const ctx = await fetchPagoContext(pagoId);
  await assertNoEstaPorDevolver(ctx);
  const sol = ctx.expediente?.solicitante;
  if (!sol) {
    throw AppError.badRequest(
      'El estudio del pago no tiene solicitante asociado — no se puede facturar.',
      'NO_SOLICITANTE',
    );
  }

  // 3. El cliente de la factura: quien pagó. Adenda 2 §7, opción B: si pagó el
  //    gestor, la factura va a la inmobiliaria (o al propietario), no al
  //    solicitante. Encima, lo que se corrigió en el modal de facturar.
  const pagador = await clientePagador(ctx, sol.email);
  const cliente = aplicarOverride(pagador ?? clienteDesdeSolicitante(sol), override);

  // 3.5. Validacion estricta SIEMPRE — mismo set de faltantes que el preview.
  // Bloquea cualquier emision con datos incompletos. Defense in depth contra
  // clientes que saltaron la pantalla de Datos Fiscales o que tienen un
  // tipo_documento no tributario (eg. pasaporte del wizard de registro).
  const faltantes = faltantesFiscales(cliente);
  if (faltantes.length > 0) {
    throw new AppError(
      400,
      'CLIENTE_DATOS_INCOMPLETOS',
      pagador
        ? 'Faltan datos fiscales de quien pagó para emitir la factura. Complétalos en Configuración → Datos para contrato.'
        : 'Faltan datos fiscales para emitir la factura. Completalos en Facturacion → Datos Fiscales.',
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

  // La tasa: la prima, TARIFA_IVA; lo demás, la de su concepto (admin la edita
  // en /facturacion). Si tasa>0, monto del pago es total con IVA incluido y
  // calculamos el price (base) para Factus. Si tasa=0, price = monto.
  const gravado = CONCEPTOS_GRAVADOS.has(ctx.concepto);
  const tasaIva = gravado ? await tarifaIvaGravados() : await getTarifaIvaPorConcepto(ctx.concepto);
  if (tasaIva === 0 && gravado) {
    // Queda el intento con el motivo, para que «Pendientes de facturar» lo muestre.
    const error =
      'La prima de vinculación se factura con IVA (Adenda 1 de contratos §1.6) y TARIFA_IVA está en 0 %. Corrígela en Calibración y vuelve a facturar.';
    await persistFailedAttempt({
      pagoId,
      expedienteId: ctx.expediente_id,
      referenceCode,
      concepto: ctx.concepto,
      total: monto,
      error,
      respuestaProveedor: null,
    });
    throw AppError.conflict(error, 'IVA_CONCEPTO_GRAVADO_EN_CERO');
  }
  const { price: priceStr, cashRounding } = partirTotalConIva(monto, tasaIva);

  const payload: factus.CreateBillInput = {
    reference_code: referenceCode,
    document: '01', // Factura electrónica de Venta
    ...(numberingRangeId !== null ? { numbering_range_id: numberingRangeId } : {}),
    operation_type: '10', // Estándar
    send_email: true,
    payment_details: [
      {
        payment_form: 1, // contado
        payment_method_code: medioPagoDian(ctx.metodo, ctx.gateway_response),
        reference_code: pagoId.replace(/-/g, '').slice(0, 12).toUpperCase(),
        amount: monto.toFixed(2), // total con IVA si aplica
      },
    ],
    ...(cashRounding ? { cash_rounding_amount: cashRounding } : {}),
    customer: {
      identification: cliente.numero_documento,
      // Persona juridica: company + trade_name + dv (DV del NIT). Persona
      // natural: names. legal_organization_code 1=Jurídica, 2=Natural.
      ...(cliente.tipo_persona === 'juridica'
        ? {
            company: cliente.razon_social,
            trade_name: cliente.razon_social,
            ...(cliente.digito_verificacion ? { dv: cliente.digito_verificacion } : {}),
          }
        : { names: cliente.nombre_completo }),
      address: cliente.direccion || undefined,
      email: cliente.email || undefined,
      phone: cliente.telefono || undefined,
      legal_organization_code: cliente.tipo_persona === 'juridica' ? '1' : '2',
      tribute_code: cliente.tribute_code,
      identification_document_code: mapTipoDocumentoToFactus(cliente.tipo_documento),
      // V2: code DANE = 5 dígitos (faltantesFiscales ya lo exige).
      municipality_code: cliente.municipio_codigo,
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
    // Carrera con el otro disparo (automático o manual) del mismo pago: Factus
    // rechaza el reference_code repetido, pero la factura ya quedó emitida.
    const yaEmitida = await findFacturaExistente(pagoId);
    if (yaEmitida?.estado === 'emitida') {
      return { id: yaEmitida.id, factus_number: yaEmitida.factus_number, cufe: yaEmitida.cufe, estado: yaEmitida.estado };
    }

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
    cliente,
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
  cliente: ClienteFiscal;
  factusRes: factus.CreateBillResponse;
  bill: FactusBillSnapshot;
  referenceCode: string;
  concepto: string;
  montoFallback: number;
}) {
  const { pagoId, expedienteId, cliente, factusRes, bill, referenceCode, concepto, montoFallback } = params;

  // Si ya hay un intento previo (fallido), actualizamos en vez de insertar.
  const existente = await findFacturaExistente(pagoId);

  // Para persona juridica el campo razon_social en `facturas` guarda la
  // razon social real (no el nombre del representante). Para natural usa
  // nombre completo.
  const facturaRazonSocial =
    cliente.tipo_persona === 'juridica' && cliente.razon_social ? cliente.razon_social : cliente.nombre_completo;

  // Si es NIT con DV, lo persistimos con el sufijo (eg. "900123456-7") para
  // que el listado de facturas y el PDF muestren el documento completo.
  const facturaNit =
    cliente.digito_verificacion && cliente.tipo_documento.toLowerCase() === 'nit'
      ? `${cliente.numero_documento}-${cliente.digito_verificacion}`
      : cliente.numero_documento;

  const data = {
    pago_id: pagoId,
    expediente_id: expedienteId,
    numero_factura: bill.number,
    razon_social: facturaRazonSocial,
    nit: facturaNit,
    direccion_fiscal: cliente.direccion,
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
  /** Quien la pide; null = sistema (webhook) o rol interno: sin chequeo de pertenencia. */
  perfilId: string | null,
  override: DatosFiscalesInmobiliaria | undefined,
  userId: string | null,
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
    .select('id, perfil_id, cantidad_estudios, precio_cop, estado, stripe_session_id, stripe_payment_intent_id, completed_at, paquete_id, gateway_response')
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
    gateway_response: unknown;
  };

  // La compra es de la organización (perfil canónico): cualquier miembro la
  // factura, y la factura sale con los datos fiscales de la organización.
  if (perfilId && compra.perfil_id !== (await resolveOrgCanonicalPerfilId(perfilId))) {
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
      nombre_representante, telefono, email_recaudo, municipio_codigo, municipio_nombre
    `)
    .eq('id', compra.perfil_id)
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
    municipio_codigo: string | null;
    municipio_nombre: string | null;
  };

  const { data: authUserData } = await supabase.auth.admin.getUserById(compra.perfil_id);
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
    // Guardado una vez en "Datos para contrato": ya no hay que teclearlo en cada factura.
    municipio_codigo: override?.municipio_codigo?.trim() || perfil.municipio_codigo || '',
    municipio_nombre: override?.municipio_nombre?.trim() || perfil.municipio_nombre || perfil.ciudad || '',
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

  // El paquete es el pago anticipado de evaluaciones: lleva el IVA de la
  // evaluación (ET art. 429, el anticipo causa el IVA del servicio), así que
  // lee la tasa del estudio y no una propia.
  const tasaIva = await getTarifaIvaPorConcepto('estudio');
  const { price: priceStr, cashRounding } = partirTotalConIva(monto, tasaIva);

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
        payment_method_code: medioPagoDian('pasarela', compra.gateway_response),
        reference_code: (compra.stripe_session_id || compraId).replace(/[^A-Z0-9]/gi, '').slice(0, 12).toUpperCase(),
        amount: monto.toFixed(2),
      },
    ],
    ...(cashRounding ? { cash_rounding_amount: cashRounding } : {}),
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

  logger.info({ compraId, referenceCode, perfilId: compra.perfil_id }, 'Factus: enviando factura de compra de creditos');

  // 7. Llamar a Factus.
  let factusRes: factus.CreateBillResponse;
  try {
    factusRes = await factus.createBill(payload);
  } catch (err) {
    // Misma carrera que en crearFacturaDesdePago (webhook + clic manual).
    const yaEmitida = await findFacturaExistentePorCompra(compraId);
    if (yaEmitida?.estado === 'emitida') {
      return { id: yaEmitida.id, factus_number: yaEmitida.factus_number, cufe: yaEmitida.cufe, estado: yaEmitida.estado };
    }

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
    // Un intento fallido nunca pisa una factura ya emitida.
    await (supabase
      .from('facturas' as string) as ReturnType<typeof supabase.from>)
      .update(data as never)
      .eq('id', existente.id)
      .neq('estado', 'emitida');
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
    // Un intento fallido nunca pisa una factura ya emitida.
    await (supabase
      .from('facturas' as string) as ReturnType<typeof supabase.from>)
      .update(data as never)
      .eq('id', existente.id)
      .neq('estado', 'emitida');
    return;
  }

  await (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .insert(data as never);
}

// ── Listar / ver ───────────────────────────────────────────────────

/**
 * P1: una factura emitida cuyo pago quedó 'reembolsado' o cuya compra de
 * créditos quedó 'cancelado' (contracargo o reembolso) necesita nota crédito en
 * Factus. Sin columna nueva: se cruza al vuelo. Devuelve el filtro `.or()` de
 * PostgREST, o null si no hay ninguna.
 * ponytail: los ids van en la URL; son pocos (reembolsos y compras revertidas).
 * Si crecen a cientos, pasarlo a una vista o RPC.
 */
async function filtroNotaCreditoPendiente(): Promise<string | null> {
  const [pagos, compras] = await Promise.all([
    (supabase.from('pagos' as string) as ReturnType<typeof supabase.from>).select('id').eq('estado', 'reembolsado'),
    (supabase.from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('estado', 'cancelado'),
  ]);
  const conError = pagos.error ?? compras.error;
  if (conError) {
    logger.error({ error: conError.message }, 'Error leyendo los cobros reembolsados para las notas crédito');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al listar facturas');
  }
  const ids = (r: { data: unknown }) => ((r.data ?? []) as Array<{ id: string }>).map((x) => x.id);
  const partes = [
    ids(pagos).length ? `pago_id.in.(${ids(pagos).join(',')})` : null,
    ids(compras).length ? `compra_creditos_id.in.(${ids(compras).join(',')})` : null,
  ].filter(Boolean);
  return partes.length ? partes.join(',') : null;
}

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
  if (query.nota_credito_pendiente) {
    const filtro = await filtroNotaCreditoPendiente();
    if (!filtro) return { facturas: [], pagination: { total: 0, page: query.page, limit: query.limit, totalPages: 0 } };
    qb = qb.eq('estado', 'emitida').or(filtro);
  }

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
    // Org-aware: facturas de los expedientes de su cartera/organización
    // (resolveAllowedExpedienteIds: inmuebles propios + de sus organizaciones).
    const expedienteIds = await resolveAllowedExpedienteIds(userId, userRol);
    if (expedienteIds !== null && expedienteIds.length === 0) {
      return { facturas: [], pagination: { total: 0, page: query.page, limit: query.limit, totalPages: 0 } };
    }
    if (expedienteIds !== null) {
      qb = qb.in('expediente_id', expedienteIds);
    }
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
// - admin/operador: todos los pagos completados sin factura, y además las
//   compras de paquetes de créditos sin factura (no viven en `pagos`).
// - inmobiliaria/propietario: pagos de expedientes asociados a sus inmuebles.
// - solicitante: pagos de sus propios expedientes.
// Los pagos de estudios liberados con crédito no se listan: ese dinero se
// factura en la compra del paquete.

export interface PagoPendienteFacturar {
  /** null en una compra de créditos (ver compra_id). */
  pago_id: string | null;
  /** Compra de paquete de créditos; null en un pago. */
  compra_id: string | null;
  /** En una compra: el nombre de la organización que compró. */
  cliente_nombre: string | null;
  expediente_id: string | null;
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
    // Org-aware: expedientes de su cartera/organización.
    expedienteIdsScope = await resolveAllowedExpedienteIds(userId, userRol);
    if (expedienteIdsScope !== null && expedienteIdsScope.length === 0) return [];
  }

  // 2. Pagos completados en el alcance.
  // ponytail: trae todos los completados (PostgREST corta en 1.000 filas).
  // Excluir los ya facturados en la BD pide la FK facturas.pago_id → pagos,
  // que en producción no existe; agregarla cuando el volumen lo pida.
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

  // 3. Cruzar con facturas (excluir las emitidas) y con los consumos de crédito.
  const pagoIds = pagosTyped.map((p) => p.id);
  const [facturasRows, conCredito, porDevolver] = await Promise.all([
    selectInEnLotes<{ pago_id: string; estado: string; error_mensaje: string | null }>(
      'facturas', 'pago_id, estado, error_mensaje', 'pago_id', pagoIds,
    ),
    pagosConsumoDeCredito(pagoIds),
    pagoIds.length > 0 ? pagosPorDevolver() : Promise.resolve(new Set<string>()),
  ]);

  const facturasByPago = new Map<string, { estado: string; error_mensaje: string | null }>();
  for (const f of facturasRows) {
    // Si hay multiples filas (caso reintento), nos quedamos con la mas
    // "fuerte": emitida > pendiente > fallida. Aqui basta con guardarla,
    // un pago con factura emitida lo excluimos de todas formas.
    facturasByPago.set(f.pago_id, { estado: f.estado, error_mensaje: f.error_mensaje });
  }

  const pendientes: PagoPendienteFacturar[] = pagosTyped
    .filter((p) => {
      const f = facturasByPago.get(p.id);
      // Excluir si ya hay factura emitida, si salió de un crédito prepagado o
      // si se va a devolver.
      return (!f || f.estado !== 'emitida') && !conCredito.has(p.id) && !porDevolver.has(p.id);
    })
    .map((p) => {
      const f = facturasByPago.get(p.id);
      return {
        pago_id: p.id,
        compra_id: null,
        cliente_nombre: null,
        expediente_id: p.expediente_id,
        expediente_numero: p.expediente?.numero || '',
        concepto: p.concepto,
        monto: Number(p.monto) || 0,
        fecha_pago: p.fecha_pago,
        factura_estado: f?.estado ?? null,
        factura_error: f?.error_mensaje ?? null,
      };
    });

  // 4. Roles internos: también las compras de paquetes sin factura emitida.
  //    Sin esto una compra cuya factura automática falló (Factus, datos
  //    fiscales incompletos) solo la veía el comprador.
  if (expedienteIdsScope === null) {
    pendientes.push(...(await comprasPendientesFacturar()));
    pendientes.sort((a, b) => (b.fecha_pago ?? '').localeCompare(a.fecha_pago ?? ''));
  }

  return pendientes;
}

async function comprasPendientesFacturar(): Promise<PagoPendienteFacturar[]> {
  const { data: comprasRows, error } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, perfil_id, precio_cop, completed_at')
    .eq('estado', 'completado');
  if (error) {
    logger.error({ error: error.message }, 'Error listando compras de créditos pendientes de facturar');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al listar pagos pendientes de facturacion');
  }
  const compras = (comprasRows || []) as Array<{ id: string; perfil_id: string; precio_cop: number | string; completed_at: string | null }>;
  if (compras.length === 0) return [];

  const [facturasRows, { data: perfilesRows }] = await Promise.all([
    selectInEnLotes<{ compra_creditos_id: string; estado: string; error_mensaje: string | null }>(
      'facturas', 'compra_creditos_id, estado, error_mensaje', 'compra_creditos_id', compras.map((c) => c.id),
    ),
    (supabase
      .from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('id, nombre, apellido, razon_social')
      .in('id', [...new Set(compras.map((c) => c.perfil_id))]),
  ]);

  const facturaByCompra = new Map(facturasRows.map((f) => [f.compra_creditos_id, f]));
  const nombreByPerfil = new Map(
    ((perfilesRows || []) as Array<{ id: string; nombre: string | null; apellido: string | null; razon_social: string | null }>)
      .map((p) => [p.id, p.razon_social?.trim() || `${p.nombre ?? ''} ${p.apellido ?? ''}`.trim()]),
  );

  return compras
    .filter((c) => facturaByCompra.get(c.id)?.estado !== 'emitida')
    .map((c) => {
      const f = facturaByCompra.get(c.id);
      return {
        pago_id: null,
        compra_id: c.id,
        cliente_nombre: nombreByPerfil.get(c.perfil_id) || null,
        expediente_id: null,
        expediente_numero: '',
        concepto: 'creditos_estudios',
        monto: Number(c.precio_cop) || 0,
        fecha_pago: c.completed_at,
        factura_estado: f?.estado ?? null,
        factura_error: f?.error_mensaje ?? null,
      };
    });
}

/**
 * Resuelve el expediente_id ligado a una factura: directo si la fila lo trae,
 * o vía su pago (pago.expediente_id). Devuelve null para facturas de compra de
 * créditos (sin expediente) o filas huérfanas.
 */
async function resolveFacturaExpedienteId(
  factura: Record<string, unknown>,
): Promise<string | null> {
  const direct = (factura.expediente_id as string | null) ?? null;
  if (direct) return direct;
  const pagoId = (factura.pago_id as string | null) ?? null;
  if (pagoId) {
    const { data: pago } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('expediente_id')
      .eq('id', pagoId)
      .maybeSingle();
    return (pago as { expediente_id?: string | null } | null)?.expediente_id ?? null;
  }
  return null;
}

/**
 * Guard de pertenencia para facturas SIN expediente (compra de créditos de
 * estudios). El "cliente" de la factura es la inmobiliaria compradora, no un
 * solicitante. No-op para roles internos y llamadas sin identidad; 404 para
 * cualquier otro rol que no sea el comprador (o miembro activo de su
 * organización, en el caso de una inmobiliaria).
 */
async function assertCompraFacturaAccess(
  factura: Record<string, unknown>,
  userId?: string,
  userRol?: string,
): Promise<void> {
  if (!userId || !userRol) return; // llamada de sistema
  const scope = await resolveVisibilityScope(userId, userRol);
  if (scope.kind === 'all') return; // rol interno: ve todo

  const compraId = (factura.compra_creditos_id as string | null) ?? null;
  if (compraId) {
    const { data: compra } = await (supabase
      .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .select('perfil_id')
      .eq('id', compraId)
      .maybeSingle();
    const compradorId = (compra as { perfil_id?: string | null } | null)?.perfil_id ?? null;
    if (compradorId) {
      if (compradorId === userId) return; // su propia compra
      if (userRol === 'inmobiliaria') {
        // El comprador puede ser cualquier miembro de su organización.
        const orgIds = await resolveMembershipInmobiliariaIds(userId);
        for (const orgId of orgIds) {
          const memberIds = await resolveOrgMemberPerfilIds(orgId);
          if (memberIds.includes(compradorId)) return;
        }
      }
    }
  }
  throw AppError.notFound('Factura no encontrada', 'FACTURA_NOT_FOUND');
}

export async function getFacturaById(id: string, userId?: string, userRol?: string) {
  const { data, error } = await (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('id', id)
    .single();
  if (error || !data) {
    throw AppError.notFound('Factura no encontrada', 'FACTURA_NOT_FOUND');
  }

  const f = data as Record<string, unknown>;

  // Guard multi-tenant por-id: resuelve el expediente de la factura y valida
  // pertenencia (no-op para roles internos / llamadas sin identidad). Cierra el
  // IDOR de GET /facturas/:id y GET /facturas/:id/factus/:tipo — antes cualquier
  // rol con permiso 'facturas:read' podía leer/descargar facturas ajenas.
  const expedienteId = await resolveFacturaExpedienteId(f);
  if (expedienteId) {
    await assertExpedienteAccess(expedienteId, userId, userRol);
  } else {
    // Sin expediente: factura de compra de créditos (o huérfana).
    await assertCompraFacturaAccess(f, userId, userRol);
  }

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

  // Mapear a la forma esperada por el frontend (IFactura). Los datos del EMISOR
  // salen de getCompany() (configuracion_sistema.empresa, editable por admin) —
  // antes estaban hardcodeados con un NIT placeholder ('901.000.000-0') que se
  // mostraba en la factura.
  const empresa = await getCompany();
  return {
    ...f,
    numero: f.factus_number ?? f.numero_factura ?? null,
    fecha: f.validada_en ?? f.created_at,
    subtotal: subtotal > 0 ? subtotal : (totalEffective ?? 0),
    iva: taxEffective,
    iva_porcentaje: ivaPorcentaje,
    total: totalEffective ?? 0,
    emisor_razon_social: empresa.name,
    emisor_nit: empresa.nit,
    emisor_direccion: empresa.address,
    receptor_razon_social: f.razon_social ?? '',
    receptor_documento: f.nit ?? '',
    receptor_direccion: f.direccion_fiscal ?? '',
    receptor_email: '',
  };
}

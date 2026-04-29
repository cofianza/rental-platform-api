/**
 * Factus.com.co — Cliente API V2 (facturación electrónica DIAN Colombia)
 *
 * - Sandbox: https://api-sandbox.factus.com.co
 * - Auth: OAuth2 password grant. access_token vive 600s. Hay refresh_token.
 * - Crear factura: POST /v2/bills/validate (síncrono — DIAN valida en la
 *   misma request y devuelve CUFE + QR + PDF/XML downloadable).
 * - Sin webhooks: el resultado completo viene en la respuesta del POST.
 *
 * Mantiene un cache de token en memoria. El token se refresca de forma
 * lazy: si está expirado o vence en < 30s, se renueva. Si no hay
 * refresh_token válido, se hace login con credenciales.
 */

import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';

// ── Types ──────────────────────────────────────────────────────────

interface AuthResponse {
  token_type: 'Bearer';
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

// ── V2: códigos DIAN y DANE ────────────────────────────────────────
// V2 usa códigos estándar DIAN (no IDs internos de Factus) y código DANE
// para municipios. Ver tabla referencia DIAN.
//
// identification_document_code: 11=RC, 12=TI, 13=CC, 21=TE, 22=CE, 31=NIT,
//   41=Pasaporte, 50=NIT Extranjero, 91=NUIP.
// legal_organization_code: 1=Jurídica, 2=Natural.
// tribute_code: 01=IVA, 04=INC, ZA=IVA+INC, ZZ=No aplica.
// municipality_code: código DANE de 5 dígitos (ej. 11001=Bogotá D.C.).

export interface FactusCustomer {
  identification: string;
  dv?: string;
  company?: string;
  trade_name?: string;
  /** En V2 no hay 'names' separado — para persona natural, va en company. */
  names?: string;
  address?: string;
  email?: string;
  phone?: string;
  legal_organization_code: string;
  tribute_code: string;
  identification_document_code: string;
  municipality_code: string;
}

export interface FactusTax {
  /** 01=IVA, 04=INC, etc. Omitir si is_excluded=true. */
  code?: string;
  /** "19.00", "5.00", "0.00". Omitir si is_excluded=true. */
  rate?: string;
  /** true = servicio/producto excluido de IVA (no causa el impuesto). */
  is_excluded?: boolean;
}

export interface FactusItem {
  code_reference: string;
  name: string;
  quantity: string; // V2: string con decimal
  discount_rate: string; // "0.00"
  price: string; // V2: string con decimal
  unit_measure_code: string; // "94" = unidad
  standard_code: string; // "999" = Estándar adoptado contribuyente
  taxes: FactusTax[];
}

export interface FactusPaymentDetail {
  /** 1=contado, 2=crédito */
  payment_form: number;
  /** Código método pago — ver tabla Factus. 10=efectivo, 42=consignación. */
  payment_method_code: string;
  reference_code?: string;
  amount: string;
  /** YYYY-MM-DD. Requerido si payment_form=2 (crédito). */
  due_date?: string;
}

export interface CreateBillInput {
  reference_code: string;
  /** "01" = Factura electrónica de Venta (default V2). */
  document?: string;
  /** Opcional. Si solo hay un rango activo Factus lo selecciona solo. */
  numbering_range_id?: number;
  /** "10" = Estándar (default). */
  operation_type?: string;
  send_email?: boolean;
  observation?: string;
  cash_rounding_amount?: string;
  payment_details: FactusPaymentDetail[];
  customer: FactusCustomer;
  items: FactusItem[];
}

export interface CreateBillResponse {
  status: 'Created';
  message: string;
  data: {
    company: Record<string, unknown>;
    customer: Record<string, unknown>;
    numbering_range: Record<string, unknown>;
    bill: {
      id: number;
      number: string;
      reference_code: string;
      cufe: string;
      qr: string;
      qr_image: string; // base64 data URL
      validated: string;
      total: string;
      tax_amount: string;
      gross_value: string;
      discount: string;
      [k: string]: unknown;
    };
    items: unknown[];
    [k: string]: unknown;
  };
}

export interface NumberingRange {
  id: number;
  document: string;
  prefix: string;
  from: number;
  to: number;
  current: number;
  resolution_number: string;
  start_date: string;
  end_date: string;
  is_expired: 0 | 1;
  is_active: 0 | 1;
}

// ── Token cache ────────────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
}
let tokenCache: CachedToken | null = null;
const REFRESH_BUFFER_MS = 30_000; // refrescar 30s antes de expirar
let inflightAuth: Promise<string> | null = null;

// ── HTTP helper ────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  // Si hay un auth en curso, reutilizamos esa promesa para evitar
  // hammering al endpoint /oauth/token bajo carga concurrente.
  if (inflightAuth) return inflightAuth;

  if (tokenCache && tokenCache.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return tokenCache.accessToken;
  }

  inflightAuth = doAuthenticate();
  try {
    return await inflightAuth;
  } finally {
    inflightAuth = null;
  }
}

async function doAuthenticate(): Promise<string> {
  // Si tenemos refresh token vigente, usarlo. Si no, login completo.
  if (tokenCache?.refreshToken && tokenCache.expiresAt > Date.now()) {
    try {
      const refreshed = await refreshTokenCall(tokenCache.refreshToken);
      cacheToken(refreshed);
      return refreshed.access_token;
    } catch (err) {
      logger.warn({ error: err }, 'Factus: refresh token failed — re-login');
    }
  }

  const fresh = await passwordLogin();
  cacheToken(fresh);
  return fresh.access_token;
}

function cacheToken(res: AuthResponse): void {
  tokenCache = {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: Date.now() + res.expires_in * 1000,
  };
}

async function passwordLogin(): Promise<AuthResponse> {
  if (!env.FACTUS_CLIENT_ID || !env.FACTUS_CLIENT_SECRET || !env.FACTUS_USERNAME || !env.FACTUS_PASSWORD) {
    throw AppError.badRequest(
      'Credenciales de Factus no configuradas (FACTUS_CLIENT_ID/SECRET/USERNAME/PASSWORD).',
      'FACTUS_NOT_CONFIGURED',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: env.FACTUS_CLIENT_ID,
    client_secret: env.FACTUS_CLIENT_SECRET,
    username: env.FACTUS_USERNAME,
    password: env.FACTUS_PASSWORD,
  });

  const res = await fetch(`${env.FACTUS_API_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ status: res.status, body: text }, 'Factus: login failed');
    throw new AppError(502, 'FACTUS_AUTH_ERROR', `Factus auth ${res.status}: ${text || 'sin detalle'}`);
  }

  return (await res.json()) as AuthResponse;
}

async function refreshTokenCall(refreshToken: string): Promise<AuthResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.FACTUS_CLIENT_ID || '',
    client_secret: env.FACTUS_CLIENT_SECRET || '',
    refresh_token: refreshToken,
  });

  const res = await fetch(`${env.FACTUS_API_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`refresh ${res.status}`);
  }
  return (await res.json()) as AuthResponse;
}

async function factusRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${env.FACTUS_API_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // ignore
    }
    logger.error({ status: res.status, path, body: parsed ?? text }, 'Factus API error');
    const err = new AppError(
      res.status >= 500 ? 502 : res.status,
      `FACTUS_${res.status}`,
      `Factus ${path} ${res.status}: ${typeof parsed === 'object' ? JSON.stringify(parsed) : text || 'sin detalle'}`,
    );
    // Adjuntar payload crudo para que el caller lo persista en respuesta_proveedor.
    (err as AppError & { factusBody?: unknown }).factusBody = parsed ?? text;
    throw err;
  }

  return (await res.json()) as T;
}

// ── API Methods ────────────────────────────────────────────────────

/**
 * Lista rangos de numeración filtrando por documento/activo.
 * Cache simple en memoria (1h) — los rangos casi nunca cambian.
 */
let cachedRanges: { data: NumberingRange[]; cachedAt: number } | null = null;
const RANGES_TTL_MS = 60 * 60 * 1000;

export async function listNumberingRanges(opts?: {
  /** Código documento DIAN (21 = factura electrónica). Default 21. */
  document?: string;
  /** Solo activos (default true). */
  onlyActive?: boolean;
  /** Forzar refresh del cache. */
  force?: boolean;
}): Promise<NumberingRange[]> {
  const now = Date.now();
  if (!opts?.force && cachedRanges && now - cachedRanges.cachedAt < RANGES_TTL_MS) {
    return cachedRanges.data;
  }

  const params = new URLSearchParams();
  params.set('filter[document]', opts?.document ?? '21');
  if (opts?.onlyActive !== false) params.set('filter[is_active]', '1');

  // Factus V2 puede envolver la lista de varias formas:
  //   { data: [...] }                     (forma simple)
  //   { data: { data: [...], ... } }      (paginación Laravel)
  const result = await factusRequest<{
    data: NumberingRange[] | { data: NumberingRange[] };
  }>(`/v2/numbering-ranges?${params.toString()}`);

  let ranges: NumberingRange[] = [];
  if (Array.isArray(result.data)) {
    ranges = result.data;
  } else if (result.data && Array.isArray((result.data as { data?: NumberingRange[] }).data)) {
    ranges = (result.data as { data: NumberingRange[] }).data;
  }
  cachedRanges = { data: ranges, cachedAt: now };
  return ranges;
}

/**
 * Auto-discover: devuelve el ID del primer rango activo de facturación
 * electrónica (document=21). Si la cuenta no tiene acceso a /v2/numbering-ranges
 * (algunos planes de Factus), retorna null y dejamos que Factus seleccione
 * el rango automáticamente al crear la factura (válido cuando solo hay uno
 * activo, según los docs).
 */
export async function discoverNumberingRangeId(): Promise<number | null> {
  try {
    const ranges = await listNumberingRanges({ document: '21', onlyActive: true });
    const usable = ranges.filter((r) => !r.is_expired && r.is_active && r.current < r.to);
    if (usable.length === 0) {
      logger.warn(
        'Factus: ningún rango activo retornado por /v2/numbering-ranges — se omitirá el ID',
      );
      return null;
    }
    return usable[0].id;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Factus: no se pudo listar rangos (¿plan limita el endpoint?) — se omitirá numbering_range_id',
    );
    return null;
  }
}

/**
 * Crea y valida una factura electrónica (síncrono — DIAN ya validada en la
 * respuesta).
 */
export async function createBill(input: CreateBillInput): Promise<CreateBillResponse> {
  return factusRequest<CreateBillResponse>('/v2/bills/validate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Descarga el PDF de una factura ya emitida en Factus.
 * El número aquí es el `bill.number` que devuelve `createBill` (ej. "SETP990001347").
 * La respuesta trae el archivo en base64 y el nombre original sugerido.
 */
export async function downloadBillPdf(
  billNumber: string,
): Promise<{ pdf_base_64_encoded: string; file_name: string }> {
  const result = await factusRequest<{
    data: { pdf_base_64_encoded: string; file_name: string };
  }>(`/v2/bills/${encodeURIComponent(billNumber)}/download-pdf`);
  return result.data;
}

/**
 * Descarga el XML (representación electrónica DIAN) de una factura ya emitida.
 */
export async function downloadBillXml(
  billNumber: string,
): Promise<{ xml_base_64_encoded: string; file_name: string }> {
  const result = await factusRequest<{
    data: { xml_base_64_encoded: string; file_name: string };
  }>(`/v2/bills/${encodeURIComponent(billNumber)}/download-xml/`);
  return result.data;
}

/**
 * Busca municipios por nombre (autocomplete del wizard de registro).
 * Devuelve hasta 50 resultados. Usa el endpoint público de Factus.
 */
export interface FactusMunicipality {
  id: number;
  code: string;
  name: string;
  department: { id: number; code: string; name: string };
}

export async function searchMunicipalities(name: string): Promise<FactusMunicipality[]> {
  const result = await factusRequest<{ data: FactusMunicipality[] }>(
    `/v2/municipalities?name=${encodeURIComponent(name)}`,
  );
  return result.data || [];
}

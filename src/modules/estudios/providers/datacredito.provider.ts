// ============================================================
// DataCredito / Experian — Historia de Credito+ (HDC Plus) REST
//
// Manual: MN-VPT-001 "Manual de Implementacion WSS Historia de Credito+
// Servicio Rest" v1.5 + PATH.xlsx (diccionario de campos) + Anexo Advance
// Income DW. Productos contratados por Cofianza:
//   - Historia de Credito + en Linea
//   - Advance Credit Score 1.1 (modelCode 'DF')  -> score de riesgo
//   - Advance Income        (productCode 'DW')  -> ingreso estimado
//
// Auth en DOS pasos (a diferencia de TransUnion, que es Basic Auth directo):
//   1) POST {BASE}/spla/oauth2/v1/token  headers client_id+client_secret,
//      body {username,password} del usuario OKTA  -> access_token
//   2) POST {BASE}/cs/credit-history/v1/hdcplus  headers Authorization Bearer
//      + client_id + client_secret + serverIpAddress + ProductId +
//      InfoAccountType, y user/password (OTRAS credenciales) en el BODY.
//
// OJO — el servicio solo acepta trafico desde las IPs publicas declaradas a
// Experian. Desde local responde 403 aunque las credenciales sean correctas:
// solo se puede probar desde el servidor desplegado.
// ============================================================

import { randomUUID } from 'node:crypto';
import { env } from '@/config/env';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { withRetry } from './retry';
import type {
  CreditRiskProvider,
  ProviderSolicitudInput,
  ProviderSolicitudResponse,
  ProviderStatusResponse,
  ProviderResult,
  ProviderHealthInfo,
} from './types';

// ── Tipo documento → personIdType (Tabla 1 del manual) ──────
const TIPO_DOCUMENTO_MAP: Record<string, number> = {
  cc: 1,
  ce: 2,
  nit: 3,
  ti: 4,
  pasaporte: 5,
};

// ── Catalogo de responseCode (Tabla 13, pags. 28-29) ────────
// `exito`      → la consulta se resolvio (con o sin datos).
// `reintentar` → transitorio, vale la pena reintentar.
// El resto son errores definitivos: de entrada (04/05/06/10) o de
// configuracion/credenciales (01/02/12/16/17/18), que NO deben reintentarse.
const RESPONSE_CODES: Record<string, { mensaje: string; exito?: boolean; reintentar?: boolean }> = {
  '01': { mensaje: 'Codigo de suscriptor no existe (revisar DATACREDITO_USER)' },
  '02': { mensaje: 'Clave de consulta errada (revisar DATACREDITO_PASSWORD)' },
  '04': { mensaje: 'Tipo de documento errado' },
  '05': { mensaje: 'Numero de documento errado' },
  '06': { mensaje: 'Primer apellido errado' },
  '09': { mensaje: 'El numero de identificacion no existe en los archivos de validacion de la base de datos' },
  '10': { mensaje: 'El apellido enviado no coincide con el registrado en la Registraduria Nacional' },
  '12': { mensaje: 'Clave de consulta bloqueada — requiere gestion con DataCredito' },
  '13': { mensaje: 'La consulta fue efectiva', exito: true },
  '14': { mensaje: 'Consulta efectiva, sin informacion disponible por este canal', exito: true },
  '16': { mensaje: 'Prepago agotado' },
  '17': { mensaje: 'Clave de consulta vencida' },
  '18': { mensaje: 'Clave de consulta no habilitada' },
  '23': { mensaje: 'No se pudo realizar la consulta, vuelva a intentar', reintentar: true },
};

// El manual dice 30 min y en DEMO se observo expires_in=600. Se usa siempre el
// expires_in que devuelve el runtime; esto es solo el piso si no viniera.
const TOKEN_TTL_FALLBACK_S = 600;
// Margen para no usar un token que expira mientras viaja la peticion.
const TOKEN_SAFETY_MARGIN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;

// ── Respuesta del servicio ──────────────────────────────────
// Todo opcional a proposito: nunca hemos visto un payload real con
// responseCode 13, y el diccionario (PATH.xlsx) es una hoja hecha a mano con
// erratas conocidas. El parser no debe romperse por un campo ausente.

interface DcProductResult {
  securityCode?: string;
  consultDate?: string;
  responseCode?: string | number;
  responseDesc?: string;
}

interface DcModel {
  modelCode?: string | number;
  modelName?: (string | null)[] | string | null;
  modelDate?: string;
  scoreValue?: number;
  population?: number;
  classification?: string;
  ScoreReason?: string[];
}

interface DcProductValue {
  productCode?: string;
  productName?: string | null;
  reason?: string;
  value?: number | string;
  valueSMLV?: number | string;
}

interface DcPrincipals {
  currentCredits?: number;
  currentNegativeCredits?: number;
  negativeHistoricalLast12Months?: number;
  closedCredits?: number;
  currentDisputes?: number;
  totalDisputes?: number;
  consultedLast6Months?: number;
  valueMonthlyPayment?: number;
  maturationSince?: string;
}

interface DcBalances {
  totaldebtBalance?: number;
  debtBalanceD30?: number;
  debtBalanceD60?: number;
  debtBalanceD90?: number;
  hightestDebtBalance?: number;
}

interface DcReport {
  productResult?: DcProductResult;
  identifyingAttributes?: Record<string, unknown>;
  basicInformation?: Record<string, unknown>;
  models?: DcModel[];
  // Anexo Advance Income: llega como arreglo ANIDADO (productValueList[0][n]).
  productValueList?: DcProductValue[][] | DcProductValue[];
  AgregatedInfo?: {
    overview?: {
      PrincipalsAgregatedInfo?: DcPrincipals;
      BalancesAgregatedInfo?: DcBalances;
    };
  };
  alerts?: { alertCode?: string; textAlert?: string }[];
}

interface DcSuccessResponse {
  ReportHDCplus?: DcReport;
}

// Envelope de errores de plataforma (ApiGee/gateway) — forma distinta a la
// respuesta de negocio: no trae ReportHDCplus.
interface DcErrorEnvelope {
  success?: boolean;
  errors?: { code?: string; message?: string }[];
  uri?: string;
}

interface DcTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: string | number;
}

// ── Cache de token y de resultados ──────────────────────────
let tokenCache: { token: string; expiresAt: number } | null = null;
const resultCache = new Map<string, ProviderResult>();

// ── Helpers ─────────────────────────────────────────────────

/**
 * DataCredito usa -1 como "valor no reportado". Sin esta normalizacion
 * aparecerian saldos y moras de -1 en la UI.
 */
function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (typeof n !== 'number' || Number.isNaN(n) || n === -1) return null;
  return n;
}

function formatCOP(value: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(value);
}

/** El catalogo usa dos digitos; el servicio devuelve number (13) o string ('09'). */
function normalizeResponseCode(raw: unknown): string {
  return String(raw ?? '').trim().padStart(2, '0');
}

/**
 * DataCredito valida el primer apellido contra la Registraduria cuando el
 * documento es CC. Si el caller no lo entrega por separado se deriva del
 * nombre completo: en Colombia el orden habitual es
 * `Nombre1 [Nombre2] Apellido1 [Apellido2]`, asi que con 4+ palabras el primer
 * apellido es la antepenultima, y con 3 la penultima.
 * Es una heuristica: lo correcto es que el caller pase `primer_apellido`.
 */
function derivarPrimerApellido(nombreCompleto: string): string {
  const partes = nombreCompleto.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '';
  if (partes.length <= 2) return partes[partes.length - 1];
  if (partes.length === 3) return partes[1];
  return partes[partes.length - 2];
}

function assertCredentials(): {
  clientId: string;
  clientSecret: string;
  oktaUser: string;
  oktaPassword: string;
  user: string;
  password: string;
} {
  const clientId = env.DATACREDITO_CLIENT_ID;
  const clientSecret = env.DATACREDITO_CLIENT_SECRET;
  const oktaUser = env.DATACREDITO_OKTA_USERNAME;
  const oktaPassword = env.DATACREDITO_OKTA_PASSWORD;
  const user = env.DATACREDITO_USER;
  const password = env.DATACREDITO_PASSWORD;

  const faltantes: string[] = [];
  if (!clientId) faltantes.push('DATACREDITO_CLIENT_ID');
  if (!clientSecret) faltantes.push('DATACREDITO_CLIENT_SECRET');
  if (!oktaUser) faltantes.push('DATACREDITO_OKTA_USERNAME');
  if (!oktaPassword) faltantes.push('DATACREDITO_OKTA_PASSWORD');
  if (!user) faltantes.push('DATACREDITO_USER');
  if (!password) faltantes.push('DATACREDITO_PASSWORD');

  if (faltantes.length > 0) {
    throw AppError.badRequest(
      `Credenciales de DataCredito no configuradas. Falta: ${faltantes.join(', ')}.`,
      'PROVIDER_NOT_CONFIGURED',
    );
  }

  return {
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    oktaUser: oktaUser as string,
    oktaPassword: oktaPassword as string,
    user: user as string,
    password: password as string,
  };
}

function baseUrl(): string {
  return env.DATACREDITO_API_URL.replace(/\/$/, '');
}

/**
 * Advance Income (productCode 'DW'). Los tres primeros objetos son ingreso
 * medio / limite inferior / limite superior, en MILES de pesos.
 *
 * El anexo define codigos de exclusion en `reason`: 50-54 significan "no
 * estimable" y llegan con value 0 — NO significan "gana cero". Verificado en
 * DEMO: una persona sin informacion devolvio reason '0051' con value 0, y las
 * entradas sin razon llegan como '00000' (por eso no se exige un codigo
 * concreto: basta descartar las exclusiones y exigir un valor positivo).
 */
const DW_EXCLUSION_CODES = new Set([50, 51, 52, 53, 54]);

function extraerIngresoDW(report: DcReport): number | null {
  const productValues = (report.productValueList ?? []).flat() as DcProductValue[];
  const dw = productValues.find((p) => String(p.productCode ?? '').toUpperCase() === 'DW');
  if (!dw) return null;

  const reason = Number(dw.reason);
  if (!Number.isNaN(reason) && DW_EXCLUSION_CODES.has(reason)) return null;

  const valor = num(dw.value);
  if (valor === null || valor <= 0) return null;
  return valor * 1000;
}

/**
 * Construye las observaciones legibles a partir del consolidado. Es lo que ve
 * el gestor en la card del estudio, asi que se prioriza mora y endeudamiento.
 */
function buildObservaciones(report: DcReport, score: number | null, ingreso: number | null): string {
  const parts: string[] = [];

  parts.push(score !== null ? `Score Advance 1.1: ${score}` : 'Score Advance 1.1 no disponible');

  const p = report.AgregatedInfo?.overview?.PrincipalsAgregatedInfo;
  const b = report.AgregatedInfo?.overview?.BalancesAgregatedInfo;

  const vigentes = num(p?.currentCredits);
  const negativos = num(p?.currentNegativeCredits);
  const negHist12 = num(p?.negativeHistoricalLast12Months);
  if (vigentes !== null) parts.push(`Creditos vigentes: ${vigentes}`);
  if (negativos !== null && negativos > 0) parts.push(`negativos actuales: ${negativos}`);
  if (negHist12 !== null && negHist12 > 0) parts.push(`negativos ult. 12 meses: ${negHist12}`);

  const saldoTotal = num(b?.totaldebtBalance);
  if (saldoTotal !== null) parts.push(`Saldo total: ${formatCOP(saldoTotal)}`);

  const mora30 = num(b?.debtBalanceD30);
  const mora60 = num(b?.debtBalanceD60);
  const mora90 = num(b?.debtBalanceD90);
  const moraMax = Math.max(mora30 ?? 0, mora60 ?? 0, mora90 ?? 0);
  if (moraMax > 0) parts.push(`en mora: ${formatCOP(moraMax)}`);

  const cuota = num(p?.valueMonthlyPayment);
  if (cuota !== null && cuota > 0) parts.push(`Cuota mensual comprometida: ${formatCOP(cuota)}`);

  if (ingreso !== null) parts.push(`Ingreso estimado (Advance Income): ${formatCOP(ingreso)}`);

  const reclamos = num(p?.currentDisputes);
  if (reclamos !== null && reclamos > 0) parts.push(`Reclamos vigentes: ${reclamos}`);

  const alertas = (report.alerts ?? []).map((a) => a.textAlert).filter(Boolean);
  if (alertas.length > 0) parts.push(`Alertas: ${alertas.slice(0, 3).join('; ')}`);

  return parts.join('. ');
}

// ── Provider ────────────────────────────────────────────────

export class DatacreditoProvider implements CreditRiskProvider {
  readonly id = 'datacredito' as const;
  readonly name = 'DataCredito Experian';

  async solicitar(input: ProviderSolicitudInput): Promise<ProviderSolicitudResponse> {
    const creds = assertCredentials();

    if (!input.tipo_documento || !input.numero_documento) {
      throw AppError.badRequest(
        'Tipo y numero de documento son requeridos para consultar DataCredito.',
        'PROVIDER_INVALID_INPUT',
      );
    }

    const personIdType = TIPO_DOCUMENTO_MAP[input.tipo_documento.toLowerCase()];
    if (!personIdType) {
      throw AppError.badRequest(
        `Tipo de documento "${input.tipo_documento}" no soportado por DataCredito. Tipos validos: ${Object.keys(TIPO_DOCUMENTO_MAP).join(', ')}`,
        'PROVIDER_INVALID_DOCUMENT_TYPE',
      );
    }

    // El backend rechaza documentos no numericos con una excepcion Java poco
    // legible; se valida antes para no gastar (y facturar) una consulta.
    const numeroDocumento = input.numero_documento.trim();
    if (!/^\d{1,11}$/.test(numeroDocumento)) {
      throw AppError.badRequest(
        'El numero de documento debe ser numerico y de maximo 11 digitos para consultar DataCredito.',
        'PROVIDER_INVALID_INPUT',
      );
    }

    const primerApellido = (input.primer_apellido?.trim() || derivarPrimerApellido(input.nombre_completo)).slice(0, 80);
    if (!input.primer_apellido && personIdType === 1) {
      logger.warn(
        { provider: this.id, estudioId: input.estudio_id },
        'DataCredito: primer_apellido no vino en el input y se derivo del nombre completo — si no coincide con Registraduria la consulta devolvera codigo 10',
      );
    }

    const body = {
      user: creds.user,
      password: creds.password,
      identifyingTrx: {
        requestUUID: randomUUID(),
        dateTime: fechaConOffsetColombia(),
        originatorChannelName: env.DATACREDITO_CHANNEL_NAME,
        originatorChannelType: env.DATACREDITO_CHANNEL_TYPE,
      },
      identifyingUser: {
        person: {
          personId: {
            personIdNumber: numeroDocumento,
            personIdType,
          },
          personLastName: primerApellido,
        },
      },
    };

    logger.info(
      { provider: this.id, estudioId: input.estudio_id, tipoDoc: input.tipo_documento },
      'DataCredito: iniciando consulta HDC Plus',
    );

    const start = Date.now();

    const response = await withRetry<DcSuccessResponse | DcErrorEnvelope>(
      () => this.executeConsulta(body),
      'DataCredito consultarHDCPlus',
      {
        maxAttempts: 3,
        baseDelayMs: 2000,
        maxDelayMs: 10000,
        backoffFactor: 2,
        // Solo transitorios del proveedor. Los errores de entrada (documento
        // invalido, apellido que no coincide) y los de credenciales no se
        // reintentan: darian el mismo resultado y cada intento puede facturarse.
        shouldRetry: (error) =>
          error instanceof AppError
            ? error.errorCode === 'PROVIDER_UNAVAILABLE'
            : true,
      },
    );

    const elapsed = Date.now() - start;

    // Envelope de plataforma (no trae ReportHDCplus).
    if (!('ReportHDCplus' in response) || !response.ReportHDCplus) {
      const envelope = response as DcErrorEnvelope;
      const err = envelope.errors?.[0];
      const msg = err?.message ?? 'Respuesta sin ReportHDCplus';
      logger.error({ provider: this.id, code: err?.code, msg, elapsed }, 'DataCredito: error de plataforma');
      throw AppError.badRequest(`DataCredito: ${msg}`, 'PROVIDER_ERROR');
    }

    const report = response.ReportHDCplus;
    const codigo = normalizeResponseCode(report.productResult?.responseCode);
    const catalogo = RESPONSE_CODES[codigo];
    const descripcion = catalogo?.mensaje ?? report.productResult?.responseDesc ?? `codigo ${codigo}`;

    // Referencia: el securityCode identifica la transaccion ante DataCredito.
    const referencia = report.productResult?.securityCode || `DC-${Date.now()}`;

    if (!catalogo?.exito) {
      logger.error(
        { provider: this.id, codigo, descripcion, referencia, elapsed },
        `DataCredito: consulta no efectiva (codigo ${codigo})`,
      );

      // Transitorio → PROVIDER_UNAVAILABLE para que el flujo lo muestre como
      // "vuelve a intentar" en vez de como rechazo.
      if (catalogo?.reintentar) {
        throw new AppError(503, 'PROVIDER_UNAVAILABLE', `DataCredito: ${descripcion}`);
      }

      // Documento inexistente o apellido que no concuerda: no es fallo tecnico
      // ni rechazo de credito, es un dato de entrada que no valida.
      if (codigo === '09' || codigo === '10' || codigo === '05' || codigo === '06') {
        throw AppError.badRequest(`DataCredito: ${descripcion}`, 'PROVIDER_SUBJECT_NOT_FOUND');
      }

      // Credenciales / suscripcion.
      if (['01', '02', '12', '16', '17', '18'].includes(codigo)) {
        throw AppError.unauthorized(`DataCredito: ${descripcion}`, 'PROVIDER_AUTH_ERROR');
      }

      throw AppError.badRequest(`DataCredito (codigo ${codigo}): ${descripcion}`, 'PROVIDER_ERROR');
    }

    const { score, resultado, observaciones } = this.parseResult(report, codigo);

    logger.info(
      { provider: this.id, codigo, score, resultado, referencia, elapsed },
      'DataCredito: consulta completada',
    );

    resultCache.set(referencia, {
      referencia_proveedor: referencia,
      score,
      resultado,
      observaciones,
      datos_crudos: response as unknown as Record<string, unknown>,
    });

    return {
      referencia_proveedor: referencia,
      status: 'completed',
      mensaje: score !== null ? `Consulta completada. Score: ${score}` : `Consulta completada (${descripcion})`,
    };
  }

  async consultarEstado(referenciaProveedor: string): Promise<ProviderStatusResponse> {
    // DataCredito es sincrono — si existe la referencia, ya esta completado.
    const cached = resultCache.has(referenciaProveedor);
    return {
      referencia_proveedor: referenciaProveedor,
      status: cached ? 'completed' : 'failed',
      mensaje: cached ? null : 'Referencia no encontrada en cache (consulta sincrona)',
      progreso_porcentaje: cached ? 100 : null,
    };
  }

  async obtenerResultado(referenciaProveedor: string): Promise<ProviderResult> {
    const cached = resultCache.get(referenciaProveedor);
    if (!cached) {
      throw AppError.notFound(
        `Resultado DataCredito no encontrado para referencia ${referenciaProveedor}. La consulta es sincrona y el resultado se obtiene al solicitar.`,
        'PROVIDER_RESULT_NOT_FOUND',
      );
    }
    return cached;
  }

  async cancelar(_referenciaProveedor: string): Promise<{ cancelado: boolean; mensaje: string }> {
    return {
      cancelado: false,
      mensaje: 'DataCredito realiza consultas sincronas, no es posible cancelar una consulta ya completada.',
    };
  }

  async verificarDisponibilidad(): Promise<ProviderHealthInfo> {
    const start = Date.now();
    try {
      // Pedir token es el health check mas barato: no consume una consulta al
      // buro y valida credenciales + conectividad + whitelist de IP.
      await this.obtenerToken(true);
      return {
        proveedor: this.id,
        disponible: true,
        latencia_ms: Date.now() - start,
        ultimo_error: null,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        proveedor: this.id,
        disponible: false,
        latencia_ms: Date.now() - start,
        ultimo_error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      };
    }
  }

  // ── Privados ────────────────────────────────────────────────

  /**
   * Token OAuth2 cacheado en memoria del proceso. El manual no documenta el
   * refresh_token que devuelve el endpoint, asi que no se usa: cuando expira se
   * pide uno nuevo, que es una operacion barata y no facturable.
   */
  private async obtenerToken(forzarNuevo = false): Promise<string> {
    const creds = assertCredentials();

    if (!forzarNuevo && tokenCache && tokenCache.expiresAt > Date.now() + TOKEN_SAFETY_MARGIN_MS) {
      return tokenCache.token;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${baseUrl()}/spla/oauth2/v1/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        },
        body: JSON.stringify({ username: creds.oktaUser, password: creds.oktaPassword }),
        signal: controller.signal,
      });

      const text = await res.text();

      if (!res.ok) {
        // 403 suele ser IP no autorizada (el servicio solo acepta las IPs
        // declaradas a Experian); 401 es credenciales.
        if (res.status === 403) {
          throw AppError.unauthorized(
            'DataCredito: acceso denegado (403). Probablemente la IP de origen no esta en la lista autorizada por Experian.',
            'PROVIDER_AUTH_ERROR',
          );
        }
        if (res.status === 401) {
          throw AppError.unauthorized(
            'DataCredito: credenciales invalidas al solicitar el token.',
            'PROVIDER_AUTH_ERROR',
          );
        }
        if (res.status >= 500) {
          throw new AppError(503, 'PROVIDER_UNAVAILABLE', `DataCredito no disponible al pedir token (HTTP ${res.status})`);
        }
        throw AppError.badRequest(`DataCredito: error al obtener token (HTTP ${res.status})`, 'PROVIDER_ERROR');
      }

      const json = JSON.parse(text) as DcTokenResponse;
      if (!json.access_token) {
        throw AppError.badRequest('DataCredito: la respuesta del token no trae access_token', 'PROVIDER_ERROR');
      }

      const ttl = Number(json.expires_in) || TOKEN_TTL_FALLBACK_S;
      tokenCache = { token: json.access_token, expiresAt: Date.now() + ttl * 1000 };

      logger.info({ provider: 'datacredito', ttl }, 'DataCredito: token obtenido');
      return json.access_token;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw AppError.badRequest(
          `DataCredito: timeout de ${REQUEST_TIMEOUT_MS / 1000}s al obtener el token`,
          'PROVIDER_TIMEOUT',
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Ejecuta la consulta. Si el token fue rechazado (401/403 del servicio, no
   * del token endpoint) lo renueva y reintenta UNA vez — es el unico caso en el
   * que reintentar es gratis y casi siempre resuelve.
   */
  private async executeConsulta(body: Record<string, unknown>): Promise<DcSuccessResponse | DcErrorEnvelope> {
    try {
      return await this.postConsulta(body, await this.obtenerToken());
    } catch (error) {
      if (error instanceof AppError && error.errorCode === 'PROVIDER_TOKEN_REJECTED') {
        logger.warn({ provider: 'datacredito' }, 'DataCredito: token rechazado, renovando y reintentando');
        tokenCache = null;
        return this.postConsulta(body, await this.obtenerToken(true));
      }
      throw error;
    }
  }

  private async postConsulta(
    body: Record<string, unknown>,
    token: string,
  ): Promise<DcSuccessResponse | DcErrorEnvelope> {
    const creds = assertCredentials();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        ProductId: env.DATACREDITO_PRODUCT_ID,
        InfoAccountType: env.DATACREDITO_INFO_ACCOUNT_TYPE,
        Authorization: `Bearer ${token}`,
      };
      // Obligatorio segun el manual; el header admite UNA sola IP.
      if (env.DATACREDITO_SERVER_IP) {
        headers.serverIpAddress = env.DATACREDITO_SERVER_IP;
      }

      const res = await fetch(`${baseUrl()}/cs/credit-history/v1/hdcplus`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          // El manual de HDC usa 401 y el de seguridad 403 para lo mismo.
          throw new AppError(401, 'PROVIDER_TOKEN_REJECTED', `DataCredito: token rechazado (HTTP ${res.status})`);
        }
        if (res.status >= 500) {
          throw new AppError(503, 'PROVIDER_UNAVAILABLE', `DataCredito no disponible (HTTP ${res.status})`);
        }
        throw AppError.badRequest(
          `DataCredito: HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ''}`,
          'PROVIDER_ERROR',
        );
      }

      return JSON.parse(text) as DcSuccessResponse | DcErrorEnvelope;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw AppError.badRequest(
          `DataCredito: timeout de ${REQUEST_TIMEOUT_MS / 1000}s excedido`,
          'PROVIDER_TIMEOUT',
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseResult(
    report: DcReport,
    codigo: string,
  ): {
    score: number | null;
    resultado: 'aprobado' | 'rechazado' | 'condicionado';
    observaciones: string;
  } {
    // Score: Advance Credit Score 1.1 = modelCode 'DF' (Tabla 18). modelCode
    // puede venir numerico o alfanumerico, por eso el String().
    // Verificado en DEMO: cuando el titular no tiene informacion, el modelo DF
    // llega con scoreValue 0 — NO es un score bajo, es ausencia de score. Sin
    // este caso un no bancarizado caeria en la banda de 'rechazado'.
    const modelo = (report.models ?? []).find(
      (m) => String(m.modelCode ?? '').trim().toUpperCase() === 'DF',
    );
    const scoreRaw = num(modelo?.scoreValue);
    const score = scoreRaw === 0 ? null : scoreRaw;

    const ingreso = extraerIngresoDW(report);
    const observaciones = buildObservaciones(report, score, ingreso);

    // Codigo 14 = consulta valida pero sin informacion por este canal
    // (tipicamente persona no bancarizada). Es un desenlace legitimo, no un
    // rechazo: se marca condicionado para que un humano decida.
    if (codigo === '14') {
      return {
        score: null,
        resultado: 'condicionado',
        observaciones:
          'La consulta fue efectiva pero DataCredito no tiene informacion crediticia de esta persona (no bancarizada). No es un rechazo de credito: requiere evaluacion manual con otros soportes.',
      };
    }

    // Sin score no se puede decidir automaticamente: queda en revision manual.
    if (score === null) {
      return {
        score: null,
        resultado: 'condicionado',
        observaciones: `${observaciones}. Requiere revision manual: no se recibio el score Advance 1.1.`,
      };
    }

    return { score, resultado: scoreToResultado(score), observaciones };
  }
}

/**
 * Bandas configurables: los manuales de Experian NO documentan el rango ni la
 * direccion del scoreValue del Advance 1.1, asi que los cortes son
 * provisionales (mismos que TransUnion) hasta que Experian los confirme.
 */
function scoreToResultado(score: number): 'aprobado' | 'rechazado' | 'condicionado' {
  if (score >= env.DATACREDITO_SCORE_MIN_APROBADO) return 'aprobado';
  if (score >= env.DATACREDITO_SCORE_MIN_CONDICIONADO) return 'condicionado';
  return 'rechazado';
}

/** El servicio espera ISO-8601 con offset de Colombia (-05:00). */
function fechaConOffsetColombia(): string {
  const ahora = new Date();
  const bogota = new Date(ahora.getTime() - 5 * 60 * 60 * 1000);
  return `${bogota.toISOString().split('.')[0]}-05:00`;
}

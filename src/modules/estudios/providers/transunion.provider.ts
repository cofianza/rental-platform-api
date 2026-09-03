// ============================================================
// TransUnion Colombia — Combo CreditVision + Info Comercial (1901)
// ============================================================

import { env } from '@/config/env';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { withRetry } from './retry';
import { TRANSUNION_TIMEOUT_MS } from './timeouts';
import type {
  CreditRiskProvider,
  ProviderSolicitudInput,
  ProviderSolicitudResponse,
  ProviderStatusResponse,
  ProviderResult,
  ProviderHealthInfo,
} from './types';

// ── Tipo documento → código TransUnion ──────────────────────
const TIPO_DOCUMENTO_MAP: Record<string, string> = {
  cc: '1',
  nit: '2',
  ce: '3',
  ti: '4',
  pasaporte: '5',
};

// ── Exclusiones CreditVision (no son errores) ───────────────
const EXCLUSION_MESSAGES: Record<number, string> = {
  '-7': 'Titular fallecido o documento no elegible para scoring',
  '-6': 'Tipo de documento no elegible para scoring',
  '-5': 'Titular sin informacion crediticia en activo ni pasivo',
  '-4': 'Titular solo con informacion en el pasivo',
};

// ── Errores conocidos de TransUnion ─────────────────────────
const TU_ERROR_MESSAGES: Record<number, string> = {
  1: 'Numero de identificacion requerido',
  2: 'Tipo de identificacion requerido',
  3: 'Codigo de informacion requerido',
  7: 'Tipo de identificacion no permitido para este combo',
  8: 'Numero de identificacion excede caracteres permitidos',
  13: 'Usuario o contrasena invalidos (GAUS)',
  16: 'Sin privilegios para consultar combo 1901',
  23: 'El tercero consultado no existe en centrales de riesgo',
  29: 'Error interno en TransUnion, intente nuevamente',
  32: 'Error en servicio individual del combo',
  37: 'Numero de identificacion invalido',
};

// Timeout por llamada. Politica de Evaluacion y Score V4.1, seccion 14: "el
// tiempo de espera maximo por respuesta de cada API antes de considerar falla
// es de 8 segundos [...] El timeout debe configurarse en la capa de
// integracion, no en el motor de scoring". Antes eran 60s fijos.
//
// TransUnion hace UNA llamada HTTP por intento, asi que el presupuesto de un
// intento es exactamente el timeout.
//
// El valor NO es la constante de la politica a secas: mientras
// TRANSUNION_API_URL siga apuntando al host UAT (que es lo que hay hoy en
// produccion) el corte de 8s no distingue "buro caido" de "UAT bajo carga", y
// como PROVIDER_TIMEOUT no es reintentable dejaria el modulo inoperante. Lo
// resuelve providers/timeouts.ts; TRANSUNION_REQUEST_TIMEOUT_MS lo fuerza.
const requestTimeoutMs = () => TRANSUNION_TIMEOUT_MS;

// ── Interfaces de respuesta TransUnion ──────────────────────

interface TransUnionVariable {
  nombre: string;
  valor: string;
}

interface TransUnionFechaCorte {
  variables: TransUnionVariable[];
}

interface TransUnionCreditVision {
  fechaCorte?: TransUnionFechaCorte[];
  transactionId?: string;
  resultadoOperacion?: string;
}

interface TransUnionConsolidadoRegistro {
  NumeroObligaciones?: string;
  TotalSaldo?: string;
  SaldoObligacionesMora?: string;
  ValorMora?: string;
}

interface TransUnionConsolidado {
  Registro?: TransUnionConsolidadoRegistro;
  ResumenPrincipal?: TransUnionConsolidadoRegistro[];
}

interface TransUnionInfoComercial {
  Consolidado?: TransUnionConsolidado;
}

interface TransUnionTercero {
  NombreTitular?: string;
  Estado?: string;
  RangoEdad?: string;
}

interface TransUnionSuccessResponse {
  Tercero?: TransUnionTercero;
  CreditVision_5694?: TransUnionCreditVision;
  Informacion_Comercial_154?: TransUnionInfoComercial;
}

interface TransUnionErrorResponse {
  codigo: number;
  mensaje: string;
  idtransaccion?: string;
}

type TransUnionResponse = TransUnionSuccessResponse | TransUnionErrorResponse;

// ── Cache de resultados (TransUnion es síncrono) ────────────
const resultCache = new Map<string, ProviderResult>();

// ── Helper: formato moneda COP ──────────────────────────────
function formatCOP(value: string | number | undefined): string {
  const num = typeof value === 'string' ? parseInt(value, 10) : (value ?? 0);
  if (isNaN(num)) return '$0';
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(num);
}

// ── Helper: determinar resultado según score ────────────────
function scoreToResultado(score: number): 'aprobado' | 'rechazado' | 'condicionado' {
  if (score >= 600) return 'aprobado';
  if (score >= 400) return 'condicionado';
  return 'rechazado';
}

// ── Helper: validar credenciales configuradas ───────────────
function assertCredentials(): { username: string; password: string } {
  const username = env.TRANSUNION_USERNAME;
  const password = env.TRANSUNION_PASSWORD;
  if (!username || !password) {
    throw AppError.badRequest(
      'Credenciales de TransUnion no configuradas. Verifique TRANSUNION_USERNAME y TRANSUNION_PASSWORD.',
      'PROVIDER_NOT_CONFIGURED',
    );
  }
  return { username, password };
}

// ── Helper: construir observaciones legibles ────────────────
function buildObservaciones(
  score: number | null,
  resultado: 'aprobado' | 'rechazado' | 'condicionado',
  infoComercial?: TransUnionInfoComercial,
  exclusionCode?: number,
): string {
  if (exclusionCode !== undefined) {
    const msg = EXCLUSION_MESSAGES[exclusionCode] ?? `Exclusion CreditVision (codigo ${exclusionCode})`;
    return `Score no disponible (codigo ${exclusionCode}): ${msg}`;
  }

  const parts: string[] = [`Score CreditVision: ${score}`];

  const registro = infoComercial?.Consolidado?.Registro;
  if (registro) {
    const obligaciones = registro.NumeroObligaciones ?? '0';
    const saldoMora = registro.SaldoObligacionesMora ?? '0';
    const totalSaldo = registro.TotalSaldo ?? '0';
    const enMora = parseInt(saldoMora, 10) > 0;

    parts.push(`Obligaciones totales: ${obligaciones}`);
    if (enMora) {
      parts.push(`en mora: ${formatCOP(saldoMora)}`);
    }
    parts.push(`Saldo total: ${formatCOP(totalSaldo)}`);
  }

  return parts.join('. ');
}

// ── Provider ────────────────────────────────────────────────

export class TransUnionProvider implements CreditRiskProvider {
  readonly id = 'transunion' as const;
  readonly name = 'TransUnion Colombia';

  async solicitar(input: ProviderSolicitudInput): Promise<ProviderSolicitudResponse> {
    const { username, password } = assertCredentials();

    // Validar datos mínimos
    if (!input.tipo_documento || !input.numero_documento) {
      throw AppError.badRequest(
        'Tipo y numero de documento son requeridos para consultar TransUnion.',
        'PROVIDER_INVALID_INPUT',
      );
    }

    // Mapear tipo documento
    const tipoIdentificacion = TIPO_DOCUMENTO_MAP[input.tipo_documento.toLowerCase()];
    if (!tipoIdentificacion) {
      throw AppError.badRequest(
        `Tipo de documento "${input.tipo_documento}" no soportado por TransUnion. Tipos validos: ${Object.keys(TIPO_DOCUMENTO_MAP).join(', ')}`,
        'PROVIDER_INVALID_DOCUMENT_TYPE',
      );
    }

    const body = {
      codigoInformacion: '1901',
      tipoIdentificacion,
      numeroIdentificacion: input.numero_documento,
      motivoConsulta: env.TRANSUNION_CONSULTA_MOTIVO,
      idPolitica: env.TRANSUNION_POLICY_ID,
      numeroCuenta: '',
      tipoEntidad: '',
      tipoCuenta: '',
      codigoEntidad: '',
    };

    const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');

    logger.info(
      { provider: this.id, estudioId: input.estudio_id, tipoDoc: input.tipo_documento },
      'TransUnion: iniciando consulta Combo 1901',
    );

    const start = Date.now();

    const response = await withRetry<TransUnionResponse>(
      () => this.executeRequest(body, basicAuth),
      'TransUnion consultarCombo',
      {
        // Aritmetica del SLA de 40 s con el timeout de la politica (8 s):
        //   intento 1 (8) + espera (1) + intento 2 (8) + espera (2) + intento 3 (8) = 27 s
        // Quedan ~13 s para parsear, persistir respuesta_proveedor, la RPC de
        // resultado y el orquestador. `deadlineMs` es la garantia dura: si un
        // reintento no cabe, no se intenta — y por eso `attemptBudgetMs` usa el
        // timeout REAL del proveedor, no la constante de la politica: mientras
        // la URL apunte a UAT (45 s por intento) el guard suprime los
        // reintentos, que es lo correcto (no caben en el SLA de ninguna forma).
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 4000,
        backoffFactor: 2,
        deadlineMs: env.BURO_SLA_TOTAL_MS,
        attemptBudgetMs: TRANSUNION_TIMEOUT_MS,
        // Reintentar SOLO errores transitorios del proveedor:
        //  - PROVIDER_UNAVAILABLE: TransUnion caído (5xx/520). El origen erroró
        //    sin procesar, así que reintentar es seguro (no factura doble) y
        //    suele resolver caídas pasajeras.
        //  - errores de red sin respuesta (fetch lanza, no es AppError).
        // NO reintentar: PROVIDER_TIMEOUT (el abort es local; TransUnion pudo
        // procesar y facturar) ni errores 4xx / de credenciales.
        shouldRetry: (error) =>
          error instanceof AppError
            ? error.errorCode === 'PROVIDER_UNAVAILABLE'
            : true,
      },
    );

    const elapsed = Date.now() - start;

    // Detectar error de TransUnion (campo "codigo" en root level)
    if ('codigo' in response && typeof response.codigo === 'number') {
      const errorResp = response as TransUnionErrorResponse;
      const friendlyMsg = TU_ERROR_MESSAGES[errorResp.codigo] ?? errorResp.mensaje;

      logger.error(
        { provider: this.id, codigo: errorResp.codigo, elapsed },
        `TransUnion: error ${errorResp.codigo}`,
      );

      // Auth errors → no reintentar
      if (errorResp.codigo === 13) {
        throw AppError.unauthorized(
          `TransUnion: ${friendlyMsg}`,
          'PROVIDER_AUTH_ERROR',
        );
      }

      // Tercero no existe → no es error del sistema
      if (errorResp.codigo === 23) {
        throw AppError.badRequest(
          `TransUnion: ${friendlyMsg}`,
          'PROVIDER_SUBJECT_NOT_FOUND',
        );
      }

      throw AppError.badRequest(
        `TransUnion (codigo ${errorResp.codigo}): ${friendlyMsg}`,
        'PROVIDER_ERROR',
      );
    }

    // Respuesta exitosa — parsear resultado
    const successResp = response as TransUnionSuccessResponse;
    const { score, resultado, observaciones, referencia, exclusionCode } = this.parseResult(successResp);

    logger.info(
      { provider: this.id, score, resultado, referencia, elapsed },
      'TransUnion: consulta completada',
    );

    // Cachear resultado completo
    const providerResult: ProviderResult = {
      referencia_proveedor: referencia,
      score,
      resultado,
      observaciones,
      datos_crudos: successResp as unknown as Record<string, unknown>,
    };
    resultCache.set(referencia, providerResult);

    return {
      referencia_proveedor: referencia,
      status: 'completed',
      mensaje: exclusionCode !== undefined
        ? `Consulta completada con exclusion CreditVision (codigo ${exclusionCode})`
        : `Consulta completada. Score: ${score}`,
    };
  }

  async consultarEstado(referenciaProveedor: string): Promise<ProviderStatusResponse> {
    // TransUnion es síncrono — si existe la referencia, ya está completado
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
        `Resultado TransUnion no encontrado para referencia ${referenciaProveedor}. La consulta es sincrona y el resultado se obtiene al solicitar.`,
        'PROVIDER_RESULT_NOT_FOUND',
      );
    }
    return cached;
  }

  async cancelar(_referenciaProveedor: string): Promise<{ cancelado: boolean; mensaje: string }> {
    // TransUnion es síncrono — no hay consulta en progreso que cancelar
    return {
      cancelado: false,
      mensaje: 'TransUnion realiza consultas sincronas, no es posible cancelar una consulta ya completada.',
    };
  }

  async verificarDisponibilidad(): Promise<ProviderHealthInfo> {
    const start = Date.now();

    try {
      const { username, password } = assertCredentials();
      const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');

      // Health check: enviar request con documento vacío, esperar error controlado (código 1)
      const body = {
        codigoInformacion: '1901',
        tipoIdentificacion: '1',
        numeroIdentificacion: '',
        motivoConsulta: env.TRANSUNION_CONSULTA_MOTIVO,
        idPolitica: env.TRANSUNION_POLICY_ID,
        numeroCuenta: '',
        tipoEntidad: '',
        tipoCuenta: '',
        codigoEntidad: '',
      };

      await this.executeRequest(body, basicAuth);
      const latencia = Date.now() - start;

      // Cualquier respuesta (incluso error controlado) = servicio disponible
      return {
        proveedor: this.id,
        disponible: true,
        latencia_ms: latencia,
        ultimo_error: null,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const latencia = Date.now() - start;
      const msg = error instanceof Error ? error.message : String(error);

      return {
        proveedor: this.id,
        disponible: false,
        latencia_ms: latencia,
        ultimo_error: msg,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // ── Privados ────────────────────────────────────────────────

  private async executeRequest(body: Record<string, string>, basicAuth: string): Promise<TransUnionResponse> {
    const controller = new AbortController();
    const timeoutMs = requestTimeoutMs();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(env.TRANSUNION_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${basicAuth}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        // 5xx (incluye los 52x de Cloudflare, p.ej. HTTP 520: el origen de
        // TransUnion está caído o respondió algo inválido) → transitorio del
        // lado del proveedor. Lo marcamos como PROVIDER_UNAVAILABLE para que
        // withRetry lo reintente y el estudio muestre un mensaje claro.
        // 4xx → error de la petición; no se reintenta.
        if (res.status >= 500) {
          throw new AppError(
            503,
            'PROVIDER_UNAVAILABLE',
            `TransUnion no disponible (HTTP ${res.status})`,
          );
        }
        throw new Error(`TransUnion HTTP ${res.status}: ${res.statusText || 'sin detalle'}`);
      }

      return await res.json() as TransUnionResponse;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw AppError.badRequest(
          `TransUnion: timeout de ${timeoutMs / 1000}s excedido (limite de la politica, seccion 14)`,
          'PROVIDER_TIMEOUT',
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseResult(response: TransUnionSuccessResponse): {
    score: number | null;
    resultado: 'aprobado' | 'rechazado' | 'condicionado';
    observaciones: string;
    referencia: string;
    exclusionCode?: number;
  } {
    const creditVision = response.CreditVision_5694;
    const infoComercial = response.Informacion_Comercial_154;

    // Extraer transactionId como referencia
    const referencia = creditVision?.transactionId
      ?? `TU-${Date.now()}`;

    // Extraer score de CreditVision
    const variables = creditVision?.fechaCorte?.[0]?.variables ?? [];
    const scoreVar = variables.find((v) => v.nombre === 'CREDITVISION');
    const rawScore = scoreVar ? parseInt(scoreVar.valor, 10) : null;

    // Manejar exclusiones (valores negativos)
    if (rawScore !== null && rawScore < 0) {
      return {
        score: null,
        resultado: 'condicionado',
        observaciones: buildObservaciones(null, 'condicionado', infoComercial, rawScore),
        referencia,
        exclusionCode: rawScore,
      };
    }

    // Score no encontrado en la respuesta
    if (rawScore === null || isNaN(rawScore)) {
      return {
        score: null,
        resultado: 'condicionado',
        observaciones: 'Score CreditVision no disponible en la respuesta. Requiere revision manual.',
        referencia,
      };
    }

    // Score válido → evaluar
    const resultado = scoreToResultado(rawScore);
    const observaciones = buildObservaciones(rawScore, resultado, infoComercial);

    return { score: rawScore, resultado, observaciones, referencia };
  }
}

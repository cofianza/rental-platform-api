// ============================================================
// Tarifas y primas por ruta de aprobacion — Adenda 1 §5 (Gerencia, 07/09/2026)
// ------------------------------------------------------------
// Texto literal:
//
//   5.1 Tarifa mensual de la fianza
//     - Aprobado automatico (85 a 100): 2,0% del canon mensual, mas IVA.
//     - Aprobacion condicionada con coarrendatario (70 a 84 con coarrendatario
//       >= 80): 2,5% del canon mensual, mas IVA.
//     - Aprobado tras revision manual: 2,7% del canon mensual, mas IVA.
//   5.2 Prima de vinculacion
//     - Solicitante que firma solo: 20% del canon mensual, pago unico.
//     - Solicitante con coarrendatario: 10% del canon mensual, pago unico.
//   5.3 Cashback
//     - Al terminar el contrato sin moras: 30% del total de tarifas mensuales
//       efectivamente pagadas. No aplica sobre la prima de vinculacion.
//   Nota: pueden existir condiciones especiales negociadas caso por caso, que
//   se cargan manualmente y no se derivan del score. El sistema debe permitir
//   sobrescribir la tarifa con autorizacion de Gerencia General, dejando
//   registro de quien autorizo y cuando.
//
// Funcion PURA: recibe la via de aprobacion y el canon, devuelve las cifras.
// El override (estudios.tarifa_override) se aplica encima y se marca.
// ============================================================

export type ViaAprobacion = 'automatica' | 'condicionada_coarrendatario' | 'revision_manual';

/** IVA general en Colombia. */
export const IVA_PCT = 19;

export const TARIFA_MENSUAL_PCT: Record<ViaAprobacion, number> = {
  automatica: 2.0,
  condicionada_coarrendatario: 2.5,
  revision_manual: 2.7,
};

export const PRIMA_VINCULACION_PCT = { solo: 20, con_coarrendatario: 10 } as const;
export const CASHBACK_PCT = 30;

export interface TarifaOverride {
  tarifa_mensual_pct?: number;
  prima_vinculacion_pct?: number;
  cashback_pct?: number;
  autorizado_por: string;
  autorizado_en: string;
  motivo?: string | null;
}

export interface EntradaTarifas {
  via: ViaAprobacion;
  conCoarrendatario: boolean;
  canonCop: number | null;
  override?: TarifaOverride | null;
}

export interface Tarifas {
  via: ViaAprobacion;
  con_coarrendatario: boolean;
  tarifa_mensual_pct: number;
  tarifa_mensual_cop: number | null;
  iva_pct: number;
  tarifa_mensual_con_iva_cop: number | null;
  prima_vinculacion_pct: number;
  prima_vinculacion_cop: number | null;
  cashback_pct: number;
  /** true cuando alguna cifra viene de un override autorizado. */
  negociada: boolean;
  override: TarifaOverride | null;
}

const redondear = (n: number) => Math.round(n);

function pctDe(canon: number | null, pct: number): number | null {
  return canon === null ? null : redondear((canon * pct) / 100);
}

export function calcularTarifas(e: EntradaTarifas): Tarifas {
  const o = e.override ?? null;
  const tarifaPct = o?.tarifa_mensual_pct ?? TARIFA_MENSUAL_PCT[e.via];
  const primaPct =
    o?.prima_vinculacion_pct ??
    (e.conCoarrendatario ? PRIMA_VINCULACION_PCT.con_coarrendatario : PRIMA_VINCULACION_PCT.solo);
  const cashbackPct = o?.cashback_pct ?? CASHBACK_PCT;

  const tarifaCop = pctDe(e.canonCop, tarifaPct);
  return {
    via: e.via,
    con_coarrendatario: e.conCoarrendatario,
    tarifa_mensual_pct: tarifaPct,
    tarifa_mensual_cop: tarifaCop,
    iva_pct: IVA_PCT,
    tarifa_mensual_con_iva_cop: tarifaCop === null ? null : redondear(tarifaCop * (1 + IVA_PCT / 100)),
    prima_vinculacion_pct: primaPct,
    prima_vinculacion_cop: pctDe(e.canonCop, primaPct),
    cashback_pct: cashbackPct,
    negociada: !!o && (o.tarifa_mensual_pct != null || o.prima_vinculacion_pct != null || o.cashback_pct != null),
    override: o,
  };
}

/** Lee el JSONB de la fila tolerando null, basura o versiones viejas. */
export function leerTarifaOverride(v: unknown): TarifaOverride | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.autorizado_por !== 'string' || typeof o.autorizado_en !== 'string') return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined);
  return {
    tarifa_mensual_pct: num(o.tarifa_mensual_pct),
    prima_vinculacion_pct: num(o.prima_vinculacion_pct),
    cashback_pct: num(o.cashback_pct),
    autorizado_por: o.autorizado_por,
    autorizado_en: o.autorizado_en,
    motivo: typeof o.motivo === 'string' ? o.motivo : null,
  };
}

/**
 * Via de aprobacion a partir de lo que el sistema sabe del estudio. Es la
 * misma lectura que hace rutas-resultado.ts, reducida a las tres filas de la
 * tabla de tarifas:
 *   - puntaje >= umbral de aprobacion         -> automatica
 *   - zona gris con coarrendatario >= umbral  -> condicionada_coarrendatario
 *   - todo lo demas que termino aprobado      -> revision_manual (un humano
 *     lo aprobo, o el buro aprobo sin puntaje del modelo)
 */
export function viaDeAprobacion(e: {
  puntaje: number | null;
  coarrendatarioVinculado: boolean;
  puntajeCoarrendatario: number | null;
  umbralAprobacion: number;
  umbralZonaGris: number;
  umbralCoarrendatario: number;
}): ViaAprobacion {
  if (e.puntaje !== null && e.puntaje >= e.umbralAprobacion) return 'automatica';
  if (
    e.puntaje !== null &&
    e.puntaje >= e.umbralZonaGris &&
    e.coarrendatarioVinculado &&
    e.puntajeCoarrendatario !== null &&
    e.puntajeCoarrendatario >= e.umbralCoarrendatario
  ) {
    return 'condicionada_coarrendatario';
  }
  return 'revision_manual';
}

/**
 * La via segun lo que el sistema sabe hoy: el puntaje solo cuenta cuando el
 * motor decide (o la ruta usa el scorecard) y los umbrales salen del panel de
 * calibracion. Una sola definicion para el CRC y para GET /estudios/:id/tarifa.
 */
export function viaSegunCalibracion(
  puntaje: number | null,
  conCoarrendatario: boolean,
  cal: { UMBRAL_APROBACION_AUTOMATICA: number; UMBRAL_ZONA_GRIS: number; UMBRAL_COARRENDATARIO: number },
): ViaAprobacion {
  return viaDeAprobacion({
    puntaje,
    coarrendatarioVinculado: conCoarrendatario,
    puntajeCoarrendatario: null,
    umbralAprobacion: cal.UMBRAL_APROBACION_AUTOMATICA,
    umbralZonaGris: cal.UMBRAL_ZONA_GRIS,
    umbralCoarrendatario: cal.UMBRAL_COARRENDATARIO,
  });
}

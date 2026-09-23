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
// Adenda 1 del modulo de contratos §1.1: "La prima y la tarifa causan IVA,
// siempre. En vivienda y en comercial." (la version anterior omitia el de la prima).
//
// Funcion PURA: recibe la via de aprobacion, el canon y el IVA, devuelve las cifras.
// El override (estudios.tarifa_override) se aplica encima y se marca.
// ============================================================

export type ViaAprobacion = 'automatica' | 'condicionada_coarrendatario' | 'revision_manual';

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
  /** Tarifa de IVA vigente (parametro TARIFA_IVA); el llamador la lee de getCalibracion. */
  ivaPct: number;
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
  /** Base, sin IVA. */
  prima_vinculacion_cop: number | null;
  /** Lo que se cobra: la prima mas IVA (Adenda 1 contratos §1.1). */
  prima_vinculacion_con_iva_cop: number | null;
  cashback_pct: number;
  /** true cuando alguna cifra viene de un override autorizado. */
  negociada: boolean;
  override: TarifaOverride | null;
}

const redondear = (n: number) => Math.round(n);

export function pctDe(canon: number | null, pct: number): number | null {
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
  const primaCop = pctDe(e.canonCop, primaPct);
  const conIva = (n: number | null) => (n === null ? null : redondear(n * (1 + e.ivaPct / 100)));
  return {
    via: e.via,
    con_coarrendatario: e.conCoarrendatario,
    tarifa_mensual_pct: tarifaPct,
    tarifa_mensual_cop: tarifaCop,
    iva_pct: e.ivaPct,
    tarifa_mensual_con_iva_cop: conIva(tarifaCop),
    prima_vinculacion_pct: primaPct,
    prima_vinculacion_cop: primaCop,
    prima_vinculacion_con_iva_cop: conIva(primaCop),
    cashback_pct: cashbackPct,
    negociada: !!o && (o.tarifa_mensual_pct != null || o.prima_vinculacion_pct != null || o.cashback_pct != null),
    override: o,
  };
}

/**
 * Las mismas tarifas sobre otro canon. Adenda 1 contratos, respuesta 9: "El
 * porcentaje del certificado es lo que rige; la base es el canon efectivamente
 * pactado", no el evaluado con el que se calcularon.
 */
export function sobreCanon(t: Tarifas, canonCop: number | null): Tarifas {
  return calcularTarifas({ via: t.via, conCoarrendatario: t.con_coarrendatario, canonCop, ivaPct: t.iva_pct, override: t.override });
}

const pctTexto = (n: number, minDecimales: number) =>
  `${n.toLocaleString('es-CO', { minimumFractionDigits: minDecimales, maximumFractionDigits: 2 })}%`;

/**
 * Lo que imprime el contrato V4 (paragrafos tercero y cuarto de la clausula
 * tercera): "...segun la modalidad aprobada: {comision_texto} del canon
 * vigente" y "...equivalente al {prima_texto} del canon mensual". Mismas
 * cifras que el CRC, y las dos con IVA (Adenda 1 contratos §1.1). Sin tarifas
 * (vista previa sin estudio) salen marcadores.
 */
export function textosTarifaContrato(t: Tarifas | null): { comision_texto: string; prima_texto: string } {
  if (!t) return { comision_texto: '[tarifa mensual + IVA]', prima_texto: '[prima de vinculación + IVA]' };
  return {
    comision_texto: `el ${pctTexto(t.tarifa_mensual_pct, 1)} (más IVA)`,
    prima_texto: `${pctTexto(t.prima_vinculacion_pct, 0)} (más IVA)`,
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
 * Adenda 2 §6: "La tarifa depende de la RUTA DE APROBACION, no del numero de
 * centrales consultadas." Se lee de COMO se aprobo, no del puntaje:
 *   - la ponderacion con coarrendatario aprobo a un titular condicionado
 *                                                        -> condicionada_coarrendatario (2,5%)
 *   - el motor decidio (estudios.cascada.via)            -> esa via
 *   - el buro (o el motor) aprobo el estudio sin humano  -> automatica (2,0%)
 *   - lo aprobo una persona: un condicionado aprobado a mano, o un resultado
 *     registrado a mano sin reporte de central            -> revision_manual (2,7%)
 * "Si un caso se aprueba de forma automatica consultando unicamente
 * Datacredito, la tarifa es 2,0%": por eso el puntaje del modelo ya no entra.
 */
export function viaPorRutaDeAprobacion(e: {
  aprobadoPorPonderacion: boolean;
  viaMotor: unknown;
  resultadoEstudio: string | null;
  conReporteDeCentral: boolean;
}): ViaAprobacion {
  if (e.aprobadoPorPonderacion) return 'condicionada_coarrendatario';
  if (e.viaMotor === 'automatica' || e.viaMotor === 'condicionada_coarrendatario' || e.viaMotor === 'revision_manual') {
    return e.viaMotor;
  }
  if (e.resultadoEstudio === 'aprobado' && e.conReporteDeCentral) return 'automatica';
  return 'revision_manual';
}

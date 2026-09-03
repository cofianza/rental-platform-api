// ============================================================
// Motor de scorecard V4.1 — MAPEO A LA FILA (modo sombra)
// ------------------------------------------------------------
// Traduce la salida del motor a las columnas de estudios_scorecard_sombra.
// Es puro a proposito (sin Supabase, sin env): la tabla tiene CHECKs estrechos
// —SMALLINT, BETWEEN 0 AND 24, >= 0— y un valor fuera de rango no falla un
// campo, hace fallar el INSERT entero y se pierde la corrida completa. El
// encuadre tiene que poder probarse sin levantar nada.
//
// dti_pct y canon_ingreso_pct NO se envian: son columnas GENERATED STORED.
// Postgres rechaza un INSERT que intente escribirlas.
// ============================================================

import type { SalidaSombra } from './index';
import type { SectoresCredito } from './features';

/** Encuadra a entero dentro del rango que admite la columna. */
export function entero(valor: number | null, min: number, max: number): number | null {
  if (valor === null || !Number.isFinite(valor)) return null;
  return Math.min(max, Math.max(min, Math.round(valor)));
}

/** Monto NUMERIC(_,2) no negativo. Descarta NaN/Infinity/negativos. */
export function monto(valor: number | null): number | null {
  if (valor === null || !Number.isFinite(valor) || valor < 0) return null;
  return Math.round(valor * 100) / 100;
}

/** Nombres de los sectores con al menos una obligacion. El conteo por sector
 *  va en features_crudas: aqui interesa la PRESENCIA, que es lo que puntua. */
export function sectoresPresentes(sectores: SectoresCredito | null): string[] {
  if (!sectores) return [];
  return (Object.keys(sectores) as (keyof SectoresCredito)[]).filter((k) => sectores[k] > 0);
}

export function construirFilaSombra(estudioId: string, salida: SalidaSombra): Record<string, unknown> {
  const f = salida.features;

  const puntajePorVariable: Record<string, unknown> = {};
  for (const p of salida.puntajes) {
    puntajePorVariable[p.variable] = {
      puntos: p.puntos,
      max: p.puntos_maximos,
      estado: p.estado,
      valor: p.valor,
      banda: p.banda,
      motivo: p.motivo,
      regla_dura: p.reglaDura,
    };
  }

  return {
    estudio_id: estudioId,
    modelo_version: salida.modelo_version,
    fecha_calculo: salida.fecha_evaluacion,

    score_externo: entero(f.score_externo, 0, 2_000_000_000),
    score_externo_modelo: f.score_modelo,

    ingreso_inferido_cop: monto(f.ingreso_mensual_inferido_cop),
    cuota_mensual_cop: monto(f.cuota_mensual_vigente_cop),
    canon_evaluado_cop: monto(salida.canon_evaluado_cop),

    saldo_total_cop: monto(f.saldo_total_cop),
    saldo_mora_cop: monto(f.saldo_mora_cop),
    obligaciones_vigentes: entero(f.obligaciones_vigentes, 0, 32_767),
    obligaciones_negativas: entero(f.obligaciones_negativas, 0, 32_767),
    mora_maxima_dias: entero(f.mora_maxima_dias, 0, 32_767),

    sectores: sectoresPresentes(f.sectores),

    fecha_primera_obligacion: f.fecha_primera_obligacion,
    antiguedad_historial_meses: entero(salida.antiguedad_historial_meses, 0, 2_000_000_000),

    // TransUnion cuenta las moras sumando los slots de todas las obligaciones,
    // que no comparten rejilla: el conteo puede pasarse de 24. Se encuadra.
    meses_con_mora_24m: entero(f.meses_con_mora_24m, 0, 24),
    meses_con_mora_12m: entero(f.meses_con_mora_12m, 0, 12),
    meses_con_mora_6m: entero(f.meses_con_mora_6m, 0, 6),
    ventana_comportamiento_meses: entero(f.meses_observados, 0, 24),

    puntaje_bruto: salida.puntaje_bruto,
    puntaje_normalizado: salida.puntaje_normalizado,
    puntaje_maximo_alcanzable: salida.puntaje_maximo_alcanzable,
    umbral_aprobado: salida.umbral_aprobado,
    umbral_revision: salida.umbral_revision,

    decision_sombra: salida.decision_sombra,
    motivo_no_calculable: salida.motivo_no_calculable,

    reglas_duras_activadas: salida.reglas_duras.map((r) => r.codigo),
    variables_no_calculables: salida.variables_no_calculables,

    puntaje_por_variable: puntajePorVariable,
    features_crudas: {
      ...f.crudas,
      proveedor: salida.proveedor,
      decision_motivo: salida.decision_motivo,
      puntaje_topado: salida.puntaje_topado,
      puntaje_bruto_alcanzable: salida.puntaje_bruto_alcanzable,
      puntaje_bruto_maximo_modelo: salida.puntaje_bruto_maximo_modelo,
      meses_observados: f.meses_observados,
      fecha_corte_datos: f.fecha_corte_datos,
      fecha_consulta_buro: f.fecha_consulta,
      ausencias: f.ausencias,
      advertencias: salida.advertencias,
    },
  };
}

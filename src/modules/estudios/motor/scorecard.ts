// ============================================================
// Motor de scorecard V4.1 — FUNCIONES PURAS (modo sombra)
// ------------------------------------------------------------
// Una funcion por variable de la "Politica de Evaluacion y Aprobacion por
// Score V4.1", mas la normalizacion y la deteccion de reglas duras. Sin
// Supabase, sin env, sin fetch, sin new Date(): todo lo que necesita entra por
// parametro. Es lo que hace que el check de scripts/check-scorecard.ts pueda
// recorrer cada frontera de cada banda sin levantar nada.
//
// MODO SOMBRA: nada de lo que sale de aqui decide un estudio. El resultado
// operativo lo sigue registrando fn_registrar_resultado_estudio con el
// scoreToResultado de cada provider. Este motor solo calcula lo que la
// politica HABRIA dicho, para que Gerencia pueda medir el impacto antes de
// mover un umbral.
//
// ------------------------------------------------------------
// TRES ESTADOS, Y LA DIFERENCIA IMPORTA
//
//   'calculada'        -> hay dato; `puntos` es un numero (0 incluido).
//   'no_calculable'    -> la fuente existe pero el dato no llego; puntos null.
//   'fuera_de_alcance' -> no hay fuente contratada (V4/V7/V9); puntos null.
//
// `puntos: null` NUNCA se suma como 0. Sumar 0 en silencio convierte "no
// sabemos" en "salio mal" y hunde el puntaje de gente sobre la que el buro
// simplemente no reporto — que es exactamente el error que esta tarea existe
// para no cometer.
// ============================================================

import type { FeaturesBuro, SectoresCredito } from './features';

// ── Escala del modelo ───────────────────────────────────────

/** Politica V4.1: 9 variables, 119 puntos brutos, normalizados a 100. */
export const MAX_BRUTO_MODELO = 119;

/**
 * Umbrales de la politica. SE GUARDAN CON CADA CORRIDA y NO se aplican a
 * ninguna decision real: con las fuentes contratadas hoy el techo alcanzable
 * es 80.7 (DataCredito) y 59.7 (TransUnion), asi que exigir 85 rechazaria a
 * toda la cartera.
 */
export const UMBRAL_APROBADO = 85;
export const UMBRAL_REVISION = 70;

export type CodigoVariable = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7' | 'V8' | 'V9';

/**
 * Puntos maximos por variable.
 *
 * V1/V2/V3/V5/V6/V8 estan verificados contra el analisis de brecha: su suma es
 * 96, que normalizada da 80.7 — el techo documentado de DataCredito.
 *
 * V4 (seguridad social/PILA), V7 (estabilidad laboral) y V9 (arrendamiento
 * previo) NO tienen fuente contratada. Su reparto individual (10/8/5) es un
 * Los maximos de las tres variables sin fuente NO son un supuesto: la politica
 * los fija explicitamente en §4.4 (seguridad social, 8 pts), §4.7 (estabilidad
 * laboral, 10 pts) y §4.9 (arrendamiento previo, 5 pts). Su suma es 23, que es
 * lo unico que entra hoy en la aritmetica (119 - 96 calculables).
 */
export const PUNTOS_MAXIMOS: Record<CodigoVariable, number> = {
  V1: 50, // score externo
  V2: 15, // DTI
  V3: 10, // canon / ingreso
  V4: 8,  // seguridad social (PILA) — sin fuente · §4.4
  V5: 6,  // experiencia crediticia
  V6: 10, // comportamiento reciente
  V7: 10, // estabilidad laboral — sin fuente · §4.7
  V8: 5,  // antiguedad del historial
  V9: 5,  // arrendamiento previo — sin fuente
};

/** Variables sin fuente contratada. Fuera de alcance de esta tarea. */
export const VARIABLES_FUERA_DE_ALCANCE: readonly CodigoVariable[] = ['V4', 'V7', 'V9'];

export type EstadoVariable = 'calculada' | 'no_calculable' | 'fuera_de_alcance';

/** Codigos estables de regla dura. Se persisten tal cual, asi que renombrarlos
 *  invalida el historico: agregar si, renombrar no. */
export type CodigoReglaDura =
  | 'score_menor_450'
  | 'dti_mayor_65'
  | 'canon_ingreso_mayor_40'
  | 'mora_vigente'
  | 'mora_mayor_30d_6m';

export interface ResultadoVariable {
  puntos: number | null;
  estado: EstadoVariable;
  /** El valor que se evaluo, para poder auditar el puntaje sin reparsear. */
  valor: number | string | null;
  banda: string | null;
  reglaDura: CodigoReglaDura | null;
  motivo: string | null;
}

export interface PuntajeVariable extends ResultadoVariable {
  variable: CodigoVariable;
  puntos_maximos: number;
}

function calculada(
  puntos: number,
  valor: number | string | null,
  banda: string,
  reglaDura: CodigoReglaDura | null = null,
): ResultadoVariable {
  return { puntos, estado: 'calculada', valor, banda, reglaDura, motivo: null };
}

function noCalculable(motivo: string, valor: number | string | null = null): ResultadoVariable {
  return { puntos: null, estado: 'no_calculable', valor, banda: null, reglaDura: null, motivo };
}

function fueraDeAlcance(motivo: string): ResultadoVariable {
  return { puntos: null, estado: 'fuera_de_alcance', valor: null, banda: null, reglaDura: null, motivo };
}

/**
 * Las tablas de la politica estan escritas con enteros ("26 a 35", "5 a 8
 * anios") y dejan huecos en los reales: un DTI de 25.4 no cae en ninguna fila.
 * Se cierran evaluando por COTA SUPERIOR INCLUSIVA de menor a mayor (para las
 * variables donde menos es mejor) o por cota inferior de mayor a menor (donde
 * mas es mejor). Es una interpretacion, no texto de politica — documentada
 * aqui para que se pueda revisar de un vistazo.
 */
interface Banda {
  corte: number;
  puntos: number;
  etiqueta: string;
}

function bandaPorCotaSuperior(valor: number, tabla: readonly Banda[]): Banda | null {
  for (const b of tabla) {
    if (valor <= b.corte) return b;
  }
  return null;
}

function bandaPorCotaInferior(valor: number, tabla: readonly Banda[]): Banda | null {
  for (const b of tabla) {
    if (valor >= b.corte) return b;
  }
  return null;
}

// ============================================================
// V1 — Score externo del buro (50 pts)
// ============================================================

/**
 * Politica V4.1 §3 "Variable 1 — Score de central de riesgo" (50 pts) y §3.1
 * "jerarquia de decision": por debajo de 450 el caso se rechaza sin importar
 * el resto del scorecard.
 *
 * Ordenada de mayor a menor: gana la primera cota inferior que se cumpla.
 */
export const TABLA_V1: readonly Banda[] = [
  { corte: 800, puntos: 50, etiqueta: '>= 800' },
  { corte: 750, puntos: 47, etiqueta: '750-799' },
  { corte: 700, puntos: 44, etiqueta: '700-749' },
  { corte: 650, puntos: 40, etiqueta: '650-699' },
  { corte: 600, puntos: 34, etiqueta: '600-649' },
  { corte: 550, puntos: 20, etiqueta: '550-599' },
  { corte: 450, puntos: 10, etiqueta: '450-549' },
];

/** Banda de revision manual obligatoria de §3.1: prevalece sobre el puntaje. */
export const V1_REVISION_MANUAL_MIN = 450;
export const V1_REVISION_MANUAL_MAX = 599;
export const V1_RECHAZO_DURO = 450;

export function puntajeV1ScoreExterno(score: number | null): ResultadoVariable {
  if (score === null) {
    return noCalculable('El buro no entrego score (exclusion, sin historia o seccion ausente)');
  }
  if (score < V1_RECHAZO_DURO) {
    // Regla dura: la variable SI se evaluo (puntos 0, estado 'calculada'), lo
    // que cambia es que dispara rechazo. Marcarla 'no_calculable' la sacaria
    // del denominador y haria parecer que faltaba una fuente.
    return calculada(0, score, `< ${V1_RECHAZO_DURO}`, 'score_menor_450');
  }
  const banda = bandaPorCotaInferior(score, TABLA_V1);
  return banda
    ? calculada(banda.puntos, score, banda.etiqueta)
    : noCalculable('Score fuera de toda banda documentada', score);
}

// ============================================================
// V2 — DTI: cuota mensual vigente / ingreso inferido (15 pts)
// ============================================================

/**
 * Politica V4.1 §4.2 "Variable 2 — Capacidad de pago (DTI)" (15 pts).
 * Por encima del 65% es regla dura de rechazo.
 *
 * NOTA — el DTI que se calcula aqui es el del BURO: cuota reportada sobre
 * ingreso inferido. La politica pide sumar tambien la cuota de la fianza, que
 * hoy no esta cotizada en el momento del estudio. Queda documentado en las
 * advertencias en vez de estimarla: un DTI inflado con un supuesto es peor que
 * un DTI honesto y etiquetado.
 */
export const TABLA_V2: readonly Banda[] = [
  { corte: 25, puntos: 15, etiqueta: '<= 25%' },
  { corte: 35, puntos: 12, etiqueta: '26-35%' },
  { corte: 45, puntos: 8, etiqueta: '36-45%' },
  { corte: 55, puntos: 4, etiqueta: '46-55%' },
  { corte: 65, puntos: 2, etiqueta: '56-65%' },
];
export const V2_DTI_MAXIMO = 65;

export function puntajeV2Dti(dtiPct: number | null): ResultadoVariable {
  if (dtiPct === null) {
    return noCalculable('Sin ingreso inferido o sin cuota reportada: el DTI no es calculable');
  }
  if (dtiPct > V2_DTI_MAXIMO) {
    return calculada(0, dtiPct, `> ${V2_DTI_MAXIMO}%`, 'dti_mayor_65');
  }
  const banda = bandaPorCotaSuperior(dtiPct, TABLA_V2);
  return banda
    ? calculada(banda.puntos, dtiPct, banda.etiqueta)
    : noCalculable('DTI fuera de toda banda documentada', dtiPct);
}

// ============================================================
// V3 — Canon / ingreso (10 pts)
// ============================================================

/**
 * Politica V4.1 §4.3 "Variable 3 — Relacion canon / ingreso" (10 pts).
 * Por encima del 40% es regla dura de rechazo.
 */
export const TABLA_V3: readonly Banda[] = [
  { corte: 25, puntos: 10, etiqueta: '<= 25%' },
  { corte: 30, puntos: 7, etiqueta: '26-30%' },
  { corte: 35, puntos: 4, etiqueta: '31-35%' },
  { corte: 40, puntos: 2, etiqueta: '36-40%' },
];
export const V3_CANON_INGRESO_MAXIMO = 40;

export function puntajeV3CanonIngreso(pct: number | null): ResultadoVariable {
  if (pct === null) {
    return noCalculable('Sin ingreso inferido o sin canon del inmueble: la relacion no es calculable');
  }
  if (pct > V3_CANON_INGRESO_MAXIMO) {
    return calculada(0, pct, `> ${V3_CANON_INGRESO_MAXIMO}%`, 'canon_ingreso_mayor_40');
  }
  const banda = bandaPorCotaSuperior(pct, TABLA_V3);
  return banda
    ? calculada(banda.puntos, pct, banda.etiqueta)
    : noCalculable('Relacion canon/ingreso fuera de toda banda documentada', pct);
}

// ============================================================
// V4 / V7 / V9 — sin fuente contratada
// ============================================================

export function puntajeV4SeguridadSocial(): ResultadoVariable {
  return fueraDeAlcance('Sin fuente: no hay integracion PILA / seguridad social');
}

export function puntajeV7EstabilidadLaboral(): ResultadoVariable {
  return fueraDeAlcance('Sin fuente: no hay verificacion de empleador ni antiguedad laboral');
}

export function puntajeV9ArrendamientoPrevio(): ResultadoVariable {
  return fueraDeAlcance('Sin fuente: no hay historial de arrendamiento verificable');
}

// ============================================================
// V5 — Experiencia crediticia (6 pts)
// ============================================================

/**
 * Politica V4.1 §4.5 "Variable 5 — Experiencia crediticia" (6 pts):
 * presencia en sector financiero puntua completo; la presencia solo en sector
 * real o cooperativo puntua parcial.
 *
 * TELCOS no esta tabulado en la politica. DataCredito lo separa como sector
 * propio (10 de las 52 cuentas de la evidencia real). Por defecto NO puntua
 * por si solo — la constante existe para que la decision de Gerencia sea un
 * cambio de una linea y no una reescritura de la funcion.
 */
export const V5_PUNTOS_FINANCIERO = 6;
export const V5_PUNTOS_REAL_O_COOPERATIVO = 4;
export const V5_TELCO_PUNTUA_COMO_REAL = false;

export function puntajeV5Experiencia(
  sectores: SectoresCredito | null,
  sinHistorial: boolean | null,
): ResultadoVariable {
  // "Sin historial" es un hecho conocido, no un dato faltante: puntua 0 pero
  // ENTRA en el denominador. Es la diferencia entre "no tiene credito" y "no
  // sabemos si tiene credito".
  if (sinHistorial === true) {
    return calculada(0, 'sin historial', 'sin historial crediticio');
  }
  if (sectores === null) {
    return noCalculable('El buro no entrego el detalle de obligaciones por sector');
  }
  if (sectores.financiero > 0) {
    return calculada(V5_PUNTOS_FINANCIERO, sectores.financiero, 'con sector financiero');
  }
  if (sectores.real > 0 || sectores.cooperativo > 0) {
    return calculada(
      V5_PUNTOS_REAL_O_COOPERATIVO,
      sectores.real + sectores.cooperativo,
      'solo sector real / cooperativo',
    );
  }
  if (V5_TELCO_PUNTUA_COMO_REAL && sectores.telco > 0) {
    return calculada(V5_PUNTOS_REAL_O_COOPERATIVO, sectores.telco, 'solo telcos (asimilado a real)');
  }
  if (sectores.telco > 0 || sectores.otros > 0) {
    return calculada(0, sectores.telco + sectores.otros, 'solo telcos / otros — no tabulado');
  }
  return calculada(0, 0, 'sin obligaciones');
}

// ============================================================
// V6 — Comportamiento de pago reciente (10 pts)
// ============================================================

/**
 * Politica V4.1 §4.6 "Variable 6 — Comportamiento de pago" (10 pts) y §5
 * "Reglas duras": mora vigente y mora mayor a 30 dias en los ultimos 6 meses
 * rechazan sin importar el puntaje.
 *
 * Los penalizadores (-15 / -5) pueden dejar el bruto total negativo: se
 * absorbe con el piso 0 de `normalizar`, no aqui, para que el detalle por
 * variable siga mostrando la penalizacion real.
 *
 * OJO — la fila de politica "mora entre 1 y 30 dias -> -5" NO es observable en
 * DataCredito: su bucket mas fino es 30-59 dias, asi que todo caracter de mora
 * cae ya en ">30 dias". El extractor deja ese contador en 0 y el motor emite
 * una advertencia; no se inventa una equivalencia.
 */
export const V6_BONO_SIN_MORA_24M = 10;
export const V6_BONO_SIN_HISTORIAL = 5;
export const V6_PENALIZACION_MORA_MAYOR_30D = -15;
export const V6_PENALIZACION_MORA_1_30D = -5;
export const V6_VENTANA_BONO_MESES = 24;

export function puntajeV6Comportamiento(f: FeaturesBuro): ResultadoVariable {
  // 1. Reglas duras primero: son estado, no puntaje.
  if (f.mora_vigente === true) {
    return calculada(0, 'mora vigente', 'mora vigente', 'mora_vigente');
  }
  if ((f.moras_mayor_30d_ultimos_6m ?? 0) > 0) {
    return calculada(
      0,
      f.moras_mayor_30d_ultimos_6m,
      'mora > 30 dias en los ultimos 6 meses',
      'mora_mayor_30d_6m',
    );
  }
  // 2. Sin saber si hay mora vigente no se puede puntuar la variable.
  if (f.mora_vigente === null) {
    return noCalculable('No se pudo determinar el estado de mora vigente');
  }
  // 3. Sin historial: hecho conocido, puntua el bono documentado.
  if (f.sin_historial_crediticio === true) {
    return calculada(V6_BONO_SIN_HISTORIAL, 'sin historial', 'sin historial crediticio');
  }
  // 4. Penalizadores.
  if ((f.moras_mayor_30d_ultimos_12m ?? 0) > 0) {
    return calculada(
      V6_PENALIZACION_MORA_MAYOR_30D,
      f.moras_mayor_30d_ultimos_12m,
      'mora > 30 dias en los ultimos 12 meses',
    );
  }
  if ((f.moras_1_30d_ultimos_12m ?? 0) > 0) {
    return calculada(
      V6_PENALIZACION_MORA_1_30D,
      f.moras_1_30d_ultimos_12m,
      'mora 1-30 dias en los ultimos 12 meses',
    );
  }
  // 5. Bono: exige 24 meses EFECTIVAMENTE observados. Con 10 meses limpios no
  //    se otorga — cero moras sobre 10 meses no es cero moras sobre 24.
  if ((f.meses_observados ?? 0) >= V6_VENTANA_BONO_MESES && (f.meses_con_mora_24m ?? 0) === 0) {
    return calculada(V6_BONO_SIN_MORA_24M, f.meses_observados, `sin mora en ${V6_VENTANA_BONO_MESES} meses`);
  }
  // 6. Ventana completa pero con mora fuera de los 12 meses: la politica no
  //    define bono ni penalizador para ese perfil, asi que son 0 puntos
  //    CALCULADOS. Marcarlo 'no calculable' seria falso — la ventana si se
  //    observo — y ademas topaba el puntaje maximo sin motivo.
  if ((f.meses_observados ?? 0) >= V6_VENTANA_BONO_MESES) {
    return calculada(
      0,
      f.meses_con_mora_24m,
      'mora fuera de la ventana de 12 meses: sin bono ni penalizacion',
    );
  }
  return noCalculable(
    `Ventana insuficiente: se observaron ${f.meses_observados ?? 0} de ${V6_VENTANA_BONO_MESES} meses`,
    f.meses_observados,
  );
}

// ============================================================
// V8 — Antiguedad del historial crediticio (5 pts)
// ============================================================

/**
 * Politica V4.1 §4.8 "Variable 8 — Antiguedad del historial" (5 pts).
 * La politica tabula en anios ("5 a 8 anios"); aqui se trabaja en meses para
 * no perder los casos intermedios (4.5 anios = 54 meses cae en la banda de
 * 2-5 anios). Ordenada de mayor a menor.
 */
export const TABLA_V8: readonly Banda[] = [
  { corte: 97, puntos: 5, etiqueta: '> 8 anios' },
  { corte: 60, puntos: 4, etiqueta: '5-8 anios' },
  { corte: 24, puntos: 3, etiqueta: '2-5 anios' },
  { corte: 6, puntos: 1, etiqueta: '6-24 meses' },
  { corte: 0, puntos: 0, etiqueta: '< 6 meses' },
];

export function puntajeV8Antiguedad(mesesHistorial: number | null): ResultadoVariable {
  if (mesesHistorial === null) {
    return noCalculable('El buro no entrego la fecha de la primera obligacion');
  }
  if (mesesHistorial < 0) {
    return noCalculable('Fecha de primera obligacion posterior al corte de datos', mesesHistorial);
  }
  const banda = bandaPorCotaInferior(mesesHistorial, TABLA_V8);
  return banda
    ? calculada(banda.puntos, mesesHistorial, banda.etiqueta)
    : noCalculable('Antiguedad fuera de toda banda documentada', mesesHistorial);
}

// ============================================================
// Aritmetica del modelo
// ============================================================

/**
 * Meses completos entre dos fechas ISO (YYYY-MM-DD). Devuelve null si alguna
 * no es legible. No usa Date para evitar sorpresas de zona horaria: la
 * aritmetica de calendario sobre YYYY-MM es exacta y determinista.
 */
export function mesesEntre(desdeISO: string | null, hastaISO: string | null): number | null {
  if (!desdeISO || !hastaISO) return null;
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(desdeISO);
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(hastaISO);
  if (!a || !b) return null;
  const meses = (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
  return Number(b[3]) < Number(a[3]) ? meses - 1 : meses;
}

/**
 * Porcentaje EXACTO (sin redondear); null si el denominador falta o es 0.
 *
 * No se redondea aqui a proposito: las bandas y las reglas duras se evaluan
 * sobre el ratio exacto. Redondear antes de comparar mueve de banda a los
 * casos que caen justo sobre un corte — un DTI de 65.04% se veria como 65.0 y
 * escaparia de la regla dura de >65% — y ademas discrepaba de las columnas
 * generadas dti_pct / canon_ingreso_pct, que Postgres calcula con 2 decimales.
 * Para mostrar o persistir, redondear en el borde con porcentajeParaMostrar().
 */
export function porcentaje(numerador: number | null, denominador: number | null): number | null {
  if (numerador === null || denominador === null || denominador <= 0) return null;
  return (numerador / denominador) * 100;
}

/** Redondeo a 2 decimales para casar con las columnas NUMERIC(_,2) de la tabla. */
export function porcentajeParaMostrar(valor: number | null): number | null {
  return valor === null ? null : Math.round(valor * 100) / 100;
}

/** Redondeo half-up a un decimal. Los puntajes son >= 0, asi que half-up
 *  equivale a half-away-from-zero y no hace falta ramificar por signo. */
export function redondear1(valor: number): number {
  return Math.round(valor * 10) / 10;
}

/**
 * Normaliza el bruto a escala 100.
 *
 * Piso 0: los penalizadores de V6 (-15 / -5) pueden superar a los positivos y
 * dejar el bruto negativo. Un puntaje negativo no significa nada en una escala
 * 0-100 y ademas violaria el CHECK de la tabla.
 */
export function normalizar(bruto: number, maxBruto: number = MAX_BRUTO_MODELO): number | null {
  if (!Number.isFinite(bruto) || !Number.isFinite(maxBruto) || maxBruto <= 0) return null;
  return redondear1((Math.max(0, bruto) / maxBruto) * 100);
}

export interface TotalesScorecard {
  /** Suma de las variables 'calculada', con piso 0. */
  puntaje_bruto: number;
  /** 119 menos los maximos de las variables ausentes. Es el techo REAL de esta
   *  corrida: sin el, un 62 normalizado no se puede leer. */
  puntaje_bruto_alcanzable: number;
  puntaje_normalizado: number | null;
  puntaje_maximo_alcanzable: number | null;
  /** true si falto alguna variable. Hoy es true en el 100% de los estudios,
   *  porque V4/V7/V9 no tienen fuente. */
  puntaje_topado: boolean;
  variables_no_calculables: CodigoVariable[];
  reglas_duras: CodigoReglaDura[];
}

/** Agrega los puntajes por variable en los totales del modelo. */
export function totalizar(puntajes: readonly PuntajeVariable[]): TotalesScorecard {
  let bruto = 0;
  let alcanzable = 0;
  const ausentes: CodigoVariable[] = [];
  const reglas: CodigoReglaDura[] = [];

  for (const p of puntajes) {
    if (p.estado === 'calculada' && p.puntos !== null) {
      bruto += p.puntos;
      alcanzable += p.puntos_maximos;
    } else {
      ausentes.push(p.variable);
    }
    if (p.reglaDura && !reglas.includes(p.reglaDura)) reglas.push(p.reglaDura);
  }

  return {
    puntaje_bruto: Math.max(0, bruto),
    puntaje_bruto_alcanzable: alcanzable,
    puntaje_normalizado: alcanzable > 0 ? normalizar(bruto) : null,
    puntaje_maximo_alcanzable: alcanzable > 0 ? normalizar(alcanzable) : null,
    puntaje_topado: ausentes.length > 0,
    variables_no_calculables: ausentes,
    reglas_duras: reglas,
  };
}

export type DecisionSombra = 'aprobado' | 'revision_manual' | 'rechazado' | 'no_calculable';

export interface DecisionCalculada {
  decision: DecisionSombra;
  motivo: string;
}

/**
 * Decision HIPOTETICA. No se aplica en ningun lado: se guarda al lado de la
 * decision real para poder cruzarlas.
 *
 * Jerarquia (politica V4.1 §3.1 + §5):
 *   1. Sin ninguna variable calculable -> no_calculable (sin puntaje que comparar).
 *   2. Alguna regla dura activada      -> rechazado.
 *   3. Score externo en [450, 599]     -> revision manual obligatoria, prevalece
 *                                         sobre el puntaje (§3.1).
 *   4. Comparacion con los umbrales    -> 85 / 70.
 *
 * El paso 4 se ejecuta AUNQUE el puntaje este topado. El diseno previo proponia
 * una cuarta salida 'no concluyente' para ese caso, pero hoy V4/V7/V9 no tienen
 * fuente y el puntaje esta topado en el 100% de los estudios: esa salida
 * vaciaria el cruce y dejaria a Gerencia sin la unica cifra que pidio. En vez
 * de esconder la banda se publica junto a `puntaje_maximo_alcanzable` y a la
 * advertencia correspondiente, que es la informacion que la hace interpretable.
 */
export function decidirSombra(
  totales: TotalesScorecard,
  scoreExterno: number | null,
  umbralAprobado: number = UMBRAL_APROBADO,
  umbralRevision: number = UMBRAL_REVISION,
): DecisionCalculada {
  if (totales.puntaje_normalizado === null) {
    return {
      decision: 'no_calculable',
      motivo: 'Ninguna variable del scorecard resulto calculable con este payload',
    };
  }
  if (totales.reglas_duras.length > 0) {
    return {
      decision: 'rechazado',
      motivo: `Regla dura activada: ${totales.reglas_duras.join(', ')}`,
    };
  }
  if (
    scoreExterno !== null &&
    scoreExterno >= V1_REVISION_MANUAL_MIN &&
    scoreExterno <= V1_REVISION_MANUAL_MAX
  ) {
    return {
      decision: 'revision_manual',
      motivo: `Score externo ${scoreExterno} en la banda de revision manual obligatoria (${V1_REVISION_MANUAL_MIN}-${V1_REVISION_MANUAL_MAX})`,
    };
  }
  const p = totales.puntaje_normalizado;
  if (p >= umbralAprobado) {
    return { decision: 'aprobado', motivo: `Puntaje ${p} >= umbral de aprobacion ${umbralAprobado}` };
  }
  if (p >= umbralRevision) {
    return { decision: 'revision_manual', motivo: `Puntaje ${p} entre ${umbralRevision} y ${umbralAprobado}` };
  }
  return { decision: 'rechazado', motivo: `Puntaje ${p} < umbral de revision ${umbralRevision}` };
}

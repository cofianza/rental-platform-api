// ============================================================
// Motor de scorecard V4.1 — EXTRACTORES DE FEATURES (modo sombra)
// ------------------------------------------------------------
// Traduce la respuesta cruda de cada buro a un vocabulario unico
// (FeaturesBuro) que el scorecard puede puntuar sin saber de que proveedor
// vino. Aqui NO se puntua nada ni se decide nada: solo se lee.
//
// Tres invariantes que este archivo no puede romper:
//
//   1. NUNCA lanza. El motor corre en sombra, despues de que el resultado real
//      ya quedo registrado. Un payload raro devuelve nulls, no una excepcion.
//      Por eso todo acceso al payload pasa por los helpers `obj()` / `arr()`.
//
//   2. Ausencia != cero. DataCredito usa -1 y TransUnion la cadena vacia o un
//      guion para decir "no reporta". Confundirlos con 0 fabrica un DTI de 0%
//      (excelente) sobre una persona de la que no sabemos nada. Cada campo
//      ausente queda anotado en `ausencias` con su motivo.
//
//   3. Las unidades van en el nombre. El bug historico de esta integracion es
//      miles-vs-pesos: `agregatedInfo` viene en MILES de pesos y el detalle de
//      `liabilities`/`creditCard` en PESOS. Todo lo que sale de aqui con
//      sufijo `_cop` esta en PESOS.
//
// Wrapper: DataCredito se cachea CON el envelope `ReportHDCplus`
// (datacredito.provider.ts linea ~501 guarda `response`, no `report`), y
// TransUnion sin envelope. Los extractores toleran ambas formas.
// ============================================================

// ── Vocabulario comun ───────────────────────────────────────

/** Por que falta un dato. 'no_reportado' != 'no_soportado': el primero es una
 *  persona sin ese dato, el segundo es un buro que no vende esa fuente. */
export type MotivoAusencia =
  | 'no_reportado'          // centinela -1, guion, cadena vacia
  | 'no_soportado'          // el proveedor no expone la fuente (TU: ingreso)
  | 'excluido_por_buro'     // DW reason 50-54; exclusion CreditVision -7..-4
  | 'ventana_insuficiente'  // no hay meses suficientes para 24/12/6
  | 'no_parseable'          // llego, pero el codigo no esta documentado
  | 'unidad_sin_verificar'  // llego un monto, pero su escala no esta confirmada
  | 'seccion_ausente';      // la seccion entera no vino en el payload

export interface SectoresCredito {
  financiero: number;
  cooperativo: number;
  real: number;
  telco: number;
  otros: number;
}

export interface FeaturesBuro {
  proveedor: string;
  /** Cuando se consulto el buro (ISO). */
  fecha_consulta: string | null;
  /**
   * Corte de los datos del buro (ISO). Es el ancla de TODAS las ventanas
   * temporales: en la evidencia real el `consultDate` es 2026-08-21 pero el
   * ultimo mes con comportamiento es 2026-05-31 — casi 3 meses de rezago.
   * Anclar en `new Date()` haria que la ventana de 6 meses incluyera meses sin
   * dato y los leyera como limpios.
   */
  fecha_corte_datos: string | null;

  // V1 — score externo
  score_externo: number | null;
  /** Modelo que produjo el score ('DF', 'CREDITVISION', 'PERSISTIDO'). Sin
   *  esta etiqueta los scores de dos buros no son comparables. */
  score_modelo: string | null;

  // V2 / V3 — capacidad de pago (PESOS)
  ingreso_mensual_inferido_cop: number | null;
  cuota_mensual_vigente_cop: number | null;

  // Endeudamiento y mora (PESOS / conteos)
  saldo_total_cop: number | null;
  saldo_mora_cop: number | null;
  obligaciones_vigentes: number | null;
  obligaciones_negativas: number | null;
  mora_maxima_dias: number | null;

  // V5 — experiencia crediticia
  sectores: SectoresCredito | null;
  sin_historial_crediticio: boolean | null;

  // V6 — comportamiento reciente
  mora_vigente: boolean | null;
  /** Meses de comportamiento efectivamente REPORTADOS (no la ventana pedida).
   *  Cero moras sobre 3 meses no es lo mismo que cero moras sobre 24. */
  meses_observados: number | null;
  meses_con_mora_24m: number | null;
  meses_con_mora_12m: number | null;
  meses_con_mora_6m: number | null;
  moras_1_30d_ultimos_12m: number | null;
  moras_mayor_30d_ultimos_12m: number | null;
  moras_mayor_30d_ultimos_6m: number | null;

  // V8 — antiguedad del historial
  fecha_primera_obligacion: string | null;

  /** Motivo por el que cada campo ausente esta ausente. */
  ausencias: Record<string, MotivoAusencia>;
  /** Provenance: rutas usadas, conteos crudos, cadenas de comportamiento.
   *  Permite auditar una cifra sin volver a parsear respuesta_proveedor. */
  crudas: Record<string, unknown>;
}

/** Features vacias — el punto de partida de todo extractor y la respuesta a un
 *  payload que no se puede leer. */
export function featuresVacias(proveedor: string): FeaturesBuro {
  return {
    proveedor,
    fecha_consulta: null,
    fecha_corte_datos: null,
    score_externo: null,
    score_modelo: null,
    ingreso_mensual_inferido_cop: null,
    cuota_mensual_vigente_cop: null,
    saldo_total_cop: null,
    saldo_mora_cop: null,
    obligaciones_vigentes: null,
    obligaciones_negativas: null,
    mora_maxima_dias: null,
    sectores: null,
    sin_historial_crediticio: null,
    mora_vigente: null,
    meses_observados: null,
    meses_con_mora_24m: null,
    meses_con_mora_12m: null,
    meses_con_mora_6m: null,
    moras_1_30d_ultimos_12m: null,
    moras_mayor_30d_ultimos_12m: null,
    moras_mayor_30d_ultimos_6m: null,
    fecha_primera_obligacion: null,
    ausencias: {},
    crudas: {},
  };
}

// ── Helpers de lectura tolerante ────────────────────────────
// Todo acceso al payload pasa por aqui. Son la razon por la que los
// extractores no necesitan try/catch en cada linea.

function obj(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function arr(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  // TransUnion colapsa los arreglos de un solo elemento a objeto (herencia XML).
  if (value !== null && typeof value === 'object') return [value];
  return [];
}

function pick(source: unknown, ...claves: string[]): unknown {
  const o = obj(source);
  if (!o) return undefined;
  for (const clave of claves) {
    if (o[clave] !== undefined && o[clave] !== null) return o[clave];
  }
  return undefined;
}

/**
 * Numero "de verdad". Replica la semantica de `num()` de datacredito.provider:
 * -1 es el centinela de "no reportado", no un valor. Se le suman los
 * centinelas de TransUnion, que es un servicio de origen XML y manda cadena
 * vacia o guion.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const limpio = value.trim();
    if (limpio === '' || limpio === '-' || limpio === '--' || limpio === 'N/A') return null;
    const parsed = Number(limpio.replace(/\./g, '').replace(/,/g, '.'));
    if (Number.isNaN(parsed) || parsed === -1) return null;
    return parsed;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value === -1) return null;
  return value;
}

/** Los agregados del buro vienen en MILES de pesos. */
function milesAPesos(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : n * 1000;
}

function texto(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const limpio = value.trim();
  return limpio === '' || limpio === '-' ? null : limpio;
}

/** ISO (YYYY-MM-DD) tomando solo la parte de fecha; rechaza lo que no valide. */
function fechaISO(value: unknown): string | null {
  const t = texto(value);
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!m) return null;
  const [, y, mes, d] = m;
  const mm = Number(mes);
  const dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${mes}-${d}`;
}

/** TransUnion entrega fechas DD/MM/YYYY, no ISO. */
function fechaDMY(value: unknown): string | null {
  const t = texto(value);
  if (!t) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (!m) return fechaISO(t);
  const [, d, mes, y] = m;
  const mm = Number(mes);
  const dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${mes}-${d}`;
}

function sectoresVacios(): SectoresCredito {
  return { financiero: 0, cooperativo: 0, real: 0, telco: 0, otros: 0 };
}

function totalSectores(s: SectoresCredito): number {
  return s.financiero + s.cooperativo + s.real + s.telco + s.otros;
}

// ============================================================
// DataCredito / Experian — HDC Plus
// ============================================================

/**
 * Alfabeto del vector de comportamiento (Tabla 4 del manual
 * `implementacion_HDC+PN_Rest.pdf`, pags. 22-23, columna "Comport."):
 *   N = al dia · 1 = mora 30-59d · 2 = 60-89d · 3 = 90-119d · 4 = 120d o mas
 *   '-' / espacio = codigo 00 "no disponible"
 *
 * OJO: el bucket mas fino del buro es 30-59 dias. La banda de la politica
 * "mora entre 1 y 30 dias -> -5" NO es observable en DataCredito: todo
 * caracter de mora ya cae en ">30 dias". Se documenta como advertencia en vez
 * de inventar una equivalencia.
 */
const DC_COMPORTAMIENTO_MORA: Record<string, number> = {
  '1': 30,
  '2': 60,
  '3': 90,
  '4': 120,
};
const DC_COMPORTAMIENTO_AL_DIA = 'N';

/** economicSector de DataCredito (verificado en la evidencia del 2026-08-21). */
const DC_SECTOR_MAP: Record<string, keyof SectoresCredito> = {
  '1': 'financiero',
  '2': 'cooperativo',
  '3': 'real',
  '4': 'telco',
};

/** Anexo Advance Income: `reason` 50-54 = ingreso no estimable. Llega con
 *  value 0, que NO significa "gana cero". Mismo set que el provider. */
const DW_EXCLUSION_CODES = new Set([50, 51, 52, 53, 54]);

interface MesComportamiento {
  fecha: string | null;
  /** Dias de mora del peor caso del mes; 0 = al dia; null = no parseable. */
  moraDias: number | null;
}

/**
 * Extrae las features del payload crudo de DataCredito.
 * Tolera el payload con o sin el envelope `ReportHDCplus`.
 * Nunca lanza.
 */
export function extraerFeaturesDataCredito(payload: unknown): FeaturesBuro {
  const f = featuresVacias('datacredito');
  try {
    const raiz = obj(payload);
    if (!raiz) {
      f.ausencias.payload = 'seccion_ausente';
      return f;
    }
    // El provider cachea el envelope completo; filas viejas podrian estar sin el.
    const report = obj(raiz.ReportHDCplus) ?? raiz;

    // ── Fechas ─────────────────────────────────────────────
    const productResult = obj(report.productResult);
    f.fecha_consulta = fechaISO(productResult?.consultDate);

    // ── V1: score Advance 1.1 (modelCode 'DF') ─────────────
    // scoreValue 0 = ausencia de score (persona sin informacion), no un score
    // bajo. Mismo criterio que datacredito.provider.parseResult.
    const modelo = arr(report.models)
      .map(obj)
      .find((m) => m !== null && String(m.modelCode ?? '').trim().toUpperCase() === 'DF');
    const scoreRaw = num(modelo?.scoreValue);
    if (scoreRaw === null || scoreRaw === 0) {
      f.ausencias.score_externo = modelo ? 'excluido_por_buro' : 'seccion_ausente';
    } else {
      f.score_externo = scoreRaw;
      f.score_modelo = 'DF';
    }

    // ── V2/V3: ingreso inferido (Advance Income, productCode 'DW') ──
    // productValueList llega ANIDADO (productValueList[0][n]); .flat() cubre
    // las dos formas.
    const productValues = arr(report.productValueList).flat().map(obj);
    const dw = productValues.find(
      (p) => p !== null && String(p.productCode ?? '').toUpperCase() === 'DW',
    );
    if (!dw) {
      f.ausencias.ingreso_mensual_inferido_cop = 'seccion_ausente';
    } else {
      const reason = Number(dw.reason);
      const valor = num(dw.value);
      if (!Number.isNaN(reason) && DW_EXCLUSION_CODES.has(reason)) {
        f.ausencias.ingreso_mensual_inferido_cop = 'excluido_por_buro';
      } else if (valor === null || valor <= 0) {
        f.ausencias.ingreso_mensual_inferido_cop = 'no_reportado';
      } else {
        // El anexo ordena los tres primeros DW como medio / limite inferior /
        // limite superior, y del cuarto en adelante son ceros de relleno.
        // Se usa el PRIMERO (el estimado medio). Tomar "el menor" daria 0 y
        // dispararia un DTI infinito -> rechazo espurio.
        f.ingreso_mensual_inferido_cop = valor * 1000;
      }
    }

    // ── Consolidado ────────────────────────────────────────
    // El manual documenta 'AgregatedInfo.overview.{Principals,Balances}AgregatedInfo'
    // pero el servicio real devuelve 'agregatedInfo.overview.{principals,balances}'.
    const overview = obj(pick(report, 'agregatedInfo', 'AgregatedInfo'))?.overview;
    const principals = obj(pick(overview, 'principals', 'PrincipalsAgregatedInfo'));
    const balances = obj(pick(overview, 'balances', 'BalancesAgregatedInfo'));

    if (!balances) {
      f.ausencias.cuota_mensual_vigente_cop = 'seccion_ausente';
    } else {
      // valueMonthlyPayment vive en 'balances', no en 'principals', y va en MILES.
      f.cuota_mensual_vigente_cop = milesAPesos(balances.valueMonthlyPayment);
      if (f.cuota_mensual_vigente_cop === null) {
        f.ausencias.cuota_mensual_vigente_cop = 'no_reportado';
      }
      f.saldo_total_cop = milesAPesos(balances.totaldebtBalance);
      // El saldo en mora se toma como el maximo de las cuatro senales, igual
      // que datacredito.provider.ts: hay entidades que dejan
      // totalValueBalanceOverdue en 0 y reportan el vencido solo en los
      // buckets D30/D60/D90. Quedarse con una sola senal lee como limpio un
      // perfil con mora.
      const moras = [
        milesAPesos(balances.totalValueBalanceOverdue),
        milesAPesos(balances.debtBalanceD30),
        milesAPesos(balances.debtBalanceD60),
        milesAPesos(balances.debtBalanceD90),
      ].filter((v): v is number => v !== null);
      f.saldo_mora_cop = moras.length > 0 ? Math.max(...moras) : null;
    }

    f.obligaciones_vigentes = num(principals?.currentCredits);
    f.obligaciones_negativas = num(principals?.currentNegativeCredits);

    // ── V6: mora vigente ───────────────────────────────────
    // Dos senales independientes: conteo de creditos negativos actuales y
    // saldo total en mora. Basta una para marcar mora vigente; si ninguna
    // llego, queda null (desconocido), NO false.
    const saldoMora = f.saldo_mora_cop;
    const negativos = f.obligaciones_negativas;
    if (negativos === null && saldoMora === null) {
      f.mora_vigente = null;
      f.ausencias.mora_vigente = 'no_reportado';
    } else {
      f.mora_vigente = (negativos ?? 0) > 0 || (saldoMora ?? 0) > 0;
    }

    // ── V6: serie mes a mes ────────────────────────────────
    const meses: MesComportamiento[] = arr(obj(pick(overview, 'behavior', 'Behavior'))?.month)
      .map(obj)
      .filter((m): m is Record<string, unknown> => m !== null)
      .map((m) => {
        const marca = String(m.behaviour ?? '').trim().toUpperCase();
        let moraDias: number | null = null;
        if (marca === DC_COMPORTAMIENTO_AL_DIA) moraDias = 0;
        else if (DC_COMPORTAMIENTO_MORA[marca] !== undefined) moraDias = DC_COMPORTAMIENTO_MORA[marca];
        return { fecha: fechaISO(m.behaviourDate), moraDias };
      });

    // Orden descendente por fecha: no se confia en el orden de llegada.
    const ordenados = [...meses].sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? ''));
    f.fecha_corte_datos = ordenados.find((m) => m.fecha !== null)?.fecha ?? f.fecha_consulta;

    if (ordenados.length === 0) {
      f.ausencias.meses_observados = 'seccion_ausente';
    } else {
      const observados = ordenados.filter((m) => m.moraDias !== null);
      f.meses_observados = observados.length;

      const enVentana = (n: number) => ordenados.slice(0, n).filter((m) => m.moraDias !== null);
      const conMora = (v: MesComportamiento[]) => v.filter((m) => (m.moraDias ?? 0) > 0).length;

      f.meses_con_mora_24m = conMora(enVentana(24));
      f.meses_con_mora_12m = conMora(enVentana(12));
      f.meses_con_mora_6m = conMora(enVentana(6));
      // El bucket mas fino de DataCredito es 30-59 dias: una mora de 1-30 dias
      // simplemente no aparece en el vector. Por eso 0 aqui es "el buro no
      // puede reportarlas", no "no las tuvo" — el motor lo advierte.
      f.moras_1_30d_ultimos_12m = 0;
      f.moras_mayor_30d_ultimos_12m = f.meses_con_mora_12m;
      f.moras_mayor_30d_ultimos_6m = f.meses_con_mora_6m;

      const peor = observados.reduce((max, m) => Math.max(max, m.moraDias ?? 0), 0);
      if (peor > 0) f.mora_maxima_dias = peor;
      f.crudas.cadena_comportamiento = ordenados
        .slice(0, 24)
        .map((m) => `${m.fecha ?? '?'}:${m.moraDias === null ? '-' : m.moraDias}`);
    }

    // Respaldo del conteo de negativos historicos cuando el vector no vino.
    const negHist12 = num(principals?.negativeHistoricalLast12Months);
    if (f.moras_mayor_30d_ultimos_12m === null && negHist12 !== null) {
      f.moras_mayor_30d_ultimos_12m = negHist12;
      f.crudas.moras_12m_desde_agregado = true;
    }

    // ── V5: sectores ───────────────────────────────────────
    // Hay que sumar liabilities Y creditCard: leyendo solo liabilities el
    // sector financiero de la evidencia da 3 en vez de 11 (las 8 tarjetas
    // viven en creditCard).
    const cuentas = [...arr(report.liabilities), ...arr(report.creditCard)]
      .map((c) => obj(obj(c)?.account))
      .filter((a): a is Record<string, unknown> => a !== null);

    if (cuentas.length === 0) {
      f.ausencias.sectores = 'seccion_ausente';
      // El consolidado dice si la persona simplemente no tiene historia.
      const cerrados = num(principals?.closedCredits);
      if (f.obligaciones_vigentes !== null || cerrados !== null) {
        f.sin_historial_crediticio = (f.obligaciones_vigentes ?? 0) === 0 && (cerrados ?? 0) === 0;
      }
    } else {
      const s = sectoresVacios();
      for (const cuenta of cuentas) {
        const codigo = String(num(cuenta.economicSector) ?? '');
        const clave = DC_SECTOR_MAP[codigo] ?? 'otros';
        s[clave] += 1;
      }
      f.sectores = s;
      f.sin_historial_crediticio = totalSectores(s) === 0;
      f.crudas.cuentas_por_sector = { ...s, total: cuentas.length };
    }

    // ── V8: antiguedad ─────────────────────────────────────
    // maturationSince es el dato del consolidado; el minimo de
    // accountOpeningDate es el respaldo cuando no viene.
    f.fecha_primera_obligacion = fechaISO(principals?.maturationSince);
    if (f.fecha_primera_obligacion === null) {
      const aperturas = cuentas
        .map((c) => fechaISO(c.accountOpeningDate))
        .filter((d): d is string => d !== null)
        .sort();
      f.fecha_primera_obligacion = aperturas[0] ?? null;
      if (f.fecha_primera_obligacion === null) {
        f.ausencias.fecha_primera_obligacion = 'no_reportado';
      } else {
        f.crudas.primera_obligacion_desde_apertura = true;
      }
    }

    f.crudas.rutas = {
      score: 'models[modelCode=DF].scoreValue',
      ingreso: 'productValueList[].{productCode=DW}.value (miles)',
      cuota: 'agregatedInfo.overview.balances.valueMonthlyPayment (miles)',
      comportamiento: 'agregatedInfo.overview.behavior.month[]',
      sectores: 'liabilities[].account.economicSector + creditCard[].account.economicSector',
      antiguedad: 'agregatedInfo.overview.principals.maturationSince',
    };
  } catch (err) {
    // Blindaje final: el motor corre en sombra y jamas puede propagar un error.
    f.ausencias.extractor = 'no_parseable';
    f.crudas.error_extractor = err instanceof Error ? err.message : String(err);
  }
  return f;
}

// ============================================================
// TransUnion — Combo 1901 (CreditVision + Informacion Comercial)
// ============================================================

/** Codigos de exclusion de CreditVision. Son valores negativos en el campo
 *  `valor` y significan "no scoreable", no "score bajisimo". */
const TU_EXCLUSIONES = new Set([-7, -6, -5, -4]);

/**
 * Sectores de TransUnion: las secciones se llaman `Sector<Nombre>AlDia` /
 * `Sector<Nombre>Mora`.
 *
 * OJO — asimetria conocida entre buros: DataCredito separa TELCOS como sector
 * propio (economicSector 4) y TransUnion los mete dentro de "Sector Real"
 * (en la evidencia, MOVISTAR y COMCEL salen bajo SectorRealAlDia). Se
 * clasifica por la seccion, que es la taxonomia del propio buro, y el detalle
 * de TipoEntidad/LineaCredito queda en `crudas` para poder refinarlo el dia
 * que Gerencia defina si telcos puntua. Inventar aqui un mapa de codigos de
 * entidad no documentado seria peor que dejar la asimetria visible.
 */
const TU_SECTOR_MAP: Record<string, keyof SectoresCredito> = {
  FINANCIERO: 'financiero',
  COOPERATIVO: 'cooperativo',
  SOLIDARIO: 'cooperativo',
  REAL: 'real',
  TELCO: 'telco',
  TELCOS: 'telco',
  TELECOMUNICACIONES: 'telco',
};

/** Alfabeto del vector `Comportamientos`. TransUnion no documenta el juego
 *  completo: 'N' es al dia y los digitos son tramos de mora. Cualquier otro
 *  caracter (la evidencia UAT trae 'R') se cuenta como NO observado, nunca
 *  como limpio. */
const TU_COMPORTAMIENTO_MORA: Record<string, number> = {
  '1': 30,
  '2': 60,
  '3': 90,
  '4': 120,
  '5': 150,
};

/**
 * Extrae las features del payload crudo de TransUnion.
 * Tolera el payload con o sin envelope. Nunca lanza.
 *
 * TransUnion NO entrega ingreso inferido por ningun nodo del combo 1901: V2 y
 * V3 quedan estructuralmente no calculables ('no_soportado'), no en 0.
 */
export function extraerFeaturesTransUnion(payload: unknown): FeaturesBuro {
  const f = featuresVacias('transunion');
  try {
    const raiz = obj(payload);
    if (!raiz) {
      f.ausencias.payload = 'seccion_ausente';
      return f;
    }
    // El provider guarda la respuesta plana; se admite un envelope por si acaso.
    const root = obj(raiz.Informacion_Comercial_154) || obj(raiz.CreditVision_5694) || obj(raiz.Tercero)
      ? raiz
      : (obj(raiz.respuesta) ?? obj(raiz.data) ?? raiz);

    const tercero = obj(root.Tercero);
    const fechaTercero = fechaISO(tercero?.Fecha);

    // ── V1: CreditVision ───────────────────────────────────
    const cv = obj(root.CreditVision_5694);
    const corte = arr(cv?.fechaCorte).map(obj).find((c) => c !== null);
    f.fecha_corte_datos = fechaISO(corte?.valor) ?? fechaTercero;
    f.fecha_consulta = fechaTercero ?? f.fecha_corte_datos;

    const variable = arr(corte?.variables)
      .map(obj)
      .find((v) => v !== null && String(v.nombre ?? '').trim().toUpperCase() === 'CREDITVISION');
    const scoreRaw = num(variable?.valor);
    if (scoreRaw === null) {
      f.ausencias.score_externo = cv ? 'no_reportado' : 'seccion_ausente';
    } else if (TU_EXCLUSIONES.has(scoreRaw) || scoreRaw < 0) {
      f.ausencias.score_externo = 'excluido_por_buro';
      f.crudas.exclusion_creditvision = scoreRaw;
    } else {
      f.score_externo = scoreRaw;
      f.score_modelo = 'CREDITVISION';
    }

    // ── V2/V3: no existe fuente de ingreso en el combo 1901 ──
    f.ausencias.ingreso_mensual_inferido_cop = 'no_soportado';

    // ── Consolidado ────────────────────────────────────────
    const ic = obj(root.Informacion_Comercial_154);
    if (!ic) {
      f.ausencias.consolidado = 'seccion_ausente';
    }
    // TransUnion colapsa los arreglos de un elemento a objeto, asi que Registro
    // puede llegar de las dos formas. arr() normaliza ambas; leerlo solo con
    // obj() descartaba el consolidado entero en silencio cuando venia como
    // arreglo. Se prefiere la fila 'Total' si existe.
    const registrosConsolidado = arr(obj(ic?.Consolidado)?.Registro)
      .map(obj)
      .filter((r): r is Record<string, unknown> => r !== null);
    const registro =
      registrosConsolidado.find(
        (r) => String(r.PaqueteInformacion ?? '').trim().toUpperCase() === 'TOTAL',
      ) ?? registrosConsolidado[0] ?? null;
    if (registro) {
      // Las unidades del consolidado de TransUnion NO estan verificadas contra
      // el manual (la evidencia UAT trae saldos de dos digitos donde DataCredito
      // trae millones). Por eso los montos NO se escriben en las columnas _cop:
      // mezclar dos escalas separadas por ~1000x en la misma columna corrompe
      // cualquier analisis posterior, y es peor que no tener el dato. Los
      // conteos si son unidad-independientes y se usan tal cual.
      f.ausencias.saldo_total_cop = 'unidad_sin_verificar';
      f.ausencias.saldo_mora_cop = 'unidad_sin_verificar';
      f.ausencias.cuota_mensual_vigente_cop = 'unidad_sin_verificar';
      f.obligaciones_vigentes = num(registro.NumeroObligaciones);
      f.obligaciones_negativas = num(registro.CantidadObligacionesMora);
      f.crudas.consolidado_sin_convertir = {
        nota: 'unidad sin verificar contra el manual de TransUnion; no se escribe en columnas _cop',
        TotalSaldo: num(registro.TotalSaldo),
        ValorMora: num(registro.ValorMora) ?? num(registro.SaldoObligacionesMora),
        CuotaObligacionesDia: num(registro.CuotaObligacionesDia),
      };

      // La senal de mora vigente se apoya en los CONTEOS, que no dependen de la
      // unidad, y en el valor crudo solo para saber si es > 0 (comparar contra
      // cero es valido en cualquier escala).
      const valorMoraCrudo = num(registro.ValorMora) ?? num(registro.SaldoObligacionesMora);
      if (f.obligaciones_negativas === null && valorMoraCrudo === null) {
        f.ausencias.mora_vigente = 'no_reportado';
      } else {
        f.mora_vigente = (f.obligaciones_negativas ?? 0) > 0 || (valorMoraCrudo ?? 0) > 0;
      }
    } else {
      f.ausencias.mora_vigente = 'seccion_ausente';
    }

    // ── V5 / V6 / V8: recorrer las secciones Sector<X>{AlDia,Mora} ──
    const sectores = sectoresVacios();
    const aperturas: string[] = [];
    const cadenas: string[] = [];
    const detalleEntidad: Record<string, number> = {};
    let obligaciones = 0;
    let peorMora: number | null = null;

    for (const [clave, valor] of Object.entries(ic ?? {})) {
      const m = /^Sector(.+?)(AlDia|Mora)$/.exec(clave);
      if (!m) continue;
      const nombre = m[1].toUpperCase();
      const destino = TU_SECTOR_MAP[nombre] ?? 'otros';

      for (const rawObligacion of arr(obj(valor)?.Obligacion)) {
        const o = obj(rawObligacion);
        if (!o) continue;
        obligaciones += 1;
        sectores[destino] += 1;

        const apertura = fechaDMY(o.FechaApertura);
        if (apertura) aperturas.push(apertura);

        const linea = texto(o.LineaCredito) ?? texto(o.TipoEntidad);
        if (linea) detalleEntidad[linea] = (detalleEntidad[linea] ?? 0) + 1;

        const moraMax = num(o.MoraMaxima);
        if (moraMax !== null && moraMax > 0) peorMora = Math.max(peorMora ?? 0, moraMax);

        const cadena = texto(o.Comportamientos);
        if (cadena) cadenas.push(cadena);
      }
    }

    if (obligaciones === 0) {
      f.ausencias.sectores = 'seccion_ausente';
    } else {
      f.sectores = sectores;
      f.sin_historial_crediticio = false;
      f.crudas.cuentas_por_sector = { ...sectores, total: obligaciones };
      f.crudas.linea_credito = detalleEntidad;
    }
    if (peorMora !== null) f.mora_maxima_dias = peorMora;

    // ── V6: vector Comportamientos ─────────────────────────
    // Formato: '|N |N |  |...|'. Los slots NO traen fecha y cada obligacion
    // tiene su propia FechaCorte, asi que las rejillas de dos obligaciones no
    // estan alineadas entre si. Consecuencia: solo la pregunta
    // order-independent ("hay alguna mora en lo reportado?") es contestable;
    // las sub-ventanas de 12 y 6 meses quedan no calculables.
    if (cadenas.length === 0) {
      f.ausencias.meses_observados = 'seccion_ausente';
    } else {
      let observadosMax = 0;
      let mesesConMora = 0;
      let hayNoParseable = false;
      for (const cadena of cadenas) {
        const slots = cadena.split('|').slice(1, -1).map((s) => s.trim().toUpperCase());
        let observados = 0;
        for (const slot of slots) {
          if (slot === '') continue;
          if (slot === 'N') {
            observados += 1;
          } else if (TU_COMPORTAMIENTO_MORA[slot] !== undefined) {
            observados += 1;
            mesesConMora += 1;
            peorMora = Math.max(peorMora ?? 0, TU_COMPORTAMIENTO_MORA[slot]);
          } else {
            // Codigo no documentado (la evidencia UAT trae 'R'): no observado,
            // y jamas "limpio".
            hayNoParseable = true;
          }
        }
        observadosMax = Math.max(observadosMax, observados);
      }
      f.meses_observados = observadosMax;
      f.meses_con_mora_24m = mesesConMora;
      // Sin fecha por slot no hay forma de recortar 12 o 6 meses.
      f.ausencias.meses_con_mora_12m = 'no_parseable';
      f.ausencias.meses_con_mora_6m = 'no_parseable';
      // MoraMaxima de TransUnion viene en CUOTAS/periodos (escala 1-9), no en
      // dias, asi que no alimenta mora_maxima_dias: mezclarla con el mapeo del
      // vector Comportamientos (30-150 dias) via Math.max daria un maximo entre
      // dos escalas distintas. Se guarda aparte, sin traducir.
      if (peorMora !== null) f.crudas.mora_maxima_cuotas = peorMora;
      if (hayNoParseable) f.crudas.comportamiento_con_codigos_no_documentados = true;
      f.crudas.cadenas_comportamiento = cadenas;
    }

    // ── V8: antiguedad ─────────────────────────────────────
    aperturas.sort();
    f.fecha_primera_obligacion = aperturas[0] ?? null;
    if (f.fecha_primera_obligacion === null) {
      f.ausencias.fecha_primera_obligacion = 'no_reportado';
    }

    f.crudas.rutas = {
      score: 'CreditVision_5694.fechaCorte[0].variables[nombre=CREDITVISION].valor',
      ingreso: 'NO EXISTE en el combo 1901',
      consolidado: 'Informacion_Comercial_154.Consolidado.Registro',
      sectores: 'Informacion_Comercial_154.Sector<X>{AlDia,Mora}.Obligacion[]',
      antiguedad: 'min(Obligacion[].FechaApertura) DD/MM/YYYY',
    };
  } catch (err) {
    f.ausencias.extractor = 'no_parseable';
    f.crudas.error_extractor = err instanceof Error ? err.message : String(err);
  }
  return f;
}

// ============================================================
// Despacho por proveedor
// ============================================================

/**
 * Elige el extractor por el proveedor del estudio, NO por la forma del
 * objeto: `respuesta_proveedor` guarda DataCredito CON envelope y TransUnion
 * sin el, y adivinar por la forma se rompe el dia que uno de los dos cambie.
 * Un proveedor sin extractor (sifin, manual) devuelve features vacias.
 */
export function extraerFeatures(proveedor: string | null | undefined, payload: unknown): FeaturesBuro {
  const id = String(proveedor ?? '').trim().toLowerCase();
  if (id === 'datacredito') return extraerFeaturesDataCredito(payload);
  if (id === 'transunion') return extraerFeaturesTransUnion(payload);
  const f = featuresVacias(id || 'desconocido');
  f.ausencias.proveedor = 'no_soportado';
  return f;
}

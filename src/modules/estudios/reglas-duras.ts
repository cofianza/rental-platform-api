// ============================================================
// Reglas duras de la Politica de Evaluacion V4.1 — PUNTO DE DECISION REAL
// ------------------------------------------------------------
// Este es el unico archivo del repo donde el motor de scorecard deja de ser
// sombra y DECIDE. Gerencia autorizo activar exactamente DOS reglas de la
// Politica V4.1, literales en sus tablas:
//
//   §4.2 Capacidad de endeudamiento (DTI):  "> 65%  ->  RECHAZO AUTOMATICO"
//   §4.3 Relacion canon / ingreso:          "> 40%  ->  RECHAZO AUTOMATICO"
//
// y §3: "Las reglas duras anulan el puntaje total y generan rechazo automatico
// sin importar cuantos puntos tenga el solicitante en las demas variables".
//
// Caso que lo motivo (produccion, 2026-09-02, estudio fca479e0): score 773 ->
// aprobado automatico, con ingreso inferido 5.094.000, cuota vigente 4.081.000
// (DTI 80.11%) y canon 3.800.000 (canon/ingreso 74.6%). Las dos reglas
// aplicaban y ninguna decidia.
//
// ------------------------------------------------------------
// LO QUE ESTE ARCHIVO **NO** HACE (autorizacion de Gerencia, no omision)
//
//   - SI activa (2026-09-11, Adenda 2 §2) la regla dura de score externo <
//     UMBRAL_SCORE_RECHAZO (450): el corte real pasa de 400 (providers) a
//     450. Salvo con un score capturado a mano (PERSISTIDO): su escala no es
//     la del buro y lo decide el analista que lo registro.
//   - NO activa las reglas de mora (V6) ni las de restitucion.
//   - SI activa (2026-09-07) 'listas_restrictivas' (§6: OFAC/ONU via Auco),
//     pero esa regla SOLO puede dispararse con AUCO_BACKGROUND_CHECK_ENABLED:
//     apagado, nunca hay resumen 'verificado' y la lista blanca no cambia
//     nada. El interruptor ES la autorizacion. Ver antecedentes.ts.
//   - NO toca scoreToResultado ni los umbrales 85/70 del scorecard.
//
// Por eso el filtro no es "cualquier regla dura que traiga el motor" sino la
// lista blanca REGLAS_DURAS_ACTIVAS. El motor sigue calculando las otras y
// guardandolas en el registro sombra: se miden, no deciden.
//
// ------------------------------------------------------------
// LA REGLA MAS IMPORTANTE: NO CALCULABLE != INCUMPLIDA
//
// Si la regla no se puede evaluar por falta de datos, NO se rechaza: el
// estudio sigue el flujo de siempre. Politica §2: "Falla controlada: ante
// indisponibilidad de fuentes de datos, el sistema escala a revision manual —
// nunca rechaza por fallo tecnico"; y §6 pone "ingreso no inferible" en la
// fila de REVISION MANUAL, no en las de rechazo.
//
// Esto no es teorico: TransUnion NO entrega ingreso inferido (el extractor lo
// marca 'no_soportado'), asi que por esa via ninguna de las dos reglas es
// evaluable y TODOS los estudios de TransUnion se comportan exactamente como
// hoy. El mecanismo que lo garantiza esta aguas arriba, en scorecard.ts:
// puntajeV2Dti(null) y puntajeV3CanonIngreso(null) devuelven estado
// 'no_calculable' con reglaDura = null. Aqui solo se filtra lo que SI llego.
//
// ------------------------------------------------------------
// DOS PIEZAS, COMO EN tope-canon.guard.ts
//
//   - aplicarReglasDuras: funcion PURA (salida del motor + resultado propuesto
//     -> veredicto). Es la regla de negocio y es lo que cubre
//     scripts/check-reglas-duras.ts sin levantar Supabase.
//   - resolverResultadoEstudio: resuelve los insumos en Supabase (proveedor,
//     payload, canon), corre el motor, aplica la funcion pura y devuelve lo
//     que hay que mandarle a fn_registrar_resultado_estudio.
//
// NUNCA LANZA. Si algo falla al resolver los insumos, devuelve el resultado
// propuesto tal cual: un rechazo por fallo tecnico seria peor que no aplicar
// la regla (§2).
//
// ------------------------------------------------------------
// INDEPENDENCIA DEL REGISTRO SOMBRA
//
// La decision NO depende de que estudios_scorecard_sombra se haya podido
// escribir. resolverResultadoEstudio corre ANTES del RPC y calcula por su
// cuenta; registrarScorecardSombra corre DESPUES y solo persiste. Si el upsert
// sombra falla, el estudio ya quedo rechazado correctamente. La salida del
// motor se pasa de una a otra unicamente para no evaluar dos veces la misma
// corrida (y para que las dos cuenten exactamente la misma historia).
// ============================================================

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { evaluarSombra } from './motor';
import type { CodigoReglaDura, SalidaSombra } from './motor';
import { V1_RECHAZO_DURO, V2_DTI_MAXIMO, V3_CANON_INGRESO_MAXIMO } from './motor/scorecard';
// §14 / §16.5: lo que NO rechaza pero tampoco deja aprobar en automatico.
import { leerResumenAntecedentes, requiereRevisionManual } from './antecedentes';
import type { ResumenAntecedentes } from './antecedentes';
// Anexo A + §14: la identidad del prospecto tampoco puede quedar sin validar
// para aprobar en automatico. Vive en el modulo de autorizaciones porque el
// cotejo ocurre AHI (pantalla del prospecto), mucho antes de que exista un
// resultado de estudio.
import { leerBiometriaDeExpediente, requiereRevisionManualPorBiometria } from '@/modules/autorizaciones/biometria';
// Adenda §8: el ingreso declarado contrasta con el estimado y puede escalar a
// revision. Vive en autorizaciones porque este arbol no puede nombrarlo.
import { contrasteIngresoProspecto } from '@/modules/autorizaciones/ingreso-declarado';
// Adenda §11: factor de ajuste del ingreso, umbrales y demas parametros vienen
// del panel de calibracion, no de constantes.
import { getCalibracion } from '@/lib/calibracion';
// Politica §15: ningun perfil sin cedula colombiana se aprueba en automatico.
import { motivoRevisionPerfilExtranjero } from './perfil-extranjero';
// El canon se lee con el MISMO helper del guard del tope (§4.4): una sola
// definicion de "cual es el canon de este estudio" para las dos reglas que lo
// usan. Duplicarla dejaria al tope y al scorecard mirando canones distintos.
import { formatearCOP, leerCanonDelInmueble } from './tope-canon.guard';

// ============================================================
// Lista blanca de reglas ACTIVAS
// ============================================================

/**
 * Las unicas reglas duras del motor que hoy deciden. DTI y canon/ingreso
 * autorizadas por Gerencia el 2026-09-03; score < 450 por la Adenda 2 §2.
 * Agregar una aqui es activar una regla en produccion: no se hace sin
 * autorizacion escrita (Politica §1).
 */
export const REGLAS_DURAS_ACTIVAS = ['score_menor_450', 'dti_mayor_65', 'canon_ingreso_mayor_40', 'listas_restrictivas'] as const;

export type ReglaDuraActiva = (typeof REGLAS_DURAS_ACTIVAS)[number];

function esReglaActiva(codigo: CodigoReglaDura): codigo is ReglaDuraActiva {
  return (REGLAS_DURAS_ACTIVAS as readonly string[]).includes(codigo);
}

/** Etiqueta legible por codigo, para el mensaje del gestor. */
const ETIQUETA_REGLA: Record<ReglaDuraActiva, string> = {
  score_menor_450: 'score externo por debajo del minimo',
  dti_mayor_65: 'capacidad de endeudamiento (DTI)',
  canon_ingreso_mayor_40: 'relacion canon / ingreso',
  listas_restrictivas: 'listas restrictivas (OFAC / ONU)',
};

// ============================================================
// Veredicto
// ============================================================

/** Cifras que sostienen el rechazo. Es lo que hace auditable la decision. */
export interface DetalleReglasDuras {
  dti_pct: number | null;
  dti_umbral: number;
  canon_ingreso_pct: number | null;
  canon_ingreso_umbral: number;
  ingreso_mensual_inferido_cop: number | null;
  /** Adenda §1.1: el crudo x FACTOR_AJUSTE_INGRESO. Es el que evaluo la regla. */
  ingreso_mensual_ajustado_cop: number | null;
  factor_ajuste_ingreso: number;
  cuota_mensual_vigente_cop: number | null;
  canon_evaluado_cop: number | null;
  score_externo: number | null;
  /** Adenda 2 §2: corte vigente del score externo (UMBRAL_SCORE_RECHAZO). */
  score_umbral_rechazo: number;
  proveedor: string;
  modelo_version: string;
  /** Solo con 'listas_restrictivas': que lista(s) reporto Auco. */
  listas_vinculantes: { ofac: boolean; onu: boolean } | null;
  /** Codigo del proceso en Auco, para reabrir el reporte. */
  antecedentes_code: string | null;
}

export type VeredictoReglasDuras =
  | {
      rechaza: false;
      /** Siempre vacio en esta rama. Se mantiene para no ramificar al leerlo. */
      reglas: readonly ReglaDuraActiva[];
      /** Resultado que debe persistirse: el propuesto, sin tocar. */
      resultadoFinal: string;
      /** true si el resultado propuesto cambio. Siempre false aqui. */
      cambiaResultado: false;
      motivoGestor: null;
      motivoProspecto: null;
    }
  | {
      rechaza: true;
      /** Las reglas ACTIVAS que se dispararon. Nunca vacio. */
      reglas: readonly ReglaDuraActiva[];
      resultadoFinal: 'rechazado';
      /**
       * false cuando el proveedor ya habia dicho 'rechazado': la regla dura
       * confirma, no cambia. Se distingue para no ensuciar los logs de impacto
       * con rechazos que ya existian.
       */
      cambiaResultado: boolean;
      /** Con cifras y umbrales. Politica §2 "trazabilidad". Solo gestor. */
      motivoGestor: string;
      /** Motivo GENERAL, lenguaje del Flujo §10. Sin parametros del modelo. */
      motivoProspecto: string;
      detalle: DetalleReglasDuras;
    };

export interface EntradaReglasDuras {
  /** Lo que dijo el proveedor (o el gestor en el registro manual). */
  resultadoPropuesto: string;
  /** Salida del motor. Si es null no hay nada que evaluar y no se rechaza. */
  salida: SalidaSombra | null;
  /** Corte del score externo con el que corrio el motor (solo para el motivo). */
  umbralScoreRechazo?: number;
}

// ============================================================
// Mensajes
// ============================================================

/** Porcentaje con dos decimales, o 's/d'. */
function pct(valor: number | null): string {
  return valor === null ? 's/d' : `${valor}%`;
}

/**
 * El ingreso tal como lo vio la regla. Con factor 1 es el crudo; con el factor
 * de la Adenda §1.1 se muestran las dos cifras — el gestor tiene que poder ver
 * que el 40% se evaluo sobre un ingreso ampliado, no sobre el de la central.
 */
function textoIngreso(d: DetalleReglasDuras): string {
  const crudo = d.ingreso_mensual_inferido_cop;
  if (crudo === null) return 'ingreso mensual estimado s/d';
  if (d.factor_ajuste_ingreso === 1 || d.ingreso_mensual_ajustado_cop === null) {
    return `ingreso mensual estimado ${formatearCOP(crudo)}`;
  }
  return `ingreso estimado ${formatearCOP(crudo)} x factor ${d.factor_ajuste_ingreso} = ${formatearCOP(d.ingreso_mensual_ajustado_cop)} (Adenda §1.1)`;
}

/**
 * Prefijo estable del motivo del gestor. Es un MARCADOR, no decoracion: es lo
 * unico que permite reconocer un rechazo por regla dura leyendo solo
 * `estudios.motivo_rechazo` —columna que existe desde siempre— cuando
 * `regla_dura_activada` todavia no existe (migracion sin correr) o su UPDATE
 * best-effort fallo. No cambiarlo sin actualizar inferirReglasDurasDesdeMotivo.
 */
export const PREFIJO_MOTIVO_REGLA_DURA =
  'Rechazo automatico por regla dura de la Politica de Evaluacion V4.1.';

/** Marcadores de seccion del motivo del gestor, uno por regla activa. */
const MARCADOR_SECCION: Record<ReglaDuraActiva, string> = {
  score_menor_450: 'Score externo (§6, Adenda 2 §2):',
  dti_mayor_65: 'Capacidad de endeudamiento (DTI, §4.2):',
  canon_ingreso_mayor_40: 'Relacion canon / ingreso (§4.3):',
  listas_restrictivas: 'Listas restrictivas (§6):',
};

/**
 * Reconstruye las reglas que decidieron a partir del motivo del gestor.
 *
 * RESPALDO, no camino principal: el veredicto se propaga en memoria por el hook
 * post-resultado. Esto cubre los lectores que solo tienen la fila delante (el
 * redactado para el prospecto, el orquestador cuando lo invoca otro camino) y
 * NO depende de ninguna columna nueva.
 *
 * Devuelve [] si el texto no lleva el marcador: cualquier otro motivo (el
 * generico del score bajo, o uno escrito a mano por un gestor) NO es una regla
 * dura y no debe tratarse como tal.
 */
export function inferirReglasDurasDesdeMotivo(
  motivo: string | null | undefined,
): ReglaDuraActiva[] {
  if (!motivo || !motivo.startsWith(PREFIJO_MOTIVO_REGLA_DURA)) return [];
  return REGLAS_DURAS_ACTIVAS.filter((codigo) => motivo.includes(MARCADOR_SECCION[codigo]));
}

/**
 * Que ve el PROSPECTO en lugar del motivo del gestor.
 *
 * Politica §2 ("sin revelar los parametros internos del modelo") y §11
 * ("Cofianza no esta obligada a revelar los parametros internos del modelo ni
 * los puntajes especificos por variable"): el texto del gestor lleva DTI,
 * ingreso inferido, cuota, umbrales y version del modelo, y por eso NO puede
 * viajar en la respuesta que lee el solicitante — ni siquiera si ninguna
 * pantalla lo pinta, porque el JSON se abre con DevTools.
 *
 *   - rechazo por regla dura -> el motivo GENERAL del Flujo §10.
 *   - cualquier otro motivo  -> null. Preferimos no decir nada a afirmar una
 *     causa equivocada: el texto generico del score bajo tampoco es apto para
 *     el prospecto (§13 prohibe la palabra "rechazado" en sus pantallas).
 */
export function motivoParaProspectoDesdeMotivoGestor(
  motivo: string | null | undefined,
): string | null {
  const reglas = inferirReglasDurasDesdeMotivo(motivo);
  return reglas.length > 0 ? motivoProspectoReglasDuras(reglas) : null;
}

/**
 * Motivo para el GESTOR: cifras reales, umbrales aplicados y la mencion
 * explicita de que el puntaje quedo anulado.
 *
 * Politica §2 "Derecho a saber: el solicitante rechazado tiene derecho a
 * conocer el motivo general de la decision, sin revelar los parametros
 * internos del modelo". El gestor NO es el solicitante: a el si se le da el
 * detalle, y por eso este texto viaja a estudios.motivo_rechazo.
 *
 * ESE CAMPO SE LEE POR API, no solo por pantalla: el rol 'solicitante' tiene
 * expedientes:read y GET /expedientes/:id/estudios es justamente lo que
 * consulta su propia tarjeta. Que ninguna pantalla suya lo pinte no basta —
 * con DevTools lo ve. La separacion de audiencias se hace por eso en la capa
 * de servicio (redactarEstudioParaProspecto en estudios.service.ts), que
 * sustituye este texto por motivoParaProspectoDesdeMotivoGestor.
 *
 * NOTA sobre el redondeo: los porcentajes se muestran con los 2 decimales que
 * publica el motor, pero la regla se evaluo sobre el ratio EXACTO. Un DTI de
 * 65.004% dispara la regla y se muestra como "65%": el texto puede verse
 * apretado contra el umbral, la decision no lo esta.
 */
export function motivoGestorReglasDuras(
  reglas: readonly ReglaDuraActiva[],
  d: DetalleReglasDuras,
): string {
  const partes: string[] = [PREFIJO_MOTIVO_REGLA_DURA];

  if (reglas.includes('score_menor_450')) {
    partes.push(
      `Score externo (§6, Adenda 2 §2): ${d.score_externo ?? 's/d'} es menor que el minimo de ${d.score_umbral_rechazo}; ` +
        'rechazo inmediato sin calcular el resto del modelo.',
    );
  }

  if (reglas.includes('dti_mayor_65')) {
    partes.push(
      `Capacidad de endeudamiento (DTI, §4.2): ${pct(d.dti_pct)} supera el maximo de ${d.dti_umbral}% ` +
        `(cuota mensual comprometida ${d.cuota_mensual_vigente_cop === null ? 's/d' : formatearCOP(d.cuota_mensual_vigente_cop)} ` +
        `sobre ${textoIngreso(d)}).`,
    );
  }

  if (reglas.includes('canon_ingreso_mayor_40')) {
    partes.push(
      `Relacion canon / ingreso (§4.3): ${pct(d.canon_ingreso_pct)} supera el maximo de ${d.canon_ingreso_umbral}% ` +
        `(canon ${d.canon_evaluado_cop === null ? 's/d' : formatearCOP(d.canon_evaluado_cop)} ` +
        `sobre ${textoIngreso(d)}).`,
    );
  }

  if (reglas.includes('listas_restrictivas')) {
    const cuales = [
      d.listas_vinculantes?.ofac ? 'OFAC (lista Clinton)' : null,
      d.listas_vinculantes?.onu ? 'ONU' : null,
    ].filter(Boolean).join(' y ') || 'listas vinculantes';
    partes.push(
      `Listas restrictivas (§6): reportado en ${cuales} segun el background check de Auco` +
        `${d.antecedentes_code ? ` (proceso ${d.antecedentes_code})` : ''}.`,
    );
  }

  partes.push(
    d.score_externo === null || reglas.includes('score_menor_450')
      ? 'Las reglas duras anulan el puntaje total (Politica §3).'
      : `Las reglas duras anulan el puntaje total (Politica §3): el score del buro (${d.score_externo}) no cambia esta decision.`,
  );

  partes.push(`Fuente: ${d.proveedor}, modelo ${d.modelo_version}.`);

  return partes.join(' ');
}

/**
 * Motivo GENERAL para el prospecto. Flujo §10 ("No aprobable por ahora […]
 * Nunca es un portazo") y §13 ("Nunca usar la palabra 'rechazado' en ninguna
 * pantalla dirigida al prospecto"). Sin porcentajes, sin umbrales, sin nombres
 * de variables: son parametros internos del modelo que §2 manda no revelar.
 */
export function motivoProspectoReglasDuras(reglas: readonly ReglaDuraActiva[]): string {
  // Listas restrictivas: sin nombrar la lista ni la fuente. Las mejoras de
  // canon/coarrendatario no aplican, asi que el cierre es distinto.
  if (reglas.includes('listas_restrictivas')) {
    return (
      'No aprobable por ahora. Con la informacion disponible hoy, no pudimos completar las verificaciones ' +
      'de identidad y cumplimiento que la ley nos exige para respaldar un contrato. ' +
      'No es una decision definitiva sobre ti: puedes volver a solicitarlo mas adelante o escribirnos para revisar tu caso.'
    );
  }

  // Score bajo: sin nombrar el score ni el corte (§2). La regla dura anula al
  // coarrendatario (§5), asi que no se le ofrece esa salida.
  if (reglas.includes('score_menor_450')) {
    return (
      'No aprobable por ahora. Con la informacion disponible hoy, tu historial en las centrales de riesgo ' +
      'no alcanza el minimo que exige nuestra politica para respaldar un contrato. ' +
      'No es una decision definitiva sobre ti: puedes volver a solicitarlo mas adelante o escribirnos para revisar tu caso.'
    );
  }

  const soloCanon =
    reglas.includes('canon_ingreso_mayor_40') && !reglas.includes('dti_mayor_65');

  const causa = soloCanon
    ? 'el canon de este inmueble representa una parte demasiado alta de los ingresos que pudimos verificar'
    : reglas.includes('canon_ingreso_mayor_40')
      ? 'el canon de este inmueble y los compromisos financieros que ya tienes representan una carga mensual demasiado alta frente a los ingresos que pudimos verificar'
      : 'los compromisos financieros que ya tienes representan una carga mensual demasiado alta frente a los ingresos que pudimos verificar';

  return (
    `No aprobable por ahora. Con la informacion disponible hoy, ${causa}. ` +
    'No es una decision definitiva sobre ti: puedes intentarlo con un inmueble de canon menor, ' +
    'presentar un co-arrendatario o volver a solicitarlo mas adelante.'
  );
}

// ============================================================
// La regla, pura
// ============================================================

/**
 * Convierte la salida del motor en la decision real. Sin Supabase, sin env,
 * sin fecha: mismo insumo, mismo veredicto.
 *
 * Tres formas de NO rechazar, y las tres importan:
 *   1. salida null            -> no hubo corrida del motor.
 *   2. reglas_duras vacio     -> ninguna se disparo, o la variable quedo
 *                                'no_calculable' (sin ingreso, sin canon).
 *   3. solo reglas NO activas -> el motor las mide, pero no deciden todavia.
 */
export function aplicarReglasDuras(entrada: EntradaReglasDuras): VeredictoReglasDuras {
  const { resultadoPropuesto, salida } = entrada;

  const sinRechazo = {
    rechaza: false as const,
    reglas: [] as readonly ReglaDuraActiva[],
    resultadoFinal: resultadoPropuesto,
    cambiaResultado: false as const,
    motivoGestor: null,
    motivoProspecto: null,
  };

  if (!salida) return sinRechazo;

  // Lista blanca: de todas las reglas duras que trae el motor solo pasan las
  // DOS autorizadas. Las demas siguen midiendose en el registro sombra.
  //
  // Se recorre REGLAS_DURAS_ACTIVAS (y no salida.reglas_duras) para que el
  // ORDEN sea el de la politica —DTI §4.2, luego canon/ingreso §4.3— y no el
  // orden en que el motor recorrio las variables: el motivo del gestor y la
  // columna de trazabilidad no deberian cambiar de forma por eso.
  const activadas = new Set<ReglaDuraActiva>(
    salida.reglas_duras.map((r) => r.codigo).filter(esReglaActiva),
  );
  // Un score capturado a mano (PERSISTIDO) no tiene la escala del buro (el
  // motor lo advierte): no dispara el corte de 450, lo decide el analista.
  if (salida.features.score_modelo === 'PERSISTIDO') activadas.delete('score_menor_450');
  const reglas = REGLAS_DURAS_ACTIVAS.filter((codigo) => activadas.has(codigo));

  if (reglas.length === 0) return sinRechazo;

  const detalle: DetalleReglasDuras = {
    dti_pct: salida.dti_pct,
    dti_umbral: V2_DTI_MAXIMO,
    canon_ingreso_pct: salida.canon_ingreso_pct,
    canon_ingreso_umbral: V3_CANON_INGRESO_MAXIMO,
    ingreso_mensual_inferido_cop: salida.features.ingreso_mensual_inferido_cop,
    ingreso_mensual_ajustado_cop: salida.ingreso_inferido_ajustado_cop,
    factor_ajuste_ingreso: salida.factor_ajuste_ingreso,
    cuota_mensual_vigente_cop: salida.features.cuota_mensual_vigente_cop,
    canon_evaluado_cop: salida.canon_evaluado_cop,
    score_externo: salida.features.score_externo,
    score_umbral_rechazo: entrada.umbralScoreRechazo ?? V1_RECHAZO_DURO,
    proveedor: salida.proveedor,
    modelo_version: salida.modelo_version,
    listas_vinculantes: salida.antecedentes?.listas_vinculantes ?? null,
    antecedentes_code: salida.antecedentes?.code ?? null,
  };

  return {
    rechaza: true,
    reglas,
    resultadoFinal: 'rechazado',
    cambiaResultado: resultadoPropuesto !== 'rechazado',
    motivoGestor: motivoGestorReglasDuras(reglas, detalle),
    motivoProspecto: motivoProspectoReglasDuras(reglas),
    detalle,
  };
}

/**
 * Politica §6/§14 y Adenda 2 §3: sin ingreso inferible de NINGUNA fuente no
 * hay aprobacion automatica (no rechaza). Se mira la corrida FINAL —en la
 * cascada la segunda central solo aporta score; el ingreso viene de la
 * primaria—, no cada fuente. Hoy la unica fuente es el estimador de la central
 * (Adenda 1 §1): una corrida solo por TransUnion, que no lo tiene, cae aqui.
 * Solo aplica si se leyo el reporte de una central (la ausencia tiene motivo):
 * el registro manual del analista no trae reporte y no se frena por esto.
 */
export function motivoRevisionIngresoNoInferible(salida: SalidaSombra | null): string | null {
  if (!salida || salida.features.ingreso_mensual_inferido_cop !== null) return null;
  if (!salida.features.ausencias.ingreso_mensual_inferido_cop) return null;
  return 'Revisión manual obligatoria (Política §6/§14, Adenda 2 §3): no se pudo inferir el ingreso de ninguna fuente de esta evaluación.';
}

/** Linea corta para anexar a `observaciones`, que es factual (score, saldos). */
export function notaObservacionesReglasDuras(
  reglas: readonly ReglaDuraActiva[],
  d: DetalleReglasDuras,
): string {
  const trozos = reglas.map((r) =>
    r === 'score_menor_450'
      ? `score externo ${d.score_externo ?? 's/d'} (min ${d.score_umbral_rechazo})`
      : r === 'dti_mayor_65'
        ? `DTI ${pct(d.dti_pct)} (max ${d.dti_umbral}%)`
        : r === 'canon_ingreso_mayor_40'
          ? `canon/ingreso ${pct(d.canon_ingreso_pct)} (max ${d.canon_ingreso_umbral}%)`
          : `listas restrictivas: reportado (${[d.listas_vinculantes?.ofac ? 'OFAC' : null, d.listas_vinculantes?.onu ? 'ONU' : null].filter(Boolean).join('/') || 's/d'})`,
  );
  return `Regla dura V4.1 activada — ${trozos.join('; ')}. Anula el puntaje total (§3).`;
}

// ============================================================
// Resolucion contra Supabase
// ============================================================

export interface ArgsResolverResultado {
  estudioId: string;
  expedienteId: string;
  /** Resultado que el proveedor (o el gestor) quiere registrar. */
  resultadoPropuesto: string;
  /** `estudios.score` a registrar. Respaldo de V1 en el registro manual. */
  score?: number | null;
  /** Observaciones que iban al RPC. Se les anexa la nota de la regla dura. */
  observaciones?: string | null;
  /** motivo_rechazo que iba al RPC. La regla dura lo sustituye si se activa. */
  motivoRechazo?: string | null;
  /** Si no viene, se lee de la fila del estudio. */
  proveedor?: string | null;
  /** `ProviderResult.datos_crudos` en memoria. Evita releer la fila. */
  datosCrudos?: Record<string, unknown> | null;
  /**
   * Resumen del background check de Auco en memoria (camino inline). Si viene
   * `undefined` se lee de `estudios.antecedentes`; `null` significa "ya se, no
   * hay" y no se lee nada.
   */
  antecedentes?: ResumenAntecedentes | null;
  /**
   * Tipo de documento CONSULTADO (§15). `undefined` = leerlo de
   * `datos_formulario` de la fila; el camino inline lo pasa del providerInput.
   */
  tipoDocumento?: string | null;
}

export interface ResolucionEstudio {
  /** Lo que hay que mandarle a fn_registrar_resultado_estudio. */
  resultado: string;
  observaciones: string | null;
  motivoRechazo: string | null;
  veredicto: VeredictoReglasDuras;
  /**
   * §14 / §16.5: motivo por el que un 'aprobado' del buro se registro como
   * 'condicionado' (revision manual). null si no aplico. Es informativo: el
   * resultado ya viene cambiado en `resultado`.
   */
  revisionManual: string | null;
  /**
   * Politica §14 / §9 `apis_fallidas`: fuentes que no respondieron en ESTA
   * evaluacion, con los nombres que usa la Politica ('listas_restrictivas',
   * 'registraduria'). El call site agrega las centrales.
   */
  apisFallidas: string[];
  /**
   * La corrida del motor, para que registrarScorecardSombra persista ESTA y no
   * una segunda evaluacion. null si no se pudo evaluar (y entonces tampoco se
   * rechazo: ver la nota de falla controlada del encabezado).
   */
  salida: SalidaSombra | null;
}

/**
 * Canon del estudio. Reusa el lector del guard del tope (§4.4), que falla
 * CERRADO lanzando: alli tiene sentido (un canon no verificable no puede
 * habilitar un cobro), aqui NO. Un error de lectura aqui solo puede volver
 * la regla V3 no evaluable, que es el lado seguro — rechazar por un timeout
 * de PostgREST seria exactamente el "rechazo por fallo tecnico" que §2
 * prohibe.
 */
/**
 * `estudios.antecedentes` en un SELECT APARTE del de proveedor/payload: si la
 * migracion 20260907000002 no corrio, nombrar la columna falla el SELECT
 * entero (42703) y se perderia la evaluacion de DTI/canon por una columna que
 * no tiene que ver. Aqui el fallo solo deja los antecedentes en null.
 */
async function leerAntecedentesDelEstudio(estudioId: string): Promise<ResumenAntecedentes | null> {
  try {
    const { data, error } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select('antecedentes')
      .eq('id', estudioId)
      .maybeSingle();
    if (error) {
      logger.warn({ estudioId, error: error.message }, 'Reglas duras: no se pudo leer estudios.antecedentes — se evalua sin ellos');
      return null;
    }
    return leerResumenAntecedentes((data as { antecedentes?: unknown } | null)?.antecedentes);
  } catch (err) {
    logger.warn({ estudioId, err: err instanceof Error ? err.message : String(err) }, 'Reglas duras: excepcion leyendo antecedentes');
    return null;
  }
}

export async function canonParaLaRegla(expedienteId: string): Promise<number | null> {
  try {
    const bruto = await leerCanonDelInmueble({ expedienteId });
    const n = typeof bruto === 'string' ? Number(bruto) : bruto;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) {
    logger.warn(
      { expedienteId, err: err instanceof Error ? err.message : String(err) },
      'Reglas duras: no se pudo leer el canon — la regla canon/ingreso queda no evaluable (no rechaza)',
    );
    return null;
  }
}

/**
 * Punto UNICO de decision. Los tres caminos que llaman a
 * fn_registrar_resultado_estudio pasan por aqui ANTES del RPC:
 *   1. registrarResultadoInline   (proveedor sincrono)
 *   2. consultarEstadoProveedor   (polling)
 *   3. registrarResultado         (registro manual del gestor)
 *
 * Nunca lanza: ante cualquier fallo devuelve el resultado propuesto intacto.
 */
export async function resolverResultadoEstudio(
  args: ArgsResolverResultado,
): Promise<ResolucionEstudio> {
  const base: ResolucionEstudio = {
    resultado: args.resultadoPropuesto,
    observaciones: args.observaciones ?? null,
    motivoRechazo: args.motivoRechazo ?? null,
    veredicto: aplicarReglasDuras({ resultadoPropuesto: args.resultadoPropuesto, salida: null }),
    salida: null,
    revisionManual: null,
    apisFallidas: [],
  };

  try {
    // 1. Insumos que no vinieron del call site. El registro manual no tiene ni
    //    proveedor ni payload en scope: se leen de la fila.
    let proveedor = args.proveedor ?? null;
    let payload: unknown = args.datosCrudos ?? null;
    let score = args.score ?? null;
    let tipoDocumento: string | null | undefined = args.tipoDocumento;

    if (!proveedor || !payload || tipoDocumento === undefined) {
      const { data: row } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .select('proveedor, respuesta_proveedor, score, datos_formulario')
        .eq('id', args.estudioId)
        .maybeSingle();
      const est = row as {
        proveedor?: string | null;
        respuesta_proveedor?: Record<string, unknown> | null;
        score?: number | null;
        datos_formulario?: { tipo_documento?: string | null } | null;
      } | null;
      proveedor = proveedor ?? est?.proveedor ?? null;
      payload = payload ?? est?.respuesta_proveedor ?? null;
      score = score ?? est?.score ?? null;
      if (tipoDocumento === undefined) tipoDocumento = est?.datos_formulario?.tipo_documento ?? null;
    }

    // 1b. Antecedentes de Auco: en memoria (inline) o de la columna (polling y
    //     registro manual). Ver leerAntecedentesDelEstudio.
    const antecedentes =
      args.antecedentes !== undefined
        ? args.antecedentes
        : await leerAntecedentesDelEstudio(args.estudioId);

    // 2. Canon congelado de esta corrida + parametros vigentes del panel.
    const canon = await canonParaLaRegla(args.expedienteId);
    const cal = await getCalibracion();

    // 3. Evaluar. evaluarSombra nunca lanza. El factor de ajuste (Adenda §1.1)
    //    entra AQUI, no en el motor: asi cada corrida registra el factor con el
    //    que se decidio.
    const salida = evaluarSombra({
      proveedor,
      payload,
      canon_mensual_cop: canon,
      score_persistido: score,
      antecedentes,
      factor_ajuste_ingreso: cal.FACTOR_AJUSTE_INGRESO,
      umbral_aprobado: cal.UMBRAL_APROBACION_AUTOMATICA,
      umbral_revision: cal.UMBRAL_ZONA_GRIS,
      umbral_score_rechazo: cal.UMBRAL_SCORE_RECHAZO,
      umbral_score_revision: cal.UMBRAL_SCORE_REVISION,
    });

    const veredicto = aplicarReglasDuras({
      resultadoPropuesto: args.resultadoPropuesto,
      salida,
      umbralScoreRechazo: cal.UMBRAL_SCORE_RECHAZO,
    });

    if (!veredicto.rechaza) {
      // §14 ("no aprobar automaticamente sin chequeo de listas") y §16.5
      // (antecedentes = flag de revision manual, nunca rechazo). Solo toca un
      // 'aprobado': lo baja a 'condicionado', que es la revision manual de
      // este sistema (ruta 'en_revision' para el prospecto). Un 'rechazado' o
      // un 'condicionado' del buro solo reciben la nota.
      //
      // DOS fuentes mandan a revision y ninguna anula a la otra: los
      // antecedentes (listas / §16.5) y la identidad (Anexo A / §14). Se
      // acumulan porque el analista tiene que ver las dos razones — quedarse
      // con la primera esconderia la otra.
      const biometria = await leerBiometriaDeExpediente(args.expedienteId);
      // §14 / §9: fuentes que no respondieron, con los nombres de la Politica.
      const apisFallidas = [
        antecedentes?.estado === 'no_verificado' ? 'listas_restrictivas' : null,
        biometria?.estado === 'no_verificada' ? 'registraduria' : null,
      ].filter((a): a is string => !!a);
      const motivos = [
        requiereRevisionManual(antecedentes),
        requiereRevisionManualPorBiometria(biometria),
        // Adenda §8: declarado vs estimado CRUDO de la central.
        await contrasteIngresoProspecto(
          args.expedienteId,
          salida.features.ingreso_mensual_inferido_cop,
          cal.UMBRAL_DIFERENCIA_INGRESO,
        ),
        // Politica §15: sin cedula colombiana no hay aprobacion automatica.
        motivoRevisionPerfilExtranjero(tipoDocumento),
        // Adenda 2 §2: score en la banda 450-599 (o la del panel) -> revision
        // obligatoria. Con los cortes de hoy el buro ya marca condicionado
        // bajo 600; esto cubre que Gerencia suba el tope desde el panel.
        salida.revision_obligatoria,
        // Adenda 2 §3: sin ingreso de ninguna fuente, nada de aprobacion automatica.
        motivoRevisionIngresoNoInferible(salida),
      ].filter((m): m is string => !!m);
      const motivoRevision = motivos.length > 0 ? motivos.join(' ') : null;
      if (!motivoRevision) return { ...base, veredicto, salida, apisFallidas };

      const obs = (args.observaciones ?? '').trim();
      const observaciones = obs ? `${obs} ${motivoRevision}` : motivoRevision;
      const baja = args.resultadoPropuesto === 'aprobado';
      if (baja) {
        logger.warn(
          {
            estudioId: args.estudioId,
            expedienteId: args.expedienteId,
            antecedentes: antecedentes?.estado,
            flags: antecedentes?.flags_revision,
            biometria: biometria?.estado,
            similitud: biometria?.similitud,
          },
          'Auco: el aprobado del buro se registra como CONDICIONADO — revision manual (§14/§16.5/Anexo A)',
        );
      }
      return {
        ...base,
        resultado: baja ? 'condicionado' : args.resultadoPropuesto,
        observaciones,
        veredicto,
        salida,
        revisionManual: motivoRevision,
        apisFallidas,
      };
    }

    const nota = notaObservacionesReglasDuras(veredicto.reglas, veredicto.detalle);
    const observacionesBase = (args.observaciones ?? '').trim();

    logger.warn(
      {
        estudioId: args.estudioId,
        expedienteId: args.expedienteId,
        resultadoPropuesto: args.resultadoPropuesto,
        reglas: veredicto.reglas,
        dtiPct: veredicto.detalle.dti_pct,
        canonIngresoPct: veredicto.detalle.canon_ingreso_pct,
        score: veredicto.detalle.score_externo,
        proveedor: veredicto.detalle.proveedor,
        cambiaResultado: veredicto.cambiaResultado,
      },
      'Regla dura V4.1: el estudio se registra como RECHAZADO pese al score',
    );

    return {
      resultado: 'rechazado',
      observaciones: observacionesBase ? `${observacionesBase} ${nota}` : nota,
      // La regla dura manda sobre cualquier motivo que trajera el call site:
      // es la causa real del rechazo.
      motivoRechazo: veredicto.motivoGestor,
      veredicto,
      salida,
      revisionManual: null,
      apisFallidas: [],
    };
  } catch (err) {
    // Falla controlada (§2): sin veredicto, el estudio sigue el flujo de hoy.
    logger.warn(
      {
        estudioId: args.estudioId,
        expedienteId: args.expedienteId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Reglas duras: no se pudieron evaluar — el estudio se registra con el resultado del proveedor',
    );
    return base;
  }
}

// ============================================================
// Trazabilidad
// ============================================================

/**
 * Deja los codigos de las reglas que decidieron en `estudios.regla_dura_activada`.
 *
 * Va en un UPDATE aparte y no como parametro del RPC a proposito: cambiar la
 * firma de fn_registrar_resultado_estudio obligaria a coordinar el deploy con
 * la migracion, y este dato es trazabilidad, no parte de la transaccion que
 * decide. Mismo patron que `respuesta_proveedor` en estudios.service.ts.
 *
 * Best-effort, y NADA aguas abajo depende de que funcione: la columna es para
 * la medicion agregada que pidio Gerencia (un GROUP BY sobre unnest), no para
 * que el orquestador se entere. El veredicto viaja EN MEMORIA por el hook
 * post-resultado, y su respaldo es el marcador de `motivo_rechazo`. Si la
 * migracion 20260903000004 todavia no corrio, el UPDATE falla, se registra un
 * warning y el estudio queda igual de rechazado, con los mismos textos.
 *
 * Se AWAITEA en los call sites (no fire-and-forget) para no dejar un UPDATE
 * suelto compitiendo con el resto del cierre del estudio.
 */
export async function registrarReglaDuraActivada(
  estudioId: string,
  veredicto: VeredictoReglasDuras,
): Promise<void> {
  if (!veredicto.rechaza) return;
  try {
    const { error } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({ regla_dura_activada: veredicto.reglas as unknown } as never)
      .eq('id', estudioId);
    if (error) {
      logger.warn(
        { estudioId, error: error.message, reglas: veredicto.reglas },
        'No se pudo persistir regla_dura_activada — el rechazo queda igual, con su motivo en motivo_rechazo',
      );
    }
  } catch (err) {
    logger.warn(
      { estudioId, err: err instanceof Error ? err.message : String(err) },
      'No se pudo persistir regla_dura_activada (excepcion)',
    );
  }
}

/** Etiqueta legible de un codigo, para los mensajes del gestor aguas abajo. */
export function etiquetaReglaDura(codigo: string): string {
  return ETIQUETA_REGLA[codigo as ReglaDuraActiva] ?? codigo;
}

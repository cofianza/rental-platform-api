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
//   - NO activa la regla dura de score < 450 (moveria el corte 400 -> 450 de
//     los providers, que Gerencia todavia no autorizo).
//   - NO activa las reglas de mora (V6), ni las de restitucion, ni listas.
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
import { V2_DTI_MAXIMO, V3_CANON_INGRESO_MAXIMO } from './motor/scorecard';
// El canon se lee con el MISMO helper del guard del tope (§4.4): una sola
// definicion de "cual es el canon de este estudio" para las dos reglas que lo
// usan. Duplicarla dejaria al tope y al scorecard mirando canones distintos.
import { formatearCOP, leerCanonDelInmueble } from './tope-canon.guard';

// ============================================================
// Lista blanca de reglas ACTIVAS
// ============================================================

/**
 * Las unicas reglas duras del motor que hoy deciden. Autorizadas por Gerencia
 * el 2026-09-03. Agregar una aqui es activar una regla en produccion: no se
 * hace sin autorizacion escrita (Politica §1).
 */
export const REGLAS_DURAS_ACTIVAS = ['dti_mayor_65', 'canon_ingreso_mayor_40'] as const;

export type ReglaDuraActiva = (typeof REGLAS_DURAS_ACTIVAS)[number];

function esReglaActiva(codigo: CodigoReglaDura): codigo is ReglaDuraActiva {
  return (REGLAS_DURAS_ACTIVAS as readonly string[]).includes(codigo);
}

/** Etiqueta legible por codigo, para el mensaje del gestor. */
const ETIQUETA_REGLA: Record<ReglaDuraActiva, string> = {
  dti_mayor_65: 'capacidad de endeudamiento (DTI)',
  canon_ingreso_mayor_40: 'relacion canon / ingreso',
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
  cuota_mensual_vigente_cop: number | null;
  canon_evaluado_cop: number | null;
  score_externo: number | null;
  proveedor: string;
  modelo_version: string;
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
}

// ============================================================
// Mensajes
// ============================================================

/** Porcentaje con dos decimales, o 's/d'. */
function pct(valor: number | null): string {
  return valor === null ? 's/d' : `${valor}%`;
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
  dti_mayor_65: 'Capacidad de endeudamiento (DTI, §4.2):',
  canon_ingreso_mayor_40: 'Relacion canon / ingreso (§4.3):',
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

  if (reglas.includes('dti_mayor_65')) {
    partes.push(
      `Capacidad de endeudamiento (DTI, §4.2): ${pct(d.dti_pct)} supera el maximo de ${d.dti_umbral}% ` +
        `(cuota mensual comprometida ${d.cuota_mensual_vigente_cop === null ? 's/d' : formatearCOP(d.cuota_mensual_vigente_cop)} ` +
        `sobre ingreso mensual inferido ${d.ingreso_mensual_inferido_cop === null ? 's/d' : formatearCOP(d.ingreso_mensual_inferido_cop)}).`,
    );
  }

  if (reglas.includes('canon_ingreso_mayor_40')) {
    partes.push(
      `Relacion canon / ingreso (§4.3): ${pct(d.canon_ingreso_pct)} supera el maximo de ${d.canon_ingreso_umbral}% ` +
        `(canon ${d.canon_evaluado_cop === null ? 's/d' : formatearCOP(d.canon_evaluado_cop)} ` +
        `sobre ingreso mensual inferido ${d.ingreso_mensual_inferido_cop === null ? 's/d' : formatearCOP(d.ingreso_mensual_inferido_cop)}).`,
    );
  }

  partes.push(
    d.score_externo === null
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
  const reglas = REGLAS_DURAS_ACTIVAS.filter((codigo) => activadas.has(codigo));

  if (reglas.length === 0) return sinRechazo;

  const detalle: DetalleReglasDuras = {
    dti_pct: salida.dti_pct,
    dti_umbral: V2_DTI_MAXIMO,
    canon_ingreso_pct: salida.canon_ingreso_pct,
    canon_ingreso_umbral: V3_CANON_INGRESO_MAXIMO,
    ingreso_mensual_inferido_cop: salida.features.ingreso_mensual_inferido_cop,
    cuota_mensual_vigente_cop: salida.features.cuota_mensual_vigente_cop,
    canon_evaluado_cop: salida.canon_evaluado_cop,
    score_externo: salida.features.score_externo,
    proveedor: salida.proveedor,
    modelo_version: salida.modelo_version,
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

/** Linea corta para anexar a `observaciones`, que es factual (score, saldos). */
export function notaObservacionesReglasDuras(
  reglas: readonly ReglaDuraActiva[],
  d: DetalleReglasDuras,
): string {
  const trozos = reglas.map((r) =>
    r === 'dti_mayor_65'
      ? `DTI ${pct(d.dti_pct)} (max ${d.dti_umbral}%)`
      : `canon/ingreso ${pct(d.canon_ingreso_pct)} (max ${d.canon_ingreso_umbral}%)`,
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
}

export interface ResolucionEstudio {
  /** Lo que hay que mandarle a fn_registrar_resultado_estudio. */
  resultado: string;
  observaciones: string | null;
  motivoRechazo: string | null;
  veredicto: VeredictoReglasDuras;
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
async function canonParaLaRegla(expedienteId: string): Promise<number | null> {
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
  };

  try {
    // 1. Insumos que no vinieron del call site. El registro manual no tiene ni
    //    proveedor ni payload en scope: se leen de la fila.
    let proveedor = args.proveedor ?? null;
    let payload: unknown = args.datosCrudos ?? null;
    let score = args.score ?? null;

    if (!proveedor || !payload) {
      const { data: row } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .select('proveedor, respuesta_proveedor, score')
        .eq('id', args.estudioId)
        .maybeSingle();
      const est = row as {
        proveedor?: string | null;
        respuesta_proveedor?: Record<string, unknown> | null;
        score?: number | null;
      } | null;
      proveedor = proveedor ?? est?.proveedor ?? null;
      payload = payload ?? est?.respuesta_proveedor ?? null;
      score = score ?? est?.score ?? null;
    }

    // 2. Canon congelado de esta corrida.
    const canon = await canonParaLaRegla(args.expedienteId);

    // 3. Evaluar. evaluarSombra nunca lanza.
    const salida = evaluarSombra({
      proveedor,
      payload,
      canon_mensual_cop: canon,
      score_persistido: score,
    });

    const veredicto = aplicarReglasDuras({
      resultadoPropuesto: args.resultadoPropuesto,
      salida,
    });

    if (!veredicto.rechaza) {
      return { ...base, veredicto, salida };
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

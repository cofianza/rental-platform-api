// ============================================================
// Portabilidad del estudio a otra propiedad (Flujo §4.3).
//
// Flujo de Gerencia, modulo de estudios, seccion 4.3 (CAMBIO APROBADO,
// literal): "Un estudio ya pagado y ejecutado puede reutilizarse para una
// propiedad distinta sin costo adicional, siempre que el canon de la nueva
// propiedad este dentro de la tolerancia establecida en la Politica de
// Evaluacion (hasta +15%, con recalculo de la relacion canon/ingreso menor o
// igual al 40%). Si el canon de la nueva propiedad excede la tolerancia, el
// sistema informa que se requiere una nueva evaluacion y su respectivo cobro.
// El estudio conserva su vigencia original; la reutilizacion no la extiende.
// Esta portabilidad es un beneficio comercial diferenciador: el prospecto no
// paga dos veces por buscar vivienda."
//
// Es la continuacion natural del §4.2: cuando un candidato aprobado reserva la
// propiedad, los demas estudios "quedan disponibles para reasignarse a otro
// inmueble" (ver reserva-inmueble.notificaciones.ts). Aqui esta la regla que
// decide si esa reasignacion se puede hacer sin volver a cobrar.
//
// ── DOS PIEZAS, COMO EN tope-canon.guard.ts ──────────────────────────────
//
//   - evaluarPortabilidad: funcion PURA (canon original + ingreso original +
//     canon destino -> veredicto). Es la regla de negocio y es lo que cubre
//     scripts/check-portabilidad.ts sin levantar Supabase.
//   - reasignarEstudio (estudios.service.ts): resuelve los insumos en
//     Supabase, aplica esta funcion y mueve el expediente.
//
// ── LAS TRES CONDICIONES Y SU ORDEN ──────────────────────────────────────
//
//   1. TOPE ABSOLUTO del inmueble destino (§4.4). Va PRIMERO por lo mismo que
//      argumenta tope-canon.guard.ts: es un hecho de la propiedad, no del
//      prospecto, y es el mensaje accionable — si el canon del destino excede
//      el maximo afianzable, ninguna tolerancia lo arregla. Se reusa
//      `evaluarTopeCanon` tal cual: la regla del tope tiene un solo dueño.
//   2. TOLERANCIA +15%, INCLUSIVA. Exactamente +15% pasa; un peso mas, no.
//      Mismo criterio que el tope ("hasta 3.000.000" incluye 3.000.000): el
//      documento dice "hasta +15%" y bloquea lo que "excede la tolerancia".
//   3. RECALCULO canon/ingreso <= 40%. Es la regla dura §4.3 de la Politica
//      V4.1, que YA rechaza en produccion (reglas-duras.ts). Va DESPUES de la
//      tolerancia y NO en lugar de ella: un canon que cabe en el +15% pero
//      dispara la relacion por encima del 40% NO es portable. Aprobar por la
//      puerta de atras un caso que el motor rechazaria de frente seria peor
//      que cobrar una evaluacion nueva.
//
// ── QUE PASA CUANDO FALTA UN INSUMO ──────────────────────────────────────
//
// SIN CANON ORIGINAL -> NO PORTABLE. No es una regla incumplida: es que no hay
// contra que medir. `estudios.canon_evaluado` empezo a escribirse con este
// cambio (lo congelan ejecutarEstudio en el CAS y registrarResultado en el
// registro manual), asi que los estudios anteriores no lo tienen y no hay forma
// honesta de reconstruirlo:
// `inmuebles.valor_arriendo` es EDITABLE y pudo cambiar desde entonces —
// adivinar con el canon de hoy produciria una tolerancia inventada. Se dice
// con claridad y se ofrece la salida (evaluacion nueva), que es el trato del
// §13: accionable, sin portazo.
//
// SIN INGRESO ORIGINAL -> la condicion queda `no_evaluable` y NO bloquea por
// si sola. Es la doctrina que este repo ya fijo en reglas-duras.ts ("LA REGLA
// MAS IMPORTANTE: NO CALCULABLE != INCUMPLIDA", Politica §2 "nunca rechaza por
// fallo tecnico" y §6 "ingreso no inferible" -> revision manual, no rechazo).
// El motivo concreto: TransUnion NO entrega ingreso inferido, asi que ese
// estudio se DECIDIO en produccion sin que la regla del 40% fuera evaluable;
// exigirla solo para portar seria un estandar mas duro que el de la evaluacion
// original y empujaria al prospecto a pagar dos veces — exactamente lo que el
// §4.3 quiere evitar. La exposicion queda acotada por la otra condicion: el
// canon destino no puede superar al original en mas de 15%, asi que la
// relacion canon/ingreso no puede empeorar mas de un 15% relativo respecto de
// la que el estudio ya acepto.
//
// En los tres casos el veredicto de la condicion (`cumple` / `no_cumple` /
// `no_evaluable`) viaja en el resultado y se PERSISTE en la traza de la
// reasignacion: sin eso la decision no seria auditable.
// ============================================================

import { AppError } from '@/lib/errors';
import { evaluarTopeCanon, formatearCOP, getTopeCanon } from './tope-canon.guard';
// El 40% no se reescribe aqui: es la misma constante que usa la regla dura que
// ya rechaza en produccion (reglas-duras.ts la importa del mismo sitio). Si
// Gerencia mueve el umbral, se mueve en un solo lugar.
import {
  V3_CANON_INGRESO_MAXIMO,
  porcentaje,
  porcentajeParaMostrar,
} from './motor/scorecard';

/** Codigo de dominio unico. La web discrimina por el para el mensaje del §4.3. */
export const ESTUDIO_NO_PORTABLE_ERROR_CODE = 'ESTUDIO_NO_PORTABLE';

/**
 * Tolerancia del §4.3 en PUNTOS PORCENTUALES. Va como constante y no como env
 * porque no es transitoria como el tope: es la regla comercial del documento.
 */
export const PORTABILIDAD_TOLERANCIA_PCT = 15;

export type MotivoNoPortable =
  /**
   * El estudio no tiene el canon congelado. Dos poblaciones distintas y NO se
   * distinguen aqui a proposito (ver mensajeNoPortable): los historicos
   * anteriores al congelado, y los que se completaron sin que se pudiera
   * resolver el canon del inmueble.
   */
  | 'sin_canon_original'
  /** El inmueble destino no tiene un canon utilizable con que comparar. */
  | 'sin_canon_destino'
  /** El destino supera el maximo afianzable sin coafianzamiento (§4.4). */
  | 'excede_tope_canon'
  /** El destino supera el canon original en mas del 15%. */
  | 'excede_tolerancia'
  /** El recalculo dispara la regla dura canon/ingreso > 40%. */
  | 'canon_ingreso_excede';

/** Veredicto de la segunda condicion del §4.3, tal como se audita. */
export type VeredictoCanonIngreso = 'cumple' | 'no_cumple' | 'no_evaluable';

export interface ContextoPortabilidad {
  /**
   * `estudios.canon_evaluado`: el canon CONGELADO con el que se ejecuto el
   * estudio. Se acepta string porque PostgREST devuelve NUMERIC como string.
   */
  canonOriginal: number | string | null | undefined;
  /**
   * Ingreso mensual inferido de la corrida original
   * (`estudios_scorecard_sombra.ingreso_inferido_cop`). NULL cuando el buro no
   * lo entrego — con TransUnion es siempre asi.
   */
  ingresoOriginal: number | string | null | undefined;
  /** `inmuebles.valor_arriendo` del inmueble destino. */
  canonDestino: number | string | null | undefined;
  /** Tope vigente del §4.4. Por defecto, el de env. */
  topeCop?: number;
  /** Tolerancia en puntos porcentuales. Por defecto, el 15 del §4.3. */
  toleranciaPct?: number;
}

interface DatosComunes {
  canonOriginalCop: number;
  canonDestinoCop: number;
  /** canonOriginal * (100 + tolerancia) / 100. El techo inclusivo. */
  canonMaximoToleradoCop: number;
  toleranciaPct: number;
  ingresoOriginalCop: number | null;
  /** canonDestino / ingresoOriginal * 100, o null si el ingreso no se conoce. */
  canonIngresoDestinoPct: number | null;
  veredictoCanonIngreso: VeredictoCanonIngreso;
}

export type VeredictoPortabilidad =
  | ({ portable: true } & DatosComunes)
  | {
      portable: false;
      motivo: MotivoNoPortable;
      /** Presentes solo cuando se pudieron resolver; null si faltaba el insumo. */
      canonOriginalCop: number | null;
      canonDestinoCop: number | null;
      canonMaximoToleradoCop: number | null;
      toleranciaPct: number;
      ingresoOriginalCop: number | null;
      canonIngresoDestinoPct: number | null;
      veredictoCanonIngreso: VeredictoCanonIngreso;
      topeCop: number;
      detalle: string;
    };

/**
 * Normaliza un NUMERIC de PostgREST (que llega como string) a un numero
 * positivo utilizable, o null. Cero, negativo, NaN e Infinity son "no hay
 * dato", no "hay un dato malo": ninguno sirve ni para comparar ni para dividir.
 */
function aMonto(bruto: number | string | null | undefined): number | null {
  const n = typeof bruto === 'string' ? Number(bruto) : bruto;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Techo de la tolerancia, INCLUSIVO.
 *
 * Se calcula como `canon * (100 + pct) / 100` y no como `canon * 1.15` a
 * proposito: 1.15 no es representable en binario y el producto se desvia unos
 * pocos ULP, asi que un canon destino que es EXACTAMENTE el +15% podia caer
 * del lado equivocado de la comparacion. Con enteros de por medio (2.000.000 *
 * 115 = 230.000.000, / 100 = 2.300.000) el borde es exacto, que es justo donde
 * el documento dice "hasta".
 */
export function canonMaximoTolerado(canonOriginalCop: number, toleranciaPct: number): number {
  return (canonOriginalCop * (100 + toleranciaPct)) / 100;
}

/**
 * Relacion canon/ingreso en porcentaje EXACTO, o null si el ingreso no se
 * conoce. Es la misma `porcentaje()` del motor, a proposito.
 *
 * NO se redondea aqui, y eso es la correccion de un defecto real: redondear a 2
 * decimales ANTES de comparar contra el 40 dejaba pasar el intervalo
 * (40%, 40.005%) — p.ej. 2.000.200 sobre un ingreso de 5.000.000 da 40.004%,
 * que redondeado es 40 y "cumplia", mientras `puntajeV3CanonIngreso` (la regla
 * dura ACTIVA en produccion, que compara sobre el exacto) lo marca
 * 'canon_ingreso_mayor_40'. Ahi la portabilidad aprobaba por la puerta de atras
 * justo lo que el motor rechaza de frente. Es el mismo defecto que
 * motor/scorecard.ts documenta como corregido ("Redondear antes de comparar
 * mueve de banda a los casos que caen justo sobre un corte").
 *
 * El redondeo a 2 decimales sigue existiendo, pero SOLO para mostrar y
 * persistir (`porcentajeParaMostrar`, que casa con las columnas NUMERIC(_,2)).
 */
export function relacionCanonIngresoPct(
  canonCop: number,
  ingresoCop: number | null,
): number | null {
  return porcentaje(canonCop, ingresoCop);
}

/**
 * ¿Se puede llevar este estudio, ya pagado y ejecutado, a esta otra propiedad
 * sin volver a cobrar? Regla del §4.3, sin dependencias.
 */
export function evaluarPortabilidad(contexto: ContextoPortabilidad): VeredictoPortabilidad {
  const toleranciaPct = contexto.toleranciaPct ?? PORTABILIDAD_TOLERANCIA_PCT;
  const topeCop = contexto.topeCop ?? getTopeCanon();

  const canonOriginalCop = aMonto(contexto.canonOriginal);
  const canonDestinoCop = aMonto(contexto.canonDestino);
  const ingresoOriginalCop = aMonto(contexto.ingresoOriginal);

  const canonMaximoToleradoCop =
    canonOriginalCop === null ? null : canonMaximoTolerado(canonOriginalCop, toleranciaPct);
  // DOS numeros y no uno: el EXACTO decide, el redondeado se muestra y se
  // persiste. Comparar sobre el redondeado abria el intervalo (40, 40.005) que
  // la regla dura si rechaza (ver relacionCanonIngresoPct).
  const canonIngresoExactoPct =
    canonDestinoCop === null ? null : relacionCanonIngresoPct(canonDestinoCop, ingresoOriginalCop);
  const canonIngresoDestinoPct = porcentajeParaMostrar(canonIngresoExactoPct);

  // El veredicto de la segunda condicion se resuelve una sola vez y viaja en
  // TODAS las salidas: tambien cuando el que bloquea es otro motivo. Sin eso,
  // la traza de una reasignacion negada por tolerancia no dejaria constancia de
  // si la relacion canon/ingreso se pudo mirar siquiera.
  const veredictoCanonIngreso: VeredictoCanonIngreso =
    canonIngresoExactoPct === null
      ? 'no_evaluable'
      : canonIngresoExactoPct > V3_CANON_INGRESO_MAXIMO
        ? 'no_cumple'
        : 'cumple';

  const noPortable = (
    motivo: MotivoNoPortable,
    detalle: string,
  ): Extract<VeredictoPortabilidad, { portable: false }> => ({
    portable: false,
    motivo,
    canonOriginalCop,
    canonDestinoCop,
    canonMaximoToleradoCop,
    toleranciaPct,
    ingresoOriginalCop,
    canonIngresoDestinoPct,
    veredictoCanonIngreso,
    topeCop,
    detalle,
  });

  // 0. Sin canon congelado no hay tolerancia que calcular. Ver el encabezado:
  //    NO se cae al canon actual del inmueble origen, que es editable.
  if (canonOriginalCop === null) {
    return noPortable(
      'sin_canon_original',
      'El estudio no tiene registrado el canon con el que se evaluo, asi que no hay contra que medir la tolerancia.',
    );
  }

  // 0.b El destino sin canon utilizable tampoco se puede comparar. A diferencia
  //     del tope (donde un canon ausente NO bloquea, porque puede que todavia
  //     no haya inmueble), aqui el inmueble destino es un dato que el gestor
  //     acaba de elegir: si no tiene canon, la comparacion es imposible.
  if (canonDestinoCop === null) {
    return noPortable(
      'sin_canon_destino',
      'La propiedad de destino no tiene un canon registrado con el que comparar.',
    );
  }

  // 1. Tope absoluto del §4.4, con la MISMA funcion que lo aplica en el resto
  //    del flujo. El destino es una propiedad nueva que Cofianza tendria que
  //    afianzar: aqui no hay grandfathering que valga.
  const tope = evaluarTopeCanon({ canonCop: canonDestinoCop, topeCop });
  if (!tope.ok) {
    return noPortable('excede_tope_canon', tope.detalle);
  }

  // 2. Tolerancia +15%, inclusiva.
  if (canonDestinoCop > (canonMaximoToleradoCop as number)) {
    return noPortable(
      'excede_tolerancia',
      `El canon de la nueva propiedad (${formatearCOP(canonDestinoCop)}) supera en mas de ${toleranciaPct}% ` +
        `el canon con el que se hizo el estudio (${formatearCOP(canonOriginalCop)}; maximo ${formatearCOP(canonMaximoToleradoCop as number)}).`,
    );
  }

  // 3. Recalculo canon/ingreso. Regla dura ACTIVA: si el ingreso se conoce y la
  //    relacion supera el 40%, se niega aunque el canon quepa en el 15%.
  if (veredictoCanonIngreso === 'no_cumple') {
    return noPortable(
      'canon_ingreso_excede',
      `Con el canon de la nueva propiedad, la relacion canon/ingreso quedaria en ` +
        `${(canonIngresoDestinoPct as number).toFixed(2)}%, por encima del maximo de ${V3_CANON_INGRESO_MAXIMO}%.`,
    );
  }

  return {
    portable: true,
    canonOriginalCop,
    canonDestinoCop,
    canonMaximoToleradoCop: canonMaximoToleradoCop as number,
    toleranciaPct,
    ingresoOriginalCop,
    canonIngresoDestinoPct,
    veredictoCanonIngreso,
  };
}

/**
 * Mensaje del §13: dice el numero concreto, dice que NO se cobro nada todavia,
 * y da la salida. Nunca la palabra "rechazado" ni tono de portazo — la
 * portabilidad es un beneficio comercial, y que no aplique no es una sancion.
 */
export function mensajeNoPortable(
  veredicto: Extract<VeredictoPortabilidad, { portable: false }>,
): string {
  const cierre =
    'No se genero ningun cobro ni se descuento ningun credito. ' +
    'Puedes elegir otra propiedad, o solicitar una evaluacion nueva para esta.';

  switch (veredicto.motivo) {
    case 'sin_canon_original':
      // NO se afirma la causa. Antes decia "este estudio se ejecuto antes de
      // que el sistema registrara el canon evaluado", que es cierto para los
      // historicos pero FALSO para un estudio de hoy cuyo inmueble no tenia
      // canon legible al completarse: se le nombraba al gestor una causa
      // irreparable por definicion y se quedaba sin ninguna accion posible.
      // Se dice lo unico que se sabe con certeza —que el dato no esta— y se
      // ofrece la salida, sin insinuar que al prospecto le falte algo.
      return (
        'Este estudio no tiene registrado el canon con el que se evaluo, ' +
        'asi que no podemos verificar la tolerancia de portabilidad. ' +
        'Para esta propiedad se requiere una evaluacion nueva. ' +
        cierre
      );
    case 'sin_canon_destino':
      return (
        'La propiedad de destino no tiene un canon registrado, asi que no podemos ' +
        'compararlo con el del estudio. Completa el canon del inmueble e intenta de nuevo.'
      );
    case 'excede_tope_canon':
      return (
        `${veredicto.detalle} Cofianza no puede afianzar hoy esa propiedad sin un acuerdo de coafianzamiento. ` +
        'No se genero ningun cobro ni se descuento ningun credito.'
      );
    case 'excede_tolerancia':
      return `${veredicto.detalle} Para esta propiedad se requiere una evaluacion nueva. ${cierre}`;
    case 'canon_ingreso_excede':
      return `${veredicto.detalle} Para esta propiedad se requiere una evaluacion nueva. ${cierre}`;
  }
}

/**
 * Traduce el veredicto negativo al error de dominio.
 *
 * Funcion aparte (y no un throw suelto en el servicio) por lo mismo que en
 * tope-canon.guard.ts: para que el check pueda comprobar sin Supabase lo que
 * mas importa del error — que lleva un CODIGO PROPIO y los numeros con los que
 * se decidio, que es lo que hace auditable un "no" que le cuesta plata a
 * alguien.
 */
export function errorNoPortable(
  veredicto: Extract<VeredictoPortabilidad, { portable: false }>,
): AppError {
  return AppError.badRequest(mensajeNoPortable(veredicto), ESTUDIO_NO_PORTABLE_ERROR_CODE, {
    motivo: veredicto.motivo,
    canon_original_cop: veredicto.canonOriginalCop,
    canon_destino_cop: veredicto.canonDestinoCop,
    canon_maximo_tolerado_cop: veredicto.canonMaximoToleradoCop,
    tolerancia_pct: veredicto.toleranciaPct,
    canon_ingreso_destino_pct: veredicto.canonIngresoDestinoPct,
    veredicto_canon_ingreso: veredicto.veredictoCanonIngreso,
    canon_ingreso_maximo_pct: V3_CANON_INGRESO_MAXIMO,
    tope_cop: veredicto.topeCop,
  });
}

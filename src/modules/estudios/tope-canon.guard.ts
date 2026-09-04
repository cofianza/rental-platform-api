// ============================================================
// Tope de canon: el maximo que Cofianza puede afianzar hoy.
//
// Flujo del modulo de estudios, seccion 4.4 (literal): "Al seleccionar la
// propiedad, y ANTES de avanzar y de generar cualquier cobro, el sistema valida
// el tope de canon vigente. Si el canon supera el maximo permitido sin acuerdo
// de coafianzamiento, el flujo se detiene con un mensaje claro y no se cobra el
// estudio. Hasta 3.000.000". La seccion 12 lo repite como caso borde: "Canon
// superior al tope. El flujo se detiene en el Paso 1, antes de cualquier cobro".
//
// Gerencia (Direccion de Riesgo) fijo el valor en 3.000.000 el 2026-09-03,
// resolviendo la contradiccion con la Politica de Evaluacion V4.1 §6, que decia
// 2.000.000. Manda el Flujo §4.4.
//
// La regla es TRANSITORIA: rige mientras Cofianza no tenga un acuerdo de
// coafianzamiento que absorba el exceso. Por eso el tope se lee de
// env.CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP y no esta escrito en el codigo:
// cuando el acuerdo exista, sube (o se retira) sin desplegar.
//
// NO es la regla V3 del scorecard. El motor sombra (src/modules/estudios/motor/)
// tiene su propia regla de canon / ingreso > 40%, que es una RELACION entre el
// canon y el ingreso declarado de la persona. Esta de aqui es un tope ABSOLUTO
// en pesos sobre el inmueble, no depende de quien lo arriende, y se evalua antes
// de que exista dato alguno del prospecto. Son dos reglas distintas y no se
// fusionan.
//
// Como el guard de autorizacion previa, este modulo tiene dos piezas a
// proposito:
//   - evaluarTopeCanon: funcion PURA (canon + tope -> veredicto). Es la regla de
//     negocio, y es lo que cubre scripts/check-tope-canon.ts.
//   - assertCanonDentroDelTope: resuelve el canon en Supabase, aplica la funcion
//     pura y traduce el veredicto a un AppError accionable.
//
// ORDEN respecto al gate de autorizacion previa (autorizacion.guard.ts): este va
// PRIMERO. Los dos son de solo lectura y ninguno escribe, asi que el orden solo
// decide que mensaje lee el gestor — y el accionable es este. El tope es un
// hecho del INMUEBLE, conocido en el Paso 1, antes de que haya prospecto: si el
// canon excede el tope el estudio no va a poder correr nunca, y contestar
// "falta la autorizacion" mandaria al gestor a perseguir una firma inutil.
// Ademas pedirle a una persona su autorizacion de habeas data para un estudio
// que no se puede ejecutar seria recolectar datos personales sin finalidad
// (principio de finalidad, Ley 1581 de 2012).
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';

/** Codigo de dominio unico del tope. La web lo usa para el mensaje accionable. */
export const CANON_EXCEDE_TOPE_ERROR_CODE = 'CANON_EXCEDE_TOPE';

/** Unico motivo de rechazo. Es un tope, no una bateria de reglas. */
export type MotivoRechazoTopeCanon = 'excede_tope';

export interface ContextoTopeCanon {
  /**
   * Canon mensual del inmueble en PESOS. `inmuebles.valor_arriendo` es el
   * canon: NO existe ninguna columna llamada "canon". Se acepta string porque
   * PostgREST devuelve NUMERIC como string.
   */
  canonCop: number | string | null | undefined;
  /** Tope vigente en PESOS. Por defecto, el de env. */
  topeCop?: number;
}

export type VeredictoTopeCanon =
  | {
      ok: true;
      canonCop: number | null;
      topeCop: number;
      /**
       * false cuando no hay canon con que contrastar (no hay inmueble que
       * resolver todavia). Ver la nota de "canon desconocido" mas abajo: se
       * DEJA PASAR y el caller lo registra en el log.
       */
      canonConocido: boolean;
    }
  | {
      ok: false;
      motivo: MotivoRechazoTopeCanon;
      canonCop: number;
      topeCop: number;
      detalle: string;
    };

/** Formato de pesos colombianos para los mensajes que lee el gestor. */
export function formatearCOP(valor: number): string {
  return `$${new Intl.NumberFormat('es-CO').format(valor)}`;
}

/** Tope vigente en pesos. Un solo lugar de lectura del env. */
export function getTopeCanon(): number {
  return env.CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP;
}

/**
 * Regla de negocio del 4.4, sin dependencias.
 *
 * Dos decisiones que el documento no deletrea y que quedan fijadas aqui:
 *
 * 1. El tope es INCLUSIVO. "Hasta 3.000.000" incluye 3.000.000: solo bloquea
 *    lo que lo SUPERA (el documento dice "si el canon supera el maximo"). Un
 *    canon de exactamente 3.000.000 pasa; 3.000.001 no.
 *
 * 2. Canon DESCONOCIDO (null, 0, negativo, no numerico) NO bloquea. Un canon
 *    ausente no "supera" nada: es un vacio de datos, no un inmueble caro, y
 *    bloquear por un vacio seria una restriccion que Gerencia no pidio.
 *
 *    OJO con el alcance real de esta rama: el esquema NO permite un inmueble
 *    sin canon. `inmuebles.valor_arriendo` es numeric NOT NULL con CHECK
 *    (valor_arriendo > 0) y `expedientes.inmueble_id` es NOT NULL (verificado
 *    contra la base productiva el 2026-09-03). O sea que, con datos legitimos,
 *    la unica forma de llegar aqui es estructural: que todavia no haya inmueble
 *    que resolver (`createEstudioFromInmueble` sin id). La cita del motor
 *    sombra ("Sin canon del inmueble: V3 queda no calculable") habla de un
 *    expediente sin inmueble resuelto, NO de un valor_arriendo nulo.
 *
 *    Por eso `leerCanon` no puede devolver "desconocido" cuando la consulta
 *    falla: eso convertiria cualquier timeout de PostgREST en un permiso
 *    silencioso para cobrar y consultar el buro. Ahi se falla CERRADO.
 */
export function evaluarTopeCanon(contexto: ContextoTopeCanon): VeredictoTopeCanon {
  const topeCop = contexto.topeCop ?? getTopeCanon();

  const bruto = contexto.canonCop;
  const numero = typeof bruto === 'string' ? Number(bruto) : bruto;
  const canonCop =
    typeof numero === 'number' && Number.isFinite(numero) && numero > 0 ? numero : null;

  if (canonCop === null) {
    return { ok: true, canonCop: null, topeCop, canonConocido: false };
  }

  if (canonCop > topeCop) {
    return {
      ok: false,
      motivo: 'excede_tope',
      canonCop,
      topeCop,
      detalle: `El canon del inmueble (${formatearCOP(canonCop)}) supera el tope vigente (${formatearCOP(topeCop)}).`,
    };
  }

  return { ok: true, canonCop, topeCop, canonConocido: true };
}

/**
 * Mensaje accionable y sin dramatismo (el flujo prohibe la palabra "rechazado"
 * y el tono de portazo): dice cuanto es el canon, cuanto es el tope, que NO se
 * cobro nada, y cual es la salida.
 */
export function mensajeTopeExcedido(canonCop: number, topeCop: number): string {
  return (
    `El canon de este inmueble (${formatearCOP(canonCop)}) excede el maximo que Cofianza puede ` +
    `afianzar hoy sin un acuerdo de coafianzamiento (${formatearCOP(topeCop)}). ` +
    'No se genero ningun cobro ni se descuento ningun credito. ' +
    'Puedes continuar con un inmueble dentro del tope, o escribirnos para revisar el caso.'
  );
}

/**
 * Traduce un veredicto de rechazo al error de dominio.
 *
 * Es una funcion aparte (y no un throw suelto dentro del assert) para que el
 * check pueda comprobar sin Supabase lo que mas importa del error: que lleva un
 * CODIGO PROPIO y no una excepcion generica. La web discrimina por ese codigo.
 */
export function errorTopeExcedido(
  veredicto: Extract<VeredictoTopeCanon, { ok: false }>,
): AppError {
  return AppError.badRequest(
    mensajeTopeExcedido(veredicto.canonCop, veredicto.topeCop),
    CANON_EXCEDE_TOPE_ERROR_CODE,
    {
      motivo: veredicto.motivo,
      canon_cop: veredicto.canonCop,
      tope_cop: veredicto.topeCop,
    },
  );
}

/**
 * Canon mensual del inmueble, en PESOS, resuelto desde el expediente o
 * directamente desde el inmueble.
 *
 * Dos queries encadenadas en vez de un embed de PostgREST: mismo criterio que
 * motor/sombra.service.ts — el embed es mas corto pero sensible a la ambiguedad
 * de FKs, y este camino no puede fallar por sintaxis de relacion.
 *
 * FALLA CERRADO. Si cualquiera de las dos consultas devuelve error (timeout,
 * 5xx de PostgREST, pool agotado), esta funcion LANZA en vez de devolver
 * "desconocido": tragarse el error convertiria una caida transitoria de la base
 * en un permiso silencioso para cobrar el estudio y consultar el buro de un
 * inmueble de cualquier canon. Como el esquema garantiza que el canon existe
 * (valor_arriendo NOT NULL > 0, expedientes.inmueble_id NOT NULL), un error de
 * lectura NUNCA es un vacio de datos legitimo.
 *
 * Devuelve `undefined` solo en el caso estructural: no hay inmueble que
 * resolver todavia (o la fila no existe), que el caller trata como canon
 * desconocido y deja pasar con un warning.
 *
 * Se EXPORTA porque la regla dura de canon / ingreso (§4.3, reglas-duras.ts)
 * necesita exactamente el mismo canon que el tope: si cada una resolviera el
 * suyo, el estudio podria bloquearse contra un canon y evaluarse contra otro.
 * Ese caller SI atrapa el throw — para el, un canon no legible solo vuelve la
 * regla no evaluable, que es el lado seguro.
 */
export async function leerCanonDelInmueble(args: {
  expedienteId?: string | null;
  inmuebleId?: string | null;
}): Promise<number | string | null | undefined> {
  let inmuebleId = args.inmuebleId ?? null;

  if (!inmuebleId && args.expedienteId) {
    const { data: exp, error: expError } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('inmueble_id')
      .eq('id', args.expedienteId)
      .maybeSingle();
    if (expError) throw errorCanonNoLegible(expError.message, args);
    inmuebleId = (exp as { inmueble_id?: string | null } | null)?.inmueble_id ?? null;
  }

  if (!inmuebleId) return undefined;

  const { data: inm, error: inmError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('valor_arriendo')
    .eq('id', inmuebleId)
    .maybeSingle();

  if (inmError) throw errorCanonNoLegible(inmError.message, args);

  return (inm as { valor_arriendo?: number | string | null } | null)?.valor_arriendo ?? undefined;
}

/** Codigo del fallo de lectura. No es un rechazo del tope: es un "no pude verificar". */
export const CANON_NO_VERIFICABLE_ERROR_CODE = 'CANON_NO_VERIFICABLE';

/**
 * Error de la rama fail-closed. 503 y no 400: no es culpa del gestor ni del
 * inmueble, es que la base no contesto — y reintentar es la accion correcta.
 */
function errorCanonNoLegible(
  detalle: string,
  args: { expedienteId?: string | null; inmuebleId?: string | null },
): AppError {
  logger.error(
    { detalle, expedienteId: args.expedienteId, inmuebleId: args.inmuebleId },
    'Tope 4.4: no se pudo leer el canon del inmueble — se bloquea el estudio (fail closed)',
  );
  return new AppError(
    503,
    CANON_NO_VERIFICABLE_ERROR_CODE,
    'No pudimos verificar el canon del inmueble en este momento, asi que no continuamos. ' +
      'No se genero ningun cobro ni se descuento ningun credito. Intenta de nuevo en un momento.',
  );
}

export interface AssertTopeArgs {
  /** Se resuelve el inmueble del expediente. Excluyente con inmuebleId. */
  expedienteId?: string | null;
  /** Camino directo cuando el expediente aun no existe (crear desde inmueble). */
  inmuebleId?: string | null;
  /** Nombre del call site. Solo para el log — deja ver por donde entro. */
  origen: string;
  /**
   * GRANDFATHERING de lo YA COBRADO. Cuando es true, un canon por encima del
   * tope se registra en el log pero NO lanza.
   *
   * La regla del §4.4 protege de COBRAR un estudio sobre un inmueble fuera de
   * tope ("no se cobra el estudio"), no de ENTREGAR uno que ya se cobro. Los
   * call sites que corren despues del pago (reintento de un 'fallido',
   * re-consulta al otro buro, re-evaluacion con soportes) tienen que poder
   * terminar de prestar el servicio pagado: bloquearlos dejaria al cliente
   * cobrado y sin estudio, y ademas con un mensaje que le afirma que "no se
   * genero ningun cobro" — falso en ese caso.
   *
   * El bloqueo real vive en los sitios que PRECEDEN al cobro (habilitarEstudio,
   * createEstudio, createEstudioFromInmueble, liberarEstudioConCredito,
   * asumirCosto, enviarLinkPago, createPaymentLink y la invitacion del
   * co-arrendatario), que son los que el §4.4 pide.
   */
  soloAdvertir?: boolean;
}

/**
 * Lanza si el canon del inmueble supera el tope vigente. Se invoca ANTES de
 * cualquier cobro, descuento de credito o consulta al buro.
 *
 * Devuelve el canon evaluado para que el caller lo pueda dejar en su propio log.
 */
export async function assertCanonDentroDelTope(
  args: AssertTopeArgs,
): Promise<{ canonCop: number | null }> {
  const canonBruto = await leerCanonDelInmueble(args);
  const veredicto = evaluarTopeCanon({ canonCop: canonBruto });

  if (!veredicto.ok) {
    logger.warn(
      {
        origen: args.origen,
        expedienteId: args.expedienteId,
        inmuebleId: args.inmuebleId,
        canonCop: veredicto.canonCop,
        topeCop: veredicto.topeCop,
        soloAdvertir: args.soloAdvertir === true,
      },
      args.soloAdvertir
        ? 'Tope 4.4: el canon supera el tope, pero el estudio YA fue cobrado — se deja continuar (grandfathering)'
        : 'Tope 4.4: estudio bloqueado — el canon del inmueble supera el maximo afianzable sin coafianzamiento',
    );
    if (!args.soloAdvertir) {
      throw errorTopeExcedido(veredicto);
    }
    return { canonCop: veredicto.canonCop };
  }

  if (!veredicto.canonConocido) {
    // No bloquea (ver evaluarTopeCanon), pero queda visible: un inmueble sin
    // canon tampoco puede calcular la relacion canon/ingreso del scorecard.
    logger.warn(
      { origen: args.origen, expedienteId: args.expedienteId, inmuebleId: args.inmuebleId },
      'Tope 4.4: el inmueble no tiene canon utilizable — no se puede contrastar contra el tope',
    );
  }

  return { canonCop: veredicto.canonCop };
}

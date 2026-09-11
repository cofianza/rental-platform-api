/**
 * Las CUATRO RUTAS del resultado — Flujo de Gerencia, modulo de estudios, §10
 * "PASO 7 — RESULTADO", con las bandas CORREGIDAS por la Adenda 1 §3.
 *
 * Texto literal del Flujo §10:
 *
 *   "El motor produce una de cuatro rutas. En ninguna se utiliza la palabra
 *    'rechazado'.
 *      - Perfil fuerte. Aprobado. El prospecto firma solo, sin acompañante.
 *      - Perfil medio. Aprobado con opcion: puede continuar solo o con
 *        coarrendatario, obteniendo en ese caso un menor valor de prima.
 *      - Coarrendatario requerido. Aprobado con acompañante. La opcion de
 *        continuar solo se muestra bloqueada, sin precio y sin dramatismo.
 *      - No aprobable por ahora. Se comunica que aun no es posible activar la
 *        fianza y se indica que puede mejorar. Nunca es un portazo."
 *
 * ── POR QUE ESTO ES UNA CAPA DE PRESENTACION Y NO UNA DECISION NUEVA ──────
 *
 * La decision ya la toman otros: las reglas duras (§6 de la Politica), el
 * scorecard (o el buro mientras el motor no decida) y la cascada. Este modulo
 * NO decide nada — traduce una decision ya tomada al lenguaje comercial que el
 * §10 exige, y dice que puede hacer el prospecto en cada caso.
 *
 * ── LAS BANDAS, SEGUN LA ADENDA 1 §3 (07/09/2026) ────────────────────────
 *
 * Desarrollo habia leido "85+ fuerte / 80-84 medio / 70-79 coarrendatario",
 * y Gerencia lo corrigio por escrito: "LA INTERPRETACION DE DESARROLLO ES
 * INCORRECTA [...] El umbral de 80 se refiere al puntaje DEL COARRENDATARIO,
 * no al del solicitante." La regla correcta:
 *
 *   85 a 100                                        -> APROBADO AUTOMATICO, firma solo
 *   70 a 84 CON coarrendatario que obtiene >= 80    -> APROBACION AUTOMATICA CONDICIONADA
 *   70 a 84 SIN coarrendatario (o con uno < 80)     -> REVISION MANUAL
 *   < 70                                            -> RECHAZADO
 *
 * "El esquema propuesto por desarrollo le quitaria la palanca del
 * coarrendatario a quien obtiene entre 70 y 79 puntos, que es precisamente el
 * segmento al que apunta la propuesta comercial de Cofianza."
 *
 * De ahi el mapa (los umbrales vienen del panel de calibracion, Adenda §11):
 *     >= UMBRAL_APROBACION_AUTOMATICA (85)  perfil_fuerte
 *     [UMBRAL_ZONA_GRIS (70), 85)           coarrendatario_requerido — con
 *                                           coarrendatario >= UMBRAL_COARRENDATARIO
 *                                           (80) se comunica como aprobado
 *     < 70                                  no_aprobable
 *
 * "Perfil medio" del Flujo NO es una banda de puntaje: es el aprobado por el
 * buro cuando el modelo no pudo calcular puntaje (el caso normal mientras
 * MOTOR_DECIDE_ENABLED este apagado). Y la "menor prima" con coarrendatario es
 * literal para TODOS los aprobados: la prima de vinculacion baja del 20% al
 * 10% del canon (Adenda §5.2), asi que tambien el perfil fuerte la ve.
 *
 * ── POR QUE HAY UNA QUINTA SALIDA QUE EL DOCUMENTO NO NOMBRA ──────────────
 *
 * `en_revision` no es una quinta ruta: es el ESTADO mientras un analista
 * decide. Mostrarle al prospecto "no aprobable" mientras un humano aun no
 * decide seria mentirle; mostrarle "aprobado" seria peor.
 */

/** Las cuatro rutas del §10, mas el estado transitorio de revision manual. */
export type RutaResultado =
  | 'perfil_fuerte'
  | 'perfil_medio'
  | 'coarrendatario_requerido'
  | 'no_aprobable'
  | 'en_revision';

// Defaults de la Politica §3.1 y la Adenda §3. Los vigentes los manda el panel
// de calibracion via `EntradaRuta.umbrales`.
export const CORTE_PERFIL_FUERTE = 85;
export const CORTE_ZONA_GRIS = 70;
export const UMBRAL_COARRENDATARIO = 80;

export interface UmbralesRuta {
  aprobacion: number;
  zonaGris: number;
  coarrendatario: number;
}

export const UMBRALES_RUTA_DEFAULT: UmbralesRuta = {
  aprobacion: CORTE_PERFIL_FUERTE,
  zonaGris: CORTE_ZONA_GRIS,
  coarrendatario: UMBRAL_COARRENDATARIO,
};

export interface EntradaRuta {
  /** Puntaje normalizado 0-100 del scorecard V4.1. `null` cuando no se pudo calcular. */
  puntaje: number | null;
  /** Resultado registrado. Mientras el motor no decida, es el del buro. */
  resultadoVigente: 'pendiente' | 'aprobado' | 'rechazado' | 'condicionado';
  /** Alguna regla dura del §6 se activo. Anula el puntaje por completo. */
  reglaDuraActivada: boolean;
  /** El expediente ya tiene un coarrendatario vinculado y evaluado. */
  coarrendatarioVinculado: boolean;
  /** Puntaje del coarrendatario, si fue evaluado. */
  puntajeCoarrendatario: number | null;
  /** Umbrales vigentes (panel de calibracion). Sin ellos, los de la Politica. */
  umbrales?: Partial<UmbralesRuta> | null;
}

export interface Ruta {
  ruta: RutaResultado;
  /** Titulo para el prospecto. Nunca dice "rechazado" (§13). */
  titulo: string;
  /** Cuerpo para el prospecto. Nunca "seguro" ni "aseguradora" (§13). */
  mensaje: string;
  /** ¿Puede firmar sin acompañante? */
  puedeContinuarSolo: boolean;
  /** ¿El acompañante es obligatorio para que esto avance? */
  coarrendatarioObligatorio: boolean;
  /** ¿Sumar un coarrendatario le abarata la prima? (Adenda §5.2: 20% -> 10%). */
  coarrendatarioAbarataPrima: boolean;
  /** Etiqueta interna para el gestor. Aqui SI se puede ser tecnico. */
  etiquetaGestor: string;
}

/**
 * "Nunca es un portazo": el §10 exige decir QUE PUEDE MEJORAR. Estas son
 * mejoras genericas y accionables — no revelan el modelo, los umbrales ni el
 * puntaje, que el prospecto no puede ver (ver redactarEstudioParaProspecto).
 */
export const MEJORAS_SUGERIDAS: readonly string[] = [
  'Sumar un coarrendatario con ingresos propios: no necesita finca raiz.',
  'Ponerte al dia en las obligaciones que tengas en mora.',
  'Buscar un inmueble con un canon mas bajo frente a tus ingresos.',
];

const NO_APROBABLE = {
  titulo: 'Por ahora no podemos activar la fianza',
  mensaje:
    'Revisamos tu solicitud y en este momento no podemos respaldarla. Esto puede cambiar: abajo te contamos que ayuda a que si podamos.',
  puedeContinuarSolo: false,
  coarrendatarioObligatorio: false,
  coarrendatarioAbarataPrima: false,
} as const;

/**
 * Traduce una decision ya tomada a la ruta del §10.
 *
 * El orden de los casos ES la jerarquia y no se puede reordenar:
 *   1. regla dura     — el §6 dice que anula el puntaje, gane lo que gane
 *   2. condicionado   — un humano todavia no decide; no adelantamos veredicto
 *   3. rechazado      — ya se dijo que no
 *   4. sin puntaje    — aprobado sin scorecard calculable
 *   5. por bandas     — Adenda §3
 */
export function resolverRuta(e: EntradaRuta): Ruta {
  const u: UmbralesRuta = { ...UMBRALES_RUTA_DEFAULT, ...(e.umbrales ?? {}) };

  // 1. Regla dura: §6 de la Politica. Ni el mejor puntaje la compensa, y el
  //    coarrendatario tampoco ("Regla dura del coarrendatario contamina el
  //    conjunto", §5).
  if (e.reglaDuraActivada) {
    return { ruta: 'no_aprobable', ...NO_APROBABLE, etiquetaGestor: 'No aprobable — regla dura activada' };
  }

  // 2. Revision manual en curso. NO es una de las cuatro rutas: es el estado
  //    mientras un analista decide.
  if (e.resultadoVigente === 'condicionado' || e.resultadoVigente === 'pendiente') {
    return {
      ruta: 'en_revision',
      titulo: 'Estamos revisando tu solicitud',
      mensaje:
        'Una persona de nuestro equipo esta revisando tu caso. Te escribimos apenas tengamos la respuesta.',
      puedeContinuarSolo: false,
      coarrendatarioObligatorio: false,
      coarrendatarioAbarataPrima: false,
      etiquetaGestor: 'En revision manual',
    };
  }

  // 3. Rechazado (por el buro, o por el motor cuando decide).
  if (e.resultadoVigente === 'rechazado') {
    return { ruta: 'no_aprobable', ...NO_APROBABLE, etiquetaGestor: 'No aprobable — resultado registrado' };
  }

  // 4. Aprobado sin puntaje del scorecard: el buro aprobo y el modelo no pudo
  //    calcular. Se aprueba con la opcion abierta — ni "perfil fuerte" (no hay
  //    puntaje que lo justifique) ni "no aprobable" (contradiria el resultado).
  if (e.puntaje === null) {
    return {
      ruta: 'perfil_medio',
      titulo: 'Tu solicitud fue aprobada',
      mensaje:
        'Puedes continuar solo. Si prefieres, tambien puedes sumar un coarrendatario y obtener una prima mas baja: no necesita finca raiz.',
      puedeContinuarSolo: true,
      coarrendatarioObligatorio: false,
      coarrendatarioAbarataPrima: true,
      etiquetaGestor: 'Aprobado sin puntaje del modelo',
    };
  }

  // 5. Bandas de la Adenda §3.
  if (e.puntaje >= u.aprobacion) {
    return {
      ruta: 'perfil_fuerte',
      titulo: 'Tu solicitud fue aprobada',
      mensaje:
        'Puedes firmar el contrato tu solo, sin acompañante. Si quieres, un coarrendatario te baja la prima de vinculacion: no necesita finca raiz.',
      puedeContinuarSolo: true,
      coarrendatarioObligatorio: false,
      coarrendatarioAbarataPrima: true,
      etiquetaGestor: `Aprobado automatico (${e.puntaje} pts)`,
    };
  }

  if (e.puntaje >= u.zonaGris) {
    // Zona gris 70-84 COMPLETA: el coarrendatario es la palanca. Con uno que
    // obtenga >= UMBRAL_COARRENDATARIO por flujo automatico -> aprobacion
    // automatica condicionada; sin el, o con uno mas debil -> revision manual.
    const yaLoTiene =
      e.coarrendatarioVinculado &&
      e.puntajeCoarrendatario !== null &&
      e.puntajeCoarrendatario >= u.coarrendatario;

    return {
      ruta: 'coarrendatario_requerido',
      titulo: yaLoTiene ? 'Tu solicitud fue aprobada con acompañante' : 'Casi listo: necesitas un acompañante',
      mensaje: yaLoTiene
        ? 'Tu coarrendatario ya quedo vinculado y podemos respaldar el contrato.'
        : 'Podemos respaldar tu contrato si lo presentas junto a un coarrendatario. No necesita finca raiz: basta con que tenga ingresos propios.',
      puedeContinuarSolo: false,
      coarrendatarioObligatorio: true,
      coarrendatarioAbarataPrima: false,
      etiquetaGestor: yaLoTiene
        ? `Zona gris (${e.puntaje} pts) — aprobado con coarrendatario (${e.puntajeCoarrendatario} pts)`
        : `Zona gris (${e.puntaje} pts) — coarrendatario >= ${u.coarrendatario} o revision manual`,
    };
  }

  // < 70: el §5 es explicito — "ningun coarrendatario compensa" porque "el
  // afianzado es quien ocupa el inmueble".
  return { ruta: 'no_aprobable', ...NO_APROBABLE, etiquetaGestor: `No aprobable (${e.puntaje} pts)` };
}

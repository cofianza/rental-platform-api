/**
 * Las CUATRO RUTAS del resultado — Flujo de Gerencia, modulo de estudios, §10
 * "PASO 7 — RESULTADO".
 *
 * Texto literal del documento:
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
 * La decision ya la toman otros: las reglas duras (§6 de la Politica), el score
 * del buro y el scorecard. Este modulo NO decide nada — traduce una decision ya
 * tomada al lenguaje comercial que el §10 exige, y dice que puede hacer el
 * prospecto en cada caso (firmar solo, sumar coarrendatario, esperar).
 * Meter aqui una regla de negocio nueva seria un error: habria dos sitios
 * decidiendo lo mismo.
 *
 * ── LA RECONCILIACION DE LAS BANDAS (decision de implementacion, no del doc) ──
 *
 * Las dos tablas de la Politica V4.1 NO coinciden entre si:
 *
 *   §3 "Decision por puntaje"        §5 "Politica de coarrendatario"
 *     85-100  APROBADO AUTOMATICO      >= 80   sin coarrendatario requerido
 *     70-84   REVISION MANUAL          70-79   zona gris, coarrendatario obligatorio
 *     < 70    RECHAZADO                < 70    rechazo, ningun coarrendatario compensa
 *
 * Un puntaje de 82 cae en "revision manual" por §3 y en "no requiere
 * coarrendatario" por §5. La franja 80-84 es exactamente el desacuerdo.
 *
 * Se resuelve leyendo el §10 del Flujo como el desempate, porque describe
 * justamente esa franja: "Perfil medio. Aprobado con OPCION: puede continuar
 * solo o con coarrendatario, obteniendo en ese caso un menor valor de prima."
 * Un coarrendatario OPCIONAL que abarata la prima es, palabra por palabra, el
 * cruce entre "no lo requiero" (§5) y "no apruebo solo automaticamente" (§3).
 *
 * De ahi el mapa:
 *     >= 85    perfil_fuerte             (§3 aprobado automatico)
 *     80 - 84  perfil_medio              (§5 no lo requiere, §3 no lo aprueba solo)
 *     70 - 79  coarrendatario_requerido  (§5 zona gris)
 *     < 70     no_aprobable              (ambas coinciden)
 *
 * ESTO ES UNA INTERPRETACION, NO UNA CITA. Si Gerencia decide otra cosa, el
 * unico sitio a tocar son las constantes de abajo.
 *
 * ── POR QUE HAY UNA QUINTA SALIDA QUE EL DOCUMENTO NO NOMBRA ──────────────
 *
 * `en_revision` no es una quinta ruta: es el ESTADO mientras un analista
 * decide. El §10 describe las cuatro salidas FINALES, y varias cosas mandan un
 * caso a revision manual sin que ninguna de las cuatro aplique todavia (score
 * externo 450-599 por la jerarquia del §3, discrepancia entre fuentes,
 * ingreso no inferible). Mostrarle al prospecto "no aprobable" mientras un
 * humano aun no decide seria mentirle; mostrarle "aprobado" seria peor.
 */

/** Las cuatro rutas del §10, mas el estado transitorio de revision manual. */
export type RutaResultado =
  | 'perfil_fuerte'
  | 'perfil_medio'
  | 'coarrendatario_requerido'
  | 'no_aprobable'
  | 'en_revision';

// Cortes de puntaje normalizado (0-100) del scorecard V4.1. Ver la
// reconciliacion de arriba antes de moverlos.
export const CORTE_PERFIL_FUERTE = 85;
export const CORTE_PERFIL_MEDIO = 80;
export const CORTE_ZONA_GRIS = 70;

export interface EntradaRuta {
  /**
   * Puntaje normalizado 0-100 del scorecard V4.1. `null` cuando no se pudo
   * calcular (que hoy es lo normal: sin PILA ni ingreso inferido el DTI no
   * sale, ver [[ingreso-declarado-vs-inferido]]).
   */
  puntaje: number | null;
  /**
   * Resultado que hoy manda de verdad: viene del buro via scoreToResultado.
   * Mientras el scorecard siga en sombra, este es el dato con autoridad.
   */
  resultadoVigente: 'pendiente' | 'aprobado' | 'rechazado' | 'condicionado';
  /** Alguna regla dura del §6 se activo. Anula el puntaje por completo. */
  reglaDuraActivada: boolean;
  /** El expediente ya tiene un coarrendatario vinculado y evaluado. */
  coarrendatarioVinculado: boolean;
  /** Puntaje del coarrendatario, si fue evaluado. */
  puntajeCoarrendatario: number | null;
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
  /**
   * ¿Sumar un coarrendatario le abarata la prima? Solo en perfil_medio: es el
   * incentivo comercial que el §10 pide mostrar.
   */
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

/**
 * Traduce una decision ya tomada a la ruta del §10.
 *
 * El orden de los casos ES la jerarquia y no se puede reordenar:
 *   1. regla dura     — el §6 dice que anula el puntaje, gane lo que gane
 *   2. condicionado   — un humano todavia no decide; no adelantamos veredicto
 *   3. rechazado      — el buro ya dijo que no
 *   4. sin puntaje    — aprobado por buro pero sin scorecard calculable
 *   5. por bandas     — el caso normal el dia que el scorecard mande
 */
export function resolverRuta(e: EntradaRuta): Ruta {
  // 1. Regla dura: §6 de la Politica. Ni el mejor puntaje la compensa, y el
  //    coarrendatario tampoco ("Regla dura del coarrendatario contamina el
  //    conjunto", §5).
  if (e.reglaDuraActivada) {
    return {
      ruta: 'no_aprobable',
      titulo: 'Por ahora no podemos activar la fianza',
      mensaje:
        'Revisamos tu solicitud y en este momento no podemos respaldarla. Esto puede cambiar: abajo te contamos que ayuda a que si podamos.',
      puedeContinuarSolo: false,
      coarrendatarioObligatorio: false,
      coarrendatarioAbarataPrima: false,
      etiquetaGestor: 'No aprobable — regla dura activada',
    };
  }

  // 2. Revision manual en curso. NO es una de las cuatro rutas: es el estado
  //    mientras un analista decide. Ver la nota de arriba.
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

  // 3. El buro dijo que no. Es la unica autoridad hoy (el scorecard va en
  //    sombra), asi que su 'rechazado' manda aunque el puntaje sea alto.
  if (e.resultadoVigente === 'rechazado') {
    return {
      ruta: 'no_aprobable',
      titulo: 'Por ahora no podemos activar la fianza',
      mensaje:
        'Revisamos tu solicitud y en este momento no podemos respaldarla. Esto puede cambiar: abajo te contamos que ayuda a que si podamos.',
      puedeContinuarSolo: false,
      coarrendatarioObligatorio: false,
      coarrendatarioAbarataPrima: false,
      etiquetaGestor: 'No aprobable — resultado del buro',
    };
  }

  // 4. Aprobado por el buro pero sin puntaje del scorecard. Es el caso NORMAL
  //    hoy: sin PILA ni ingreso inferido el DTI no se calcula y el puntaje sale
  //    null. Tratarlo como perfil_fuerte seria inventarse un puntaje que nadie
  //    calculo; tratarlo como no_aprobable contradiria al buro. Se aprueba con
  //    la opcion abierta, que es la lectura conservadora y la que no le cierra
  //    la puerta a nadie.
  if (e.puntaje === null) {
    return {
      ruta: 'perfil_medio',
      titulo: 'Tu solicitud fue aprobada',
      mensaje:
        'Puedes continuar solo. Si prefieres, tambien puedes sumar un coarrendatario y obtener una prima mas baja: no necesita finca raiz.',
      puedeContinuarSolo: true,
      coarrendatarioObligatorio: false,
      coarrendatarioAbarataPrima: true,
      etiquetaGestor: 'Aprobado por el buro — sin puntaje del modelo',
    };
  }

  // 5. Por bandas del scorecard.
  if (e.puntaje >= CORTE_PERFIL_FUERTE) {
    return {
      ruta: 'perfil_fuerte',
      titulo: 'Tu solicitud fue aprobada',
      mensaje: 'Puedes firmar el contrato tu solo, sin acompañante. No necesitas nada mas.',
      puedeContinuarSolo: true,
      coarrendatarioObligatorio: false,
      coarrendatarioAbarataPrima: false,
      etiquetaGestor: `Perfil fuerte (${e.puntaje} pts)`,
    };
  }

  if (e.puntaje >= CORTE_PERFIL_MEDIO) {
    return {
      ruta: 'perfil_medio',
      titulo: 'Tu solicitud fue aprobada',
      mensaje:
        'Puedes continuar solo. Si prefieres, tambien puedes sumar un coarrendatario y obtener una prima mas baja: no necesita finca raiz.',
      puedeContinuarSolo: true,
      coarrendatarioObligatorio: false,
      coarrendatarioAbarataPrima: true,
      etiquetaGestor: `Perfil medio (${e.puntaje} pts) — coarrendatario opcional`,
    };
  }

  if (e.puntaje >= CORTE_ZONA_GRIS) {
    // Zona gris del §5: el coarrendatario es OBLIGATORIO. El documento pide que
    // la opcion de ir solo se muestre "bloqueada, sin precio y sin dramatismo".
    const yaLoTiene =
      e.coarrendatarioVinculado &&
      e.puntajeCoarrendatario !== null &&
      e.puntajeCoarrendatario >= CORTE_PERFIL_MEDIO;

    return {
      ruta: 'coarrendatario_requerido',
      titulo: yaLoTiene ? 'Tu solicitud fue aprobada con acompañante' : 'Casi listo: necesitas un acompañante',
      mensaje: yaLoTiene
        ? 'Tu coarrendatario ya quedo vinculado y podemos respaldar el contrato.'
        : 'Podemos respaldar tu contrato si lo presentas junto a un coarrendatario. No necesita finca raiz: basta con que tenga ingresos propios.',
      puedeContinuarSolo: false,
      coarrendatarioObligatorio: true,
      coarrendatarioAbarataPrima: false,
      etiquetaGestor: `Zona gris (${e.puntaje} pts) — coarrendatario obligatorio`,
    };
  }

  // < 70: el §5 es explicito — "ningun coarrendatario compensa" porque "el
  // afianzado es quien ocupa el inmueble".
  return {
    ruta: 'no_aprobable',
    titulo: 'Por ahora no podemos activar la fianza',
    mensaje:
      'Revisamos tu solicitud y en este momento no podemos respaldarla. Esto puede cambiar: abajo te contamos que ayuda a que si podamos.',
    puedeContinuarSolo: false,
    coarrendatarioObligatorio: false,
    coarrendatarioAbarataPrima: false,
    etiquetaGestor: `No aprobable (${e.puntaje} pts)`,
  };
}

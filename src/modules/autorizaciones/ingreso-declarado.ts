/**
 * Ingreso DECLARADO por el prospecto (Flujo §8.2) — funcion pura.
 *
 * Existe por una contradiccion real entre los dos documentos de Gerencia:
 *
 *   Flujo §8.2 le pregunta al prospecto cuanto recibe al mes.
 *   Politica de Evaluacion y Score V4.1 §4.2, literal: "El ingreso mensual es
 *   INFERIDO AUTOMATICAMENTE POR EL SISTEMA a partir de las fuentes
 *   disponibles. Cuando hay mas de una fuente, se toma el valor mas
 *   conservador (el menor) [...] Si el solicitante considera que el ingreso
 *   inferido es inferior al real, puede aportar documentacion EN EL PROCESO DE
 *   REVISION MANUAL."
 *
 * Se resuelve asi: el declarado NUNCA es fuente del scorecard. Ni del DTI
 * (§4.2), ni de la relacion canon/ingreso (§4.3), ni de las dos unicas reglas
 * duras vivas (dti_mayor_65, canon_ingreso_mayor_40). Vive en su propia
 * columna (autorizacion_perfil_prospecto.ingreso_declarado_cop) y tiene
 * exactamente dos usos:
 *
 *   1. mostrarselo al gestor interno y a la revision manual, etiquetado;
 *   2. la SENAL de discrepancia que la propia Politica contempla, y que es lo
 *      unico que hay en este archivo.
 *
 * La senal se calcula AL VUELO en el endpoint de lectura y jamas se persiste
 * ni se devuelve al motor. Por eso vive aqui y no en src/modules/estudios/:
 * ese directorio entero tiene prohibido nombrar el ingreso declarado, y
 * scripts/check-ingreso-declarado.ts lo verifica con un grep.
 */

/**
 * Umbral de la senal. La Politica habla de ">30% para el IBC reportado" y de
 * ">40% entre dos fuentes primarias"; el declarado no es ninguna de las dos —
 * es autorreportado, o sea la fuente mas manipulable que existe — asi que se
 * usa el umbral mas laxo de los dos para no llenar de ruido al gestor.
 */
export const DISCREPANCIA_INGRESO_PCT = 40;

/**
 * ¿El ingreso declarado se aleja del inferido lo suficiente como para pedir
 * una mirada humana?
 *
 * Devuelve null — no "false" — cuando falta cualquiera de los dos, y ESO ES LO
 * NORMAL HOY: TransUnion no entrega ingreso inferido por ningun nodo del combo
 * 1901 (features.ts lo marca 'no_soportado'), asi que con el proveedor actual
 * esta funcion no dispara nunca. Es deliberado. La ausencia del inferido NO se
 * rellena con el declarado: eso taparia la brecha de fuentes en vez de
 * arreglarla, y envenenaria el dataset con el que Gerencia va a calibrar los
 * umbrales 85/70.
 */
export function senalDiscrepanciaIngreso(
  declaradoCop: number | null | undefined,
  inferidoCop: number | null | undefined,
): { hay: boolean; desviacion_pct: number } | null {
  if (typeof declaradoCop !== 'number' || !Number.isFinite(declaradoCop) || declaradoCop <= 0) return null;
  if (typeof inferidoCop !== 'number' || !Number.isFinite(inferidoCop) || inferidoCop <= 0) return null;
  const desviacion = (Math.abs(declaradoCop - inferidoCop) / inferidoCop) * 100;
  return {
    hay: desviacion > DISCREPANCIA_INGRESO_PCT,
    desviacion_pct: Math.round(desviacion * 100) / 100,
  };
}

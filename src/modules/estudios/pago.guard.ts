/**
 * Gate de PAGO del estudio + la decision de ORDEN del flujo §6.3.
 *
 * ─────────────────────────────────────────────────────────────
 * POR QUE EXISTE
 * ─────────────────────────────────────────────────────────────
 * El flujo de Gerencia, modulo de estudios, §6.3 "Opcion C — Enlace de pago al
 * prospecto" fija el orden: el pago se solicita DESPUES de que el prospecto
 * otorgue la autorizacion y ANTES de que el motor ejecute la evaluacion.
 * ("si se cobra antes de autorizar, se cobra a personas que nunca autorizan;
 * si se cobra despues del resultado, se ejecutan evaluaciones que nadie paga").
 *
 * Hasta 2026-09-04 el orden real del codigo era el inverso (PAGO → AUTORIZACION
 * → EJECUCION) y de esa invariante colgaba la seguridad del dinero: nadie
 * verificaba el pago antes de consultar el buro porque el pago SIEMPRE venia
 * antes. Al invertir el orden, `onHabeasDataAutorizado` pasa a ser alcanzable
 * sin pago, y `ejecutarEstudio` consume una consulta FACTURABLE e IRREVERSIBLE.
 * De ahi este archivo: la barrera que antes daba el orden ahora la da un gate.
 *
 * ─────────────────────────────────────────────────────────────
 * LA SEÑAL
 * ─────────────────────────────────────────────────────────────
 * Una fila en `pagos` con expediente_id + concepto='estudio' + estado='completado'.
 * Ahi terminan los TRES caminos de cobro (credito prepago = opcion A, la
 * inmobiliaria asume = opcion B, link al prospecto = opcion C), y el indice
 * `uq_pagos_estudio_activo` garantiza que hay como maximo una. Por eso el gate
 * es por EXPEDIENTE y no por estudio: el estudio del co-arrendatario y el hijo
 * de re-evaluacion no tienen ni pueden tener pago propio, y se amparan en el
 * del titular. Y por eso los expedientes historicos ya pagados pasan sin
 * migracion ni backfill: su fila ya existe.
 *
 * ponytail: el gate mira la EXISTENCIA de la fila, no su monto. El precio lo
 * fija el emisor —los tres caminos leen `getMontoEstudio()` y ninguna ruta
 * acepta ya el monto del cliente para concepto='estudio'— asi que re-validarlo
 * aqui seria una segunda lectura del config en el camino caliente para atrapar
 * un caso que ya no se puede fabricar. Si algun dia una ruta vuelve a aceptar
 * un monto libre, este es el sitio donde falta el contraste.
 *
 * NO se apoya en `estudios.estado`: `submitFormulario` (publico, por token)
 * mueve un estudio a 'formulario_completado' desde cualquier estado no final,
 * asi que el estado del estudio no es una barrera de dinero.
 *
 * ─────────────────────────────────────────────────────────────
 * UNA LECTURA, DOS POLITICAS
 * ─────────────────────────────────────────────────────────────
 * El mismo SELECT estaba escrito dos veces con politicas CONTRARIAS
 * (estudios.service.ts fail-open para el tope, reasignacion.service.ts
 * fail-closed con 503). Aqui conviven, que es lo que evita que se
 * desincronicen:
 *
 *   - `leerSenalPagoEstudio` hace la lectura UNA vez y devuelve la señal cruda.
 *   - `assertPagoEstudio` (fail-CLOSED) la traduce a error accionable. Un error
 *     de lectura NO puede convertirse en "seguro ya estaba pagado" y disparar
 *     una consulta que cuesta dinero real: responde 503, que ademas es honesto
 *     (reintentar sirve).
 *   - `senalIndicaPagado` (fail-OPEN a la baja) es el interruptor
 *     bloquear/advertir del tope de canon §4.4: ahi "no pude verificar" tiene
 *     que comportarse como "no pagado" para que el tope bloquee.
 *
 * Se invoca ANTES del lock a 'en_proceso' y ANTES de cualquier llamada al
 * proveedor, por la misma razon que el gate 8.4 (ver autorizacion.guard.ts):
 * un estudio bloqueado aqui no consume consulta ni queda colgado en
 * 'en_proceso'.
 */

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/** El estudio no figura pagado — no se consulta el buro. */
export const PAGO_ESTUDIO_REQUERIDO_ERROR_CODE = 'PAGO_ESTUDIO_REQUERIDO';
/** No es un "no pago": es un "no pude verificar". Reintentar sirve. */
export const PAGO_NO_VERIFICABLE_ERROR_CODE = 'PAGO_ESTUDIO_NO_VERIFICABLE';
/** El estudio queda aparcado aqui mientras se espera el pago (§6.3). */
export const ESTADO_ESPERANDO_PAGO = 'pago_pendiente';

/** Resultado crudo de la lectura de la señal de pago. */
export type SenalPagoEstudio = 'pagado' | 'no_pagado' | 'no_verificable';

/** Lee la señal canonica UNA vez. No lanza: quien decide es el caller. */
export async function leerSenalPagoEstudio(expedienteId: string): Promise<SenalPagoEstudio> {
  const { data, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('expediente_id', expedienteId)
    .eq('concepto', 'estudio')
    .eq('estado', 'completado')
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error(
      { error: error.message, expedienteId },
      'No se pudo verificar el pago del estudio (señal no verificable)',
    );
    return 'no_verificable';
  }
  return data ? 'pagado' : 'no_pagado';
}

/**
 * ¿Se puede tratar como pagado? Fail-OPEN a la baja: "no pude verificar" cuenta
 * como NO pagado. Es el interruptor bloquear/advertir del tope de canon (§4.4),
 * NO el gate de dinero — para eso esta `assertPagoEstudio`.
 */
export function senalIndicaPagado(senal: SenalPagoEstudio): boolean {
  return senal === 'pagado';
}

/**
 * Igual que el par leer+senalIndicaPagado, en una sola llamada. Se conserva el
 * nombre historico porque es el que usan el tope de canon y la re-evaluacion.
 */
export async function estudioYaCobrado(expedienteId: string): Promise<boolean> {
  return senalIndicaPagado(await leerSenalPagoEstudio(expedienteId));
}

/**
 * Traduce la señal a error accionable. FUNCION PURA a proposito: la logica del
 * gate se puede ejercitar sin Supabase (ver scripts/check-orden-pago-estudio.ts).
 *
 * `origen` decide el codigo y el mensaje sin tocar los call-sites que ya
 * existian: la reasignacion §4.3 conserva ESTUDIO_NO_REASIGNABLE (que la web ya
 * consume) y la ejecucion estrena PAGO_ESTUDIO_REQUERIDO.
 */
export function assertPagoEstudio(
  senal: SenalPagoEstudio,
  ctx: { origen: 'ejecutar' | 'reasignacion'; expedienteNumero?: string | null },
): void {
  if (senal === 'pagado') return;

  if (senal === 'no_verificable') {
    throw new AppError(
      503,
      PAGO_NO_VERIFICABLE_ERROR_CODE,
      ctx.origen === 'reasignacion'
        ? 'No pudimos verificar el pago de este estudio en este momento, asi que no lo reasignamos. ' +
            'Intenta de nuevo en un momento.'
        : 'No pudimos verificar el pago de este estudio en este momento, asi que no lo ejecutamos. ' +
            'Intenta de nuevo en un momento.',
    );
  }

  if (ctx.origen === 'reasignacion') {
    throw new AppError(
      409,
      'ESTUDIO_NO_REASIGNABLE',
      `El estudio del expediente ${ctx.expedienteNumero ?? ''} no figura como pagado, y la reasignacion sin costo ` +
        'del §4.3 aplica solo a estudios ya pagados y ejecutados. Completa el pago y vuelve a intentarlo.',
      { motivo: 'estudio_no_pagado' },
    );
  }

  throw new AppError(
    409,
    PAGO_ESTUDIO_REQUERIDO_ERROR_CODE,
    'El estudio de este expediente todavia no figura como pagado, asi que no se consulta a centrales de riesgo. ' +
      'Se ejecuta solo apenas se confirme el pago del arrendatario, o cuando la inmobiliaria asuma el costo o libere un credito.',
    { motivo: 'estudio_no_pagado' },
  );
}

/** Azucar: lee la señal y la asserta. Para los call-sites que no reusan la lectura. */
export async function assertEstudioPagado(
  expedienteId: string,
  ctx: { origen: 'ejecutar' | 'reasignacion'; expedienteNumero?: string | null },
): Promise<void> {
  assertPagoEstudio(await leerSenalPagoEstudio(expedienteId), ctx);
}

// ============================================================
// La decision de ORDEN del §6.3 (funcion PURA)
// ============================================================

/**
 * Que corresponde hacer con el estudio de un expediente, dado lo que ya paso.
 *
 * Es la unica codificacion del orden nuevo, y es pura para poder ejercitarla en
 * el check. La consumen los tres eventos que pueden llegar en cualquier orden:
 * el gestor elige "Enviar link al arrendatario" (enviarLinkPago), el prospecto
 * firma (onHabeasDataAutorizado) y el pago se confirma (onEstudioPagado).
 *
 *   'pedir_autorizacion' → todavia no autorizo: se le manda el habeas data y NO
 *                          se cobra. Es la inversion literal del §6.3.
 *   'cobrar'             → ya autorizo y el pagador es el prospecto (opcion C):
 *                          recien ahora se crea el link de pago.
 *   'esperar_pago'       → ya autorizo, el cobro ya esta en marcha (link vivo) o
 *                          el pagador lo define el gestor: el estudio queda EN
 *                          ESPERA y no consume consultas a centrales.
 *   'ejecutar'           → autorizacion + pago: unico caso en que se va al buro.
 */
export type PasoEstudio = 'pedir_autorizacion' | 'cobrar' | 'esperar_pago' | 'ejecutar';

export function siguientePasoEstudio(input: {
  /** Firma del TITULAR vigente (mismo predicado que el gate 8.4). */
  autorizado: boolean;
  /** Señal canonica de pago del expediente. */
  senalPago: SenalPagoEstudio;
  /** Hay una fila de pago viva (pendiente/procesando) — el cobro ya salio. */
  pagoActivo: boolean;
  /** `estudios.pago_por`: 'arrendatario' = opcion C. null = el gestor no decidio. */
  pagoPor: string | null;
}): PasoEstudio {
  if (!input.autorizado) return 'pedir_autorizacion';
  // "no_verificable" NO ejecuta: fail-closed tambien aqui.
  if (input.senalPago === 'pagado') return 'ejecutar';
  if (input.pagoActivo) return 'esperar_pago';
  // Sin cobro en marcha: solo se le cobra al prospecto si el gestor eligio la
  // opcion C. Si todavia no decidio (pago_por null), el estudio espera y el
  // aviso va al gestor — cobrarle al prospecto por defecto le pisaria la
  // decision (podia querer usar un credito).
  return input.pagoPor === 'arrendatario' ? 'cobrar' : 'esperar_pago';
}

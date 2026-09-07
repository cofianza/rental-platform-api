/**
 * Expiracion del estudio por falta de autorizacion — Flujo de Gerencia,
 * modulo de estudios.
 *
 * §12 CASOS BORDE, literal:
 *   "El prospecto no autoriza. El estudio expira transcurrido el plazo
 *    definido. El solicitante puede reenviar la solicitud sin costo adicional
 *    mientras no se haya ejecutado el motor."
 *
 * §14 PUNTOS PENDIENTES DE DEFINICION, ya resuelto por Gerencia:
 *   "Plazo de expiracion. 15 dias"
 *
 * §11 ESTADOS DEL ESTUDIO:
 *   "Expirado. El prospecto no autorizo dentro del plazo definido."
 *
 * ── POR QUE ESTO SE DERIVA Y NO SE PERSISTE ──────────────────────────────
 *
 * "Expirado" NO se agrega al enum `estado_estudio`, por la misma razon que no
 * se agrego "reasignado" (ver la migracion 20260903000006): la lista del §11
 * es de estados que ve el PROSPECTO, no del enum — incluye tambien "Borrador"
 * y "Esperando autorizacion", que tampoco son valores del enum.
 *
 * Agregar el valor romperia en cascada ESTADOS_ESTUDIO_EN_CURSO, los estados
 * permitidos de ejecucion, el gate del certificado y fn_registrar_resultado_estudio,
 * y a cambio no ganariamos nada: la expiracion es una funcion del RELOJ, no un
 * hecho que alguien decida. Un estudio "expira" solo con que pase el tiempo,
 * asi que persistirlo obligaria a un cron cuyo unico trabajo seria escribir lo
 * que una resta de fechas ya dice.
 *
 * Y no hay ningun recurso retenido que liberar: desde el §4.2 habilitar un
 * estudio ya NO bloquea el inmueble, asi que dejarlo abierto no le cuesta nada
 * a nadie. Lo unico que hacia falta era dejar de contarlo como "en curso" y
 * decirselo al gestor.
 *
 * ── EL RELOJ ARRANCA CUANDO SE LE PIDE LA AUTORIZACION AL PROSPECTO ──────
 *
 * No cuando se crea el estudio. Un estudio puede pasar dias en el panel antes
 * de que el gestor decida la forma de pago (§6), y ese tiempo no es del
 * prospecto: el §12 habla de "el prospecto no autoriza", asi que el plazo
 * cuenta desde que se le pidio. Si nunca se le pidio, no puede expirar.
 *
 * ponytail: funcion pura sobre fechas. Sin cron, sin columna, sin migracion.
 */

/** §14: "Plazo de expiracion. 15 dias". */
export const PLAZO_EXPIRACION_DIAS = 15;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

export interface ContextoExpiracion {
  /** Estado actual del estudio (valor del enum estado_estudio). */
  estado: string | null | undefined;
  /**
   * Cuando se le pidio la autorizacion al prospecto (created_at de la fila de
   * `autorizaciones_habeas_data` del titular). `null` = nunca se le pidio.
   */
  autorizacionSolicitadaEn: string | null;
  /** Si el titular ya firmo, el plazo dejo de correr: no hay nada que expirar. */
  autorizacionFirmada: boolean;
  /** Momento de referencia, inyectado para poder ejercitarlo. */
  ahoraMs: number;
  /** Plazo en dias. Por defecto el del §14. */
  plazoDias?: number;
}

export interface VeredictoExpiracion {
  expirado: boolean;
  /** Dias que quedan. Negativo cuando ya expiro; null si el reloj no corre. */
  diasRestantes: number | null;
  /** Fecha en que expira (ISO), o null si el reloj no corre. */
  expiraEn: string | null;
  motivo: string;
}

/**
 * Estados en los que el estudio TODAVIA espera al prospecto. Fuera de estos el
 * reloj no corre: 'en_proceso' y posteriores significan que el motor ya arranco
 * —o sea que la autorizacion llego— y los finales ya no esperan nada.
 *
 * Se escriben por extension, igual que ESTADOS_ESTUDIO_EN_CURSO: un valor nuevo
 * del enum NO expira hasta que alguien lo ponga aqui a proposito.
 */
const ESTADOS_QUE_ESPERAN_AL_PROSPECTO: readonly string[] = [
  'solicitado',
  'pago_pendiente',
  'pagado',
  'formulario_enviado',
];

export function evaluarExpiracion(ctx: ContextoExpiracion): VeredictoExpiracion {
  const plazoDias = ctx.plazoDias ?? PLAZO_EXPIRACION_DIAS;

  if (ctx.autorizacionFirmada) {
    return {
      expirado: false,
      diasRestantes: null,
      expiraEn: null,
      motivo: 'El prospecto ya autorizo: el plazo dejo de correr.',
    };
  }

  if (!ESTADOS_QUE_ESPERAN_AL_PROSPECTO.includes(ctx.estado ?? '')) {
    return {
      expirado: false,
      diasRestantes: null,
      expiraEn: null,
      motivo: 'El estudio no esta esperando la autorizacion del prospecto.',
    };
  }

  if (!ctx.autorizacionSolicitadaEn) {
    return {
      expirado: false,
      diasRestantes: null,
      expiraEn: null,
      motivo: 'Todavia no se le ha pedido la autorizacion al prospecto: el plazo no ha empezado.',
    };
  }

  const inicioMs = new Date(ctx.autorizacionSolicitadaEn).getTime();
  if (Number.isNaN(inicioMs)) {
    // Fecha ilegible: NO expirar. Un estudio que expira por un dato corrupto es
    // peor que uno que se queda abierto de mas — este no le cuesta nada a nadie.
    return {
      expirado: false,
      diasRestantes: null,
      expiraEn: null,
      motivo: 'No se pudo leer la fecha de la solicitud de autorizacion.',
    };
  }

  const venceMs = inicioMs + plazoDias * MS_POR_DIA;
  const restantesMs = venceMs - ctx.ahoraMs;

  return {
    expirado: restantesMs <= 0,
    diasRestantes: Math.ceil(restantesMs / MS_POR_DIA),
    expiraEn: new Date(venceMs).toISOString(),
    motivo:
      restantesMs <= 0
        ? `El prospecto no autorizo dentro de los ${plazoDias} dias. Puedes reenviarle la solicitud sin costo adicional.`
        : `Esperando la autorizacion del prospecto. Vence en ${Math.ceil(restantesMs / MS_POR_DIA)} dia(s).`,
  };
}

/**
 * ¿Este estudio sigue contando como "en curso" para el indicador del §4.2?
 *
 * Un estudio expirado deja de contar: el gestor no puede hacer nada con el
 * salvo reenviar, y seguir mostrandolo como activo infla el contador de
 * candidatos en paralelo que ve sobre la propiedad.
 */
export function cuentaComoEnCurso(ctx: ContextoExpiracion, esEstadoEnCurso: boolean): boolean {
  if (!esEstadoEnCurso) return false;
  return !evaluarExpiracion(ctx).expirado;
}

// ============================================================
// Estudios simultaneos por inmueble — y la reserva que los cierra.
//
// Flujo de Gerencia, modulo de estudios, seccion 4.2 (CAMBIO APROBADO,
// literal): "Una misma propiedad debe admitir varios estudios en curso de
// manera simultanea. La propiedad NO se bloquea porque exista un estudio en
// proceso. [...] La propiedad se marca como reservada y deja de admitir nuevos
// estudios unicamente cuando un estudio resulta APROBADO y avanza a la
// generacion del contrato."
//
// Justificacion de negocio (del mismo documento): una inmobiliaria muestra el
// mismo inmueble a varios interesados a la vez y necesita evaluarlos en
// paralelo, sin saber cual autorizara ni cual sera aprobado. Bloquear al primer
// estudio obliga a esperar y manda los demas candidatos a otra afianzadora.
//
// ── LA DECISION SOBRE 'en_estudio' ────────────────────────────────────────
//
// 'en_estudio' DEJA DE ESCRIBIRSE. El valor NO se elimina del enum
// estado_inmueble (hay filas historicas y ~14 archivos que lo nombran), pero
// ningun camino nuevo lo produce: mientras hay estudios en curso el inmueble
// se queda 'disponible'.
//
// Por que asi y no "conservarlo como estado informativo no bloqueante":
//
//   1. La REGLA CANONICA DE VITRINA de la auditoria previa es
//      "publicado <=> visible_vitrina = true AND estado = 'disponible'".
//      Esta escrita en ~8 sitios del backend (public-properties, interesados,
//      vitrina.createInterest, dashboard.countVitrinaPublicados,
//      toggleVisibility, la coercion del PUT) y otros tantos de la web.
//      Conservar 'en_estudio' obligaria a convertir cada uno de esos
//      `estado = 'disponible'` en `estado IN ('disponible','en_estudio')`.
//      Son mas sitios, cada uno es una oportunidad de reintroducir el doble
//      arriendo, y el que se olvide falla en silencio (un inmueble
//      invisible, o peor: uno reservado que sigue publicado).
//
//   2. El indicador de estudios activos (§4.2 "se muestra un indicador con el
//      numero de estudios activos") ya transporta esa informacion, y la
//      transporta MEJOR: dice cuantos, no solo que hay alguno. Un estado que
//      dice "en estudio" cuando el inmueble esta perfectamente disponible es
//      un dato falso; un contador de 3 no lo es.
//
//   3. 'en_estudio' era ademas un estado MENTIROSO ya hoy: el camino real del
//      piloto (fn_habilitar_estudio_expediente, propietario/inmobiliaria) lo
//      escribia fuera de la transaccion y solo desde 'disponible', asi que el
//      segundo estudio pasaba igual y el estado no representaba nada. Los 4
//      inmuebles atascados en 'en_estudio' en produccion (2026-09-03) no
//      tenian NI UN estudio en curso.
//
// Lo que NO cambia: 'ocupado' sigue bloqueando exactamente igual que hoy.
//
// ── DONDE QUEDA LA PROTECCION CONTRA EL DOBLE ARRIENDO ────────────────────
//
// Se corre del INICIO (bloquear al primer estudio) al FINAL (reservar al
// aprobar). La regla nueva, en una linea:
//
//   el estado del inmueble sigue el ciclo del CONTRATO, no el del ESTUDIO.
//
// Por eso ningun RPC de estudios vuelve a tocar `inmuebles.estado`: ni al
// crear, ni al cancelar, ni al registrar resultado. Cancelar el estudio de UN
// candidato entre varios no puede cambiar el estado de la propiedad.
//
// La reserva la toma `fn_reservar_inmueble_para_contrato`, que corre dentro de
// generarContrato — el chokepoint por el que pasan los dos caminos que llevan
// de un expediente aprobado a un contrato (aprobarCondicionado y
// generarContratoExpediente). La atomicidad es de la base: SELECT ... FOR
// UPDATE sobre la fila del inmueble mas un TITULAR ESCALAR
// (`inmuebles.reservado_por_expediente_id`). Una fila, una columna, un titular:
// dos aprobaciones concurrentes no pueden producir dos reservas ni con la
// planificacion mas adversa, porque la segunda transaccion se bloquea en el
// FOR UPDATE y al despertar lee el titular ya escrito.
//
// (Un indice unico parcial sobre `contratos` seria la red de seguridad
// equivalente, pero `contratos` no tiene `inmueble_id` — llega al inmueble por
// `expediente_id` — y Postgres no admite un indice unico que cruce tablas. La
// columna escalar en `inmuebles` da la misma garantia estructural: no hay dos
// valores posibles en una sola celda.)
//
// ── ESTE ARCHIVO ──────────────────────────────────────────────────────────
//
// Mismo patron que tope-canon.guard.ts y autorizacion.guard.ts: las decisiones
// viven en funciones PURAS, ejercitadas sin Supabase por
// scripts/check-estudios-simultaneos.ts; los asserts solo resuelven insumos y
// traducen el veredicto a un AppError.
// ============================================================

import { AppError } from '@/lib/errors';

// ============================================================
// 1. Que es un "estudio en curso"
// ============================================================

/**
 * Estados FINALES de un estudio. Es la misma lista que estudios.service.ts ya
 * usaba como criterio de "activo" (createEstudio, enviarEnlace) desde antes de
 * este cambio; se centraliza aqui para que el contador del indicador y el
 * guard de admision no puedan divergir de ella.
 *
 * Matiz deliberado sobre 'fallido': cuenta como NO-en-curso aunque sea
 * REINTENTABLE (ESTADOS_PERMITIDOS_EJECUCION lo admite). Es lo correcto para
 * el indicador — un estudio caido por un timeout del buro no es un candidato
 * compitiendo por la propiedad — y no cierra ninguna puerta, porque el
 * reintento reusa el MISMO registro y no necesita crear otro estudio.
 */
export const ESTADOS_ESTUDIO_FINALES = ['completado', 'fallido', 'cancelado'] as const;

/**
 * Los 8 estados en curso del enum estado_estudio, por extension. Se escriben
 * completos (y no como "el enum menos los finales") porque el indicador que ve
 * el gestor no puede depender de que nadie agregue un valor al enum sin
 * pensarlo: un valor nuevo NO cuenta como en curso hasta que alguien lo ponga
 * aqui a proposito.
 */
export const ESTADOS_ESTUDIO_EN_CURSO = [
  'solicitado',
  'pago_pendiente',
  'pagado',
  'autorizado',
  'formulario_enviado',
  'formulario_completado',
  'documentos_cargados',
  'en_proceso',
] as const;

export function esEstudioEnCurso(estado: string | null | undefined): boolean {
  if (!estado) return false;
  return (ESTADOS_ESTUDIO_EN_CURSO as readonly string[]).includes(estado);
}

/** Cuantos de estos estudios estan en curso. El numero del indicador del §4.2. */
export function contarEstudiosEnCurso(
  estudios: ReadonlyArray<{ estado?: string | null } | null | undefined>,
): number {
  return estudios.filter((e) => esEstudioEnCurso(e?.estado)).length;
}

// ============================================================
// 2. Admision de un estudio nuevo
// ============================================================

/** Codigo de dominio de la unica causa que hoy cierra la puerta. */
export const INMUEBLE_RESERVADO_ERROR_CODE = 'INMUEBLE_RESERVADO';

export interface ContextoAdmisionEstudio {
  /** `inmuebles.estado`. */
  estadoInmueble: string | null | undefined;
  /** `inmuebles.reservado_por_expediente_id`: quien tiene la reserva, o null. */
  reservadoPorExpedienteId?: string | null;
  /**
   * Expediente para el que se quiere el estudio. Si coincide con el titular de
   * la reserva NO se bloquea: el candidato reservado puede seguir moviendo su
   * propio caso (p. ej. el estudio del co-arrendatario).
   */
  expedienteId?: string | null;
  /**
   * Cuantos estudios hay ya en curso sobre el inmueble. Se recibe SOLO para
   * dejar constancia de que no influye en la decision (§4.2: "la propiedad NO
   * se bloquea porque exista un estudio en proceso").
   */
  estudiosEnCurso?: number;
}

export type MotivoNoAdmision = 'reservado' | 'ocupado' | 'inactivo';

export type VeredictoAdmisionEstudio =
  | { admite: true; estudiosEnCurso: number }
  | { admite: false; motivo: MotivoNoAdmision; reservadoPorExpedienteId: string | null };

/**
 * ¿Puede nacer un estudio nuevo sobre este inmueble?
 *
 * Las tres unicas causas de NO, todas ajenas al numero de estudios:
 *   - 'inactivo': el dueño lo dio de baja (soft-delete). Nunca fue admisible.
 *   - 'ocupado' SIN titular de reserva: arrendado de verdad (contrato vigente,
 *     o activacion manual / contrato en papel). Es el bloqueo que YA existia y
 *     que este cambio NO toca.
 *   - 'ocupado' CON titular != este expediente: reservado para un candidato
 *     aprobado que va camino al contrato. Es el bloqueo NUEVO, el que sustituye
 *     al de 'en_estudio'.
 *
 * Todo lo demas admite, sin importar cuantos estudios haya en curso — incluido
 * 'en_estudio', que es legado y hay que seguir admitiendo mientras queden filas
 * viejas sin normalizar.
 */
export function evaluarAdmisionDeEstudio(
  contexto: ContextoAdmisionEstudio,
): VeredictoAdmisionEstudio {
  const estudiosEnCurso = contexto.estudiosEnCurso ?? 0;
  const titular = contexto.reservadoPorExpedienteId ?? null;

  if (contexto.estadoInmueble === 'inactivo') {
    return { admite: false, motivo: 'inactivo', reservadoPorExpedienteId: titular };
  }

  if (contexto.estadoInmueble === 'ocupado') {
    // El propio titular de la reserva sigue pudiendo mover su caso.
    if (titular && contexto.expedienteId && titular === contexto.expedienteId) {
      return { admite: true, estudiosEnCurso };
    }
    return {
      admite: false,
      motivo: titular ? 'reservado' : 'ocupado',
      reservadoPorExpedienteId: titular,
    };
  }

  return { admite: true, estudiosEnCurso };
}

/** Mensaje del §13: accionable, sin la palabra "rechazado" y sin portazo. */
export function mensajeNoAdmision(motivo: MotivoNoAdmision): string {
  switch (motivo) {
    case 'reservado':
      return (
        'Esta propiedad quedo reservada para un candidato aprobado y su contrato ya esta en proceso, ' +
        'asi que no admite estudios nuevos. Puedes iniciar el estudio sobre otra propiedad.'
      );
    case 'ocupado':
      return (
        'Esta propiedad ya esta arrendada. Para volver a estudiarla hay que terminar o cancelar ' +
        'el contrato vigente desde el detalle del inmueble.'
      );
    case 'inactivo':
      return 'Esta propiedad esta inactiva. Reactivala desde el detalle del inmueble para poder estudiarla.';
  }
}

export function errorNoAdmision(
  veredicto: Extract<VeredictoAdmisionEstudio, { admite: false }>,
): AppError {
  return new AppError(409, INMUEBLE_RESERVADO_ERROR_CODE, mensajeNoAdmision(veredicto.motivo), {
    motivo: veredicto.motivo,
    reservado_por_expediente_id: veredicto.reservadoPorExpedienteId,
  });
}

// ============================================================
// 3. La reserva: el CAS que impide el doble arriendo
// ============================================================

export const INMUEBLE_YA_RESERVADO_ERROR_CODE = 'INMUEBLE_YA_RESERVADO';

export interface ContextoReserva {
  /** Estado del inmueble LEIDO BAJO EL LOCK (SELECT ... FOR UPDATE). */
  estadoInmueble: string | null | undefined;
  /** Titular actual de la reserva, leido bajo el mismo lock. */
  reservadoPorExpedienteId?: string | null;
  /** Expediente aprobado que intenta reservar. */
  expedienteId: string;
  /**
   * ¿Hay un contrato VIGENTE sobre el inmueble por otro expediente? Es el caso
   * "arrendado de verdad" sin titular de reserva anotado: filas anteriores a
   * esta migracion, o activaciones manuales.
   */
  tieneContratoVigenteAjeno?: boolean;
}

export type ResultadoReserva =
  /** Gano el CAS: hay que escribir el titular y sacarlo de la vitrina. */
  | { accion: 'reservar'; expedienteId: string }
  /** Ya lo tenia este mismo expediente: idempotente, no se reescribe nada. */
  | { accion: 'ya_reservado_por_este'; expedienteId: string }
  /** Perdio: otro expediente se llevo la propiedad. El caller debe fallar 409. */
  | { accion: 'conflicto'; motivo: MotivoNoAdmision; titular: string | null };

/**
 * Decision de reserva, PURA. Es la mitad de arriba de
 * `fn_reservar_inmueble_para_contrato`: lo que la RPC hace con la fila ya
 * bloqueada. Se escribe aparte para poder simular aqui las dos aprobaciones
 * concurrentes sin una base de datos.
 *
 * La secuencia real de dos aprobaciones simultaneas, y por que solo puede
 * haber una reserva:
 *
 *   T1: SELECT ... FOR UPDATE  -> estado='disponible', titular=NULL
 *       decidirReserva -> 'reservar' -> UPDATE titular=A, estado='ocupado'
 *       COMMIT
 *   T2: se BLOQUEA en el FOR UPDATE hasta el COMMIT de T1; al despertar
 *       Postgres le entrega la version NUEVA de la fila -> titular=A
 *       decidirReserva -> 'conflicto' -> 409
 *
 * No hay orden de ejecucion en el que las dos escriban: el lock es sobre la
 * fila del inmueble, y el titular es una sola celda de esa fila.
 */
export function decidirReserva(contexto: ContextoReserva): ResultadoReserva {
  const titular = contexto.reservadoPorExpedienteId ?? null;

  if (contexto.estadoInmueble === 'inactivo') {
    return { accion: 'conflicto', motivo: 'inactivo', titular };
  }

  // Idempotencia primero: reintentar la generacion del contrato (o generarlo
  // dos veces desde la pestaña Contratos) no puede fallar con 409 contra uno
  // mismo.
  if (titular && titular === contexto.expedienteId) {
    return { accion: 'ya_reservado_por_este', expedienteId: contexto.expedienteId };
  }

  if (titular) {
    return { accion: 'conflicto', motivo: 'reservado', titular };
  }

  // Sin titular anotado pero ya arrendado: 'ocupado' con contrato vigente
  // ajeno. Preserva el bloqueo que existia antes de esta columna.
  if (contexto.estadoInmueble === 'ocupado' || contexto.tieneContratoVigenteAjeno === true) {
    return { accion: 'conflicto', motivo: 'ocupado', titular: null };
  }

  // 'disponible' y el legado 'en_estudio' se reservan igual.
  return { accion: 'reservar', expedienteId: contexto.expedienteId };
}

export function errorReservaPerdida(
  resultado: Extract<ResultadoReserva, { accion: 'conflicto' }>,
): AppError {
  return new AppError(
    409,
    INMUEBLE_YA_RESERVADO_ERROR_CODE,
    resultado.motivo === 'reservado'
      ? 'Otro candidato fue aprobado primero y esta propiedad ya quedo reservada para su contrato. ' +
          'Este expediente sigue vigente: puedes usarlo para otra propiedad.'
      : mensajeNoAdmision(resultado.motivo),
    { motivo: resultado.motivo, reservado_por_expediente_id: resultado.titular },
  );
}

// ============================================================
// 4. La regla canonica de vitrina — se preserva intacta
// ============================================================

/**
 * REGLA CANONICA de la auditoria "vitrina vs ocupado", sin un solo cambio:
 *
 *   publicado <=> visible_vitrina = true AND estado = 'disponible'
 *
 * Este cambio NO la toca. Lo unico que cambia es CUANTOS inmuebles califican:
 * al dejar de escribir 'en_estudio', un inmueble con estudios en curso se
 * queda 'disponible' y por lo tanto sigue publicable — que es exactamente lo
 * que pide el §4.2. Y al reservar con 'ocupado', el inmueble reservado sale de
 * la vitrina por la misma regla de siempre, sin logica nueva.
 *
 * Se escribe aqui, y se ejercita en el check, para que quede una prueba de que
 * la regla sobrevivio al cambio.
 */
export function esPublicableEnVitrina(inmueble: {
  estado: string | null | undefined;
  visible_vitrina?: boolean | null;
}): boolean {
  return inmueble.visible_vitrina === true && inmueble.estado === 'disponible';
}

/**
 * ¿El inmueble admite que el dueño lo publique? (toggleVisibility). Es la misma
 * regla mirada desde el otro lado: solo depende del estado, no del flag.
 * Un inmueble con 3 estudios en curso SI se puede publicar.
 */
export function puedePublicarseEnVitrina(estado: string | null | undefined): boolean {
  return estado === 'disponible';
}

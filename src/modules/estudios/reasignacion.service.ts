// ============================================================
// Reasignacion de un estudio a otra propiedad (Flujo §4.3).
//
// El §4.2 ya deja el caso planteado: cuando un candidato aprobado reserva la
// propiedad, "los demas estudios en curso se notifican al solicitante y quedan
// disponibles para reasignarse a otro inmueble". Esto es esa reasignacion.
//
// La REGLA (tolerancia +15% y recalculo canon/ingreso <= 40%) vive en
// portabilidad.ts, que es puro y se ejercita sin Supabase. Aqui solo estan los
// insumos, los guards y el movimiento.
//
// ── QUE SE MUEVE: `expedientes.inmueble_id` ──────────────────────────────
//
// De las tres formas posibles de "llevar el estudio a otra propiedad", esta es
// la unica que no rompe nada. Las otras dos, y por que no:
//
//   A. Mover `estudios.expediente_id` a otro expediente.
//      - El COBRO esta atado al EXPEDIENTE, no al estudio:
//        `uq_pagos_estudio_activo` es UNIQUE (expediente_id) WHERE
//        concepto='estudio'. El expediente destino nacería sin pago, o sea
//        "no pagado" para todo el sistema: los flujos de cobro (credito,
//        inmobiliaria asume, link al prospecto) volverian a ofrecer cobrar.
//        Doble cobro, directo.
//      - La AUTORIZACION de habeas data del titular se busca por
//        `expediente_id` (autorizacion.guard.ts): movido el estudio, cualquier
//        reintento fallaria con 'sin_autorizacion' sobre una firma que SI
//        existe.
//
//   B. Crear un expediente nuevo con un estudio hijo.
//      - Obliga a inventar una fila en `pagos` que no corresponde a plata
//        movida, o a dejar el expediente sin pago (mismo doble cobro).
//      - Obliga a COPIAR `respuesta_proveedor` (el payload crudo del buro) a
//        una segunda fila: duplicar datos financieros personales sin una
//        finalidad nueva (Ley 1581, minimizacion).
//      - Obliga a duplicar o re-apuntar la autorizacion: fabricar evidencia de
//        consentimiento para un expediente que la persona nunca vio.
//      - `estudio_padre_id` ya esta ocupado por la re-evaluacion.
//
// Moviendo `expedientes.inmueble_id`, en cambio, TODO viaja junto y nada se
// duplica: el pago sigue siendo uno, la autorizacion sigue apuntando al mismo
// expediente, el estudio conserva su id, su `respuesta_proveedor` y su fila
// sombra (y su certificado conserva codigo y vencimiento, aunque se reimprima
// con la propiedad nueva). Cero filas nuevas en `pagos`, cero cobros.
//
// El precio, y se paga a conciencia: el historial del expediente queda hablando
// de dos propiedades (la cita ya realizada fue a la vieja). Por eso la
// reasignacion escribe un evento de timeline con las dos propiedades, los dos
// canones y el veredicto de las dos condiciones — el historial no queda mudo,
// queda explicado.
//
// Y por eso mismo, todo lo que NO puede quedar hablando de dos propiedades se
// resuelve explicitamente, porque ni `contratos` ni `citas` ni el PDF del
// certificado guardan el inmueble por su cuenta:
//   - un expediente que ya genero contrato NO se reasigna (el contrato no puede
//     cambiar de objeto despues de emitido);
//   - una visita viva bloquea hasta que el gestor la cancele o reprograme (si
//     no, el solicitante recibiria una direccion que nadie acordo);
//   - el certificado emitido se REGENERA con la propiedad nueva (mismo codigo,
//     mismo vencimiento), porque el PDF es inmutable y /verificar deriva la
//     propiedad del expediente: sin regenerarlo, un mismo codigo describiria
//     dos propiedades distintas;
//   - el destino tiene que ser de la MISMA cartera: de la propiedad se deriva
//     quien ve el expediente, asi que cruzar de agencia mudaria datos
//     personales de cartera.
//
// ── POR QUE **NO** SE AGREGA EL ESTADO 'reasignado' DEL §11 ───────────────
//
// El §11 lista "Reasignado" entre los estados que ve el prospecto, pero esa
// lista no es el enum de la base (incluye tambien "Borrador", "Esperando
// autorizacion" y "Expirado", que tampoco son valores de `estado_estudio`).
// En este diseño el estudio NO se mueve ni cambia de estado: sigue
// 'completado', que es la verdad — su resultado del buro no cambio porque el
// inmueble si.
//
// Agregarlo al enum romperia, en cascada: ESTADOS_ESTUDIO_FINALES (y con el el
// contador de estudios en curso del §4.2), ESTADOS_PERMITIDOS_EJECUCION (se
// perderia el reintento), el guard `estado !== 'completado'` del certificado
// (el estudio portado dejaria de poder certificarse, que es justo lo que el
// prospecto necesita en la propiedad nueva) y fn_registrar_resultado_estudio.
// "Reasignado" se resuelve como ETIQUETA DERIVADA: hay reasignacion si existe
// una fila en `estudios_reasignaciones` (o el evento de timeline).
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { getCompany } from '@/lib/companyConfig';
import { assertExpedienteAccess, assertInmuebleAccess } from '@/lib/tenantScope';
import {
  evaluarPortabilidad,
  errorNoPortable,
  type VeredictoCanonIngreso,
} from './portabilidad';
import { formatearCOP } from './tope-canon.guard';
import {
  evaluarAdmisionDeEstudio,
  errorNoAdmision,
  ESTADOS_ESTUDIO_EN_CURSO,
} from './estudios-simultaneos.guard';
import { generarCertificado } from './certificado.service';

/** El estudio no esta en condiciones de portarse (estado, pago o expediente). */
export const ESTUDIO_NO_REASIGNABLE_ERROR_CODE = 'ESTUDIO_NO_REASIGNABLE';
/** No se pudo confirmar el pago. No es un "no pago": es un "no pude verificar". */
export const PAGO_NO_VERIFICABLE_ERROR_CODE = 'PAGO_ESTUDIO_NO_VERIFICABLE';

/**
 * Estados terminales del expediente. Misma lista que estudios.service.ts: un
 * expediente cerrado o rechazado no se muda de propiedad, se archiva.
 */
const ESTADOS_TERMINALES_EXPEDIENTE = ['cerrado', 'rechazado'];

/**
 * Citas que todavia apuntan a una visita que puede ocurrir. `citas` NO guarda
 * inmueble: resuelve la direccion por `expediente.inmueble` en tiempo de
 * lectura, asi que una cita viva sobreviviria al traslado mostrando —y
 * notificando— la direccion de la propiedad NUEVA.
 */
const ESTADOS_CITA_VIVA = ['solicitada', 'confirmada'];

/** Fecha legible para los mensajes al gestor. Bogota, como el resto del sistema. */
function formatearFecha(iso: string | null): string {
  if (!iso) return 'sin fecha';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'sin fecha';
  return new Date(t).toLocaleDateString('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

interface EstudioParaReasignar {
  id: string;
  expediente_id: string;
  estado: string;
  resultado: string | null;
  tipo: string;
  fecha_completado: string | null;
  canon_evaluado: number | string | null;
  canon_evaluado_origen: string | null;
}

interface ExpedienteParaReasignar {
  id: string;
  numero: string | null;
  estado: string;
  inmueble_id: string | null;
  solicitante_id: string | null;
  inmobiliaria_id: string | null;
  miembro_responsable_id: string | null;
}

interface InmuebleParaReasignar {
  id: string;
  codigo: string | null;
  direccion: string | null;
  valor_arriendo: number | string | null;
  estado: string | null;
  reservado_por_expediente_id: string | null;
  inmobiliaria_id: string | null;
  propietario_id: string | null;
}

export interface ResultadoReasignacion {
  expediente_id: string;
  expediente_numero: string | null;
  estudio_id: string;
  inmueble_origen_id: string;
  inmueble_destino_id: string;
  canon_origen_cop: number;
  canon_destino_cop: number;
  canon_maximo_tolerado_cop: number;
  tolerancia_pct: number;
  canon_ingreso_destino_pct: number | null;
  veredicto_canon_ingreso: VeredictoCanonIngreso;
  /** Vigencia ORIGINAL, no recalculada. null si el estudio no tiene fecha. */
  vigencia_hasta: string | null;
  /** Siempre false: el §4.3 es explicito en que la reutilizacion no cobra. */
  se_cobro: boolean;
  /**
   * Que paso con el certificado ya emitido, si lo habia. El PDF es inmutable y
   * nombra la propiedad ORIGEN, mientras /verificar deriva la propiedad del
   * expediente: sin regenerarlo, el mismo codigo describia dos propiedades.
   *
   *   'sin_certificado' -> no habia ninguno emitido; nada que hacer.
   *   'regenerado'      -> mismo codigo, version+1, mismo vencimiento.
   *   'desactualizado'  -> la regeneracion fallo; el gestor tiene que
   *                        regenerarlo a mano antes de entregarlo.
   */
  certificado: 'sin_certificado' | 'regenerado' | 'desactualizado';
}

/**
 * ¿El estudio de este expediente esta REALMENTE pagado?
 *
 * Deliberadamente NO reusa `estudioYaCobrado` de estudios.service.ts: aquel es
 * best-effort A LA BAJA (si la consulta falla asume "no pagado") porque su uso
 * es el interruptor entre bloquear y advertir en el tope. Aqui el lado seguro
 * es el CONTRARIO: la reasignacion REGALA una evaluacion, asi que un error de
 * lectura no puede convertirse en "sigamos, seguro estaba pagado". Falla
 * CERRADO con 503, que ademas es la respuesta honesta (reintentar sirve).
 *
 * La señal es la misma que usa todo el sistema: una fila en `pagos` con
 * concepto='estudio' y estado='completado' para el expediente. Ahi terminan los
 * tres caminos de cobro (credito prepago, la inmobiliaria asume, link al
 * prospecto), y el indice `uq_pagos_estudio_activo` garantiza que hay como
 * maximo una.
 */
async function assertEstudioPagado(expedienteId: string, expedienteNumero: string | null): Promise<void> {
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
      'Reasignacion §4.3: no se pudo verificar el pago del estudio — no se reasigna (fail closed)',
    );
    throw new AppError(
      503,
      PAGO_NO_VERIFICABLE_ERROR_CODE,
      'No pudimos verificar el pago de este estudio en este momento, asi que no lo reasignamos. ' +
        'Intenta de nuevo en un momento.',
    );
  }

  if (!data) {
    throw new AppError(
      409,
      ESTUDIO_NO_REASIGNABLE_ERROR_CODE,
      `El estudio del expediente ${expedienteNumero ?? ''} no figura como pagado, y la reasignacion sin costo ` +
        'del §4.3 aplica solo a estudios ya pagados y ejecutados. Completa el pago y vuelve a intentarlo.',
      { motivo: 'estudio_no_pagado' },
    );
  }
}

/**
 * Ingreso mensual inferido de la corrida original.
 *
 * Vive en `estudios_scorecard_sombra.ingreso_inferido_cop`, que es la tabla del
 * motor sombra. Leerla para DECIDIR es incomodo a proposito (el nombre lleva
 * "sombra" justamente para que quien la use lo piense), asi que aqui se trata
 * como EVIDENCIA BEST-EFFORT y no como fuente de verdad:
 *
 *   - si no hay fila, o el buro no reporto ingreso (TransUnion nunca lo hace),
 *     o la consulta falla -> devuelve null, y la condicion del 40% queda
 *     'no_evaluable', que NO bloquea (ver portabilidad.ts).
 *   - se ordena por `fecha_calculo DESC` porque el UNIQUE es
 *     (estudio_id, modelo_version): al cambiar de version del modelo conviven
 *     dos filas y la que vale es la ultima.
 *
 * DEUDA EXPLICITA: el hogar correcto de este dato es un `ingreso_evaluado_cop`
 * congelado en `estudios`, escrito por el punto de decision (reglas-duras.ts,
 * que ya escribe `regla_dura_activada` y tiene el ingreso en la mano). Eso
 * queda para la iteracion que pueda tocar el punto de decision; hasta entonces
 * se lee de aqui y se persiste el veredicto en la traza para que la decision
 * sea auditable aunque la fila sombra cambie despues.
 */
async function leerIngresoInferidoOriginal(estudioId: string): Promise<number | null> {
  try {
    const { data, error } = await (supabase
      .from('estudios_scorecard_sombra' as string) as ReturnType<typeof supabase.from>)
      .select('ingreso_inferido_cop')
      .eq('estudio_id', estudioId)
      .order('fecha_calculo', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.warn(
        { estudioId, error: error.message },
        'Reasignacion §4.3: no se pudo leer el ingreso inferido — la condicion canon/ingreso queda no evaluable',
      );
      return null;
    }

    const bruto = (data as { ingreso_inferido_cop?: number | string | null } | null)
      ?.ingreso_inferido_cop;
    const n = typeof bruto === 'string' ? Number(bruto) : bruto;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) {
    logger.warn(
      { estudioId, err: err instanceof Error ? err.message : String(err) },
      'Reasignacion §4.3: excepcion leyendo el ingreso inferido — condicion no evaluable',
    );
    return null;
  }
}

/**
 * Cuantos estudios hay en curso sobre el inmueble destino. Solo alimenta el
 * indicador del §4.2: NO decide nada (la propiedad no se bloquea porque tenga
 * estudios en proceso). Best-effort.
 */
async function contarEstudiosEnCursoDelInmueble(inmuebleId: string): Promise<number> {
  const { data } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('inmueble_id', inmuebleId);
  const ids = ((data as Array<{ id: string }> | null) ?? []).map((e) => e.id);
  if (ids.length === 0) return 0;
  const { count } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .in('expediente_id', ids)
    .in('estado', ESTADOS_ESTUDIO_EN_CURSO as unknown as string[]);
  return count ?? 0;
}

/**
 * ¿El expediente ya genero un contrato sobre la propiedad actual?
 *
 * `contratos` NO tiene columna de inmueble: tanto el listado como la generacion
 * derivan la propiedad de `expedientes.inmuebles` en tiempo de lectura. Movido
 * el expediente, un contrato ya emitido —aunque este cancelado— empieza a
 * listarse sobre una propiedad que nunca documento, y el scoping por cartera se
 * va con el (el dueño del inmueble original pierde el acceso a su contrato y el
 * del destino gana acceso a uno ajeno).
 *
 * Se mira en CUALQUIER estado, no solo en los activos, y por eso no basta con
 * los guards que ya existen: un contrato cancelado antes de firmar libera la
 * reserva (`reservado_por_expediente_id` deja de apuntar aqui) y no cambia el
 * estado del expediente, asi que se colaba entre los dos.
 *
 * Fail closed: si la consulta falla no se reasigna. Es una lectura barata y el
 * daño de equivocarse es un contrato hablando de otra propiedad.
 */
async function assertExpedienteSinContratos(
  expedienteId: string,
  expedienteNumero: string | null,
): Promise<void> {
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado')
    .eq('expediente_id', expedienteId)
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error(
      { error: error.message, expedienteId },
      'Reasignacion §4.3: no se pudieron verificar los contratos del expediente — no se reasigna (fail closed)',
    );
    throw new AppError(
      503,
      PAGO_NO_VERIFICABLE_ERROR_CODE,
      'No pudimos verificar si este expediente ya genero un contrato, asi que no lo reasignamos. ' +
        'Intenta de nuevo en un momento.',
    );
  }

  const contrato = data as { id: string; numero: string | null; estado: string } | null;
  if (contrato) {
    throw new AppError(
      409,
      ESTUDIO_NO_REASIGNABLE_ERROR_CODE,
      `El expediente ${expedienteNumero ?? ''} ya genero el contrato ${contrato.numero ?? contrato.id} ` +
        `(${contrato.estado}) sobre la propiedad actual, y ese contrato no puede quedar hablando de otra. ` +
        'Crea un expediente nuevo para la otra propiedad — el estudio de este ya esta pagado y su ' +
        'resultado sigue disponible.',
      { motivo: 'expediente_con_contrato', contrato_id: contrato.id, estado: contrato.estado },
    );
  }
}

/**
 * ¿Hay una visita viva sobre la propiedad actual?
 *
 * Se BLOQUEA en vez de cancelar en cascada: cancelar aqui significaria mandar
 * notificaciones (WhatsApp con direccion) desde un servicio cuyo trabajo es
 * mover un expediente, y dejar al gestor sin decidir sobre una visita que quiza
 * quiere reprogramar en la propiedad nueva. El mensaje dice exactamente que
 * hacer.
 *
 * Fail closed por el mismo motivo que los contratos: el daño de seguir es
 * mandar a alguien a una direccion que nadie acordo visitar.
 */
async function assertExpedienteSinCitasVivas(
  expedienteId: string,
  expedienteNumero: string | null,
): Promise<void> {
  const { data, error } = await (supabase
    .from('citas' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .in('estado', ESTADOS_CITA_VIVA)
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error(
      { error: error.message, expedienteId },
      'Reasignacion §4.3: no se pudieron verificar las citas del expediente — no se reasigna (fail closed)',
    );
    throw new AppError(
      503,
      PAGO_NO_VERIFICABLE_ERROR_CODE,
      'No pudimos verificar las visitas agendadas de este expediente, asi que no lo reasignamos. ' +
        'Intenta de nuevo en un momento.',
    );
  }

  const cita = data as { id: string; estado: string } | null;
  if (cita) {
    throw new AppError(
      409,
      ESTUDIO_NO_REASIGNABLE_ERROR_CODE,
      `El expediente ${expedienteNumero ?? ''} tiene una visita ${cita.estado} para la propiedad actual. ` +
        'Si la reasignas, esa visita pasaria a mostrar la direccion de la propiedad nueva sin que nadie ' +
        'lo haya acordado. Cancelala o reprogramala primero y vuelve a intentarlo.',
      { motivo: 'cita_viva', cita_id: cita.id, estado: cita.estado },
    );
  }
}

/**
 * Regenera el certificado del estudio DESPUES del traslado, si habia uno.
 *
 * El PDF es inmutable y lleva impresos la direccion, el codigo y el canon del
 * inmueble ORIGEN; `verificarCertificado`, en cambio, deriva la propiedad de
 * `expedientes.inmueble_id` en tiempo de lectura. Sin esto, el MISMO codigo de
 * certificado describia dos propiedades distintas segun por donde se lo mirara
 * —el PDF una y el QR otra—, que es exactamente el aspecto de un documento
 * adulterado.
 *
 * Regenerar conserva `codigo` (sube `version`) y, como la vigencia esta anclada
 * en `estudios.fecha_completado`, reimprime el MISMO `fecha_vencimiento`: no se
 * regala vigencia, que es la otra promesa del §4.3.
 *
 * NUNCA lanza: el expediente ya se movio y no se revierte por el PDF. Lo que
 * hace es DECIR que quedo desactualizado, para que la UI lo advierta en vez de
 * dejar circulando un certificado que nombra la propiedad equivocada.
 */
async function regenerarCertificadoTrasTraslado(args: {
  estudioId: string;
  userId: string;
  userRol?: string;
  ip?: string;
}): Promise<ResultadoReasignacion['certificado']> {
  const { estudioId, userId, userRol, ip } = args;

  const { data, error } = await (supabase
    .from('estudios_certificados' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('estudio_id', estudioId)
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error(
      { estudioId, error: error.message },
      'Reasignacion §4.3: no se pudo consultar el certificado del estudio — se advierte como desactualizado',
    );
    return 'desactualizado';
  }
  if (!data) return 'sin_certificado';

  try {
    await generarCertificado(estudioId, userId, ip, userRol);
    logger.info({ estudioId }, 'Reasignacion §4.3: certificado regenerado con la propiedad nueva');
    return 'regenerado';
  } catch (err) {
    logger.error(
      { estudioId, err: err instanceof Error ? err.message : String(err) },
      'Reasignacion §4.3: no se pudo regenerar el certificado — queda describiendo la propiedad anterior',
    );
    return 'desactualizado';
  }
}

/**
 * Vigencia ORIGINAL del estudio, en ISO.
 *
 * Se ancla en `fecha_completado` (la fecha en que el dato del buro estuvo
 * vigente) y NO en la emision del certificado. Es lo que hace que la promesa
 * del §4.3 —"el estudio conserva su vigencia original; la reutilizacion no la
 * extiende"— se cumpla por construccion: si se anclara en la emision, bastaria
 * con regenerar el certificado despues de reasignar para ganar 60 dias nuevos.
 *
 * La ventana es la misma que la del certificado (`certificateValidityDays`),
 * porque hoy es la unica vigencia en dias que existe en el sistema: los
 * `estudios` no tienen caducidad propia. Si algun dia la tienen, este es el
 * lugar donde cambiarla.
 */
async function vigenciaOriginalISO(fechaCompletado: string | null): Promise<string | null> {
  if (!fechaCompletado) return null;
  const base = new Date(fechaCompletado).getTime();
  if (!Number.isFinite(base)) return null;
  const dias = (await getCompany()).certificateValidityDays;
  return new Date(base + dias * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Mueve el expediente de un estudio ya pagado y ejecutado a otra propiedad, sin
 * cobrar ni descontar credito, conservando la vigencia original.
 */
export async function reasignarEstudio(args: {
  estudioId: string;
  inmuebleDestinoId: string;
  userId: string;
  userRol?: string;
  ip?: string;
}): Promise<ResultadoReasignacion> {
  const { estudioId, inmuebleDestinoId, userId, userRol, ip } = args;

  // 1. El estudio.
  const { data: estudioRow, error: estudioError } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, estado, resultado, tipo, fecha_completado, canon_evaluado, canon_evaluado_origen')
    .eq('id', estudioId)
    .maybeSingle();

  if (estudioError) throw fromSupabaseError(estudioError);
  if (!estudioRow) throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  const estudio = estudioRow as unknown as EstudioParaReasignar;

  // 2. Tenant guard ANTES de exponer o mutar nada. Sin esto, un rol externo con
  //    expedientes:update movia el expediente de OTRA agencia por UUID.
  await assertExpedienteAccess(estudio.expediente_id, userId, userRol);

  // 3. El estudio tiene que estar COMPLETADO. El §4.3 dice "ya pagado y
  //    ejecutado": un 'fallido' no se ejecuto (y ademas es reintentable sobre
  //    el mismo registro, asi que no necesita portarse), un 'cancelado' es un
  //    callejon sin salida y uno en curso todavia no produjo nada que reusar.
  if (estudio.estado !== 'completado') {
    throw new AppError(
      409,
      ESTUDIO_NO_REASIGNABLE_ERROR_CODE,
      'Solo se puede reasignar un estudio ya ejecutado (completado). ' +
        `Este estudio esta en estado "${estudio.estado}".`,
      { motivo: 'estado_no_completado', estado: estudio.estado },
    );
  }

  // 3.b VIGENCIA ORIGINAL. El §4.3 promete que "el estudio conserva su vigencia
  //     original; la reutilizacion no la extiende" — y de ahi se sigue que un
  //     estudio que ya la agoto no tiene nada que conservar. Trasladarlo seria
  //     un callejon sin salida: en la propiedad nueva no se le podria emitir
  //     certificado (certificado.service.ts rechaza con ESTUDIO_VENCIDO por la
  //     misma ventana), y si ya tenia uno, la regeneracion del paso 10.b
  //     fallaria y el certificado se quedaria nombrando la propiedad anterior.
  //     Se dice antes, con la salida del §13, en vez de mover el expediente
  //     para nada.
  const vigenciaHasta = await vigenciaOriginalISO(estudio.fecha_completado);
  if (vigenciaHasta !== null && new Date(vigenciaHasta).getTime() <= Date.now()) {
    throw new AppError(
      409,
      ESTUDIO_NO_REASIGNABLE_ERROR_CODE,
      `Este estudio se completo el ${formatearFecha(estudio.fecha_completado)} y su vigencia ya termino ` +
        `(${formatearFecha(vigenciaHasta)}). La reutilizacion del §4.3 conserva la vigencia original y no la ` +
        'extiende, asi que para esta propiedad se requiere una evaluacion nueva. ' +
        'No se genero ningun cobro ni se descuento ningun credito.',
      { motivo: 'estudio_fuera_de_vigencia', vigencia_hasta: vigenciaHasta },
    );
  }

  // 4. El expediente.
  const { data: expedienteRow, error: expedienteError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, inmueble_id, solicitante_id, inmobiliaria_id, miembro_responsable_id')
    .eq('id', estudio.expediente_id)
    .maybeSingle();

  if (expedienteError) throw fromSupabaseError(expedienteError);
  if (!expedienteRow) {
    throw AppError.notFound('Expediente asociado al estudio no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }
  const expediente = expedienteRow as unknown as ExpedienteParaReasignar;

  if (ESTADOS_TERMINALES_EXPEDIENTE.includes(expediente.estado)) {
    throw new AppError(
      409,
      ESTUDIO_NO_REASIGNABLE_ERROR_CODE,
      `El expediente ${expediente.numero ?? ''} esta ${expediente.estado} y ya no se traslada a otra propiedad.`,
      { motivo: 'expediente_terminal', estado: expediente.estado },
    );
  }

  if (!expediente.inmueble_id) {
    throw AppError.badRequest(
      'El expediente no tiene una propiedad asociada, asi que no hay nada que reasignar.',
      ESTUDIO_NO_REASIGNABLE_ERROR_CODE,
    );
  }

  if (expediente.inmueble_id === inmuebleDestinoId) {
    throw AppError.badRequest(
      'El expediente ya esta sobre esa propiedad.',
      ESTUDIO_NO_REASIGNABLE_ERROR_CODE,
      { motivo: 'mismo_inmueble' },
    );
  }

  // 5. PAGADO. Es el guard que impide que la reasignacion se convierta en una
  //    puerta para saltarse el cobro de una evaluacion. Falla cerrado.
  await assertEstudioPagado(expediente.id, expediente.numero);

  // 6. La RESERVA del ORIGEN. Si este expediente es el titular de la reserva,
  //    su contrato ya esta en curso: mudarlo de propiedad dejaria el inmueble
  //    origen 'ocupado' para siempre, con un titular apuntando a un expediente
  //    que ya no lo ocupa. La salida correcta es terminar o cancelar el
  //    contrato desde el inmueble (que SI libera la reserva), no esta.
  const { data: origenRow, error: origenError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('id, codigo, direccion, reservado_por_expediente_id, inmobiliaria_id, propietario_id')
    .eq('id', expediente.inmueble_id)
    .maybeSingle();
  if (origenError) throw fromSupabaseError(origenError);
  const origen = origenRow as unknown as Pick<
    InmuebleParaReasignar,
    | 'id'
    | 'codigo'
    | 'direccion'
    | 'reservado_por_expediente_id'
    | 'inmobiliaria_id'
    | 'propietario_id'
  > | null;

  if (origen?.reservado_por_expediente_id === expediente.id) {
    throw new AppError(
      409,
      ESTUDIO_NO_REASIGNABLE_ERROR_CODE,
      `Este expediente tiene reservada la propiedad ${origen.codigo ?? origen.direccion ?? ''} para su contrato. ` +
        'Termina o cancela ese contrato desde el detalle del inmueble y luego reasigna el estudio.',
      { motivo: 'expediente_titular_de_reserva' },
    );
  }

  // 6.b CONTRATOS. Ni `contratos` ni `citas` guardan el inmueble: los dos lo
  //     derivan del expediente en tiempo de lectura, asi que ambos se mudarian
  //     de propiedad sin decirlo. Los dos guards van juntos y ANTES de tocar
  //     nada del destino, porque los dos se resuelven mirando solo este
  //     expediente y los dos tienen una accion clara para el gestor.
  await assertExpedienteSinContratos(expediente.id, expediente.numero);

  // 6.c CITAS vivas.
  await assertExpedienteSinCitasVivas(expediente.id, expediente.numero);

  // 7. El DESTINO. Guard de tenant tambien aqui: la reasignacion escribe el
  //    expediente sobre este inmueble, asi que llevarlo a una propiedad ajena
  //    seria mover datos personales a la cartera de otra agencia.
  await assertInmuebleAccess(inmuebleDestinoId, userId, userRol);

  const { data: destinoRow, error: destinoError } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, codigo, direccion, valor_arriendo, estado, reservado_por_expediente_id, inmobiliaria_id, propietario_id',
    )
    .eq('id', inmuebleDestinoId)
    .maybeSingle();
  if (destinoError) throw fromSupabaseError(destinoError);
  if (!destinoRow) throw AppError.notFound('Inmueble no encontrado', 'INMUEBLE_NOT_FOUND');
  const destino = destinoRow as unknown as InmuebleParaReasignar;

  // 7.b MISMA CARTERA. Este guard es el que faltaba, y lo que protege no es un
  //     numero sino datos personales.
  //
  //     La reasignacion reescribe `expedientes.inmueble_id`, y de la PROPIEDAD
  //     se deriva quien ve el expediente (`resolveAllowedExpedienteIds` arma el
  //     scope por cartera de inmuebles). Llevarlo a un inmueble de otra
  //     organizacion mudaba el expediente ENTERO —solicitante, documentos y el
  //     `respuesta_proveedor` del buro— a la cartera de una agencia ajena: la
  //     que PAGO el estudio lo perdia de su lista sin aviso, y la otra heredaba
  //     gratis un estudio pagado y el historial crediticio de una persona que
  //     autorizo el tratamiento frente a alguien mas (Ley 1581: finalidad).
  //
  //     Y era un clic: para los roles internos `assertInmuebleAccess` es no-op
  //     y el modal lista todo el inventario. Se niega por defecto; si algun dia
  //     hace falta el traslado entre agencias, es una accion aparte, explicita
  //     y con su propia traza — no un efecto colateral de elegir mal en una
  //     lista.
  //
  //     Cuando no hay organizacion (cartera de un propietario individual) el
  //     dueño es `inmuebles.propietario_id`, y el traslado entre dos
  //     propietarios distintos tendria exactamente el mismo efecto.
  //     Se compara contra el INMUEBLE ORIGEN y no solo contra
  //     `expedientes.inmobiliaria_id`, porque el acceso se deriva de la
  //     propiedad; el `inmobiliaria_id` del expediente esta denormalizado y, si
  //     alguna vez difiere, la unica salida segura es no mover nada. De ahi el
  //     `orgExpediente === null || orgExpediente === orgDestino`: exige que
  //     tampoco contradiga al expediente cuando este si tiene organizacion.
  const orgExpediente = expediente.inmobiliaria_id ?? null;
  const orgOrigen = origen?.inmobiliaria_id ?? null;
  const orgDestino = destino.inmobiliaria_id ?? null;
  const duenioOrigen = origen?.propietario_id ?? null;
  const duenioDestino = destino.propietario_id ?? null;
  const mismaOrg =
    orgDestino === orgOrigen && (orgExpediente === null || orgExpediente === orgDestino);
  // Sin organizacion, el dueño de la cartera es el propietario individual.
  const mismoDuenio = orgDestino !== null || duenioDestino === duenioOrigen;
  const mismaCartera = mismaOrg && mismoDuenio;

  if (!mismaCartera) {
    logger.warn(
      {
        estudioId: estudio.id,
        expedienteId: expediente.id,
        inmuebleOrigenId: expediente.inmueble_id,
        inmuebleDestinoId: destino.id,
        orgExpediente,
        orgOrigen,
        orgDestino,
        duenioOrigen,
        duenioDestino,
        userId,
        userRol,
      },
      'Reasignacion §4.3 negada: el inmueble destino pertenece a otra cartera',
    );
    throw new AppError(
      409,
      ESTUDIO_NO_REASIGNABLE_ERROR_CODE,
      `La propiedad ${destino.codigo ?? destino.direccion ?? 'de destino'} pertenece a otra cartera. ` +
        'Un estudio solo se reutiliza dentro de la misma agencia o del mismo propietario: trasladarlo ' +
        'moveria el expediente completo —con los datos del solicitante y el resultado del buro— a una ' +
        'cartera distinta. Elige una propiedad de esta misma cartera.',
      { motivo: 'cambio_de_cartera' },
    );
  }

  // 8. ADMISION del destino (§4.2). Se reusa el guard: reservado por otro
  //    candidato, arrendado o inactivo cierran la puerta; el numero de estudios
  //    en curso NO. La reasignacion tampoco TOMA la reserva — la reserva es del
  //    contrato (fn_reservar_inmueble_para_contrato), no del estudio.
  const admision = evaluarAdmisionDeEstudio({
    estadoInmueble: destino.estado,
    reservadoPorExpedienteId: destino.reservado_por_expediente_id,
    expedienteId: expediente.id,
    estudiosEnCurso: await contarEstudiosEnCursoDelInmueble(destino.id),
  });
  if (!admision.admite) throw errorNoAdmision(admision);

  // 9. PORTABILIDAD (§4.3). El tope de canon del destino se evalua DENTRO de
  //    esta funcion, con la misma `evaluarTopeCanon` del §4.4 — no se duplica
  //    la regla ni se la salta.
  const ingresoOriginal = await leerIngresoInferidoOriginal(estudio.id);
  const veredicto = evaluarPortabilidad({
    canonOriginal: estudio.canon_evaluado,
    ingresoOriginal,
    canonDestino: destino.valor_arriendo,
  });

  if (!veredicto.portable) {
    logger.info(
      {
        estudioId: estudio.id,
        expedienteId: expediente.id,
        inmuebleOrigenId: expediente.inmueble_id,
        inmuebleDestinoId: destino.id,
        motivo: veredicto.motivo,
        canonOriginalCop: veredicto.canonOriginalCop,
        canonDestinoCop: veredicto.canonDestinoCop,
        veredictoCanonIngreso: veredicto.veredictoCanonIngreso,
      },
      'Reasignacion §4.3 no permitida — se requiere una evaluacion nueva',
    );
    throw errorNoPortable(veredicto);
  }

  // 10. EL MOVIMIENTO. Un solo UPDATE, condicionado al inmueble de origen (CAS):
  //     si otra request ya movio el expediente, esta no pisa el resultado.
  //
  //     SOLO se escribe el inmueble. `inmobiliaria_id` no se toca porque el
  //     guard 7.b ya garantiza que la cartera es la misma; antes se reescribia
  //     junto con el responsable, que es precisamente como el expediente
  //     cambiaba de dueño.
  const { data: movidas, error: updateError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .update({
      inmueble_id: destino.id,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', expediente.id)
    .eq('inmueble_id', expediente.inmueble_id)
    .select('id');

  if (updateError) {
    // Indice unico parcial idx_expediente_activo_solicitante_inmueble: este
    // solicitante ya tiene un expediente activo sobre la propiedad destino.
    // Es un conflicto legible, no un 500.
    if (updateError.code === '23505') {
      throw new AppError(
        409,
        'EXPEDIENTE_ACTIVO_DUPLICADO',
        'Este solicitante ya tiene un expediente activo sobre esa propiedad. ' +
          'Continua con el existente en vez de trasladar este.',
        { inmueble_destino_id: destino.id },
      );
    }
    logger.error(
      { error: updateError.message, expedienteId: expediente.id, inmuebleDestinoId: destino.id },
      'Reasignacion §4.3: fallo el UPDATE del expediente',
    );
    throw fromSupabaseError(updateError);
  }

  if (!movidas || (movidas as unknown[]).length === 0) {
    throw AppError.conflict(
      'El expediente cambio de propiedad mientras se procesaba la reasignacion — refresca para ver el estado actual.',
      ESTUDIO_NO_REASIGNABLE_ERROR_CODE,
    );
  }

  // 10.b EL CERTIFICADO, si lo habia. Va DESPUES del UPDATE a proposito: el PDF
  //      se arma leyendo `expedientes.inmuebles`, asi que solo despues del
  //      traslado imprime la propiedad nueva.
  const certificado = await regenerarCertificadoTrasTraslado({
    estudioId: estudio.id,
    userId,
    userRol,
    ip,
  });

  const resultado: ResultadoReasignacion = {
    expediente_id: expediente.id,
    expediente_numero: expediente.numero,
    estudio_id: estudio.id,
    inmueble_origen_id: expediente.inmueble_id,
    inmueble_destino_id: destino.id,
    canon_origen_cop: veredicto.canonOriginalCop,
    canon_destino_cop: veredicto.canonDestinoCop,
    canon_maximo_tolerado_cop: veredicto.canonMaximoToleradoCop,
    tolerancia_pct: veredicto.toleranciaPct,
    canon_ingreso_destino_pct: veredicto.canonIngresoDestinoPct,
    veredicto_canon_ingreso: veredicto.veredictoCanonIngreso,
    vigencia_hasta: vigenciaHasta,
    // El §4.3 es explicito: "sin costo adicional". Viaja en la respuesta y en
    // la traza para que la promesa sea verificable, no solo prometida.
    se_cobro: false,
    certificado,
  };

  // 11. TRAZA. Tres registros con proposito distinto, ninguno bloqueante: el
  //     movimiento ya esta hecho y no se revierte porque falle una bitacora.
  await registrarTrazaReasignacion(resultado, userId, origen, destino);

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_REASIGNADO,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: estudio.id,
    detalle: { ...resultado },
    ip,
  });

  logger.info(
    {
      estudioId: estudio.id,
      expedienteId: expediente.id,
      inmuebleOrigenId: expediente.inmueble_id,
      inmuebleDestinoId: destino.id,
      canonOrigenCop: veredicto.canonOriginalCop,
      canonDestinoCop: veredicto.canonDestinoCop,
      veredictoCanonIngreso: veredicto.veredictoCanonIngreso,
      vigenciaHasta,
    },
    'Reasignacion §4.3 aplicada — el estudio se reutiliza sin costo y conserva su vigencia',
  );

  return resultado;
}

/**
 * Deja constancia de la reasignacion. Nunca lanza.
 *
 * Dos escrituras con audiencias distintas:
 *   - `eventos_timeline`: lo que el gestor lee al abrir el expediente. Es lo
 *     que evita que el historial (la cita, los documentos) quede hablando de
 *     una propiedad sin explicar por que. No necesita ninguna migracion, asi
 *     que es la traza que SIEMPRE existe.
 *   - `estudios_reasignaciones`: la fila auditable, con los dos canones, el
 *     veredicto de las dos condiciones, la vigencia conservada y el "no se
 *     cobro". Si la migracion 20260903000006 todavia no corrio, el insert
 *     falla: se registra un error que la nombra (mismo patron que
 *     reservarInmuebleParaContrato) y la reasignacion sigue en pie con el
 *     evento de timeline y la bitacora.
 */
async function registrarTrazaReasignacion(
  resultado: ResultadoReasignacion,
  userId: string,
  origen: { codigo: string | null; direccion: string | null } | null,
  destino: { codigo: string | null; direccion: string | null },
): Promise<void> {
  const nombreOrigen = origen?.codigo?.trim() || origen?.direccion?.trim() || 'la propiedad anterior';
  const nombreDestino = destino.codigo?.trim() || destino.direccion?.trim() || 'la nueva propiedad';

  // El error de PostgREST viaja en el RESULTADO, no como excepcion: el builder
  // solo rechaza la promesa si se le encadena `.throwOnError()`. Envolver esto
  // en un try/catch y no leer `{ error }` hacia que un insert fallido (FK,
  // timeout, metadata invalida) se perdiera en silencio y el warn de abajo
  // fuera codigo muerto — justo en la traza que este modulo declara "la que
  // SIEMPRE existe". El catch se queda solo para el fallo de red.
  try {
    const { error: timelineError } = await (supabase
      .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
      .insert({
        expediente_id: resultado.expediente_id,
        tipo: 'estado',
        descripcion:
          `El estudio se reasigno de ${nombreOrigen} (${formatearCOP(resultado.canon_origen_cop)}) ` +
          `a ${nombreDestino} (${formatearCOP(resultado.canon_destino_cop)}) sin costo adicional. ` +
          'El estudio conserva su vigencia original.' +
          (resultado.certificado === 'regenerado'
            ? ' El certificado se regenero con la propiedad nueva, conservando su codigo y su vencimiento.'
            : resultado.certificado === 'desactualizado'
              ? ' ATENCION: el certificado emitido quedo describiendo la propiedad anterior — hay que regenerarlo antes de entregarlo.'
              : ''),
        metadata: {
          motivo: 'estudio_reasignado_a_otra_propiedad',
          ...resultado,
          reasignado_por: userId,
        },
      } as never);

    if (timelineError) {
      logger.error(
        { error: timelineError.message, expedienteId: resultado.expediente_id },
        'Reasignacion §4.3: no se pudo escribir el evento de timeline — el expediente cambio de propiedad sin dejar constancia legible',
      );
    }
  } catch (err) {
    logger.error(
      { err, expedienteId: resultado.expediente_id },
      'Reasignacion §4.3: excepcion escribiendo el evento de timeline',
    );
  }

  const { error } = await (supabase
    .from('estudios_reasignaciones' as string) as ReturnType<typeof supabase.from>)
    .insert({
      estudio_id: resultado.estudio_id,
      expediente_id: resultado.expediente_id,
      inmueble_origen_id: resultado.inmueble_origen_id,
      inmueble_destino_id: resultado.inmueble_destino_id,
      canon_origen_cop: resultado.canon_origen_cop,
      canon_destino_cop: resultado.canon_destino_cop,
      canon_maximo_tolerado_cop: resultado.canon_maximo_tolerado_cop,
      tolerancia_pct: resultado.tolerancia_pct,
      canon_ingreso_destino_pct: resultado.canon_ingreso_destino_pct,
      veredicto_canon_ingreso: resultado.veredicto_canon_ingreso,
      vigencia_hasta_conservada: resultado.vigencia_hasta,
      se_cobro: resultado.se_cobro,
      certificado_estado: resultado.certificado,
      reasignado_por: userId,
    } as never);

  if (error) {
    logger.error(
      { error: error.message, estudioId: resultado.estudio_id, expedienteId: resultado.expediente_id },
      'Reasignacion §4.3: no se pudo escribir en estudios_reasignaciones (¿falta correr la migracion 20260903000006?) — ' +
        'la reasignacion quedo hecha y trazada en el timeline y en la bitacora',
    );
  }
}

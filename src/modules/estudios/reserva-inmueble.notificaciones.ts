// ============================================================
// Aviso a los DEMAS candidatos cuando una propiedad queda reservada.
//
// Flujo de Gerencia, modulo de estudios, §4.2, ultimo punto (literal):
//   "Al aprobarse uno. Los demas estudios en curso sobre esa propiedad se
//    notifican al solicitante y quedan disponibles para reasignarse a otro
//    inmueble."
//
// ── QUE SE HACE Y QUE NO ──────────────────────────────────────────────────
//
// SE NOTIFICA. Al solicitante de cada estudio en curso sobre la propiedad que
// acaba de reservarse: notificacion in-app + correo, mas un evento de timeline
// en su expediente para que el gestor lo vea al abrirlo.
//
// NO SE REASIGNA AQUI. La portabilidad del estudio a otro inmueble es el §4.3 y
// ya existe: POST /estudios/:estudioId/reasignar (reasignacion.service.ts), que
// mueve `expedientes.inmueble_id` sin cobrar cuando el canon de la nueva
// propiedad cabe en la tolerancia. Pero la dispara el GESTOR desde el
// expediente, no este aviso ni el prospecto (que solo tiene expedientes:read).
// Por eso el copy sigue diciendo "un asesor te ayuda a asignarlo": es literal,
// no un placeholder a la espera del §4.3.
//
// ── EL ESTUDIO NO SE TOCA: ES DELIBERADO ─────────────────────────────────
//
// El estudio afectado se queda EXACTAMENTE como estaba (en curso), y su
// expediente tambien. No se cancela, no se rechaza, no se cierra. Tres razones:
//
//   1. El estudio SIGUE SIENDO VALIDO. Es un estudio de la persona, no de la
//      propiedad: el resultado del buro no cambia porque el inmueble se haya
//      ido. Cancelarlo tiraria un estudio pagado, y ademas la vigencia de 60
//      dias del certificado existe justamente para poder reusarlo.
//   2. Un estudio cancelado SI seria el callejon sin salida. Desde 'cancelado'
//      no hay camino de vuelta (es estado final: ESTADOS_ESTUDIO_FINALES), asi
//      que la reasignacion del §4.3 se encontraria con un registro muerto y
//      habria que crear —y cobrar— uno nuevo.
//   3. Dejandolo en curso, el gestor conserva las tres salidas: esperar (el
//      contrato del otro candidato puede caerse y la propiedad volver), cancelar
//      a mano si el solicitante desiste, o reasignar cuando exista el §4.3.
//
// Es best-effort de punta a punta: la reserva ya se confirmo en la base y no se
// revierte porque un correo falle.
// ============================================================

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { notificarYCorreo, findPerfilIdByEmail } from '../notificaciones/notificaciones.service';

/** Una fila de `afectados` tal como la devuelve fn_reservar_inmueble_para_contrato. */
export interface CandidatoAfectado {
  expediente_id: string;
  expediente_numero: string | null;
  solicitante_id: string | null;
  solicitante_nombre: string | null;
  solicitante_apellido: string | null;
  solicitante_email: string | null;
}

export interface AvisoReservaInput {
  afectados: CandidatoAfectado[];
  /** Codigo del inmueble reservado — es como el solicitante lo reconoce. */
  inmuebleCodigo?: string | null;
  inmuebleDireccion?: string | null;
  /** Expediente que gano la reserva. Solo para el log y la trazabilidad. */
  expedienteGanadorId: string;
}

/** El texto que lee el solicitante. §13: informativo, con salida, sin portazo. */
export function mensajeInmuebleReservado(referencia: string): string {
  return (
    `El inmueble ${referencia} fue reservado para otro candidato. ` +
    'Tu estudio sigue vigente y puedes usarlo para otra propiedad: un asesor te ayuda a asignarlo.'
  );
}

/**
 * Como se nombra la propiedad en el mensaje. El codigo es lo que el solicitante
 * vio en la vitrina y en su expediente; la direccion es el respaldo.
 */
export function referenciaInmueble(
  codigo?: string | null,
  direccion?: string | null,
): string {
  return codigo?.trim() || direccion?.trim() || 'que estabas evaluando';
}

/**
 * Notifica a los solicitantes de los demas estudios en curso. Nunca lanza.
 *
 * Se llama DESPUES de que la reserva quedo confirmada en la base, y solo la
 * ejecuta el ganador del CAS: `afectados` viene vacio en el camino idempotente
 * (regenerar el contrato del mismo expediente), asi que nadie recibe el aviso
 * dos veces por reintentar.
 */
export async function avisarCandidatosDeReserva(input: AvisoReservaInput): Promise<void> {
  const { expedienteGanadorId } = input;
  if (input.afectados.length === 0) return;

  // Un estudio que ya tuvo contrato (p. ej. el ex-arrendatario de un V3
  // TERMINADO: la fianza activa no cierra el estudio) no es un candidato: su
  // evaluación se consumió y no se puede reasignar. "Tu estudio sigue vigente"
  // le mentiría. Los de contrato cancelado antes de firmar sí siguen vivos.
  const { data: conContrato, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('expediente_id')
    .in('expediente_id', input.afectados.map((a) => a.expediente_id))
    .neq('estado', 'cancelado');
  if (error) {
    // Mejor callar que mentir: es solo un aviso y la reserva ya quedó.
    logger.warn({ err: error, expedienteGanadorId }, 'Flujo 4.2: sin avisos de reserva (no se pudieron leer los contratos)');
    return;
  }
  const consumidos = new Set(((conContrato ?? []) as { expediente_id: string }[]).map((c) => c.expediente_id));
  const afectados = input.afectados.filter((a) => !consumidos.has(a.expediente_id));
  if (afectados.length === 0) return;

  const referencia = referenciaInmueble(input.inmuebleCodigo, input.inmuebleDireccion);
  const mensaje = mensajeInmuebleReservado(referencia);

  logger.info(
    { expedienteGanadorId, afectados: afectados.length, inmueble: referencia },
    'Flujo 4.2: la propiedad quedo reservada — avisando a los demas candidatos en curso',
  );

  for (const cand of afectados) {
    try {
      // 1. Evento de timeline en SU expediente. Es lo que hace que el caso no
      //    sea un callejon sin salida: el gestor abre el expediente y ve por
      //    que se detuvo, sin tener que reconstruirlo.
      await (supabase
        .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
        .insert({
          expediente_id: cand.expediente_id,
          tipo: 'estado',
          descripcion:
            `El inmueble ${referencia} fue reservado para otro candidato aprobado. ` +
            'La evaluación de este estudio sigue vigente y puede asignarse a otra propiedad.',
          metadata: {
            motivo: 'inmueble_reservado_por_otro_candidato',
            expediente_ganador_id: expedienteGanadorId,
            inmueble_codigo: input.inmuebleCodigo ?? null,
          },
        } as never);

      // 2. Aviso al solicitante (in-app + correo). El solicitante puede no
      //    tener perfil todavia (llego por invitacion / vitrina): en ese caso
      //    findPerfilIdByEmail devuelve null y notificarYCorreo es no-op, que
      //    es el comportamiento deseado — no rompe el bucle.
      const perfilId = await findPerfilIdByEmail(cand.solicitante_email);
      if (perfilId) {
        await notificarYCorreo({
          userId: perfilId,
          tipo: 'inmueble.reservado_por_otro',
          titulo: 'La propiedad quedo reservada para otro candidato',
          mensaje,
          link: `/expedientes/${cand.expediente_id}`,
          payload: {
            expediente_id: cand.expediente_id,
            inmueble_codigo: input.inmuebleCodigo ?? null,
            // El §4.3 ya existe, pero este payload viaja al PROSPECTO y el
            // prospecto no puede dispararlo (solo tiene expedientes:read; la
            // ruta pide expedientes:update). Sigue en false a proposito: el
            // aviso informa, y el boton vive en el expediente, del lado del
            // gestor. Ponerlo en true aqui prometeria una accion que quien lee
            // el aviso no puede ejecutar.
            reasignacion_disponible: false,
          },
        });
      }
    } catch (err) {
      // Un candidato que falla no puede dejar sin aviso a los demas.
      logger.warn(
        { err, expedienteId: cand.expediente_id },
        'No se pudo avisar a un candidato de que la propiedad quedo reservada',
      );
    }
  }
}

export const MOTIVO_VISITA_INMUEBLE_RESERVADO = 'El inmueble fue reservado para otro candidato';

/**
 * Cancela las visitas vivas (solicitada/confirmada) de los DEMAS estudios sobre
 * el inmueble recien reservado y avisa a cada solicitante. Cubre a quien solo
 * pidio visita desde la vitrina (expediente sin estudio), que no entra en
 * `afectados`. La del ganador no se toca. Best-effort: nunca lanza.
 */
export async function cancelarVisitasDeOtros(inmuebleId: string, expedienteGanadorId: string): Promise<void> {
  try {
    const { data: exps, error: expErr } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('inmueble_id', inmuebleId)
      .neq('id', expedienteGanadorId);
    if (expErr) throw expErr;
    const ids = ((exps ?? []) as { id: string }[]).map((e) => e.id);
    if (ids.length === 0) return;

    const { data: canceladas, error } = await (supabase
      .from('citas' as string) as ReturnType<typeof supabase.from>)
      .update({
        estado: 'cancelada',
        motivo_cancelacion: MOTIVO_VISITA_INMUEBLE_RESERVADO,
        updated_at: new Date().toISOString(),
      } as never)
      .in('expediente_id', ids)
      .in('estado', ['solicitada', 'confirmada'])
      .select('id, expediente_id, fecha_propuesta, fecha_confirmada');
    if (error) throw error;
    const filas = (canceladas ?? []) as Array<{
      id: string; expediente_id: string; fecha_propuesta: string; fecha_confirmada: string | null;
    }>;
    if (filas.length === 0) return;

    logger.info(
      { expedienteGanadorId, inmuebleId, visitas: filas.length },
      'Flujo 4.2: visitas de los demas candidatos canceladas por la reserva',
    );
    const { notificarCitaCancelada } = await import('../citas/citas.service');
    for (const c of filas) {
      await (supabase.from('eventos_timeline' as string) as ReturnType<typeof supabase.from>).insert({
        expediente_id: c.expediente_id,
        tipo: 'cita',
        descripcion: `Cita cancelada: ${MOTIVO_VISITA_INMUEBLE_RESERVADO}`,
        metadata: { cita_id: c.id, motivo: 'inmueble_reservado_por_otro_candidato', expediente_ganador_id: expedienteGanadorId },
      } as never);
      // 'administrador' = la cancela Cofianza, así que el aviso va al solicitante.
      await notificarCitaCancelada(
        c.expediente_id,
        c.fecha_confirmada || c.fecha_propuesta,
        MOTIVO_VISITA_INMUEBLE_RESERVADO,
        'administrador',
      ).catch((err) => logger.warn({ err, citaId: c.id }, 'No se pudo avisar la visita cancelada por la reserva'));
    }
  } catch (err) {
    logger.warn({ err, inmuebleId, expedienteGanadorId }, 'No se pudieron cancelar las visitas de los demas candidatos');
  }
}

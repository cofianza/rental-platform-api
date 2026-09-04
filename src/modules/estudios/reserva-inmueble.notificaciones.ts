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
// NO SE REASIGNA. La portabilidad del estudio a otro inmueble es el §4.3 y es
// otra fase. Por eso el copy anuncia pero NO promete un boton: dice "un asesor
// puede asignarlo a otra propiedad", no "reasignalo aqui".
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
  const { afectados, expedienteGanadorId } = input;
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
            'El estudio de este expediente sigue vigente y puede asignarse a otra propiedad.',
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
            // La reasignacion es el §4.3 y todavia no existe: se deja el dato
            // para que la web pueda mostrar el aviso sin ofrecer un boton.
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

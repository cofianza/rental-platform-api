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
// acaba de reservarse: notificacion in-app + correo si tiene cuenta, y solo
// correo si no la tiene (la mayoria de prospectos nunca se registra). Al gestor:
// el dueño del inmueble y el miembro responsable del estudio (in-app), mas un
// evento de timeline en el expediente.
//
// "Puede asignarse a otra propiedad" solo se le dice a quien tiene la
// evaluacion COMPLETADA: reasignarEstudio exige 'completado', asi que a un
// estudio todavia en curso esa promesa no se le puede cumplir hoy.
//
// NO SE REASIGNA AQUI. La portabilidad del estudio a otro inmueble es el §4.3 y
// ya existe: POST /estudios/:estudioId/reasignar (reasignacion.service.ts), que
// mueve `expedientes.inmueble_id` sin cobrar cuando el canon de la nueva
// propiedad cabe en la tolerancia. Pero la dispara el GESTOR desde el
// expediente, no este aviso ni el prospecto (que solo tiene expedientes:read).
// Por eso el copy sigue diciendo "un asesor le ayuda a asignarlo": es literal,
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
import {
  notificarYCorreo,
  notificarUsuario,
  notificarResponsableExpediente,
  findPerfilIdByEmail,
} from '../notificaciones/notificaciones.service';
import { formatNumeroEstudio } from '@/lib/numeroEstudio';

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

/**
 * El texto que lee el solicitante. §13: informativo, con salida, sin portazo;
 * de usted (va por correo a un tercero). La reasignacion exige la evaluacion
 * completada: a un estudio en curso no se le promete.
 */
export function mensajeInmuebleReservado(referencia: string, completado = true): string {
  return (
    `El inmueble ${referencia} fue reservado para otro candidato. ` +
    (completado
      ? 'Su estudio sigue vigente y puede usarse para otra propiedad: un asesor le ayuda a asignarlo.'
      : 'Su estudio sigue en curso; un asesor le indicará cómo continuar con otra propiedad.')
  );
}

/** Lo que lee el gestor (dueño y responsable) en su notificacion y en el timeline. */
export function mensajeReservaParaGestor(
  referencia: string,
  numero: string | null,
  nombre: string,
  completado: boolean,
): string {
  const estudio = `El estudio${numero ? ` ${formatNumeroEstudio(numero)}` : ''}${nombre ? ` de ${nombre}` : ''}`;
  return (
    `El inmueble ${referencia} quedó reservado para otro candidato aprobado. ` +
    (completado
      ? `${estudio} sigue vigente y puede reasignarse a otra propiedad desde el estudio.`
      : `${estudio} sigue en curso: cuando su evaluación se complete podrá reasignarse a otra propiedad, o cancélelo si el prospecto desiste.`)
  );
}

/**
 * Aviso al solicitante, tenga o no cuenta: con cuenta, in-app + correo (y el
 * link lleva a su estudio); sin cuenta, solo el correo (a una pagina publica,
 * porque /expedientes le pediria un login que no tiene). Nunca lanza.
 */
export async function avisarAlSolicitante(args: {
  email: string | null;
  nombre: string | null;
  tipo: string;
  titulo: string;
  mensaje: string;
  /** Destino del aviso para quien tiene cuenta. */
  link: string;
  /** Destino del correo para quien no tiene cuenta. */
  linkSinCuenta?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  if (!args.email) return;
  try {
    const perfilId = await findPerfilIdByEmail(args.email);
    if (perfilId) {
      await notificarYCorreo({
        userId: perfilId,
        tipo: args.tipo,
        titulo: args.titulo,
        mensaje: args.mensaje,
        link: args.link,
        payload: args.payload,
      });
      return;
    }
    // Import diferido: el cliente de correo arrastra la config completa, y este
    // modulo lo cargan tambien contratos y la reasignacion.
    const [{ sendResponsableAsignadoEmail }, { env }] = await Promise.all([
      import('../orchestrator/orchestrator.emails'),
      import('@/config'),
    ]);
    await sendResponsableAsignadoEmail({
      email: args.email,
      nombre: args.nombre,
      titulo: args.titulo,
      mensaje: args.mensaje,
      link: args.linkSinCuenta ?? '/',
      frontend_url: env.FRONTEND_URL,
    });
  } catch (err) {
    logger.warn({ err, tipo: args.tipo }, 'No se pudo avisar al solicitante');
  }
}

/**
 * Como se nombra la propiedad en el mensaje. El codigo es lo que el solicitante
 * vio en la vitrina y en su expediente; la direccion es el respaldo.
 */
export function referenciaInmueble(
  codigo?: string | null,
  direccion?: string | null,
): string {
  return codigo?.trim() || direccion?.trim() || 'que se estaba evaluando';
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
  const ids = afectados.map((a) => a.expediente_id);

  // Que evaluaciones ya estan completadas (solo esas se pueden reasignar) y a
  // quien avisar del lado del gestor: el dueño del inmueble reservado y el
  // miembro responsable de cada estudio. Si no se puede leer, se avisa igual
  // pero sin prometer la reasignacion.
  const [{ data: completados }, { data: exps }] = await Promise.all([
    (supabase.from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select('expediente_id')
      .in('expediente_id', ids)
      .eq('tipo', 'individual')
      .eq('estado', 'completado'),
    (supabase.from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id, miembro_responsable_id, inmuebles!expedientes_inmueble_id_fkey(propietario_id)')
      .in('id', ids),
  ]);
  const conEvaluacion = new Set(((completados ?? []) as { expediente_id: string }[]).map((e) => e.expediente_id));
  const gestion = new Map(
    ((exps ?? []) as Array<{
      id: string;
      miembro_responsable_id: string | null;
      inmuebles: { propietario_id: string | null } | null;
    }>).map((e) => [e.id, e]),
  );

  logger.info(
    { expedienteGanadorId, afectados: afectados.length, inmueble: referencia },
    'Flujo 4.2: la propiedad quedo reservada — avisando a los demas candidatos en curso',
  );

  for (const cand of afectados) {
    try {
      const completado = conEvaluacion.has(cand.expediente_id);
      const nombre = `${cand.solicitante_nombre ?? ''} ${cand.solicitante_apellido ?? ''}`.trim();
      const alGestor = mensajeReservaParaGestor(referencia, cand.expediente_numero, nombre, completado);
      const payload = { expediente_id: cand.expediente_id, inmueble_codigo: input.inmuebleCodigo ?? null };

      // 1. Evento de timeline en SU expediente. Es lo que hace que el caso no
      //    sea un callejon sin salida: el gestor abre el expediente y ve por
      //    que se detuvo, sin tener que reconstruirlo.
      await (supabase
        .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
        .insert({
          expediente_id: cand.expediente_id,
          tipo: 'estado',
          descripcion: alGestor,
          metadata: {
            motivo: 'inmueble_reservado_por_otro_candidato',
            expediente_ganador_id: expedienteGanadorId,
            inmueble_codigo: input.inmuebleCodigo ?? null,
          },
        } as never);

      // 2. Al gestor: dueño del inmueble y miembro responsable del estudio.
      const aviso = {
        tipo: 'inmueble.reservado_por_otro',
        titulo: 'Un estudio perdió la propiedad por una reserva',
        mensaje: alGestor,
        link: `/expedientes/${cand.expediente_id}`,
        // La reasignacion (§4.3) la dispara el gestor desde el estudio y exige
        // la evaluacion completada.
        payload: { ...payload, reasignacion_disponible: completado },
      };
      const g = gestion.get(cand.expediente_id);
      const duenoId = g?.inmuebles?.propietario_id ?? null;
      if (duenoId) await notificarUsuario({ userId: duenoId, ...aviso });
      await notificarResponsableExpediente({
        expedienteId: cand.expediente_id,
        miembroId: g ? g.miembro_responsable_id : undefined,
        excluirPerfilId: duenoId,
        ...aviso,
      });

      // 3. Al solicitante, tenga o no cuenta.
      await avisarAlSolicitante({
        email: cand.solicitante_email,
        nombre: nombre || null,
        tipo: 'inmueble.reservado_por_otro',
        titulo: 'La propiedad quedó reservada para otro candidato',
        mensaje: mensajeInmuebleReservado(referencia, completado),
        link: `/expedientes/${cand.expediente_id}`,
        linkSinCuenta: '/vitrina',
        // El prospecto no puede dispararla (solo tiene expedientes:read): el
        // aviso informa y el boton vive del lado del gestor.
        payload: { ...payload, reasignacion_disponible: false },
      });
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

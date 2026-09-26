import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  getAvailableTransitions,
  getTransitionDef,
  isTransitionValid,
  type EstadoExpediente,
  type PreconditionId,
} from './expediente-state-machine';
import { getExpedienteById } from './expedientes.service';
import { assertExpedienteAccess, resolveRolMiembro } from '@/lib/tenantScope';
import type { AuthUser } from '@/types/auth';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type { TransitionInput } from './expediente-workflow.schema';
import { faltaColumna } from './cierre-sin-acta';

// ============================================================
// Tipos internos
// ============================================================

interface ExpedienteRow {
  id: string;
  numero: string;
  estado: EstadoExpediente;
  analista_id: string | null;
  /** Propietario del inmueble — necesario para validar ownership cuando el
   *  caller es propietario/inmobiliaria. */
  propietario_id: string | null;
  /** Organización dueña del inmueble (multi-tenant ownership org-aware). */
  inmobiliaria_id: string | null;
}

// Transiciones que el propietario / inmobiliaria pueden ejecutar sobre los
// expedientes de SUS propios inmuebles. El dueño puede CERRAR / CANCELAR
// el expediente dando un motivo — no necesita pedir permiso a un admin para
// abandonar un flujo. Las transiciones intermedias (aprobar, rechazar,
// condicionar) siguen siendo del analista.
// Salvo 'condicionado': es revisión manual y la Adenda 2 §5 prohíbe al dueño
// aprobar, modificar o CERRAR ese caso. Lo resuelve un analista de Cofianza.
const PROPIETARIO_TRANSITIONS: ReadonlyArray<{ from: EstadoExpediente; to: EstadoExpediente }> = [
  { from: 'borrador', to: 'cerrado' },
  { from: 'en_revision', to: 'cerrado' },
  { from: 'informacion_incompleta', to: 'cerrado' },
  { from: 'aprobado', to: 'cerrado' },
  { from: 'rechazado', to: 'cerrado' },
];

/** Roles de Cofianza: ven el historial completo (P34). */
const ROLES_COFIANZA = ['administrador', 'operador_analista', 'gerencia_consulta'];

interface TransitionRpcResult {
  expediente_id: string;
  estado_anterior: EstadoExpediente;
  estado_nuevo: EstadoExpediente;
  evento_timeline_id: string;
  updated_at: string;
}

// ============================================================
// Ejecutar transicion
// ============================================================

export async function executeTransition(
  expedienteId: string,
  input: TransitionInput,
  user: AuthUser,
) {
  const expediente = await fetchExpediente(expedienteId);
  const currentState = expediente.estado;
  const targetState = input.nuevo_estado;

  // Validar que la transicion es estructuralmente valida
  if (!isTransitionValid(currentState, targetState)) {
    const validTargets = getAvailableTransitions(currentState);
    throw AppError.badRequest(
      `Transicion invalida: ${currentState} -> ${targetState}`,
      'INVALID_TRANSITION',
      { estado_actual: currentState, transiciones_validas: validTargets },
    );
  }

  // Verificar permisos (incluye ownership para propietario/inmobiliaria
  // y filtra qué transiciones puede hacer cada rol).
  await checkPermissions(expediente, user, currentState, targetState);

  // Verificar precondiciones
  const transitionDef = getTransitionDef(currentState, targetState)!;
  await checkPreconditions(transitionDef.preconditions, expediente, input);

  // Adenda 2 §4.3: aprobar una revisión manual recalcula el puntaje con V7/V9
  // del analista, igual que la card "Aprobar estudio". Se exige ANTES de mover
  // el estado: después ya no hay cómo pedirlo.
  if (currentState === 'condicionado' && targetState === 'aprobado' && !input.evaluacion) {
    throw AppError.badRequest(
      'Para aprobar una revisión manual puntúa la estabilidad laboral y el historial de arrendamiento del solicitante.',
      'EVALUACION_REQUERIDA',
    );
  }

  // Mismo camino que la card «Aprobar estudio»: por aquí el titular no se
  // enteraba (ni correo ni aviso en la app) de que podía seguir al contrato.
  if (currentState === 'condicionado' && targetState === 'aprobado') {
    const { aprobarCondicionado } = await import('./expediente-habilitacion.service');
    const r = await aprobarCondicionado(expedienteId, user.id, user.rol, undefined, {
      fundamento: input.comentario,
      documentos_consultados: input.documentos_consultados ?? [],
      evaluacion: input.evaluacion!,
    });
    return {
      ...(await getExpedienteById(expedienteId)),
      estado_anterior: currentState,
      evento_timeline_id: null,
      puntaje_revision_manual: r.puntaje_revision_manual,
    };
  }

  // Si la transicion es "Cancelar expediente" (cualquier estado activo →
  // cerrado con esa etiqueta), despues de la RPC se persisten las columnas de
  // cancelacion para que el UI distinga entre cierre natural y abandono mid-flow. Si la
  // etiqueta no llega (clientes viejos o el caller no la mando), inferimos
  // por estado_anterior: aprobado/borrador/en_revision/info_incompleta/
  // condicionado → cerrado siempre fue cancelacion (rechazado→cerrado es la
  // unica transicion al cerrado que no es abandono).
  const ESTADOS_CANCELABLES: EstadoExpediente[] = [
    'borrador',
    'en_revision',
    'informacion_incompleta',
    'condicionado',
    'aprobado',
  ];
  // El fallback por estado_anterior SOLO aplica cuando la etiqueta no llega.
  // Antes se evaluaba siempre, y como `comentario` es obligatorio por schema
  // (min(1)) la tercera rama del OR era verdadera en todos los casos: desde
  // 'aprobado' salen DOS transiciones a 'cerrado' —'Cerrar estudio' (cierre
  // natural, con el contrato firmado) y 'Cancelar estudio' (abandono)— y la
  // etiqueta es lo unico que las distingue, asi que un arriendo que termino
  // bien quedaba archivado en rojo como "Estudio cancelado — no continuara con
  // el proceso", en el detalle, en la lista y en el dashboard. Sin deshacer.
  const fueCancelacion =
    targetState === 'cerrado' &&
    // 'Cancelar expediente' = etiqueta vieja (web sin redeploy aun); se acepta igual.
    (input.etiqueta === 'Cancelar estudio' || input.etiqueta === 'Cancelar expediente' ||
      (!input.etiqueta && ESTADOS_CANCELABLES.includes(currentState) && !!input.comentario) ||
      // «Cerrar estudio» desde 'aprobado' es el cierre del arriendo firmado. Sin
      // contrato firmado no hubo arriendo: queda como cancelación, no como
      // «¡Estudio finalizado!».
      (currentState === 'aprobado' && !(await tieneContratoFirmado(expedienteId))));

  // V3 §12.2: un estudio con la fianza activa o terminada no se cancela (eso
  // marcaría abandono sobre un arriendo en curso): se cierra con el acta.
  if (fueCancelacion && (await tieneFianzaV3(expedienteId))) {
    throw AppError.conflict(
      'Este estudio tiene un contrato con la fianza activa o terminada: se cierra con el acta de entrega, no se cancela.',
      'ESTUDIO_CON_FIANZA',
    );
  }

  // Cerrar el estudio cancela su contrato V3 con la firma incompleta: la
  // inmobiliaria acepta antes el aviso (Adenda 1 del módulo de contratos, respuesta 11).
  if (targetState === 'cerrado' && user.rol === 'inmobiliaria') {
    const { exigirAcuseDelEstudio } = await import('@/modules/contratos/v3/firma/firma.service');
    await exigirAcuseDelEstudio(expedienteId, user.rol);
  }

  // Construir descripcion del evento
  const descripcion = buildTimelineDescription(currentState, targetState, user, input);

  // Ejecutar transicion atomica via RPC
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('transicionar_expediente', {
    p_expediente_id: expedienteId,
    p_nuevo_estado: targetState,
    p_descripcion: descripcion,
    p_usuario_id: user.id,
    p_comentario: input.comentario,
  });

  if (error) {
    // Triggers de la BD (V3 §12.2): sin acta de entrega, o con el contrato en firma, no se cierra.
    const msg = String((error as { message?: string }).message ?? '');
    if (msg.includes('ACTA_ENTREGA_REQUERIDA')) {
      // Adenda 1 contratos (respuesta 21): el acta la carga la inmobiliaria, nunca Cofianza.
      const deCofianza = user.rol === 'administrador' || user.rol === 'operador_analista';
      throw AppError.conflict(
        deCofianza
          ? `El contrato no tiene el acta de entrega e inventario: la carga la inmobiliaria. Si no la va a cargar, ${
              user.rol === 'administrador' ? 'puedes' : 'un administrador de Cofianza puede'
            } cerrar el estudio sin acta, con motivo.`
          : 'Carga el acta de entrega e inventario del contrato antes de cerrar el estudio.',
        'ACTA_ENTREGA_REQUERIDA',
      );
    }
    if (msg.includes('CONTRATO_EN_FIRMA')) {
      throw AppError.conflict(
        'El contrato de este estudio está en firma. Cancélalo antes de cerrar el estudio.',
        'CONTRATO_EN_FIRMA',
      );
    }
    logger.error({ error, expedienteId }, 'Error al transicionar estudio');
    throw AppError.badRequest('Error al ejecutar la transicion', 'TRANSITION_FAILED');
  }

  const result = data as TransitionRpcResult;

  // P34 (Política §9/§11/§13, Adenda 2 §5.1): al rechazar, el gestor ve en el
  // banner el motivo corto que el analista escribió para él, sin cifras del
  // buró ni datos del co-arrendatario; el comentario queda como fundamento
  // interno (timeline y bitácora). Al prospecto no le llega: se lo redacta
  // getExpedienteById. Best-effort, como los vecinos: la transición ya quedó.
  if (targetState === 'rechazado' && input.motivo) {
    const { error: motivoErr } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .update({ motivo_rechazo: input.motivo } as never)
      .eq('id', expedienteId);
    if (motivoErr) {
      logger.warn({ expedienteId, err: motivoErr.message }, 'No se pudo guardar el motivo del rechazo para el gestor');
    }
    // En el evento también: es lo único del rechazo que getTransitionHistory le
    // muestra al gestor. Desde condicionado lo guarda abajo la revisión manual.
    if (currentState !== 'condicionado') {
      const { error: metaErr } = await (supabase
        .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
        .update({ metadata: { motivo_gestor: input.motivo } } as never)
        .eq('id', result.evento_timeline_id);
      if (metaErr) logger.warn({ expedienteId, err: metaErr.message }, 'No se pudo guardar el motivo del rechazo en el timeline');
    }
  }

  if (fueCancelacion) {
    const { error: updErr } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .update({
        cancelado_at: new Date().toISOString(),
        motivo_cancelacion: input.comentario,
        estado_pre_cancelacion: currentState,
      } as never)
      .eq('id', expedienteId);
    if (updErr) {
      // No abortamos — la transicion ya quedo. Solo dejamos rastro: el
      // expediente quedara como cerrado-sin-marcar-cancelacion y la UI
      // lo mostrara como "finalizado" (mismo bug que veniamos solucionando)
      // pero al menos el cierre quedo bien.
      logger.warn(
        { expedienteId, err: updErr.message },
        'No se pudo persistir info de cancelacion — el estudio quedo cerrado pero sin marca de cancelacion',
      );
    }

  } else if (targetState === 'cerrado' && currentState === 'rechazado') {
    // rechazado→cerrado NO es abandono, asi que no lleva `cancelado_at`. Pero
    // sin ninguna marca cae en la rama "else" de la UI y el detalle saluda con
    // "¡Estudio finalizado! Todos los pasos se completaron exitosamente" —
    // sobre un candidato rechazado y sin contrato. Guardar de donde viene deja
    // que la barra de progreso y el banner elijan el texto correcto sin
    // inventarse una cancelacion que no hubo.
    const { error: preErr } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .update({ estado_pre_cancelacion: currentState } as never)
      .eq('id', expedienteId);
    if (preErr) {
      logger.warn(
        { expedienteId, err: preErr.message },
        'No se pudo marcar el cierre como posterior a un rechazo — el detalle lo mostrara como finalizado',
      );
    }
  }

  // Un estudio cerrado o rechazado no le pide nada más al prospecto: su enlace
  // de autorización pendiente muere aquí (si no, lo firmaba y leía «seguimos
  // con tu estudio»). 'expirado' es la única transición que el trigger de
  // inalterabilidad permite sobre una fila pendiente. La página pública además
  // lo rechaza por el estado del expediente, así que un fallo solo se registra.
  if (targetState === 'rechazado' || targetState === 'cerrado') {
    const { error: autErr } = await (supabase
      .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'expirado' } as never)
      .eq('expediente_id', expedienteId)
      .eq('estado', 'pendiente');
    if (autErr) logger.warn({ expedienteId, err: autErr.message }, 'No se pudieron expirar las autorizaciones pendientes del estudio');
  }

  // Soltar la RESERVA del inmueble si este expediente era su titular. Corre en
  // TODO rechazo o cierre — no solo en cancelación: antes un
  // condicionado→rechazado manual dejaba el inmueble atascado para siempre.
  //
  // Flujo §4.2: la liberación es ahora HOLDER-AWARE (solo suelta si
  // `reservado_por_expediente_id` apunta a ESTE expediente), no "desde
  // en_estudio". Con estudios simultáneos ese matiz es todo: el rechazo del
  // candidato B no puede soltar la reserva que tomó A. Fire-and-forget.
  if (targetState === 'rechazado' || targetState === 'cerrado') {
    (async () => {
      await liberarReservaSiNoQuedaContratoVivo(expedienteId, targetState, user.id);
    })().catch((e) => logger.warn({ e, expedienteId }, 'No se pudo liberar la reserva del inmueble tras rechazo/cierre'));
  }

  // P1: al cerrar o rechazar, los cobros vivos de la evaluación se cancelan y lo
  // ya pagado sin consulta al buró se le devuelve a quien pagó. Fire-and-forget.
  if (targetState === 'rechazado' || targetState === 'cerrado') {
    void import('@/modules/pagos/reembolsos.service')
      .then((m) =>
        m.devolverEvaluacionSinConsulta(expedienteId, targetState === 'rechazado' ? 'Estudio rechazado' : 'Estudio cerrado', user.id),
      )
      .catch((e) => logger.warn({ e, expedienteId }, 'No se pudo revisar la devolución de la evaluación'));
  }

  // Adenda 2 §5.1: salir de 'condicionado' es resolver una revision manual.
  // Queda en el timeline (usuario y fecha los pone el RPC; el comentario es el
  // fundamento) con los documentos consultados, y en la bitacora.
  // (Aprobar ya salió arriba por aprobarCondicionado.)
  if (currentState === 'condicionado') {
    const documentos = input.documentos_consultados ?? [];
    const { error: metaErr } = await (supabase
      .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
      .update({
        metadata: {
          manual: true,
          origen: 'analista_revision_manual',
          fundamento: input.comentario,
          documentos_consultados: documentos,
          ...(targetState === 'rechazado' && input.motivo ? { motivo_gestor: input.motivo } : {}),
        },
      } as never)
      .eq('id', result.evento_timeline_id);
    if (metaErr) logger.warn({ expedienteId, err: metaErr.message }, 'No se pudieron guardar los documentos consultados en el timeline');
    // Rechazo: avisan al co-arrendatario, al dueño y al prospecto (Política §11:
    // motivo general y derecho de apelación). Cancelación: al dueño, a quien la
    // guía del condicionado le promete que se enterará. (Aprobar ya salió arriba
    // por aprobarCondicionado, con sus avisos.)
    if (targetState === 'rechazado') {
      void import('@/modules/coarrendatarios/coarrendatarios.service')
        .then((m) => m.avisarCoarrendatarioDecision(expedienteId, targetState))
        .catch((e) => logger.warn({ error: e, expedienteId }, 'No se pudo avisar al coarrendatario'));
      void import('./expediente-habilitacion.service')
        .then((m) =>
          Promise.all([
            m.avisarDuenoDecisionRevisionManual(expedienteId, 'rechazado', input.motivo),
            m.avisarSolicitanteDecision(expedienteId, 'rechazado'),
          ]),
        )
        .catch((e) => logger.warn({ error: e, expedienteId }, 'No se pudo avisar al dueño o al prospecto'));
    } else if (targetState === 'cerrado') {
      void import('./expediente-habilitacion.service')
        .then((m) => m.avisarDuenoDecisionRevisionManual(expedienteId, 'cancelado'))
        .catch((e) => logger.warn({ error: e, expedienteId }, 'No se pudo avisar al dueño'));
      // El co-arrendatario ya evaluado también se entera del cierre.
      void import('@/modules/coarrendatarios/coarrendatarios.service')
        .then((m) => m.avisarCoarrendatarioDecision(expedienteId, 'cerrado'))
        .catch((e) => logger.warn({ error: e, expedienteId }, 'No se pudo avisar al coarrendatario'));
    }

    logAudit({
      usuarioId: user.id,
      accion: AUDIT_ACTIONS.REVISION_MANUAL_DECIDIDA,
      entidad: AUDIT_ENTITIES.EXPEDIENTE,
      entidadId: expedienteId,
      detalle: {
        decision: targetState,
        fundamento: input.comentario,
        documentos_consultados: documentos,
      },
    });
  }

  logger.info(
    { expedienteId, from: currentState, to: targetState, userId: user.id, cancelacion: fueCancelacion },
    'Transicion de estudio ejecutada',
  );

  // Retornar expediente actualizado completo con relaciones
  const expedienteActualizado = await getExpedienteById(expedienteId);

  return {
    ...expedienteActualizado,
    estado_anterior: result.estado_anterior,
    evento_timeline_id: result.evento_timeline_id,
    // Solo lo trae la aprobación de un condicionado (sale arriba).
    puntaje_revision_manual: null,
  };
}

// ============================================================
// Cierre sin acta de entrega (Adenda 1 contratos, respuesta 21)
// ============================================================

/**
 * Un administrador de Cofianza no carga el acta de entrega (avalaría un
 * documento que no presenció), pero sí puede cerrar el estudio SIN ACTA, con
 * motivo: la ausencia de acta es evidencia y el riesgo es de la inmobiliaria.
 * Quién, cuándo y por qué van en el MISMO UPDATE que cierra: así el trigger de
 * §12.2 lo deja pasar (migración 20260930000002) y nada queda a medias. CAS
 * sobre el estado leído. Es el cierre natural de un arriendo firmado: suelta la
 * reserva si ya no queda contrato vivo, igual que «Cerrar estudio».
 */
export async function cerrarSinActa(expedienteId: string, motivo: string, user: AuthUser, ip?: string) {
  if (user.rol !== 'administrador')
    throw AppError.forbidden('Solo un administrador de Cofianza puede cerrar un estudio sin acta de entrega.');
  const expediente = await fetchExpediente(expedienteId);
  if (!isTransitionValid(expediente.estado, 'cerrado'))
    throw AppError.conflict('El estudio ya está cerrado.', 'EXPEDIENTE_ESTADO_CAMBIADO');
  if (!(await faltaActaV3(expedienteId)))
    throw AppError.conflict(
      'Este estudio no tiene un contrato esperando el acta de entrega: ciérralo con «Cambiar estado».',
      'CIERRE_SIN_ACTA_NO_APLICA',
    );

  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'cerrado',
      cierre_sin_acta_en: new Date().toISOString(),
      cierre_sin_acta_por: user.id,
      cierre_sin_acta_motivo: motivo,
    } as never)
    .eq('id', expedienteId)
    .eq('estado', expediente.estado)
    .select('id');
  if (error) {
    if (String(error.message ?? '').includes('CONTRATO_EN_FIRMA'))
      throw AppError.conflict('El contrato de este estudio está en firma. Cancélalo antes de cerrar el estudio.', 'CONTRATO_EN_FIRMA');
    if (faltaColumna(error)) {
      logger.error({ expedienteId, error: error.message }, 'Cierre sin acta: falta correr la migración 20260930000002');
      throw new AppError(
        503,
        'CIERRE_SIN_ACTA_NO_DISPONIBLE',
        'El cierre sin acta todavía no está disponible (falta aplicar la migración 20260930000002). El estudio no se cerró.',
      );
    }
    logger.error({ expedienteId, error: error.message }, 'No se pudo cerrar el estudio sin acta');
    throw new AppError(500, 'CIERRE_SIN_ACTA_ERROR', 'No se pudo cerrar el estudio. Intenta de nuevo.');
  }
  if (!(data as unknown[] | null)?.length)
    throw AppError.conflict('El estudio cambió de estado mientras tanto. Recarga la página.', 'EXPEDIENTE_ESTADO_CAMBIADO');

  // Lo que transicionar_expediente deja en el timeline, con la marca del cierre sin acta.
  const { error: tlError } = await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'estado',
      descripcion: `Estudio cerrado sin acta de entrega por ${user.email} (administrador de Cofianza). Motivo: ${motivo}`,
      usuario_id: user.id,
      estado_anterior: expediente.estado,
      estado_nuevo: 'cerrado',
      comentario: motivo,
      metadata: { cierre_sin_acta: true },
    } as never);
  if (tlError) logger.warn({ expedienteId, error: tlError.message }, 'Cierre sin acta sin evento en el timeline (queda en el estudio y la bitácora)');
  logAudit({
    usuarioId: user.id,
    accion: AUDIT_ACTIONS.EXPEDIENTE_CERRADO_SIN_ACTA,
    entidad: AUDIT_ENTITIES.EXPEDIENTE,
    entidadId: expedienteId,
    detalle: { motivo, estado_anterior: expediente.estado },
    ip,
  });
  void liberarReservaSiNoQuedaContratoVivo(expedienteId, 'cerrado', user.id).catch((e) =>
    logger.warn({ e, expedienteId }, 'No se pudo liberar la reserva del inmueble tras el cierre sin acta'),
  );
  return { ...(await getExpedienteById(expedienteId)), estado_anterior: expediente.estado };
}

/** ¿Algún contrato V3 del estudio con la fianza activa o terminada sigue sin acta de entrega? */
async function faltaActaV3(expedienteId: string): Promise<boolean> {
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('expediente_id', expedienteId)
    .not('destinacion', 'is', null)
    .in('estado', ['vigente', 'finalizado']);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo verificar el contrato del estudio');
  const ids = ((data as { id: string }[] | null) ?? []).map((c) => c.id);
  if (!ids.length) return false;
  const { data: actas, error: actasError } = await (supabase
    .from('contrato_archivos' as string) as ReturnType<typeof supabase.from>)
    .select('contrato_id')
    .in('contrato_id', ids)
    .eq('tipo_archivo', 'acta_entrega');
  if (actasError) throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo verificar el acta de entrega');
  const conActa = new Set(((actas as { contrato_id: string }[] | null) ?? []).map((a) => a.contrato_id));
  return ids.some((id) => !conActa.has(id));
}

// ============================================================
// Liberación de la reserva al rechazar/cerrar el expediente
// ============================================================

/**
 * Estados PRE-FIRMA del contrato: el contrato existe pero nadie lo ha firmado
 * ni enviado a firma. Al morir el expediente estos contratos se auto-cancelan,
 * exactamente igual que las renovaciones pre-firma cuando termina su padre
 * (aplicarEfectosTerminacion en contrato-workflow.service.ts). Incluye
 * 'firma_incompleta' (V3): el proceso de Auco ya se cerró sin todas las firmas
 * y no hay fianza operando. 'pendiente_firma' sigue fuera: bloquea la liberación.
 */
export const CONTRATO_ESTADOS_PRE_FIRMA = ['borrador', 'en_revision', 'aprobado', 'firma_incompleta'] as const;

/** Estados terminales del contrato: ya no comprometen la propiedad. */
const CONTRATO_ESTADOS_TERMINALES = ['finalizado', 'cancelado'] as const;

/**
 * Suelta la reserva del inmueble al rechazar/cerrar el expediente, pero SOLO
 * despues de asegurarse de que no queda ningun contrato vivo que pueda revivir
 * y arrendar la propiedad por segunda vez.
 *
 * El guard viejo miraba unicamente ['vigente','firmado','pendiente_firma'] y
 * solo en el cierre. Dejaba pasar dos agujeros de DOBLE ARRIENDO:
 *
 *   1. Un contrato en 'borrador'/'en_revision'/'aprobado' no lo veia. Se
 *      liberaba el inmueble, otro candidato lo reservaba y firmaba, y despues
 *      alguien retomaba aquel contrato (su unica precondicion, ESTUDIO_APROBADO,
 *      sigue cumpliendose y nada mira el estado del expediente) hasta 'vigente'.
 *      Dos contratos vigentes sobre la misma propiedad.
 *   2. El rechazo liberaba INCONDICIONAL, asi que la ponderacion del
 *      coarrendatario o el orchestrator podian soltar la reserva de un contrato
 *      que estaba literalmente en la mesa de firmas.
 *
 * Ahora: (a) se auto-cancelan los contratos pre-firma —matar la via de vuelta,
 * no solo detectarla, para que el gestor no quede atascado—; (b) el guard cubre
 * TODO estado no terminal y se aplica igual al rechazo que al cierre. Si tras
 * cancelar los pre-firma sigue habiendo un contrato en firma / firmado /
 * vigente, NO se libera: esa propiedad esta comprometida y el camino correcto
 * es cancelar o terminar el contrato desde su propio workflow (que si libera).
 */
async function liberarReservaSiNoQuedaContratoVivo(
  expedienteId: string,
  targetState: EstadoExpediente,
  usuarioId: string | null,
): Promise<void> {
  // 1. Auto-cancelar los contratos pre-firma del expediente. Se usa el RPC
  //    directo (mismo patron que la auto-cancelacion de renovaciones): no
  //    queremos los side effects TS de la transicion, la liberacion la hacemos
  //    aqui abajo una sola vez.
  // Se leen los no terminales y se filtra aquí: nombrar 'firma_incompleta' en la
  // consulta la haría fallar mientras el valor no exista en el enum (migración aparte).
  const { data: noTerminales } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .not('estado', 'in', `(${CONTRATO_ESTADOS_TERMINALES.join(',')})`);
  const preFirma = ((noTerminales as Array<{ id: string; estado: string }> | null) ?? []).filter((c) =>
    (CONTRATO_ESTADOS_PRE_FIRMA as readonly string[]).includes(c.estado),
  );

  const motivo = targetState === 'rechazado' ? 'Estudio rechazado' : 'Estudio cerrado';
  for (const contrato of preFirma) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: rpcErr } = await (supabase as any).rpc('transicionar_contrato', {
      p_contrato_id: contrato.id,
      p_nuevo_estado: 'cancelado',
      p_descripcion: `Cancelacion automatica: el estudio quedo ${targetState}`,
      p_usuario_id: usuarioId,
      p_comentario: null,
      p_motivo: motivo,
    });
    if (rpcErr) {
      logger.warn(
        { contratoId: contrato.id, expedienteId, error: (rpcErr as { message?: string }).message },
        'No se pudo auto-cancelar el contrato pre-firma del estudio rechazado/cerrado',
      );
    } else {
      await (supabase
        .from('contratos' as string) as ReturnType<typeof supabase.from>)
        .update({ motivo_cancelacion: motivo, fecha_terminacion: new Date().toISOString() } as never)
        .eq('id', contrato.id);
      logger.info({ contratoId: contrato.id, expedienteId }, 'Contrato pre-firma auto-cancelado con el estudio');
    }
  }

  // 2. Guard: cualquier contrato NO TERMINAL que quede (incluidos los pre-firma
  //    que no se pudieron cancelar) bloquea la liberacion. FAIL-CLOSED: si la
  //    consulta falla tampoco liberamos — dejar un inmueble bloqueado es
  //    molesto y corregible a mano; liberarlo de mas es doble arriendo.
  const { data: vivos, error: guardError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .not('estado', 'in', `(${CONTRATO_ESTADOS_TERMINALES.join(',')})`)
    .limit(1);

  if (guardError) {
    logger.error(
      { expedienteId, error: guardError.message },
      'Guard de contrato vivo fallo — reserva NO liberada por precaucion',
    );
    return;
  }
  const contratoVivo = ((vivos as Array<{ id: string; estado: string }> | null) ?? [])[0];
  if (contratoVivo) {
    logger.info(
      { expedienteId, contratoId: contratoVivo.id, estado: contratoVivo.estado },
      'Reserva NO liberada: el estudio conserva un contrato no terminal',
    );
    return;
  }

  const { liberarReservaDeExpediente } = await import('../inmuebles/inmuebles.service');
  await liberarReservaDeExpediente(expedienteId);
}

// ============================================================
// Obtener transiciones disponibles
// ============================================================

export async function getTransitionsForExpediente(expedienteId: string, userId?: string, userRol?: string) {
  // Guard multi-tenant: roles internos y llamadas de sistema pasan (no-op);
  // propietario/inmobiliaria/solicitante solo ven las transiciones de sus
  // expedientes. 404 (no 403) para no revelar existencia cross-tenant.
  // Todo en paralelo (antes 3 idas en serie antes de pintar el detalle): si el
  // guard falla, Promise.all rechaza con su 404 y el resto se descarta.
  const [, expediente, conFianzaV3, conContratoFirmado] = await Promise.all([
    assertExpedienteAccess(expedienteId, userId, userRol),
    fetchExpediente(expedienteId),
    tieneFianzaV3(expedienteId),
    tieneContratoFirmado(expedienteId),
  ]);
  let transiciones = getAvailableTransitions(expediente.estado);
  // Con una fianza V3 activa o terminada no se ofrece "Cancelar estudio" (executeTransition la rechaza).
  if (conFianzaV3) transiciones = transiciones.filter((t) => t.label !== 'Cancelar estudio');
  // Sin contrato firmado, cerrar un aprobado es cancelarlo: no se ofrece «Cerrar estudio».
  if (expediente.estado === 'aprobado' && !conContratoFirmado) {
    transiciones = transiciones.filter((t) => t.label !== 'Cerrar estudio');
  }

  // Solo lectura (Gerencia y el miembro 'solo_lectura' de una inmobiliaria):
  // el POST de transiciones los rechaza siempre, asi que ofrecerles transiciones
  // los llevaba a escribir el comentario y chocar con un 403. Misma fuente
  // (resolveRolMiembro, cacheada) que el write-block de auth.ts: si no, un
  // titular que ademas es viewer en otra org perdia "Cambiar estado".
  const soloLectura =
    userRol === 'gerencia_consulta' ||
    (userRol === 'inmobiliaria' && !!userId && (await resolveRolMiembro(userId)) === 'solo_lectura');
  // El dueno (propietario/inmobiliaria) solo puede cerrar: ofrecerle "Aprobar"
  // o "Rechazar" lo llevaba a escribir el comentario y recibir un 403 al final
  // (executeTransition aplica esta misma lista mas abajo).
  const esDueno = userRol === 'propietario' || userRol === 'inmobiliaria';
  const visibles = soloLectura
    ? []
    : esDueno
    ? transiciones.filter((t) =>
        PROPIETARIO_TRANSITIONS.some(
          (p) => p.from === expediente.estado && p.to === (t.estado as EstadoExpediente),
        ),
      )
    : transiciones;

  return {
    expediente_id: expedienteId,
    estado_actual: expediente.estado,
    transiciones_disponibles: visibles,
  };
}

/** ¿El estudio tiene un contrato V3 con la fianza activa o terminada? */
async function tieneFianzaV3(expedienteId: string): Promise<boolean> {
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('expediente_id', expedienteId)
    .not('destinacion', 'is', null)
    .in('estado', ['vigente', 'finalizado'])
    .limit(1);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo verificar el contrato del estudio');
  return !!(data as unknown[] | null)?.length;
}

/** ¿El estudio tiene un contrato firmado (o ya vigente o finalizado)? */
async function tieneContratoFirmado(expedienteId: string): Promise<boolean> {
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('expediente_id', expedienteId)
    .in('estado', ['firmado', 'vigente', 'finalizado'])
    .limit(1);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo verificar el contrato del estudio');
  return !!(data as unknown[] | null)?.length;
}

// ============================================================
// Historial de transiciones
// ============================================================

export async function getTransitionHistory(expedienteId: string, userId?: string, userRol?: string) {
  // Guard multi-tenant (mismo criterio que getTransitionsForExpediente): no-op
  // para roles internos y llamadas de sistema; 404 si el usuario no puede acceder.
  await assertExpedienteAccess(expedienteId, userId, userRol);

  // Verificar que el expediente existe
  const expediente = await fetchExpediente(expedienteId);

  const { data, error } = await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, estado_anterior, estado_nuevo, comentario, descripcion, created_at, metadata,
      usuario:perfiles!eventos_timeline_usuario_id_fkey(id, nombre, apellido)
    `)
    .eq('expediente_id', expedienteId)
    .eq('tipo', 'estado')
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al obtener historial de transiciones');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el historial de transiciones');
  }

  const rows = (data as unknown as Array<{
    id: string;
    estado_anterior: string | null;
    estado_nuevo: string | null;
    comentario: string | null;
    descripcion: string;
    created_at: string;
    metadata: { origen?: string; motivo_gestor?: string } | null;
    usuario: { id: string; nombre: string; apellido: string } | null;
  }>) || [];

  // P34: fuera de Cofianza no salen el comentario (el fundamento interno del
  // analista), la descripción (quién cambió el estado y, en filas viejas, el
  // mismo comentario) ni el usuario que lo cambió: solo los estados. El gestor
  // ve además el motivo que el analista escribió para él; el prospecto,
  // ninguno. Tampoco la ponderación cuenta el resultado ni las reglas duras del
  // co-arrendatario (Ley 1266). Cierra por defecto: sin rol no es de Cofianza.
  const deCofianza = !!userRol && ROLES_COFIANZA.includes(userRol);
  const esGestor = userRol === 'inmobiliaria' || userRol === 'propietario';

  return {
    expediente_id: expedienteId,
    estado_actual: expediente.estado,
    historial: rows.map(({ metadata, ...r }) =>
      deCofianza
        ? r
        : {
            ...r,
            descripcion:
              metadata?.origen === 'ponderacion_coarrendatario'
                ? `Resultado combinado con el co-arrendatario: ${r.estado_nuevo ?? 'sin cambio'}.`
                : `Estado cambiado de '${r.estado_anterior ?? 'sin estado'}' a '${r.estado_nuevo ?? 'sin estado'}'.`,
            comentario: esGestor ? (metadata?.motivo_gestor ?? null) : null,
            usuario: null,
          },
    ),
  };
}

// ============================================================
// Helpers privados
// ============================================================

async function fetchExpediente(id: string): Promise<ExpedienteRow> {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, analista_id, inmuebles!expedientes_inmueble_id_fkey(propietario_id, inmobiliaria_id)')
    .eq('id', id)
    .single();

  if (error || !data) {
    throw AppError.notFound('Estudio no encontrado');
  }

  const row = data as unknown as {
    id: string;
    numero: string;
    estado: EstadoExpediente;
    analista_id: string | null;
    inmuebles: { propietario_id: string; inmobiliaria_id: string | null } | null;
  };

  return {
    id: row.id,
    numero: row.numero,
    estado: row.estado,
    analista_id: row.analista_id,
    propietario_id: row.inmuebles?.propietario_id ?? null,
    inmobiliaria_id: row.inmuebles?.inmobiliaria_id ?? null,
  };
}

async function checkPermissions(
  expediente: ExpedienteRow,
  user: AuthUser,
  fromState: EstadoExpediente,
  toState: EstadoExpediente,
): Promise<void> {
  const isAdmin = user.rol === 'administrador' || user.rol === 'operador_analista';
  const isAssignedAnalyst = expediente.analista_id === user.id;

  if (isAdmin || isAssignedAnalyst) return;

  // Propietario / inmobiliaria pueden cerrar SUS expedientes terminales.
  // No tienen permiso para hacer transiciones intermedias (las del analista).
  const isPropietarioRol = user.rol === 'propietario' || user.rol === 'inmobiliaria';
  if (isPropietarioRol) {
    // El estudio tiene que estar en su cartera: el miembro restringido de la
    // organización, solo lo suyo o lo que le asignaron.
    const esDueno = await assertExpedienteAccess(expediente.id, user.id, user.rol).then(
      () => true,
      () => false,
    );
    if (!esDueno) {
      throw AppError.forbidden(
        'Solo el dueño del inmueble puede cambiar el estado de este estudio',
        'EXPEDIENTE_FORBIDDEN',
      );
    }
    const allowed = PROPIETARIO_TRANSITIONS.some(
      (t) => t.from === fromState && t.to === toState,
    );
    if (!allowed) {
      throw AppError.forbidden(
        `Como ${user.rol} solo puedes cerrar estudios ya aprobados o rechazados. La transicion ${fromState} → ${toState} requiere un administrador.`,
        'TRANSITION_NOT_ALLOWED_FOR_ROLE',
      );
    }
    return;
  }

  throw AppError.forbidden(
    'Solo el analista asignado, un administrador o el dueño del inmueble pueden transicionar este estudio',
    'FORBIDDEN',
  );
}

async function checkPreconditions(
  preconditions: readonly PreconditionId[],
  expediente: ExpedienteRow,
  input: TransitionInput,
): Promise<void> {
  for (const precondition of preconditions) {
    await checkSinglePrecondition(precondition, expediente, input);
  }
}

async function checkSinglePrecondition(
  precondition: PreconditionId,
  expediente: ExpedienteRow,
  input: TransitionInput,
): Promise<void> {
  switch (precondition) {
    case 'ANALISTA_ASIGNADO': {
      if (!expediente.analista_id) {
        throw AppError.badRequest(
          'El estudio debe tener un analista asignado',
          'PRECONDITION_FAILED',
          { precondition: 'ANALISTA_ASIGNADO' },
        );
      }
      break;
    }

    case 'DOCUMENTOS_EXISTENTES': {
      const { count, error } = await (supabase
        .from('documentos' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('expediente_id', expediente.id);

      if (error || !count || count === 0) {
        throw AppError.badRequest(
          'El estudio debe tener al menos un documento',
          'PRECONDITION_FAILED',
          { precondition: 'DOCUMENTOS_EXISTENTES' },
        );
      }
      break;
    }

    case 'ESTUDIO_APROBADO': {
      const { count, error } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('expediente_id', expediente.id)
        .eq('resultado', 'aprobado');

      if (error || !count || count === 0) {
        throw AppError.badRequest(
          'Se requiere un estudio con resultado aprobado',
          'PRECONDITION_FAILED',
          { precondition: 'ESTUDIO_APROBADO' },
        );
      }
      break;
    }

    case 'ESTUDIO_RECHAZADO': {
      const { count, error } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('expediente_id', expediente.id)
        .eq('resultado', 'rechazado');

      if (error || !count || count === 0) {
        throw AppError.badRequest(
          'Se requiere un estudio con resultado rechazado',
          'PRECONDITION_FAILED',
          { precondition: 'ESTUDIO_RECHAZADO' },
        );
      }
      break;
    }

    case 'ESTUDIO_CONDICIONADO': {
      const { count, error } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('expediente_id', expediente.id)
        .eq('resultado', 'condicionado');

      if (error || !count || count === 0) {
        throw AppError.badRequest(
          'Se requiere un estudio con resultado condicionado',
          'PRECONDITION_FAILED',
          { precondition: 'ESTUDIO_CONDICIONADO' },
        );
      }
      break;
    }

    case 'DOCUMENTOS_NUEVOS_DESDE_ULTIMA_TRANSICION': {
      const { data: lastEvent } = await (supabase
        .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
        .select('created_at')
        .eq('expediente_id', expediente.id)
        .eq('tipo', 'estado')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (lastEvent) {
        const evt = lastEvent as unknown as { created_at: string };
        const { count, error } = await (supabase
          .from('documentos' as string) as ReturnType<typeof supabase.from>)
          .select('id', { count: 'exact', head: true })
          .eq('expediente_id', expediente.id)
          .gt('created_at', evt.created_at);

        if (error || !count || count === 0) {
          throw AppError.badRequest(
            'Se requieren documentos nuevos desde la ultima revision',
            'PRECONDITION_FAILED',
            { precondition: 'DOCUMENTOS_NUEVOS_DESDE_ULTIMA_TRANSICION' },
          );
        }
      }
      break;
    }

    case 'CONTRATO_FIRMADO_O_MOTIVO': {
      // Aceptamos motivo o comentario indistintamente — el modal del frontend
      // tiene un solo campo "Comentario / Motivo" y lo manda como `comentario`.
      if (input.motivo?.trim() || input.comentario?.trim()) {
        break;
      }

      const { count, error } = await (supabase
        .from('contratos' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('expediente_id', expediente.id)
        .eq('estado', 'firmado');

      if (error || !count || count === 0) {
        throw AppError.badRequest(
          'Se requiere un contrato firmado o un motivo/comentario de cierre',
          'PRECONDITION_FAILED',
          { precondition: 'CONTRATO_FIRMADO_O_MOTIVO' },
        );
      }
      break;
    }

    case 'MOTIVO_CIERRE': {
      // Para cancelaciones desde estados activos: motivo o comentario obligatorio.
      // El modal manda `comentario` (campo único "Comentario / Motivo"), pero
      // aceptamos cualquiera para no acoplar la regla al naming del UI.
      if (!input.motivo?.trim() && !input.comentario?.trim()) {
        throw AppError.badRequest(
          'Se requiere un motivo/comentario para cerrar el estudio',
          'PRECONDITION_FAILED',
          { precondition: 'MOTIVO_CIERRE' },
        );
      }
      break;
    }
  }
}

function buildTimelineDescription(
  from: EstadoExpediente,
  to: EstadoExpediente,
  user: AuthUser,
  input: TransitionInput,
): string {
  let desc = `Estado cambiado de '${from}' a '${to}' por ${user.email}`;
  if (input.motivo) {
    desc += `. Motivo: ${input.motivo}`;
  }
  // P34: el fundamento de un rechazo no va en la descripción; queda en
  // `comentario`, que solo ve Cofianza.
  if (input.comentario && to !== 'rechazado') {
    desc += `. Comentario: ${input.comentario}`;
  }
  return desc;
}

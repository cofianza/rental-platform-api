// ============================================================
// Orchestrator — Motor de automatizacion de flujos
// Conecta eventos del sistema con acciones automaticas
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { sendEstudioAprobadoEmail, sendEstudioRechazadoEmail, sendDocumentosRequeridosEmail, sendArrendatarioAprobadoNotificacionEmail } from './orchestrator.emails';
import { notificarUsuario, notificarResponsableExpediente } from '@/modules/notificaciones/notificaciones.service';
import { enviarTemplate } from '@/modules/whatsapp';
import { resolveNombreDueno } from '@/lib/tenantScope';
import {
  motivoProspectoReglasDuras,
  inferirReglasDurasDesdeMotivo,
} from '@/modules/estudios/reglas-duras';
import type { ReglaDuraActiva } from '@/modules/estudios/reglas-duras';
// §6.3: la señal canonica de pago y la decision de orden (pura).
import {
  leerSenalPagoEstudio,
  senalIndicaPagado,
  siguientePasoEstudio,
  ESTADO_ESPERANDO_PAGO,
  type SenalPagoEstudio,
} from '@/modules/estudios/pago.guard';

/**
 * Un rechazo por REGLA DURA de la Politica V4.1 (DTI > 65% §4.2, canon/ingreso
 * > 40% §4.3) no se parece al rechazo por score bajo que este orquestador
 * conocia: el score puede ser altisimo (773 en el caso de produccion que
 * motivo la activacion) y sin embargo el estudio se rechaza.
 *
 * Sin esta lectura, los tres efectos del rechazo mienten:
 *   - el timeline diria "Estudio crediticio rechazado (Score: 773)", como si
 *     el score fuera la causa;
 *   - el banner del expediente diria solo "fue rechazado", perdiendo las
 *     cifras que el gestor necesita (Politica §2, trazabilidad);
 *   - el correo al prospecto le mostraria su score al lado de "no cumplio los
 *     requisitos minimos".
 *
 * RESPALDO, no camino principal. Lo normal es que el veredicto llegue EN
 * MEMORIA por los parametros del evento (dispararHookPostResultado lo propaga
 * desde el mismo punto que decidio). Esta lectura solo cubre a los llamadores
 * que no lo traen — y por eso no puede depender de una columna nueva:
 * `regla_dura_activada` solo existe si corrio la migracion, y mientras no corra
 * un SELECT que la nombre falla entero (42703) y devolveria el caso vacio.
 *
 * De ahi los dos pasos: primero `motivo_rechazo`, que existe desde siempre y
 * lleva el marcador de regla dura al inicio del texto; y solo si la columna
 * existe se prefieren sus codigos, que son el dato canonico.
 */
async function leerReglaDuraDelEstudio(estudioId: string): Promise<{
  reglas: ReglaDuraActiva[];
  motivoGestor: string | null;
}> {
  if (!estudioId) return { reglas: [], motivoGestor: null };
  try {
    const { data, error } = await db('estudios')
      .select('motivo_rechazo')
      .eq('id', estudioId)
      .maybeSingle();
    if (error) {
      logger.warn(
        { estudioId, error: error.message },
        'Orchestrator: no se pudo leer motivo_rechazo — se usan los textos genericos',
      );
      return { reglas: [], motivoGestor: null };
    }
    const motivoGestor = (data as { motivo_rechazo?: string | null } | null)?.motivo_rechazo ?? null;
    const reglas = inferirReglasDurasDesdeMotivo(motivoGestor);

    // Codigos canonicos si la columna ya existe. Un fallo aqui (migracion sin
    // correr) NO degrada nada: ya tenemos las reglas inferidas del texto.
    const { data: colData, error: colError } = await db('estudios')
      .select('regla_dura_activada')
      .eq('id', estudioId)
      .maybeSingle();
    if (!colError) {
      const codigos = (colData as { regla_dura_activada?: unknown } | null)?.regla_dura_activada;
      if (Array.isArray(codigos) && codigos.length > 0) {
        return { reglas: codigos as ReglaDuraActiva[], motivoGestor };
      }
    }

    return { reglas, motivoGestor };
  } catch (err) {
    logger.warn(
      { estudioId, err: err instanceof Error ? err.message : String(err) },
      'Orchestrator: excepcion leyendo la regla dura — se usan los textos genericos',
    );
    return { reglas: [], motivoGestor: null };
  }
}

// ── Type-safe Supabase helper (same pattern as rest of project) ──
const db = (table: string) => (supabase.from(table as string) as ReturnType<typeof supabase.from>);

/**
 * WhatsApp al dueño del inmueble (propietario/inmobiliaria) con un template de
 * estudio. Resuelve nombre + teléfono del dueño desde `perfiles`. Best-effort:
 * sin teléfono no envía y enviarTemplate traga errores.
 */
async function enviarWhatsAppDueno(
  propietarioId: string,
  template: 'ESTUDIO_APROBADO_DUENO' | 'ESTUDIO_CONDICIONADO_DUENO',
  nombreArrendatario: string,
  direccion: string,
  expedienteId: string,
) {
  const { data: prop } = await db('perfiles')
    .select('telefono')
    .eq('id', propietarioId)
    .maybeSingle();
  const p = prop as { telefono?: string | null } | null;
  // Nombre del dueño: razón social → nombre de la inmobiliaria → nombre+apellido.
  const nombreDueno = await resolveNombreDueno(propietarioId);
  await enviarTemplate({
    to: p?.telefono ?? null,
    template,
    variables: [nombreDueno, nombreArrendatario, direccion],
    context: { expediente_id: expedienteId },
  });
}

/** Solicitante (nombre/teléfono) del expediente — para los WhatsApp de status. */
async function getSolicitanteDelExpediente(expedienteId: string) {
  const { data } = await db('expedientes')
    .select('solicitante_id, inmueble_id, solicitantes(nombre, telefono)')
    .eq('id', expedienteId)
    .maybeSingle();
  const row = data as {
    inmueble_id: string | null;
    solicitantes: { nombre: string | null; telefono: string | null } | null;
  } | null;
  return { sol: row?.solicitantes ?? null, inmuebleId: row?.inmueble_id ?? null };
}

// ── Event: Habeas Data Autorizado ───────────────────────────

export async function onHabeasDataAutorizado(params: {
  expedienteId: string;
  solicitanteId: string;
  autorizacionId: string;
}) {
  const { expedienteId, solicitanteId, autorizacionId } = params;

  logger.info({ expedienteId, solicitanteId }, 'Orchestrator: habeas data autorizado, iniciando estudio automatico');

  try {
    // 1. Buscar estudio pendiente del expediente (con error leído: un fallo de
    //    BD aquí no debe confundirse con "no hay estudio")
    // `pago_pendiente` entra en la lista desde el §6.3: con el orden invertido
    // un estudio puede estar EN ESPERA DE PAGO cuando llega una segunda firma
    // (reenvio del enlace), y dejarlo fuera lo volvia invisible para siempre.
    // El .neq del tipo es un bug preexistente que la inversion vuelve
    // frecuente: sin el, la firma del TITULAR tomaba el estudio del
    // co-arrendatario (mismo expediente_id, creado despues) y le pisaba
    // `datos_formulario` con el documento del titular.
    const { data: estudio, error: estudioError } = await db('estudios')
      .select('id, estado, proveedor, expediente_id, datos_formulario, pago_por')
      .eq('expediente_id', expedienteId)
      .neq('tipo', 'con_coarrendatario')
      .in('estado', ['solicitado', 'pago_pendiente', 'formulario_completado', 'formulario_enviado', 'documentos_cargados'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle() as { data: Record<string, unknown> | null; error: { message: string } | null };

    if (estudioError) {
      throw new Error(`Error consultando estudio pendiente: ${estudioError.message}`);
    }
    if (!estudio) {
      logger.warn({ expedienteId }, 'Orchestrator: no se encontro estudio pendiente');
      return;
    }

    // 2. Obtener datos del solicitante
    const { data: solicitante, error: solicitanteError } = await db('solicitantes')
      .select('nombre, apellido, tipo_documento, numero_documento, email, telefono')
      .eq('id', solicitanteId)
      .maybeSingle() as { data: Record<string, unknown> | null; error: { message: string } | null };

    if (solicitanteError) {
      throw new Error(`Error consultando solicitante: ${solicitanteError.message}`);
    }
    if (!solicitante) {
      logger.warn({ solicitanteId }, 'Orchestrator: solicitante no encontrado');
      return;
    }

    // 3. Actualizar estudio. MERGE de datos_formulario donde lo existente GANA:
    //    si el solicitante ya envió el formulario self-service (posiblemente
    //    con una cédula corregida o con ingresos/ocupación), esos datos no se
    //    pisan con el snapshot de la tabla solicitantes.
    const datosBase = {
      nombre_completo: `${solicitante.nombre} ${solicitante.apellido}`,
      tipo_documento: solicitante.tipo_documento,
      numero_documento: solicitante.numero_documento,
      email: solicitante.email,
      telefono: solicitante.telefono || '',
      acepta_terminos: true,
    };
    const datosExistentes = (estudio.datos_formulario as Record<string, unknown> | null) ?? {};
    // Merge: lo que el solicitante envió gana, pero los valores VACÍOS no pisan
    // (un '' guardado bloquearía para siempre el dato bueno del snapshot), y el
    // documento SIEMPRE viene de `solicitantes` (es el system-of-record: se
    // sincroniza tras cada ejecución y al corregirlo con validación).
    const limpios = Object.fromEntries(
      Object.entries(datosExistentes).filter(([, v]) => v !== null && v !== undefined && v !== ''),
    );
    const datosMerged = {
      ...datosBase,
      ...limpios,
      tipo_documento: datosBase.tipo_documento,
      numero_documento: datosBase.numero_documento,
      acepta_terminos: true,
    };
    //    Y el ESTADO depende del §6.3: si el pago ya entró (opciones A y B, y
    //    los expedientes de siempre) el estudio queda listo para ejecutar; si
    //    no, queda EN ESPERA DE PAGO — "el estudio permanece en estado de
    //    espera y no consume consultas a centrales".
    const senalPago = await leerSenalPagoEstudio(expedienteId);
    const pagado = senalIndicaPagado(senalPago);
    // 'no_verificable' (blip de PostgREST) NO aparca. Aparcar es irreversible
    // en la practica: en A y B el pago YA ocurrio, asi que no habra otro
    // onEstudioPagado que despierte el estudio, 'pago_pendiente' no esta en
    // ESTADOS_PERMITIDOS_EJECUCION (el boton Ejecutar responde
    // ESTUDIO_ESTADO_INVALIDO) y cuenta como estudio en curso, bloqueando
    // cualquier otro. Un error de lectura dejaria muerto un expediente pagado
    // y firmado. El fail-closed del dinero ya lo da assertPagoEstudio dentro
    // de ejecutarEstudio: aqui aparcar no aporta seguridad, solo un pozo.
    const aparcar = senalPago === 'no_pagado';

    const { error: updateError } = await db('estudios')
      .update({
        datos_formulario: datosMerged,
        ...(pagado ? { estado: 'formulario_completado' } : aparcar ? { estado: ESTADO_ESPERANDO_PAGO } : {}),
        autorizacion_habeas_data_id: autorizacionId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq('id', estudio.id);

    if (updateError) {
      throw new Error(`Error preparando el estudio para ejecución: ${(updateError as { message?: string }).message}`);
    }

    // 3.5 §6.3 — el cobro va DESPUÉS de la autorización y ANTES de la
    //     evaluación. Si todavía no hay pago, aquí NO se ejecuta nada: se pide
    //     el cobro (o se espera al que ya está en marcha) y el estudio queda
    //     aparcado. Ojo: aunque este return no existiera, ejecutarEstudio tiene
    //     su propio gate de pago — este camino solo evita el ruido de intentar.
    if (!pagado) {
      // RE-LECTURA DESPUES de escribir el estado: cierra la carrera con el
      // pago que entra en paralelo. Si el gestor pulsa "liberar credito" /
      // "yo asumo" entre la lectura de arriba y este UPDATE, su
      // `onEstudioPagado` corre cuando el estudio todavia esta en 'solicitado'
      // y su CAS sobre 'pago_pendiente' no encuentra nada: se da por hecho y
      // no reintenta. Sin esta relectura el estudio quedaba pagado (credito
      // consumido) y aparcado para siempre. Con ella, quien escribio ultimo el
      // estado es quien reevalua.
      const senalPost = aparcar ? await leerSenalPagoEstudio(expedienteId) : senalPago;
      if (senalPost === 'pagado') {
        await onEstudioPagado(expedienteId, solicitanteId);
        return;
      }
      await pedirPagoTrasAutorizacion({
        expedienteId,
        senalPago: senalPost,
        pagoPor: (estudio.pago_por as string | null) ?? null,
      });
      return;
    }

    // 4. Ejecutar estudio via provider. ejecutarEstudio dispara el proceso en
    //    background y retorna de inmediato — NO consultamos el estado aquí:
    //    la consulta inmediata siempre fallaba con SIN_REFERENCIA_PROVEEDOR
    //    (la referencia aún no se persiste) y generaba una falsa alarma de
    //    "falló el inicio" en el timeline en CADA arranque exitoso. El
    //    resultado llega solo vía registrarResultadoInline + onEstudioCompletado.
    const { ejecutarEstudio } = await import('@/modules/estudios/estudios.service');

    try {
      await ejecutarEstudio(estudio.id as string, solicitanteId);
      logger.info({ estudioId: estudio.id }, 'Orchestrator: estudio disparado en background');
    } catch (providerError) {
      // Si TransUnion no esta configurado o falla, el estudio queda como 'fallido'
      // pero el flujo no se bloquea. Dejar rastro VISIBLE en el expediente: sin
      // esto, el equipo no se entera de que el inicio automático falló.
      logger.warn({ error: providerError, estudioId: estudio.id }, 'Orchestrator: provider no disponible, estudio requiere atencion manual');
      await registrarTimeline(
        expedienteId,
        'estudio',
        'Falló el inicio automático del estudio tras la autorización — requiere atención (el solicitante puede reintentar desde su panel)',
      ).catch(() => {});
    }

    logger.info({ estudioId: estudio.id, expedienteId }, 'Orchestrator: flujo automatico de estudio ejecutado');
  } catch (error) {
    // Error duro (BD caída, update fallido): rastro visible en el expediente.
    logger.error({ error, expedienteId }, 'Orchestrator: error en onHabeasDataAutorizado');
    await registrarTimeline(
      expedienteId,
      'estudio',
      'Falló el inicio automático del estudio tras la autorización — iniciar manualmente o pedir al solicitante reintentar',
    ).catch(() => {});
  }
}

// ── §6.3: el punto UNICO de convergencia ────────────────────
//
// La firma y el pago son dos eventos que pueden llegar en cualquier orden (y a
// la vez). En vez de tener logica espejada en cada hook, los dos terminan
// consultando la misma decision pura (`siguientePasoEstudio`), de modo que el
// orden de llegada deja de importar POR CONSTRUCCION y no por analisis caso a
// caso.

/**
 * Autorizacion del TITULAR del expediente. Mismo predicado que
 * `enviarEnlaceAutorizacion` y que el gate 8.4 — si se desincronizan, las capas
 * se contradicen: `coarrendatario_id IS NULL` (el co-arrendatario tiene su
 * propia fila con el mismo expediente_id), no revocada y VIGENTE.
 */
async function leerAutorizacionTitular(
  expedienteId: string,
): Promise<{ id: string; estado: string } | null> {
  const { data, error } = (await db('autorizaciones_habeas_data')
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .is('fecha_revocacion', null)
    .in('estado', ['pendiente', 'autorizado'])
    .or(`vigente_hasta.is.null,vigente_hasta.gt.${new Date().toISOString()}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()) as { data: { id: string; estado: string } | null; error: { message: string } | null };
  // Fail-closed, mismo criterio que pago.guard.ts sobre `pagos`: "no pude
  // leer" NO es "no hay autorizacion". Confundirlos manda un habeas data a
  // quien ya firmo (AUTORIZACION_YA_FIRMADA -> warn) y deja el estudio pagado
  // y aparcado sin salida, guiando al operador a un boton que tambien falla.
  // Los tres call-sites llaman a onEstudioPagado fire-and-forget con .catch,
  // asi que el throw queda como warn y el pago se puede reintentar.
  if (error) {
    throw new Error(`No se pudo verificar la autorizacion del titular: ${error.message}`);
  }
  return data;
}

/** ¿Hay una fila de pago de estudio VIVA (el cobro ya salio)? */
async function hayPagoEstudioActivo(expedienteId: string): Promise<boolean> {
  const { data } = (await db('pagos')
    .select('id')
    .eq('expediente_id', expedienteId)
    .eq('concepto', 'estudio')
    .in('estado', ['pendiente', 'procesando'])
    .limit(1)
    .maybeSingle()) as { data: { id: string } | null };
  return !!data;
}

/**
 * El prospecto acaba de autorizar y NO hay pago confirmado. Aqui vive la
 * inversion del §6.3: recien ahora se le pide el dinero.
 *
 * - opcion C (pago_por='arrendatario'): se crea el link y se le manda por
 *   correo + WhatsApp. `enviarLinkPago` es reentrante a proposito — es la
 *   MISMA funcion que el gestor dispara desde el panel, solo que aquella vez
 *   se desvio a mandar el habeas data.
 * - el gestor todavia no eligio quien paga, o ya hay un link vivo: el estudio
 *   queda EN ESPERA y el aviso va al expediente. Cobrarle al prospecto por
 *   defecto le pisaria la decision al gestor (podia querer usar un credito).
 */
async function pedirPagoTrasAutorizacion(params: {
  expedienteId: string;
  senalPago: SenalPagoEstudio;
  pagoPor: string | null;
}): Promise<void> {
  const { expedienteId, senalPago, pagoPor } = params;

  const paso = siguientePasoEstudio({
    autorizado: true,
    senalPago,
    pagoActivo: await hayPagoEstudioActivo(expedienteId),
    pagoPor,
  });

  if (paso !== 'cobrar') {
    await registrarTimeline(
      expedienteId,
      'estudio',
      'Autorización firmada. El estudio queda EN ESPERA del pago: no se consulta a centrales de riesgo hasta confirmarlo.',
    ).catch(() => {});
    return;
  }

  const { data: expRow } = (await db('expedientes')
    .select('creado_por, solicitantes(nombre, apellido, email)')
    .eq('id', expedienteId)
    .maybeSingle()) as {
    data: {
      creado_por: string | null;
      solicitantes: { nombre: string | null; apellido: string | null; email: string | null } | null;
    } | null;
  };
  const sol = expRow?.solicitantes ?? null;
  if (!expRow?.creado_por || !sol?.email) {
    logger.warn({ expedienteId }, 'Orchestrator §6.3: sin creado_por o sin email del solicitante — no se puede generar el cobro');
    await registrarTimeline(
      expedienteId,
      'estudio',
      'El arrendatario ya autorizó, pero no pudimos generarle el cobro (falta su correo). Define el pago desde el expediente.',
    ).catch(() => {});
    return;
  }

  const { enviarLinkPago } = await import('@/modules/pago-estudio/pago-estudio.service');
  try {
    await enviarLinkPago(
      expedienteId,
      {
        email_pagador: sol.email,
        nombre_pagador: `${sol.nombre ?? ''} ${sol.apellido ?? ''}`.trim() || sol.email,
      },
      expRow.creado_por,
    );
    await registrarTimeline(
      expedienteId,
      'pago',
      'Autorización firmada: se le envió al arrendatario el enlace de pago del estudio (correo y WhatsApp).',
    ).catch(() => {});
  } catch (err) {
    const code = err instanceof AppError ? err.errorCode : null;
    // Carreras con el gestor, que resuelven solas:
    //   YA_COMPLETADO -> alguien pago/asumio mientras tanto: reentrar UNA vez.
    //   PENDIENTE/23505 -> otro evento gano y ya hay link vivo: no hacer nada.
    if (code === 'PAGO_ESTUDIO_YA_COMPLETADO') {
      await onEstudioPagado(expedienteId, expRow.creado_por);
      return;
    }
    if (code === 'PAGO_ESTUDIO_PENDIENTE') return;
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), expedienteId },
      'Orchestrator §6.3: no se pudo generar el cobro tras la autorización',
    );
    await registrarTimeline(
      expedienteId,
      'pago',
      // El tope de canon (§4.4) puede rechazar el cobro DESPUÉS de la firma: es
      // el modo de falla nuevo que trae la inversión. Sin este rastro el
      // expediente quedaba en espera sin causa visible para el gestor.
      `No se pudo generar el cobro del estudio tras la autorización (${err instanceof Error ? err.message : 'error'}). Revísalo desde el expediente.`,
    ).catch(() => {});
  }
}

/**
 * DUEÑO UNICO de "el estudio de este expediente quedo pagado".
 *
 * Reemplaza las TRES copias del bloque "ya se pago -> mandar autorizacion" que
 * vivian en onPagoConfirmado, asumirCosto y liberarEstudioConCredito. Tras la
 * inversion del §6.3 esas tres llamaban a `enviarEnlaceAutorizacion` incluso
 * cuando la firma YA existia, y esa funcion lanza AUTORIZACION_YA_FIRMADA: el
 * `.catch` lo degradaba a un warn y el estudio quedaba pagado y parado para
 * siempre. Aqui se bifurca:
 *
 *   ya firmo   -> se despierta el estudio aparcado y se ejecuta (CAS sobre
 *                 'pago_pendiente': idempotente frente a los tres caminos que
 *                 confirman un pago — webhook, cron de reconciliacion y el
 *                 endpoint publico de retorno de la pasarela).
 *   pendiente  -> nada: la firma disparara la ejecucion.
 *   sin firma  -> se le manda el habeas data (comportamiento de siempre para
 *                 A y B, y para las opciones C que quedaron en vuelo).
 *
 * Devuelve true solo si disparo la ejecucion de algun estudio.
 */
export async function onEstudioPagado(expedienteId: string, userId?: string | null): Promise<boolean> {
  const autorizacion = await leerAutorizacionTitular(expedienteId);

  if (!autorizacion) {
    if (!userId) {
      logger.warn({ expedienteId }, 'Orchestrator: pago de estudio sin autorización y sin usuario para enviar el enlace');
      return false;
    }
    try {
      const { enviarEnlaceAutorizacion } = await import('@/modules/autorizaciones/autorizaciones.service');
      await enviarEnlaceAutorizacion(expedienteId, userId);
      logger.info({ expedienteId }, 'Orchestrator: link de autorización enviado tras el pago');
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), expedienteId },
        'Orchestrator: no se pudo enviar el link de autorización tras el pago',
      );
      await registrarTimeline(
        expedienteId,
        'pago',
        'No se pudo enviar automáticamente el link de autorización al inquilino. Reenvíalo manualmente desde el expediente.',
      ).catch(() => {});
    }
    return false;
  }

  if (autorizacion.estado !== 'autorizado') {
    logger.info({ expedienteId }, 'Orchestrator: pago confirmado, esperando la firma del arrendatario');
    return false;
  }

  // CAS: solo despierta a los que estaban EN ESPERA DE PAGO. Multi-fila a
  // propósito — el estudio del co-arrendatario se aparca igual y arranca junto
  // con el del titular.
  const { data: despertados, error: casErr } = (await db('estudios')
    .update({ estado: 'formulario_completado', updated_at: new Date().toISOString() } as never)
    .eq('expediente_id', expedienteId)
    .eq('estado', ESTADO_ESPERANDO_PAGO)
    .select('id')) as { data: { id: string }[] | null; error: { message: string } | null };

  if (casErr) {
    logger.error({ error: casErr.message, expedienteId }, 'Orchestrator: no se pudo despertar el estudio tras el pago');
    return false;
  }
  if (!despertados || despertados.length === 0) {
    logger.info({ expedienteId }, 'Orchestrator: pago confirmado pero no había estudio en espera de pago');
    return false;
  }

  const { ejecutarEstudio } = await import('@/modules/estudios/estudios.service');
  let alguno = false;
  for (const { id } of despertados) {
    try {
      await ejecutarEstudio(id, userId ?? '');
      alguno = true;
      logger.info({ estudioId: id, expedienteId }, 'Orchestrator: estudio disparado tras confirmarse el pago');
    } catch (err) {
      logger.warn({ error: err, estudioId: id }, 'Orchestrator: falló el arranque del estudio tras el pago');
      await registrarTimeline(
        expedienteId,
        'estudio',
        'Falló el inicio automático del estudio tras confirmarse el pago — iniciar manualmente desde el expediente.',
      ).catch(() => {});
    }
  }
  return alguno;
}

// ── Event: Estudio Completado ───────────────────────────────

export async function onEstudioCompletado(params: {
  estudioId: string;
  expedienteId: string;
  resultado: string;
  score: number | null;
  solicitanteId: string;
  /**
   * Reglas duras que forzaron el rechazo, tal como las devolvio el punto de
   * decision. Viene en memoria desde dispararHookPostResultado: asi los textos
   * de esta rama no dependen de ninguna columna ni de ningun UPDATE
   * best-effort. Ausente (llamador antiguo) -> se cae al respaldo por fila.
   */
  reglasDuras?: readonly ReglaDuraActiva[];
  /** Motivo con cifras para el gestor. Acompaña a `reglasDuras`. */
  motivoGestorReglaDura?: string | null;
}) {
  const { estudioId, expedienteId, resultado, score } = params;

  logger.info({ estudioId, expedienteId, resultado, score }, 'Orchestrator: estudio completado');

  try {
    // Obtener datos del expediente con joins
    const { data: expediente } = await db('expedientes')
      .select('id, numero, inmueble_id, solicitante_id')
      .eq('id', expedienteId)
      .single() as { data: Record<string, unknown> | null };

    if (!expediente) return;

    // Obtener solicitante y inmueble por separado (evita joins complejos)
    const { data: sol } = await db('solicitantes')
      .select('nombre, apellido, email, telefono')
      .eq('id', expediente.solicitante_id)
      .single() as { data: { nombre: string; apellido: string; email: string; telefono: string | null } | null };

    const { data: inm } = await db('inmuebles')
      .select('id, direccion, ciudad, valor_arriendo, propietario_id')
      .eq('id', expediente.inmueble_id)
      .single() as { data: { id: string; direccion: string; ciudad: string; valor_arriendo: number; propietario_id: string } | null };

    if (resultado === 'aprobado') {
      // ── APROBADO ──
      await transicionarExpediente(expedienteId, 'en_revision');
      const transiciono = await transicionarExpediente(expedienteId, 'aprobado');

      // Si el expediente no llegó a 'aprobado' (ya estaba aprobado, o está en
      // un estado que no lo permite) NO se disparan los efectos: mandar el
      // correo "tu estudio fue aprobado" y pedirle al dueño que genere el
      // contrato sobre un expediente que no avanzó produce un boton que falla
      // con EXPEDIENTE_NO_APROBADO — y, si ya estaba aprobado, un correo
      // duplicado.
      if (!transiciono) {
        logger.warn(
          { expedienteId, resultado },
          'Orchestrator: resultado aprobado pero el expediente no transicionó — se omiten notificaciones',
        );
        return;
      }

      // Decisión Mario (2026-05-05): NO auto-generar el contrato. La duración
      // del contrato y la fecha de inicio las decide el propietario justo
      // antes de generar — no antes del estudio. El expediente queda en
      // 'aprobado' y el panel del propietario muestra el card "Generar
      // contrato" que pide los datos y dispara la generación.
      await registrarTimeline(expedienteId, 'estudio', `Estudio crediticio aprobado (Score: ${score}). El propietario debe generar el contrato desde el panel.`);

      if (sol?.email) {
        sendEstudioAprobadoEmail({
          email: sol.email,
          nombre: `${sol.nombre} ${sol.apellido}`,
          inmueble: inm?.direccion || '',
          ciudad: inm?.ciudad || '',
          score,
        }).catch((e) => logger.warn({ error: e }, 'Orchestrator: error email aprobado'));
      }

      // Notificar al propietario/inmobiliaria que el arrendatario fue aprobado
      if (inm?.propietario_id && sol) {
        try {
          const { data: propietario } = await db('perfiles')
            .select('nombre, apellido, razon_social')
            .eq('id', inm.propietario_id)
            .single() as { data: { nombre: string; apellido: string; razon_social: string | null } | null };

          // Obtener email del propietario via Supabase Auth admin
          const { data: authUserData } = await supabase.auth.admin.getUserById(inm.propietario_id);
          const propietarioEmail = authUserData?.user?.email;

          if (propietarioEmail && propietario) {
            sendArrendatarioAprobadoNotificacionEmail({
              email: propietarioEmail,
              nombre_propietario: propietario.razon_social || `${propietario.nombre} ${propietario.apellido}`,
              nombre_arrendatario: `${sol.nombre} ${sol.apellido}`,
              inmueble: inm.direccion || '',
              ciudad: inm.ciudad || '',
              email_arrendatario: sol.email,
              telefono_arrendatario: sol.telefono || undefined,
            }).catch((e) => logger.warn({ error: e }, 'Orchestrator: error email notificacion propietario'));
          }
        } catch (e) {
          logger.warn({ error: e }, 'Orchestrator: error obteniendo datos propietario para notificacion');
        }

        // Notificacion in-app al propietario: el estudio fue aprobado y el
        // siguiente paso es generar el contrato desde su panel. Fire-and-forget.
        notificarUsuario({
          userId: inm.propietario_id,
          tipo: 'estudio.aprobado.propietario',
          titulo: 'Estudio del arrendatario aprobado',
          mensaje: `${sol.nombre} ${sol.apellido} fue aprobado para ${inm.direccion || 'tu inmueble'}. Genera el contrato desde el expediente para continuar.`,
          link: `/expedientes/${expedienteId}`,
          payload: { expediente_id: expedienteId, score, solicitante_email: sol.email },
        }).catch((e) => logger.warn({ error: e }, 'Orchestrator: error notif in-app propietario aprobado'));

        // Espejo para el miembro responsable del expediente (in-app + WhatsApp).
        notificarResponsableExpediente({
          expedienteId,
          excluirPerfilId: inm.propietario_id,
          tipo: 'estudio.aprobado.propietario',
          titulo: 'Estudio del arrendatario aprobado',
          mensaje: `${sol.nombre} ${sol.apellido} fue aprobado para ${inm.direccion || 'tu inmueble'}. Genera el contrato desde el expediente para continuar.`,
          link: `/expedientes/${expedienteId}`,
          payload: { expediente_id: expedienteId, score, solicitante_email: sol.email },
          whatsapp: {
            // variables[0] (nombre del dueño) lo sustituye el helper por el nombre del miembro.
            template: 'ESTUDIO_APROBADO_DUENO',
            variables: ['Hola', `${sol.nombre} ${sol.apellido}`, inm.direccion || 'tu inmueble'],
          },
        }).catch((e) => logger.warn({ error: e }, 'Orchestrator: error notif responsable aprobado'));

        // WhatsApp al dueño: "el estudio fue aprobado, genera el contrato".
        enviarWhatsAppDueno(inm.propietario_id, 'ESTUDIO_APROBADO_DUENO', `${sol.nombre} ${sol.apellido}`, inm.direccion || 'tu inmueble', expedienteId)
          .catch((e) => logger.warn({ error: e }, 'Orchestrator: error WhatsApp dueño aprobado'));
      }

    } else if (resultado === 'rechazado') {
      // ── RECHAZADO ──
      await transicionarExpediente(expedienteId, 'en_revision');
      const transiciono = await transicionarExpediente(expedienteId, 'rechazado');

      // Mismo criterio que la rama aprobado: sin transición no hay efectos.
      // Aquí además evita el caso grave — liberar el inmueble de un expediente
      // que sigue vivo (ver migración 20260817000002).
      if (!transiciono) {
        logger.warn(
          { expedienteId, resultado },
          'Orchestrator: resultado rechazado pero el expediente no transicionó — se omiten notificaciones y NO se libera el inmueble',
        );
        return;
      }
      // ¿Fue una regla dura de la Politica V4.1, o el score bajo de siempre?
      // Cambia los tres textos de esta rama, no la mecanica.
      //
      // Preferimos SIEMPRE el veredicto que llego en memoria: es el mismo que
      // decidio, no puede haberse perdido en un UPDATE best-effort ni depende
      // de que la migracion de `regla_dura_activada` haya corrido. La lectura
      // por fila queda para los llamadores que no lo traen.
      const reglaDura =
        params.reglasDuras && params.reglasDuras.length > 0
          ? {
              reglas: [...params.reglasDuras],
              motivoGestor: params.motivoGestorReglaDura ?? null,
            }
          : await leerReglaDuraDelEstudio(estudioId);
      const porReglaDura = reglaDura.reglas.length > 0;

      await registrarTimeline(
        expedienteId,
        'estudio',
        porReglaDura
          ? `Estudio rechazado por regla dura de la Politica V4.1 (${reglaDura.reglas.join(', ')}). ` +
              `Las reglas duras anulan el puntaje total${score !== null ? `: el score del buro fue ${score}` : ''}.`
          : `Estudio crediticio rechazado (Score: ${score}).`,
      );

      // Persistir motivo legible para el banner de cierre. Si la transición
      // anterior no ocurrió (estado no era 'condicionado'), el .eq lo dejará
      // sin cambios — no rompe.
      //
      // Con regla dura se copia el motivo del estudio, que trae las cifras y
      // los umbrales (Politica §2 "trazabilidad"). Ese banner es gestor-only:
      // el prospecto ve el texto §10 de ExpedienteRechazadoBanner, que no lee
      // este campo.
      await db('expedientes')
        .update({
          motivo_rechazo:
            porReglaDura && reglaDura.motivoGestor
              ? reglaDura.motivoGestor
              : 'El estudio crediticio del titular fue rechazado. La solicitud no procede.',
        } as never)
        .eq('id', expedienteId)
        .eq('estado', 'rechazado');

      // Soltar la RESERVA del inmueble, si este expediente era su titular.
      // Llegar aquí ya implica que el expediente transicionó a 'rechazado'
      // (guard arriba). El helper es holder-aware (Flujo §4.2): si la reserva
      // es de OTRO candidato aprobado, o no hay reserva, no toca nada — antes
      // el criterio era "desde en_estudio", que con estudios simultáneos
      // liberaba propiedades ajenas.
      const { liberarReservaDeExpediente } = await import('@/modules/inmuebles/inmuebles.service');
      await liberarReservaDeExpediente(expedienteId);

      if (sol?.email) {
        // Al PROSPECTO va el motivo GENERAL en el lenguaje del Flujo §10, sin
        // porcentajes ni umbrales (Politica §2: "sin revelar los parametros
        // internos del modelo"). Y sin el score: mostrarle 773 al lado de "no
        // pudimos respaldar tu solicitud" es contradictorio y no explica nada.
        sendEstudioRechazadoEmail({
          email: sol.email,
          nombre: `${sol.nombre} ${sol.apellido}`,
          score: porReglaDura ? null : score,
          motivoGeneral: porReglaDura ? motivoProspectoReglasDuras(reglaDura.reglas) : null,
        }).catch((e) => logger.warn({ error: e }, 'Orchestrator: error email rechazado'));
      }

      // Notificacion in-app al propietario: el estudio fue rechazado, el flujo
      // termina aqui (no hay accion del propietario). Fire-and-forget.
      if (inm?.propietario_id && sol) {
        notificarUsuario({
          userId: inm.propietario_id,
          tipo: 'estudio.rechazado.propietario',
          titulo: 'Estudio del arrendatario rechazado',
          mensaje: `El estudio crediticio de ${sol.nombre} ${sol.apellido} para ${inm.direccion || 'tu inmueble'} fue rechazado. El expediente no avanza al contrato.`,
          link: `/expedientes/${expedienteId}`,
          payload: { expediente_id: expedienteId, score, solicitante_email: sol.email },
        }).catch((e) => logger.warn({ error: e }, 'Orchestrator: error notif in-app propietario rechazado'));

        // Espejo para el miembro responsable del expediente (in-app; sin WhatsApp).
        notificarResponsableExpediente({
          expedienteId,
          excluirPerfilId: inm.propietario_id,
          tipo: 'estudio.rechazado.propietario',
          titulo: 'Estudio del arrendatario rechazado',
          mensaje: `El estudio crediticio de ${sol.nombre} ${sol.apellido} para ${inm.direccion || 'tu inmueble'} fue rechazado. El expediente no avanza al contrato.`,
          link: `/expedientes/${expedienteId}`,
          payload: { expediente_id: expedienteId, score, solicitante_email: sol.email },
        }).catch((e) => logger.warn({ error: e }, 'Orchestrator: error notif responsable rechazado'));
      }

    } else if (resultado === 'condicionado') {
      // ── CONDICIONADO ──
      await transicionarExpediente(expedienteId, 'en_revision');
      const transiciono = await transicionarExpediente(expedienteId, 'condicionado');

      // Mismo criterio que las otras dos ramas: sin transición no hay efectos.
      if (!transiciono) {
        logger.warn(
          { expedienteId, resultado },
          'Orchestrator: resultado condicionado pero el expediente no transicionó — se omiten notificaciones',
        );
        return;
      }
      await registrarTimeline(expedienteId, 'estudio', `Estudio condicionado (Score: ${score}). Se requieren documentos adicionales.`);

      if (sol?.email) {
        sendDocumentosRequeridosEmail({ email: sol.email, nombre: `${sol.nombre} ${sol.apellido}`, score })
          .catch((e) => logger.warn({ error: e }, 'Orchestrator: error email condicionado'));
      }

      // Notificacion in-app al propietario: el estudio salio condicionado.
      // El propietario debe revisar la documentacion adicional cuando llegue
      // y decidir si proceder con el contrato. Fire-and-forget.
      if (inm?.propietario_id && sol) {
        notificarUsuario({
          userId: inm.propietario_id,
          tipo: 'estudio.condicionado.propietario',
          titulo: 'Estudio condicionado',
          mensaje: `El estudio de ${sol.nombre} ${sol.apellido} para ${inm.direccion || 'tu inmueble'} quedó condicionado. Revisa los documentos adicionales del solicitante y decide si proceder.`,
          link: `/expedientes/${expedienteId}`,
          payload: { expediente_id: expedienteId, score, solicitante_email: sol.email },
        }).catch((e) => logger.warn({ error: e }, 'Orchestrator: error notif in-app propietario condicionado'));

        // Espejo para el miembro responsable del expediente (in-app + WhatsApp).
        notificarResponsableExpediente({
          expedienteId,
          excluirPerfilId: inm.propietario_id,
          tipo: 'estudio.condicionado.propietario',
          titulo: 'Estudio condicionado',
          mensaje: `El estudio de ${sol.nombre} ${sol.apellido} para ${inm.direccion || 'tu inmueble'} quedó condicionado. Revisa los documentos adicionales del solicitante y decide si proceder.`,
          link: `/expedientes/${expedienteId}`,
          payload: { expediente_id: expedienteId, score, solicitante_email: sol.email },
          whatsapp: {
            // variables[0] (nombre del dueño) lo sustituye el helper por el nombre del miembro.
            template: 'ESTUDIO_CONDICIONADO_DUENO',
            variables: ['Hola', `${sol.nombre} ${sol.apellido}`, inm.direccion || 'tu inmueble'],
          },
        }).catch((e) => logger.warn({ error: e }, 'Orchestrator: error notif responsable condicionado'));

        // WhatsApp al dueño: "el estudio quedó condicionado, requiere tu revisión".
        enviarWhatsAppDueno(inm.propietario_id, 'ESTUDIO_CONDICIONADO_DUENO', `${sol.nombre} ${sol.apellido}`, inm.direccion || 'tu inmueble', expedienteId)
          .catch((e) => logger.warn({ error: e }, 'Orchestrator: error WhatsApp dueño condicionado'));
      }
    }

    logger.info({ expedienteId, resultado }, 'Orchestrator: flujo post-estudio completado');
  } catch (error) {
    logger.error({ error, expedienteId, resultado }, 'Orchestrator: error en onEstudioCompletado');
  }
}

// ── Event: Firma Completada ─────────────────────────────────
// (Eliminado, jul-2026.) Aquí vivía onFirmaCompletada: código MUERTO (sin
// callers) que además activaba 'vigente' con UPDATE directo saltándose la
// máquina de estados (sin fecha_firma, sin historial). El pipeline post-firma
// canónico vive en firma/post-firma.service.ts (RPC transicionar_contrato +
// maybeAutoActivarVigente en contratos.service.ts, que marca el inmueble
// ocupado y cierra el expediente). No reintroducir un segundo punto de entrada.

// ── Event: Pago Confirmado ──────────────────────────────────

// Sources que reciben el camino sin-OTP: vitrina_publica e invitacion.
// 'manual' queda fuera — el operador maneja esos expedientes con el flujo
// tradicional de autorización habeas-data (OTP+canvas).
const SOURCES_ONBOARDING_AUTOMATICO = new Set(['vitrina_publica', 'invitacion']);

export async function onPagoConfirmado(params: {
  pagoId: string;
  expedienteId: string;
  concepto: string;
}) {
  const { pagoId, expedienteId, concepto } = params;
  logger.info({ pagoId, expedienteId, concepto }, 'Orchestrator: pago confirmado');

  try {
    await registrarTimeline(expedienteId, 'pago', `Pago de ${concepto} confirmado.`);

    // WhatsApp de status al solicitante: "recibimos tu pago" (fire-and-forget;
    // enviarTemplate traga errores y sin teléfono no envía).
    //
    // NO se envía para concepto='estudio': el texto aprobado por Meta de
    // PAGO_CONFIRMADO promete "en breve te llegará el enlace para autorizar tu
    // estudio", y con el orden del §6.3 esa autorización ya se firmó antes del
    // pago — sería mandarle a esperar un paso que ya cumplió. Se reactiva
    // cuando exista `cofianza_pago_confirmado_v2` aprobada (mismo versionado
    // que CITA_CONFIRMADA v3). El prospecto igual recibe la notificación in-app
    // 'pago.confirmado' de la máquina de estados.
    if (concepto !== 'estudio') (async () => {
      const { data: pagoRow } = await db('pagos')
        .select('monto')
        .eq('id', pagoId)
        .maybeSingle();
      const monto = Number((pagoRow as { monto?: number | string | null } | null)?.monto ?? 0);
      const { sol } = await getSolicitanteDelExpediente(expedienteId);
      await enviarTemplate({
        to: sol?.telefono ?? null,
        template: 'PAGO_CONFIRMADO',
        variables: [sol?.nombre || 'Hola', `$${new Intl.NumberFormat('es-CO').format(monto)}`],
        context: { expediente_id: expedienteId },
      });
    })().catch((err) => logger.warn({ err, expedienteId }, 'Orchestrator: WhatsApp de pago confirmado falló'));

    // Disparar facturación electrónica fire-and-forget. Si falla, queda
    // un registro en 'facturas' con error_mensaje para retry manual desde
    // el panel admin/inmobiliaria.
    import('@/modules/facturacion/facturacion.service')
      .then(({ crearFacturaDesdePago }) =>
        crearFacturaDesdePago(pagoId, null).catch((err) =>
          logger.warn(
            { error: err instanceof Error ? err.message : String(err), pagoId, expedienteId },
            'Orchestrator: facturación automática falló — pendiente retry manual',
          ),
        ),
      )
      .catch((err) => logger.warn({ error: err }, 'Orchestrator: no se pudo cargar facturacion.service'));

    if (concepto !== 'estudio') return;

    // Cargar source + solicitante para decidir bifurcación.
    const { data: expRow } = await db('expedientes')
      .select('id, source, solicitante_id, creado_por')
      .eq('id', expedienteId)
      .single() as { data: { id: string; source: string | null; solicitante_id: string | null; creado_por: string | null } | null };

    if (!expRow) {
      logger.error({ expedienteId }, 'Orchestrator: expediente no encontrado en onPagoConfirmado');
      return;
    }

    // (b) §6.3 — el pago acaba de entrar. Todo lo que sigue (¿ya firmó? ¿hay
    // estudio en espera? ¿hay que mandarle el habeas data?) lo decide
    // onEstudioPagado, que es el dueño único de ese evento para las TRES
    // opciones de pago. Hasta 2026-09-04 aquí vivía el auto-envío del link de
    // autorización, que era el eslabón "pago → autorización" del orden viejo.
    //
    // El early-return evita además el ruido de la rama de onboarding de abajo
    // (que busca un estudio en 'solicitado'): si el estudio ya arrancó, no hay
    // nada que completar.
    if (await onEstudioPagado(expedienteId, expRow.creado_por)) return;

    // Flujo manual: admin opera con OTP+canvas. Sin intervención automática.
    if (!expRow.source || !SOURCES_ONBOARDING_AUTOMATICO.has(expRow.source)) {
      logger.info(
        { expedienteId, source: expRow.source },
        'Orchestrator: pago confirmado en flujo manual — sin dispatch automático',
      );
      return;
    }

    // Validar que tengamos solicitante vinculado (invitación externa pudo
    // no haber sido canjeada todavía — raro aquí pero defensivo).
    if (!expRow.solicitante_id) {
      logger.warn(
        { expedienteId, source: expRow.source },
        'Orchestrator: expediente sin solicitante vinculado — no se puede avanzar estudio',
      );
      return;
    }

    // Buscar estudio placeholder (creado por fn_habilitar_estudio_expediente
    // en Prompt 4). Si otro proceso ya lo avanzó, salimos silenciosos.
    // Se filtra por los burós EJECUTABLES, no por TransUnion fijo: desde que
    // el gestor puede habilitar el estudio con DataCrédito, filtrar por un
    // solo buró dejaba el estudio en 'solicitado' para siempre tras el pago.
    // 'manual'/'sifin' siguen fuera: no los resuelve un provider.
    const { data: estudioRow } = await db('estudios')
      .select('id, estado')
      .eq('expediente_id', expedienteId)
      .eq('estado', 'solicitado')
      .in('proveedor', ['transunion', 'datacredito'])
      .maybeSingle() as { data: { id: string; estado: string } | null };

    if (!estudioRow) {
      logger.warn(
        { expedienteId },
        'Orchestrator: pago confirmado pero no hay estudio en estado=solicitado para avanzar',
      );
      return;
    }

    // Import dinámico (evita ciclo orchestrator ↔ estudios, mismo patrón
    // que onHabeasDataAutorizado ya usa en este archivo).
    const estudiosModule = await import('@/modules/estudios/estudios.service');

    try {
      const result = await estudiosModule.completarFormularioDesdeOnboarding({
        estudioId: estudioRow.id,
        expedienteId: expRow.id,
        solicitanteId: expRow.solicitante_id,
        userId: expRow.creado_por ?? expRow.solicitante_id,
      });

      if (result.yaCompletado) {
        logger.info(
          { estudioId: estudioRow.id },
          'Orchestrator: estudio ya estaba completado antes del pago — skip ejecución',
        );
        return;
      }

      // NO auto-ejecutar. Dejamos el estudio en 'formulario_completado' para que
      // el solicitante confirme su cédula explícitamente desde el panel y recién
      // entonces dispare la consulta a TransUnion vía POST /estudios/:id/ejecutar.
      //
      // Con el §6.3 este camino solo se alcanza cuando el pago llegó SIN firma
      // previa (opciones C emitidas antes de la inversión, y A/B): onEstudioPagado
      // acaba de mandar el habeas data, así que cuando el prospecto firme será
      // onHabeasDataAutorizado —con el pago ya confirmado— quien ejecute.
      logger.info(
        { pagoId, estudioId: estudioRow.id, expedienteId: expRow.id },
        'Orchestrator: pago confirmado, formulario poblado — esperando confirmación del solicitante para ejecutar TransUnion',
      );
    } catch (err) {
      logger.error(
        { expedienteId: expRow.id, estudioId: estudioRow.id, err },
        'Orchestrator: error avanzando estudio tras pago — requiere intervención manual',
      );
    }
  } catch (error) {
    logger.error({ error, pagoId }, 'Orchestrator: error en onPagoConfirmado');
  }
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Transiciona el expediente si el salto es válido.
 *
 * Devuelve `true` SOLO si escribió el nuevo estado. Los callers dependen de
 * eso para no disparar efectos (correos, notificaciones, liberación del
 * inmueble) cuando la transición fue un no-op: sin ese chequeo, un resultado
 * que llega tarde sobre un expediente que ya avanzó mandaba correos de
 * "aprobado" y pedía generar un contrato imposible.
 */
async function transicionarExpediente(expedienteId: string, estadoDestino: string): Promise<boolean> {
  const { data: exp } = await db('expedientes')
    .select('estado')
    .eq('id', expedienteId)
    .single() as { data: { estado: string } | null };

  if (!exp || exp.estado === estadoDestino) return false;

  const transiciones: Record<string, string[]> = {
    borrador: ['en_revision'],
    en_revision: ['aprobado', 'rechazado', 'condicionado', 'informacion_incompleta'],
    informacion_incompleta: ['en_revision'],
    condicionado: ['aprobado', 'rechazado'],
    aprobado: ['cerrado'],
    // Un rechazo del buró es una señal, no una sentencia: la re-evaluación
    // (RESULTADOS_REEVALUABLES incluye 'rechazado') existe para reconsiderarlo
    // con soportes nuevos. Sin este salto, el resultado del estudio hijo no
    // podía mover el expediente y la mitad 'rechazado' de esa funcionalidad
    // era un callejón sin salida. Reabre a 'en_revision' — de ahí el mismo
    // flujo decide aprobado/condicionado/rechazado. NO se abre 'aprobado' a
    // reapertura: ahí puede haber un contrato en camino.
    rechazado: ['cerrado', 'en_revision'],
  };

  if (!(transiciones[exp.estado] || []).includes(estadoDestino)) {
    logger.warn({ expedienteId, from: exp.estado, to: estadoDestino }, 'Orchestrator: transicion no permitida');
    return false;
  }

  await db('expedientes')
    .update({ estado: estadoDestino, updated_at: new Date().toISOString() } as never)
    .eq('id', expedienteId);

  await db('eventos_timeline').insert({
    expediente_id: expedienteId,
    tipo: 'estado',
    descripcion: `Estado cambiado automaticamente: "${exp.estado}" → "${estadoDestino}"`,
    estado_anterior: exp.estado,
    estado_nuevo: estadoDestino,
    metadata: { automatico: true, origen: 'orchestrator' },
  } as never);

  logger.info({ expedienteId, from: exp.estado, to: estadoDestino }, 'Orchestrator: expediente transicionado');
  return true;
}

async function registrarTimeline(expedienteId: string, tipo: string, descripcion: string) {
  await db('eventos_timeline').insert({
    expediente_id: expedienteId,
    tipo,
    descripcion,
    metadata: { automatico: true, origen: 'orchestrator' },
  } as never);
}

// ============================================================
// Orchestrator — Motor de automatizacion de flujos
// Conecta eventos del sistema con acciones automaticas
// ============================================================

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { sendEstudioAprobadoEmail, sendEstudioRechazadoEmail, sendDocumentosRequeridosEmail, sendContratoListoEmail } from './orchestrator.emails';

// ── Type-safe Supabase helper (same pattern as rest of project) ──
const db = (table: string) => (supabase.from(table as string) as ReturnType<typeof supabase.from>);

const DURACION_CONTRATO_DEFAULT = 12;

// ── Event: Habeas Data Autorizado ───────────────────────────

export async function onHabeasDataAutorizado(params: {
  expedienteId: string;
  solicitanteId: string;
  autorizacionId: string;
}) {
  const { expedienteId, solicitanteId, autorizacionId } = params;

  logger.info({ expedienteId, solicitanteId }, 'Orchestrator: habeas data autorizado, iniciando estudio automatico');

  try {
    // 1. Buscar estudio pendiente del expediente
    const { data: estudio } = await db('estudios')
      .select('id, estado, proveedor, expediente_id')
      .eq('expediente_id', expedienteId)
      .in('estado', ['solicitado', 'formulario_completado', 'documentos_cargados'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single() as { data: Record<string, unknown> | null };

    if (!estudio) {
      logger.warn({ expedienteId }, 'Orchestrator: no se encontro estudio pendiente');
      return;
    }

    // 2. Obtener datos del solicitante
    const { data: solicitante } = await db('solicitantes')
      .select('nombre, apellido, tipo_documento, numero_documento, email, telefono')
      .eq('id', solicitanteId)
      .single() as { data: Record<string, unknown> | null };

    if (!solicitante) {
      logger.warn({ solicitanteId }, 'Orchestrator: solicitante no encontrado');
      return;
    }

    // 3. Actualizar estudio con datos del formulario
    await db('estudios')
      .update({
        datos_formulario: {
          nombre_completo: `${solicitante.nombre} ${solicitante.apellido}`,
          tipo_documento: solicitante.tipo_documento,
          numero_documento: solicitante.numero_documento,
          email: solicitante.email,
          telefono: solicitante.telefono || '',
          acepta_terminos: true,
        },
        estado: 'formulario_completado',
        autorizacion_habeas_data_id: autorizacionId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq('id', estudio.id);

    // 4. Ejecutar estudio via provider
    const { ejecutarEstudio, consultarEstadoProveedor } = await import('@/modules/estudios/estudios.service');

    try {
      await ejecutarEstudio(estudio.id as string, solicitanteId);

      // 5. Para providers sincronos (TransUnion), consultar resultado inmediato
      const estadoResult = await consultarEstadoProveedor(estudio.id as string);
      const est = estadoResult.estudio;

      if (est?.estado === 'completado' && est?.resultado) {
        // El hook post-estudio en estudios.service.ts ya dispara onEstudioCompletado
        logger.info({ estudioId: estudio.id, resultado: est.resultado }, 'Orchestrator: estudio completado sincronamente');
      }
    } catch (providerError) {
      // Si TransUnion no esta configurado o falla, el estudio queda como 'fallido'
      // pero el flujo no se bloquea
      logger.warn({ error: providerError, estudioId: estudio.id }, 'Orchestrator: provider no disponible, estudio requiere atencion manual');
    }

    logger.info({ estudioId: estudio.id, expedienteId }, 'Orchestrator: flujo automatico de estudio ejecutado');
  } catch (error) {
    logger.error({ error, expedienteId }, 'Orchestrator: error en onHabeasDataAutorizado');
  }
}

// ── Event: Estudio Completado ───────────────────────────────

export async function onEstudioCompletado(params: {
  estudioId: string;
  expedienteId: string;
  resultado: string;
  score: number | null;
  solicitanteId: string;
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
      .select('nombre, apellido, email')
      .eq('id', expediente.solicitante_id)
      .single() as { data: { nombre: string; apellido: string; email: string } | null };

    const { data: inm } = await db('inmuebles')
      .select('id, direccion, ciudad, valor_arriendo, propietario_id')
      .eq('id', expediente.inmueble_id)
      .single() as { data: { id: string; direccion: string; ciudad: string; valor_arriendo: number; propietario_id: string } | null };

    if (resultado === 'aprobado') {
      // ── APROBADO ──
      await transicionarExpediente(expedienteId, 'en_revision');
      await transicionarExpediente(expedienteId, 'aprobado');

      const contratoId = await generarContratoAutomatico(expedienteId, inm?.valor_arriendo);

      await registrarTimeline(expedienteId, 'estudio', `Estudio crediticio aprobado (Score: ${score}). Contrato generado automaticamente.`);

      if (sol?.email) {
        sendEstudioAprobadoEmail({
          email: sol.email,
          nombre: `${sol.nombre} ${sol.apellido}`,
          inmueble: inm?.direccion || '',
          ciudad: inm?.ciudad || '',
          score,
        }).catch((e) => logger.warn({ error: e }, 'Orchestrator: error email aprobado'));
      }

      if (contratoId) {
        await avanzarContratoAFirma(contratoId, sol, inm);
      }

    } else if (resultado === 'rechazado') {
      // ── RECHAZADO ──
      await transicionarExpediente(expedienteId, 'en_revision');
      await transicionarExpediente(expedienteId, 'rechazado');
      await registrarTimeline(expedienteId, 'estudio', `Estudio crediticio rechazado (Score: ${score}).`);

      // Liberar inmueble
      if (inm) {
        await db('inmuebles')
          .update({ estado: 'disponible', updated_at: new Date().toISOString() } as never)
          .eq('id', inm.id);
      }

      if (sol?.email) {
        sendEstudioRechazadoEmail({ email: sol.email, nombre: `${sol.nombre} ${sol.apellido}`, score })
          .catch((e) => logger.warn({ error: e }, 'Orchestrator: error email rechazado'));
      }

    } else if (resultado === 'condicionado') {
      // ── CONDICIONADO ──
      await transicionarExpediente(expedienteId, 'en_revision');
      await transicionarExpediente(expedienteId, 'condicionado');
      await registrarTimeline(expedienteId, 'estudio', `Estudio condicionado (Score: ${score}). Se requieren documentos adicionales.`);

      if (sol?.email) {
        sendDocumentosRequeridosEmail({ email: sol.email, nombre: `${sol.nombre} ${sol.apellido}`, score })
          .catch((e) => logger.warn({ error: e }, 'Orchestrator: error email condicionado'));
      }
    }

    logger.info({ expedienteId, resultado }, 'Orchestrator: flujo post-estudio completado');
  } catch (error) {
    logger.error({ error, expedienteId, resultado }, 'Orchestrator: error en onEstudioCompletado');
  }
}

// ── Event: Firma Completada ─────────────────────────────────

export async function onFirmaCompletada(params: {
  contratoId: string;
  expedienteId: string;
}) {
  const { contratoId, expedienteId } = params;
  logger.info({ contratoId, expedienteId }, 'Orchestrator: firma completada');

  try {
    const { data: solicitudes } = await db('solicitudes_firma')
      .select('id, estado')
      .eq('contrato_id', contratoId) as { data: Array<{ id: string; estado: string }> | null };

    const todasFirmadas = solicitudes?.every((s) => s.estado === 'firmado');

    if (todasFirmadas) {
      await db('contratos')
        .update({ estado: 'vigente', updated_at: new Date().toISOString() } as never)
        .eq('id', contratoId);

      await transicionarExpediente(expedienteId, 'cerrado');
      await registrarTimeline(expedienteId, 'contrato', 'Contrato firmado por todas las partes. Expediente cerrado automaticamente.');
    }
  } catch (error) {
    logger.error({ error, contratoId }, 'Orchestrator: error en onFirmaCompletada');
  }
}

// ── Event: Pago Confirmado ──────────────────────────────────

export async function onPagoConfirmado(params: {
  pagoId: string;
  expedienteId: string;
  concepto: string;
}) {
  const { pagoId, expedienteId, concepto } = params;
  logger.info({ pagoId, expedienteId, concepto }, 'Orchestrator: pago confirmado');

  try {
    await registrarTimeline(expedienteId, 'pago', `Pago de ${concepto} confirmado.`);

    if (concepto === 'estudio') {
      const { data: estudio } = await db('estudios')
        .select('id, estado')
        .eq('expediente_id', expedienteId)
        .eq('estado', 'pago_pendiente')
        .single() as { data: { id: string } | null };

      if (estudio) {
        await db('estudios')
          .update({ estado: 'pagado', updated_at: new Date().toISOString() } as never)
          .eq('id', estudio.id);
      }
    }
  } catch (error) {
    logger.error({ error, pagoId }, 'Orchestrator: error en onPagoConfirmado');
  }
}

// ── Helpers ─────────────────────────────────────────────────

async function transicionarExpediente(expedienteId: string, estadoDestino: string) {
  const { data: exp } = await db('expedientes')
    .select('estado')
    .eq('id', expedienteId)
    .single() as { data: { estado: string } | null };

  if (!exp || exp.estado === estadoDestino) return;

  const transiciones: Record<string, string[]> = {
    borrador: ['en_revision'],
    en_revision: ['aprobado', 'rechazado', 'condicionado', 'informacion_incompleta'],
    informacion_incompleta: ['en_revision'],
    condicionado: ['aprobado', 'rechazado'],
    aprobado: ['cerrado'],
    rechazado: ['cerrado'],
  };

  if (!(transiciones[exp.estado] || []).includes(estadoDestino)) {
    logger.warn({ expedienteId, from: exp.estado, to: estadoDestino }, 'Orchestrator: transicion no permitida');
    return;
  }

  await db('expedientes')
    .update({ estado: estadoDestino, updated_at: new Date().toISOString() } as never)
    .eq('id', expedienteId);

  await db('eventos_timeline').insert({
    expediente_id: expedienteId,
    tipo: 'transicion',
    descripcion: `Estado cambiado automaticamente: "${exp.estado}" → "${estadoDestino}"`,
    estado_anterior: exp.estado,
    estado_nuevo: estadoDestino,
    metadata: { automatico: true, origen: 'orchestrator' },
  } as never);

  logger.info({ expedienteId, from: exp.estado, to: estadoDestino }, 'Orchestrator: expediente transicionado');
}

async function generarContratoAutomatico(expedienteId: string, valorArriendo?: number): Promise<string | null> {
  try {
    const { data: plantilla } = await db('plantillas_contrato')
      .select('id, version')
      .eq('activa', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single() as { data: { id: string; version: number } | null };

    if (!plantilla) {
      logger.warn('Orchestrator: no hay plantilla activa');
      return null;
    }

    const { data: contrato, error } = await db('contratos')
      .insert({
        expediente_id: expedienteId,
        plantilla_id: plantilla.id,
        plantilla_version: plantilla.version,
        estado: 'borrador',
        duracion_meses: DURACION_CONTRATO_DEFAULT,
        valor_arriendo: valorArriendo || 0,
        fecha_inicio: new Date().toISOString().slice(0, 10),
        datos_variables: {},
      } as never)
      .select('id')
      .single() as { data: { id: string } | null; error: unknown };

    if (error || !contrato) {
      logger.error({ error }, 'Orchestrator: error creando contrato');
      return null;
    }

    logger.info({ contratoId: contrato.id, expedienteId }, 'Orchestrator: contrato generado');
    return contrato.id;
  } catch (error) {
    logger.error({ error }, 'Orchestrator: error en generarContratoAutomatico');
    return null;
  }
}

async function avanzarContratoAFirma(
  contratoId: string,
  solicitante: { nombre: string; apellido: string; email: string } | null,
  inmueble: { direccion: string; ciudad: string } | null,
) {
  try {
    await db('contratos')
      .update({ estado: 'pendiente_firma', updated_at: new Date().toISOString() } as never)
      .eq('id', contratoId);

    if (solicitante?.email) {
      sendContratoListoEmail({
        email: solicitante.email,
        nombre: `${solicitante.nombre} ${solicitante.apellido}`,
        inmueble: inmueble?.direccion || '',
        ciudad: inmueble?.ciudad || '',
      }).catch((e) => logger.warn({ error: e }, 'Orchestrator: error email contrato listo'));
    }

    logger.info({ contratoId }, 'Orchestrator: contrato avanzado a pendiente_firma');
  } catch (error) {
    logger.error({ error, contratoId }, 'Orchestrator: error en avanzarContratoAFirma');
  }
}

async function registrarTimeline(expedienteId: string, tipo: string, descripcion: string) {
  await db('eventos_timeline').insert({
    expediente_id: expedienteId,
    tipo,
    descripcion,
    metadata: { automatico: true, origen: 'orchestrator' },
  } as never);
}

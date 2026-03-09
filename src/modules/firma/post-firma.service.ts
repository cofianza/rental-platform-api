/**
 * Post-firma orchestration service — HP-345
 *
 * Executes automatically after completarFirma succeeds:
 * 1. Transition contrato to "firmado" (if all solicitudes are signed)
 * 2. Insert timeline event on expediente
 * 3. Send acuse email to firmante (async, non-blocking)
 * 4. Send notification email to operador (async, non-blocking)
 */

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { sendFirmaAcuseEmail, sendFirmaOperadorNotification } from './post-firma.emails';

// ============================================================
// Types
// ============================================================

interface PostFirmaContext {
  solicitudId: string;
  contratoId: string;
  nombreFirmante: string;
  emailFirmante: string;
  firmadoEn: string;
}

interface ContratoForPostFirma {
  id: string;
  estado: string;
  expediente_id: string;
  nombre_archivo: string | null;
  expedientes: {
    numero_expediente: string;
    analista_id: string | null;
    inmuebles: { direccion: string; ciudad: string } | null;
    analista: { id: string; nombre: string; apellido: string; email: string } | null;
  } | null;
}

interface SolicitudEstado {
  id: string;
  estado: string;
}

// ============================================================
// Main orchestrator (fire-and-forget from completarFirma)
// ============================================================

export async function executePostFirma(ctx: PostFirmaContext): Promise<void> {
  const { solicitudId, contratoId, nombreFirmante, emailFirmante, firmadoEn } = ctx;

  // 1. Fetch contrato with expediente and analista
  const { data: contratoData, error: contratoError } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, estado, expediente_id, nombre_archivo,
      expedientes(
        numero_expediente, analista_id,
        inmuebles(direccion, ciudad),
        analista:perfiles!expedientes_analista_id_fkey(id, nombre, apellido, email)
      )
    `)
    .eq('id', contratoId)
    .single();

  if (contratoError || !contratoData) {
    logger.error({ error: contratoError?.message, contratoId }, 'Post-firma: contrato not found');
    return;
  }

  const contrato = contratoData as unknown as ContratoForPostFirma;

  // 2. Check if ALL solicitudes for this contrato are firmado
  const { data: solicitudes } = await (supabase
    .from('solicitudes_firma' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('contrato_id', contratoId);

  const allSolicitudes = (solicitudes as unknown as SolicitudEstado[]) || [];
  const allSigned = allSolicitudes.length > 0 && allSolicitudes.every((s) => s.estado === 'firmado');

  // 3. Transition contrato to "firmado" if all solicitudes signed AND contrato is in pendiente_firma
  if (allSigned && contrato.estado === 'pendiente_firma') {
    await transitionContratoToFirmado(contrato, nombreFirmante);
  }

  // 4. Insert timeline event on expediente
  if (contrato.expedientes) {
    await insertTimelineEvent(contrato, solicitudId, nombreFirmante, firmadoEn);
  }

  // 5. Send emails (async, non-blocking — failures logged but don't throw)
  const inmueble = contrato.expedientes?.inmuebles;
  const expedienteNum = contrato.expedientes?.numero_expediente || '';

  // Email to firmante
  sendFirmaAcuseEmail({
    to: emailFirmante,
    nombreFirmante,
    firmadoEn,
    contratoNombre: contrato.nombre_archivo || 'Contrato de arrendamiento',
    inmuebleDireccion: inmueble?.direccion || '',
    inmuebleCiudad: inmueble?.ciudad || '',
  }).catch((err) => {
    logger.error({ error: err, email: emailFirmante }, 'Post-firma: error sending acuse email to firmante');
  });

  // Email to operador
  const analista = contrato.expedientes?.analista;
  if (analista?.email) {
    const expedienteUrl = `${env.FRONTEND_URL}/expedientes/${contrato.expediente_id}`;
    sendFirmaOperadorNotification({
      to: analista.email,
      nombreOperador: analista.nombre,
      nombreFirmante,
      firmadoEn,
      contratoNombre: contrato.nombre_archivo || 'Contrato de arrendamiento',
      expedienteNumero: expedienteNum,
      expedienteUrl,
      allSigned,
    }).catch((err) => {
      logger.error({ error: err, email: analista.email }, 'Post-firma: error sending notification to operador');
    });
  }

  logger.info(
    { contratoId, solicitudId, allSigned },
    'Post-firma: orchestration completed',
  );
}

// ============================================================
// Transition contrato to firmado (atomic via RPC)
// ============================================================

async function transitionContratoToFirmado(
  contrato: ContratoForPostFirma,
  nombreFirmante: string,
): Promise<void> {
  const descripcion = `Contrato firmado electronicamente por todos los firmantes. Ultima firma: ${nombreFirmante}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc('transicionar_contrato', {
    p_contrato_id: contrato.id,
    p_nuevo_estado: 'firmado',
    p_descripcion: descripcion,
    p_usuario_id: null, // system action
    p_comentario: 'Transicion automatica post-firma electronica',
    p_motivo: null,
  });

  if (error) {
    logger.error({ error, contratoId: contrato.id }, 'Post-firma: error transitioning contrato to firmado');
    return;
  }

  // Apply side effect: set fecha_firma
  await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .update({ fecha_firma: new Date().toISOString() } as never)
    .eq('id', contrato.id);

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.CONTRATO_TRANSITIONED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contrato.id,
    detalle: {
      estado_anterior: 'pendiente_firma',
      estado_nuevo: 'firmado',
      automatico: true,
      motivo: 'Todas las firmas completadas',
    },
  });

  logger.info({ contratoId: contrato.id }, 'Post-firma: contrato transitioned to firmado');
}

// ============================================================
// Insert timeline event
// ============================================================

async function insertTimelineEvent(
  contrato: ContratoForPostFirma,
  solicitudId: string,
  nombreFirmante: string,
  firmadoEn: string,
): Promise<void> {
  const expedienteId = contrato.expediente_id;
  const contratoNombre = contrato.nombre_archivo || 'contrato de arrendamiento';
  const descripcion = `${nombreFirmante} firmo el ${contratoNombre}`;

  const { error } = await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'firma',
      descripcion,
      usuario_id: null, // system action
      metadata: {
        solicitud_firma_id: solicitudId,
        contrato_id: contrato.id,
        nombre_firmante: nombreFirmante,
        firmado_en: firmadoEn,
      },
    } as never);

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Post-firma: error inserting timeline event');
  }
}

// Punto de entrada del módulo WhatsApp. El resto del backend solo
// debería importar desde aquí — la elección de provider, la lista
// de templates y la firma del envío están encapsuladas.

import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { enviarMensaje } from './whatsapp.service';
import { WHATSAPP_TEMPLATES, type WhatsappTemplateKey } from './templates';
import type { WhatsAppSendResult } from './providers/types';

export { enviarMensaje } from './whatsapp.service';
export { WHATSAPP_TEMPLATES } from './templates';
export type { WhatsappTemplateKey } from './templates';

type WhatsappContext = {
  expediente_id?: string;
  contrato_id?: string;
  mora_id?: string;
  estudio_id?: string;
};

/** Enmascara el teléfono dejando solo los últimos 4 dígitos visibles. */
function maskTelefono(to: string): string {
  return to.length <= 4 ? to : '*'.repeat(to.length - 4) + to.slice(-4);
}

/**
 * Deja rastro del resultado del envío (enviado/fallido/mock + error de Meta)
 * en la bitácora — atado al expediente/contrato/mora/estudio del context —
 * para diagnosticar sin leer logs crudos. Fire-and-forget.
 */
function registrarResultado(
  template: WhatsappTemplateKey,
  templateId: string,
  to: string,
  result: WhatsAppSendResult,
  context?: WhatsappContext,
): void {
  const accion =
    result.estado === 'aceptado'
      ? AUDIT_ACTIONS.WHATSAPP_ENVIADO
      : result.estado === 'mock'
        ? AUDIT_ACTIONS.WHATSAPP_MOCK
        : AUDIT_ACTIONS.WHATSAPP_FALLIDO;

  const logPayload = {
    template,
    templateId,
    to: maskTelefono(to),
    estado: result.estado,
    error: result.error,
    messageId: result.message_id,
  };
  if (result.estado === 'fallido') {
    logger.warn(logPayload, '[WhatsApp] envío fallido');
  } else if (result.estado === 'mock') {
    logger.info(logPayload, '[WhatsApp] MOCK — no se envió (WHATSAPP_PROVIDER != meta)');
  } else {
    logger.info(logPayload, '[WhatsApp] enviado');
  }

  // Atar el registro a la entidad del context (preferimos expediente).
  const entidadId =
    context?.expediente_id ?? context?.contrato_id ?? context?.mora_id ?? context?.estudio_id;
  if (!entidadId) return;

  logAudit({
    usuarioId: null,
    accion,
    entidad: AUDIT_ENTITIES.WHATSAPP,
    entidadId,
    detalle: {
      template,
      template_id: templateId,
      to: maskTelefono(to),
      estado: result.estado,
      error: result.error ?? null,
      message_id: result.message_id,
    },
  });
}

/**
 * Helper tipado para disparar un template. Devuelve siempre — los
 * errores se loguean pero NO se propagan, así un fallo del provider
 * jamás bloquea el flujo de negocio (confirmar cita, aprobar estudio,
 * etc.) que lo invoca. El emisor es siempre "fire-and-forget".
 */
export async function enviarTemplate(args: {
  to: string | null | undefined;
  template: WhatsappTemplateKey;
  variables?: string[];
  /** Sufijos de botones URL dinámicos (orden de índice). P.ej. token de la cita. */
  urlButtons?: string[];
  context?: {
    expediente_id?: string;
    contrato_id?: string;
    mora_id?: string;
    estudio_id?: string;
  };
}): Promise<void> {
  const { to, template, variables, urlButtons, context } = args;

  if (!to) {
    logger.debug({ template }, 'WhatsApp omitido: sin telefono destinatario');
    return;
  }

  const tpl = WHATSAPP_TEMPLATES[template];

  try {
    const result = await enviarMensaje({
      to,
      template_id: tpl.id,
      language: tpl.language,
      variables,
      url_buttons: urlButtons,
      context,
    });
    // Deja rastro del resultado (enviado/fallido/mock + error) en log + bitácora.
    registrarResultado(template, tpl.id, to, result, context);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(
      { error, template, to: maskTelefono(to) },
      'WhatsApp falló — el flujo de negocio sigue, pero la notificación no llegó',
    );
    // Registrar también el fallo inesperado (excepción) en la bitácora.
    registrarResultado(template, tpl.id, to, { message_id: null, estado: 'fallido', error }, context);
  }
}

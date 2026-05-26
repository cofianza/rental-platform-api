// Punto de entrada del módulo WhatsApp. El resto del backend solo
// debería importar desde aquí — la elección de provider, la lista
// de templates y la firma del envío están encapsuladas.

import { logger } from '@/lib/logger';
import { enviarMensaje } from './whatsapp.service';
import { WHATSAPP_TEMPLATES, type WhatsappTemplateKey } from './templates';

export { enviarMensaje } from './whatsapp.service';
export { WHATSAPP_TEMPLATES } from './templates';
export type { WhatsappTemplateKey } from './templates';

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
  context?: {
    expediente_id?: string;
    contrato_id?: string;
    mora_id?: string;
    estudio_id?: string;
  };
}): Promise<void> {
  const { to, template, variables, context } = args;

  if (!to) {
    logger.debug({ template }, 'WhatsApp omitido: sin telefono destinatario');
    return;
  }

  const tpl = WHATSAPP_TEMPLATES[template];

  try {
    await enviarMensaje({
      to,
      template_id: tpl.id,
      language: tpl.language,
      variables,
      context,
    });
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : err, template, to },
      'WhatsApp falló — el flujo de negocio sigue, pero la notificación no llegó',
    );
  }
}

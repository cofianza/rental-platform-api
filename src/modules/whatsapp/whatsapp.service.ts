// ============================================================
// WhatsApp Service — fachada que selecciona el provider activo
// según `WHATSAPP_PROVIDER` (env), normaliza el teléfono y delega
// el envío. Mantiene el contrato estable mientras la integración
// con Meta Business Cloud queda pendiente (Mario 12-may-2026).
// ============================================================

import { logger } from '@/lib/logger';
import { MockWhatsAppProvider } from './providers/mock.provider';
import { MetaWhatsAppProvider } from './providers/meta.provider';
import type {
  WhatsAppMessage,
  WhatsAppProvider,
  WhatsAppSendResult,
} from './providers/types';
import type { EnviarWhatsappInput } from './whatsapp.schema';

// Selección del provider — controlable por env. Mientras no esté
// configurado WHATSAPP_PROVIDER=meta, se usa el mock que loguea.
function buildProvider(): WhatsAppProvider {
  const providerEnv = process.env.WHATSAPP_PROVIDER?.toLowerCase();
  if (providerEnv === 'meta') {
    logger.info('WhatsApp provider activo: Meta Business Cloud');
    return new MetaWhatsAppProvider();
  }
  return new MockWhatsAppProvider();
}

const provider = buildProvider();

/** Normaliza un teléfono a E.164. Si viene con 10 dígitos locales asume CO (+57). */
function normalizarTelefono(raw: string): string {
  const limpio = raw.replace(/[\s-]/g, '');
  if (limpio.startsWith('+')) return limpio;
  if (limpio.length === 10) return `+57${limpio}`;
  return `+${limpio}`;
}

export async function enviarMensaje(input: EnviarWhatsappInput): Promise<WhatsAppSendResult> {
  const msg: WhatsAppMessage = {
    to: normalizarTelefono(input.to),
    templateId: input.template_id,
    language: input.language ?? 'es_CO',
    variables: input.variables,
    isAuthentication: input.is_authentication,
    urlButtons: input.url_buttons,
    context: input.context,
  };

  logger.debug({ provider: provider.nombre, to: msg.to, template: msg.templateId }, 'Enviando WhatsApp');

  return provider.send(msg);
}

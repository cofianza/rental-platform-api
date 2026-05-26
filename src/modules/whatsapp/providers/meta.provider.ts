// ============================================================
// Meta Business Cloud Provider — placeholder pendiente de integración.
//
// Documentación: https://developers.facebook.com/docs/whatsapp/cloud-api
//
// Variables de entorno requeridas (agregar a `src/config/env.ts` cuando
// se active la integración):
//   - WHATSAPP_META_PHONE_NUMBER_ID  → ID del número remitente
//   - WHATSAPP_META_ACCESS_TOKEN     → Token permanent / system user
//   - WHATSAPP_META_API_VERSION      → ej: 'v21.0'
//
// Cuando esté listo, exportar instance: `export const metaProvider = new MetaWhatsAppProvider()`
// y enchufar en whatsapp.service.ts vía env flag `WHATSAPP_PROVIDER=meta`.
// ============================================================

import { logger } from '@/lib/logger';
import type { WhatsAppMessage, WhatsAppProvider, WhatsAppSendResult } from './types';

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly nombre = 'meta';

  async send(msg: WhatsAppMessage): Promise<WhatsAppSendResult> {
    // TODO Mario 12-may-2026: implementar llamada a Graph API.
    //
    // const url = `https://graph.facebook.com/${env.WHATSAPP_META_API_VERSION}/${env.WHATSAPP_META_PHONE_NUMBER_ID}/messages`;
    // const body = {
    //   messaging_product: 'whatsapp',
    //   to: msg.to,
    //   type: 'template',
    //   template: {
    //     name: msg.templateId,
    //     language: { code: msg.language ?? 'es' },
    //     components: msg.variables?.length
    //       ? [{ type: 'body', parameters: msg.variables.map((v) => ({ type: 'text', text: v })) }]
    //       : undefined,
    //   },
    // };
    // const res = await fetch(url, {
    //   method: 'POST',
    //   headers: {
    //     Authorization: `Bearer ${env.WHATSAPP_META_ACCESS_TOKEN}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify(body),
    // });
    // const json = await res.json();
    // if (!res.ok) return { message_id: null, estado: 'fallido', error: json?.error?.message };
    // return { message_id: json.messages?.[0]?.id ?? null, estado: 'aceptado' };

    logger.warn(
      { to: msg.to, templateId: msg.templateId },
      '[WhatsApp Meta] provider seleccionado pero la integración aún está pendiente — no se envía nada',
    );

    return {
      message_id: null,
      estado: 'fallido',
      error: 'Meta provider no implementado todavía (placeholder).',
    };
  }
}

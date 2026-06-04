// ============================================================
// Meta Business Cloud Provider — envío de plantillas WhatsApp vía Graph API.
//
// Documentación: https://developers.facebook.com/docs/whatsapp/cloud-api
//
// Se activa con WHATSAPP_PROVIDER=meta y requiere en el .env:
//   - WHATSAPP_META_PHONE_NUMBER_ID  → ID del número remitente
//   - WHATSAPP_META_ACCESS_TOKEN     → token permanente (system user)
//   - WHATSAPP_META_API_VERSION      → ej: 'v21.0'
// (Mario 12-may-2026: WhatsApp directo con Meta, no vía Auco.)
// ============================================================

import { env } from '@/config';
import { logger } from '@/lib/logger';
import type { WhatsAppMessage, WhatsAppProvider, WhatsAppSendResult } from './types';

interface GraphResponse {
  messages?: Array<{ id: string }>;
  error?: { message?: string; code?: number };
}

// Timeout duro del envío: sin esto, un Graph API colgado mantiene abierta la
// request HTTP del usuario (p.ej. POST /enviar-otp) indefinidamente.
const META_TIMEOUT_MS = 12_000;

// Reintentos ante errores transitorios (429 / 5xx / red). Un solo reintento basta
// para absorber picos de Meta sin alargar demasiado la espera del usuario.
const META_MAX_ATTEMPTS = 2;
const META_RETRY_BACKOFF_MS = 800;

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly nombre = 'meta';

  async send(msg: WhatsAppMessage): Promise<WhatsAppSendResult> {
    if (!env.WHATSAPP_META_PHONE_NUMBER_ID || !env.WHATSAPP_META_ACCESS_TOKEN) {
      logger.error('[WhatsApp Meta] Falta WHATSAPP_META_PHONE_NUMBER_ID o WHATSAPP_META_ACCESS_TOKEN en el .env');
      return { message_id: null, estado: 'fallido', error: 'Credenciales de Meta no configuradas' };
    }

    const url = `https://graph.facebook.com/${env.WHATSAPP_META_API_VERSION}/${env.WHATSAPP_META_PHONE_NUMBER_ID}/messages`;

    // Componentes del template. En plantillas de categoría "Authentication" el
    // código (variables[0]) va en el cuerpo Y en el botón "copiar código".
    const code = msg.variables?.[0];

    // Las plantillas Authentication exigen el código en cuerpo + botón. Sin él,
    // Meta rechaza el mensaje y el OTP nunca llega: fallamos rápido y claro.
    if (msg.isAuthentication && !code) {
      logger.error(
        { template: msg.templateId, to: msg.to },
        '[WhatsApp Meta] Plantilla de autenticación sin código — no se envía',
      );
      return { message_id: null, estado: 'fallido', error: 'Falta el codigo para la plantilla de autenticacion' };
    }

    let components: Array<Record<string, unknown>> | undefined;
    if (msg.isAuthentication && code) {
      // El botón de las plantillas Authentication de Cofianza es de tipo "url"
      // (one-tap); el código va en el cuerpo y como parámetro del botón.
      components = [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: code }],
        },
      ];
    } else if (msg.variables?.length) {
      components = [
        { type: 'body', parameters: msg.variables.map((v) => ({ type: 'text', text: v })) },
      ];
    }

    const body = {
      messaging_product: 'whatsapp',
      // Graph API espera el número E.164 sin el '+' inicial.
      to: msg.to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: msg.templateId,
        language: { code: msg.language ?? 'es' },
        ...(components ? { components } : {}),
      },
    };

    let lastError = 'Error de red';
    for (let attempt = 1; attempt <= META_MAX_ATTEMPTS; attempt++) {
      const result = await this.attemptSend(url, body, msg);
      if (result.ok) {
        logger.info(
          { to: msg.to, template: msg.templateId, messageId: result.messageId, attempt },
          '[WhatsApp Meta] Mensaje enviado',
        );
        return { message_id: result.messageId, estado: 'aceptado' };
      }
      lastError = result.error;
      // Solo reintentamos errores transitorios (429 / 5xx / red); no 4xx ni timeout.
      if (result.retryable && attempt < META_MAX_ATTEMPTS) {
        logger.warn(
          { to: msg.to, template: msg.templateId, attempt, error: result.error },
          '[WhatsApp Meta] Error transitorio, reintentando envío',
        );
        await new Promise((r) => setTimeout(r, META_RETRY_BACKOFF_MS * attempt));
        continue;
      }
      break;
    }
    return { message_id: null, estado: 'fallido', error: lastError };
  }

  /** Un intento de envío. Distingue fallos transitorios (reintentables) de definitivos. */
  private async attemptSend(
    url: string,
    body: Record<string, unknown>,
    msg: WhatsAppMessage,
  ): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string; retryable: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Parseo defensivo: un 5xx de gateway puede devolver HTML; res.json()
      // entonces tira y se confundiría con un error de red, perdiendo el status real.
      const rawText = await res.text();
      let json: GraphResponse = {};
      if (rawText) {
        try {
          json = JSON.parse(rawText) as GraphResponse;
        } catch {
          logger.error(
            { status: res.status, body: rawText.slice(0, 200), to: msg.to, template: msg.templateId },
            '[WhatsApp Meta] Respuesta no-JSON de Graph API',
          );
          return { ok: false, error: `HTTP ${res.status} (respuesta no-JSON)`, retryable: res.status >= 500 };
        }
      }

      if (!res.ok) {
        logger.error(
          { status: res.status, error: json?.error, to: msg.to, template: msg.templateId },
          '[WhatsApp Meta] Envío fallido',
        );
        return {
          ok: false,
          error: json?.error?.message ?? `HTTP ${res.status}`,
          retryable: res.status === 429 || res.status >= 500,
        };
      }

      return { ok: true, messageId: json.messages?.[0]?.id ?? null };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      logger.error({ err, to: msg.to, template: msg.templateId, isTimeout }, '[WhatsApp Meta] Error de red al enviar');
      return {
        ok: false,
        error: isTimeout
          ? `Timeout de ${META_TIMEOUT_MS / 1000}s al contactar Graph API`
          : err instanceof Error ? err.message : 'Error de red',
        // Red transitoria sí se reintenta; el timeout no (ya esperamos 12s).
        retryable: !isTimeout,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ============================================================
// Mock WhatsApp Provider — usado mientras no hay credenciales de
// Meta Business Cloud. Loguea la "intención" del envío y devuelve
// estado 'mock' para que el caller siga el flujo sin esperar la
// integración (Mario 12-may-2026).
// ============================================================

import { logger } from '@/lib/logger';
import type { WhatsAppMessage, WhatsAppProvider, WhatsAppSendResult } from './types';

export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly nombre = 'mock';

  async send(msg: WhatsAppMessage): Promise<WhatsAppSendResult> {
    logger.info(
      {
        provider: 'mock',
        to: msg.to,
        templateId: msg.templateId,
        language: msg.language ?? 'es',
        variables: msg.variables ?? [],
        urlButtons: msg.urlButtons ?? [],
        context: msg.context ?? {},
      },
      '[WhatsApp MOCK] enviaría mensaje (provider real pendiente de Meta)',
    );

    return {
      message_id: null,
      estado: 'mock',
    };
  }
}

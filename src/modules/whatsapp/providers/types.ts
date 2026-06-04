// ============================================================
// WhatsApp Provider — Interface común para proveedores de
// mensajería WhatsApp. La impl actual es un mock que sólo loguea;
// Meta Business Cloud entrará después usando esta misma interfaz
// (Mario 12-may-2026: WhatsApp directo con Meta, no via Auco).
// ============================================================

export interface WhatsAppMessage {
  /** Teléfono destinatario en formato E.164 (ej: +573001234567). */
  to: string;
  /** ID del template aprobado por Meta (ej: "estudio_aprobado_v1"). */
  templateId: string;
  /** Idioma del template (ej: "es_CO"). Default: 'es'. */
  language?: string;
  /** Variables del template, en orden de aparición ({{1}}, {{2}}, ...). */
  variables?: string[];
  /**
   * true para plantillas de categoría "Authentication" de Meta: el código
   * (variables[0]) se manda en el cuerpo y en el botón "copiar código".
   */
  isAuthentication?: boolean;
  /** Metadata opcional: a qué expediente / contrato / mora se refiere. */
  context?: {
    expediente_id?: string;
    contrato_id?: string;
    mora_id?: string;
    estudio_id?: string;
  };
}

export interface WhatsAppSendResult {
  /** ID del mensaje en el proveedor (Meta MID, p.ej.). null si es mock. */
  message_id: string | null;
  /** Estado inicial del envío. */
  estado: 'aceptado' | 'fallido' | 'mock';
  /** Mensaje de error si falló. */
  error?: string;
}

export interface WhatsAppProvider {
  /** Identifica el proveedor concreto en logs y métricas. */
  readonly nombre: string;
  send(msg: WhatsAppMessage): Promise<WhatsAppSendResult>;
}

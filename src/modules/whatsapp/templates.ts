// ============================================================
// Templates de WhatsApp — IDs y variables esperadas por cada
// mensaje transaccional. Los nombres aquí deben coincidir con
// los templates que se aprobarán en Meta Business Cloud Console.
//
// Cuando entren las credenciales de Meta:
//   1) Registrar cada `id` como template aprobado en Business Manager.
//   2) Los `vars` van en el orden {{1}}, {{2}}, {{3}}... del body.
//   3) Idioma: 'es_CO'.
// ============================================================

export const WHATSAPP_TEMPLATES = {
  /** Notifica al solicitante que su estudio fue aprobado. */
  ESTUDIO_APROBADO: {
    id: 'cofianza_estudio_aprobado_v1',
    language: 'es_CO',
    // {{1}} nombre, {{2}} numero_expediente
    description: 'Hola {{1}} 🎉 Tu estudio Cofianza ({{2}}) fue aprobado. Ya puedes avanzar con tu contrato.',
  },
  /** Notifica al solicitante que su estudio fue rechazado. */
  ESTUDIO_RECHAZADO: {
    id: 'cofianza_estudio_rechazado_v1',
    language: 'es_CO',
    // {{1}} nombre, {{2}} numero_expediente
    description: 'Hola {{1}}, el resultado de tu estudio ({{2}}) no fue aprobado. Revisa los detalles en tu panel.',
  },
  /** Notifica al solicitante que su estudio fue condicionado (se sugiere coarrendatario). */
  ESTUDIO_CONDICIONADO: {
    id: 'cofianza_estudio_condicionado_v1',
    language: 'es_CO',
    // {{1}} nombre, {{2}} numero_expediente
    description: 'Hola {{1}}, tu estudio ({{2}}) fue condicionado. Puedes continuar agregando un coarrendatario o documentación adicional.',
  },
  /** Cita confirmada por el propietario en la fecha original. */
  CITA_CONFIRMADA: {
    id: 'cofianza_cita_confirmada_v1',
    language: 'es_CO',
    // {{1}} nombre, {{2}} direccion_inmueble, {{3}} ciudad, {{4}} fecha_confirmada
    description: 'Hola {{1}}, tu visita al inmueble en {{2}}, {{3}} fue confirmada para el {{4}}.',
  },
  /** Cita reprogramada (la fecha confirmada difiere de la propuesta). */
  CITA_REPROGRAMADA: {
    id: 'cofianza_cita_reprogramada_v1',
    language: 'es_CO',
    // {{1}} nombre, {{2}} direccion_inmueble, {{3}} fecha_propuesta, {{4}} fecha_confirmada
    description: 'Hola {{1}}, el propietario ajustó tu visita al inmueble {{2}} de {{3}} a {{4}}.',
  },
  /** Cita cancelada — destinada al contrario del actor que canceló. */
  CITA_CANCELADA: {
    id: 'cofianza_cita_cancelada_v1',
    language: 'es_CO',
    // {{1}} nombre, {{2}} direccion_inmueble, {{3}} fecha_cita, {{4}} motivo
    description: 'Hola {{1}}, la visita al inmueble {{2}} programada para {{3}} fue cancelada. Motivo: {{4}}.',
  },
  /** Fase 1 de Mora — recordatorio amistoso al inquilino (+0d desde el reporte). */
  MORA_FASE_1: {
    id: 'cofianza_mora_fase1_v1',
    language: 'es_CO',
    // {{1}} inquilino, {{2}} inmueble, {{3}} monto, {{4}} fecha_vencimiento
    description: 'Hola {{1}} 👋 Detectamos que el canon del inmueble {{2}} por ${{3}} venció el {{4}}. ¿Pudiste hacer el pago? Si ya lo hiciste, no te preocupes — pásanos el comprobante por aquí.',
  },
  /** Fase 2 — Urgencia (+4d). Tono más formal, recordando al coarrendatario. */
  MORA_FASE_2: {
    id: 'cofianza_mora_fase2_v1',
    language: 'es_CO',
    // {{1}} inquilino, {{2}} inmueble, {{3}} monto, {{4}} dias_mora
    description: 'Hola {{1}}, el canon del inmueble {{2}} por ${{3}} lleva {{4}} días en mora. Te invitamos a regularizar antes de que el caso escale a Cofianza como respaldo legal.',
  },
  /** Fase 3 — Legal (+10d). Cofianza toma control. */
  MORA_FASE_3: {
    id: 'cofianza_mora_fase3_v1',
    language: 'es_CO',
    // {{1}} inquilino, {{2}} inmueble, {{3}} monto, {{4}} dias_mora
    description: 'Hola {{1}}, el caso de la mora del inmueble {{2}} por ${{3}} ({{4}} días) fue escalado formalmente a Cofianza. Nuestro equipo se comunicará contigo en las próximas horas.',
  },
  /**
   * Link de autorización de tratamiento de datos (categoría UTILITY en Meta).
   * Se envía al inquilino para que abra la pantalla y firme con OTP al final.
   */
  AUTORIZACION_LINK: {
    id: 'cofianza_autorizacion_link',
    language: 'es_CO',
    // {{1}} nombre, {{2}} enlace de autorización
    description: 'Hola {{1}}, Cofianza necesita tu autorización para estudiar tu solicitud de arriendo. Abre este enlace para revisarla y firmarla: {{2}}',
  },
  /**
   * Código OTP de la autorización (categoría AUTHENTICATION en Meta). La validación
   * del código constituye la firma electrónica de la autorización (Ley 527/1999).
   */
  AUTORIZACION_OTP: {
    id: 'cofianza_otp_autorizacion',
    language: 'es_CO',
    // {{1}} código OTP de 6 dígitos
    description: 'Tu código de autorización Cofianza es {{1}}. Válido por 5 minutos. No lo compartas con nadie.',
  },
} as const;

export type WhatsappTemplateKey = keyof typeof WHATSAPP_TEMPLATES;

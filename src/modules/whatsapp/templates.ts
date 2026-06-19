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
  /**
   * Cita confirmada por el propietario en la fecha original.
   * v2: incluye 2 botones URL dinámicos — "Reprogramar" y "Cancelar" — que
   * abren cofianza.co/visita/<accion>/<token>. El token de la cita se pasa
   * como urlButtons:[token, token] (índices 0 y 1) al enviar.
   */
  CITA_CONFIRMADA: {
    id: 'cofianza_cita_confirmada_v2',
    language: 'es_CO',
    // {{1}} nombre, {{2}} direccion_inmueble, {{3}} ciudad, {{4}} fecha_confirmada
    // Botón 0 (Reprogramar) y botón 1 (Cancelar): sufijo URL = token de la cita.
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
  /** Link de pago del estudio al arrendatario (refuerzo del correo). */
  PAGO_ESTUDIO_LINK: {
    id: 'cofianza_pago_estudio_link',
    language: 'es_CO',
    // {{1}} nombre, {{2}} monto formateado, {{3}} link de pago
    description: 'Hola {{1}}, para avanzar con tu solicitud de arriendo debes pagar el estudio ({{2}} COP). Puedes pagar aquí: {{3}} — también te lo enviamos por correo.',
  },
  /** Confirmación de pago recibido (status para el solicitante). */
  PAGO_CONFIRMADO: {
    id: 'cofianza_pago_confirmado',
    language: 'es_CO',
    // {{1}} nombre, {{2}} monto formateado
    description: 'Hola {{1}}, recibimos tu pago de {{2}} COP. En breve te llegará el enlace para autorizar tu estudio. Gracias por confiar en Cofianza.',
  },
  /** Contrato firmado por todas las partes — cierre feliz del proceso. */
  CONTRATO_FIRMADO: {
    id: 'cofianza_contrato_firmado',
    language: 'es_CO',
    // {{1}} nombre, {{2}} dirección del inmueble
    description: 'Hola {{1}}, tu contrato de arrendamiento del inmueble {{2}} fue firmado por todas las partes. Te llegará copia por correo. Bienvenido a tu nuevo hogar.',
  },
  /** Nueva solicitud desde la vitrina — aviso al propietario/inmobiliaria. */
  NUEVA_SOLICITUD_VITRINA: {
    id: 'cofianza_nueva_solicitud_vitrina',
    language: 'es_CO',
    // {{1}} nombre del interesado, {{2}} dirección del inmueble
    description: 'Hola, recibiste una nueva solicitud de arriendo: {{1}} está interesado en tu inmueble {{2}}. Ingresa a Cofianza para revisar el expediente y agendar la visita.',
  },
  /** Estudio aprobado — aviso al dueño para que genere el contrato. */
  ESTUDIO_APROBADO_DUENO: {
    id: 'cofianza_estudio_aprobado_dueno',
    language: 'es_CO',
    // {{1}} nombre del dueño, {{2}} nombre del arrendatario, {{3}} dirección
    description: 'Hola {{1}}, el estudio de {{2}} para tu inmueble {{3}} fue aprobado. Ingresa a Cofianza para generar el contrato de arrendamiento.',
  },
  /** Estudio condicionado — aviso al dueño de que requiere su revisión. */
  ESTUDIO_CONDICIONADO_DUENO: {
    id: 'cofianza_estudio_condicionado_dueno',
    language: 'es_CO',
    // {{1}} nombre del dueño, {{2}} nombre del arrendatario, {{3}} dirección
    description: 'Hola {{1}}, el estudio de {{2}} para tu inmueble {{3}} quedó condicionado y requiere tu revisión. Ingresa a Cofianza para revisar y decidir si continúas.',
  },
  /**
   * Aviso al dueño/inmobiliaria de que el solicitante propuso (o reprogramó)
   * una visita y debe confirmarla. Cubre tanto la primera solicitud como la
   * reprogramación desde el link público. Estilo pulido (encabezado + emojis +
   * pie) como el resto; el cuerpo real vive en Meta.
   */
  CITA_SOLICITADA_DUENO: {
    id: 'cofianza_cita_solicitada_dueno',
    language: 'es_CO',
    // {{1}} dueño, {{2}} solicitante, {{3}} dirección, {{4}} ciudad, {{5}} fecha propuesta
    description: 'Hola {{1}}, {{2}} quiere visitar tu inmueble. 📍 Inmueble: {{3}}, {{4}} 📅 Fecha propuesta: {{5}}. Ingresa a Cofianza para confirmar la visita o proponer otra fecha.',
  },
} as const;

export type WhatsappTemplateKey = keyof typeof WHATSAPP_TEMPLATES;

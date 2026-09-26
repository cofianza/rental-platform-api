import { z } from 'zod';

// ============================================================
// Param schemas
// ============================================================

export const expedienteIdParamsSchema = z.object({
  expedienteId: z.string().uuid('ID de estudio inválido'),
});

export const tokenParamsSchema = z.object({
  token: z.string().min(32, 'Token inválido').max(64, 'Token inválido'),
});

// ============================================================
// POST /expedientes/:expedienteId/autorizacion-riesgo/enviar-enlace
// ============================================================

// Body opcional: corrige el contacto del solicitante si estaba mal escrito.
// Se persiste en `solicitantes` server-side (así también sirve para el rol
// propietario, que no tiene PATCH de solicitantes) y el enlace va al corregido.
export const enviarEnlaceAutorizacionSchema = z
  .object({
    email: z.string().email('Email inválido').optional(),
    telefono: z.string().max(20).optional(),
    // Documento corregido (Reintentar consulta): la firma nueva congela el de
    // la ficha, así que se corrige ahí antes de emitir el enlace.
    // Mismos valores que el body de /estudios/:id/ejecutar (Reintentar consulta).
    tipo_documento: z.enum(['cc', 'nit', 'ce', 'ti', 'pasaporte', 'ppt', 'pep']).optional(),
    numero_documento: z.string().trim().min(5).max(20).optional(),
  })
  .optional();

// ============================================================
// POST /public/autorizar/:token/firmar
// ============================================================

// §8.1: el numero de documento que ESCRIBE el prospecto. Se compara en el
// servidor con la ficha (normalizando puntos y espacios) y nunca se devuelve.
const numeroDocumentoEscrito = z
  .string()
  .trim()
  .min(1, 'Escribe tu número de documento')
  .max(30, 'Número de documento demasiado largo');

// ============================================================
// POST /public/autorizar/:token/confirmar-identidad  (Flujo §8.1)
// ============================================================

export const confirmarIdentidadSchema = z.object({
  numero_documento: numeroDocumentoEscrito,
});

// Adenda 1 §7 (Gerencia, 07/09/2026): "No se implementa OTP en el flujo de
// autorizacion del estudio." El prospecto autoriza marcando las casillas
// ('casilla', Decreto 1377/2013 art. 7). 'otp' sigue aceptado y, si viene,
// se verifica; 'canvas' se conserva por compatibilidad. El riesgo del enlace
// reenviado a un tercero (Flujo §12) queda ACEPTADO y registrado por la
// Gerencia General en esa Adenda: la evidencia es el registro de la
// aceptacion (fecha, hora, IP, dispositivo, texto y documento confirmado).
export const firmarSchema = z.object({
  metodo_firma: z.enum(['casilla', 'canvas', 'otp'], {
    message: 'Método de firma inválido. Valores permitidos: casilla, canvas, otp',
  }),
  datos_firma: z.string().min(100, 'Firma inválida').max(500000, 'Firma demasiado grande').optional(),
  codigo_otp: z.string().length(6, 'Código OTP debe ser de 6 dígitos').optional(),
  // Flujo §8.1: la firma vuelve a comparar el documento escrito con la ficha
  // (un POST directo se saltaria confirmar-identidad). Obligatorio.
  numero_documento: numeroDocumentoEscrito,
  // Consentimientos opcionales (Paso 2 "Beneficios"). No condicionan el servicio.
  consentimientos_opcionales: z
    .object({
      analitica: z.boolean().optional(),
      comercial: z.boolean().optional(),
      historial_referencia: z.boolean().optional(),
    })
    .optional(),
}).superRefine((data, ctx) => {
  if (data.metodo_firma === 'canvas' && !data.datos_firma) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['datos_firma'],
      message: 'La firma es requerida para el método canvas',
    });
  }
  if (data.metodo_firma === 'otp' && !data.codigo_otp) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['codigo_otp'],
      message: 'El código OTP es requerido para verificación por OTP',
    });
  }
});

// ============================================================
// POST /public/autorizar/:token/perfil  (Flujo §8, PASO 5)
// ============================================================

// Todo opcional a proposito. §8.2 es, segun el propio documento, "donde mas
// gente abandona": el boton Continuar nunca se deshabilita y un envio parcial
// vale. La identidad (§8.1) ya no entra por aqui: exige el documento escrito
// (confirmarIdentidadSchema); una clave `identidad_confirmada` se descarta.
//
// TOLERANCIA POR CAMPO (`.catch(undefined)`): los tres bloques del §8 viajan en
// UN solo POST y `validate` rechaza el body ENTERO ante cualquier issue. Sin
// esto, un correo del co-arrendatario tecleado en un celular sin el TLD
// ("maria@gmail") o un par de ceros de mas en el ingreso tiraban a la basura
// tambien la confirmacion de identidad, la situacion laboral y el resto — todo
// el PASO 5 perdido por el campo opcional de un tercero. Un campo malo se cae
// solo; los demas se guardan.
export const perfilProspectoSchema = z.object({
  // §8.2 — AUTORREPORTADO. No alimenta el scorecard (Politica V4.1 §4.2).
  situacion_laboral: z.enum(['empleado', 'independiente', 'pensionado', 'otro']).optional().catch(undefined),
  // Politica Anexo A.3/A.4: solo si eligio 'independiente'. Sin RUT = informal
  // = revision manual (reglas-duras.ts).
  tiene_rut: z.boolean().optional().catch(undefined),
  donde_labora: z.string().max(200).optional().catch(undefined),
  ingreso_declarado_cop: z.coerce.number().nonnegative().max(1_000_000_000).optional().catch(undefined),
  // §8.3 — INTENCION, no invitacion. No se piden tipo ni numero de documento
  // del co-arrendatario: es el dato de un tercero tecleado de memoria por un
  // cuarto en un celular (calidad pesima) y es friccion justo donde la gente
  // abandona. El gestor los completa en el formulario que ya existe.
  presentacion: z.enum(['solo', 'acompanado']).optional(),
  coarrendatario: z
    .object({
      nombre: z.string().min(1).max(100),
      apellido: z.string().min(1).max(100),
      email: z.email('Email inválido').optional(),
      telefono: z.string().max(20).optional(),
    })
    .refine((c) => !!(c.email || c.telefono), {
      message: 'Necesitamos su correo o su WhatsApp para poder escribirle',
    })
    .optional()
    .catch(undefined),
});

// ============================================================
// POST /public/autorizar/:token/biometria  (Politica Anexo A + §14)
// ============================================================

/**
 * Imagen como data URL JPEG/PNG o base64 crudo.
 *
 * EL TOPE ES EL PUNTO: `express.json({ limit: '2mb' })` cubre el REQUEST
 * ENTERO, y aqui viajan DOS imagenes. Sin corte por campo, dos fotos de un
 * celular moderno (4-8 MB cada una en base64) revientan el body parser con un
 * 413 crudo, sin mensaje util y sin llegar a este schema. 1.4 MB de base64
 * son ~1 MB de JPEG, de sobra para un cotejo facial; el front ya reescala a
 * 1280 px antes de enviar.
 */
const imagenBase64 = z
  .string()
  .min(100, 'Imagen vacía o incompleta')
  .max(1_400_000, 'La imagen es demasiado grande: vuelve a tomarla')
  .refine(
    (v) => /^data:image\/(jpeg|jpg|png);base64,[A-Za-z0-9+/=\s]+$/.test(v) || /^[A-Za-z0-9+/=\s]+$/.test(v),
    { message: 'Formato de imagen inválido (se espera JPEG o PNG en base64)' },
  );

export const biometriaSchema = z.object({
  /** Foto del documento de identidad (anverso). */
  documentImage: imagenBase64,
  /** Selfie del titular. */
  photo: imagenBase64,
});

// ============================================================
// POST /public/autorizar/:token/reportar-identidad  (Flujo §12)
// ============================================================

export const reportarIdentidadSchema = z.object({
  motivo: z.enum(['no_soy_yo', 'datos_incorrectos']),
  detalle: z.string().max(500).optional(),
});

// ============================================================
// PATCH /expedientes/:expedienteId/autorizacion-riesgo/revocar
// ============================================================

// Ley 1581 art. 8 + Decreto 1377 art. 9 y 20: Cofianza registra la solicitud
// de revocacion que el TITULAR le hizo, con la fecha y el canal por el que
// llego y el soporte (numero de radicado, correo, nota de la llamada...).
export const CANALES_REVOCACION = ['correo', 'whatsapp', 'llamada', 'escrito'] as const;

export const revocarSchema = z.object({
  canal: z.enum(CANALES_REVOCACION, { message: 'Canal inválido. Valores permitidos: correo, whatsapp, llamada, escrito' }),
  // Fecha en que el titular hizo la solicitud (AAAA-MM-DD, hora de Colombia).
  fecha_solicitud: z.iso
    .date('Fecha de la solicitud inválida (AAAA-MM-DD)')
    .refine(
      (f) => f <= new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }),
      'La fecha de la solicitud no puede ser futura',
    ),
  // Soporte o nota de la solicitud.
  motivo: z.string()
    .min(10, 'El soporte debe tener al menos 10 caracteres')
    .max(1000, 'El soporte no debe exceder 1000 caracteres'),
  // Sujeto a revocar. Sin este campo se revoca la del TITULAR (comportamiento
  // historico). Con el, la del co-arrendatario invitado indicado: desde
  // 2026-09-03 el co-arrendatario tiene su propia autorizacion habeas data y
  // sin esta via no tendria forma de ejercer su derecho de revocacion
  // (Ley 1581 de 2012, art. 8), porque la fila del titular y la suya comparten
  // expediente_id.
  coarrendatario_id: z.uuid({ error: 'ID de co-arrendatario inválido' }).optional(),
});

// ============================================================
// POST /public/autorizar/:token/verificar-otp
// ============================================================

export const verificarOtpSchema = z.object({
  codigo: z.string().length(6, 'Código debe ser de 6 dígitos'),
});

// ============================================================
// Type exports
// ============================================================

export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
export type TokenParams = z.infer<typeof tokenParamsSchema>;
export type EnviarEnlaceAutorizacionInput = z.infer<typeof enviarEnlaceAutorizacionSchema>;
export type FirmarInput = z.infer<typeof firmarSchema>;
export type RevocarInput = z.infer<typeof revocarSchema>;
export type VerificarOtpInput = z.infer<typeof verificarOtpSchema>;
export type PerfilProspectoInput = z.infer<typeof perfilProspectoSchema>;
export type ReportarIdentidadInput = z.infer<typeof reportarIdentidadSchema>;
export type BiometriaInput = z.infer<typeof biometriaSchema>;
export type ConfirmarIdentidadInput = z.infer<typeof confirmarIdentidadSchema>;

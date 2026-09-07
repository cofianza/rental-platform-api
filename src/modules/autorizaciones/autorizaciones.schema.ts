import { z } from 'zod';

// ============================================================
// Param schemas
// ============================================================

export const expedienteIdParamsSchema = z.object({
  expedienteId: z.string().uuid('ID de expediente invalido'),
});

export const tokenParamsSchema = z.object({
  token: z.string().min(32, 'Token invalido').max(64, 'Token invalido'),
});

// ============================================================
// POST /expedientes/:expedienteId/autorizacion-riesgo/enviar-enlace
// ============================================================

// Body opcional: corrige el contacto del solicitante si estaba mal escrito.
// Se persiste en `solicitantes` server-side (así también sirve para el rol
// propietario, que no tiene PATCH de solicitantes) y el enlace va al corregido.
export const enviarEnlaceAutorizacionSchema = z
  .object({
    email: z.string().email('Email invalido').optional(),
    telefono: z.string().max(20).optional(),
  })
  .optional();

// ============================================================
// POST /public/autorizar/:token/firmar
// ============================================================

// Adenda 1 §7 (Gerencia, 07/09/2026): "No se implementa OTP en el flujo de
// autorizacion del estudio." El prospecto autoriza marcando las casillas
// ('casilla', Decreto 1377/2013 art. 7). 'otp' sigue aceptado y, si viene,
// se verifica; 'canvas' se conserva por compatibilidad. El riesgo del enlace
// reenviado a un tercero (Flujo §12) queda ACEPTADO y registrado por la
// Gerencia General en esa Adenda: la evidencia es el registro de la
// aceptacion (fecha, hora, IP, dispositivo, texto y documento confirmado).
export const firmarSchema = z.object({
  metodo_firma: z.enum(['casilla', 'canvas', 'otp'], {
    message: 'Metodo de firma invalido. Valores permitidos: casilla, canvas, otp',
  }),
  datos_firma: z.string().min(100, 'Firma invalida').max(500000, 'Firma demasiado grande').optional(),
  codigo_otp: z.string().length(6, 'Codigo OTP debe ser de 6 digitos').optional(),
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
      message: 'La firma es requerida para el metodo canvas',
    });
  }
  if (data.metodo_firma === 'otp' && !data.codigo_otp) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['codigo_otp'],
      message: 'El codigo OTP es requerido para verificacion por OTP',
    });
  }
});

// ============================================================
// POST /public/autorizar/:token/perfil  (Flujo §8, PASO 5)
// ============================================================

// Todo opcional a proposito. §8.2 es, segun el propio documento, "donde mas
// gente abandona": el boton Continuar nunca se deshabilita y un envio parcial
// vale. `identidad_confirmada` es z.literal(true) cuando viene, para que un
// cliente no pueda registrar "confirme" con false.
//
// TOLERANCIA POR CAMPO (`.catch(undefined)`): los tres bloques del §8 viajan en
// UN solo POST y `validate` rechaza el body ENTERO ante cualquier issue. Sin
// esto, un correo del co-arrendatario tecleado en un celular sin el TLD
// ("maria@gmail") o un par de ceros de mas en el ingreso tiraban a la basura
// tambien la confirmacion de identidad, la situacion laboral y el resto — todo
// el PASO 5 perdido por el campo opcional de un tercero. Un campo malo se cae
// solo; los demas se guardan. `identidad_confirmada` NO lleva catch: es
// literal(true) o nada, y ahi si queremos el 400.
export const perfilProspectoSchema = z.object({
  // §8.1
  identidad_confirmada: z.literal(true).optional(),
  // §8.2 — AUTORREPORTADO. No alimenta el scorecard (Politica V4.1 §4.2).
  situacion_laboral: z.enum(['empleado', 'independiente', 'pensionado', 'otro']).optional().catch(undefined),
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
      email: z.email('Email invalido').optional(),
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
  .min(100, 'Imagen vacia o incompleta')
  .max(1_400_000, 'La imagen es demasiado grande: vuelve a tomarla')
  .refine(
    (v) => /^data:image\/(jpeg|jpg|png);base64,[A-Za-z0-9+/=\s]+$/.test(v) || /^[A-Za-z0-9+/=\s]+$/.test(v),
    { message: 'Formato de imagen invalido (se espera JPEG o PNG en base64)' },
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

export const revocarSchema = z.object({
  motivo: z.string()
    .min(10, 'El motivo debe tener al menos 10 caracteres')
    .max(1000, 'El motivo no debe exceder 1000 caracteres'),
  // Sujeto a revocar. Sin este campo se revoca la del TITULAR (comportamiento
  // historico). Con el, la del co-arrendatario invitado indicado: desde
  // 2026-09-03 el co-arrendatario tiene su propia autorizacion habeas data y
  // sin esta via no tendria forma de ejercer su derecho de revocacion
  // (Ley 1581 de 2012, art. 8), porque la fila del titular y la suya comparten
  // expediente_id.
  coarrendatario_id: z.uuid({ error: 'ID de co-arrendatario invalido' }).optional(),
});

// ============================================================
// POST /public/autorizar/:token/verificar-otp
// ============================================================

export const verificarOtpSchema = z.object({
  codigo: z.string().length(6, 'Codigo debe ser de 6 digitos'),
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

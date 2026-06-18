import { z } from 'zod';

// Teléfono en E.164: '+' + 1-15 dígitos. Aceptamos también local CO
// (10 dígitos) y le prefijamos '+57' en el service si no viene con '+'.
const phoneSchema = z
  .string()
  .min(7, 'Teléfono muy corto')
  .max(20, 'Teléfono muy largo')
  .regex(/^\+?[\d\s-]+$/, 'Teléfono inválido');

export const enviarWhatsappSchema = z.object({
  to: phoneSchema,
  template_id: z.string().min(1, 'template_id requerido').max(100),
  language: z.string().min(2).max(10).optional(),
  variables: z.array(z.string().max(500)).max(20).optional(),
  // true para plantillas de categoría "Authentication" (Meta): el código va en
  // el cuerpo y además en el botón "copiar código".
  is_authentication: z.boolean().optional(),
  // Sufijos dinámicos de botones URL (uno por botón, en orden). Para plantillas
  // con botones "Visitar sitio web" de URL dinámica (p.ej. token de la cita).
  url_buttons: z.array(z.string().max(300)).max(3).optional(),
  context: z
    .object({
      expediente_id: z.uuid().optional(),
      contrato_id: z.uuid().optional(),
      mora_id: z.uuid().optional(),
      estudio_id: z.uuid().optional(),
    })
    .optional(),
});

export type EnviarWhatsappInput = z.infer<typeof enviarWhatsappSchema>;

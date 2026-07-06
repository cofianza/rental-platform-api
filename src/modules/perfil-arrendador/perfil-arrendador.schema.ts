import { z } from 'zod';

/**
 * Datos del arrendador editables por la inmobiliaria/propietario.
 * Estos campos alimentan la generacion del contrato (cabecera + clausula
 * CUARTA paragrafo 1 + bloque de notificaciones).
 *
 * Todos los campos son opcionales para permitir guardado parcial — el
 * frontend valida obligatoriedad al "Guardar" pero permite que la
 * inmobiliaria complete su perfil en pasos.
 */
export const updatePerfilArrendadorSchema = z.object({
  // Datos generales (PJ/PN)
  // Nombre comercial / razón social de la inmobiliaria (sale en el contrato y
  // en el header). Solo inmobiliaria; un propietario individual usa su nombre.
  razon_social: z.string().max(200).optional().nullable(),
  // NIT de la inmobiliaria (con dígito de verificación). Sale en el contrato.
  // Solo inmobiliaria (un propietario individual se identifica con su cédula).
  // max(20) para coincidir con la columna perfiles.nit VARCHAR(20).
  nit: z.string().max(20).optional().nullable(),
  representante_legal: z.string().max(200).optional().nullable(),
  domicilio_direccion: z.string().max(200).optional().nullable(),
  domicilio_ciudad: z.string().max(120).optional().nullable(),

  // Solo inmobiliaria (admin valida en el service)
  matricula_arrendador: z.string().max(50).optional().nullable(),

  // Recaudo
  whatsapp_recaudo: z.string().max(30).optional().nullable(),
  email_recaudo: z.string().email('Email invalido').optional().nullable().or(z.literal('')),
  cuenta_recaudo_banco: z.string().max(80).optional().nullable(),
  cuenta_recaudo_tipo: z.enum(['ahorros', 'corriente']).optional().nullable(),
  cuenta_recaudo_numero: z.string().max(40).optional().nullable(),
  cuenta_recaudo_titular_nombre: z.string().max(200).optional().nullable(),
  cuenta_recaudo_titular_nit: z.string().max(40).optional().nullable(),
});

export type UpdatePerfilArrendadorInput = z.infer<typeof updatePerfilArrendadorSchema>;

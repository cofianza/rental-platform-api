import { z } from 'zod';

export const crearSolicitudFirmaSchema = z.object({
  contrato_id: z.string().uuid('ID de contrato invalido'),
  nombre_firmante: z.string().min(2, 'Nombre debe tener al menos 2 caracteres').max(200),
  email_firmante: z.string().email('Email invalido').max(255),
  telefono_firmante: z.string().max(20).optional(),
  enviar_sms: z.boolean().optional().default(false),
});

export const solicitudIdParamsSchema = z.object({
  id: z.string().uuid('ID de solicitud invalido'),
});

export const contratoIdParamsSchema = z.object({
  contratoId: z.string().uuid('ID de contrato invalido'),
});

export const tokenParamsSchema = z.object({
  token: z.string().length(64, 'Token invalido'),
});

export const otpVerificarSchema = z.object({
  codigo: z.string().length(6, 'El codigo debe ser de 6 digitos').regex(/^\d+$/, 'El codigo debe ser numerico'),
});

export const completarFirmaSchema = z.object({
  firma_imagen: z.string().min(100, 'La firma no puede estar vacia'),
  user_agent: z.string().min(1).max(1000),
  geo_latitud: z.number().min(-90).max(90).optional(),
  geo_longitud: z.number().min(-180).max(180).optional(),
  geo_precision: z.number().min(0).optional(),
});

export type CrearSolicitudFirmaInput = z.infer<typeof crearSolicitudFirmaSchema>;
export type SolicitudIdParams = z.infer<typeof solicitudIdParamsSchema>;
export type ContratoIdParams = z.infer<typeof contratoIdParamsSchema>;
export type OtpVerificarInput = z.infer<typeof otpVerificarSchema>;
export type CompletarFirmaInput = z.infer<typeof completarFirmaSchema>;

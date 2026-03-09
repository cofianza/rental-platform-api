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

export type CrearSolicitudFirmaInput = z.infer<typeof crearSolicitudFirmaSchema>;
export type SolicitudIdParams = z.infer<typeof solicitudIdParamsSchema>;
export type ContratoIdParams = z.infer<typeof contratoIdParamsSchema>;

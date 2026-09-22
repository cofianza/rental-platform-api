import { z } from 'zod';

export const crearSolicitudFirmaSchema = z.object({
  contrato_id: z.string().uuid('ID de contrato inválido'),
  nombre_firmante: z.string().min(2, 'Nombre debe tener al menos 2 caracteres').max(200),
  email_firmante: z.string().email('Email inválido').max(255),
  telefono_firmante: z.string().max(20).optional(),
  enviar_sms: z.boolean().optional().default(false),
});

export const solicitudIdParamsSchema = z.object({
  id: z.string().uuid('ID de solicitud inválido'),
});

export const contratoIdParamsSchema = z.object({
  contratoId: z.string().uuid('ID de contrato inválido'),
});

export const tokenParamsSchema = z.object({
  token: z.string().length(64, 'Token inválido'),
});

// Adenda 2 §9 — verificación de identidad antes de la firma
export const consentimientoIdentidadSchema = z.object({
  opcion: z.enum(['autoriza', 'analista']),
});

export const verificacionIdentidadParamsSchema = z.object({
  contratoId: z.string().uuid('ID de contrato inválido'),
  verificacionId: z.string().uuid('ID de verificación inválido'),
});

export const revisarIdentidadSchema = z.object({
  resultado: z.enum(['confirmada', 'suplantacion']),
  nota: z.string().trim().min(10, 'Escribe cómo verificaste la identidad (mínimo 10 caracteres)').max(1000),
});

export const reenviarFirmaSchema = z.object({
  email_alternativo: z.string().email('Email inválido').max(255).optional(),
});

export type CrearSolicitudFirmaInput = z.infer<typeof crearSolicitudFirmaSchema>;
export type SolicitudIdParams = z.infer<typeof solicitudIdParamsSchema>;
export type ContratoIdParams = z.infer<typeof contratoIdParamsSchema>;
export type ReenviarFirmaInput = z.infer<typeof reenviarFirmaSchema>;

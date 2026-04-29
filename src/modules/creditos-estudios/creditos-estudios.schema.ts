import { z } from 'zod';

// ============================================================
// Inmobiliaria-facing
// ============================================================

export const comprarPaqueteSchema = z.object({
  paquete_id: z.uuid({ error: 'ID de paquete invalido' }),
});

export const liberarEstudioCreditoSchema = z.object({
  notas: z.string().max(500, 'Notas muy largas').optional(),
});

// ============================================================
// Super admin (CRUD paquetes)
// ============================================================

export const createPaqueteSchema = z.object({
  nombre: z.string().min(1, 'Nombre requerido').max(100, 'Nombre muy largo'),
  descripcion: z.string().max(500, 'Descripcion muy larga').optional(),
  cantidad_estudios: z.coerce.number().int().min(1, 'Cantidad minima es 1').max(1000, 'Maximo 1000'),
  precio_cop: z.coerce.number().int().min(1000, 'Precio minimo es $1.000').max(99999999, 'Precio muy alto'),
  vence_en_dias: z.coerce.number().int().positive().nullable().optional(),
  activo: z.boolean().default(true),
  orden: z.coerce.number().int().min(0).default(0),
});

export const updatePaqueteSchema = createPaqueteSchema.partial();

export const paqueteIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID de paquete invalido' }),
});

// ============================================================
// Listado de movimientos (historial)
// ============================================================

export const listMovimientosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  tipo: z.enum(['compra', 'consumo', 'expiracion', 'ajuste']).optional(),
});

export const compraIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID de compra invalido' }),
});

// Datos fiscales de la inmobiliaria que pueden venir como override en
// el body al facturar — si faltan, se intenta leer del perfil. Todos
// opcionales para soportar el preflight (POST sin body para detectar
// faltantes).
export const facturarCompraSchema = z.object({
  razon_social: z.string().min(1).max(200).optional(),
  nit: z.string().min(1).max(20).optional(),
  direccion: z.string().min(1).max(200).optional(),
  email: z.string().email('Email invalido').max(200).optional(),
  telefono: z.string().min(1).max(20).optional(),
  municipio_codigo: z.string().regex(/^\d{5}$/, 'Codigo DANE invalido (5 digitos)').optional(),
  municipio_nombre: z.string().min(1).max(100).optional(),
  tipo_documento: z.string().min(1).max(5).optional(),
});

export type ComprarPaqueteInput = z.infer<typeof comprarPaqueteSchema>;
export type LiberarEstudioCreditoInput = z.infer<typeof liberarEstudioCreditoSchema>;
export type CreatePaqueteInput = z.infer<typeof createPaqueteSchema>;
export type UpdatePaqueteInput = z.infer<typeof updatePaqueteSchema>;
export type PaqueteIdParams = z.infer<typeof paqueteIdParamsSchema>;
export type ListMovimientosQuery = z.infer<typeof listMovimientosQuerySchema>;
export type CompraIdParams = z.infer<typeof compraIdParamsSchema>;
export type FacturarCompraInput = z.infer<typeof facturarCompraSchema>;

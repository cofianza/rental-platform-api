import { z } from 'zod';

export const TIPOS_ARCHIVO_CONTRATO = ['inventario', 'acta_entrega', 'documento_identidad'] as const;
export type TipoArchivoContrato = (typeof TIPOS_ARCHIVO_CONTRATO)[number];

export const subirArchivoParamsSchema = z.object({
  id: z.string().uuid('ID de contrato invalido'),
});

export const subirArchivoBodySchema = z.object({
  tipo_archivo: z.enum(TIPOS_ARCHIVO_CONTRATO, {
    message: 'Tipo de archivo invalido. Valores permitidos: inventario, acta_entrega, documento_identidad',
  }),
});

export const archivoIdParamsSchema = z.object({
  id: z.string().uuid('ID de contrato invalido'),
  archivoId: z.string().uuid('ID de archivo invalido'),
});

export type SubirArchivoParams = z.infer<typeof subirArchivoParamsSchema>;
export type SubirArchivoBody = z.infer<typeof subirArchivoBodySchema>;
export type ArchivoIdParams = z.infer<typeof archivoIdParamsSchema>;

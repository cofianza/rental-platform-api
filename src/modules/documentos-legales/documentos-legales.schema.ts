import { z } from 'zod';

export const TIPOS_DOCUMENTO_LEGAL = [
  'camara_comercio',
  'rut',
  'matricula_arrendador',
  'cedula_representante',
  'poder_notarial',
  'poliza',
  'contrato_marco',
] as const;

export type TipoDocumentoLegal = (typeof TIPOS_DOCUMENTO_LEGAL)[number];

export const tipoParamsSchema = z.object({
  tipo: z.enum(TIPOS_DOCUMENTO_LEGAL, {
    error: `Tipo invalido. Valores permitidos: ${TIPOS_DOCUMENTO_LEGAL.join(', ')}`,
  }),
});

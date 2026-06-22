import { z } from 'zod';

// Actualización parcial de los datos de la empresa (Cofianza). Todos opcionales;
// se mezclan sobre los valores actuales.
export const updateEmpresaSchema = z
  .object({
    name: z.string().trim().min(1).max(300).optional(),
    nit: z.string().trim().min(1).max(50).optional(),
    address: z.string().trim().min(1).max(300).optional(),
    phone: z.string().trim().min(1).max(30).optional(),
    email: z.string().email({ message: 'Email inválido' }).max(255).optional(),
    website: z.string().trim().max(255).optional(),
    certificateValidityDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();

export type UpdateEmpresaInput = z.infer<typeof updateEmpresaSchema>;

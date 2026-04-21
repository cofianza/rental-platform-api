import { z } from 'zod';

// Token = 64 chars hex (crypto.randomBytes(32).toString('hex') en expediente-externo.service.ts).
export const tokenParamSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, { message: 'Token de invitación inválido' }),
});

export type TokenParam = z.infer<typeof tokenParamSchema>;

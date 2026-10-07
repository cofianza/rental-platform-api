import { z } from 'zod';

const fecha = z.iso.date({ error: 'Fecha inválida (AAAA-MM-DD)' });
const mes = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/, 'Indique el mes como AAAA-MM-01');

export const idParams = z.object({ id: z.string().uuid('ID inválido') });

export const listarCuentasQuery = z.object({
  situacion: z.enum(['borrador', 'bloqueada_fiscal', 'emitiendo', 'emitida', 'pagada', 'parcial', 'vencida', 'anulada']).optional(),
  periodo: mes.optional(),
});

export const pagoBody = z.object({
  referencia: z.string().trim().min(1, 'Indique la referencia del pago').max(120),
  fecha,
});

export const anularBody = z.object({
  motivo: z.string().trim().min(5, 'Indique el motivo de la anulación').max(500),
});

export const terminacionBody = z.object({ fecha });

export const condicionBody = z
  .object({
    fecha,
    canon_cop: z.number().positive('El canon debe ser mayor que cero').max(1_000_000_000).optional(),
    tarifa_pct: z.number().min(0).max(100).optional(),
  })
  .refine((d) => d.canon_cop != null || d.tarifa_pct != null, { error: 'Indique el canon o el % de la tarifa' });

export const liquidacionQuery = z.object({ periodo: mes });

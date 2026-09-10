import { z } from 'zod';

const ROLES_USUARIO = ['administrador', 'operador_analista', 'gerencia_consulta', 'propietario', 'inmobiliaria'] as const;

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
  role: z.enum(ROLES_USUARIO).optional(),
  is_active: z.enum(['true', 'false']).optional(),
  sortBy: z.enum(['created_at', 'nombre', 'email']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const userIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID de usuario inválido' }),
});

export const createUserSchema = z.object({
  email: z.email({ error: 'Email inválido' }),
  nombre: z.string().min(1, 'Nombre requerido').max(100, 'Nombre muy largo'),
  apellido: z.string().min(1, 'Apellido requerido').max(100, 'Apellido muy largo'),
  telefono: z.string().max(20, 'Teléfono muy largo').optional(),
  rol: z.enum(ROLES_USUARIO, { error: 'Rol inválido. Roles permitidos: administrador, operador_analista, gerencia_consulta, propietario, inmobiliaria' }),
});

export const updateUserSchema = z.object({
  nombre: z.string().min(1, 'Nombre requerido').max(100, 'Nombre muy largo').optional(),
  apellido: z.string().min(1, 'Apellido requerido').max(100, 'Apellido muy largo').optional(),
  telefono: z.string().max(20, 'Teléfono muy largo').nullable().optional(),
  rol: z.enum(ROLES_USUARIO, { error: 'Rol inválido. Roles permitidos: administrador, operador_analista, gerencia_consulta, propietario, inmobiliaria' }).optional(),
});

// Reset de contraseña por administrador — el admin ingresa directamente
// la nueva contraseña del usuario (no se manda link). Misma validacion
// de fuerza que el flow de reset normal: 8+ chars, 1 mayus, 1 minus, 1 digit.
export const resetPasswordByAdminSchema = z.object({
  password: z
    .string()
    .min(8, 'La contraseña debe tener al menos 8 caracteres')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'La contraseña debe contener al menos 1 mayúscula, 1 minúscula y 1 número',
    ),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type UserIdParams = z.infer<typeof userIdParamsSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ResetPasswordByAdminInput = z.infer<typeof resetPasswordByAdminSchema>;

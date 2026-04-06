export type UserRole = 'administrador' | 'operador_analista' | 'gerencia_consulta' | 'propietario' | 'inmobiliaria' | 'solicitante';

export interface AuthUser {
  id: string;
  email: string;
  rol: UserRole;
  activo: boolean;
}

export type { Resource, Action, InternalRole } from '@/config/permissions';

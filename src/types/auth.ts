export type UserRole = 'administrador' | 'operador_analista' | 'gerencia_consulta' | 'propietario' | 'inmobiliaria';

export interface AuthUser {
  id: string;
  email: string;
  rol: UserRole;
  activo: boolean;
}

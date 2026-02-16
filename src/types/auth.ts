export type UserRole = 'administrador' | 'operador_analista' | 'gerencia_consulta' | 'propietario' | 'inmobiliaria';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

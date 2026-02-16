export type UserRole = 'admin' | 'operator' | 'manager' | 'owner' | 'agency';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

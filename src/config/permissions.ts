/**
 * Configuracion RBAC - Mapa de permisos por rol
 * Fuente unica de verdad para todo el sistema de control de acceso.
 * Solo roles internos del panel admin (HP-151 cubre propietario/inmobiliaria).
 */

// ============================================================
// Tipos
// ============================================================

export type Resource =
  | 'usuarios'
  | 'expedientes'
  | 'estudios'
  | 'contratos'
  | 'plantillas'
  | 'inmuebles'
  | 'reportes'
  | 'configuracion'
  | 'bitacora'
  | 'dashboard'
  | 'solicitantes'
  | 'documentos'
  | 'pagos'
  | 'facturas';

export type Action =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'export'
  | 'validar'
  | 'descargar'
  | 'read_own';

export type InternalRole = 'administrador' | 'operador_analista' | 'gerencia_consulta';

export type PermissionMap = Record<Resource, Action[]>;

// ============================================================
// Mapa de permisos
// ============================================================

export const ROLE_PERMISSIONS: Record<InternalRole, PermissionMap> = {
  administrador: {
    usuarios: ['create', 'read', 'update', 'delete'],
    expedientes: ['create', 'read', 'update', 'delete'],
    estudios: ['create', 'read', 'update', 'delete'],
    contratos: ['create', 'read', 'update', 'delete'],
    plantillas: ['create', 'read', 'update', 'delete'],
    inmuebles: ['create', 'read', 'update', 'delete'],
    reportes: ['read', 'export'],
    configuracion: ['create', 'read', 'update', 'delete'],
    bitacora: ['read'],
    dashboard: ['read'],
    solicitantes: ['create', 'read', 'update', 'delete'],
    documentos: ['create', 'read', 'update', 'delete', 'validar'],
    pagos: ['create', 'read', 'update', 'delete'],
    facturas: ['create', 'read', 'update', 'delete'],
  },
  operador_analista: {
    usuarios: ['read_own'],
    expedientes: ['create', 'read', 'update', 'delete'],
    estudios: ['create', 'read', 'update'],
    contratos: ['create', 'read', 'update'],
    plantillas: ['read'],
    inmuebles: ['create', 'read', 'update', 'delete'],
    reportes: ['read', 'export'],
    configuracion: [],
    bitacora: [],
    dashboard: ['read'],
    solicitantes: ['create', 'read', 'update', 'delete'],
    documentos: ['create', 'read', 'update', 'delete', 'validar'],
    pagos: ['create', 'read'],
    facturas: ['create', 'read'],
  },
  gerencia_consulta: {
    usuarios: [],
    expedientes: ['read'],
    estudios: ['read'],
    contratos: ['read'],
    plantillas: [],
    inmuebles: ['read'],
    reportes: ['read', 'export'],
    configuracion: [],
    bitacora: [],
    dashboard: ['read'],
    solicitantes: ['read'],
    documentos: ['read', 'descargar'],
    pagos: ['read'],
    facturas: ['read'],
  },
};

// ============================================================
// Helpers
// ============================================================

export const INTERNAL_ROLES: InternalRole[] = ['administrador', 'operador_analista', 'gerencia_consulta'];

export function hasPermission(role: string, resource: Resource, action: Action): boolean {
  const permissions = ROLE_PERMISSIONS[role as InternalRole];
  if (!permissions) return false;
  const actions = permissions[resource];
  if (!actions) return false;
  return actions.includes(action);
}

export function getPermissionsForRole(role: string): PermissionMap | null {
  const permissions = ROLE_PERMISSIONS[role as InternalRole];
  return permissions ?? null;
}

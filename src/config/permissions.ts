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
  | 'facturas'
  | 'citas'
  | 'disponibilidad';

export type Action =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'export'
  | 'validar'
  | 'descargar'
  | 'read_own';

export type InternalRole = 'administrador' | 'operador_analista' | 'gerencia_consulta' | 'propietario' | 'inmobiliaria' | 'solicitante';

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
    citas: ['create', 'read', 'update', 'delete'],
    disponibilidad: ['read', 'read_own', 'update'],
  },
  operador_analista: {
    usuarios: ['read_own'],
    expedientes: ['create', 'read', 'update', 'delete'],
    estudios: ['create', 'read', 'update'],
    contratos: ['create', 'read', 'update'],
    plantillas: ['read'],
    inmuebles: ['create', 'read', 'update'],
    reportes: ['read', 'export'],
    configuracion: [],
    bitacora: [],
    dashboard: ['read'],
    solicitantes: ['create', 'read', 'update', 'delete'],
    documentos: ['create', 'read', 'update', 'delete', 'validar'],
    pagos: ['create', 'read'],
    facturas: ['create', 'read'],
    citas: ['create', 'read', 'update'],
    disponibilidad: ['read'],
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
    citas: ['read'],
    disponibilidad: ['read'],
  },
  propietario: {
    usuarios: ['read_own'],
    expedientes: ['read'],
    estudios: ['read'],
    // 'update' permite regenerar el PDF cuando cambien datos del perfil
    // o del inmueble. La generacion inicial es automatica via orchestrator.
    contratos: ['read', 'update'],
    plantillas: [],
    inmuebles: ['create', 'read', 'update'],
    reportes: [],
    // Configuracion: necesita read+update para 'Datos para contrato' (su
    // propio perfil arrendador con domicilio, cuenta de recaudo, logo).
    // La pagina /configuracion filtra secciones por rol — el propietario
    // solo ve las que le corresponden, no las de admin.
    configuracion: ['read', 'update'],
    bitacora: [],
    dashboard: ['read'],
    solicitantes: [],
    documentos: ['read', 'descargar'],
    // create/update: el propietario gestiona el pago del estudio de su
    // candidato (enviar link al arrendatario, asumir, cancelar-y-asumir).
    pagos: ['read', 'create', 'update'],
    facturas: ['read'],
    citas: ['create', 'read', 'update'],
    disponibilidad: ['read', 'read_own', 'update'],
  },
  inmobiliaria: {
    usuarios: ['read_own'],
    expedientes: ['create', 'read', 'update'],
    estudios: ['create', 'read', 'update'],
    contratos: ['create', 'read', 'update'],
    plantillas: ['read'],
    inmuebles: ['create', 'read', 'update'],
    reportes: ['read'],
    // Igual que propietario: necesita read+update para 'Datos para contrato'
    // y para 'Creditos de estudios' (gestion de paquetes y compras).
    configuracion: ['read', 'update'],
    bitacora: [],
    dashboard: ['read'],
    solicitantes: ['create', 'read', 'update'],
    documentos: ['create', 'read', 'update', 'descargar'],
    pagos: ['create', 'read'],
    facturas: ['create', 'read'],
    citas: ['create', 'read', 'update'],
    disponibilidad: ['read', 'read_own', 'update'],
  },
  solicitante: {
    usuarios: ['read_own'],
    expedientes: ['read'],
    estudios: ['read'],
    contratos: ['read'],
    plantillas: [],
    inmuebles: [],
    reportes: [],
    // Acceso a /configuracion solo para llegar a "Mi cuenta" (perfil propio).
    // Las demas secciones del menu se filtran con `soloRoles` en el frontend.
    configuracion: ['read'],
    bitacora: [],
    dashboard: ['read'],
    solicitantes: ['read_own'],
    documentos: ['create', 'read', 'descargar'],
    pagos: ['create', 'read'],
    facturas: ['read'],
    // 'update' habilita /reprogramar y /cancelar; el guard fino en
    // citas.permissions.ts limita las acciones a las propias del solicitante.
    citas: ['create', 'read', 'update'],
    disponibilidad: ['read'],
  },
};

// ============================================================
// Helpers
// ============================================================

export const INTERNAL_ROLES: InternalRole[] = ['administrador', 'operador_analista', 'gerencia_consulta', 'propietario', 'inmobiliaria', 'solicitante'];

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

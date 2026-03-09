// ============================================================
// Credit Risk Provider — Interfaces & Types
// ============================================================

export type ProveedorId = 'transunion' | 'sifin' | 'datacredito';

export type ProviderStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ProviderSolicitudInput {
  estudio_id: string;
  tipo: 'individual' | 'con_coarrendatario';
  nombre_completo: string;
  tipo_documento: string;
  numero_documento: string;
  email: string;
  telefono: string;
  ingresos_mensuales?: number;
  ocupacion?: string;
  empresa?: string;
  direccion_residencia?: string;
}

export interface ProviderSolicitudResponse {
  referencia_proveedor: string;
  status: ProviderStatus;
  mensaje: string | null;
}

export interface ProviderStatusResponse {
  referencia_proveedor: string;
  status: ProviderStatus;
  mensaje: string | null;
  progreso_porcentaje: number | null;
}

export interface ProviderResult {
  referencia_proveedor: string;
  score: number | null;
  resultado: 'aprobado' | 'rechazado' | 'condicionado';
  observaciones: string;
  datos_crudos: Record<string, unknown>;
}

export interface ProviderHealthInfo {
  proveedor: ProveedorId;
  disponible: boolean;
  latencia_ms: number | null;
  ultimo_error: string | null;
  timestamp: string;
}

export interface CreditRiskProvider {
  readonly id: ProveedorId;
  readonly name: string;

  solicitar(input: ProviderSolicitudInput): Promise<ProviderSolicitudResponse>;
  consultarEstado(referenciaProveedor: string): Promise<ProviderStatusResponse>;
  obtenerResultado(referenciaProveedor: string): Promise<ProviderResult>;
  cancelar(referenciaProveedor: string): Promise<{ cancelado: boolean; mensaje: string }>;
  verificarDisponibilidad(): Promise<ProviderHealthInfo>;
}

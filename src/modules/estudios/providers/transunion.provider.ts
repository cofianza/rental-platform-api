// ============================================================
// TransUnion Colombia — Stub (pendiente credenciales)
// ============================================================

import { AppError } from '@/lib/errors';
import type {
  CreditRiskProvider,
  ProviderSolicitudInput,
  ProviderSolicitudResponse,
  ProviderStatusResponse,
  ProviderResult,
  ProviderHealthInfo,
} from './types';

const NOT_IMPLEMENTED = 'Integracion con TransUnion no implementada. Pendiente credenciales del proveedor. Use modo mock o captura manual (HP-329).';

export class TransUnionProvider implements CreditRiskProvider {
  readonly id = 'transunion' as const;
  readonly name = 'TransUnion Colombia';

  // TODO: Implement when TransUnion credentials are available
  // Requires: TRANSUNION_API_URL, TRANSUNION_API_KEY

  async solicitar(_input: ProviderSolicitudInput): Promise<ProviderSolicitudResponse> {
    throw AppError.badRequest(NOT_IMPLEMENTED, 'PROVIDER_NOT_IMPLEMENTED');
  }

  async consultarEstado(_ref: string): Promise<ProviderStatusResponse> {
    throw AppError.badRequest(NOT_IMPLEMENTED, 'PROVIDER_NOT_IMPLEMENTED');
  }

  async obtenerResultado(_ref: string): Promise<ProviderResult> {
    throw AppError.badRequest(NOT_IMPLEMENTED, 'PROVIDER_NOT_IMPLEMENTED');
  }

  async cancelar(_ref: string): Promise<{ cancelado: boolean; mensaje: string }> {
    throw AppError.badRequest(NOT_IMPLEMENTED, 'PROVIDER_NOT_IMPLEMENTED');
  }

  async verificarDisponibilidad(): Promise<ProviderHealthInfo> {
    return {
      proveedor: this.id,
      disponible: false,
      latencia_ms: null,
      ultimo_error: NOT_IMPLEMENTED,
      timestamp: new Date().toISOString(),
    };
  }
}

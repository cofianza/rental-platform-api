// ============================================================
// Mock Credit Risk Provider — for development and testing
// ============================================================

import crypto from 'node:crypto';
import { logger } from '@/lib/logger';
import type {
  CreditRiskProvider,
  ProveedorId,
  ProviderSolicitudInput,
  ProviderSolicitudResponse,
  ProviderStatusResponse,
  ProviderResult,
  ProviderHealthInfo,
} from './types';

// In-memory store for mock studies
const mockStudies = new Map<string, {
  input: ProviderSolicitudInput;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
}>();

export class MockProvider implements CreditRiskProvider {
  readonly id: ProveedorId;
  readonly name: string;

  constructor(proveedorId: ProveedorId) {
    this.id = proveedorId;
    this.name = `Mock ${proveedorId}`;
  }

  async solicitar(input: ProviderSolicitudInput): Promise<ProviderSolicitudResponse> {
    await this.simulateDelay();

    // Simulate provider failure for docs ending in 999
    if (input.numero_documento.endsWith('999')) {
      throw new Error(`Mock provider (${this.id}): fallo simulado para documento terminado en 999`);
    }

    const ref = `MOCK-${this.id.toUpperCase()}-${crypto.randomUUID().slice(0, 8)}`;

    mockStudies.set(ref, { input, status: 'completed', createdAt: new Date() });

    logger.info(
      { provider: this.id, ref, documento: maskDocumento(input.numero_documento) },
      'Mock provider: estudio solicitado',
    );

    return {
      referencia_proveedor: ref,
      status: 'processing',
      mensaje: 'Estudio mock iniciado correctamente',
    };
  }

  async consultarEstado(ref: string): Promise<ProviderStatusResponse> {
    await this.simulateDelay();

    const study = mockStudies.get(ref);
    if (!study) {
      return {
        referencia_proveedor: ref,
        status: 'failed',
        mensaje: 'Referencia no encontrada en mock',
        progreso_porcentaje: null,
      };
    }

    return {
      referencia_proveedor: ref,
      status: study.status,
      mensaje: null,
      progreso_porcentaje: study.status === 'completed' ? 100 : 60,
    };
  }

  async obtenerResultado(ref: string): Promise<ProviderResult> {
    await this.simulateDelay();

    const study = mockStudies.get(ref);
    if (!study) {
      throw new Error(`Mock provider: referencia ${ref} no encontrada`);
    }

    const { resultado, score } = this.determineResult(study.input.numero_documento);

    return {
      referencia_proveedor: ref,
      score,
      resultado,
      observaciones: `Resultado mock generado por ${this.name}. Patron de documento determina resultado.`,
      datos_crudos: {
        mock: true,
        provider: this.id,
        timestamp: new Date().toISOString(),
        documento_pattern: study.input.numero_documento.slice(-3),
      },
    };
  }

  async cancelar(ref: string): Promise<{ cancelado: boolean; mensaje: string }> {
    await this.simulateDelay();
    mockStudies.delete(ref);
    return { cancelado: true, mensaje: 'Estudio mock cancelado exitosamente' };
  }

  async verificarDisponibilidad(): Promise<ProviderHealthInfo> {
    const start = Date.now();
    await this.simulateDelay();
    return {
      proveedor: this.id,
      disponible: true,
      latencia_ms: Date.now() - start,
      ultimo_error: null,
      timestamp: new Date().toISOString(),
    };
  }

  private determineResult(doc: string): { resultado: 'aprobado' | 'rechazado' | 'condicionado'; score: number } {
    if (doc.endsWith('000')) return { resultado: 'rechazado', score: 250 };
    if (doc.endsWith('111')) return { resultado: 'condicionado', score: 500 };
    return { resultado: 'aprobado', score: 750 };
  }

  private async simulateDelay(): Promise<void> {
    const delay = 1000 + Math.random() * 2000; // 1-3 seconds
    await new Promise((r) => setTimeout(r, delay));
  }
}

// ============================================================
// Data masking utility
// ============================================================

export function maskDocumento(doc: string): string {
  if (doc.length <= 4) return '****';
  return '****' + doc.slice(-4);
}

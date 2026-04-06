import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dashboardService from '../dashboard.service';

// ── Mock Supabase ───────────────────────────────────────────

const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockNeq = vi.fn();
const mockGte = vi.fn();
const mockLte = vi.fn();
const mockIn = vi.fn();

function createChain(finalData: unknown, finalCount?: number) {
  const chain: Record<string, unknown> = {};
  const methods = { select: mockSelect, eq: mockEq, neq: mockNeq, gte: mockGte, lte: mockLte, in: mockIn };

  for (const [name, fn] of Object.entries(methods)) {
    fn.mockImplementation(() => chain);
    chain[name] = fn;
  }

  // Terminal: return data
  chain.then = undefined;

  // Make it thenable for await
  Object.defineProperty(chain, 'then', {
    value: (resolve: (val: unknown) => void) => {
      resolve({ data: finalData, error: null, count: finalCount });
    },
    configurable: true,
  });

  return chain;
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { supabase } from '@/lib/supabase';
const mockFrom = supabase.from as ReturnType<typeof vi.fn>;

// ── Tests ───────────────────────────────────────────────────

describe('Dashboard Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSummary()', () => {
    it('deberia retornar summary con todos los campos', async () => {
      // Mock 5 parallel queries
      let callIndex = 0;
      mockFrom.mockImplementation((table: string) => {
        callIndex++;

        if (table === 'expedientes' && callIndex === 1) {
          // queryExpedientesActivos - count query
          return createChain(null, 5);
        }
        if (table === 'expedientes' && callIndex === 2) {
          // queryExpedientesPorEstado
          return createChain([
            { estado: 'borrador' },
            { estado: 'borrador' },
            { estado: 'en_revision' },
            { estado: 'aprobado' },
            { estado: 'aprobado' },
          ]);
        }
        if (table === 'expedientes' && callIndex === 3) {
          // queryTasaAprobacion
          return createChain([
            { estado: 'aprobado' },
            { estado: 'aprobado' },
            { estado: 'rechazado' },
          ]);
        }
        if (table === 'expedientes' && callIndex === 4) {
          // queryTiempoPromedioResolucion
          const now = new Date();
          const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
          return createChain([
            { created_at: fiveDaysAgo.toISOString(), updated_at: now.toISOString(), estado: 'aprobado' },
          ]);
        }
        if (table === 'pagos') {
          // queryIngresosDelPeriodo
          return createChain([
            { monto: 500000 },
            { monto: 1000000 },
          ]);
        }

        return createChain([]);
      });

      const result = await dashboardService.getSummary('2026-01-01', '2026-12-31');

      expect(result).toHaveProperty('totalExpedientesActivos');
      expect(result).toHaveProperty('expedientesPorEstado');
      expect(result).toHaveProperty('tasaAprobacion');
      expect(result).toHaveProperty('tiempoPromedioResolucionDias');
      expect(result).toHaveProperty('ingresosDelPeriodo');
      expect(result.expedientesPorEstado).toHaveProperty('borrador');
      expect(result.expedientesPorEstado).toHaveProperty('aprobado');
    });
  });

  describe('getExpedientesPorEstado()', () => {
    it('deberia retornar conteo agrupado por estado', async () => {
      mockFrom.mockImplementation(() => {
        return createChain([
          { estado: 'borrador' },
          { estado: 'borrador' },
          { estado: 'en_revision' },
          { estado: 'aprobado' },
        ]);
      });

      const result = await dashboardService.getExpedientesPorEstado('2026-01-01', '2026-12-31');

      expect(result).toBeInstanceOf(Array);
      const borrador = result.find((r) => r.estado === 'borrador');
      expect(borrador?.count).toBe(2);
      const aprobado = result.find((r) => r.estado === 'aprobado');
      expect(aprobado?.count).toBe(1);
    });

    it('deberia usar mes en curso si no se envian fechas', async () => {
      mockFrom.mockImplementation(() => createChain([]));

      const result = await dashboardService.getExpedientesPorEstado();

      expect(result).toBeInstanceOf(Array);
      expect(mockFrom).toHaveBeenCalledWith('expedientes');
    });

    it('deberia retornar array vacio si no hay datos', async () => {
      mockFrom.mockImplementation(() => createChain([]));

      const result = await dashboardService.getExpedientesPorEstado('2026-01-01', '2026-01-02');

      expect(result).toEqual([]);
    });
  });
});

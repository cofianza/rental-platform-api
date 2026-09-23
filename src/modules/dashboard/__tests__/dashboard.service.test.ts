import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dashboardService from '../dashboard.service';

// ── Mock Supabase ───────────────────────────────────────────

const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockNeq = vi.fn();
const mockGte = vi.fn();
const mockLte = vi.fn();
const mockIn = vi.fn();
const mockOrder = vi.fn();

function createChain(finalData: unknown, finalCount?: number) {
  const chain: Record<string, unknown> = {};
  // order/range: las consultas paginan con fetchAll.
  const methods = { select: mockSelect, eq: mockEq, neq: mockNeq, gte: mockGte, lte: mockLte, in: mockIn, order: mockOrder, range: vi.fn() };

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
    // Estudios creados en el periodo y sus decisiones en la línea de tiempo
    // (orden ascendente, como las pide la consulta).
    const eventos = [
      // e1: aprobado a los 2 días y luego cerrado por el contrato (el cierre no
      // es una decisión: no viene en esta consulta).
      { expediente_id: 'e1', estado_nuevo: 'aprobado', created_at: '2026-03-03T00:00:00Z', expedientes: { created_at: '2026-03-01T00:00:00Z' } },
      // e3: rechazado a las 12 horas.
      { expediente_id: 'e3', estado_nuevo: 'rechazado', created_at: '2026-03-02T12:00:00Z', expedientes: { created_at: '2026-03-02T00:00:00Z' } },
      // e2: condicionado a los 4 días y aprobado después (ponderación).
      { expediente_id: 'e2', estado_nuevo: 'condicionado', created_at: '2026-03-05T00:00:00Z', expedientes: { created_at: '2026-03-01T00:00:00Z' } },
      { expediente_id: 'e2', estado_nuevo: 'aprobado', created_at: '2026-03-06T00:00:00Z', expedientes: { created_at: '2026-03-01T00:00:00Z' } },
    ];

    function mockTablas() {
      let expCall = 0;
      mockFrom.mockImplementation((table: string) => {
        if (table === 'expedientes') {
          expCall++;
          // 1ª: conteo de activos; 2ª: conteo por estado del periodo.
          return expCall === 1
            ? createChain(null, 5)
            : createChain([{ estado: 'cerrado' }, { estado: 'condicionado' }, { estado: 'rechazado' }]);
        }
        if (table === 'eventos_timeline') return createChain(eventos);
        if (table === 'pagos') return createChain([{ monto: 500000 }, { monto: 1000000 }]);
        return createChain([]);
      });
    }

    it('tasa y tiempo salen de la primera y la última decisión, no del estado ni de updated_at', async () => {
      mockTablas();

      const result = await dashboardService.getSummary('2026-03-01', '2026-03-31');

      // Decisión vigente: aprobado, aprobado, rechazado → 2 de 3. El aprobado
      // que terminó 'cerrado' cuenta como aprobado.
      expect(result.tasaAprobacion).toBe(66.67);
      // Primera decisión: 2 días, 4 días y 0,5 días → 2,17.
      expect(result.tiempoPromedioResolucionDias).toBe(2.17);
      expect(result.totalExpedientesActivos).toBe(5);
      expect(result.expedientesPorEstado).toEqual({ cerrado: 1, condicionado: 1, rechazado: 1 });
      expect(result.ingresosDelPeriodo).toBe(1500000);
      expect(mockFrom).toHaveBeenCalledWith('eventos_timeline');
      expect(mockEq).toHaveBeenCalledWith('tipo', 'estado');
    });

    it('"Estudios activos" no cuenta rechazados ni cerrados', async () => {
      mockTablas();

      await dashboardService.getSummary('2026-03-01', '2026-03-31');

      const filtroEstado = mockIn.mock.calls.find(([col]) => col === 'estado');
      expect(filtroEstado?.[1]).toEqual(['borrador', 'en_revision', 'informacion_incompleta', 'condicionado', 'aprobado']);
      expect(mockNeq).not.toHaveBeenCalledWith('estado', 'cerrado');
    });

    it('sin decisiones en el periodo: tasa y tiempo en 0', async () => {
      mockFrom.mockImplementation((table: string) =>
        table === 'expedientes' ? createChain(null, 0) : createChain([]),
      );

      const result = await dashboardService.getSummary('2026-03-01', '2026-03-31');

      expect(result.tasaAprobacion).toBe(0);
      expect(result.tiempoPromedioResolucionDias).toBe(0);
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as reportesService from '../reportes.service';

// ── Mock Supabase ───────────────────────────────────────────

const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockGte = vi.fn();
const mockLte = vi.fn();
const mockIn = vi.fn();

function createChain(finalData: unknown) {
  const chain: Record<string, unknown> = {};
  // order/range: las consultas paginan con fetchAll.
  const methods = { select: mockSelect, eq: mockEq, gte: mockGte, lte: mockLte, in: mockIn, order: vi.fn(), range: vi.fn() };

  for (const [name, fn] of Object.entries(methods)) {
    fn.mockImplementation(() => chain);
    chain[name] = fn;
  }

  chain.then = undefined;

  Object.defineProperty(chain, 'then', {
    value: (resolve: (val: unknown) => void) => {
      resolve({ data: finalData, error: null });
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

describe('Reportes Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getVolumenExpedientes()', () => {
    it('deberia usar rango de 6 meses por defecto si no se envian fechas', async () => {
      let callIndex = 0;
      mockFrom.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          // Creados query
          return createChain([
            { id: '1', estado: 'borrador', created_at: '2026-03-15T10:00:00Z' },
          ]);
        }
        // Cerrados query
        return createChain([]);
      });

      const result = await reportesService.getVolumenExpedientes();

      expect(result).toHaveProperty('meses');
      expect(result).toHaveProperty('total_creados');
      expect(result).toHaveProperty('total_cerrados');
      expect(result).toHaveProperty('total_neto');
      expect(result.meses.length).toBeGreaterThanOrEqual(6);
      expect(mockFrom).toHaveBeenCalledWith('expedientes');
    });

    it('deberia retornar datos agrupados por mes con filtro de fechas', async () => {
      let callIndex = 0;
      mockFrom.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          // Creados query
          return createChain([
            { id: '1', estado: 'borrador', created_at: '2026-01-10T10:00:00Z' },
            { id: '2', estado: 'en_revision', created_at: '2026-01-20T10:00:00Z' },
            { id: '3', estado: 'aprobado', created_at: '2026-02-05T10:00:00Z' },
            { id: '4', estado: 'borrador', created_at: '2026-02-15T10:00:00Z' },
            { id: '5', estado: 'rechazado', created_at: '2026-03-01T10:00:00Z' },
          ]);
        }
        // Cerrados query
        return createChain([
          { id: '3', estado: 'aprobado', updated_at: '2026-02-20T10:00:00Z' },
          { id: '5', estado: 'rechazado', updated_at: '2026-03-10T10:00:00Z' },
        ]);
      });

      const result = await reportesService.getVolumenExpedientes('2026-01-01', '2026-03-31');

      expect(result.meses.length).toBeGreaterThanOrEqual(3);

      // Enero
      const enero = result.meses.find(m => m.periodo === 'Enero 2026');
      const febrero = result.meses.find(m => m.periodo === 'Febrero 2026');
      const marzo = result.meses.find(m => m.periodo === 'Marzo 2026');
      expect(enero).toBeDefined();
      expect(febrero).toBeDefined();
      expect(marzo).toBeDefined();

      expect(enero!.creados).toBe(2);
      expect(enero!.cerrados).toBe(0);
      expect(febrero!.creados).toBe(2);
      expect(febrero!.cerrados).toBe(1);
      expect(marzo!.creados).toBe(1);
      expect(marzo!.cerrados).toBe(1);
      // Totals
      expect(result.total_creados).toBe(5);
      expect(result.total_cerrados).toBe(2);
      expect(result.total_neto).toBe(3);
    });

    it('deberia retornar meses vacios si no hay datos', async () => {
      mockFrom.mockImplementation(() => createChain([]));

      const result = await reportesService.getVolumenExpedientes('2026-01-01', '2026-03-31');

      expect(result.meses.length).toBeGreaterThanOrEqual(3);
      for (const mes of result.meses) {
        expect(mes.creados).toBe(0);
        expect(mes.cerrados).toBe(0);
        expect(mes.neto).toBe(0);
      }
      expect(result.total_creados).toBe(0);
      expect(result.total_cerrados).toBe(0);
      expect(result.total_neto).toBe(0);
    });

    it('deberia aplicar filtro de estado cuando se proporciona', async () => {
      let callIndex = 0;
      mockFrom.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return createChain([
            { id: '1', estado: 'aprobado', created_at: '2026-01-10T10:00:00Z' },
          ]);
        }
        return createChain([
          { id: '1', estado: 'aprobado', updated_at: '2026-01-20T10:00:00Z' },
        ]);
      });

      const result = await reportesService.getVolumenExpedientes(
        '2026-01-01',
        '2026-01-31',
        'aprobado',
      );

      expect(result.total_creados).toBe(1);
      expect(result.total_cerrados).toBe(1);
      // Verify .eq was called for estado filter
      expect(mockEq).toHaveBeenCalledWith('estado', 'aprobado');
    });

    it('"Hasta" incluye el día elegido completo en hora Colombia', async () => {
      mockFrom.mockImplementation(() => createChain([]));

      await reportesService.getVolumenExpedientes('2026-09-23', '2026-09-23');

      expect(mockGte).toHaveBeenCalledWith('created_at', '2026-09-23T00:00:00-05:00');
      expect(mockLte).toHaveBeenCalledWith('created_at', '2026-09-23T23:59:59.999-05:00');
    });

    it('con solo "Desde" no descarta el filtro', async () => {
      mockFrom.mockImplementation(() => createChain([]));

      await reportesService.getVolumenExpedientes('2026-09-01');

      expect(mockGte).toHaveBeenCalledWith('created_at', '2026-09-01T00:00:00-05:00');
    });

    it('agrupa por mes en hora Colombia y no inventa meses en los bordes', async () => {
      let callIndex = 0;
      mockFrom.mockImplementation(() => {
        callIndex++;
        // 30-sep 21:00 en Bogotá = 1-oct 02:00 UTC: es de septiembre.
        return createChain(callIndex === 1 ? [{ id: '1', estado: 'borrador', created_at: '2026-10-01T02:00:00Z' }] : []);
      });

      const result = await reportesService.getVolumenExpedientes('2026-07-01', '2026-09-30');

      expect(result.meses.map((m) => m.periodo)).toEqual(['Julio 2026', 'Agosto 2026', 'Septiembre 2026']);
      expect(result.meses[2].creados).toBe(1);
    });

    it('deberia formatear periodos en espanol', async () => {
      let callIndex = 0;
      mockFrom.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return createChain([
            { id: '1', estado: 'borrador', created_at: '2026-06-15T10:00:00Z' },
            { id: '2', estado: 'borrador', created_at: '2026-12-15T10:00:00Z' },
          ]);
        }
        return createChain([]);
      });

      const result = await reportesService.getVolumenExpedientes('2026-06-01', '2026-12-31');

      const periodos = result.meses.map((m) => m.periodo);
      expect(periodos).toContain('Junio 2026');
      expect(periodos).toContain('Diciembre 2026');
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as service from '../public-properties.service';

// ── Mock Supabase ───────────────────────────────────────────

vi.mock('@/lib/supabase', () => {
  const chain = () => {
    const obj: Record<string, unknown> = {};
    const methods = ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'order', 'range', 'single', 'in'];
    for (const m of methods) {
      obj[m] = vi.fn().mockReturnValue(obj);
    }
    // Default resolution
    obj._resolve = { data: [], error: null, count: 0 };
    Object.defineProperty(obj, 'then', {
      value: (resolve: (val: unknown) => void) => resolve(obj._resolve),
      configurable: true,
      writable: true,
    });
    return obj;
  };

  const mockChain = chain();
  return {
    supabase: {
      from: vi.fn().mockReturnValue(mockChain),
      _chain: mockChain,
    },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { supabase } from '@/lib/supabase';
const mockFrom = supabase.from as ReturnType<typeof vi.fn>;
const mockChain = (supabase as unknown as { _chain: Record<string, unknown> })._chain;

// ── Tests ───────────────────────────────────────────────────

describe('Public Properties Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default resolution
    mockChain._resolve = { data: [], error: null, count: 0 };
    mockFrom.mockReturnValue(mockChain);
  });

  describe('listPublicProperties()', () => {
    it('deberia retornar lista paginada con defaults', async () => {
      mockChain._resolve = {
        data: [
          { id: '1', tipo: 'apartamento', ciudad: 'Medellin', valor_arriendo: 1500000 },
        ],
        error: null,
        count: 1,
      };

      const result = await service.listPublicProperties({
        page: 1,
        limit: 12,
        sortBy: 'created_at',
        sortOrder: 'desc',
      });

      expect(result.data).toHaveLength(1);
      expect(result.pagination).toHaveProperty('total');
      expect(result.pagination).toHaveProperty('page');
      expect(result.pagination).toHaveProperty('limit');
      expect(result.pagination).toHaveProperty('totalPages');
      expect(mockFrom).toHaveBeenCalledWith('inmuebles');
    });

    it('deberia aplicar filtro de ciudad', async () => {
      mockChain._resolve = { data: [], error: null, count: 0 };

      await service.listPublicProperties({
        page: 1, limit: 12, ciudad: 'Medellin',
        sortBy: 'created_at', sortOrder: 'desc',
      });

      expect(mockChain.ilike).toHaveBeenCalledWith('ciudad', 'Medellin');
    });

    it('deberia aplicar filtro de precio', async () => {
      mockChain._resolve = { data: [], error: null, count: 0 };

      await service.listPublicProperties({
        page: 1, limit: 12, precio_min: 500000, precio_max: 2000000,
        sortBy: 'created_at', sortOrder: 'desc',
      });

      expect(mockChain.gte).toHaveBeenCalledWith('valor_arriendo', 500000);
      expect(mockChain.lte).toHaveBeenCalledWith('valor_arriendo', 2000000);
    });

    it('deberia aplicar busqueda de texto', async () => {
      mockChain._resolve = { data: [], error: null, count: 0 };

      await service.listPublicProperties({
        page: 1, limit: 12, search: 'laureles',
        sortBy: 'created_at', sortOrder: 'desc',
      });

      expect(mockChain.or).toHaveBeenCalledWith(
        expect.stringContaining('laureles'),
      );
    });
  });

  describe('getPublicPropertyById()', () => {
    it('deberia lanzar 404 si inmueble no existe', async () => {
      mockChain._resolve = { data: null, error: { code: 'PGRST116', message: 'not found' } };

      await expect(
        service.getPublicPropertyById('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow('no encontrado');
    });
  });

  describe('getPublicPropertyFilters()', () => {
    it('deberia retornar valores unicos', async () => {
      mockChain._resolve = {
        data: [
          { ciudad: 'Medellin', tipo: 'apartamento', estrato: 4 },
          { ciudad: 'Medellin', tipo: 'casa', estrato: 3 },
          { ciudad: 'Bogota', tipo: 'apartamento', estrato: 4 },
        ],
        error: null,
      };

      const filters = await service.getPublicPropertyFilters();

      expect(filters.ciudades).toContain('Medellin');
      expect(filters.ciudades).toContain('Bogota');
      expect(filters.tipos).toContain('apartamento');
      expect(filters.tipos).toContain('casa');
      expect(filters.estratos).toContain(3);
      expect(filters.estratos).toContain(4);
    });

    it('deberia retornar arrays vacios si no hay datos', async () => {
      mockChain._resolve = { data: [], error: null };

      const filters = await service.getPublicPropertyFilters();

      expect(filters.ciudades).toEqual([]);
      expect(filters.tipos).toEqual([]);
      expect(filters.estratos).toEqual([]);
    });
  });
});

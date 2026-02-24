import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@/types/auth';

// Mock supabase antes de importar el service
const mockSingle = vi.fn();
const mockLimit = vi.fn(() => ({ single: mockSingle }));
const mockOrder = vi.fn(() => ({ limit: mockLimit }));
const mockGt = vi.fn(() => ({ single: mockSingle }));
const mockEq: ReturnType<typeof vi.fn> = vi.fn((): Record<string, unknown> => ({
  eq: mockEq,
  single: mockSingle,
  order: mockOrder,
  gt: mockGt,
}));
const mockSelect = vi.fn((_cols?: string, _opts?: Record<string, unknown>) => ({
  eq: mockEq,
}));
const mockFrom = vi.fn((_table?: string) => ({
  select: mockSelect,
}));
const mockRpc = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    rpc: (fn: string, params: Record<string, unknown>) => mockRpc(fn, params),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock getExpedienteById from expedientes.service
const mockGetExpedienteById = vi.fn();
vi.mock('../expedientes.service', () => ({
  getExpedienteById: (...args: unknown[]) => mockGetExpedienteById(...args),
}));

import {
  executeTransition,
  getTransitionsForExpediente,
  getTransitionHistory,
} from '../expediente-workflow.service';

// Helpers
const adminUser: AuthUser = { id: 'admin-uuid', email: 'admin@test.com', rol: 'administrador', activo: true };
const analistaUser: AuthUser = { id: 'analista-uuid', email: 'analista@test.com', rol: 'operador_analista', activo: true };
const otherUser: AuthUser = { id: 'other-uuid', email: 'other@test.com', rol: 'operador_analista', activo: true };

const mockExpediente = {
  id: 'exp-uuid',
  numero: 'EXP-2026-0001',
  estado: 'borrador' as const,
  analista_id: 'analista-uuid',
};

const mockFullExpediente = {
  id: 'exp-uuid',
  numero: 'EXP-2026-0001',
  estado: 'en_revision',
  analista_id: 'analista-uuid',
  propiedad: { id: 'prop-uuid', direccion: 'Calle 1' },
  solicitante: { id: 'sol-uuid', nombre: 'Juan' },
};

function setupFetchExpediente(expediente: Record<string, unknown> | null) {
  mockFrom.mockReturnValueOnce({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: expediente, error: null }),
      }),
    }),
  });
}

function setupPreconditionCount(count: number | null, error: Record<string, unknown> | null = null) {
  mockFrom.mockReturnValueOnce({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue(Object.assign(
        Promise.resolve({ count, error }),
        { eq: vi.fn().mockReturnValue(Promise.resolve({ count, error })) },
      )),
    }),
  });
}

describe('expediente-workflow.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExpedienteById.mockResolvedValue(mockFullExpediente);
  });

  // ================================================================
  // executeTransition - transicion invalida
  // ================================================================
  describe('executeTransition - transicion invalida', () => {
    it('debe retornar error INVALID_TRANSITION con transiciones validas', async () => {
      setupFetchExpediente(mockExpediente);

      await expect(
        executeTransition('exp-uuid', { nuevo_estado: 'aprobado', comentario: 'Test' }, adminUser),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'INVALID_TRANSITION',
      });
    });
  });

  // ================================================================
  // executeTransition - permisos
  // ================================================================
  describe('executeTransition - permisos', () => {
    it('debe retornar 403 si el usuario no es analista asignado ni admin', async () => {
      setupFetchExpediente(mockExpediente);

      await expect(
        executeTransition('exp-uuid', { nuevo_estado: 'en_revision', comentario: 'Test' }, otherUser),
      ).rejects.toMatchObject({
        statusCode: 403,
        errorCode: 'FORBIDDEN',
      });
    });

    it('debe permitir al administrador transicionar cualquier expediente', async () => {
      setupFetchExpediente(mockExpediente);
      setupPreconditionCount(3); // DOCUMENTOS_EXISTENTES
      mockRpc.mockResolvedValueOnce({
        data: {
          expediente_id: 'exp-uuid',
          estado_anterior: 'borrador',
          estado_nuevo: 'en_revision',
          evento_timeline_id: 'evt-uuid',
          updated_at: '2026-02-24T10:00:00Z',
        },
        error: null,
      });

      const result = await executeTransition(
        'exp-uuid',
        { nuevo_estado: 'en_revision', comentario: 'Listo para revision' },
        adminUser,
      );

      expect(result.estado_anterior).toBe('borrador');
      expect(mockRpc).toHaveBeenCalledWith(
        'transicionar_expediente',
        expect.objectContaining({
          p_expediente_id: 'exp-uuid',
          p_nuevo_estado: 'en_revision',
          p_usuario_id: 'admin-uuid',
          p_comentario: 'Listo para revision',
        }),
      );
    });

    it('debe permitir al analista asignado transicionar', async () => {
      setupFetchExpediente(mockExpediente);
      setupPreconditionCount(1);
      mockRpc.mockResolvedValueOnce({
        data: {
          expediente_id: 'exp-uuid',
          estado_anterior: 'borrador',
          estado_nuevo: 'en_revision',
          evento_timeline_id: 'evt-uuid',
          updated_at: '2026-02-24T10:00:00Z',
        },
        error: null,
      });

      const result = await executeTransition(
        'exp-uuid',
        { nuevo_estado: 'en_revision', comentario: 'Revisando' },
        analistaUser,
      );

      expect(result.estado_anterior).toBe('borrador');
    });
  });

  // ================================================================
  // executeTransition - precondiciones
  // ================================================================
  describe('executeTransition - precondiciones', () => {
    it('debe fallar si no hay analista asignado (PRECONDITION_FAILED)', async () => {
      const expSinAnalista = { ...mockExpediente, analista_id: null };
      setupFetchExpediente(expSinAnalista);

      await expect(
        executeTransition('exp-uuid', { nuevo_estado: 'en_revision', comentario: 'Test' }, adminUser),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'PRECONDITION_FAILED',
        details: { precondition: 'ANALISTA_ASIGNADO' },
      });
    });

    it('debe fallar si no hay documentos', async () => {
      setupFetchExpediente(mockExpediente);
      setupPreconditionCount(0);

      await expect(
        executeTransition('exp-uuid', { nuevo_estado: 'en_revision', comentario: 'Test' }, adminUser),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'PRECONDITION_FAILED',
        details: { precondition: 'DOCUMENTOS_EXISTENTES' },
      });
    });
  });

  // ================================================================
  // executeTransition - exito (retorna expediente completo)
  // ================================================================
  describe('executeTransition - exito', () => {
    it('debe retornar expediente actualizado con estado_anterior y evento_timeline_id', async () => {
      setupFetchExpediente(mockExpediente);
      setupPreconditionCount(2); // documentos
      mockRpc.mockResolvedValueOnce({
        data: {
          expediente_id: 'exp-uuid',
          estado_anterior: 'borrador',
          estado_nuevo: 'en_revision',
          evento_timeline_id: 'evt-uuid',
          updated_at: '2026-02-24T10:00:00Z',
        },
        error: null,
      });

      const result = await executeTransition(
        'exp-uuid',
        { nuevo_estado: 'en_revision', comentario: 'Listo', motivo: 'Revision inicial' },
        adminUser,
      );

      // Debe incluir datos del expediente completo + estado_anterior + evento_timeline_id
      expect(result.estado_anterior).toBe('borrador');
      expect(result.evento_timeline_id).toBe('evt-uuid');
      expect(result.id).toBe('exp-uuid');
      expect(mockGetExpedienteById).toHaveBeenCalledWith('exp-uuid');
    });

    it('debe pasar comentario al RPC', async () => {
      setupFetchExpediente(mockExpediente);
      setupPreconditionCount(2);
      mockRpc.mockResolvedValueOnce({
        data: {
          expediente_id: 'exp-uuid',
          estado_anterior: 'borrador',
          estado_nuevo: 'en_revision',
          evento_timeline_id: 'evt-uuid',
          updated_at: '2026-02-24T10:00:00Z',
        },
        error: null,
      });

      await executeTransition(
        'exp-uuid',
        { nuevo_estado: 'en_revision', comentario: 'Mi comentario' },
        adminUser,
      );

      expect(mockRpc).toHaveBeenCalledWith(
        'transicionar_expediente',
        expect.objectContaining({
          p_comentario: 'Mi comentario',
        }),
      );
    });
  });

  // ================================================================
  // executeTransition - expediente no encontrado
  // ================================================================
  describe('executeTransition - expediente no encontrado', () => {
    it('debe retornar 404 si el expediente no existe', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
          }),
        }),
      });

      await expect(
        executeTransition('no-existe', { nuevo_estado: 'en_revision', comentario: 'Test' }, adminUser),
      ).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
      });
    });
  });

  // ================================================================
  // getTransitionsForExpediente - retorna { estado, label }[]
  // ================================================================
  describe('getTransitionsForExpediente', () => {
    it('debe retornar transiciones disponibles con labels desde borrador', async () => {
      setupFetchExpediente(mockExpediente);

      const result = await getTransitionsForExpediente('exp-uuid');

      expect(result).toEqual({
        expediente_id: 'exp-uuid',
        estado_actual: 'borrador',
        transiciones_disponibles: [
          { estado: 'en_revision', label: 'Enviar a revision' },
        ],
      });
    });

    it('debe retornar 4 transiciones con labels desde en_revision', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'en_revision' });

      const result = await getTransitionsForExpediente('exp-uuid');

      expect(result.transiciones_disponibles).toHaveLength(4);
      for (const t of result.transiciones_disponibles) {
        expect(t).toHaveProperty('estado');
        expect(t).toHaveProperty('label');
        expect(t.label.length).toBeGreaterThan(0);
      }
    });

    it('no requiere permisos de analista (cualquier usuario autenticado)', async () => {
      setupFetchExpediente(mockExpediente);

      // Should not throw - no user parameter needed
      const result = await getTransitionsForExpediente('exp-uuid');
      expect(result.estado_actual).toBe('borrador');
    });
  });

  // ================================================================
  // getTransitionHistory
  // ================================================================
  describe('getTransitionHistory', () => {
    it('debe retornar historial de transiciones', async () => {
      // fetchExpediente
      setupFetchExpediente(mockExpediente);

      // Query eventos_timeline
      const mockHistorial = [
        {
          id: 'evt-1',
          estado_anterior: 'borrador',
          estado_nuevo: 'en_revision',
          comentario: 'Enviado a revision',
          descripcion: "Estado cambiado de 'borrador' a 'en_revision'",
          created_at: '2026-02-24T10:00:00Z',
          usuario: { id: 'admin-uuid', nombre: 'Admin', apellido: 'User' },
        },
      ];

      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: mockHistorial, error: null }),
            }),
          }),
        }),
      });

      const result = await getTransitionHistory('exp-uuid');

      expect(result).toEqual({
        expediente_id: 'exp-uuid',
        estado_actual: 'borrador',
        historial: mockHistorial,
      });
    });

    it('debe retornar 404 si el expediente no existe', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
          }),
        }),
      });

      await expect(
        getTransitionHistory('no-existe'),
      ).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
      });
    });

    it('debe retornar 500 si hay error en la query', async () => {
      setupFetchExpediente(mockExpediente);

      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
            }),
          }),
        }),
      });

      await expect(
        getTransitionHistory('exp-uuid'),
      ).rejects.toMatchObject({
        statusCode: 500,
        errorCode: 'INTERNAL_ERROR',
      });
    });
  });
});

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

import { executeTransition, getTransitionsForExpediente } from '../expediente-workflow.service';

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
  const resolvedValue = Promise.resolve({ count, error });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eqFn: any = vi.fn(() => ({
    eq: eqFn,
    then: resolvedValue.then.bind(resolvedValue),
  }));
  // Make the eq result thenable so await works on it
  Object.assign(eqFn(), { then: resolvedValue.then.bind(resolvedValue) });

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
  });

  // AC #6: Transiciones invalidas retornan 400 INVALID_TRANSITION
  describe('executeTransition - transicion invalida', () => {
    it('debe retornar error INVALID_TRANSITION con transiciones validas', async () => {
      setupFetchExpediente(mockExpediente);

      await expect(
        executeTransition('exp-uuid', { nuevo_estado: 'aprobado' }, adminUser),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'INVALID_TRANSITION',
        details: {
          estado_actual: 'borrador',
          transiciones_validas: ['en_revision'],
        },
      });
    });
  });

  // AC #8: Usuario sin permisos recibe 403 FORBIDDEN
  describe('executeTransition - permisos', () => {
    it('debe retornar 403 si el usuario no es analista asignado ni admin', async () => {
      setupFetchExpediente(mockExpediente);

      await expect(
        executeTransition('exp-uuid', { nuevo_estado: 'en_revision' }, otherUser),
      ).rejects.toMatchObject({
        statusCode: 403,
        errorCode: 'FORBIDDEN',
      });
    });

    it('debe permitir al administrador transicionar cualquier expediente', async () => {
      // Fetch expediente
      setupFetchExpediente(mockExpediente);
      // Precondition: ANALISTA_ASIGNADO (pasa porque analista_id existe)
      // Precondition: DOCUMENTOS_EXISTENTES
      setupPreconditionCount(3);
      // RPC call
      mockRpc.mockResolvedValueOnce({
        data: {
          expediente_id: 'exp-uuid',
          estado_anterior: 'borrador',
          estado_nuevo: 'en_revision',
          evento_timeline_id: 'evt-uuid',
          updated_at: '2026-02-17T10:00:00Z',
        },
        error: null,
      });

      const result = await executeTransition(
        'exp-uuid',
        { nuevo_estado: 'en_revision' },
        adminUser,
      );

      expect(result.estado_nuevo).toBe('en_revision');
      expect(mockRpc).toHaveBeenCalledWith(
        'transicionar_expediente',
        expect.objectContaining({
          p_expediente_id: 'exp-uuid',
          p_nuevo_estado: 'en_revision',
          p_usuario_id: 'admin-uuid',
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
          updated_at: '2026-02-17T10:00:00Z',
        },
        error: null,
      });

      const result = await executeTransition(
        'exp-uuid',
        { nuevo_estado: 'en_revision' },
        analistaUser,
      );

      expect(result.estado_nuevo).toBe('en_revision');
    });
  });

  // AC #9: borrador -> en_revision falla sin analista asignado
  describe('executeTransition - precondiciones', () => {
    it('debe fallar si no hay analista asignado (PRECONDITION_FAILED)', async () => {
      const expSinAnalista = { ...mockExpediente, analista_id: null };
      setupFetchExpediente(expSinAnalista);

      await expect(
        executeTransition('exp-uuid', { nuevo_estado: 'en_revision' }, adminUser),
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
        executeTransition('exp-uuid', { nuevo_estado: 'en_revision' }, adminUser),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'PRECONDITION_FAILED',
        details: { precondition: 'DOCUMENTOS_EXISTENTES' },
      });
    });
  });

  // AC #5: PATCH cambia el estado correctamente
  describe('executeTransition - exito', () => {
    it('debe retornar resultado exitoso con estado anterior y nuevo', async () => {
      setupFetchExpediente(mockExpediente);
      setupPreconditionCount(2); // documentos
      mockRpc.mockResolvedValueOnce({
        data: {
          expediente_id: 'exp-uuid',
          estado_anterior: 'borrador',
          estado_nuevo: 'en_revision',
          evento_timeline_id: 'evt-uuid',
          updated_at: '2026-02-17T10:00:00Z',
        },
        error: null,
      });

      const result = await executeTransition(
        'exp-uuid',
        { nuevo_estado: 'en_revision', motivo: 'Listo para revision' },
        adminUser,
      );

      expect(result).toEqual({
        expediente_id: 'exp-uuid',
        numero: 'EXP-2026-0001',
        estado_anterior: 'borrador',
        estado_nuevo: 'en_revision',
        evento_timeline_id: 'evt-uuid',
        updated_at: '2026-02-17T10:00:00Z',
      });
    });
  });

  // Expediente no encontrado
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
        executeTransition('no-existe', { nuevo_estado: 'en_revision' }, adminUser),
      ).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
      });
    });
  });

  // AC #12: GET retorna transiciones disponibles
  describe('getTransitionsForExpediente', () => {
    it('debe retornar transiciones disponibles desde borrador', async () => {
      setupFetchExpediente(mockExpediente);

      const result = await getTransitionsForExpediente('exp-uuid', adminUser);

      expect(result).toEqual({
        expediente_id: 'exp-uuid',
        estado_actual: 'borrador',
        transiciones_disponibles: ['en_revision'],
      });
    });

    it('debe retornar 4 transiciones desde en_revision', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'en_revision' });

      const result = await getTransitionsForExpediente('exp-uuid', analistaUser);

      expect(result.transiciones_disponibles).toHaveLength(4);
    });

    it('debe retornar 403 si usuario no tiene permisos', async () => {
      setupFetchExpediente(mockExpediente);

      await expect(
        getTransitionsForExpediente('exp-uuid', otherUser),
      ).rejects.toMatchObject({
        statusCode: 403,
        errorCode: 'FORBIDDEN',
      });
    });
  });
});

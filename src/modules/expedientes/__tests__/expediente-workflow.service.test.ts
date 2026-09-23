import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@/types/auth';

// Mock supabase antes de importar el service
const mockSingle = vi.fn();
const mockLimit = vi.fn(() => ({ single: mockSingle }));
const mockOrder = vi.fn(() => ({ limit: mockLimit }));
const mockGt = vi.fn(() => ({ single: mockSingle }));
// `not → in → limit`: la consulta de fianza V3 (tieneFianzaV3); por defecto, sin contratos V3.
const mockFianzaV3 = vi.fn(async () => ({ data: [] as unknown[], error: null }));
const filtrosFianza: unknown[][] = [];
// `in → limit`: ¿contrato firmado? (tieneContratoFirmado); por defecto, ninguno.
const mockContratoFirmado = vi.fn(async () => ({ data: [] as unknown[], error: null }));
const mockEq: ReturnType<typeof vi.fn> = vi.fn((): Record<string, unknown> => ({
  eq: mockEq,
  single: mockSingle,
  order: mockOrder,
  gt: mockGt,
  in: () => ({ limit: mockContratoFirmado }),
  not: (...a: unknown[]) => {
    filtrosFianza.push(['not', ...a]);
    return {
      in: (...b: unknown[]) => {
        filtrosFianza.push(['in', ...b]);
        return { limit: mockFianzaV3 };
      },
    };
  },
}));
const mockSelect = vi.fn((_cols?: string, _opts?: Record<string, unknown>) => ({
  eq: mockEq,
}));
const fromPorDefecto = (_table?: string): Record<string, unknown> => ({ select: mockSelect });
const mockFrom = vi.fn(fromPorDefecto);
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

// El guard de tenant (assertExpedienteAccess) no es lo que se prueba aquí:
// para el dueño consultaría Supabase. Se deja pasar; el resto, real.
vi.mock('@/lib/tenantScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenantScope')>()),
  assertExpedienteAccess: vi.fn().mockResolvedValue(undefined),
}));

// Mock getExpedienteById from expedientes.service
const mockGetExpedienteById = vi.fn();
vi.mock('../expedientes.service', () => ({
  getExpedienteById: (...args: unknown[]) => mockGetExpedienteById(...args),
}));

// Adenda 2 §4.3: aprobar una revision manual recalcula el puntaje (habilitacion).
const mockRatificar = vi.fn();
const mockAprobarCondicionado = vi.fn();
const mockAvisarDueno = vi.fn(async (..._a: unknown[]) => undefined);
const mockAvisarSolicitante = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../expediente-habilitacion.service', () => ({
  ratificarRevisionManual: (...args: unknown[]) => mockRatificar(...args),
  aprobarCondicionado: (...args: unknown[]) => mockAprobarCondicionado(...args),
  avisarDuenoDecisionRevisionManual: (...args: unknown[]) => mockAvisarDueno(...args),
  avisarSolicitanteDecision: (...args: unknown[]) => mockAvisarSolicitante(...args),
}));
vi.mock('@/modules/coarrendatarios/coarrendatarios.service', () => ({
  avisarCoarrendatarioDecision: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auditLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auditLog')>()),
  logAudit: vi.fn(),
}));

import {
  executeTransition,
  getTransitionsForExpediente,
  getTransitionHistory,
} from '../expediente-workflow.service';

// Helpers
const adminUser: AuthUser = { id: 'admin-uuid', email: 'admin@test.com', rol: 'administrador', activo: true };
const analistaUser: AuthUser = { id: 'analista-uuid', email: 'analista@test.com', rol: 'operador_analista', activo: true };
// gerencia_consulta: ni admin/operador (que transicionan cualquier expediente),
// ni analista asignado, ni dueño del inmueble -> FORBIDDEN.
const otherUser: AuthUser = { id: 'other-uuid', email: 'other@test.com', rol: 'gerencia_consulta', activo: true };

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
    mockFrom.mockImplementation(fromPorDefecto);
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
  // Adenda 2 §4.3 — aprobar una revision manual por "Cambiar estado"
  // ================================================================
  describe('executeTransition - revision manual (resolver un condicionado)', () => {
    const evaluacion = { estabilidad_laboral: 'empleado_mas_12m', arrendamiento_previo: 'sin_historial' } as const;

    it('sin V7/V9 del analista no se aprueba: 400 antes de mover el estado', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'condicionado' });

      await expect(
        executeTransition('exp-uuid', { nuevo_estado: 'aprobado', comentario: 'Soportes revisados' }, adminUser),
      ).rejects.toMatchObject({ statusCode: 400, errorCode: 'EVALUACION_REQUERIDA' });
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('con V7/V9: va por el mismo camino que la card (avisos al titular incluidos), no por la RPC', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'condicionado' });
      const recalculo = { puntaje_normalizado: 90.1, denominador: 111 };
      mockAprobarCondicionado.mockResolvedValueOnce({ puntaje_revision_manual: recalculo });

      const r = await executeTransition(
        'exp-uuid',
        { nuevo_estado: 'aprobado', comentario: 'Soportes revisados', evaluacion, documentos_consultados: ['PILA'] },
        adminUser,
      );

      expect(mockAprobarCondicionado).toHaveBeenCalledWith('exp-uuid', 'admin-uuid', 'administrador', undefined, {
        fundamento: 'Soportes revisados',
        documentos_consultados: ['PILA'],
        evaluacion,
      });
      expect(mockRpc).not.toHaveBeenCalled();
      expect(r.puntaje_revision_manual).toBe(recalculo);
    });

    const conTimeline = () => {
      const mockUpdate = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
      mockFrom.mockImplementation((t?: string) =>
        t === 'eventos_timeline' || t === 'expedientes' ? { update: mockUpdate } : fromPorDefecto(t),
      );
      mockRpc.mockResolvedValueOnce({
        data: { expediente_id: 'exp-uuid', estado_anterior: 'condicionado', evento_timeline_id: 'evt-uuid', updated_at: '2026-09-23T10:00:00Z' },
        error: null,
      });
    };

    it('rechazar: se le avisa al prospecto (con la apelación) y al dueño', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'condicionado' });
      conTimeline();
      await executeTransition('exp-uuid', { nuevo_estado: 'rechazado', comentario: 'Ingresos no soportados' }, adminUser);
      await vi.waitFor(() => expect(mockAvisarSolicitante).toHaveBeenCalledWith('exp-uuid', 'rechazado'));
      expect(mockAvisarDueno).toHaveBeenCalledWith('exp-uuid', 'rechazado');
    });

    it('cancelar: se le avisa al dueño (la guía del condicionado se lo promete)', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'condicionado' });
      conTimeline();
      await executeTransition(
        'exp-uuid',
        { nuevo_estado: 'cerrado', comentario: 'El prospecto desistió', etiqueta: 'Cancelar estudio' } as never,
        adminUser,
      );
      await vi.waitFor(() => expect(mockAvisarDueno).toHaveBeenCalledWith('exp-uuid', 'cancelado'));
      expect(mockAvisarSolicitante).not.toHaveBeenCalled();
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
  // V3 §12.2: cancelar con fianza y cerrar sin acta
  // ================================================================
  describe('cierre con contrato V3', () => {
    const cierre = (etiqueta: string) => ({ nuevo_estado: 'cerrado', comentario: 'Cierre del estudio de prueba', etiqueta }) as never;

    it('"Cancelar estudio" con una fianza V3 activa o terminada → 409 sin llamar a la RPC', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'aprobado' });
      mockFianzaV3.mockResolvedValueOnce({ data: [{ id: 'c1' }], error: null });
      filtrosFianza.length = 0;
      await expect(executeTransition('exp-uuid', cierre('Cancelar estudio'), adminUser)).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'ESTUDIO_CON_FIANZA',
      });
      expect(mockRpc).not.toHaveBeenCalled();
      // Solo cuentan los V3 con la fianza activa o terminada.
      expect(filtrosFianza).toEqual([['not', 'destinacion', 'is', null], ['in', 'estado', ['vigente', 'finalizado']]]);
    });

    it('con el contrato V3 en firma el trigger rechaza el cierre y se responde 409 CONTRATO_EN_FIRMA', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'aprobado' });
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'CONTRATO_EN_FIRMA: el contrato del estudio esta en firma…' } });
      await expect(executeTransition('exp-uuid', cierre('Cerrar estudio'), adminUser)).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'CONTRATO_EN_FIRMA',
      });
    });

    it('"Cerrar estudio" sin acta: el trigger de la BD rechaza y se responde 409 con el motivo', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'aprobado' });
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'ACTA_ENTREGA_REQUERIDA: el contrato del estudio tiene la fianza activa…' } });
      await expect(executeTransition('exp-uuid', cierre('Cerrar estudio'), adminUser)).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'ACTA_ENTREGA_REQUERIDA',
      });
    });
  });

  // ================================================================
  // «Cerrar estudio» desde aprobado sin contrato firmado
  // ================================================================
  describe('cerrar un aprobado', () => {
    const cerrar = { nuevo_estado: 'cerrado', comentario: 'El candidato desistió del arriendo', etiqueta: 'Cerrar estudio' } as never;
    const conUpdate = () => {
      const mockUpdate = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
      mockFrom.mockImplementation((t?: string) => (t === 'expedientes' ? { update: mockUpdate } : fromPorDefecto(t)));
      mockRpc.mockResolvedValueOnce({
        data: { expediente_id: 'exp-uuid', estado_anterior: 'aprobado', evento_timeline_id: 'evt-uuid', updated_at: '2026-09-23T10:00:00Z' },
        error: null,
      });
      return mockUpdate;
    };

    it('sin contrato firmado queda como cancelación, no como cierre exitoso', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'aprobado' });
      const mockUpdate = conUpdate();
      await executeTransition('exp-uuid', cerrar, adminUser);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ cancelado_at: expect.any(String), estado_pre_cancelacion: 'aprobado' }),
      );
    });

    it('con el contrato firmado es el cierre natural (sin marca de cancelación)', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'aprobado' });
      mockContratoFirmado.mockResolvedValueOnce({ data: [{ id: 'c1' }], error: null });
      const mockUpdate = conUpdate();
      await executeTransition('exp-uuid', cerrar, adminUser);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('sin contrato firmado no se ofrece «Cerrar estudio», solo «Cancelar estudio»', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'aprobado' });
      const r = await getTransitionsForExpediente('exp-uuid', 'admin-uuid', 'administrador');
      expect(r.transiciones_disponibles).toEqual([{ estado: 'cerrado', label: 'Cancelar estudio' }]);
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
          { estado: 'cerrado', label: 'Cancelar estudio' },
        ],
      });
    });

    it('Adenda 2 §5: el dueño no puede cerrar un condicionado (revisión manual de Cofianza)', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'condicionado' });
      const dueno = await getTransitionsForExpediente('exp-uuid', 'prop-uuid', 'propietario');
      expect(dueno.transiciones_disponibles).toEqual([]);

      setupFetchExpediente({ ...mockExpediente, estado: 'condicionado' });
      const admin = await getTransitionsForExpediente('exp-uuid', 'admin-uuid', 'administrador');
      expect(admin.transiciones_disponibles.map((t) => t.estado)).toEqual(
        expect.arrayContaining(['aprobado', 'rechazado', 'cerrado']),
      );

      // Un aprobado sí lo puede cerrar el dueño (no es revisión manual). Desde
      // aprobado hay dos salidas a 'cerrado' (cierre y cancelación).
      setupFetchExpediente({ ...mockExpediente, estado: 'aprobado' });
      const duenoAprobado = await getTransitionsForExpediente('exp-uuid', 'prop-uuid', 'propietario');
      const destinos = duenoAprobado.transiciones_disponibles.map((t) => t.estado);
      expect(destinos.length).toBeGreaterThan(0);
      expect(new Set(destinos)).toEqual(new Set(['cerrado']));
    });

    it('V3 §12.2: con una fianza activa o terminada no se ofrece "Cancelar estudio" (sí "Cerrar estudio")', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'aprobado' });
      mockFianzaV3.mockResolvedValueOnce({ data: [{ id: 'c1' }], error: null });
      mockContratoFirmado.mockResolvedValueOnce({ data: [{ id: 'c1' }], error: null });
      const r = await getTransitionsForExpediente('exp-uuid', 'admin-uuid', 'administrador');
      const labels = r.transiciones_disponibles.map((t) => t.label);
      expect(labels).toContain('Cerrar estudio');
      expect(labels).not.toContain('Cancelar estudio');
    });

    it('Gerencia (solo lectura) no recibe transiciones: el POST se las rechazaria', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'en_revision' });

      const result = await getTransitionsForExpediente('exp-uuid', 'gerencia-uuid', 'gerencia_consulta');

      expect(result.transiciones_disponibles).toEqual([]);
    });

    it('debe retornar 5 transiciones con labels desde en_revision', async () => {
      setupFetchExpediente({ ...mockExpediente, estado: 'en_revision' });

      const result = await getTransitionsForExpediente('exp-uuid');

      expect(result.transiciones_disponibles).toHaveLength(5);
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

    it('al titular no le cuenta el resultado ni las reglas duras de su co-arrendatario', async () => {
      setupFetchExpediente(mockExpediente);
      const fila = (origen: string | null, descripcion: string) => ({
        id: `evt-${origen}`,
        estado_anterior: 'condicionado',
        estado_nuevo: 'rechazado',
        comentario: null,
        descripcion,
        created_at: '2026-09-23T10:00:00Z',
        metadata: origen ? { origen } : null,
        usuario: null,
      });
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [
                  fila('ponderacion_coarrendatario', 'Titular condicionado + coarrendatario rechazado. Regla dura del co-arrendatario (listas restrictivas)'),
                  fila(null, 'Cambio manual'),
                ],
                error: null,
              }),
            }),
          }),
        }),
      });

      const r = await getTransitionHistory('exp-uuid', 'titular', 'solicitante');

      expect(r.historial[0].descripcion).toBe('Resultado combinado con el co-arrendatario: rechazado.');
      expect(r.historial[1].descripcion).toBe('Cambio manual');
      expect(JSON.stringify(r.historial)).not.toContain('listas restrictivas');
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

/**
 * Política §15, última fila (thin-file): sin historia en ninguna central, el
 * analista no aprueba sin (i) una fuente de capacidad verificable, (ii) un
 * co-arrendatario con puntaje >= UMBRAL_COARRENDATARIO y (iii) canon/ingreso <= 30 %.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTitular, mockCoa, mockSombra, ops } = vi.hoisted(() => ({
  mockTitular: { value: null as unknown },
  mockCoa: vi.fn(),
  mockSombra: vi.fn(),
  ops: [] as Array<{ table: string; method: string }>,
}));

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'insert', 'eq', 'neq', 'order', 'limit']) {
      chain[m] = () => {
        ops.push({ table, method: m });
        return chain;
      };
    }
    chain.maybeSingle = async () => ({ data: table === 'estudios' ? mockTitular.value : null, error: null });
    // El UPDATE condicionado -> aprobado responde 0 filas: basta para saber que el gate dejó pasar.
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return chain;
  };
  return { supabase: { from: (t: string) => chainFor(t) } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config/env', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({ UMBRAL_COARRENDATARIO: 80 })) }));
vi.mock('../expediente-habilitacion.permissions', () => ({
  assertHabilitacionPermission: vi.fn(async () => ({ estado: 'condicionado', expedienteId: 'exp-1', numero: 'EXP-1' })),
}));
vi.mock('../../orchestrator/orchestrator.emails', () => ({
  sendEstudioHabilitadoEmail: vi.fn(),
  sendEstudioNoHabilitadoEmail: vi.fn(),
  sendEstudioAprobadoEmail: vi.fn(),
  sendEstudioRechazadoEmail: vi.fn(),
}));
vi.mock('../../estudios/estudios-simultaneos.guard', () => ({ errorNoAdmision: vi.fn() }));
vi.mock('../../estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn() }));
vi.mock('../../pago-estudio/pago-estudio.service', () => ({ enviarLinkPago: vi.fn() }));
vi.mock('../../notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn(), findPerfilIdByEmail: vi.fn() }));
vi.mock('../../estudios/coarrendatario-vinculado', () => ({ coarrendatarioVinculadoVerificado: mockCoa }));
vi.mock('../../estudios/certificado.service', () => ({ leerSombraDelEstudio: mockSombra }));

import { aprobarCondicionado } from '../expediente-habilitacion.service';

const REVISION = {
  fundamento: 'Revisé los soportes del solicitante',
  documentos_consultados: [],
  evaluacion: { estabilidad_laboral: 'indefinido_2', arrendamiento_previo: 'sin_historial' },
} as never;
const aprobar = (extra: Record<string, unknown> = {}) =>
  aprobarCondicionado('exp-1', 'analista-1', 'operador_analista', undefined, { ...(REVISION as object), ...extra } as never);
const SIN_SCORE = { id: 'est-1', score: null, cascada: { score_secundaria: null, centrales_consultadas: ['datacredito'] } };
const COA_85 = { id: 'coa-1', nombre: 'Luis', estudioId: 'est-coa', puntaje: 85 };
/** Pasó el gate: llegó al UPDATE, que aquí devuelve 0 filas (409). */
const PASO = { errorCode: 'EXPEDIENTE_ESTADO_CAMBIADO' };

describe('aprobarCondicionado — thin-file (Política §15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ops.length = 0;
  });

  it('con score de alguna central no aplica', async () => {
    mockTitular.value = { ...SIN_SCORE, score: 640 };
    await expect(aprobar()).rejects.toMatchObject(PASO);
    expect(mockCoa).not.toHaveBeenCalled();
  });

  it('ninguna central respondió (§14) no es thin-file', async () => {
    mockTitular.value = { ...SIN_SCORE, cascada: { centrales_consultadas: [] } };
    await expect(aprobar()).rejects.toMatchObject(PASO);
  });

  it('sin co-arrendatario, o por debajo del umbral: no se aprueba ni se escribe nada', async () => {
    mockTitular.value = SIN_SCORE;
    for (const coa of [null, { ...COA_85, puntaje: 75 }, { ...COA_85, puntaje: null }]) {
      mockCoa.mockResolvedValueOnce(coa);
      mockSombra.mockResolvedValueOnce({ canonIngresoPct: 20 });
      await expect(aprobar({ fuente_capacidad_verificada: true })).rejects.toMatchObject({ errorCode: 'THIN_FILE_COARRENDATARIO_REQUERIDO' });
    }
    expect(ops.some((o) => o.method === 'update')).toBe(false);
  });

  it('canon/ingreso sobre el 30 %: no', async () => {
    mockTitular.value = SIN_SCORE;
    mockCoa.mockResolvedValueOnce(COA_85);
    mockSombra.mockResolvedValueOnce({ canonIngresoPct: 31.2 });
    await expect(aprobar()).rejects.toMatchObject({ errorCode: 'THIN_FILE_CANON_INGRESO' });
  });

  it('con ingreso y canon/ingreso <= 30 % pasa sin la casilla', async () => {
    mockTitular.value = SIN_SCORE;
    mockCoa.mockResolvedValueOnce(COA_85);
    mockSombra.mockResolvedValueOnce({ canonIngresoPct: 30 });
    await expect(aprobar()).rejects.toMatchObject(PASO);
  });

  it('sin ingreso exige la casilla de fuente de capacidad verificada', async () => {
    mockTitular.value = SIN_SCORE;
    mockCoa.mockResolvedValue(COA_85);
    mockSombra.mockResolvedValue({ canonIngresoPct: null });
    await expect(aprobar()).rejects.toMatchObject({ errorCode: 'THIN_FILE_FUENTE_CAPACIDAD' });
    await expect(aprobar({ fuente_capacidad_verificada: true })).rejects.toMatchObject(PASO);
  });
});

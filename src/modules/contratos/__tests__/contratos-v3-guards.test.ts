import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Contratos V3 — el flujo legacy no toca una fila V3 (diseño §3.4, pruebas §7 19).
//
// Mock de Supabase con colas POR TABLA (patrón de autorizaciones.service.test):
// filtros encadenables, terminales y `await` consumen la cola de su tabla;
// sin cola → { data: null, error: null }. `ops` registra todo para afirmar que
// tras el rechazo no hubo escrituras ni RPC.
// ============================================================

const { mockEnv, mockFrom, mockRpc, ops, queues, enqueue, mockCompletitud } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'or', 'lt', 'gt', 'gte', 'lte', 'order', 'limit'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockEnv: { CONTRATOS_V3_ENABLED: false, CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 },
    mockFrom: vi.fn((table: string) => chainFor(table)),
    mockRpc: vi.fn(async (fn: string, args: unknown) => {
      ops.push({ table: 'rpc', method: fn, args: [args] });
      return { data: null, error: { message: 'Transicion no permitida: borrador -> cancelado' } };
    }),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => {
      queues.set(table, [...(queues.get(table) ?? []), ...items]);
    },
    mockCompletitud: vi.fn(),
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t), rpc: (fn: string, a: unknown) => mockRpc(fn, a), storage: { from: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auditLog')>()),
  logAudit: vi.fn(),
}));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(async () => undefined),
  assertInmuebleAccess: vi.fn(async () => undefined),
  resolveAllowedExpedienteIds: vi.fn(async () => null),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(async () => undefined),
  findPerfilIdByEmail: vi.fn(async () => null),
}));
vi.mock('@/modules/perfil-arrendador/perfil-arrendador.service', () => ({
  checkPerfilCompletitud: (...args: unknown[]) => mockCompletitud(...args),
}));

// Import AFTER mocks
import { AppError } from '@/lib/errors';
import type { AuthUser } from '@/types/auth';
import {
  enviarContratoAFirma,
  generarContrato,
  previewContratoVerificacion,
  regenerarContrato,
} from '../contratos.service';
import { executeContratoTransition } from '../contrato-workflow.service';
import type { GenerarContratoInput, ReGenerarContratoInput } from '../contratos.schema';

const EXP = 'exp-1';
const CTO = 'cto-1';
const ADMIN = { id: 'admin-1', rol: 'administrador' } as AuthUser;

const filaV3 = (o: Record<string, unknown> = {}) => ({
  id: CTO,
  expediente_id: EXP,
  estado: 'borrador',
  storage_key: `contratos/${EXP}/${CTO}/revision-1.pdf`,
  destinacion: 'vivienda',
  numero: 'CTO-2026-0007',
  plantilla_id: null,
  datos_variables: { asistente: {} },
  ...o,
});

/** La fila que lee fetchExpedienteData (estudio aprobado, inmueble de vivienda). */
const expedienteLegacy = (inmobiliaria_id: string | null) => ({
  data: {
    id: EXP,
    numero: 'EXP-2026-0100',
    estado: 'aprobado',
    inmueble_id: 'inm-1',
    solicitante_id: 'sol-1',
    inmuebles: {
      id: 'inm-1',
      direccion: 'Carrera 43A # 1-50',
      ciudad: 'Medellín',
      valor_arriendo: 2_000_000,
      propietario_id: 'prop-1',
      inmobiliaria_id,
      uso: 'vivienda',
    },
    solicitantes: { id: 'sol-1', nombre: 'Juan', apellido: 'Pérez', tipo_documento: 'cc', numero_documento: '1020304050' },
  },
  error: null,
});
const ARRENDADOR = { data: { id: 'prop-1', nombre: 'Ana', apellido: 'Gómez', rol: 'inmobiliaria' }, error: null };

async function error(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('se esperaba un AppError');
}

const escrituras = () =>
  ops.filter((o) => ['insert', 'update', 'upsert', 'delete'].includes(o.method) || o.table === 'rpc');

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  mockEnv.CONTRATOS_V3_ENABLED = false;
  mockCompletitud.mockResolvedValue({ completo: false, faltantes: [{ campo: 'nit', etiqueta: 'NIT' }], rol: 'inmobiliaria' });
});

describe('fila V3 en el flujo legacy', () => {
  it('enviarContratoAFirma → 400 CONTRATO_V3_FIRMA_NO_DISPONIBLE', async () => {
    enqueue('contratos', { data: filaV3(), error: null });
    const e = await error(enviarContratoAFirma(CTO, ADMIN.id, ADMIN.rol));
    expect(e).toMatchObject({ statusCode: 400, errorCode: 'CONTRATO_V3_FIRMA_NO_DISPONIBLE' });
    expect(escrituras()).toEqual([]);
  });

  it('transición a en_revision → 400 CONTRATO_V3_TRANSICION_NO_PERMITIDA, sin RPC', async () => {
    enqueue('contratos', { data: filaV3(), error: null });
    const e = await error(
      executeContratoTransition(CTO, { nuevo_estado: 'en_revision', comentario: 'Revisar' } as never, ADMIN),
    );
    expect(e).toMatchObject({ statusCode: 400, errorCode: 'CONTRATO_V3_TRANSICION_NO_PERMITIDA' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('transición a pendiente_firma también se rechaza antes de delegar en el envío', async () => {
    enqueue('contratos', { data: filaV3({ estado: 'aprobado' }), error: null });
    const e = await error(
      executeContratoTransition(CTO, { nuevo_estado: 'pendiente_firma', comentario: 'Enviar' } as never, ADMIN),
    );
    expect(e.errorCode).toBe('CONTRATO_V3_TRANSICION_NO_PERMITIDA');
    expect(escrituras()).toEqual([]);
  });

  it('cancelar pasa el guard (llega al RPC de transición)', async () => {
    enqueue('contratos', { data: filaV3(), error: null });
    const e = await error(
      executeContratoTransition(
        CTO,
        { nuevo_estado: 'cancelado', comentario: 'Borrador cancelado desde el asistente', motivo: 'Cancelado' } as never,
        ADMIN,
      ),
    );
    // El RPC del mock pierde la carrera: lo importante es que se llamó con 'cancelado'.
    expect(e.errorCode).not.toBe('CONTRATO_V3_TRANSICION_NO_PERMITIDA');
    expect(mockRpc).toHaveBeenCalledWith('transicionar_contrato', expect.objectContaining({ p_nuevo_estado: 'cancelado' }));
  });

  it('regenerarContrato → 400 CONTRATO_V3_USA_ASISTENTE', async () => {
    enqueue('contratos', { data: filaV3(), error: null });
    const e = await error(regenerarContrato(CTO, {} as ReGenerarContratoInput, ADMIN.id, undefined, ADMIN.rol));
    expect(e).toMatchObject({ statusCode: 400, errorCode: 'CONTRATO_V3_USA_ASISTENTE' });
    expect(escrituras()).toEqual([]);
  });

  it('previewContratoVerificacion → 400 CONTRATO_V3_USA_ASISTENTE', async () => {
    enqueue('contratos', { data: filaV3(), error: null });
    const e = await error(previewContratoVerificacion(CTO, ADMIN.id, ADMIN.rol));
    expect(e).toMatchObject({ statusCode: 400, errorCode: 'CONTRATO_V3_USA_ASISTENTE' });
  });
});

describe('generarContrato legacy con asistente', () => {
  const generar = () => generarContrato(EXP, {} as GenerarContratoInput, ADMIN.id, undefined, ADMIN.rol);

  it('con una fila V3 viva (flag apagado) → 409 CONTRATO_USA_ASISTENTE, antes de reservar o escribir', async () => {
    enqueue('expedientes', expedienteLegacy(null));
    enqueue('perfiles', ARRENDADOR);
    enqueue('contratos', { data: [{ id: CTO }], error: null });

    const e = await error(generar());

    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_USA_ASISTENTE' });
    const nots = ops.filter((o) => o.table === 'contratos' && o.method === 'not').map((o) => o.args);
    expect(nots).toEqual([
      ['destinacion', 'is', null],
      ['estado', 'in', '(cancelado,finalizado)'],
    ]);
    expect(escrituras()).toEqual([]);
    expect(mockCompletitud).not.toHaveBeenCalled();
  });

  it('con el flag encendido e inmueble de inmobiliaria → 409 sin buscar la fila V3', async () => {
    mockEnv.CONTRATOS_V3_ENABLED = true;
    enqueue('expedientes', expedienteLegacy('org-1'));
    enqueue('perfiles', ARRENDADOR);

    const e = await error(generar());

    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_USA_ASISTENTE' });
    expect(ops.filter((o) => o.table === 'contratos')).toEqual([]);
    expect(escrituras()).toEqual([]);
  });

  it('sin poder leer las filas V3 → 503 LECTURA_NO_VERIFICABLE (fail-closed)', async () => {
    enqueue('expedientes', expedienteLegacy(null));
    enqueue('perfiles', ARRENDADOR);
    enqueue('contratos', { data: null, error: { message: 'timeout' } });

    const e = await error(generar());

    expect(e).toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
    expect(escrituras()).toEqual([]);
  });

  it('control: flag apagado y sin fila V3 → el guard deja seguir (cae en el paso siguiente)', async () => {
    enqueue('expedientes', expedienteLegacy('org-1'));
    enqueue('perfiles', ARRENDADOR);
    enqueue('contratos', { data: [], error: null });

    const e = await error(generar());

    expect(e.errorCode).toBe('PERFIL_ARRENDADOR_INCOMPLETO');
  });
});

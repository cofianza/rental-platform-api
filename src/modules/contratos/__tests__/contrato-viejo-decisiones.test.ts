import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Contrato del flujo anterior (plantilla V4): decisiones del 2026-09-24.
// Mock de Supabase con colas POR TABLA, como contratos-v3-guards.test: filtros
// encadenables, terminales y `await` consumen la cola de su tabla; sin cola →
// { data: null, error: null }. `ops` registra todo.
// ============================================================

const { mockEnv, mockFrom, mockRpc, ops, enqueue, queues, mockCompletitud, mockCoa } = vi.hoisted(() => {
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
    mockEnv: { CONTRATOS_V3_ENABLED: false, FIRMA_MULTIPARTE_ENABLED: true, CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000, RESEND_API_KEY: 're_test' },
    mockFrom: vi.fn((table: string) => chainFor(table)),
    mockRpc: vi.fn(async () => ({ data: null, error: null })),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => {
      queues.set(table, [...(queues.get(table) ?? []), ...items]);
    },
    mockCompletitud: vi.fn(),
    mockCoa: vi.fn(),
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
  puedeVerFilaExpediente: vi.fn(async () => true),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(async () => undefined),
  findPerfilIdByEmail: vi.fn(async () => null),
}));
vi.mock('@/modules/perfil-arrendador/perfil-arrendador.service', () => ({
  checkPerfilCompletitud: (...args: unknown[]) => mockCompletitud(...args),
  usuarioPuedeEditarDatosContrato: vi.fn(async () => false),
}));
// La función compartida (P2): su semántica es de otro cambio; aquí solo importa que el contrato la use.
vi.mock('@/modules/estudios/coarrendatario-vinculado', () => ({
  coarrendatarioVinculado: (...args: unknown[]) => mockCoa(...args),
}));

import { AppError } from '@/lib/errors';
import { enviarContratoAFirma, generarContrato } from '../contratos.service';
import type { GenerarContratoInput } from '../contratos.schema';

const EXP = 'exp-1';
const CTO = 'cto-1';
const ADMIN = { id: 'admin-1', rol: 'administrador' };

const expediente = (extra: Record<string, unknown> = {}) => ({
  data: {
    id: EXP,
    numero: 'EXP-2026-0100',
    estado: 'aprobado',
    inmueble_id: 'inm-1',
    solicitante_id: 'sol-1',
    inmuebles: {
      id: 'inm-1', direccion: 'Carrera 43A # 1-50', ciudad: 'Medellín', valor_arriendo: 2_000_000,
      propietario_id: 'prop-1', inmobiliaria_id: null, uso: 'vivienda',
    },
    solicitantes: { id: 'sol-1', nombre: 'Juan', apellido: 'Pérez', tipo_documento: 'cc', numero_documento: '1020304050' },
    ...extra,
  },
  error: null,
});
const PROPIETARIO = { data: { id: 'prop-1', nombre: 'Ana', apellido: 'Gómez', rol: 'propietario' }, error: null };
const COA = { id: 'coa-1', nombre: 'Pedro', estudioId: 'est-coa', puntaje: null };

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

/** Lo que generarContrato lee antes de sus guards: estudio, arrendador y (sin) contrato V3. */
function prepararGenerar(extraExpediente: Record<string, unknown> = {}) {
  enqueue('expedientes', expediente(extraExpediente));
  enqueue('perfiles', PROPIETARIO);
  enqueue('contratos', { data: [], error: null });
}

const generar = (input: Partial<GenerarContratoInput> = {}) =>
  generarContrato(EXP, input as GenerarContratoInput, ADMIN.id, undefined, ADMIN.rol);

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  mockCoa.mockResolvedValue(null);
  // Los guards de este archivo van antes de la completitud: si pasan, cae aquí.
  mockCompletitud.mockResolvedValue({ completo: false, faltantes: [{ campo: 'x', etiqueta: 'X' }], rol: 'propietario' });
});

describe('P6 y P2: co-arrendatario o co-titular en el contrato viejo', () => {
  it('con co-arrendatario (según la función compartida) → 409 antes de reservar o escribir', async () => {
    mockCoa.mockResolvedValue(COA);
    prepararGenerar();
    enqueue('expediente_coarrendatarios', {
      data: { nombre: 'Pedro', apellido: 'Ruiz', tipo_documento: 'cc', numero_documento: '77', email: 'p@x.co', telefono: null },
      error: null,
    });

    const e = await error(generar());

    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_REQUIERE_COARRENDATARIO' });
    expect(e.message).toContain('Hazlo con el contrato nuevo');
    expect(mockCoa).toHaveBeenCalledWith(EXP);
    expect(mockCompletitud).not.toHaveBeenCalled();
    expect(escrituras()).toEqual([]);
  });

  it('con co-titular en el formulario (Cofianza Compartida) → 409', async () => {
    prepararGenerar();
    const e = await error(generar({ modalidad_fianza: 'compartida', cotitular: { nombre: 'Lucía Díaz' } }));
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_REQUIERE_COARRENDATARIO' });
    expect(e.message).toContain('co-titular');
    expect(escrituras()).toEqual([]);
  });

  it('con co-titular ya guardado en el estudio → 409', async () => {
    prepararGenerar({ cotitular_nombre: 'Lucía Díaz' });
    expect(await error(generar())).toMatchObject({ errorCode: 'CONTRATO_REQUIERE_COARRENDATARIO' });
  });

  it('sin co-arrendatario para la función compartida, las columnas viejas del estudio no lo reviven', async () => {
    prepararGenerar({ coarrendatario_nombre: 'Rechazado Pérez' });
    // Pasa el guard y cae en el paso siguiente.
    expect((await error(generar())).errorCode).toBe('PERFIL_ARRENDADOR_INCOMPLETO');
    expect(ops.some((o) => o.table === 'expediente_coarrendatarios')).toBe(false);
  });

  it('enviar a firma: con co-arrendatario o con el co-titular impreso → 409 sin tocar el contrato', async () => {
    const borrador = (datos_variables: Record<string, unknown>) => ({
      data: { id: CTO, estado: 'borrador', expediente_id: EXP, storage_key: 'k.pdf', destinacion: null, datos_variables },
      error: null,
    });

    mockCoa.mockResolvedValueOnce(COA);
    enqueue('contratos', borrador({}));
    expect(await error(enviarContratoAFirma(CTO, ADMIN.id, ADMIN.rol))).toMatchObject({
      statusCode: 409,
      errorCode: 'CONTRATO_REQUIERE_COARRENDATARIO',
    });

    enqueue('contratos', borrador({ cotitular: { nombre_completo: 'Lucía Díaz' } }));
    expect(await error(enviarContratoAFirma(CTO, ADMIN.id, ADMIN.rol))).toMatchObject({
      errorCode: 'CONTRATO_REQUIERE_COARRENDATARIO',
    });
    expect(escrituras()).toEqual([]);
  });
});

describe('P21: vigencia de la evaluación (60 días) también en el contrato viejo', () => {
  const HOY = new Date('2026-09-24T15:00:00Z'); // 10:00 en Bogotá
  const evaluacion = (fecha_completado: string | null) => ({ data: { fecha_completado }, error: null });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(HOY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('evaluación de hace 61 días → 409 ESTUDIO_VENCIDO antes de reservar o escribir', async () => {
    prepararGenerar();
    enqueue('estudios', evaluacion('2026-07-25T20:00:00Z'));
    const e = await error(generar());
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'ESTUDIO_VENCIDO' });
    expect(e.message).toBe('La evaluación se completó el 25/07/2026 y ya tiene más de 60 días calendario. Se requiere una nueva evaluación.');
    expect(mockCompletitud).not.toHaveBeenCalled();
    expect(escrituras()).toEqual([]);
  });

  it.each([
    ['el día 60 pasa', '2026-07-26T20:00:00Z'],
    ['sin fecha (registro manual antiguo) no bloquea', null],
  ])('%s', async (_caso, fecha) => {
    prepararGenerar();
    enqueue('estudios', evaluacion(fecha));
    expect((await error(generar())).errorCode).toBe('PERFIL_ARRENDADOR_INCOMPLETO');
  });

  it('enviar a firma un borrador viejo con la evaluación vencida → 409 sin tocar el contrato', async () => {
    enqueue('contratos', {
      data: { id: CTO, estado: 'borrador', expediente_id: EXP, storage_key: 'k.pdf', destinacion: null, datos_variables: {} },
      error: null,
    });
    enqueue('estudios', evaluacion('2026-07-01T20:00:00Z'));
    expect(await error(enviarContratoAFirma(CTO, ADMIN.id, ADMIN.rol))).toMatchObject({ statusCode: 409, errorCode: 'ESTUDIO_VENCIDO' });
    expect(escrituras()).toEqual([]);
  });
});

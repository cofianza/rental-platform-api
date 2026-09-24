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
vi.mock('@/modules/inmuebles/inmuebles.service', () => ({
  reservarInmuebleParaContrato: vi.fn(async () => ({ reservado: true, ya_reservado: false, afectados: [] })),
  liberarReservaDeExpediente: vi.fn(async () => true),
}));
vi.mock('@/lib/pdfRenderer', () => ({ renderHtmlToPdf: vi.fn(async () => Buffer.from('%PDF')) }));
const { mockCrearSobre } = vi.hoisted(() => ({ mockCrearSobre: vi.fn(async () => ({ solicitud_id: 's-nuevo' })) }));
vi.mock('@/modules/firma/firma-multiparte.service', () => ({
  crearSolicitudFirmaMultiparte: (...a: unknown[]) => mockCrearSobre(...(a as [])),
}));

import { AppError } from '@/lib/errors';
import { enviarContratoAFirma, generarContrato, plazoFirmaContrato, previewPlantillaParaInmueble, renovarContrato } from '../contratos.service';
import { prorrogarContratosVencidos } from '../contrato-vencimiento.service';
import { logAudit } from '@/lib/auditLog';
import { findPerfilIdByEmail, notificarUsuario } from '@/modules/notificaciones/notificaciones.service';
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

  it('si no se puede leer la evaluación → 503, sin generar ni enviar (no es «sin fecha»)', async () => {
    const caida = { data: null, error: { message: 'timeout' } };
    prepararGenerar();
    enqueue('estudios', caida);
    expect(await error(generar())).toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
    expect(mockCompletitud).not.toHaveBeenCalled();

    enqueue('contratos', {
      data: { id: CTO, estado: 'borrador', expediente_id: EXP, storage_key: 'k.pdf', destinacion: null, datos_variables: {} },
      error: null,
    });
    enqueue('estudios', caida);
    expect(await error(enviarContratoAFirma(CTO, ADMIN.id, ADMIN.rol))).toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
    expect(escrituras()).toEqual([]);
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

describe('P14: matrícula de arrendador de la inmobiliaria', () => {
  const inmobiliaria = (matricula: Record<string, unknown>) => ({
    data: { id: 'prop-1', nombre: 'Ana', apellido: 'Gómez', rol: 'inmobiliaria', matricula_arrendador: 'M-77', ...matricula },
    error: null,
  });
  const preparar = (arrendador: Record<string, unknown>) => {
    enqueue('expedientes', expediente());
    enqueue('perfiles', arrendador);
    enqueue('contratos', { data: [], error: null });
    mockCompletitud.mockResolvedValue({ completo: true, faltantes: [], rol: 'inmobiliaria' });
  };

  it('sin «expedida por» → 400 antes de reservar o escribir', async () => {
    preparar(inmobiliaria({ matricula_expedida_por: '  ', matricula_fecha: '2021-03-15' }));
    const e = await error(generar());
    expect(e).toMatchObject({ statusCode: 400, errorCode: 'PERFIL_ARRENDADOR_INCOMPLETO' });
    expect(e.message).toContain('Matrícula expedida por');
    expect(escrituras()).toEqual([]);
  });

  it('con «expedida por» y sin fecha sigue (cae en el paso siguiente: la plantilla)', async () => {
    preparar(inmobiliaria({ matricula_expedida_por: 'Alcaldía de Medellín', matricula_fecha: null }));
    expect((await error(generar())).errorCode).toBe('PLANTILLA_NOT_FOUND');
  });

  it('un propietario directo no la necesita', async () => {
    preparar(PROPIETARIO);
    expect((await error(generar())).errorCode).toBe('PLANTILLA_NOT_FOUND');
  });
});

describe('P42: cuota de administración en el contrato viejo', () => {
  const cargo = async (inmueble: Record<string, unknown>) => {
    enqueue('inmuebles', {
      data: { id: 'inm-1', direccion: 'Calle 1', ciudad: 'Medellín', valor_arriendo: 2_000_000, propietario_id: 'prop-1', uso: 'vivienda', ...inmueble },
      error: null,
    });
    enqueue('perfiles', PROPIETARIO);
    enqueue('plantillas_contrato', { data: { contenido_html: '{{contrato.administracion_ph_cargo}}' }, error: null });
    return previewPlantillaParaInmueble('inm-1', ADMIN.id, ADMIN.rol);
  };

  it('en propiedad horizontal imprime la cuota vigente en cifras y letras junto a quién la paga', async () => {
    expect(await cargo({ propiedad_horizontal: true, administracion: 250_000 })).toBe(
      'A cargo del arrendatario — cuota actual $ 250.000 (DOSCIENTOS CINCUENTA MIL PESOS M/CTE)',
    );
  });

  it('sin cuota registrada dice solo quién la paga; sin propiedad horizontal, no aplica', async () => {
    expect(await cargo({ propiedad_horizontal: true, administracion: null })).toBe('A cargo del arrendatario');
    expect(await cargo({ propiedad_horizontal: false, administracion: 0 })).toBe('No aplica');
  });
});

describe('P12: comisión de intermediación por contrato', () => {
  /** Genera hasta guardar el contrato y devuelve el snapshot (datos_variables) que se insertó. */
  async function generarYLeerSnapshot(arrendador: Record<string, unknown>, comision_pct?: number) {
    const { supabase } = await import('@/lib/supabase');
    vi.mocked(supabase.storage.from).mockReturnValue({ upload: async () => ({ error: null }) } as never);
    mockCompletitud.mockResolvedValue({ completo: true, faltantes: [], rol: arrendador.rol });
    enqueue('expedientes', expediente());
    enqueue('perfiles', { data: arrendador, error: null });
    enqueue(
      'contratos',
      { data: [], error: null }, // sin contrato V3
      { data: { id: 'cto-nuevo' }, error: null }, // insert
      { data: null, error: null }, // storage_key
      { data: { id: 'cto-nuevo', _scope: {} }, error: null }, // getContratoById
    );
    enqueue('plantillas_contrato', {
      data: { id: 'pl-1', nombre: 'V4', contenido: null, contenido_html: '<p>{{inmobiliaria.comision_porcentaje}}</p>', variables: [], activa: true, version: 1 },
      error: null,
    });
    await generar(comision_pct === undefined ? {} : { comision_pct });
    const insert = ops.find((o) => o.table === 'contratos' && o.method === 'insert');
    return (insert?.args[0] as { datos_variables: { inmobiliaria: { comision_porcentaje: string }; config: { comision_porcentaje: number } } })
      .datos_variables;
  }

  const INMOBILIARIA = { id: 'prop-1', nombre: 'Ana', apellido: 'Gómez', rol: 'inmobiliaria', matricula_arrendador: 'M-77', matricula_expedida_por: 'Alcaldía' };

  it('la inmobiliaria pone su porcentaje en el contrato (no el 20 % global)', async () => {
    const dv = await generarYLeerSnapshot(INMOBILIARIA, 8.5);
    expect(dv.inmobiliaria.comision_porcentaje).toBe('8,5%');
    expect(dv.config.comision_porcentaje).toBe(8.5);
    const claves = ops.filter((o) => o.table === 'configuracion_sistema' && o.method === 'in').map((o) => o.args[1]);
    expect(claves.flat()).not.toContain('comision_intermediacion_porcentaje');
  });

  it('sin porcentaje, o en 0, la cláusula queda vacía (se suprime)', async () => {
    expect((await generarYLeerSnapshot(INMOBILIARIA)).inmobiliaria.comision_porcentaje).toBe('');
    ops.length = 0;
    expect((await generarYLeerSnapshot(INMOBILIARIA, 0)).inmobiliaria.comision_porcentaje).toBe('');
  });

  it('el propietario directo nunca la lleva, aunque llegue un porcentaje', async () => {
    const dv = await generarYLeerSnapshot({ id: 'prop-1', nombre: 'Ana', apellido: 'Gómez', rol: 'propietario' }, 10);
    expect(dv.inmobiliaria.comision_porcentaje).toBe('');
    expect(dv.config.comision_porcentaje).toBe(0);
  });
});

describe('P5: plazo de firma del contrato viejo', () => {
  const HOY = new Date('2026-09-24T15:00:00Z'); // 10:00 en Bogotá
  const evaluacion = (fecha_completado: string | null) => ({ data: { fecha_completado }, error: null });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(HOY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('15 días (DIAS_EXPIRACION_FIRMA) hasta la medianoche de Bogotá, no 72 horas', async () => {
    enqueue('estudios', evaluacion(null));
    expect(await plazoFirmaContrato(EXP)).toBe('2026-10-10T04:59:59.000Z'); // 9 de octubre, 23:59:59 en Bogotá
  });

  it('sin pasar la vigencia del CRC (60 días desde la evaluación)', async () => {
    enqueue('estudios', evaluacion('2026-08-01T15:00:00Z'));
    expect(await plazoFirmaContrato(EXP)).toBe('2026-09-30T15:00:00.000Z');
  });

  it('si no se puede leer la evaluación, no queda sin tope: 503', async () => {
    enqueue('estudios', { data: null, error: { message: 'timeout' } });
    await expect(plazoFirmaContrato(EXP)).rejects.toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
  });

  it('con menos de tres días de CRC no se abre el proceso (409)', async () => {
    enqueue('estudios', evaluacion('2026-07-27T15:00:00Z'));
    await expect(plazoFirmaContrato(EXP)).rejects.toMatchObject({ statusCode: 409, errorCode: 'CRC_SIN_MARGEN' });
  });

  describe('reenviar a firma cuando venció el plazo (contratos-firma-2)', () => {
    const enFirma = { data: { id: CTO, estado: 'pendiente_firma', expediente_id: EXP, storage_key: 'k.pdf', destinacion: null, datos_variables: null }, error: null };

    it('un sobre «enviado» con el plazo vencido no cuenta como activo: sale uno nuevo', async () => {
      enqueue('contratos', enFirma);
      enqueue('solicitudes_firma', { data: [{ id: 's-viejo', token_expiracion: '2026-09-20T04:59:59Z' }], error: null });
      const r = await enviarContratoAFirma(CTO, ADMIN.id, ADMIN.rol);
      expect(r.message).toBe('Contrato enviado a firma.');
      expect(mockCrearSobre).toHaveBeenCalledWith(CTO, ADMIN.id);
    });

    it('con el sobre aún vigente no duplica', async () => {
      enqueue('contratos', enFirma);
      enqueue('solicitudes_firma', { data: [{ id: 's-vivo', token_expiracion: '2026-10-01T04:59:59Z' }], error: null });
      expect((await enviarContratoAFirma(CTO, ADMIN.id, ADMIN.rol)).message).toBe('El contrato ya está en proceso de firma.');
      expect(mockCrearSobre).not.toHaveBeenCalled();
    });
  });
});

describe('P11 y P20: al vencer, el contrato viejo se prorroga por el mismo término', () => {
  const HOY = new Date('2026-09-24T15:00:00Z');
  const vigente = (o: Record<string, unknown> = {}) => ({
    id: CTO, expediente_id: EXP, fecha_inicio: '2025-09-15', fecha_fin: '2026-09-15', duracion_meses: 12, ...o,
  });
  const de = (table: string, method: string) => ops.filter((o) => o.table === table && o.method === method);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(HOY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('corre fecha_fin (CAS), deja constancia, avisa y NO finaliza ni libera el inmueble', async () => {
    enqueue('contratos', { data: [vigente()], error: null }, { data: [{ id: CTO }], error: null });
    enqueue('expedientes', { data: { solicitante_id: 'sol-1', inmueble_id: 'inm-1' }, error: null });
    enqueue('inmuebles', { data: { direccion: 'Calle 1', propietario_id: 'prop-1' }, error: null });
    enqueue('solicitantes', { data: { email: 'juan@x.co' }, error: null });
    vi.mocked(findPerfilIdByEmail).mockResolvedValueOnce('user-juan');

    expect(await prorrogarContratosVencidos()).toEqual({ revisados: 1, prorrogados: 1 });

    expect(de('contratos', 'lt').map((o) => o.args)).toEqual([['fecha_fin', '2026-09-24']]);
    expect(de('contratos', 'update').map((o) => o.args[0])).toEqual([{ fecha_fin: '2027-09-15' }]);
    const cas = de('contratos', 'eq').map((o) => o.args);
    expect(cas).toContainEqual(['estado', 'vigente']);
    expect(cas).toContainEqual(['fecha_fin', '2026-09-15']);
    expect(de('contrato_historial_estados', 'insert')[0].args[0]).toMatchObject({
      estado_anterior: 'vigente',
      estado_nuevo: 'vigente',
      usuario_id: null,
      comentario: expect.stringContaining('Prórroga automática por el mismo término (12 meses): el contrato vence ahora el 15/09/2027.'),
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ accion: 'contrato_prorrogado', entidadId: CTO }));
    expect(mockRpc).not.toHaveBeenCalled(); // sin transición a 'finalizado'
    await vi.waitFor(() => expect(notificarUsuario).toHaveBeenCalledTimes(2));
    expect(notificarUsuario).toHaveBeenCalledWith(expect.objectContaining({ userId: 'prop-1', tipo: 'contrato.prorrogado', titulo: 'Contrato prorrogado' }));
    expect(notificarUsuario).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-juan', tipo: 'contrato.prorrogado' }));
  });

  it('cuenta desde el inicio, no encadena: 31-ene + 1 mes vence el 28-feb y el siguiente, el 31-mar', async () => {
    vi.setSystemTime(new Date('2026-03-15T15:00:00Z'));
    enqueue('contratos', { data: [vigente({ fecha_inicio: '2026-01-31', fecha_fin: '2026-02-28', duracion_meses: 1 })], error: null }, { data: [{ id: CTO }], error: null });
    await prorrogarContratosVencidos();
    expect(de('contratos', 'update').map((o) => o.args[0])).toEqual([{ fecha_fin: '2026-03-31' }]);
  });

  it('si entretanto lo terminaron (el CAS no encuentra la fila), ni constancia ni aviso', async () => {
    enqueue('contratos', { data: [vigente()], error: null }, { data: [], error: null });
    expect(await prorrogarContratosVencidos()).toEqual({ revisados: 1, prorrogados: 0 });
    expect(de('contrato_historial_estados', 'insert')).toEqual([]);
    expect(notificarUsuario).not.toHaveBeenCalled();
  });

  it('sin término válido no lo toca (y tampoco lo finaliza)', async () => {
    enqueue('contratos', { data: [vigente({ duracion_meses: null })], error: null });
    expect(await prorrogarContratosVencidos()).toEqual({ revisados: 1, prorrogados: 0 });
    expect(de('contratos', 'update')).toEqual([]);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('«Renovar contrato» en el viejo → 409 sin escribir (antes daba 500)', async () => {
    enqueue('contratos', { data: { id: CTO, expediente_id: EXP, destinacion: null }, error: null });
    const e = await error(renovarContrato(CTO, ADMIN.id, ADMIN.rol));
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_SE_PRORROGA' });
    expect(e.message).toContain('se prorroga automáticamente por el mismo término');
    expect(escrituras()).toEqual([]);
  });
});

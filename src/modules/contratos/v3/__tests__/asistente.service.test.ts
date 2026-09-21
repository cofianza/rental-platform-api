import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Asistente de contratos V3 — service (diseño §5.1, §5.6, pruebas §7 14-18).
//
// Mock de Supabase con colas POR TABLA (patrón de autorizaciones.service.test):
// cualquier filtro devuelve el mismo builder; `maybeSingle`/`single` y el
// `await` directo consumen el siguiente resultado de la cola de esa tabla. Una
// tabla sin cola responde { data: null, error: null }. Todo queda en `ops`
// (también storage y las funciones de reserva) para afirmar el ORDEN de las
// escrituras, no solo que no explotó.
// ============================================================

const {
  mockEnv,
  mockFrom,
  ops,
  queues,
  enqueue,
  storageApi,
  mockAssertAccess,
  mockReservar,
  mockLiberar,
  mockAvisar,
  mockTarifas,
  mockCompletitud,
  mockLogAudit,
} = vi.hoisted(() => {
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
  const registra = (table: string, method: string, res: unknown) =>
    vi.fn(async (...args: unknown[]) => {
      ops.push({ table, method, args });
      return res;
    });
  return {
    mockEnv: { CONTRATOS_V3_ENABLED: true, CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 },
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => {
      queues.set(table, [...(queues.get(table) ?? []), ...items]);
    },
    storageApi: {
      upload: registra('storage', 'upload', { data: {}, error: null }),
      remove: registra('storage', 'remove', { data: [], error: null }),
      download: registra('storage', 'download', { data: null, error: { message: 'no' } }),
    },
    mockAssertAccess: vi.fn(async () => undefined),
    mockReservar: vi.fn(),
    mockLiberar: vi.fn(),
    mockAvisar: vi.fn(),
    mockTarifas: vi.fn(),
    mockCompletitud: vi.fn(),
    mockLogAudit: vi.fn(),
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t), storage: { from: () => storageApi } },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  AUDIT_ACTIONS: { CONTRATO_GENERATED: 'contrato_generated' },
  AUDIT_ENTITIES: { CONTRATO: 'contrato' },
}));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: (...args: unknown[]) => mockAssertAccess(...args),
}));
// Los defaults reales de calibración (tolerancia 15 %, tope 3.000.000, vigencia 60 días).
vi.mock('@/lib/calibracion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/calibracion')>();
  return { ...actual, getCalibracion: vi.fn(async () => actual.CALIBRACION_DEFAULT) };
});
vi.mock('@/modules/perfil-arrendador/perfil-arrendador.service', () => ({
  checkPerfilCompletitud: (...args: unknown[]) => mockCompletitud(...args),
}));
vi.mock('@/modules/estudios/tarifa-override.service', () => ({
  tarifasDelEstudio: (...args: unknown[]) => mockTarifas(...args),
}));
vi.mock('@/modules/estudios/reserva-inmueble.notificaciones', () => ({
  avisarCandidatosDeReserva: (...args: unknown[]) => mockAvisar(...args),
}));
vi.mock('@/modules/inmuebles/inmuebles.service', () => ({
  reservarInmuebleParaContrato: (...args: unknown[]) => mockReservar(...args),
  liberarReservaDeExpediente: (...args: unknown[]) => mockLiberar(...args),
}));
// Sin Chromium: el PDF es un buffer falso, los pendientes salen de la plantilla real.
vi.mock('../vivienda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vivienda')>();
  return {
    ...actual,
    generarContratoVivienda: vi.fn(async (d: Parameters<typeof actual.renderizarVivienda>[0], o: Parameters<typeof actual.renderizarVivienda>[1]) => {
      const r = actual.renderizarVivienda(d, o);
      return { pdf: Buffer.from('%PDF-1.4 prueba'), pendientes: r.pendientes, version: 'vivienda-prueba', lineas: r.lineas };
    }),
  };
});

// Import AFTER mocks
import { AppError } from '@/lib/errors';
import type { Tarifas } from '@/modules/estudios/tarifas';
import { generarVistaPrevia, guardarPaso, iniciarContrato, obtenerEstado } from '../asistente.service';
import type { Asistente } from '../asistente.reglas';

// ============================================================
// Fixtures (hoy = 2026-09-15 en Bogotá)
// ============================================================

const EXP = 'exp-1';
const USER = 'user-1';
const ROL = 'inmobiliaria';
const CTO = 'cto-1';
const LEIDO = '2026-09-15T14:00:00.000Z';

const TARIFAS: Tarifas = {
  via: 'automatica',
  con_coarrendatario: false,
  tarifa_mensual_pct: 2,
  tarifa_mensual_cop: 40_000,
  iva_pct: 19,
  tarifa_mensual_con_iva_cop: 47_600,
  prima_vinculacion_pct: 20,
  prima_vinculacion_cop: 400_000,
  cashback_pct: 30,
  negociada: false,
  override: null,
};

const PERFIL = {
  razon_social: 'INMOBILIARIA EJEMPLO S.A.S.',
  nit: '900.123.456-8',
  representante_legal: 'Ana María Gómez Restrepo',
  representante_legal_tipo_documento: 'cc',
  representante_legal_documento: '43987654',
  matricula_arrendador: 'MA-2019-0456',
  matricula_expedida_por: 'Alcaldía de Medellín',
  domicilio_direccion: 'Calle 50 # 40-20, oficina 301',
  domicilio_ciudad: 'Medellín',
  email_recaudo: 'contratos@inmobiliaria-ejemplo.co',
  whatsapp_recaudo: '+573001112233',
  logo_storage_key: null,
  cuenta_recaudo_banco: 'Bancolombia',
  cuenta_recaudo_tipo: 'ahorros',
  cuenta_recaudo_numero: '123-456789-01',
  cuenta_recaudo_titular_nombre: 'INMOBILIARIA EJEMPLO S.A.S.',
  cuenta_recaudo_titular_nit: '900123456-8',
};

const contacto = (email: string) => ({ direccion: 'Calle 10 # 20-30', municipio: 'Medellín', email, telefono: '3001234567' });

/** Sin coarrendatario, sin PH, Trasladada: los cinco pasos guardados. */
const COMPLETO: Asistente = {
  paso1: { ruta: 'A', modalidad: 'trasladada', canonCop: 2_000_000 },
  paso2: {
    usos: { carro: null, moto: null, util: null },
    amoblado: false,
    ocupantes: 2,
    propiedadHorizontal: false,
    nombreCopropiedad: null,
  },
  paso3: { vigenciaMeses: 12, fechaInicio: '2026-10-01', fechaEntrega: '2026-10-01', comisionPct: 8, administracion: null },
  paso4: { omitir: true },
  paso5: {
    ciudadFirma: 'Medellín',
    contactos: {
      arrendador: contacto('contratos@inmobiliaria-ejemplo.co'),
      arrendatario: contacto('juan.perez@correo.co'),
      coarrendatario: null,
    },
  },
  actualizadoEn: '2026-09-15T13:00:00.000Z',
};

const fila = (o: Record<string, unknown> = {}) => ({
  id: CTO,
  estado: 'borrador',
  destinacion: 'vivienda',
  numero: 'CTO-2026-0007',
  updated_at: LEIDO,
  datos_variables: { asistente: {} },
  storage_key: null,
  ...o,
});

interface Carga {
  estado?: string;
  propiedadHorizontal?: boolean | null;
  contratos?: unknown[];
  ingreso?: number | null;
  expedienteError?: boolean;
}

/** Encola UNA lectura completa de cargarFuentes (cada tabla, en su orden). */
function encolarCarga(o: Carga = {}) {
  enqueue(
    'expedientes',
    o.expedienteError
      ? { data: null, error: { message: 'timeout' } }
      : {
          data: {
            id: EXP,
            numero: 'EXP-2026-0100',
            estado: o.estado ?? 'aprobado',
            duracion_contrato_meses: 12,
            fecha_inicio_contrato: null,
            inmuebles: {
              id: 'inm-1',
              codigo: 'INM-001',
              direccion: 'Carrera 43A # 1-50, apartamento 1201',
              ciudad: 'Medellín',
              uso: 'vivienda',
              estado: 'disponible',
              reservado_por_expediente_id: null,
              inmobiliaria_id: 'org-1',
              valor_arriendo: '2000000',
              propiedad_horizontal: o.propiedadHorizontal === undefined ? false : o.propiedadHorizontal,
              parqueadero: false,
              cuarto_util: false,
            },
            solicitantes: {
              nombre: 'Juan Carlos',
              apellido: 'Pérez Mejía',
              tipo_documento: 'cc',
              numero_documento: '1020304050',
              tipo_persona: 'natural',
              email: 'juan.perez@correo.co',
              telefono: '3001234567',
              direccion: 'Calle 10 # 20-30',
              ciudad: 'Medellín',
            },
          },
          error: null,
        },
  );
  enqueue('estudios', {
    data: { id: 'est-1', resultado: 'aprobado', fecha_completado: '2026-09-01T15:00:00Z', canon_evaluado: '2000000' },
    error: null,
  });
  enqueue('expediente_coarrendatarios', { data: null, error: null });
  enqueue('inmobiliarias', { data: { owner_perfil_id: 'owner-1' }, error: null });
  enqueue('contratos', { data: o.contratos ?? [], error: null });
  enqueue('estudios_certificados', {
    data: {
      id: 'crc-1',
      codigo: 'CRC-2026-0042',
      version: 1,
      fecha_emision: '2026-09-01T16:00:00Z',
      fecha_vencimiento: '2026-10-31T16:00:00Z',
      pdf_storage_key: 'certificados/est-1.pdf',
    },
    error: null,
  });
  enqueue('estudios_scorecard_sombra', {
    data: o.ingreso === undefined || o.ingreso === null ? null : { ingreso_inferido_ajustado_cop: String(o.ingreso) },
    error: null,
  });
  enqueue('perfiles', { data: PERFIL, error: null });
}

const reserva = (o: Record<string, unknown> = {}) => ({
  reservado: true,
  ya_reservado: false,
  inmueble_codigo: 'INM-001',
  inmueble_direccion: 'Carrera 43A # 1-50',
  afectados: [],
  ...o,
});
const AFECTADO = {
  expediente_id: 'exp-otro',
  expediente_numero: 'EXP-2026-0099',
  solicitante_id: 'sol-2',
  solicitante_nombre: 'Otra',
  solicitante_apellido: 'Persona',
  solicitante_email: 'otra@correo.co',
};

const opsDe = (table: string, method: string) => ops.filter((o) => o.table === table && o.method === method);
const pos = (table: string, method: string) => ops.findIndex((o) => o.table === table && o.method === method);

async function error(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('se esperaba un AppError');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T15:00:00Z'));
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  mockEnv.CONTRATOS_V3_ENABLED = true;
  mockTarifas.mockResolvedValue({ tarifas: TARIFAS });
  mockCompletitud.mockResolvedValue({ completo: true, faltantes: [], rol: 'inmobiliaria' });
  mockReservar.mockImplementation(async () => {
    ops.push({ table: 'fn', method: 'reservar', args: [] });
    return reserva();
  });
  mockLiberar.mockResolvedValue(undefined);
  mockAvisar.mockImplementation(async () => {
    ops.push({ table: 'fn', method: 'avisar', args: [] });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// 14. Flag apagado
// ============================================================

describe('flag CONTRATOS_V3_ENABLED apagado', () => {
  beforeEach(() => {
    mockEnv.CONTRATOS_V3_ENABLED = false;
  });

  it('GET responde habilitado:false sin tocar la base (ni para el acceso)', async () => {
    const e = await obtenerEstado(EXP, USER, ROL);
    expect(e).toEqual({ habilitado: false, bloqueos: [], avisos: [], resumen: null, contrato: null });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockAssertAccess).not.toHaveBeenCalled();
  });

  it('Iniciar responde 404 CONTRATOS_V3_NO_HABILITADO', async () => {
    const e = await error(iniciarContrato(EXP, USER, ROL));
    expect(e).toMatchObject({ statusCode: 404, errorCode: 'CONTRATOS_V3_NO_HABILITADO' });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

// ============================================================
// GET con el flag encendido
// ============================================================

describe('obtenerEstado', () => {
  it('antes de Iniciar: sin bloqueos, resumen sin ingreso, contrato null', async () => {
    encolarCarga({ ingreso: 4_000_000 });
    const e = await obtenerEstado(EXP, USER, ROL);
    expect(mockAssertAccess).toHaveBeenCalledWith(EXP, USER, ROL);
    expect(e.habilitado).toBe(true);
    expect(e.bloqueos).toEqual([]);
    expect(e.contrato).toBeNull();
    expect(e.resumen!.canon).toEqual({ evaluadoCop: 2_000_000, maximoSinNuevaEvaluacionCop: 2_300_000 });
    expect(JSON.stringify(e)).not.toContain('4000000');
    // La lectura del contrato excluye cancelados y finalizados (índice contratos_v3_vivo_uq).
    expect(opsDe('contratos', 'not')[0].args).toEqual(['estado', 'in', '(cancelado,finalizado)']);
  });

  it('un error de lectura es 503 LECTURA_NO_VERIFICABLE', async () => {
    encolarCarga({ expedienteError: true });
    const e = await error(obtenerEstado(EXP, USER, ROL));
    expect(e).toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
  });

  it('tarifa con coarrendatario y ningún coarrendatario vinculado es 503 (nunca "solo")', async () => {
    mockTarifas.mockResolvedValue({ tarifas: { ...TARIFAS, con_coarrendatario: true } });
    encolarCarga();
    const e = await error(obtenerEstado(EXP, USER, ROL));
    expect(e).toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
  });
});

// ============================================================
// 15-16. Iniciar
// ============================================================

describe('iniciarContrato', () => {
  it('reserva ANTES del INSERT y avisa a los demás candidatos DESPUÉS', async () => {
    mockReservar.mockImplementation(async () => {
      ops.push({ table: 'fn', method: 'reservar', args: [] });
      return reserva({ afectados: [AFECTADO] });
    });
    encolarCarga();
    enqueue('contratos', { data: fila(), error: null });

    const r = await iniciarContrato(EXP, USER, ROL);

    expect(r.creado).toBe(true);
    expect(r.estado.contrato).toMatchObject({ id: CTO, numero: 'CTO-2026-0007', estado: 'borrador' });
    expect(pos('fn', 'reservar')).toBeGreaterThan(-1);
    expect(pos('fn', 'reservar')).toBeLessThan(pos('contratos', 'insert'));
    expect(pos('contratos', 'insert')).toBeLessThan(pos('fn', 'avisar'));
    expect(opsDe('contratos', 'insert')[0].args[0]).toMatchObject({
      expediente_id: EXP,
      estado: 'borrador',
      destinacion: 'vivienda',
      iva_canon_pct: 0,
      generado_por: USER,
      datos_variables: { asistente: {} },
    });
    expect(mockLiberar).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ detalle: expect.objectContaining({ v3: true, fase: 'iniciado', numero: 'CTO-2026-0007' }) }),
    );
  });

  it('con un borrador vivo devuelve su estado sin reservar ni insertar', async () => {
    encolarCarga({ contratos: [fila()] });
    const r = await iniciarContrato(EXP, USER, ROL);
    expect(r.creado).toBe(false);
    expect(r.estado.contrato!.id).toBe(CTO);
    expect(mockReservar).not.toHaveBeenCalled();
    expect(opsDe('contratos', 'insert')).toHaveLength(0);
  });

  it('23505 (otra pestaña ganó): devuelve la fila existente y NO libera la reserva', async () => {
    mockReservar.mockImplementation(async () => {
      ops.push({ table: 'fn', method: 'reservar', args: [] });
      return reserva({ afectados: [AFECTADO] });
    });
    encolarCarga();
    enqueue('contratos', { data: null, error: { code: '23505', message: 'duplicate key' } });
    encolarCarga({ contratos: [fila()] });

    const r = await iniciarContrato(EXP, USER, ROL);

    expect(r.creado).toBe(false);
    expect(r.estado.contrato!.id).toBe(CTO);
    expect(mockLiberar).not.toHaveBeenCalled();
    expect(mockAvisar).not.toHaveBeenCalled();
  });

  it('otro error del INSERT con reservado:true libera la reserva y no avisa', async () => {
    mockReservar.mockImplementation(async () => reserva({ afectados: [AFECTADO] }));
    encolarCarga();
    enqueue('contratos', { data: null, error: { code: '57014', message: 'timeout' } });

    const e = await error(iniciarContrato(EXP, USER, ROL));

    expect(e.statusCode).toBe(500);
    expect(mockLiberar).toHaveBeenCalledWith(EXP);
    expect(mockAvisar).not.toHaveBeenCalled();
  });

  it('otro error del INSERT con ya_reservado NO libera (la reserva ya era de este estudio)', async () => {
    mockReservar.mockResolvedValue(reserva({ reservado: false, ya_reservado: true }));
    encolarCarga();
    enqueue('contratos', { data: null, error: { code: '57014', message: 'timeout' } });

    const e = await error(iniciarContrato(EXP, USER, ROL));

    expect(e.statusCode).toBe(500);
    expect(mockLiberar).not.toHaveBeenCalled();
  });

  it('con un bloqueo responde 409 CONTRATO_BLOQUEADO y nunca reserva', async () => {
    encolarCarga({ estado: 'en_revision' });

    const e = await error(iniciarContrato(EXP, USER, ROL));

    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_BLOQUEADO' });
    expect(e.message).toBe('El contrato solo se crea sobre un estudio aprobado.');
    expect((e.details as { bloqueos: { codigo: string }[] }).bloqueos.map((b) => b.codigo)).toEqual([
      'EXPEDIENTE_NO_APROBADO',
    ]);
    expect(mockReservar).not.toHaveBeenCalled();
    expect(opsDe('contratos', 'insert')).toHaveLength(0);
  });
});

// ============================================================
// 17. Guardar paso
// ============================================================

describe('guardarPaso', () => {
  const PASO2_PH = {
    paso: 2 as const,
    datos: {
      usos: { carro: null, moto: null, util: null },
      amoblado: false,
      ocupantes: 2,
      propiedadHorizontal: true,
      nombreCopropiedad: 'Edificio Torres del Parque',
    },
  };

  it('CAS perdido (0 filas) → 409 CONTRATO_BORRADOR_CAMBIADO', async () => {
    encolarCarga({ contratos: [fila()] });
    enqueue('contratos', { data: [], error: null });

    const e = await error(guardarPaso(EXP, { paso: 4, datos: { omitir: true } }, USER, ROL));

    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_BORRADOR_CAMBIADO' });
    const eqs = opsDe('contratos', 'eq').map((o) => o.args);
    expect(eqs).toContainEqual(['estado', 'borrador']);
    expect(eqs).toContainEqual(['updated_at', LEIDO]);
  });

  it('una fila V3 viva fuera de borrador → 409 CONTRATO_NO_EDITABLE, sin escribir', async () => {
    // Un 'cancelado' ni se lee (la consulta excluye cancelados: sería 404 NO_INICIADO);
    // fuera de borrador y vivo solo queda un estado de E5, p. ej. pendiente_firma.
    encolarCarga({ contratos: [fila({ estado: 'pendiente_firma' })] });

    const e = await error(guardarPaso(EXP, { paso: 4, datos: { omitir: true } }, USER, ROL));

    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_NO_EDITABLE' });
    expect(opsDe('contratos', 'update')).toHaveLength(0);
  });

  it('sin fila V3 viva → 404 CONTRATO_V3_NO_INICIADO', async () => {
    encolarCarga();
    const e = await error(guardarPaso(EXP, { paso: 4, datos: { omitir: true } }, USER, ROL));
    expect(e).toMatchObject({ statusCode: 404, errorCode: 'CONTRATO_V3_NO_INICIADO' });
  });

  it('paso 2 con otra propiedad horizontal la escribe en el inmueble y conserva los pasos previos', async () => {
    const previo = { paso1: COMPLETO.paso1 };
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: previo } })], propiedadHorizontal: false });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()], propiedadHorizontal: true });

    await guardarPaso(EXP, PASO2_PH, USER, ROL);

    const upd = opsDe('contratos', 'update')[0].args[0] as { datos_variables: { asistente: Asistente } };
    expect(upd.datos_variables.asistente).toMatchObject({ paso1: COMPLETO.paso1, paso2: PASO2_PH.datos });
    expect(upd.datos_variables.asistente.actualizadoEn).toBe('2026-09-15T15:00:00.000Z');
    expect(opsDe('inmuebles', 'update').map((o) => o.args[0])).toEqual([{ propiedad_horizontal: true }]);
    expect(opsDe('inmuebles', 'eq').map((o) => o.args)).toEqual([['id', 'inm-1']]);
  });

  it('paso 2 con la misma propiedad horizontal no toca el inmueble', async () => {
    encolarCarga({ contratos: [fila()], propiedadHorizontal: true });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()], propiedadHorizontal: true });

    await guardarPaso(EXP, PASO2_PH, USER, ROL);

    expect(opsDe('inmuebles', 'update')).toHaveLength(0);
  });

  it('paso 3 con fecha pasada → 400 VALIDATION_ERROR, sin escribir', async () => {
    encolarCarga({ contratos: [fila()] });
    const e = await error(
      guardarPaso(EXP, { paso: 3, datos: { ...COMPLETO.paso3!, fechaInicio: '2026-09-14' } }, USER, ROL),
    );
    expect(e).toMatchObject({ statusCode: 400, errorCode: 'VALIDATION_ERROR' });
    expect(opsDe('contratos', 'update')).toHaveLength(0);
  });
});

// ============================================================
// 18. Generar
// ============================================================

describe('generarVistaPrevia', () => {
  // El reloj está congelado (beforeEach): el sufijo de la llave es fijo.
  const AHORA = Date.parse('2026-09-15T15:00:00Z');
  const KEY_ANTERIOR = `contratos/${EXP}/${CTO}/revision-1-1757940000000.pdf`;
  const KEY_NUEVA = `contratos/${EXP}/${CTO}/revision-2-${AHORA}.pdf`;
  const conDocumento = () =>
    fila({
      storage_key: KEY_ANTERIOR,
      datos_variables: { asistente: COMPLETO, documento: { generacion: 1, generadoEn: '2026-09-15T12:00:00.000Z', avisos: [] } },
    });

  it('con un bloqueo no sube nada', async () => {
    encolarCarga({ estado: 'en_revision', contratos: [fila({ datos_variables: { asistente: COMPLETO } })] });

    const e = await error(generarVistaPrevia(EXP, USER, ROL));

    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_BLOQUEADO' });
    expect(storageApi.upload).not.toHaveBeenCalled();
    expect(opsDe('contratos', 'update')).toHaveLength(0);
  });

  it('con pasos sin guardar → 422 CONTRATO_ASISTENTE_INCOMPLETO, sin subir', async () => {
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: { paso1: COMPLETO.paso1 } } })] });

    const e = await error(generarVistaPrevia(EXP, USER, ROL));

    expect(e).toMatchObject({ statusCode: 422, errorCode: 'CONTRATO_ASISTENTE_INCOMPLETO' });
    expect(storageApi.upload).not.toHaveBeenCalled();
  });

  it('CAS perdido: borra el PDF recién subido y responde 409', async () => {
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: COMPLETO } })] });
    enqueue('contratos', { data: [], error: null });

    const e = await error(generarVistaPrevia(EXP, USER, ROL));

    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_BORRADOR_CAMBIADO' });
    const primera = `contratos/${EXP}/${CTO}/revision-1-${AHORA}.pdf`;
    expect(storageApi.upload).toHaveBeenCalledWith(primera, expect.any(Buffer), expect.objectContaining({ upsert: false }));
    expect(storageApi.remove).toHaveBeenCalledWith([primera]);
    expect(pos('storage', 'upload')).toBeLessThan(pos('storage', 'remove'));
    expect(ops.filter((o) => o.table === 'contrato_partes')).toHaveLength(0);
  });

  it('éxito: sube, CAS, reemplaza las partes y borra la vista previa anterior, en ese orden', async () => {
    encolarCarga({ contratos: [conDocumento()], ingreso: 4_000_000 });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    enqueue('contrato_partes', { data: null, error: null }, { data: null, error: null });
    encolarCarga({ contratos: [conDocumento()] });

    const estado = await generarVistaPrevia(EXP, USER, ROL);

    expect(estado.habilitado).toBe(true);
    expect(mockReservar).toHaveBeenCalledWith(EXP);
    const orden = [
      pos('storage', 'upload'),
      pos('contratos', 'update'),
      pos('contrato_partes', 'delete'),
      pos('contrato_partes', 'insert'),
      pos('storage', 'remove'),
    ];
    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
    expect(storageApi.upload).toHaveBeenCalledWith(KEY_NUEVA, expect.any(Buffer), expect.objectContaining({ upsert: false }));
    expect(storageApi.remove).toHaveBeenCalledWith([KEY_ANTERIOR]);

    const upd = opsDe('contratos', 'update')[0].args[0] as Record<string, unknown> & {
      datos_variables: { documento: { generacion: number; snapshot: unknown } };
    };
    expect(upd).toMatchObject({
      valor_arriendo: 2_000_000,
      fecha_inicio: '2026-10-01',
      fecha_fin: '2027-10-01',
      duracion_meses: 12,
      storage_key: KEY_NUEVA,
      nombre_archivo: 'CTO-2026-0007-borrador.pdf',
    });
    expect(upd.datos_variables.documento.generacion).toBe(2);
    // El ingreso SOLO va a la bitácora.
    expect(JSON.stringify(upd.datos_variables)).not.toContain('4000000');
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detalle: expect.objectContaining({
          fase: 'vista_previa',
          generacion: 2,
          canon: expect.objectContaining({ ingreso_ajustado_cop: 4_000_000 }),
        }),
      }),
    );
    const eqs = opsDe('contratos', 'eq').map((o) => o.args);
    expect(eqs).toContainEqual(['updated_at', LEIDO]);
  });

  it('las partes llevan el DV del NIT y el documento del representante legal', async () => {
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: COMPLETO } })] });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    enqueue('contrato_partes', { data: null, error: null }, { data: null, error: null });
    encolarCarga({ contratos: [fila()] });

    await generarVistaPrevia(EXP, USER, ROL);

    expect(opsDe('contrato_partes', 'delete')).toHaveLength(1);
    expect(opsDe('contrato_partes', 'eq')[0].args).toEqual(['contrato_id', CTO]);
    const partes = opsDe('contrato_partes', 'insert')[0].args[0] as Record<string, unknown>[];
    expect(partes).toHaveLength(2);
    expect(partes[0]).toMatchObject({
      contrato_id: CTO,
      rol: 'arrendatario',
      orden: 1,
      estudio_id: 'est-1',
      numero_documento: '1020304050',
      email: 'juan.perez@correo.co',
      municipio: 'Medellín',
    });
    expect(partes[1]).toMatchObject({
      contrato_id: CTO,
      rol: 'arrendador',
      orden: 2,
      tipo_persona: 'juridica',
      tipo_documento: 'nit',
      numero_documento: '900123456',
      digito_verificacion: '8',
      representante_legal_nombre: 'Ana María Gómez Restrepo',
      representante_legal_tipo_documento: 'cc',
      representante_legal_documento: '43987654',
      matricula_numero: 'MA-2019-0456',
      matricula_expedida_por: 'Alcaldía de Medellín',
      email: 'contratos@inmobiliaria-ejemplo.co',
      direccion: 'Calle 10 # 20-30',
    });
  });

  it('si las partes no se guardan → 500 CONTRATO_PARTES_NO_GUARDADAS', async () => {
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: COMPLETO } })] });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    enqueue('contrato_partes', { data: null, error: null }, { data: null, error: { message: 'check_violation' } });

    const e = await error(generarVistaPrevia(EXP, USER, ROL));

    expect(e).toMatchObject({ statusCode: 500, errorCode: 'CONTRATO_PARTES_NO_GUARDADAS' });
  });
});

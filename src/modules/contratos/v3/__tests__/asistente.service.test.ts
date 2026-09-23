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
  mockMembresias,
  mockRolMiembro,
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
    mockEnv: { CONTRATOS_V3_ENABLED: true, CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000, CLAUSULAS_IA_ENABLED: false },
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
    mockMembresias: vi.fn(),
    mockRolMiembro: vi.fn(),
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
  AUDIT_ACTIONS: {
    CONTRATO_GENERATED: 'contrato_generated',
    CONTRATO_CLAUSULAS_ACEPTADAS: 'contrato_clausulas_aceptadas',
    CONTRATO_CLAUSULAS_EXCESO_AUTORIZADO: 'contrato_clausulas_exceso_autorizado',
  },
  AUDIT_ENTITIES: { CONTRATO: 'contrato' },
}));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: (...args: unknown[]) => mockAssertAccess(...args),
  resolveMembershipInmobiliariaIds: (...args: unknown[]) => mockMembresias(...args),
  resolveRolMiembro: (...args: unknown[]) => mockRolMiembro(...args),
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
  cancelarVisitasDeOtros: vi.fn(async () => undefined),
}));
vi.mock('@/modules/inmuebles/inmuebles.service', () => ({
  reservarInmuebleParaContrato: (...args: unknown[]) => mockReservar(...args),
  liberarReservaDeExpediente: (...args: unknown[]) => mockLiberar(...args),
}));
// Firma V3 (Entrega 5): el módulo se prueba aparte (firma/__tests__); aquí solo se ve que el asistente lo llame.
vi.mock('../firma/firma.service', () => ({
  crearSobre: vi.fn(async () => ({ id: 's1' })),
  estadoEnviado: vi.fn(async () => null),
  reenviar: vi.fn(),
  reintentar: vi.fn(),
  actualizarFirma: vi.fn(),
}));
vi.mock('../firma/reconciliar', () => ({ ultimoSobre: vi.fn(async () => null) }));
// Adenda 1 contratos §2.4: el aviso a la Gerencia se prueba en tope-coafianzamiento.test.ts.
const mockEscalar = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('../../tope-coafianzamiento', () => ({ escalarTopeCanon: mockEscalar }));
const mockNotificar = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: mockNotificar }));
// Sin Chromium: el PDF es un buffer falso, los pendientes salen de la plantilla real.
vi.mock('../vivienda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vivienda')>();
  // La versión real: una vista previa de otra plantilla cuenta como desactualizada.
  const { PLANTILLA_ANEXO, PLANTILLA_VIVIENDA } = await import('../plantilla-vivienda');
  return {
    ...actual,
    generarContratoVivienda: vi.fn(async (d: Parameters<typeof actual.renderizarVivienda>[0], o: Parameters<typeof actual.renderizarVivienda>[1]) => {
      const r = actual.renderizarVivienda(d, o);
      return { pdf: Buffer.from('%PDF-1.4 prueba'), pendientes: r.pendientes, version: PLANTILLA_VIVIENDA.version, lineas: r.lineas };
    }),
    generarAnexoVivienda: vi.fn(async (d: Parameters<typeof actual.renderizarAnexo>[0], o: Parameters<typeof actual.renderizarAnexo>[1]) => {
      const r = actual.renderizarAnexo(d, o);
      return { pdf: Buffer.from('%PDF-1.4 anexo'), pendientes: r.pendientes, version: PLANTILLA_ANEXO.version, lineas: r.lineas };
    }),
  };
});

// Import AFTER mocks
import { AppError } from '@/lib/errors';
import type { Tarifas } from '@/modules/estudios/tarifas';
import { PDFDocument } from 'pdf-lib';
import {
  autorizarExceso,
  cargarPropio,
  enviarAFirma,
  generarVistaPrevia,
  guardarPaso,
  iniciarContrato,
  obtenerEstado,
} from '../asistente.service';
import type { Asistente, DocumentoV3 } from '../asistente.reglas';
import { crearSobre, estadoEnviado } from '../firma/firma.service';
import { ultimoSobre } from '../firma/reconciliar';
import { guardarPasoSchema } from '../asistente.schema';
import type { AceptacionClausulas, ClausulaEnContrato, EstadoAsistente, Paso4 } from '../asistente.types';
import { AVISO_VERSION, huella } from '../clausulas.reglas';
import { contarClausulas } from '../motor';
import { PLANTILLA_VIVIENDA } from '../plantilla-vivienda';
import { generarAnexoVivienda, generarContratoVivienda } from '../vivienda';

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
      // Celulares distintos: Auco los exige únicos entre firmantes (generar ya lo revisa).
      arrendador: { ...contacto('contratos@inmobiliaria-ejemplo.co'), telefono: '3009998877' },
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
  created_at: '2026-09-14T15:00:00.000Z',
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
  /** Filas de clausulas_adicionales: solo si el paso 4 guardado trae cláusulas. */
  catalogo?: unknown[];
  /** inmuebles.nombre_copropiedad (§1.4). */
  copropiedad?: string | null;
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
              nombre_copropiedad: o.copropiedad ?? null,
              parqueadero_numero: null,
              parqueadero_moto: false,
              parqueadero_moto_numero: null,
              cuarto_util_numero: null,
              administracion: null,
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
  if (o.catalogo) enqueue('clausulas_adicionales', { data: o.catalogo, error: null });
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
  mockEnv.CLAUSULAS_IA_ENABLED = false;
  mockMembresias.mockResolvedValue(['org-1']);
  mockRolMiembro.mockResolvedValue('miembro');
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// 14. Flag apagado
// ============================================================

/**
 * GET con el flag encendido: primero lee si el contrato ya salió de borrador
 * (Entrega 5, lectura liviana); aquí no hay ninguno, y luego la carga completa.
 */
function obtener() {
  queues.set('contratos', [{ data: null, error: null }, ...(queues.get('contratos') ?? [])]);
  return obtenerEstado(EXP, USER, ROL);
}

/** Iniciar también lee primero si el estudio ya tiene un contrato fuera de borrador (E6): aquí no. */
function iniciar() {
  queues.set('contratos', [{ data: null, error: null }, ...(queues.get('contratos') ?? [])]);
  return iniciarContrato(EXP, USER, ROL);
}

describe('flag CONTRATOS_V3_ENABLED apagado', () => {
  beforeEach(() => {
    mockEnv.CONTRATOS_V3_ENABLED = false;
  });

  it('GET sin contrato enviado responde habilitado:false: acceso y una sola lectura', async () => {
    const e = await obtenerEstado(EXP, USER, ROL);
    expect(e).toEqual({ habilitado: false, bloqueos: [], avisos: [], resumen: null, contrato: null, enviado: null });
    expect(mockAssertAccess).toHaveBeenCalledWith(EXP, USER, ROL);
    expect(mockFrom.mock.calls.map(([t]) => t)).toEqual(['contratos']);
  });

  it('GET con un contrato ya enviado lo sigue mostrando (el flag no deja la firma ni el acta sin pantalla)', async () => {
    queues.set('contratos', [{ data: { id: CTO, estado: 'vigente' }, error: null }]);
    vi.mocked(estadoEnviado).mockResolvedValueOnce({ id: CTO, estado: 'vigente' } as never);
    const e = await obtenerEstado(EXP, USER, ROL);
    expect(e.enviado).toMatchObject({ id: CTO, estado: 'vigente' });
    expect(mockAssertAccess).toHaveBeenCalledWith(EXP, USER, ROL);
  });

  it('un borrador no se abre con el flag apagado', async () => {
    queues.set('contratos', [{ data: { id: CTO, estado: 'borrador' }, error: null }]);
    const e = await obtenerEstado(EXP, USER, ROL);
    expect(e.habilitado).toBe(false);
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
    const e = await obtener();
    expect(mockAssertAccess).toHaveBeenCalledWith(EXP, USER, ROL);
    expect(e.habilitado).toBe(true);
    expect(e.bloqueos).toEqual([]);
    expect(e.contrato).toBeNull();
    expect(e.resumen!.canon).toEqual({ evaluadoCop: 2_000_000, maximoSinNuevaEvaluacionCop: 2_300_000 });
    expect(JSON.stringify(e)).not.toContain('4000000');
    // La lectura del contrato excluye cancelados y finalizados (índice contratos_v3_vivo_uq).
    // La lectura liviana (E5/E6): el V3 más reciente no cancelado; un borrador cae al asistente.
    expect(opsDe('contratos', 'not')[0].args).toEqual(['destinacion', 'is', null]);
    expect(opsDe('contratos', 'neq')[0].args).toEqual(['estado', 'cancelado']);
    // La carga del asistente trae también los cancelados (el último V3 precarga el borrador nuevo).
    expect(opsDe('contratos', 'neq')[1].args).toEqual(['estado', 'finalizado']);
  });

  it('con un contrato TERMINADO (el más reciente) muestra el contrato, no "Iniciar contrato"', async () => {
    queues.set('contratos', [{ data: { id: CTO, estado: 'finalizado' }, error: null }]);
    vi.mocked(estadoEnviado).mockResolvedValueOnce({ id: CTO, estado: 'finalizado' } as never);
    const e = await obtenerEstado(EXP, USER, ROL);
    expect(e.enviado).toMatchObject({ id: CTO, estado: 'finalizado' });
    expect(estadoEnviado).toHaveBeenCalledWith(CTO);
    // Con dos filas V3 (una terminada y otra cancelada, por ejemplo) maybeSingle no debe fallar.
    expect(opsDe('contratos', 'order')[0].args).toEqual(['created_at', { ascending: false }]);
    expect(opsDe('contratos', 'limit')[0].args).toEqual([1]);
  });

  it('si el más reciente es un borrador, manda el asistente (aunque haya uno terminado antes)', async () => {
    queues.set('contratos', [{ data: { id: 'otro', estado: 'borrador' }, error: null }]);
    encolarCarga();
    const e = await obtenerEstado(EXP, USER, ROL);
    expect(e.enviado ?? null).toBeNull();
    expect(estadoEnviado).not.toHaveBeenCalled();
  });

  it('un error de lectura es 503 LECTURA_NO_VERIFICABLE', async () => {
    encolarCarga({ expedienteError: true });
    const e = await error(obtener());
    expect(e).toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
  });

  it('tarifa con coarrendatario y ningún coarrendatario vinculado es 503 (nunca "solo")', async () => {
    mockTarifas.mockResolvedValue({ tarifas: { ...TARIFAS, con_coarrendatario: true } });
    encolarCarga();
    const e = await error(obtener());
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

    const r = await iniciar();

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
    const r = await iniciar();
    expect(r.creado).toBe(false);
    expect(r.estado.contrato!.id).toBe(CTO);
    // Adenda 1 contratos, respuesta 15: iniciado el lunes 14, la reserva va hasta el lunes 21.
    expect(r.estado.contrato!.reservadoHasta).toBe('2026-09-21');
    expect(mockReservar).not.toHaveBeenCalled();
    expect(opsDe('contratos', 'insert')).toHaveLength(0);
  });

  it('tras cancelarse por reserva vencida, el contrato nuevo precarga lo que llevaba', async () => {
    const cancelado = fila({ estado: 'cancelado', datos_variables: { asistente: COMPLETO } });
    encolarCarga({ contratos: [cancelado] });
    enqueue('contratos', { data: fila({ id: 'cto-2', numero: 'CTO-2026-0008', created_at: '2026-09-15T15:00:00.000Z' }), error: null });

    const r = await iniciar();

    expect(r.creado).toBe(true);
    const c = r.estado.contrato!;
    expect(c.guardados).toEqual({});
    expect(c.prefill[1]).toEqual(COMPLETO.paso1);
    expect(c.prefill[2]).toEqual(COMPLETO.paso2);
    expect(c.prefill[3]).toMatchObject({ vigenciaMeses: 12, comisionPct: 8, fechaInicio: '2026-10-01' });
    expect(c.prefill[5]).toEqual(COMPLETO.paso5);
    // La reserva nueva corre desde el nuevo inicio.
    expect(c.reservadoHasta).toBe('2026-09-22');
  });

  it('23505 (otra pestaña ganó): devuelve la fila existente, NO libera y avisa si esta petición reservó', async () => {
    mockReservar.mockImplementation(async () => {
      ops.push({ table: 'fn', method: 'reservar', args: [] });
      return reserva({ afectados: [AFECTADO] });
    });
    encolarCarga();
    enqueue('contratos', { data: null, error: { code: '23505', message: 'duplicate key' } });
    encolarCarga({ contratos: [fila()] });

    const r = await iniciar();

    expect(r.creado).toBe(false);
    expect(r.estado.contrato!.id).toBe(CTO);
    expect(mockLiberar).not.toHaveBeenCalled();
    // Solo esta petición recibió los afectados; el contrato vivo existe → se avisa aquí.
    expect(mockAvisar).toHaveBeenCalledTimes(1);
  });

  it('otro error del INSERT con reservado:true libera la reserva y no avisa', async () => {
    mockReservar.mockImplementation(async () => reserva({ afectados: [AFECTADO] }));
    encolarCarga();
    enqueue('contratos', { data: null, error: { code: '57014', message: 'timeout' } });

    const e = await error(iniciar());

    expect(e.statusCode).toBe(500);
    expect(mockLiberar).toHaveBeenCalledWith(EXP);
    expect(mockAvisar).not.toHaveBeenCalled();
  });

  it('otro error del INSERT con ya_reservado NO libera (la reserva ya era de este estudio)', async () => {
    mockReservar.mockResolvedValue(reserva({ reservado: false, ya_reservado: true }));
    encolarCarga();
    enqueue('contratos', { data: null, error: { code: '57014', message: 'timeout' } });

    const e = await error(iniciar());

    expect(e.statusCode).toBe(500);
    expect(mockLiberar).not.toHaveBeenCalled();
  });

  it('un estudio que ya tuvo su contrato (en firma, activo o terminado) no inicia otro: 409', async () => {
    queues.set('contratos', [{ data: { id: CTO, estado: 'finalizado' }, error: null }]);
    const e = await error(iniciarContrato(EXP, USER, ROL));
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_YA_EXISTE' });
    expect(mockReservar).not.toHaveBeenCalled();
  });

  it('con un bloqueo responde 409 CONTRATO_BLOQUEADO y nunca reserva', async () => {
    encolarCarga({ estado: 'en_revision' });

    const e = await error(iniciar());

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
    expect(opsDe('inmuebles', 'update').map((o) => o.args[0])).toEqual([
      { propiedad_horizontal: true, nombre_copropiedad: 'Edificio Torres del Parque' },
    ]);
    expect(opsDe('inmuebles', 'eq').map((o) => o.args)).toEqual([['id', 'inm-1']]);
  });

  it('§1.4: los usos conexos con su número y la cuota de administración vuelven al registro del inmueble', async () => {
    encolarCarga({ contratos: [fila()], propiedadHorizontal: true, copropiedad: 'Edificio Torres del Parque' });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()], propiedadHorizontal: true, copropiedad: 'Edificio Torres del Parque' });
    await guardarPaso(EXP, { ...PASO2_PH, datos: { ...PASO2_PH.datos, usos: { carro: '12', moto: null, util: 'D-3' } } }, USER, ROL);
    expect(opsDe('inmuebles', 'update').map((o) => o.args[0])).toEqual([
      { parqueadero: true, parqueadero_numero: '12', cuarto_util: true, cuarto_util_numero: 'D-3' },
    ]);

    encolarCarga({ contratos: [fila()], propiedadHorizontal: true, copropiedad: 'Edificio Torres del Parque' });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()], propiedadHorizontal: true, copropiedad: 'Edificio Torres del Parque' });
    const adm = { aCargoDe: 'arrendatario' as const, valorCop: 350000, incluidaEnCanon: false };
    await guardarPaso(EXP, { paso: 3, datos: { ...COMPLETO.paso3!, administracion: adm } }, USER, ROL);
    expect(opsDe('inmuebles', 'update').map((o) => o.args[0]).at(-1)).toEqual({ administracion: 350000 });
  });

  it('§1.4: si el registro del inmueble no se puede escribir → 503 (el paso ya quedó guardado; guardar de nuevo reintenta)', async () => {
    encolarCarga({ contratos: [fila()], propiedadHorizontal: false });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    enqueue('inmuebles', { data: null, error: { message: 'timeout' } });
    const e = await error(guardarPaso(EXP, PASO2_PH, USER, ROL));
    expect(e).toMatchObject({ statusCode: 503, errorCode: 'INMUEBLE_NO_ACTUALIZADO' });
    expect(opsDe('contratos', 'update')).toHaveLength(1);
  });

  it('volver a guardar un paso sin cambios conserva actualizadoEn (la vista previa sigue vigente)', async () => {
    // El jsonb reordena las claves: se compara por contenido.
    const guardado = { ...COMPLETO, paso2: { nombreCopropiedad: 'Edificio Torres del Parque', ...PASO2_PH.datos }, actualizadoEn: 'antes' };
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: guardado } })], propiedadHorizontal: true });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()], propiedadHorizontal: true });

    await guardarPaso(EXP, PASO2_PH, USER, ROL);

    const upd = opsDe('contratos', 'update')[0].args[0] as { datos_variables: { asistente: Asistente } };
    expect(upd.datos_variables.asistente.actualizadoEn).toBe('antes');
  });

  it('paso 2 igual al registro del inmueble no lo toca', async () => {
    encolarCarga({ contratos: [fila()], propiedadHorizontal: true, copropiedad: 'Edificio Torres del Parque' });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()], propiedadHorizontal: true, copropiedad: 'Edificio Torres del Parque' });

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

describe('tope de canon: bloqueo y escalamiento a la Gerencia General (Adenda 1 contratos §2.4)', () => {
  const PASO1_ALTO = { ...COMPLETO.paso1!, canonCop: 3_100_000 };

  it('guardar el paso 1 por encima del tope bloquea con el mensaje de la Gerencia y escala el caso', async () => {
    encolarCarga({ contratos: [fila()] });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: { paso1: PASO1_ALTO } } })] });

    const e = await guardarPaso(EXP, { paso: 1, datos: PASO1_ALTO }, USER, ROL);

    const b = e.bloqueos.find((x) => x.codigo === 'CANON_EXCEDE_TOPE');
    expect(b?.mensaje).toContain('El caso se envió a la Gerencia General de Cofianza para evaluar un coafianzamiento');
    expect(mockEscalar).toHaveBeenCalledWith(EXP, 3_100_000, 3_000_000);
  });

  it('el GET con el paso 1 guardado por encima del tope también escala (el aviso se deduplica por estudio)', async () => {
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: { paso1: PASO1_ALTO } } })] });
    await obtener();
    expect(mockEscalar).toHaveBeenCalledTimes(1);
  });

  it('dentro del tope (o sin paso 1 guardado) no escala', async () => {
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: { paso1: COMPLETO.paso1 } } })] });
    await obtener();
    // Sin paso 1 guardado no hay canon pactado: el del registro, a lo sumo, avisa.
    encolarCarga({ contratos: [fila()] });
    await obtener();
    expect(mockEscalar).not.toHaveBeenCalled();
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

  it('el mismo celular en dos firmantes → 422 FIRMANTES_INVALIDOS antes de renderizar', async () => {
    const c = COMPLETO.paso5!.contactos;
    const repetido = { ...COMPLETO, paso5: { ...COMPLETO.paso5!, contactos: { ...c, arrendador: { ...c.arrendador, telefono: c.arrendatario.telefono } } } };
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: repetido } })] });

    const e = await error(generarVistaPrevia(EXP, USER, ROL));

    expect(e).toMatchObject({ statusCode: 422, errorCode: 'FIRMANTES_INVALIDOS' });
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

// ============================================================
// Entrega 4 — paso 4 con cláusulas adicionales (diseño §5.3, §8)
// ============================================================

interface FilaCl {
  id: string;
  inmobiliaria_id: string | null;
  titulo: string;
  texto: string;
  version: number;
  estado: string;
  validacion: { reglas: string; ia: ClausulaEnContrato['ia'] } | null;
  inhabilitada_motivo: string | null;
}
const cl = (id: string, o: Partial<FilaCl> = {}): FilaCl => ({
  id,
  inmobiliaria_id: 'org-1',
  titulo: 'Cuidado del jardín',
  texto: 'EL ARRENDATARIO mantendrá el jardín del inmueble podado y regado.',
  version: 1,
  estado: 'activa',
  validacion: { reglas: 'v1', ia: null },
  inhabilitada_motivo: null,
  ...o,
});
const BIBLIO = cl('bib-1', {
  inmobiliaria_id: null,
  titulo: 'Parqueadero asignado',
  texto: 'EL ARRENDATARIO usará el parqueadero [[número del parqueadero]] del edificio y lo mantendrá despejado.',
  version: 2,
});
const PROPIA = cl('pro-1');
/** Un modelo sin [[campos]]: sin cambios es solo texto de Cofianza (resp. 13). */
const MODELO = cl('bib-2', {
  inmobiliaria_id: null,
  titulo: 'Zonas comunes',
  texto: 'EL ARRENDATARIO respetará el reglamento de las zonas comunes del edificio.',
});
/** BIBLIO como queda en el paso 4, con su [[campo]] lleno. */
const BIBLIO_12 = { texto: 'EL ARRENDATARIO usará el parqueadero 12 del edificio y lo mantendrá despejado.', valores: { 'número del parqueadero': '12' } };
/** La aceptación sin su huella: la huella es la de lo que cubre en cada lista (resp. 13). */
const ACEPTACION: Omit<AceptacionClausulas, 'huella'> = {
  usuarioId: USER,
  nombre: 'Laura Gómez',
  email: 'laura@inmo.co',
  rolMiembro: 'miembro',
  en: '2026-09-15T14:30:00.000Z',
  ip: '10.0.0.1',
  avisoVersion: AVISO_VERSION,
};
/** Lo que el paso 4 guarda de una fila del catálogo (valores ya llenos). */
const snap = (f: FilaCl, o: Partial<ClausulaEnContrato> = {}): ClausulaEnContrato => ({
  clausulaId: f.id,
  origen: f.inmobiliaria_id ? 'propia' : 'biblioteca',
  version: f.version,
  titulo: f.titulo,
  texto: f.texto,
  valores: null,
  ia: null,
  ...o,
});
/** Resp. 13: la aceptación cubre las propias y los modelos con datos (los datos son de la inmobiliaria). */
const aceptacionDe = (cs: ClausulaEnContrato[]): AceptacionClausulas | null => {
  const cubiertas = cs.filter((c) => c.origen === 'propia' || c.valores !== null);
  return cubiertas.length ? { ...ACEPTACION, huella: huella(cubiertas) } : null;
};
const paso4De = (cs: ClausulaEnContrato[]): Paso4 => ({ clausulas: cs, huella: huella(cs), aceptacion: aceptacionDe(cs) });
const catalogoDe = (fs: FilaCl[]) =>
  fs.map(({ id, inmobiliaria_id, titulo, texto, estado, version, inhabilitada_motivo }) => ({
    id,
    inmobiliaria_id,
    titulo,
    texto,
    estado,
    version,
    inhabilitada_motivo,
  }));
const conPaso4 = (p4: Paso4, extra: Partial<Asistente> = {}) =>
  fila({ datos_variables: { asistente: { ...COMPLETO, paso4: p4, ...extra } } });
const entrada = (clausulas: { clausulaId: string; valores?: Record<string, string> }[], avisoVersion = AVISO_VERSION) => ({
  paso: 4 as const,
  datos: { clausulas, aceptoResponsabilidad: true as const, avisoVersion },
});
const codigos = (e: EstadoAsistente) => e.bloqueos.map((b) => b.codigo);
const ONCE = Array.from({ length: 11 }, (_, k) => cl(`pro-${k + 1}`, { titulo: `Obligación ${k + 1}` }));

describe('paso 4: quién incorpora cláusulas (D5)', () => {
  it('un operador que envía cláusulas → 403, sin leer el catálogo ni escribir', async () => {
    encolarCarga({ contratos: [fila()] });
    const e = await error(guardarPaso(EXP, entrada([{ clausulaId: 'pro-1' }]), USER, 'operador_analista'));
    expect(e).toMatchObject({ statusCode: 403, errorCode: 'CLAUSULAS_SOLO_INMOBILIARIA' });
    expect(ops.some((o) => o.table === 'clausulas_adicionales')).toBe(false);
    expect(opsDe('contratos', 'update')).toHaveLength(0);
  });

  it('una inmobiliaria que entra por propietario_id pero es de otra org → 403', async () => {
    mockMembresias.mockResolvedValue(['org-2']);
    encolarCarga({ contratos: [fila()] });
    const e = await error(guardarPaso(EXP, entrada([{ clausulaId: 'pro-1' }]), USER, ROL));
    expect(e).toMatchObject({ statusCode: 403, errorCode: 'CLAUSULAS_SOLO_INMOBILIARIA' });
    expect(mockMembresias).toHaveBeenCalledWith(USER);
  });

  it('{ omitir: true } se guarda como siempre, para cualquier rol, sin mirar la membresía', async () => {
    encolarCarga({ contratos: [fila()] });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()] });

    await guardarPaso(EXP, { paso: 4, datos: { omitir: true } }, USER, 'operador_analista');

    const upd = opsDe('contratos', 'update')[0].args[0] as { datos_variables: { asistente: Asistente } };
    expect(upd.datos_variables.asistente.paso4).toEqual({ omitir: true });
    expect(mockMembresias).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('paso 4: validación al guardar', () => {
  const UUID = '4f7c2a9e-1b3d-4c5e-8f6a-7b8c9d0e1f2a';

  it('schema: la aceptación es opcional (el service la exige con propias) pero no puede ser false; ids repetidos no pasan; omitir sí', () => {
    const lista = { clausulas: [{ clausulaId: UUID }], avisoVersion: AVISO_VERSION };
    expect(guardarPasoSchema.safeParse({ paso: 4, datos: lista }).success).toBe(true);
    const enFalse = guardarPasoSchema.safeParse({ paso: 4, datos: { ...lista, aceptoResponsabilidad: false } });
    expect(enFalse.success).toBe(false);
    expect(enFalse.error!.issues[0].message).toMatch(/Acepta el aviso de responsabilidad/);
    const repetidas = guardarPasoSchema.safeParse(entrada([{ clausulaId: UUID }, { clausulaId: UUID }]));
    expect(repetidas.error!.issues[0].message).toBe('Una cláusula está repetida');
    const valor = guardarPasoSchema.safeParse(entrada([{ clausulaId: UUID, valores: { puesto: '  12\n B ' } }]));
    expect(valor.data).toMatchObject({ datos: { clausulas: [{ valores: { puesto: '12 B' } }] } });
    expect(guardarPasoSchema.safeParse({ paso: 4, datos: { omitir: true } }).success).toBe(true);
  });

  it('avisoVersion vieja con una propia → 409 AVISO_CAMBIADO, sin escribir', async () => {
    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: [PROPIA], error: null });
    const e = await error(guardarPaso(EXP, entrada([{ clausulaId: 'pro-1' }], '2026-01-01'), USER, ROL));
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'AVISO_CAMBIADO' });
    expect(opsDe('contratos', 'update')).toHaveLength(0);
  });

  it('resp. 13: una propia sin aceptar el aviso → 400 ACEPTACION_REQUERIDA, sin escribir', async () => {
    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: [BIBLIO, PROPIA], error: null });
    const sinAceptar = {
      paso: 4 as const,
      datos: {
        clausulas: [{ clausulaId: 'bib-1', valores: BIBLIO_12.valores }, { clausulaId: 'pro-1' }],
        avisoVersion: AVISO_VERSION,
      },
    };
    const e = await error(guardarPaso(EXP, sinAceptar, USER, ROL));
    expect(e).toMatchObject({ statusCode: 400, errorCode: 'ACEPTACION_REQUERIDA' });
    expect(opsDe('contratos', 'update')).toHaveLength(0);
  });

  it('resp. 13: solo modelos sin datos se guardan sin aceptación (texto de Cofianza), aunque el aviso sea viejo, y sin bitácora de aceptación', async () => {
    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: [MODELO], error: null });
    enqueue('perfiles', { data: { nombre: 'Laura', apellido: 'Gómez' }, error: null }); // se lee en paralelo; no hace falta
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()] });

    const soloModelo = { paso: 4 as const, datos: { clausulas: [{ clausulaId: 'bib-2' }], avisoVersion: '2026-01-01' } };
    await guardarPaso(EXP, soloModelo, USER, ROL, '10.0.0.1', 'laura@inmo.co');

    const upd = opsDe('contratos', 'update')[0].args[0] as { datos_variables: { asistente: Asistente } };
    const esperadas = [snap(MODELO)];
    expect(upd.datos_variables.asistente.paso4).toEqual({ clausulas: esperadas, huella: huella(esperadas), aceptacion: null });
    // No se aceptó nada: no hay CONTRATO_CLAUSULAS_ACEPTADAS.
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('resp. 13: los datos que la inmobiliaria completa en un modelo son suyos: sin aceptar → 400; aceptados, la huella los cubre', async () => {
    const soloBiblio = (acepto: boolean, valor = '12') => ({
      paso: 4 as const,
      datos: {
        clausulas: [{ clausulaId: 'bib-1', valores: { 'número del parqueadero': valor } }],
        ...(acepto ? { aceptoResponsabilidad: true as const } : {}),
        avisoVersion: AVISO_VERSION,
      },
    });
    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: [BIBLIO], error: null });
    const e = await error(guardarPaso(EXP, soloBiblio(false), USER, ROL));
    expect(e).toMatchObject({ statusCode: 400, errorCode: 'ACEPTACION_REQUERIDA' });
    expect(opsDe('contratos', 'update')).toHaveLength(0);

    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: [BIBLIO], error: null });
    enqueue('perfiles', { data: { nombre: 'Laura', apellido: 'Gómez' }, error: null });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()] });
    await guardarPaso(EXP, soloBiblio(true), USER, ROL, '10.0.0.1', 'laura@inmo.co');

    const upd = opsDe('contratos', 'update')[0].args[0] as { datos_variables: { asistente: { paso4: Paso4 } } };
    const p4 = upd.datos_variables.asistente.paso4 as Extract<Paso4, { clausulas: unknown }>;
    expect(p4.clausulas[0].origen).toBe('biblioteca'); // el texto sigue siendo de Cofianza
    expect(p4.aceptacion?.huella).toBe(huella([snap(BIBLIO, BIBLIO_12)]));
    expect(p4.aceptacion?.huella).not.toBe(
      huella([snap(BIBLIO, { ...BIBLIO_12, texto: BIBLIO_12.texto.replace('12', '14') })]),
    );
  });

  it('una cláusula de otra org → 422 CLAUSULA_NO_DISPONIBLE con su índice y sin su título', async () => {
    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', {
      data: [PROPIA, cl('ajena', { inmobiliaria_id: 'org-2', titulo: 'Secreta de otra org' })],
      error: null,
    });
    const e = await error(guardarPaso(EXP, entrada([{ clausulaId: 'pro-1' }, { clausulaId: 'ajena' }]), USER, ROL));
    expect(e).toMatchObject({ statusCode: 422, errorCode: 'CLAUSULA_NO_DISPONIBLE', details: { indice: 1 } });
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain('Secreta');
    expect(opsDe('contratos', 'update')).toHaveLength(0);
  });

  it('una cláusula inhabilitada → 422 al guardar', async () => {
    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: [cl('pro-1', { estado: 'inhabilitada' })], error: null });
    const e = await error(guardarPaso(EXP, entrada([{ clausulaId: 'pro-1' }]), USER, ROL));
    expect(e).toMatchObject({ statusCode: 422, errorCode: 'CLAUSULA_NO_DISPONIBLE' });
  });

  it('un [[campo]] sin valor → 422 CLAUSULA_CAMPOS; una propia no admite valores', async () => {
    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: [BIBLIO], error: null });
    const e = await error(guardarPaso(EXP, entrada([{ clausulaId: 'bib-1' }]), USER, ROL));
    expect(e).toMatchObject({ statusCode: 422, errorCode: 'CLAUSULA_CAMPOS', details: { indice: 0 } });
    expect(e.message).toBe('Completa los datos de la cláusula «Parqueadero asignado»: número del parqueadero.');

    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: [PROPIA], error: null });
    const p = await error(guardarPaso(EXP, entrada([{ clausulaId: 'pro-1', valores: { x: '1' } }]), USER, ROL));
    expect(p).toMatchObject({ statusCode: 422, errorCode: 'CLAUSULA_CAMPOS' });
  });

  it('el valor "depósito en dinero" → 422 deposito sobre el texto FINAL, con índice', async () => {
    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: [PROPIA, BIBLIO], error: null });
    const e = await error(
      guardarPaso(
        EXP,
        entrada([{ clausulaId: 'pro-1' }, { clausulaId: 'bib-1', valores: { 'número del parqueadero': 'depósito en dinero' } }]),
        USER,
        ROL,
      ),
    );
    expect(e).toMatchObject({ statusCode: 422, errorCode: 'CLAUSULA_NO_PERMITIDA' });
    const d = e.details as { hallazgos: { codigo: string; indice: number; fragmento: string }[] };
    expect(d.hallazgos).toEqual([expect.objectContaining({ codigo: 'deposito', indice: 1, fragmento: 'depósito en dinero' })]);
    expect(opsDe('contratos', 'update')).toHaveLength(0);
  });

  it('éxito: guarda el texto final, la huella y la aceptación, y lo deja en la bitácora', async () => {
    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: [BIBLIO, PROPIA], error: null });
    enqueue('perfiles', { data: { nombre: 'Laura', apellido: 'Gómez' }, error: null });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()] });

    await guardarPaso(
      EXP,
      entrada([{ clausulaId: 'pro-1' }, { clausulaId: 'bib-1', valores: { 'número del parqueadero': '12' } }]),
      USER,
      ROL,
      '10.0.0.1',
      'laura@inmo.co',
    );

    const upd = opsDe('contratos', 'update')[0].args[0] as { datos_variables: { asistente: Asistente } };
    const esperadas = [
      snap(PROPIA),
      snap(BIBLIO, BIBLIO_12),
    ];
    expect(upd.datos_variables.asistente.paso4).toEqual({
      clausulas: esperadas,
      huella: huella(esperadas),
      // Resp. 13: la aceptación cubre la propia y el modelo, por el dato que completó la inmobiliaria.
      aceptacion: { ...ACEPTACION, en: '2026-09-15T15:00:00.000Z', huella: huella(esperadas) },
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'contrato_clausulas_aceptadas',
        entidadId: CTO,
        ip: '10.0.0.1',
        detalle: expect.objectContaining({
          huella: huella(esperadas),
          aviso_version: AVISO_VERSION,
          email: 'laura@inmo.co',
          clausulas: [
            { id: 'pro-1', version: 1, origen: 'propia' },
            { id: 'bib-1', version: 2, origen: 'biblioteca' },
          ],
        }),
      }),
    );
  });

  it('11 cláusulas se guardan (pasar el máximo no impide guardar) y quedan bloqueadas', async () => {
    const p4 = paso4De(ONCE.map((f) => snap(f)));
    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: ONCE, error: null });
    enqueue('perfiles', { data: { nombre: 'Laura', apellido: 'Gómez' }, error: null });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [conPaso4(p4)], catalogo: catalogoDe(ONCE) });

    const estado = await guardarPaso(EXP, entrada(ONCE.map((f) => ({ clausulaId: f.id }))), USER, ROL, '10.0.0.1', 'x@y.co');

    const upd = opsDe('contratos', 'update')[0].args[0] as { datos_variables: { asistente: { paso4: Paso4 } } };
    expect(upd.datos_variables.asistente.paso4).toMatchObject({ huella: p4.huella });
    expect(codigos(estado)).toEqual(['ADICIONALES_EXCEDEN_LIMITE']);
    expect(estado.bloqueos[0]).toMatchObject({
      paso: 4,
      mensaje: expect.stringContaining('tiene 11 cláusulas adicionales y el máximo es 10'),
    });
  });
});

describe('paso 4: estado (GET) y bloqueos', () => {
  it('ordinales desde la primera adicional de ESTE contrato, aviso y máximo', async () => {
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: COMPLETO } })] });
    const e = await obtener();
    // Sin coarrendatario ni PH, con comisión: 31 cláusulas → la 1.ª adicional es la 32.
    expect(e.contrato!.adicionales).toMatchObject({ maximo: 10, excesoAutorizado: null, aviso: { version: AVISO_VERSION } });
    expect(e.contrato!.adicionales.ordinales).toHaveLength(25);
    expect(e.contrato!.adicionales.ordinales[0]).toBe('TRIGÉSIMA SEGUNDA');
    expect(e.contrato!.adicionales.ordinales[24]).toBe('QUINCUAGÉSIMA SEXTA');
    expect(ops.some((o) => o.table === 'clausulas_adicionales')).toBe(false);
  });

  it('una cláusula inhabilitada después de guardar es bloqueo con el motivo; una versión nueva, aviso', async () => {
    const p4 = paso4De([snap(PROPIA), snap(BIBLIO, BIBLIO_12)]);
    encolarCarga({
      contratos: [conPaso4(p4)],
      catalogo: catalogoDe([
        cl('pro-1', { estado: 'inhabilitada', inhabilitada_motivo: 'Cita una norma derogada' }),
        { ...BIBLIO, version: 3 },
      ]),
    });
    const e = await obtener();
    expect(opsDe('clausulas_adicionales', 'in')[0].args).toEqual(['id', ['pro-1', 'bib-1']]);
    expect(e.bloqueos).toEqual([
      {
        codigo: 'CLAUSULA_INHABILITADA',
        mensaje: 'Cofianza inhabilitó la cláusula «Cuidado del jardín»: Cita una norma derogada. Quítala del contrato para continuar.',
        paso: 4,
      },
    ]);
    expect(e.avisos).toEqual([
      'Hay una versión más reciente de «Parqueadero asignado». Si vuelves a guardar el paso 4, el contrato usará la nueva.',
    ]);
  });

  it('resp. 13: un modelo que ya no coincide con el suyo (misma versión) bloquea; con otra versión solo avisa', async () => {
    const p4 = paso4De([snap(BIBLIO, BIBLIO_12)]);
    encolarCarga({ contratos: [conPaso4(p4)], catalogo: catalogoDe([{ ...BIBLIO, texto: `${BIBLIO.texto} Pagará $50.000.` }]) });
    expect(codigos(await obtener())).toEqual(['CLAUSULA_MODELO_ALTERADO']);

    encolarCarga({ contratos: [conPaso4(p4)], catalogo: catalogoDe([BIBLIO]) });
    expect(codigos(await obtener())).toEqual([]);
  });

  it('resp. 13: una aceptación que no cubre exactamente lo que debe, o de un aviso anterior, bloquea; solo modelos sin datos no la necesitan', async () => {
    const cs = [snap(BIBLIO, BIBLIO_12), snap(PROPIA)];
    const sinHuella = { ...paso4De(cs), aceptacion: { ...ACEPTACION } as AceptacionClausulas }; // anterior a la regla
    encolarCarga({ contratos: [conPaso4(sinHuella)], catalogo: catalogoDe([BIBLIO, PROPIA]) });
    expect(codigos(await obtener())).toEqual(['ACEPTACION_PENDIENTE']);

    const soloPropia = { ...paso4De(cs), aceptacion: { ...ACEPTACION, huella: huella([snap(PROPIA)]) } }; // sin el modelo con datos
    encolarCarga({ contratos: [conPaso4(soloPropia)], catalogo: catalogoDe([BIBLIO, PROPIA]) });
    expect(codigos(await obtener())).toEqual(['ACEPTACION_PENDIENTE']);

    // El aviso cambió después de aceptar: generar y enviar esperan una aceptación nueva.
    const p4 = paso4De(cs);
    const avisoViejo = { ...p4, aceptacion: { ...p4.aceptacion!, avisoVersion: '2026-09-21' } };
    encolarCarga({ contratos: [conPaso4(avisoViejo)], catalogo: catalogoDe([BIBLIO, PROPIA]) });
    expect(codigos(await obtener())).toEqual(['ACEPTACION_PENDIENTE']);

    encolarCarga({ contratos: [conPaso4(paso4De([snap(MODELO)]))], catalogo: catalogoDe([MODELO]) });
    const e = await obtener();
    expect(codigos(e)).toEqual([]);
    expect(e.contrato!.adicionales.aviso).toMatchObject({
      version: AVISO_VERSION,
      modelos: expect.stringContaining('Los datos que la inmobiliaria completa en un modelo sí son de su responsabilidad'),
      texto: expect.stringContaining('los datos que la inmobiliaria completa en los modelos'),
    });
  });

  it('un error al leer el catálogo es 503 (fail-closed)', async () => {
    encolarCarga({ contratos: [conPaso4(paso4De([snap(PROPIA)]))] });
    enqueue('clausulas_adicionales', { data: null, error: { message: 'timeout' } });
    const e = await error(obtener());
    expect(e).toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
  });

  it('resp. 13 bis: con CLAUSULAS_IA_ENABLED encendido la IA nunca bloquea a la inmobiliaria', async () => {
    mockEnv.CLAUSULAS_IA_ENABLED = true;
    encolarCarga({ contratos: [conPaso4(paso4De([snap(PROPIA)]))], catalogo: catalogoDe([PROPIA]) });
    expect(codigos(await obtener())).toEqual([]);

    // Guardar tampoco la llama (sin llave, antes era 503).
    encolarCarga({ contratos: [fila()] });
    enqueue('clausulas_adicionales', { data: [PROPIA], error: null });
    enqueue('perfiles', { data: { nombre: 'Laura', apellido: 'Gómez' }, error: null });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()] });
    await guardarPaso(EXP, entrada([{ clausulaId: 'pro-1' }]), USER, ROL, '10.0.0.1', 'laura@inmo.co');
    const upd = opsDe('contratos', 'update')[0].args[0] as { datos_variables: { asistente: { paso4: Paso4 } } };
    expect(upd.datos_variables.asistente.paso4).toMatchObject({ clausulas: [{ clausulaId: 'pro-1', ia: null }] });
  });

  it('una regla endurecida frena el borrador: el coarrendatario mencionado sin coarrendatario', async () => {
    const texto = 'EL COARRENDATARIO mantendrá el jardín del inmueble podado y regado.';
    encolarCarga({ contratos: [conPaso4(paso4De([snap(PROPIA, { texto })]))], catalogo: catalogoDe([PROPIA]) });
    const e = await obtener();
    expect(e.bloqueos).toEqual([expect.objectContaining({ codigo: 'CLAUSULA_NO_PERMITIDA', paso: 4 })]);
    expect(e.bloqueos[0].mensaje).toMatch(/^«Cuidado del jardín»: Este contrato no tiene coarrendatario/);
  });

  it('contarClausulas sin una condición que usa la plantilla → 500, nunca un número a medias', () => {
    expect(() => contarClausulas(PLANTILLA_VIVIENDA, { coa: true })).toThrow(AppError);
  });
});

describe('autorizarExceso (D6)', () => {
  const P4 = paso4De(ONCE.map((f) => snap(f)));

  it('una huella que no es la vigente → 409 CONTRATO_BORRADOR_CAMBIADO, sin escribir', async () => {
    encolarCarga({ contratos: [conPaso4(P4)], catalogo: catalogoDe(ONCE) });
    const e = await error(autorizarExceso(EXP, 'f'.repeat(64), 'admin-1', 'administrador'));
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_BORRADOR_CAMBIADO' });
    expect(opsDe('contratos', 'update')).toHaveLength(0);
  });

  it('la huella vigente autoriza sin tocar actualizadoEn y quita el bloqueo', async () => {
    encolarCarga({ contratos: [conPaso4(P4)], catalogo: catalogoDe(ONCE) });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    const autorizado = { huella: P4.huella, cantidad: 11, usuarioId: 'admin-1', en: '2026-09-15T15:00:00.000Z' };
    encolarCarga({ contratos: [conPaso4(P4, { excesoAutorizado: autorizado })], catalogo: catalogoDe(ONCE) });

    const estado = await autorizarExceso(EXP, P4.huella, 'admin-1', 'administrador', '10.0.0.9');

    const upd = opsDe('contratos', 'update')[0].args[0] as { datos_variables: { asistente: Asistente } };
    expect(upd.datos_variables.asistente.excesoAutorizado).toEqual(autorizado);
    expect(upd.datos_variables.asistente.actualizadoEn).toBe(COMPLETO.actualizadoEn);
    expect(opsDe('contratos', 'eq').map((o) => o.args)).toContainEqual(['updated_at', LEIDO]);
    expect(codigos(estado)).toEqual([]);
    expect(estado.contrato!.adicionales.excesoAutorizado).toEqual({ huella: P4.huella, cantidad: 11, en: autorizado.en });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'contrato_clausulas_exceso_autorizado', usuarioId: 'admin-1', ip: '10.0.0.9' }),
    );
  });

  it('avisa a quien inició el contrato y al responsable (sin repetir): la inmobiliaria no ve Soporte', async () => {
    encolarCarga({ contratos: [conPaso4(P4)], catalogo: catalogoDe(ONCE) });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [conPaso4(P4)], catalogo: catalogoDe(ONCE) });
    enqueue('contratos', { data: { generado_por: 'gestor-1' }, error: null });
    enqueue('expedientes', { data: { miembro_responsable_id: 'gestor-1' }, error: null });

    await autorizarExceso(EXP, P4.huella, 'admin-1', 'administrador');

    expect(mockNotificar).toHaveBeenCalledTimes(1);
    expect(mockNotificar).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'gestor-1', link: `/expedientes/${EXP}/contrato` }),
    );
  });

  it('cambiar la lista (otra huella) trae el bloqueo de vuelta', async () => {
    const otra = paso4De([...ONCE].reverse().map((f) => snap(f)));
    const viejo = { huella: P4.huella, cantidad: 11, usuarioId: 'admin-1', en: '2026-09-15T15:00:00.000Z' };
    encolarCarga({ contratos: [conPaso4(otra, { excesoAutorizado: viejo })], catalogo: catalogoDe(ONCE) });
    expect(codigos(await obtener())).toEqual(['ADICIONALES_EXCEDEN_LIMITE']);
  });

  it('sin pasar el máximo → 409 EXCESO_NO_APLICA', async () => {
    const dos = paso4De([snap(PROPIA), snap(BIBLIO, BIBLIO_12)]);
    encolarCarga({ contratos: [conPaso4(dos)], catalogo: catalogoDe([PROPIA, BIBLIO]) });
    const e = await error(autorizarExceso(EXP, dos.huella, 'admin-1', 'administrador'));
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'EXCESO_NO_APLICA' });
  });
});

describe('generar con adicionales', () => {
  it('pasa las adicionales al motor, guarda la huella y escribe el registro con numero = primera + k', async () => {
    const cs = [snap(BIBLIO, BIBLIO_12), snap(PROPIA)];
    const p4 = paso4De(cs);
    encolarCarga({ contratos: [conPaso4(p4)], catalogo: catalogoDe([BIBLIO, PROPIA]) });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    enqueue('contrato_partes', { data: null, error: null }, { data: null, error: null });
    enqueue('contrato_clausulas_adicionales', { data: null, error: null }, { data: null, error: null });
    encolarCarga({ contratos: [conPaso4(p4)], catalogo: catalogoDe([BIBLIO, PROPIA]) });

    await generarVistaPrevia(EXP, USER, ROL);

    expect(vi.mocked(generarContratoVivienda).mock.calls[0][1].adicionales).toEqual(
      cs.map(({ titulo, texto }) => ({ titulo, texto })),
    );
    const upd = opsDe('contratos', 'update')[0].args[0] as {
      datos_variables: { documento: { adicionales: unknown } };
    };
    expect(upd.datos_variables.documento.adicionales).toEqual({ huella: p4.huella, aceptacion: p4.aceptacion, primera: 32 });
    expect(opsDe('contrato_clausulas_adicionales', 'eq')[0].args).toEqual(['contrato_id', CTO]);
    expect(opsDe('contrato_clausulas_adicionales', 'insert')[0].args[0]).toEqual([
      { contrato_id: CTO, clausula_id: 'bib-1', orden: 1, numero: 32, version: 2, origen: 'biblioteca', titulo: cs[0].titulo, texto: cs[0].texto },
      { contrato_id: CTO, clausula_id: 'pro-1', orden: 2, numero: 33, version: 1, origen: 'propia', titulo: cs[1].titulo, texto: cs[1].texto },
    ]);
    expect(pos('contrato_partes', 'insert')).toBeLessThan(pos('contrato_clausulas_adicionales', 'delete'));
  });

  it('sin adicionales vacía el registro y no inserta; documento.adicionales = null', async () => {
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: COMPLETO } })] });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()] });

    await generarVistaPrevia(EXP, USER, ROL);

    expect(opsDe('contrato_clausulas_adicionales', 'delete')).toHaveLength(1);
    expect(opsDe('contrato_clausulas_adicionales', 'insert')).toHaveLength(0);
    const upd = opsDe('contratos', 'update')[0].args[0] as { datos_variables: { documento: { adicionales: unknown } } };
    expect(upd.datos_variables.documento.adicionales).toBeNull();
  });

  it('con una cláusula inhabilitada no genera (409 CONTRATO_BLOQUEADO) y la IA nunca corre', async () => {
    encolarCarga({
      contratos: [conPaso4(paso4De([snap(PROPIA)]))],
      catalogo: catalogoDe([cl('pro-1', { estado: 'inhabilitada', inhabilitada_motivo: 'x' })]),
    });
    const e = await error(generarVistaPrevia(EXP, USER, ROL));
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_BLOQUEADO' });
    expect(storageApi.upload).not.toHaveBeenCalled();
  });

  it('con una cláusula propia eliminada tampoco genera (409 CONTRATO_BLOQUEADO)', async () => {
    encolarCarga({
      contratos: [conPaso4(paso4De([snap(PROPIA)]))],
      catalogo: catalogoDe([cl('pro-1', { estado: 'eliminada' })]),
    });
    const e = await error(generarVistaPrevia(EXP, USER, ROL));
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_BLOQUEADO' });
    expect(storageApi.upload).not.toHaveBeenCalled();
  });

  it('si el registro no se escribe → 500 CONTRATO_PARTES_NO_GUARDADAS', async () => {
    const p4 = paso4De([snap(PROPIA)]);
    encolarCarga({ contratos: [conPaso4(p4)], catalogo: catalogoDe([PROPIA]) });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    enqueue('contrato_partes', { data: null, error: null }, { data: null, error: null });
    enqueue('contrato_clausulas_adicionales', { data: null, error: null }, { data: null, error: { message: 'check_violation' } });

    const e = await error(generarVistaPrevia(EXP, USER, ROL));

    expect(e).toMatchObject({ statusCode: 500, errorCode: 'CONTRATO_PARTES_NO_GUARDADAS' });
    expect(e.message).toContain('registro de cláusulas');
  });
});

// ============================================================
// Entrega 5: enviar a firma (diseño §13 casos 1-6)
// ============================================================

describe('enviar a firma y Ruta B (Entrega 5)', () => {
  const OK = { data: null, error: null };
  const KEY_PREVIA = `contratos/${EXP}/${CTO}/revision-1-1.pdf`;
  // A la firma va el CRC sin puntaje (Adenda 1, respuesta 5), no el completo 'certificados/est-1.pdf'.
  const CRC_KEY = 'certificados/est-1-firmantes.pdf';
  const AHORA = Date.parse('2026-09-15T15:00:00Z');
  const KEY_FINAL = `contratos/${EXP}/${CTO}/final-${AHORA}.pdf`;

  const PASOS = COMPLETO;
  const PASOS_B: Asistente = { ...PASOS, paso1: { ...PASOS.paso1!, ruta: 'B' }, paso4: undefined };

  async function pdfReal(paginas: number): Promise<Buffer> {
    const d = await PDFDocument.create();
    for (let i = 0; i < paginas; i++) d.addPage([200, 200]);
    return Buffer.from(await d.save());
  }
  const blob = (b: Buffer) => ({ arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  let archivos: Record<string, Buffer> = {};

  beforeEach(() => {
    archivos = {};
    storageApi.download.mockImplementation(async (...args: unknown[]) => {
      ops.push({ table: 'storage', method: 'download', args });
      const b = archivos[args[0] as string];
      return b ? { data: blob(b), error: null } : { data: null, error: { message: 'no' } };
    });
  });
  afterEach(() => {
    storageApi.download.mockImplementation(async (...args: unknown[]) => {
      ops.push({ table: 'storage', method: 'download', args });
      return { data: null, error: { message: 'no' } };
    });
  });

  /** La vista previa que la inmobiliaria revisó (la de generar), sin textos pendientes. */
  async function documentoRevisado(a: Asistente): Promise<DocumentoV3> {
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: a } })] });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    enqueue('contrato_partes', OK, OK);
    encolarCarga({ contratos: [fila()] });
    await generarVistaPrevia(EXP, USER, ROL);
    const dv = (opsDe('contratos', 'update')[0].args[0] as { datos_variables: { documento: DocumentoV3 } }).datos_variables;
    queues.clear();
    ops.length = 0;
    vi.mocked(crearSobre).mockClear();
    storageApi.upload.mockClear();
    storageApi.remove.mockClear();
    return { ...dv.documento, pendientes: [] };
  }
  const conDocumento = (a: Asistente, documento: DocumentoV3, extra: Record<string, unknown> = {}) =>
    fila({ storage_key: KEY_PREVIA, datos_variables: { asistente: a, documento, ...extra } });

  it('Ruta A: final, partes, CAS fuera de borrador, sobre y recién ahí se borra la vista previa', async () => {
    const doc = await documentoRevisado(PASOS);
    archivos[CRC_KEY] = await pdfReal(1);
    vi.mocked(generarContratoVivienda).mockResolvedValueOnce({ pdf: await pdfReal(3), pendientes: [], version: 'v', lineas: [] });
    vi.mocked(estadoEnviado).mockResolvedValueOnce({ id: CTO, estado: 'pendiente_firma' } as never);
    encolarCarga({ contratos: [conDocumento(PASOS, doc)] });
    enqueue('contrato_partes', OK, OK);
    enqueue('contratos', { data: [{ id: CTO }], error: null });

    const e = await enviarAFirma(EXP, { generacion: doc.generacion }, USER, ROL);

    expect(e.enviado).toMatchObject({ id: CTO, estado: 'pendiente_firma' });
    expect(vi.mocked(generarContratoVivienda).mock.calls.at(-1)![1]).toMatchObject({ modo: 'final', anclas: true });
    expect(crearSobre).toHaveBeenCalledWith(CTO, USER);
    const orden = [pos('storage', 'upload'), pos('contrato_partes', 'delete'), pos('contratos', 'update'), pos('storage', 'remove')];
    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((x, y) => x - y)).toEqual(orden);
    expect(storageApi.upload).toHaveBeenCalledWith(KEY_FINAL, expect.any(Buffer), expect.objectContaining({ upsert: false }));
    expect(storageApi.remove).toHaveBeenCalledWith([KEY_PREVIA]);
    const upd = opsDe('contratos', 'update')[0].args[0] as { estado: string; storage_key: string; datos_variables: { documento: DocumentoV3 } };
    expect(upd.estado).toBe('pendiente_firma');
    expect(upd.storage_key).toBe(KEY_FINAL);
    expect(upd.datos_variables.documento.final).toMatchObject({ ruta: 'A', paginas: [3, 1], crcKey: CRC_KEY, propioKey: null });
    const eqs = opsDe('contratos', 'eq').map((o) => o.args);
    expect(eqs).toContainEqual(['estado', 'borrador']);
    expect(eqs).toContainEqual(['updated_at', LEIDO]);
  });

  it('una vista previa vieja, o con datos que cambiaron, no se envía (sin subir nada)', async () => {
    const doc = await documentoRevisado(PASOS);
    encolarCarga({ contratos: [conDocumento(PASOS, doc)] });
    expect(await error(enviarAFirma(EXP, { generacion: doc.generacion + 1 }, USER, ROL))).toMatchObject({
      statusCode: 409,
      errorCode: 'VISTA_PREVIA_DESACTUALIZADA',
    });
    const otroCanon = { ...doc, entrada: { ...doc.entrada, canonCop: 1_000_000 } };
    encolarCarga({ contratos: [conDocumento(PASOS, otroCanon)] });
    expect(await error(enviarAFirma(EXP, { generacion: doc.generacion }, USER, ROL))).toMatchObject({
      errorCode: 'VISTA_PREVIA_DESACTUALIZADA',
    });
    expect(storageApi.upload).not.toHaveBeenCalled();
    expect(crearSobre).not.toHaveBeenCalled();
  });

  it('el GET marca desactualizada la vista previa con lo mismo que rechaza el envío (datos de hoy distintos)', async () => {
    const doc = await documentoRevisado(PASOS);
    encolarCarga({ contratos: [conDocumento(PASOS, doc)] });
    expect((await obtener()).contrato?.documento?.desactualizado).toBe(false);
    encolarCarga({ contratos: [conDocumento(PASOS, { ...doc, entrada: { ...doc.entrada, canonCop: 1_000_000 } })] });
    expect((await obtener()).contrato?.documento?.desactualizado).toBe(true);
    encolarCarga({ contratos: [conDocumento(PASOS, { ...doc, logoStorageKey: 'otro-logo.png' })] });
    expect((await obtener()).contrato?.documento?.desactualizado).toBe(true);
  });

  it('con textos pendientes de aprobación no se envía', async () => {
    const doc = await documentoRevisado(PASOS);
    // b-06 (el cashback de Tradicional) sigue sin aprobar
    encolarCarga({ contratos: [conDocumento(PASOS, { ...doc, pendientes: ['b-06'] })] });
    expect(await error(enviarAFirma(EXP, { generacion: doc.generacion }, USER, ROL))).toMatchObject({ errorCode: 'TEXTOS_PENDIENTES' });
  });

  it('una vista previa de otra versión de la plantilla, o con un texto ya aprobado, está desactualizada', async () => {
    const doc = await documentoRevisado(PASOS);
    for (const vieja of [
      { ...doc, plantillaVersion: 'otra-version' },
      // c-01 ya está aprobado: esa vista previa lo seguiría marcando como pendiente
      { ...doc, pendientes: ['c-01'] },
    ]) {
      encolarCarga({ contratos: [conDocumento(PASOS, vieja)] });
      expect((await obtener()).contrato?.documento?.desactualizado).toBe(true);
      encolarCarga({ contratos: [conDocumento(PASOS, vieja)] });
      expect(await error(enviarAFirma(EXP, { generacion: doc.generacion }, USER, ROL))).toMatchObject({
        statusCode: 409,
        errorCode: 'VISTA_PREVIA_DESACTUALIZADA',
      });
    }
    expect(storageApi.upload).not.toHaveBeenCalled();
  });

  it('CAS perdido: borra el PDF final y no llama a Auco', async () => {
    const doc = await documentoRevisado(PASOS);
    archivos[CRC_KEY] = await pdfReal(1);
    vi.mocked(generarContratoVivienda).mockResolvedValueOnce({ pdf: await pdfReal(2), pendientes: [], version: 'v', lineas: [] });
    encolarCarga({ contratos: [conDocumento(PASOS, doc)] });
    enqueue('contrato_partes', OK, OK);
    enqueue('contratos', { data: [], error: null });

    expect(await error(enviarAFirma(EXP, { generacion: doc.generacion }, USER, ROL))).toMatchObject({
      errorCode: 'CONTRATO_BORRADOR_CAMBIADO',
    });
    expect(storageApi.remove).toHaveBeenCalledWith([KEY_FINAL]);
    expect(crearSobre).not.toHaveBeenCalled();
  });

  it('si Auco falla: vuelve a borrador con su vista previa, borra el final y relanza', async () => {
    const doc = await documentoRevisado(PASOS);
    archivos[CRC_KEY] = await pdfReal(1);
    vi.mocked(generarContratoVivienda).mockResolvedValueOnce({ pdf: await pdfReal(2), pendientes: [], version: 'v', lineas: [] });
    vi.mocked(crearSobre).mockRejectedValueOnce(new AppError(502, 'AUCO_UPLOAD_FAILED', 'Auco no aceptó el envío'));
    encolarCarga({ contratos: [conDocumento(PASOS, doc)] });
    enqueue('contrato_partes', OK, OK);
    enqueue('contratos', { data: [{ id: CTO }], error: null }, { data: [{ id: CTO }], error: null }, OK);

    expect(await error(enviarAFirma(EXP, { generacion: doc.generacion }, USER, ROL))).toMatchObject({
      errorCode: 'AUCO_UPLOAD_FAILED',
    });
    const updates = opsDe('contratos', 'update').map((o) => o.args[0] as Record<string, unknown>);
    expect(updates[1]).toEqual({ estado: 'borrador' });
    expect(updates[2]).toMatchObject({ storage_key: KEY_PREVIA, nombre_archivo: 'CTO-2026-0007-borrador.pdf' });
    expect(storageApi.remove).toHaveBeenCalledWith([KEY_FINAL]);
    expect(storageApi.remove).not.toHaveBeenCalledWith([KEY_PREVIA]);
    const historial = opsDe('contrato_historial_estados', 'insert').map((o) => o.args[0] as Record<string, unknown>);
    expect(historial.map((h) => h.estado_nuevo)).toEqual(['pendiente_firma', 'borrador']);
  });

  it('si lo cancelaron mientras Auco fallaba, no revierte: ni borrador, ni historial, ni borra el PDF final', async () => {
    const doc = await documentoRevisado(PASOS);
    archivos[CRC_KEY] = await pdfReal(1);
    vi.mocked(generarContratoVivienda).mockResolvedValueOnce({ pdf: await pdfReal(2), pendientes: [], version: 'v', lineas: [] });
    vi.mocked(crearSobre).mockRejectedValueOnce(new AppError(502, 'AUCO_UPLOAD_FAILED', 'Auco no aceptó el envío'));
    encolarCarga({ contratos: [conDocumento(PASOS, doc)] });
    enqueue('contrato_partes', OK, OK);
    enqueue('contratos', { data: [{ id: CTO }], error: null }, { data: [], error: null });

    expect(await error(enviarAFirma(EXP, { generacion: doc.generacion }, USER, ROL))).toMatchObject({ errorCode: 'AUCO_UPLOAD_FAILED' });
    expect(opsDe('contratos', 'update')).toHaveLength(2); // el CAS y el intento de volver; nada de restaurar
    expect(opsDe('contrato_historial_estados', 'insert')).toHaveLength(1); // solo el del envío
    expect(storageApi.remove).not.toHaveBeenCalled();
  });

  it('si pese al error el proceso quedó vivo en Auco, el envío cuenta: no revierte', async () => {
    const doc = await documentoRevisado(PASOS);
    archivos[CRC_KEY] = await pdfReal(1);
    vi.mocked(generarContratoVivienda).mockResolvedValueOnce({ pdf: await pdfReal(2), pendientes: [], version: 'v', lineas: [] });
    vi.mocked(crearSobre).mockRejectedValueOnce(AppError.conflict('cambió', 'CONTRATO_ESTADO_CAMBIADO'));
    vi.mocked(ultimoSobre).mockResolvedValueOnce({ estado: 'en_firma', auco_code: 'AUCO1' } as never);
    vi.mocked(estadoEnviado).mockResolvedValueOnce({ id: CTO, estado: 'pendiente_firma' } as never);
    encolarCarga({ contratos: [conDocumento(PASOS, doc)] });
    enqueue('contrato_partes', OK, OK);
    enqueue('contratos', { data: [{ id: CTO }], error: null });

    const e = await enviarAFirma(EXP, { generacion: doc.generacion }, USER, ROL);
    expect(e.enviado).toMatchObject({ id: CTO, estado: 'pendiente_firma' });
    expect(opsDe('contratos', 'update')).toHaveLength(1);
    expect(storageApi.remove).toHaveBeenCalledWith([KEY_PREVIA]);
    expect(storageApi.remove).not.toHaveBeenCalledWith([KEY_FINAL]);
  });

  it('Ruta B: no sale a firma hasta ubicar las firmas sobre las líneas del PDF propio (Adenda 1, respuesta 6)', async () => {
    const doc = await documentoRevisado(PASOS_B);
    const propio = { key: 'propio.pdf', nombre: 'mio.pdf', paginas: 4, bytes: 1, sha256: 'a'.repeat(64), subidoEn: LEIDO, subidoPor: USER };
    encolarCarga({ contratos: [conDocumento(PASOS_B, doc, { propio })] });
    expect(await error(enviarAFirma(EXP, { generacion: doc.generacion, propioSha256: propio.sha256 }, USER, ROL))).toMatchObject({
      statusCode: 409,
      errorCode: 'RUTA_B_SIN_FIRMA',
    });
    expect(storageApi.upload).not.toHaveBeenCalled();
    expect(opsDe('contratos', 'update')).toHaveLength(0);
    expect(crearSobre).not.toHaveBeenCalled();
  });

  // Se reactiva al quitar exigirRutaConFirmas (asistente.service.ts).
  it.skip('Ruta B: sin paso 4, sin el PDF propio no sale; con él, se une [propio, Anexo, CRC] sin tocarlo', async () => {
    const doc = await documentoRevisado(PASOS_B);
    expect(vi.mocked(generarAnexoVivienda)).toHaveBeenCalled();
    // sin el PDF propio
    encolarCarga({ contratos: [conDocumento(PASOS_B, doc)] });
    expect(await error(enviarAFirma(EXP, { generacion: doc.generacion }, USER, ROL))).toMatchObject({
      errorCode: 'CONTRATO_PROPIO_REQUERIDO',
    });
    // con el PDF propio
    const propioPdf = await pdfReal(4);
    const sha = (await import('crypto')).createHash('sha256').update(propioPdf).digest('hex');
    const propio = { key: 'propio.pdf', nombre: 'mio.pdf', paginas: 4, bytes: propioPdf.length, sha256: sha, subidoEn: LEIDO, subidoPor: USER };
    archivos['propio.pdf'] = propioPdf;
    archivos[CRC_KEY] = await pdfReal(1);
    vi.mocked(generarAnexoVivienda).mockResolvedValueOnce({ pdf: await pdfReal(2), pendientes: [], version: 'v', lineas: [] });
    encolarCarga({ contratos: [conDocumento(PASOS_B, doc, { propio })] });
    expect(await error(enviarAFirma(EXP, { generacion: doc.generacion, propioSha256: 'f'.repeat(64) }, USER, ROL))).toMatchObject({
      errorCode: 'PDF_PROPIO_ALTERADO',
    });
    encolarCarga({ contratos: [conDocumento(PASOS_B, doc, { propio })] });
    enqueue('contrato_partes', OK, OK);
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    vi.mocked(estadoEnviado).mockResolvedValueOnce({ id: CTO } as never);
    await enviarAFirma(EXP, { generacion: doc.generacion, propioSha256: sha }, USER, ROL);
    const upd = opsDe('contratos', 'update').at(-1)!.args[0] as { datos_variables: { documento: DocumentoV3 } };
    expect(upd.datos_variables.documento.final).toMatchObject({ ruta: 'B', paginas: [4, 2, 1], propioKey: 'propio.pdf' });
    expect(vi.mocked(generarAnexoVivienda).mock.calls.at(-1)![1]).toMatchObject({ modo: 'final', anclas: true });
    // el registro de adicionales queda vacío en B
    expect(opsDe('contrato_clausulas_adicionales', 'insert')).toHaveLength(0);
  });

  it('cargarPropio: solo en Ruta B, valida el PDF y guarda su sha256 sin tocar actualizadoEn', async () => {
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: PASOS } })] });
    expect(await error(cargarPropio(EXP, { buffer: await pdfReal(1), originalname: 'x.pdf' }, USER, ROL))).toMatchObject({
      errorCode: 'RUTA_NO_ES_B',
    });

    encolarCarga({ contratos: [fila({ datos_variables: { asistente: PASOS_B } })] });
    const noPdf = await error(cargarPropio(EXP, { buffer: Buffer.from('hola'), originalname: 'x.pdf' }, USER, ROL));
    expect(noPdf).toMatchObject({ statusCode: 422, errorCode: 'PDF_PROPIO_INVALIDO', details: { motivo: 'no_es_pdf' } });

    const viejo = { key: 'viejo.pdf', nombre: 'v.pdf', paginas: 1, bytes: 1, sha256: 'a'.repeat(64), subidoEn: LEIDO, subidoPor: USER };
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: PASOS_B, propio: viejo } })] });
    enqueue('contratos', { data: [{ id: CTO }], error: null });
    encolarCarga({ contratos: [fila()] });
    await cargarPropio(EXP, { buffer: await pdfReal(2), originalname: 'contrato.pdf' }, USER, ROL);
    const upd = opsDe('contratos', 'update')[0].args[0] as { datos_variables: { asistente: Asistente; propio: Record<string, unknown> } };
    expect(upd.datos_variables.propio).toMatchObject({ nombre: 'contrato.pdf', paginas: 2, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(upd.datos_variables.asistente.actualizadoEn).toBe(PASOS_B.actualizadoEn);
    expect(storageApi.remove).toHaveBeenCalledWith(['viejo.pdf']);
  });

  it('cargarPropio con el CAS perdido borra lo que subió', async () => {
    encolarCarga({ contratos: [fila({ datos_variables: { asistente: PASOS_B } })] });
    enqueue('contratos', { data: [], error: null });
    expect(await error(cargarPropio(EXP, { buffer: await pdfReal(1), originalname: 'x.pdf' }, USER, ROL))).toMatchObject({
      errorCode: 'CONTRATO_BORRADOR_CAMBIADO',
    });
    const subida = (storageApi.upload.mock.calls[0] as unknown[])[0];
    expect(storageApi.remove).toHaveBeenCalledWith([subida]);
  });
});

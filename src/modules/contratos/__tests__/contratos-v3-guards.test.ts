import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Contratos V3 — el flujo legacy no toca una fila V3 (diseño §3.4, pruebas §7 19)
// y guards de la Entrega 5 (diseño §7.3, §7.4 y §9).
//
// Mock de Supabase con colas POR TABLA (patrón de autorizaciones.service.test):
// filtros encadenables, terminales y `await` consumen la cola de su tabla;
// sin cola → { data: null, error: null }. `ops` registra todo para afirmar que
// tras el rechazo no hubo escrituras ni RPC.
// ============================================================

const { mockEnv, mockFrom, mockRpc, ops, queues, enqueue, mockCompletitud, mockGetStatus } = vi.hoisted(() => {
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
    mockEnv: { CONTRATOS_V3_ENABLED: false, CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000, RESEND_API_KEY: 're_test' },
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
    mockGetStatus: vi.fn(),
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
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(async () => undefined),
  findPerfilIdByEmail: vi.fn(async () => null),
}));
vi.mock('@/lib/auco', async (orig) => ({
  ...(await orig<typeof import('@/lib/auco')>()),
  getDocumentStatus: (...a: unknown[]) => mockGetStatus(...a),
}));
vi.mock('@/modules/perfil-arrendador/perfil-arrendador.service', () => ({
  checkPerfilCompletitud: (...args: unknown[]) => mockCompletitud(...args),
}));

// Import AFTER mocks
import { AppError } from '@/lib/errors';
import type { AuthUser } from '@/types/auth';
import {
  descargarContrato,
  enviarContratoAFirma,
  getContratoById,
  generarContrato,
  previewContratoVerificacion,
  regenerarContrato,
  renovarContrato,
  supersederContratosEnFirma,
} from '../contratos.service';
import { executeContratoTransition, finalizarContratoVencido, getContratoTransitions } from '../contrato-workflow.service';
import { finalizarContratosVencidos } from '../contrato-vencimiento.service';
import type { GenerarContratoInput, ReGenerarContratoInput, RenovarContratoInput } from '../contratos.schema';
import { crearSolicitudFirmaMultiparte } from '@/modules/firma/firma-multiparte.service';
import { archivarPdfFirmadoEnStorage, crearSolicitudFirma } from '@/modules/firma/firma.service';
import { createPaymentLink, registerManualPayment, resendPaymentLink } from '@/modules/pagos/pagos.service';
import { CONTRATO_ESTADOS_PRE_FIRMA } from '@/modules/expedientes/expediente-workflow.service';

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
    expect(e.message).toBe('El envío a firma de este contrato se hace desde el asistente de contratos.');
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

  const cancelar = { nuevo_estado: 'cancelado', comentario: 'Cancelado desde el asistente', motivo: 'Cancelado' } as never;
  /** Índice de la primera operación sobre una tabla (o la RPC) en `ops`. */
  const primera = (table: string) => ops.findIndex((o) => o.table === table);

  it.each(['borrador', 'pendiente_firma', 'firma_incompleta'])(
    'cancelar desde %s pasa el guard: el hook de firma V3 corre ANTES de la RPC',
    async (estado) => {
      enqueue('contratos', { data: filaV3({ estado }), error: null });
      const e = await error(executeContratoTransition(CTO, cancelar, ADMIN));
      // El RPC del mock pierde la carrera: lo importante es que se llamó con 'cancelado', después del hook.
      expect(e.errorCode).not.toBe('CONTRATO_V3_TRANSICION_NO_PERMITIDA');
      expect(mockRpc).toHaveBeenCalledWith('transicionar_contrato', expect.objectContaining({ p_nuevo_estado: 'cancelado' }));
      expect(primera('contrato_v3_sobres')).toBeGreaterThanOrEqual(0);
      expect(primera('contrato_v3_sobres')).toBeLessThan(primera('rpc'));
    },
  );

  it('vigente (FIANZA ACTIVA) → cancelado: 400 sin hook ni RPC (§11.5: solo antes de la firma)', async () => {
    enqueue('contratos', { data: filaV3({ estado: 'vigente' }), error: null });
    const e = await error(executeContratoTransition(CTO, cancelar, ADMIN));
    expect(e).toMatchObject({ statusCode: 400, errorCode: 'CONTRATO_V3_TRANSICION_NO_PERMITIDA' });
    expect(primera('contrato_v3_sobres')).toBe(-1);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('con `estado_esperado` viejo (otro lo envió a firma mientras tanto) → 409 sin tocar Auco ni la RPC', async () => {
    enqueue('contratos', { data: filaV3({ estado: 'pendiente_firma' }), error: null });
    const e = await error(executeContratoTransition(CTO, { ...(cancelar as object), estado_esperado: 'borrador' } as never, ADMIN));
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_ESTADO_CAMBIADO' });
    expect(primera('contrato_v3_sobres')).toBe(-1);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('si todas las partes ya firmaron, el hook responde 409 y no se cancela', async () => {
    enqueue('contratos', { data: filaV3({ estado: 'pendiente_firma' }), error: null });
    enqueue('contrato_v3_sobres', { data: { id: 's1', contrato_id: CTO, intento: 1, estado: 'completo', auco_code: 'AUCO1' }, error: null });
    const e = await error(executeContratoTransition(CTO, cancelar, ADMIN));
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'FIRMA_COMPLETA' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('transiciones disponibles: un V3 vigente solo se termina; en firma incompleta, solo se cancela', async () => {
    enqueue('contratos', { data: filaV3({ estado: 'vigente' }), error: null }, { data: filaV3({ estado: 'firma_incompleta' }), error: null });
    expect((await getContratoTransitions(CTO, ADMIN)).transiciones_disponibles.map((t) => t.estado)).toEqual(['finalizado']);
    const r = await getContratoTransitions(CTO, ADMIN);
    expect(r.transiciones_disponibles.map((t) => t.estado)).toEqual(['cancelado']);
  });

  it('TERMINADO (§11.6): vigente → finalizado pasa el guard y NO toca el proceso de firma', async () => {
    enqueue('contratos', { data: filaV3({ estado: 'vigente' }), error: null });
    const terminar = { nuevo_estado: 'finalizado', comentario: 'Entregó el inmueble', motivo: 'Terminación por mutuo acuerdo' } as never;
    const e = await error(executeContratoTransition(CTO, terminar, ADMIN));
    expect(e.errorCode).not.toBe('CONTRATO_V3_TRANSICION_NO_PERMITIDA');
    expect(mockRpc).toHaveBeenCalledWith('transicionar_contrato', expect.objectContaining({ p_nuevo_estado: 'finalizado' }));
    expect(primera('contrato_v3_sobres')).toBe(-1); // sin cancelarFirmaV3: con fianza activa respondería 409
  });

  it('un miembro que no ve el estudio no termina el contrato (404) aunque sea de su organización', async () => {
    const { assertExpedienteAccess } = await import('@/lib/tenantScope');
    vi.mocked(assertExpedienteAccess).mockRejectedValueOnce(new AppError(404, 'EXPEDIENTE_NOT_FOUND', 'Estudio no encontrado'));
    enqueue('contratos', { data: filaV3({ estado: 'vigente' }), error: null });
    const miembro = { id: 'miembro-1', rol: 'inmobiliaria' } as AuthUser;
    const terminar = { nuevo_estado: 'finalizado', comentario: 'Entregó el inmueble', motivo: 'Terminación' } as never;
    expect(await error(executeContratoTransition(CTO, terminar, miembro))).toMatchObject({ statusCode: 404 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('un V3 no se termina desde otro estado que no sea FIANZA ACTIVA', async () => {
    enqueue('contratos', { data: filaV3({ estado: 'firma_incompleta' }), error: null });
    const terminar = { nuevo_estado: 'finalizado', comentario: 'x'.repeat(12), motivo: 'x' } as never;
    expect(await error(executeContratoTransition(CTO, terminar, ADMIN))).toMatchObject({ errorCode: 'CONTRATO_V3_TRANSICION_NO_PERMITIDA' });
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

describe('guards de la Entrega 5 sobre filas V3', () => {
  it('finalizarContratoVencido no finaliza un V3 aunque le llegue (se prorroga solo)', async () => {
    enqueue('contratos', { data: filaV3({ estado: 'vigente' }), error: null });
    expect(await finalizarContratoVencido(CTO)).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('el job de vencimiento no toca contratos V3', async () => {
    enqueue('contratos', { data: [], error: null });
    await finalizarContratosVencidos();
    expect(ops.filter((o) => o.table === 'contratos' && o.method === 'is').map((o) => o.args)).toContainEqual(['destinacion', null]);
  });

  it('renovarContrato con un V3 → 400 CONTRATO_V3_NO_RENOVABLE, sin escribir', async () => {
    enqueue('contratos', { data: filaV3({ estado: 'vigente' }), error: null });
    const e = await error(renovarContrato(CTO, {} as RenovarContratoInput, ADMIN.id, undefined, ADMIN.rol));
    expect(e).toMatchObject({ statusCode: 400, errorCode: 'CONTRATO_V3_NO_RENOVABLE' });
    expect(escrituras()).toEqual([]);
  });

  it('superseder solo cancela hermanos del flujo anterior (un V3 en firma no se toca)', async () => {
    enqueue('contratos', { data: [], error: null });
    await supersederContratosEnFirma(EXP, CTO, ADMIN.id);
    expect(ops.filter((o) => o.table === 'contratos' && o.method === 'is').map((o) => o.args)).toContainEqual(['destinacion', null]);
    expect(escrituras()).toEqual([]);
  });

  it('POST /firma/solicitudes con un V3 (multi-parte y un firmante) → 409 CONTRATO_V3_USA_ASISTENTE', async () => {
    enqueue('contratos', { data: filaV3({ estado: 'pendiente_firma' }), error: null }, { data: filaV3({ estado: 'pendiente_firma' }), error: null });
    const multi = await error(crearSolicitudFirmaMultiparte(CTO, ADMIN.id, ADMIN.rol));
    expect(multi).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_V3_USA_ASISTENTE' });
    const uno = await error(
      crearSolicitudFirma({ contrato_id: CTO, nombre_firmante: 'Juan', email_firmante: 'j@x.co' } as never, ADMIN.id, ADMIN.rol),
    );
    expect(uno).toMatchObject({ statusCode: 409, errorCode: 'CONTRATO_V3_USA_ASISTENTE' });
    expect(escrituras()).toEqual([]);
  });

  it('archivar el PDF firmado de un V3: el código de Auco sale del sobre completo (no hay solicitudes_firma)', async () => {
    enqueue('contratos', { data: { id: CTO, expediente_id: EXP, version: 1, storage_key_firmado: null, expedientes: { numero: 'EXP-1' } }, error: null });
    enqueue('contrato_v3_sobres', { data: { id: 's1', auco_code: 'AUCO1' }, error: null });
    mockGetStatus.mockResolvedValueOnce({ status: 'FINISH', url: 'https://auco.example/firmado.pdf' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
    try {
      await archivarPdfFirmadoEnStorage(CTO);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(mockGetStatus).toHaveBeenCalledWith('AUCO1');
    expect(ops.filter((o) => o.table === 'contrato_v3_sobres' && o.method === 'eq').map((o) => o.args)).toContainEqual(['estado', 'completo']);
    expect(ops.filter((o) => o.table === 'solicitudes_firma' && o.method === 'update')).toEqual([]);
  });

  it.each(['garantia', 'primer_canon'])('link de pago de %s con un V3 en FIRMA INCOMPLETA → 409 FIANZA_NO_OPERANDO', async (concepto) => {
    enqueue('expedientes', { data: { id: EXP, numero: 'EXP-2026-0100', estado: 'aprobado' }, error: null });
    enqueue('contratos', { data: [{ estado: 'firma_incompleta' }], error: null });
    const e = await error(
      createPaymentLink(EXP, { concepto, monto: 2_000_000, descripcion: 'x', email_pagador: 'p@x.co', nombre_pagador: 'P', enviar_email: false }, ADMIN.id, ADMIN.rol),
    );
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'FIANZA_NO_OPERANDO' });
    // Solo filas V3, y sin el valor nuevo del enum en la consulta.
    expect(ops.filter((o) => o.table === 'contratos' && o.method === 'not').map((o) => o.args)).toEqual([['destinacion', 'is', null]]);
    expect(escrituras()).toEqual([]);
  });

  it('reenviar el link de garantía con un V3 en FIRMA INCOMPLETA → 409 y no sale el correo', async () => {
    enqueue('pagos', {
      data: { id: 'pg1', estado: 'pendiente', concepto: 'garantia', expediente_id: EXP, payment_link_url: 'https://mp', email_pagador: 'p@x.co', monto: 1 },
      error: null,
    });
    enqueue('contratos', { data: [{ estado: 'firma_incompleta' }], error: null });
    const e = await error(resendPaymentLink('pg1', ADMIN.id, ADMIN.rol));
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'FIANZA_NO_OPERANDO' });
    expect(escrituras()).toEqual([]);
  });

  it('registrar a mano la garantía con un V3 en FIRMA INCOMPLETA → 409, sin insertar el pago', async () => {
    enqueue('expedientes', { data: { id: EXP }, error: null });
    enqueue('contratos', { data: [{ estado: 'firma_incompleta' }], error: null });
    const e = await error(
      registerManualPayment(
        EXP,
        { concepto: 'garantia', monto: 2_000_000, metodo: 'transferencia', fecha_pago: '2026-09-01' } as never,
        ADMIN.id,
        ADMIN.rol,
      ),
    );
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'FIANZA_NO_OPERANDO' });
    expect(escrituras()).toEqual([]);
  });

  it('cerrar o rechazar el estudio auto-cancela un contrato en FIRMA INCOMPLETA (no uno en firma)', () => {
    expect(CONTRATO_ESTADOS_PRE_FIRMA).toContain('firma_incompleta');
    expect(CONTRATO_ESTADOS_PRE_FIRMA).not.toContain('pendiente_firma');
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

describe('descargarContrato: el arrendatario (solicitante)', () => {
  const SOL = 'sol-user';
  const storageOk = async () => {
    const { supabase } = await import('@/lib/supabase');
    vi.mocked(supabase.storage.from).mockReturnValue({
      createSignedUrl: async () => ({ data: { signedUrl: 'https://firmada' }, error: null }),
    } as never);
  };

  it('descarga su contrato en firma (sin pasar por el scope de cartera, que no lo cubre)', async () => {
    await storageOk();
    const { assertExpedienteAccess, puedeVerFilaExpediente } = await import('@/lib/tenantScope');
    enqueue('contratos', { data: filaV3({ estado: 'pendiente_firma', nombre_archivo: 'c.pdf' }), error: null });
    const r = await descargarContrato(CTO, SOL, undefined, undefined, 'solicitante');
    expect(r.url).toBe('https://firmada');
    expect(assertExpedienteAccess).toHaveBeenCalledWith(EXP, SOL, 'solicitante');
    expect(vi.mocked(puedeVerFilaExpediente).mock.calls.some((c) => c[0] === SOL)).toBe(false);
  });

  it('un borrador o un estudio ajeno responde 404', async () => {
    enqueue('contratos', { data: filaV3({ estado: 'borrador' }), error: null });
    await expect(descargarContrato(CTO, SOL, undefined, undefined, 'solicitante')).rejects.toMatchObject({ statusCode: 404 });

    const { assertExpedienteAccess } = await import('@/lib/tenantScope');
    vi.mocked(assertExpedienteAccess).mockRejectedValueOnce(new AppError(404, 'EXPEDIENTE_NOT_FOUND', 'Estudio no encontrado'));
    enqueue('contratos', { data: filaV3({ estado: 'vigente' }), error: null });
    await expect(descargarContrato(CTO, SOL, undefined, undefined, 'solicitante')).rejects.toMatchObject({
      statusCode: 404,
      errorCode: 'CONTRATO_NOT_FOUND',
    });
  });
});

describe('descargarContrato: firmado subido a mano', () => {
  it('«Descargar PDF» entrega el escaneado subido, no la plantilla sin firmas (el mismo PDF del visor)', async () => {
    const { supabase } = await import('@/lib/supabase');
    const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: 'https://escaneado' }, error: null }));
    vi.mocked(supabase.storage.from).mockReturnValue({ createSignedUrl } as never);
    enqueue('contratos', {
      data: filaV3({
        estado: 'cancelado',
        nombre_archivo: 'c.pdf',
        firmado_storage_key: `contratos/${EXP}/${CTO}/firmado-papel.pdf`,
        firmado_nombre_archivo: 'firmado-papel.pdf',
      }),
      error: null,
    });

    const r = await descargarContrato(CTO, ADMIN.id, undefined, undefined, ADMIN.rol);

    expect(createSignedUrl).toHaveBeenCalledWith(`contratos/${EXP}/${CTO}/firmado-papel.pdf`, expect.any(Number), {
      download: 'firmado-papel.pdf',
    });
    expect(r).toMatchObject({ nombre_archivo: 'firmado-papel.pdf', firmado: true });
  });
});

describe('getContratoById: scope sobre la fila, sin bajar la cartera', () => {
  const INMO = 'inmo-user';
  const scope = { miembro_responsable_id: null, inmueble: { propietario_id: 'otro', inmobiliaria_id: 'org-1', miembro_responsable_id: null } };

  it('decide con el expediente embebido: una sola lectura y la respuesta sin _scope', async () => {
    const { puedeVerFilaExpediente, resolveAllowedExpedienteIds } = await import('@/lib/tenantScope');
    enqueue('contratos', { data: { ...filaV3(), _scope: scope }, error: null });
    const c = await getContratoById(CTO, INMO, 'inmobiliaria');

    expect(puedeVerFilaExpediente).toHaveBeenCalledWith(INMO, 'inmobiliaria', scope);
    expect(resolveAllowedExpedienteIds).not.toHaveBeenCalled();
    expect(ops.filter((o) => o.table !== 'contratos')).toEqual([]);
    expect(String(ops.find((o) => o.method === 'select')?.args[0])).toContain('inmuebles!expedientes_inmueble_id_fkey');
    expect(c).not.toHaveProperty('_scope');
    expect(c).toMatchObject({ id: CTO, expediente_id: EXP });
  });

  it('fuera de la cartera → 404', async () => {
    const { puedeVerFilaExpediente } = await import('@/lib/tenantScope');
    vi.mocked(puedeVerFilaExpediente).mockResolvedValueOnce(false);
    enqueue('contratos', { data: { ...filaV3(), _scope: scope }, error: null });
    await expect(getContratoById(CTO, INMO, 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404, errorCode: 'CONTRATO_NOT_FOUND' });
  });
});

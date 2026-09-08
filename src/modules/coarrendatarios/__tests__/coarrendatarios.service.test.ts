import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Conformidad con la Politica V4.1 §5 y el Flujo §10-§12 sobre el
// coarrendatario. Mismo mock de Supabase que autorizaciones: builder
// encadenable + colas de resultados POR TABLA, y `ops` para afirmar QUE se
// escribio. Una tabla sin cola responde { data: null, error: null }.
// ============================================================

const {
  mockEnv,
  mockFrom,
  ops,
  queues,
  enqueue,
  mockNotificarUsuario,
  mockNotificarYCorreo,
  mockNotificarResponsable,
  mockFindPerfilIdByEmail,
  mockEmitirCrc,
  mockLiberarReserva,
  mockEnviarTemplate,
  mockResendSend,
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
  const mockFrom = vi.fn((table: string) => chainFor(table));
  const enqueue = (table: string, ...items: Res[]) => {
    queues.set(table, [...(queues.get(table) ?? []), ...items]);
  };
  return {
    mockEnv: {
      FRONTEND_URL: 'http://localhost:3000',
      RESEND_API_KEY: 're_test',
      RESEND_FROM_EMAIL: 'no-reply@cofianza.co',
      AUTORIZACION_VIGENCIA_MESES: 12,
      MOTOR_DECIDE_ENABLED: false,
      MOTOR_RUTA_USA_SCORECARD: false,
    },
    mockFrom,
    ops,
    queues,
    enqueue,
    mockNotificarUsuario: vi.fn(async () => undefined),
    mockNotificarYCorreo: vi.fn(async () => undefined),
    mockNotificarResponsable: vi.fn(async () => undefined),
    mockFindPerfilIdByEmail: vi.fn(async () => null),
    mockEmitirCrc: vi.fn(async () => true),
    mockLiberarReserva: vi.fn(async () => undefined),
    mockEnviarTemplate: vi.fn(async () => undefined),
    mockResendSend: vi.fn(async () => ({ data: { id: 'email' }, error: null })),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/calibracion', () => ({
  getCalibracion: vi.fn(async () => ({ UMBRAL_ZONA_GRIS: 70, UMBRAL_APROBACION_AUTOMATICA: 85, UMBRAL_COARRENDATARIO: 80 })),
}));
vi.mock('@/lib/tenantScope', () => ({ perfilEsDuenoDeInmueble: vi.fn(async () => true) }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => mockResendSend(...args) };
  },
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: (...args: unknown[]) => mockEnviarTemplate(...args) }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn(async () => undefined) }));
vi.mock('@/modules/estudios/pago.guard', () => ({
  estudioYaCobrado: vi.fn(async () => true),
  ESTADO_ESPERANDO_PAGO: 'pago_pendiente',
}));
vi.mock('@/modules/estudios/certificado.service', () => ({
  emitirCertificadoAutomatico: (...args: unknown[]) => mockEmitirCrc(...args),
}));
vi.mock('@/modules/inmuebles/inmuebles.service', () => ({
  liberarReservaDeExpediente: (...args: unknown[]) => mockLiberarReserva(...args),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: (...args: unknown[]) => mockNotificarUsuario(...args),
  notificarYCorreo: (...args: unknown[]) => mockNotificarYCorreo(...args),
  notificarResponsableExpediente: (...args: unknown[]) => mockNotificarResponsable(...args),
  findPerfilIdByEmail: (...args: unknown[]) => mockFindPerfilIdByEmail(...args),
}));
// reglas-duras arrastra el motor, antecedentes y biometria: aqui solo hacen
// falta sus tres funciones puras, con stand-ins deterministas.
vi.mock('@/modules/estudios/reglas-duras', () => ({
  etiquetaReglaDura: (c: string) => (c === 'dti_mayor_65' ? 'DTI > 65%' : c),
  inferirReglasDurasDesdeMotivo: () => [],
  motivoProspectoReglasDuras: () => 'No aprobable por ahora.',
}));

// Import AFTER mocks
import {
  invitarCoarrendatario,
  onCoarrendatarioEstudioCompletado,
  rechazarInvitacion,
} from '../coarrendatarios.service';

// ============================================================
// Fixtures
// ============================================================

const EXPEDIENTE_ID = '550e8400-e29b-41d4-a716-446655440000';
const GESTOR_ID = '660e8400-e29b-41d4-a716-446655440000';
const PROPIETARIO_ID = '770e8400-e29b-41d4-a716-446655440000';
const TITULAR_ESTUDIO_ID = '880e8400-e29b-41d4-a716-446655440000';
const COA_ESTUDIO_ID = '990e8400-e29b-41d4-a716-446655440000';
const COA_ID = 'aa0e8400-e29b-41d4-a716-446655440000';

const ctxRow = (estado = 'condicionado') => ({
  data: {
    id: EXPEDIENTE_ID,
    numero: 'EXP-2026-00042',
    estado,
    creado_por: GESTOR_ID,
    solicitantes: { creado_por: null, email: 'ana@correo.co', nombre: 'Ana', apellido: 'Pérez', numero_documento: '1.234.567' },
    inmuebles: { propietario_id: PROPIETARIO_ID, inmobiliaria_id: null, direccion: 'Calle 1 # 2-3', ciudad: 'Medellín' },
  },
  error: null,
});

const invitacion = (numeroDocumento: string) => ({
  nombre: 'Luis',
  apellido: 'Gómez',
  tipo_documento: 'cc' as const,
  numero_documento: numeroDocumento,
  email: 'luis@correo.co',
});

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

// ============================================================
// Politica §5, NOTA: el coarrendatario no puede ser el mismo afianzado
// ============================================================

describe('invitarCoarrendatario — Politica §5 (mismo afianzado bajo otro nombre)', () => {
  it('rechaza cuando el documento coincide con el del titular, aunque cambie el formato', async () => {
    enqueue('expedientes', ctxRow());

    await expect(
      invitarCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', invitacion('1234567')),
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'COARRENDATARIO_MISMO_DOCUMENTO' });

    expect(ops.some((o) => o.table === 'expediente_coarrendatarios' && o.method === 'insert')).toBe(false);
  });

  it('deja pasar un documento distinto y crea la invitacion', async () => {
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', {
      data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, nombre: 'Luis', estado: 'pendiente_aceptacion' },
      error: null,
    });

    const coa = await invitarCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', invitacion('7654321'));

    expect(coa.id).toBe(COA_ID);
    expect(ops.some((o) => o.table === 'expediente_coarrendatarios' && o.method === 'insert')).toBe(true);
  });
});

// ============================================================
// Politica §5, ultima fila de la tabla: regla dura del coarrendatario
// ============================================================

describe('onCoarrendatarioEstudioCompletado — ponderacion', () => {
  const coaEstudio = (resultado: string) => ({
    data: { id: COA_ESTUDIO_ID, expediente_id: EXPEDIENTE_ID, tipo: 'con_coarrendatario', resultado, score: 700, motivo_rechazo: null },
    error: null,
  });
  const coaRow = { data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, nombre: 'Luis', apellido: 'Gómez', email: 'luis@correo.co' }, error: null };
  const titularRows = (resultado: string) => ({ data: [{ id: TITULAR_ESTUDIO_ID, resultado, score: 720 }], error: null });

  it('regla dura del coarrendatario contamina el conjunto aunque el titular este aprobado', async () => {
    enqueue('estudios', coaEstudio('rechazado'), titularRows('aprobado'));
    enqueue('expediente_coarrendatarios', coaRow);
    // UPDATE del expediente (race-safe, devuelve filas) + ctx del paso 7.
    enqueue('expedientes', { data: [{ id: EXPEDIENTE_ID }], error: null }, ctxRow());

    await onCoarrendatarioEstudioCompletado(COA_ESTUDIO_ID, { reglasDuras: ['dti_mayor_65'] });

    const update = ops.find((o) => o.table === 'expedientes' && o.method === 'update');
    expect(update).toBeDefined();
    const payload = update!.args[0] as { estado: string; motivo_rechazo?: string };
    expect(payload.estado).toBe('rechazado');
    expect(payload.motivo_rechazo).toContain('regla dura');
    expect(payload.motivo_rechazo).toContain('DTI > 65%');
    expect(mockLiberarReserva).toHaveBeenCalledWith(EXPEDIENTE_ID);
    expect(mockEmitirCrc).not.toHaveBeenCalled();
  });

  it('titular aprobado + coarrendatario rechazado por SCORE sigue aprobado (fila sin definir en la Politica)', async () => {
    enqueue('estudios', coaEstudio('rechazado'), titularRows('aprobado'));
    enqueue('expediente_coarrendatarios', coaRow);
    enqueue('expedientes', { data: [{ id: EXPEDIENTE_ID }], error: null }, ctxRow(), ctxRow());

    await onCoarrendatarioEstudioCompletado(COA_ESTUDIO_ID, { reglasDuras: [] });

    const update = ops.find((o) => o.table === 'expedientes' && o.method === 'update');
    expect((update!.args[0] as { estado: string }).estado).toBe('aprobado');
    expect(mockLiberarReserva).not.toHaveBeenCalled();
  });

  it('cuando el conjunto se aprueba, el CRC del titular se regenera con el acompañante (Flujo §10/§11)', async () => {
    enqueue('estudios', coaEstudio('aprobado'), titularRows('condicionado'));
    enqueue('expediente_coarrendatarios', coaRow);
    // UPDATE + ctx del paso 7 (que tambien firma el CRC con creado_por).
    enqueue('expedientes', { data: [{ id: EXPEDIENTE_ID }], error: null }, ctxRow('aprobado'));

    await onCoarrendatarioEstudioCompletado(COA_ESTUDIO_ID, { reglasDuras: [] });

    await vi.waitFor(() =>
      expect(mockEmitirCrc).toHaveBeenCalledWith(TITULAR_ESTUDIO_ID, GESTOR_ID, { regenerar: true }),
    );
  });
});

// ============================================================
// Flujo §12: coarrendatario que no autoriza -> se informa al principal
// ============================================================

describe('rechazarInvitacion — Flujo §12', () => {
  it('avisa al gestor (in-app + correo), al responsable y deja rastro en el timeline', async () => {
    enqueue('expediente_coarrendatarios', {
      data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, nombre: 'Luis', estado: 'pendiente_aceptacion' },
      error: null,
    });
    enqueue('expedientes', ctxRow());

    const res = await rechazarInvitacion('t'.repeat(64));

    expect(res).toEqual({ ok: true });
    const update = ops.find((o) => o.table === 'expediente_coarrendatarios' && o.method === 'update');
    expect((update!.args[0] as { estado: string }).estado).toBe('rechazado_invitacion');
    expect(ops.some((o) => o.table === 'eventos_timeline' && o.method === 'insert')).toBe(true);

    expect(mockNotificarYCorreo).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: PROPIETARIO_ID,
        tipo: 'coarrendatario.rechazo',
        mensaje: expect.stringContaining('Luis declinó ser coarrendatario del estudio EXP-2026-00042'),
        link: `/expedientes/${EXPEDIENTE_ID}`,
      }),
    );
    expect(mockNotificarResponsable).toHaveBeenCalledWith(
      expect.objectContaining({ expedienteId: EXPEDIENTE_ID, excluirPerfilId: PROPIETARIO_ID, tipo: 'coarrendatario.rechazo' }),
    );
    // El prospecto sigue recibiendo su aviso (aqui via correo, porque no tiene perfil).
    expect(mockFindPerfilIdByEmail).toHaveBeenCalledWith('ana@correo.co');
  });
});

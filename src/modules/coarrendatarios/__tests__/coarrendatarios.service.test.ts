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
const mockGetCompany = vi.hoisted(() => vi.fn(async () => ({ email: 'hola@cofianza.co' })));
vi.mock('@/lib/companyConfig', () => ({ getCompany: () => mockGetCompany() }));
vi.mock('@/lib/calibracion', () => ({
  getCalibracion: vi.fn(async () => ({ UMBRAL_ZONA_GRIS: 70, UMBRAL_APROBACION_AUTOMATICA: 85, UMBRAL_COARRENDATARIO: 80 })),
}));
const mockAssertExpedienteAccess = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: (...args: unknown[]) => mockAssertExpedienteAccess(...args),
  // Membresía de la org: dejaba pasar a cualquier miembro (no debe decidir aquí).
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
}));
const mockAvisarSolicitante = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/modules/expedientes/expediente-habilitacion.service', () => ({
  avisarSolicitanteDecision: (...args: unknown[]) => mockAvisarSolicitante(...args),
}));
const mockListOperators = vi.fn(async () => [{ id: 'analista-1' }]);
vi.mock('@/modules/users/users.service', () => ({ listOperators: () => mockListOperators() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => mockResendSend(...args) };
  },
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: (...args: unknown[]) => mockEnviarTemplate(...args) }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn(async () => undefined) }));
// El guard real (P36) escala a la Gerencia al bloquear: aquí no se escala nada.
vi.mock('@/modules/contratos/tope-coafianzamiento', () => ({ escalarTopeCanon: vi.fn(async () => false) }));
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
  inferirReglasDurasDesdeMotivo: (m: string | null) => (m?.includes('[regla dura]') ? ['dti_mayor_65'] : []),
  motivoProspectoReglasDuras: () => 'No aprobable por ahora.',
}));

// P18: el enlace del prospecto resuelve su estudio (el mismo EXPEDIENTE_ID de los fixtures).
const mockResolverToken = vi.fn(async (..._args: unknown[]) => ({ expedienteId: '550e8400-e29b-41d4-a716-446655440000' }));
vi.mock('@/modules/expedientes/expediente-soportes.service', () => ({
  resolveExpedientePorTokenDocumentos: (...args: unknown[]) => mockResolverToken(...args),
}));

// Import AFTER mocks
import { assertCanonDentroDelTope } from '@/modules/estudios/tope-canon.guard';
import { getCalibracion } from '@/lib/calibracion';
import { estudioYaCobrado } from '@/modules/estudios/pago.guard';
import {
  invitarCoarrendatario,
  getCoarrendatarioPorExpediente,
  reenviarInvitacionCoarrendatario,
  onCoarrendatarioEstudioCompletado,
  construirCorreoCoarrendatario,
  rechazarInvitacion,
  aceptarInvitacion,
  getPublicByToken,
  cancelarInvitacionCoarrendatario,
  avisarCoarrendatarioDecision,
  invitarCoarrendatarioPorToken,
  avisarInvitacionSinEfecto,
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

// Conteo del tope de invitaciones por estudio: crearInvitacion lo lee antes del INSERT.
const cupo = { data: null, error: null, count: 0 };

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
    enqueue('expediente_coarrendatarios', cupo, {
      data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, nombre: 'Luis', estado: 'pendiente_aceptacion' },
      error: null,
    });

    const coa = await invitarCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', invitacion('7654321'));

    expect(coa.id).toBe(COA_ID);
    expect(ops.some((o) => o.table === 'expediente_coarrendatarios' && o.method === 'insert')).toBe(true);
  });
});

// ============================================================
// P36: con el estudio ya cobrado, el tope de canon que bajó después solo
// advierte (el estudio pagado se termina); sin cobro, sigue bloqueando.
// ============================================================

describe('tope de canon — P36', () => {
  it.each([true, false])('invitar: soloAdvertir = estudio ya cobrado (%s)', async (cobrado) => {
    vi.mocked(estudioYaCobrado).mockResolvedValueOnce(cobrado);
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', cupo, { data: { id: COA_ID }, error: null });

    await invitarCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', invitacion('7654321'));

    expect(assertCanonDentroDelTope).toHaveBeenCalledWith(
      expect.objectContaining({ expedienteId: EXPEDIENTE_ID, soloAdvertir: cobrado }),
    );
  });

  // El guard real, no solo la llamada: canon 3.500.000 sobre un tope de 3.000.000.
  it.each([
    [true, 'invita (solo advierte)'],
    [false, 'bloquea con CANON_EXCEDE_TOPE'],
  ])('con el tope real: estudio cobrado = %s → %s', async (cobrado) => {
    const real = await vi.importActual<typeof import('@/modules/estudios/tope-canon.guard')>('@/modules/estudios/tope-canon.guard');
    vi.mocked(assertCanonDentroDelTope).mockImplementationOnce(real.assertCanonDentroDelTope);
    vi.mocked(getCalibracion).mockResolvedValueOnce({ CANON_MAX_TRANSITORIO: 3_000_000 } as never);
    vi.mocked(estudioYaCobrado).mockResolvedValueOnce(cobrado);
    // ctx, y el inmueble del estudio para el guard.
    enqueue('expedientes', ctxRow(), { data: { inmueble_id: 'inm-1' }, error: null });
    enqueue('inmuebles', { data: { valor_arriendo: '3500000', uso: 'vivienda' }, error: null });
    enqueue('expediente_coarrendatarios', cupo, { data: { id: COA_ID }, error: null });

    const r = invitarCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', invitacion('7654321'));

    if (cobrado) await expect(r).resolves.toMatchObject({ id: COA_ID });
    else await expect(r).rejects.toMatchObject({ statusCode: 400, errorCode: 'CANON_EXCEDE_TOPE' });
    expect(ops.some((o) => o.table === 'expediente_coarrendatarios' && o.method === 'insert')).toBe(cobrado);
  });

  it('aceptar: con el estudio cobrado solo advierte', async () => {
    enqueue('expediente_coarrendatarios', {
      data: {
        id: COA_ID,
        expediente_id: EXPEDIENTE_ID,
        estado: 'pendiente_aceptacion',
        token_expiracion: new Date(Date.now() + 86_400_000).toISOString(),
      },
      error: null,
    });
    enqueue('expedientes', ctxRow());

    await aceptarInvitacion('t'.repeat(64), '1.1.1.1', 'ua', {} as never).catch(() => undefined);

    expect(assertCanonDentroDelTope).toHaveBeenCalledWith(
      expect.objectContaining({ expedienteId: EXPEDIENTE_ID, origen: 'aceptarInvitacionCoarrendatario', soloAdvertir: true }),
    );
  });
});

// ============================================================
// Ley 1581: el token de la invitacion nunca viaja al cliente. Con el, el
// titular o el gestor podian aceptar el habeas data en nombre del invitado.
// ============================================================

describe('respuestas al cliente sin el token de la invitacion', () => {
  const PRIVADAS = /\*|\btoken\b|aceptado_ip|aceptado_user_agent|invitado_por/;
  // Selects cuyo resultado se devuelve: los que van tras insert/update y el
  // de la consulta. El select('*') interno del reenvio no sale de la API.
  const selectsDevueltos = () =>
    ops
      .filter((o) => o.table === 'expediente_coarrendatarios' && o.method === 'select' && !(o.args[1] as { head?: boolean })?.head)
      .map((o) => String(o.args[0]));

  it('invitar y consultar piden solo columnas publicas', async () => {
    enqueue('expedientes', ctxRow(), ctxRow());
    enqueue(
      'expediente_coarrendatarios',
      cupo,
      { data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, nombre: 'Luis', estado: 'pendiente_aceptacion' }, error: null },
      { data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, estado: 'pendiente_aceptacion', estudio_id: null }, error: null },
    );

    await invitarCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', invitacion('7654321'));
    await getCoarrendatarioPorExpediente(EXPEDIENTE_ID, GESTOR_ID, 'administrador');

    const selects = selectsDevueltos();
    expect(selects).toHaveLength(2);
    for (const cols of selects) expect(cols).not.toMatch(PRIVADAS);
    // El vencimiento sí: la tarjeta avisa cuando la invitación venció.
    expect(selects[1]).toContain('token_expiracion');
  });

  it('reenviar devuelve la fila actualizada sin el token nuevo', async () => {
    enqueue('expedientes', ctxRow());
    enqueue(
      'expediente_coarrendatarios',
      { data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, estado: 'pendiente_aceptacion', token: 'viejo' }, error: null },
      { data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, nombre: 'Luis', email: 'luis@correo.co', estado: 'pendiente_aceptacion' }, error: null },
    );

    await reenviarInvitacionCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', {});

    const i = ops.findIndex((o) => o.table === 'expediente_coarrendatarios' && o.method === 'update');
    const trasUpdate = ops.slice(i).find((o) => o.table === 'expediente_coarrendatarios' && o.method === 'select');
    expect(String(trasUpdate?.args[0])).not.toMatch(PRIVADAS);
  });
});

// ============================================================
// Ley 1266: lo que el titular (o la agencia) ve de la otra persona
// ============================================================

describe('getCoarrendatarioPorExpediente / invitar — datos del co-arrendatario', () => {
  const TITULAR_ID = 'bb0e8400-e29b-41d4-a716-446655440000';
  const ctxTitular = () => {
    const r = ctxRow();
    r.data.solicitantes.creado_por = TITULAR_ID as never;
    return r;
  };
  const coaRow = { data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, estado: 'estudio_completado', estudio_id: COA_ESTUDIO_ID }, error: null };
  const selectsCoa = () =>
    ops.filter((o) => o.table === 'expediente_coarrendatarios' && o.method === 'select').map((o) => String(o.args[0]));

  it('al titular no le embebe el estudio (score/observaciones) ni le devuelve el token', async () => {
    enqueue('expedientes', ctxTitular());
    enqueue('expediente_coarrendatarios', coaRow);
    enqueue('estudios', { data: { id: COA_ESTUDIO_ID, score: 780, observaciones: 'saldos' }, error: null });

    const coa = await getCoarrendatarioPorExpediente(EXPEDIENTE_ID, TITULAR_ID, 'solicitante');

    expect(coa?.estudio).toBeNull();
    expect(ops.some((o) => o.table === 'estudios')).toBe(false);
    expect(selectsCoa().every((c) => c !== '*' && !/\btoken\b/.test(c))).toBe(true);
  });

  it('al gestor si le embebe el estudio', async () => {
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', coaRow);
    enqueue('estudios', { data: { id: COA_ESTUDIO_ID, score: 780 }, error: null });

    const coa = await getCoarrendatarioPorExpediente(EXPEDIENTE_ID, GESTOR_ID, 'operador_analista');

    expect(coa?.estudio).toMatchObject({ score: 780 });
  });

  it('la invitacion recien creada tampoco devuelve el token', async () => {
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', cupo, { data: { id: COA_ID }, error: null });

    await invitarCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', invitacion('7654321'));

    expect(selectsCoa().length).toBeGreaterThan(0);
    expect(selectsCoa().every((c) => c !== '*' && !/\btoken\b/.test(c))).toBe(true);
  });
});

// ============================================================
// Cartera: un miembro restringido de la inmobiliaria no ve el co-arrendatario
// de un estudio ajeno solo por ser de la misma organizacion.
// ============================================================

describe('acceso de la inmobiliaria por cartera', () => {
  const MIEMBRO_ID = 'cc0e8400-e29b-41d4-a716-446655440000';

  it('fuera de su cartera: 403 y no lee la fila del co-arrendatario', async () => {
    mockAssertExpedienteAccess.mockRejectedValueOnce(new Error('404'));
    enqueue('expedientes', ctxRow());

    await expect(getCoarrendatarioPorExpediente(EXPEDIENTE_ID, MIEMBRO_ID, 'inmobiliaria')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockAssertExpedienteAccess).toHaveBeenCalledWith(EXPEDIENTE_ID, MIEMBRO_ID, 'inmobiliaria');
    expect(ops.some((o) => o.table === 'expediente_coarrendatarios')).toBe(false);
  });

  it('en su cartera: lo ve', async () => {
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', { data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, estado: 'pendiente_aceptacion', estudio_id: null }, error: null });

    const coa = await getCoarrendatarioPorExpediente(EXPEDIENTE_ID, MIEMBRO_ID, 'inmobiliaria');
    expect(coa?.id).toBe(COA_ID);
  });
});

// ============================================================
// Aceptar: si el estudio no se puede crear, la invitacion vuelve a quedar
// pendiente (antes quedaba 'aceptado' sin estudio y sin salida).
// ============================================================

describe('aceptarInvitacion — fallo al crear el estudio', () => {
  it('revierte el claim y deja la autorizacion como esta', async () => {
    enqueue(
      'expediente_coarrendatarios',
      {
        data: {
          id: COA_ID,
          expediente_id: EXPEDIENTE_ID,
          estado: 'pendiente_aceptacion',
          token_expiracion: new Date(Date.now() + 86_400_000).toISOString(),
          nombre: 'Luis',
          apellido: 'Gómez',
          tipo_documento: 'cc',
          numero_documento: '7654321',
          email: 'luis@correo.co',
        },
        error: null,
      },
      { data: [{ id: COA_ID }], error: null }, // claim
    );
    // Antes del claim y otra vez después (P3: pudo resolverse entre los dos).
    enqueue('expedientes', ctxRow(), ctxRow());
    enqueue('autorizaciones_habeas_data', { data: { id: 'aut-1' }, error: null });
    enqueue('estudios', { data: null, error: null }, { data: null, error: { message: 'timeout' } });

    await expect(aceptarInvitacion('t'.repeat(64), '1.1.1.1', 'ua', {} as never)).rejects.toMatchObject({
      statusCode: 500,
    });

    const updates = ops.filter((o) => o.table === 'expediente_coarrendatarios' && o.method === 'update');
    expect((updates.at(-1)!.args[0] as { estado: string }).estado).toBe('pendiente_aceptacion');
    expect(ops.some((o) => o.table === 'autorizaciones_habeas_data' && o.method === 'update')).toBe(false);
  });
});

// ============================================================
// Carrera aceptar vs. reenviar/decidir: el claim exige el mismo token y, tras
// él, el estudio todavía en revisión.
// ============================================================

describe('aceptarInvitacion — carrera del claim', () => {
  const TOKEN = 't'.repeat(64);
  const pendiente = {
    data: {
      id: COA_ID,
      expediente_id: EXPEDIENTE_ID,
      estado: 'pendiente_aceptacion',
      token_expiracion: new Date(Date.now() + 86_400_000).toISOString(),
      numero_documento: '7654321',
    },
    error: null,
  };

  it('el claim exige el token del enlace: si se reenvió con otro documento, no se acepta', async () => {
    enqueue('expediente_coarrendatarios', pendiente, { data: [], error: null });
    enqueue('expedientes', ctxRow());

    await expect(aceptarInvitacion(TOKEN, '1.1.1.1', 'ua', {} as never)).rejects.toMatchObject({
      errorCode: 'COARRENDATARIO_YA_PROCESADA',
    });
    // El filtro va en el UPDATE del claim, no solo en la lectura inicial.
    const claim = ops.findIndex((o) => o.table === 'expediente_coarrendatarios' && o.method === 'update');
    expect(ops.slice(claim)).toContainEqual({ table: 'expediente_coarrendatarios', method: 'eq', args: ['token', TOKEN] });
    expect(ops.some((o) => o.table === 'autorizaciones_habeas_data' || o.table === 'estudios')).toBe(false);
  });

  it('si el estudio se resolvió entre la lectura y el claim, devuelve la invitación y no consulta el buró', async () => {
    enqueue('expediente_coarrendatarios', pendiente, { data: [{ id: COA_ID }], error: null });
    enqueue('expedientes', ctxRow(), ctxRow('aprobado'));

    await expect(aceptarInvitacion(TOKEN, '1.1.1.1', 'ua', {} as never)).rejects.toMatchObject({
      errorCode: 'COARRENDATARIO_INVITACION_NO_VIGENTE',
    });
    const updates = ops.filter((o) => o.table === 'expediente_coarrendatarios' && o.method === 'update');
    expect(updates.at(-1)!.args[0]).toMatchObject({ estado: 'pendiente_aceptacion', direccion: null, municipio: null });
    expect(ops.some((o) => o.table === 'autorizaciones_habeas_data' || o.table === 'estudios')).toBe(false);
  });
});

// ============================================================
// P4: antes de aceptar se cancela o se corrige y reenvía; después, uno por estudio
// ============================================================

describe('reemplazar al co-arrendatario — P4', () => {
  it('cancelar: solo la pendiente, rota el token (el enlace viejo muere) y deja rastro', async () => {
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', { data: [{ id: COA_ID, nombre: 'Luis' }], error: null });

    await expect(cancelarInvitacionCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador')).resolves.toEqual({ ok: true });

    const update = ops.find((o) => o.table === 'expediente_coarrendatarios' && o.method === 'update');
    const payload = update!.args[0] as { estado: string; token: string };
    expect(payload.estado).toBe('rechazado_invitacion');
    expect(payload.token).toMatch(/^[a-f0-9]{64}$/);
    expect(ops).toContainEqual({ table: 'expediente_coarrendatarios', method: 'eq', args: ['estado', 'pendiente_aceptacion'] });
    expect(ops.some((o) => o.table === 'eventos_timeline' && o.method === 'insert')).toBe(true);
  });

  it('cancelar una ya aceptada: 400, uno por estudio', async () => {
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', { data: [], error: null });

    await expect(cancelarInvitacionCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador')).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'COARRENDATARIO_NO_PENDIENTE',
      message: expect.stringContaining('uno por estudio'),
    });
  });

  it('cancelar fuera de la cartera: 403 sin tocar la invitación', async () => {
    mockAssertExpedienteAccess.mockRejectedValueOnce(new Error('404'));
    enqueue('expedientes', ctxRow());

    await expect(cancelarInvitacionCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'inmobiliaria')).rejects.toMatchObject({ statusCode: 403 });
    expect(ops.some((o) => o.table === 'expediente_coarrendatarios')).toBe(false);
  });

  it('reenviar corrige nombre y documento', async () => {
    enqueue('expedientes', ctxRow());
    enqueue(
      'expediente_coarrendatarios',
      { data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, estado: 'pendiente_aceptacion' }, error: null },
      { data: { id: COA_ID, nombre: 'Luisa', email: 'luis@correo.co', estado: 'pendiente_aceptacion' }, error: null },
    );

    await reenviarInvitacionCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', {
      nombre: 'Luisa',
      tipo_documento: 'ce',
      numero_documento: '7654329',
    });

    const update = ops.find((o) => o.table === 'expediente_coarrendatarios' && o.method === 'update');
    expect(update!.args[0]).toMatchObject({ nombre: 'Luisa', tipo_documento: 'ce', numero_documento: '7654329' });
  });

  it('reenviar con el documento del titular: 400, igual que al invitar', async () => {
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', { data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, estado: 'pendiente_aceptacion' }, error: null });

    await expect(
      reenviarInvitacionCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', { numero_documento: '1234567' }),
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'COARRENDATARIO_MISMO_DOCUMENTO' });
    expect(ops.some((o) => o.table === 'expediente_coarrendatarios' && o.method === 'update')).toBe(false);
  });

  it('invitar con otra ya activa: el 23505 dice cómo salir', async () => {
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', cupo, { data: null, error: { code: '23505', message: 'duplicate' } });

    await expect(invitarCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', invitacion('7654321'))).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('cancélala para invitar a otra persona'),
    });
  });

  it('la vista pública muestra el documento enmascarado', async () => {
    enqueue('expediente_coarrendatarios', {
      data: {
        id: COA_ID,
        expediente_id: EXPEDIENTE_ID,
        nombre: 'Luis',
        apellido: 'Gómez',
        tipo_documento: 'cc',
        numero_documento: '1.017.654.321',
        email: 'luis@correo.co',
        estado: 'pendiente_aceptacion',
        token_expiracion: new Date(Date.now() + 86_400_000).toISOString(),
      },
      error: null,
    });
    enqueue('expedientes', ctxRow());

    const vista = await getPublicByToken('t'.repeat(64));

    expect(vista.documento).toBe('CC ••••4321');
    expect(JSON.stringify(vista)).not.toContain('017654321');
  });
});

// ============================================================
// P18: el prospecto invita a su co-arrendatario desde su enlace personal
// ============================================================

describe('invitar desde el enlace del prospecto — P18', () => {
  it('crea la invitación sin gestor (invitado_por null), avisa al responsable y le devuelve solo nombre y estado', async () => {
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', cupo, {
      data: { id: COA_ID, nombre: 'Luis', email: 'luis@correo.co', numero_documento: '7654321', estado: 'pendiente_aceptacion' },
      error: null,
    });

    const r = await invitarCoarrendatarioPorToken('t'.repeat(64), invitacion('7654321'));

    expect(mockResolverToken).toHaveBeenCalledWith('t'.repeat(64));
    expect(r).toEqual({ nombre: 'Luis', estado: 'pendiente_aceptacion' });
    const insert = ops.find((o) => o.table === 'expediente_coarrendatarios' && o.method === 'insert');
    expect(insert!.args[0]).toMatchObject({ expediente_id: EXPEDIENTE_ID, invitado_por: null });
    expect(mockNotificarResponsable).toHaveBeenCalledWith(
      expect.objectContaining({ expedienteId: EXPEDIENTE_ID, titulo: 'El solicitante invitó a su co-arrendatario' }),
    );
  });

  it('mismos guards que el panel: su propio documento no, con un mensaje que no lo confirma', async () => {
    enqueue('expedientes', ctxRow());

    const e = await invitarCoarrendatarioPorToken('t'.repeat(64), invitacion('1234567')).catch((x) => x);

    expect(e).toMatchObject({ statusCode: 400, errorCode: 'COARRENDATARIO_NO_INVITABLE' });
    expect(e.message).not.toMatch(/documento|titular|solicitante/i);
    expect(ops.some((o) => o.method === 'insert')).toBe(false);
  });

  it.each([
    ['el correo del titular', { ...invitacion('7654321'), email: 'ana@correo.co' }, null],
    ['otra invitación activa (23505)', invitacion('7654321'), { data: null, error: { code: '23505', message: 'duplicate' } }],
  ])('%s: el mismo mensaje genérico, sin «cancélala»', async (_, datos, insert) => {
    enqueue('expedientes', ctxRow());
    if (insert) enqueue('expediente_coarrendatarios', cupo, insert);

    const e = await invitarCoarrendatarioPorToken('t'.repeat(64), datos).catch((x) => x);

    expect(e).toMatchObject({ errorCode: 'COARRENDATARIO_NO_INVITABLE' });
    expect(e.message).not.toMatch(/cancélala|correo|solicitante/i);
  });

  it('tope por estudio antes de mirar al titular: con su propio documento responde el tope, no lo delata', async () => {
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', { data: null, error: null, count: 5 });

    await expect(invitarCoarrendatarioPorToken('t'.repeat(64), invitacion('1234567'))).rejects.toMatchObject({
      errorCode: 'COARRENDATARIO_TOPE_INVITACIONES',
    });
  });

  it('tope por estudio: con 5 invitaciones (también canceladas) no crea otra', async () => {
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', { data: null, error: null, count: 5 });

    await expect(invitarCoarrendatarioPorToken('t'.repeat(64), invitacion('7654321'))).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'COARRENDATARIO_TOPE_INVITACIONES',
    });
    expect(ops.some((o) => o.method === 'insert')).toBe(false);
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('mismos guards que el panel: solo con el estudio condicionado', async () => {
    enqueue('expedientes', ctxRow('aprobado'));

    await expect(invitarCoarrendatarioPorToken('t'.repeat(64), invitacion('7654321'))).rejects.toMatchObject({
      errorCode: 'EXPEDIENTE_NO_CONDICIONADO',
    });
  });
});

// ============================================================
// P3: fuera de 'condicionado' la invitación pendiente queda sin efecto
// ============================================================

describe('invitación fuera de condicionado — P3', () => {
  const pendiente = {
    data: {
      id: COA_ID,
      expediente_id: EXPEDIENTE_ID,
      nombre: 'Luis',
      apellido: 'Gómez',
      email: 'luis@correo.co',
      estado: 'pendiente_aceptacion',
      token_expiracion: new Date(Date.now() + 86_400_000).toISOString(),
    },
    error: null,
  };
  const noVigente = { statusCode: 400, errorCode: 'COARRENDATARIO_INVITACION_NO_VIGENTE' };

  it('aceptar: no reclama la invitación ni crea la evaluación', async () => {
    enqueue('expediente_coarrendatarios', pendiente);
    enqueue('expedientes', ctxRow('aprobado'));

    await expect(aceptarInvitacion('t'.repeat(64), '1.1.1.1', 'ua', {} as never)).rejects.toMatchObject(noVigente);

    expect(ops.some((o) => o.method === 'update' || o.method === 'insert')).toBe(false);
  });

  it('la vista pública no la ofrece para aceptar', async () => {
    enqueue('expediente_coarrendatarios', pendiente);
    enqueue('expedientes', ctxRow('rechazado'));

    await expect(getPublicByToken('t'.repeat(64))).rejects.toMatchObject(noVigente);
  });

  it('reenviar tampoco', async () => {
    enqueue('expedientes', ctxRow('aprobado'));

    await expect(reenviarInvitacionCoarrendatario(EXPEDIENTE_ID, GESTOR_ID, 'administrador', {})).rejects.toMatchObject(noVigente);
    expect(ops.some((o) => o.table === 'expediente_coarrendatarios')).toBe(false);
  });
});

describe('co-arrendatario evaluado sobre un estudio ya decidido — P3', () => {
  const coaEstudio = (resultado: string) => ({
    data: { id: COA_ESTUDIO_ID, expediente_id: EXPEDIENTE_ID, tipo: 'con_coarrendatario', estado: 'completado', resultado, score: 700, motivo_rechazo: null },
    error: null,
  });
  // Lectura por estudio_id + el UPDATE a 'estudio_completado' (su await consume la cola).
  const coaRow = { data: { id: COA_ID, expediente_id: EXPEDIENTE_ID, nombre: 'Luis', apellido: 'Gómez', email: 'luis@correo.co' }, error: null };
  const marcaCompletado = { data: null, error: null };
  const titularCondicionado = { data: [{ id: TITULAR_ESTUDIO_ID, resultado: 'condicionado', score: 720 }], error: null };
  // Lecturas del aviso final al co-arrendatario (avisarCoarrendatarioDecision).
  const encolarAvisoCoa = (resultado: string, estado: string) => {
    enqueue('expediente_coarrendatarios', { data: { id: COA_ID, nombre: 'Luis', email: 'luis@correo.co', estudio_id: COA_ESTUDIO_ID }, error: null });
    enqueue('estudios', { data: { resultado, score: 700, motivo_rechazo: null }, error: null });
    enqueue('expedientes', ctxRow(estado));
  };

  it('ya aprobado por el analista: sin «sigue en revisión», CRC regenerado y el co-arrendatario recibe la decisión real', async () => {
    enqueue('estudios', coaEstudio('aprobado'), titularCondicionado);
    enqueue('expediente_coarrendatarios', coaRow, marcaCompletado);
    enqueue('expedientes', ctxRow('aprobado'));
    encolarAvisoCoa('aprobado', 'aprobado');

    await onCoarrendatarioEstudioCompletado(COA_ESTUDIO_ID, { reglasDuras: [] });

    expect(ops.some((o) => o.table === 'eventos_timeline')).toBe(false);
    expect(mockNotificarUsuario).not.toHaveBeenCalled();
    // Sin contrato generado todavía: el CRC se regenera con el acompañante.
    await vi.waitFor(() => expect(mockEmitirCrc).toHaveBeenCalledWith(TITULAR_ESTUDIO_ID, GESTOR_ID, { regenerar: true }));
    await vi.waitFor(() => expect(mockResendSend).toHaveBeenCalledTimes(1));
    expect((mockResendSend.mock.calls[0] as unknown as [{ subject: string }])[0].subject).toContain('se aprobó');
  });

  // Con el asistente de contratos (flag + inmueble de inmobiliaria) se puede rehacer
  // con él; sin él, el contrato anterior no admite co-arrendatario (P6): se mantiene.
  it.each([
    ['con el asistente de contratos', true, 'org-1', 'cancela el contrato y genera uno nuevo desde el asistente'],
    ['sin el asistente (propietario directo)', true, null, 'El contrato actual se mantiene sin él. Si debe entrar, escríbenos a soporte@cofianza.co'],
    ['sin el asistente (flag apagado)', false, 'org-1', 'El contrato actual se mantiene sin él'],
  ])('con un contrato ya generado sin él, %s: no regenera el CRC, avisa al gestor la salida que aplica', async (_, flag, inmobiliaria, salida) => {
    mockEnv.CONTRATOS_V3_ENABLED = flag as never;
    mockGetCompany.mockResolvedValueOnce({ email: 'soporte@cofianza.co' });
    try {
      enqueue('estudios', coaEstudio('aprobado'), titularCondicionado);
      enqueue('expediente_coarrendatarios', coaRow, marcaCompletado);
      const ctx = ctxRow('aprobado');
      ctx.data.inmuebles.inmobiliaria_id = inmobiliaria as never;
      enqueue('expedientes', ctx);
      // Contrato anterior vivo, generado sin coarrendatario.
      enqueue('contratos', { data: [{ id: 'cto-1', estado: 'vigente', destinacion: null, coa_anidado: null, coa_plano: '' }], error: null });
      encolarAvisoCoa('aprobado', 'aprobado');

      await onCoarrendatarioEstudioCompletado(COA_ESTUDIO_ID, { reglasDuras: [] });

      await vi.waitFor(() => expect(mockResendSend).toHaveBeenCalledTimes(1));
      expect(mockEmitirCrc).not.toHaveBeenCalled();
      expect(mockNotificarUsuario).toHaveBeenCalledWith(
        expect.objectContaining({ userId: PROPIETARIO_ID, mensaje: expect.stringContaining(salida) }),
      );
      const { html } = (mockResendSend.mock.calls[0] as unknown as [{ html: string }])[0];
      expect(html).toContain('no haces parte');
      expect(html).not.toContain('Buenas noticias');
    } finally {
      delete (mockEnv as Record<string, unknown>).CONTRATOS_V3_ENABLED;
    }
  });

  it('estudio cerrado mientras se evaluaba: el co-arrendatario recibe el correo de cierre', async () => {
    enqueue('estudios', coaEstudio('aprobado'), titularCondicionado);
    enqueue('expediente_coarrendatarios', coaRow, marcaCompletado);
    enqueue('expedientes', ctxRow('cerrado'));
    encolarAvisoCoa('aprobado', 'cerrado');

    await onCoarrendatarioEstudioCompletado(COA_ESTUDIO_ID, { reglasDuras: [] });

    await vi.waitFor(() => expect(mockResendSend).toHaveBeenCalledTimes(1));
    const { subject } = (mockResendSend.mock.calls[0] as unknown as [{ subject: string }])[0];
    expect(subject).toContain('Se cerró el estudio');
    expect(mockEmitirCrc).not.toHaveBeenCalled();
  });

  it('regla dura (listas) después de aprobar: la aprobación se mantiene, queda fuera y se avisa a los analistas', async () => {
    enqueue('estudios', coaEstudio('rechazado'), titularCondicionado);
    enqueue('expediente_coarrendatarios', coaRow, marcaCompletado);
    // El UPDATE race-safe no encuentra el estudio en 'condicionado' (0 filas).
    enqueue('expedientes', { data: [], error: null }, ctxRow('aprobado'));
    encolarAvisoCoa('rechazado', 'aprobado');

    await onCoarrendatarioEstudioCompletado(COA_ESTUDIO_ID, { reglasDuras: ['listas_restrictivas' as never] });

    await vi.waitFor(() =>
      expect(mockNotificarUsuario).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'analista-1',
          titulo: expect.stringContaining('regla dura'),
          mensaje: expect.stringContaining('«Cambiar estado»'),
        }),
      ),
    );
    expect(mockLiberarReserva).not.toHaveBeenCalled();
    expect(mockAvisarSolicitante).not.toHaveBeenCalled();
    expect(mockEmitirCrc).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mockResendSend).toHaveBeenCalledTimes(1));
  });
});

// ============================================================
// Politica §5, ultima fila de la tabla: regla dura del coarrendatario
// ============================================================

describe('onCoarrendatarioEstudioCompletado — ponderacion', () => {
  const coaEstudio = (resultado: string) => ({
    data: { id: COA_ESTUDIO_ID, expediente_id: EXPEDIENTE_ID, tipo: 'con_coarrendatario', estado: 'completado', resultado, score: 700, motivo_rechazo: null },
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

  it('Politica §11: el rechazo le llega al prospecto (no al gestor) sin las reglas del co-arrendatario', async () => {
    enqueue('estudios', coaEstudio('rechazado'), titularRows('aprobado'));
    enqueue('expediente_coarrendatarios', coaRow);
    const ctxGestor = ctxRow();
    ctxGestor.data.solicitantes.creado_por = GESTOR_ID as never;
    enqueue('expedientes', { data: [{ id: EXPEDIENTE_ID }], error: null }, ctxGestor);

    await onCoarrendatarioEstudioCompletado(COA_ESTUDIO_ID, { reglasDuras: ['dti_mayor_65'] });

    await vi.waitFor(() =>
      expect(mockAvisarSolicitante).toHaveBeenCalledWith(EXPEDIENTE_ID, 'rechazado', expect.stringContaining('evaluación conjunta')),
    );
    expect(String(mockAvisarSolicitante.mock.calls[0][2])).not.toMatch(/DTI|mora/i);
    expect(mockNotificarUsuario).not.toHaveBeenCalledWith(expect.objectContaining({ userId: GESTOR_ID }));
  });

  it('titular aprobado + coarrendatario rechazado por SCORE sigue aprobado (fila sin definir en la Politica)', async () => {
    enqueue('estudios', coaEstudio('rechazado'), titularRows('aprobado'));
    enqueue('expediente_coarrendatarios', coaRow);
    enqueue('expedientes', { data: [{ id: EXPEDIENTE_ID }], error: null }, ctxRow(), ctxRow());

    await onCoarrendatarioEstudioCompletado(COA_ESTUDIO_ID, { reglasDuras: [] });

    const update = ops.find((o) => o.table === 'expedientes' && o.method === 'update');
    expect((update!.args[0] as { estado: string }).estado).toBe('aprobado');
    expect(mockLiberarReserva).not.toHaveBeenCalled();
    // P2: con la evaluación rechazada no entra al contrato; el dueño no lee «con co-arrendatario».
    expect(mockNotificarUsuario).toHaveBeenCalledWith(
      expect.objectContaining({ userId: PROPIETARIO_ID, titulo: 'Solicitante aprobado', mensaje: expect.stringContaining('va sin él') }),
    );
  });

  it('Adenda 2 §5: titular condicionado + coarrendatario aprobado ya NO se aprueba solo (decide el analista)', async () => {
    enqueue('estudios', coaEstudio('aprobado'), titularRows('condicionado'));
    enqueue('expediente_coarrendatarios', coaRow);
    enqueue('expedientes', ctxRow());

    await onCoarrendatarioEstudioCompletado(COA_ESTUDIO_ID, { reglasDuras: [] });

    expect(ops.some((o) => o.table === 'expedientes' && o.method === 'update')).toBe(false);
    const timeline = ops.find((o) => o.table === 'eventos_timeline' && o.method === 'insert');
    expect((timeline!.args[0] as { metadata: { resultado: string } }).metadata.resultado).toBe('revision_manual');
    await vi.waitFor(() => expect(mockListOperators).toHaveBeenCalled());
    expect(mockEmitirCrc).not.toHaveBeenCalled();
  });

  it('con el motor: 70-84 + coarrendatario >= 80 se aprueba solo y el CRC se regenera (Adenda 1 §3, Flujo §10/§11)', async () => {
    mockEnv.MOTOR_DECIDE_ENABLED = true;
    try {
      enqueue('estudios', coaEstudio('aprobado'), titularRows('condicionado'));
      enqueue('expediente_coarrendatarios', coaRow);
      enqueue('estudios_scorecard_sombra', {
        data: [
          { estudio_id: TITULAR_ESTUDIO_ID, puntaje_normalizado: 75 },
          { estudio_id: COA_ESTUDIO_ID, puntaje_normalizado: 85 },
        ],
        error: null,
      });
      // UPDATE + ctx del paso 7 (que tambien firma el CRC con creado_por).
      enqueue('expedientes', { data: [{ id: EXPEDIENTE_ID }], error: null }, ctxRow('aprobado'));

      await onCoarrendatarioEstudioCompletado(COA_ESTUDIO_ID, { reglasDuras: [] });

      const update = ops.find((o) => o.table === 'expedientes' && o.method === 'update');
      expect((update!.args[0] as { estado: string }).estado).toBe('aprobado');
      await vi.waitFor(() =>
        expect(mockEmitirCrc).toHaveBeenCalledWith(TITULAR_ESTUDIO_ID, GESTOR_ID, { regenerar: true }),
      );
    } finally {
      mockEnv.MOTOR_DECIDE_ENABLED = false;
    }
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

// ============================================================
// Correo al coarrendatario (puro): lo unico que el recibe de Cofianza
// ============================================================

describe('construirCorreoCoarrendatario', () => {
  const base = {
    email: 'coa@correo.co',
    nombre: 'Ana',
    coarrendatarioScore: 720,
    titularNombre: 'Juan Pérez',
    inmuebleDireccion: 'Cra 7 # 45-10',
    inmuebleCiudad: 'Bogotá',
    emailApelacion: 'hola@cofianza.co',
  } as const;
  const APELACION = /hola@cofianza\.co[\s\S]*15 días hábiles[\s\S]*10 días hábiles/;

  it('en revisión manual: ni aprobado ni rechazado, y sin score', () => {
    const { subject, html } = construirCorreoCoarrendatario({
      ...base,
      coarrendatarioResultado: 'aprobado',
      decisionExpediente: 'en_revision',
    });
    expect(subject).toContain('Tu evaluación ya está lista');
    expect(html).toContain('analista de Cofianza');
    // El score solo va con una decision final.
    expect(html).not.toContain('720');
  });

  it('aprobado con su evaluación condicionada: no le dice que su evaluación quedó aprobada', () => {
    const { subject, html } = construirCorreoCoarrendatario({
      ...base,
      coarrendatarioResultado: 'condicionado',
      decisionExpediente: 'aprobado',
    });
    expect(subject).toContain('Se aprobó el arrendamiento');
    expect(subject).not.toContain('Tu evaluación se aprobó');
    expect(html).toContain('aprobó');
    expect(html).not.toContain('Tu evaluación crediticia quedó <strong style="color: #047857;">aprobada</strong>');
  });

  it('el nombre y el titular no inyectan HTML en el cuerpo; el asunto va en texto plano', () => {
    const PHISHING = '<a href="https://evil.co">Verifica tu cuenta</a>';
    const { subject, html } = construirCorreoCoarrendatario({
      ...base,
      nombre: PHISHING,
      titularNombre: PHISHING,
      coarrendatarioResultado: 'aprobado',
      decisionExpediente: 'aprobado',
    });
    expect(html).not.toContain('<a href="https://evil.co"');
    expect(html).toContain('&lt;a href=');
    expect(subject).toContain(PHISHING);
  });

  it('rechazado: cierra el proceso sin prometer nada', () => {
    const { html } = construirCorreoCoarrendatario({
      ...base,
      coarrendatarioResultado: 'condicionado',
      decisionExpediente: 'rechazado',
    });
    expect(html).toContain('El proceso queda cerrado');
  });

  // P38 (Política §1, §2, §11): no aprobado → sin puntaje y con su derecho de
  // apelación; aprobado → puede ver su score.
  it('no aprobado: sin score y con la apelación (hola@cofianza.co, 15 días hábiles, respuesta en 10)', () => {
    const { html } = construirCorreoCoarrendatario({ ...base, coarrendatarioResultado: 'rechazado', decisionExpediente: 'rechazado' });
    expect(html).not.toContain('720');
    expect(html).toMatch(APELACION);
  });

  it('aprobado: ve su score y no hay nada que apelar', () => {
    const { html } = construirCorreoCoarrendatario({ ...base, coarrendatarioResultado: 'aprobado', decisionExpediente: 'aprobado' });
    expect(html).toContain('Score crediticio: <strong>720</strong>');
    expect(html).not.toMatch(APELACION);
  });

  it('estudio aprobado pero su evaluación rechazada (P2, queda fuera): no le dice que se aprobó', () => {
    const { subject, html } = construirCorreoCoarrendatario({
      ...base,
      coarrendatarioResultado: 'rechazado',
      decisionExpediente: 'aprobado',
    });
    expect(subject).not.toMatch(/aprob/i);
    expect(html).toContain('no podemos respaldarte como co-arrendatario');
    expect(html).not.toContain('720');
    expect(html).toMatch(APELACION);
  });

  it('cierre sin decidir: no es una decisión sobre él (sin apelación); con su evaluación aprobada ve su score', () => {
    const { subject, html } = construirCorreoCoarrendatario({ ...base, coarrendatarioResultado: 'aprobado', decisionExpediente: 'cerrado' });
    expect(subject).toContain('Se cerró el estudio');
    expect(html).toContain('No es una decisión sobre ti');
    expect(html).toContain('720');
    expect(html).not.toMatch(APELACION);
  });

  it('cierre con su evaluación no aprobada: sin score y con la apelación', () => {
    const { html } = construirCorreoCoarrendatario({ ...base, coarrendatarioResultado: 'rechazado', decisionExpediente: 'cerrado' });
    expect(html).not.toContain('720');
    expect(html).toMatch(APELACION);
  });

  it('aprobado con el contrato ya generado sin él: no le dice que se aprobó con él ni le da score', () => {
    const { subject, html } = construirCorreoCoarrendatario({
      ...base,
      coarrendatarioResultado: 'condicionado',
      decisionExpediente: 'aprobado',
      contratoSinEl: true,
    });
    expect(subject).not.toMatch(/aprob/i);
    expect(html).toContain('no haces parte');
    expect(html).not.toContain('720');
    expect(html).not.toMatch(APELACION);
  });

  it('su evaluación aprobada aunque el estudio no: ve su score, sin apelación', () => {
    const { html } = construirCorreoCoarrendatario({ ...base, coarrendatarioResultado: 'aprobado', decisionExpediente: 'rechazado' });
    expect(html).toContain('720');
    expect(html).not.toMatch(APELACION);
  });
});

describe('avisarInvitacionSinEfecto — P3', () => {
  it('le escribe que su invitación quedó sin efecto, sin score ni apelación', async () => {
    enqueue('expediente_coarrendatarios', { data: { nombre: 'Luis', email: 'luis@correo.co', expediente_id: EXPEDIENTE_ID }, error: null });
    enqueue('expedientes', ctxRow('aprobado'));

    await avisarInvitacionSinEfecto(COA_ESTUDIO_ID);

    const { to, subject, html } = (mockResendSend.mock.calls[0] as unknown as [{ to: string; subject: string; html: string }])[0];
    expect(to).toBe('luis@correo.co');
    expect(subject).toContain('quedó sin efecto');
    expect(html).not.toMatch(/Score|15 días hábiles/);
  });
});

describe('avisarCoarrendatarioDecision — decisión del analista', () => {
  it('si su evaluación se rechazó por regla dura no lo manda a la central de riesgo', async () => {
    enqueue('expediente_coarrendatarios', { data: { id: COA_ID, nombre: 'Luis', email: 'luis@correo.co', estudio_id: COA_ESTUDIO_ID }, error: null });
    enqueue('estudios', { data: { resultado: 'rechazado', score: 790, motivo_rechazo: 'DTI [regla dura]' }, error: null });
    enqueue('expedientes', ctxRow('rechazado'));

    await avisarCoarrendatarioDecision(EXPEDIENTE_ID, 'rechazado');

    const { html } = (mockResendSend.mock.calls[0] as unknown as [{ html: string }])[0];
    expect(html).not.toContain('central de riesgo');
    expect(html).not.toContain('790');
    expect(html).toMatch(/15 días hábiles/);
  });
});

// ============================================================
// El correo de contacto sale de la configuración de la empresa, no fijo.
// ============================================================

describe('correo de contacto de la empresa', () => {
  it('el mensaje del tope de invitaciones lo usa', async () => {
    mockGetCompany.mockResolvedValueOnce({ email: 'soporte@cofianza.co' });
    enqueue('expedientes', ctxRow());
    enqueue('expediente_coarrendatarios', { data: null, error: null, count: 5 });

    await expect(invitarCoarrendatarioPorToken('t'.repeat(64), invitacion('7654321'))).rejects.toMatchObject({
      message: expect.stringContaining('soporte@cofianza.co'),
    });
  });
});

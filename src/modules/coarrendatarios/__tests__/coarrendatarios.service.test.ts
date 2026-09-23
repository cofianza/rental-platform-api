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
  getCoarrendatarioPorExpediente,
  reenviarInvitacionCoarrendatario,
  onCoarrendatarioEstudioCompletado,
  construirCorreoCoarrendatario,
  rechazarInvitacion,
  aceptarInvitacion,
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
// Ley 1581: el token de la invitacion nunca viaja al cliente. Con el, el
// titular o el gestor podian aceptar el habeas data en nombre del invitado.
// ============================================================

describe('respuestas al cliente sin el token de la invitacion', () => {
  const PRIVADAS = /\*|\btoken\b|aceptado_ip|aceptado_user_agent|invitado_por/;
  // Selects cuyo resultado se devuelve: los que van tras insert/update y el
  // de la consulta. El select('*') interno del reenvio no sale de la API.
  const selectsDevueltos = () =>
    ops
      .filter((o) => o.table === 'expediente_coarrendatarios' && o.method === 'select')
      .map((o) => String(o.args[0]));

  it('invitar y consultar piden solo columnas publicas', async () => {
    enqueue('expedientes', ctxRow(), ctxRow());
    enqueue(
      'expediente_coarrendatarios',
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
    enqueue('expediente_coarrendatarios', { data: { id: COA_ID }, error: null });

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
  } as const;

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
    const { html } = construirCorreoCoarrendatario({
      ...base,
      coarrendatarioResultado: 'condicionado',
      decisionExpediente: 'aprobado',
    });
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
});

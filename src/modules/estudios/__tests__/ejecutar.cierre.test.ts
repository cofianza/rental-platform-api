import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// P1/P3: el cierre del estudio y ejecutarEstudio se excluyen con la propia
// evaluación. Si el cierre llega entre el guard y el lock a 'en_proceso', se
// deshace el lock (nadie consultó el buró) y se revisa la devolución. Mismo
// mock de Supabase que estudios.enlace-cancelar.test.ts: colas por tabla + `ops`.

const { mockEnv, mockFlags, ops, queues, enqueue, mockFrom, mockDevolver, mockSolicitar, mockObtener, mockSinEfecto } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const METODOS = ['select', 'update', 'insert', 'eq', 'neq', 'not', 'is', 'in', 'order', 'limit', 'range'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of METODOS) {
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
  const mockFlags: Record<string, boolean> = {};
  return {
    mockFlags,
    mockEnv: new Proxy({} as Record<string, unknown>, {
      get: (_t, k) =>
        typeof k === 'string' && k in mockFlags
          ? mockFlags[k]
          : typeof k === 'string' && (k.endsWith('_ENABLED') || k.startsWith('MOTOR_'))
            ? false
            : 'x',
    }),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockFrom: vi.fn((table: string) => chainFor(table)),
    mockDevolver: vi.fn(async () => undefined),
    // Por defecto el buró no contesta nunca (lo que corre tras el lock queda en
    // vuelo); cada prueba que lo necesita lo hace fallar.
    mockSolicitar: vi.fn((): Promise<unknown> => new Promise(() => {})),
    mockObtener: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
    mockSinEfecto: vi.fn(async () => undefined),
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/email', () => ({ sendEstudioFormEmail: vi.fn() }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({ DIAS_EXPIRACION_ESTUDIO: 30 })) }));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: vi.fn(),
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
  assertExpedienteAccess: vi.fn(async () => undefined),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(),
  findPerfilIdByEmail: vi.fn(),
  notificarResponsableExpediente: vi.fn(),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));
vi.mock('@/modules/pagos/pagos.service', () => ({ cancelarPagosPendientesDeExpediente: vi.fn() }));
vi.mock('@/modules/pagos/reembolsos.service', () => ({ devolverEvaluacionSinConsulta: mockDevolver }));
vi.mock('@/modules/coarrendatarios/coarrendatarios.service', () => ({ avisarInvitacionSinEfecto: mockSinEfecto }));
vi.mock('../tope-canon.guard', () => ({
  assertCanonDentroDelTope: vi.fn(async () => ({ canonCop: 1_500_000 })),
  leerCanonDelInmueble: vi.fn(),
}));
vi.mock('../autorizacion.guard', () => ({
  assertAutorizacionVigente: vi.fn(async () => ({ autorizacionId: 'aut-1' })),
  AUTORIZACION_PREVIA_ERROR_CODE: 'AUTORIZACION_PREVIA_REQUERIDA',
}));
vi.mock('../providers/factory', () => ({
  getProvider: vi.fn(() => ({ solicitar: mockSolicitar, obtenerResultado: mockObtener })),
  getAllProviderIds: vi.fn(() => ['transunion', 'datacredito']),
}));
vi.mock('../pago.guard', () => ({
  leerSenalPagoEstudio: vi.fn(async () => 'pagado'),
  senalIndicaPagado: () => true,
  assertPagoEstudio: vi.fn(),
  estudioYaCobrado: vi.fn(async () => true),
  ESTADO_ESPERANDO_PAGO: 'pago_pendiente',
}));

import { supabase } from '@/lib/supabase';
import { ejecutarEstudio } from '../estudios.service';

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  for (const k of Object.keys(mockFlags)) delete mockFlags[k];
});

describe('ejecutarEstudio y el cierre del estudio', () => {
  it('si el estudio se cerró entre el guard y el lock, deshace el lock, no consulta y revisa la devolución', async () => {
    enqueue(
      'estudios',
      {
        data: {
          id: 'est-1', estado: 'formulario_completado', resultado: 'pendiente', score: null, proveedor: 'transunion',
          tipo: 'individual', datos_formulario: { numero_documento: '1020304050', tipo_documento: 'cc', nombre_completo: 'Ana Pérez' },
          expediente_id: 'exp-1',
        },
        error: null,
      },
      { data: [{ id: 'est-1' }], error: null }, // lock a en_proceso
    );
    enqueue(
      'expedientes',
      { data: { id: 'exp-1', numero: 'EXP-1', estado: 'en_revision', estudio_habilitado: true, solicitante_id: null, inmueble_id: 'inm-1' }, error: null },
      { data: { estado: 'cerrado' }, error: null }, // relectura tras el lock
    );

    await expect(ejecutarEstudio('est-1', 'admin-1', undefined, 'administrador')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'EXPEDIENTE_CERRADO',
    });

    const cambios = ops.filter((o) => o.table === 'estudios' && o.method === 'update').map((o) => (o.args[0] as { estado: string }).estado);
    expect(cambios).toEqual(['en_proceso', 'formulario_completado']);
    await vi.waitFor(() => expect(mockDevolver).toHaveBeenCalledWith('exp-1', 'Estudio cerrado', null));
  });

  const estudio = (extra: Record<string, unknown> = {}) => ({
    data: {
      id: 'est-1', estado: 'formulario_completado', resultado: 'pendiente', score: null, proveedor: 'transunion',
      tipo: 'individual', datos_formulario: { numero_documento: '1020304050', tipo_documento: 'cc', nombre_completo: 'Ana Pérez' },
      expediente_id: 'exp-1', ...extra,
    },
    error: null,
  });
  const expediente = (estado: string) => ({
    data: { id: 'exp-1', numero: 'EXP-1', estado, estudio_habilitado: true, solicitante_id: null, inmueble_id: 'inm-1' },
    error: null,
  });

  it('Q5b-2: un estudio rechazado no consulta el buró (ni toma el lock)', async () => {
    enqueue('estudios', estudio({ estado: 'fallido' }));
    enqueue('expedientes', expediente('rechazado'));

    await expect(ejecutarEstudio('est-1', 'admin-1', undefined, 'administrador')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'EXPEDIENTE_CERRADO',
    });
    expect(ops.some((o) => o.table === 'estudios' && o.method === 'update')).toBe(false);
  });

  it('Q5b-2: la re-evaluación con soportes (estudio hijo) sí corre sobre el rechazado', async () => {
    enqueue('estudios', estudio({ estudio_padre_id: 'est-0' }), { data: [{ id: 'est-1' }], error: null });
    enqueue('expedientes', expediente('rechazado'), { data: { estado: 'rechazado' }, error: null });

    const r = await ejecutarEstudio('est-1', 'admin-1', undefined, 'administrador').catch((e: { errorCode?: string }) => e);

    expect((r as { errorCode?: string } | undefined)?.errorCode).not.toBe('EXPEDIENTE_CERRADO');
    const cambios = ops.filter((o) => o.table === 'estudios' && o.method === 'update').map((o) => (o.args[0] as { estado?: string }).estado);
    expect(cambios).toEqual(['en_proceso']);
    expect(mockDevolver).not.toHaveBeenCalled();
  });

  it('Q5b-2: al deshacer el lock de un reintento con otro buró, vuelven la referencia y la respuesta del anterior', async () => {
    enqueue(
      'estudios',
      estudio({ estado: 'fallido', referencia_proveedor: 'TU-9', respuesta_proveedor: { codigo: 'x' } }),
      { data: [{ id: 'est-1' }], error: null }, // lock
    );
    enqueue('expedientes', expediente('condicionado'), { data: { estado: 'rechazado' }, error: null });

    await expect(
      ejecutarEstudio('est-1', 'admin-1', undefined, 'administrador', { proveedor: 'datacredito' }),
    ).rejects.toMatchObject({ errorCode: 'EXPEDIENTE_CERRADO' });

    const [lock, deshacer] = ops.filter((o) => o.table === 'estudios' && o.method === 'update').map((o) => o.args[0]);
    expect(lock).toMatchObject({ estado: 'en_proceso', proveedor: 'datacredito', referencia_proveedor: null });
    expect(deshacer).toEqual({ estado: 'fallido', proveedor: 'transunion', referencia_proveedor: 'TU-9', respuesta_proveedor: { codigo: 'x' } });
    await vi.waitFor(() => expect(mockDevolver).toHaveBeenCalledWith('exp-1', 'Estudio rechazado', null));
  });

  const actualizaciones = () => ops.filter((o) => o.table === 'estudios' && o.method === 'update').map((o) => o.args[0] as Record<string, unknown>);

  it('Q5c-2: si el reintento con otro buró falla sin dejar referencia, vuelve la prueba de la consulta anterior', async () => {
    mockSolicitar.mockRejectedValueOnce(new Error('HTTP 503'));
    enqueue(
      'estudios',
      estudio({ estado: 'fallido', referencia_proveedor: 'TU-9', respuesta_proveedor: { codigo: 'x' } }),
      { data: [{ id: 'est-1' }], error: null }, // lock
    );
    enqueue('expedientes', expediente('en_revision'), { data: { estado: 'en_revision' }, error: null });

    await ejecutarEstudio('est-1', 'admin-1', undefined, 'administrador', { proveedor: 'datacredito' }).catch(() => undefined);

    await vi.waitFor(() => expect(actualizaciones()).toHaveLength(2));
    const [lock, fallo] = actualizaciones();
    expect(lock).toMatchObject({ estado: 'en_proceso', proveedor: 'datacredito', referencia_proveedor: null });
    expect(fallo).toMatchObject({ estado: 'fallido', proveedor: 'transunion', referencia_proveedor: 'TU-9', respuesta_proveedor: { codigo: 'x' } });
  });

  it('Q5c-2: la re-consulta de un condicionado sin score que falla conserva el resultado del estudio', async () => {
    mockSolicitar.mockRejectedValueOnce(new Error('HTTP 503'));
    const previo = {
      estado: 'completado', resultado: 'condicionado', score: null, proveedor: 'transunion', referencia_proveedor: 'TU-5',
      respuesta_proveedor: { codigo: 14 }, observaciones: 'El buró no pudo evaluar', autorizacion_habeas_data_id: 'aut-0',
      canon_evaluado: 1_400_000, canon_evaluado_origen: 'inmueble',
    };
    enqueue('estudios', estudio(previo), { data: [{ id: 'est-1' }], error: null });
    enqueue('expedientes', expediente('condicionado'));

    await ejecutarEstudio('est-1', 'admin-1', undefined, 'administrador', { proveedor: 'datacredito' }).catch(() => undefined);

    await vi.waitFor(() => expect(actualizaciones()).toHaveLength(2));
    const [lock, fallo] = actualizaciones();
    expect(lock).toMatchObject({ estado: 'en_proceso', resultado: 'pendiente', referencia_proveedor: null });
    expect(fallo).toEqual(previo);
  });

  const condicionadoSinInfo = {
    estado: 'completado', resultado: 'condicionado', score: null, proveedor: 'transunion', referencia_proveedor: 'TU-5',
  };

  it('A1: con el caso ya decidido (expediente aprobado) no se consulta el otro buró', async () => {
    enqueue('estudios', estudio(condicionadoSinInfo));
    enqueue('expedientes', expediente('aprobado'));

    await expect(
      ejecutarEstudio('est-1', 'admin-1', undefined, 'administrador', { proveedor: 'datacredito' }),
    ).rejects.toMatchObject({ errorCode: 'ESTUDIO_ESTADO_INVALIDO' });
    expect(actualizaciones()).toHaveLength(0);
    expect(mockSolicitar).not.toHaveBeenCalled();
  });

  it('A1: el «aprobado» del otro buró sobre un caso en revisión manual queda condicionado, con nota al analista', async () => {
    mockSolicitar.mockResolvedValueOnce({ referencia_proveedor: 'DC-1', status: 'completed' });
    mockObtener.mockResolvedValueOnce({ resultado: 'aprobado', score: 780, observaciones: 'ok', datos_crudos: null });
    (supabase.rpc as unknown as Mock).mockResolvedValue({ error: null });
    enqueue('estudios', estudio(condicionadoSinInfo), { data: [{ id: 'est-1' }], error: null });
    // Cualquier lectura del expediente lo ve en revisión manual.
    for (let i = 0; i < 10; i++) enqueue('expedientes', expediente('condicionado'));

    await ejecutarEstudio('est-1', 'admin-1', undefined, 'administrador', { proveedor: 'datacredito' }).catch(() => undefined);

    await vi.waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('fn_registrar_resultado_estudio', expect.anything()));
    const args = (supabase.rpc as unknown as Mock).mock.calls.find((c) => c[0] === 'fn_registrar_resultado_estudio')![1];
    expect(args.p_resultado).toBe('condicionado');
    expect(args.p_observaciones).toMatch(/Para el analista/);
  });

  describe('Política §14 / matriz QA V2, caso L: ninguna central responde (motor encendido)', () => {
    const dosCaidas = () => {
      mockFlags.MOTOR_DECIDE_ENABLED = true;
      mockSolicitar.mockRejectedValueOnce(new Error('HTTP 503')).mockRejectedValueOnce(new Error('HTTP 503'));
      enqueue('estudios', estudio({ proveedor: 'datacredito' }), { data: [{ id: 'est-1' }], error: null });
      enqueue('expedientes', expediente('en_revision'), { data: { estado: 'en_revision' }, error: null });
    };

    it('queda condicionado (revisión manual), no fallido, con la traza NO_DISPONIBLE y las dos centrales caídas', async () => {
      dosCaidas();
      (supabase.rpc as unknown as Mock).mockResolvedValue({ error: null });

      await ejecutarEstudio('est-1', 'admin-1', undefined, 'administrador').catch(() => undefined);

      await vi.waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('fn_registrar_resultado_estudio', expect.anything()));
      const args = (supabase.rpc as unknown as Mock).mock.calls.find((c) => c[0] === 'fn_registrar_resultado_estudio')![1];
      expect(args).toMatchObject({ p_resultado: 'condicionado', p_score: null, p_motivo_rechazo: null });
      expect(args.p_observaciones).toMatch(/Ninguna central/);
      await vi.waitFor(() => expect(actualizaciones().some((u) => 'cascada' in u)).toBe(true));
      expect(actualizaciones().find((u) => 'cascada' in u)!.cascada).toMatchObject({
        primaria: 'transunion',
        primaria_original: 'datacredito',
        fallback_2_3: true,
        centrales_consultadas: [],
        apis_fallidas: ['datacredito', 'transunion'],
        fuente_score: 'NO_DISPONIBLE',
        resultado: 'condicionado',
        via: 'revision_manual',
      });
      expect(actualizaciones().some((u) => u.estado === 'fallido')).toBe(false);
      // Una consulta a cada central, ninguna más: nada que se cobre dos veces.
      expect(mockSolicitar).toHaveBeenCalledTimes(2);
    });

    it('si no se puede registrar el resultado, queda fallido (reintentable), nunca en en_proceso', async () => {
      dosCaidas();
      (supabase.rpc as unknown as Mock).mockResolvedValue({ error: { message: 'boom' } });

      await ejecutarEstudio('est-1', 'admin-1', undefined, 'administrador').catch(() => undefined);

      await vi.waitFor(() => expect(actualizaciones().some((u) => u.estado === 'fallido')).toBe(true));
    });
  });

  it('Q5c-5: la evaluación del co-arrendatario con el estudio rechazado se cancela y se le avisa (P3), no solo 409', async () => {
    enqueue(
      'estudios',
      estudio({ tipo: 'con_coarrendatario', estado: 'formulario_completado' }),
      { data: [{ id: 'est-1' }], error: null }, // cancelada
    );
    enqueue('expedientes', expediente('rechazado'), { data: { estado: 'rechazado' }, error: null });

    await expect(ejecutarEstudio('est-1', 'admin-1', undefined, 'administrador')).rejects.toMatchObject({
      errorCode: 'COARRENDATARIO_ESTUDIO_NO_VIGENTE',
    });
    expect(actualizaciones()[0]).toMatchObject({ estado: 'cancelado' });
    await vi.waitFor(() => expect(mockSinEfecto).toHaveBeenCalledWith('est-1'));
  });
});

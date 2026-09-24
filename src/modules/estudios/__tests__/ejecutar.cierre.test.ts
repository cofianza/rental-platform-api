import { describe, it, expect, vi, beforeEach } from 'vitest';

// P1/P3: el cierre del estudio y ejecutarEstudio se excluyen con la propia
// evaluación. Si el cierre llega entre el guard y el lock a 'en_proceso', se
// deshace el lock (nadie consultó el buró) y se revisa la devolución. Mismo
// mock de Supabase que estudios.enlace-cancelar.test.ts: colas por tabla + `ops`.

const { mockEnv, ops, queues, enqueue, mockFrom, mockDevolver } = vi.hoisted(() => {
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
  return {
    mockEnv: new Proxy({} as Record<string, unknown>, {
      get: (_t, k) => (typeof k === 'string' && (k.endsWith('_ENABLED') || k.startsWith('MOTOR_')) ? false : 'x'),
    }),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockFrom: vi.fn((table: string) => chainFor(table)),
    mockDevolver: vi.fn(async () => undefined),
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
vi.mock('../tope-canon.guard', () => ({
  assertCanonDentroDelTope: vi.fn(async () => ({ canonCop: 1_500_000 })),
  leerCanonDelInmueble: vi.fn(),
}));
vi.mock('../autorizacion.guard', () => ({
  assertAutorizacionVigente: vi.fn(async () => ({ autorizacionId: 'aut-1' })),
  AUTORIZACION_PREVIA_ERROR_CODE: 'AUTORIZACION_PREVIA_REQUERIDA',
}));
// Sin buró en la prueba: lo que corre en segundo plano tras el lock falla y se registra.
vi.mock('../providers/factory', () => ({
  getProvider: vi.fn(() => {
    throw new Error('sin buró en la prueba');
  }),
  getAllProviderIds: vi.fn(() => ['transunion', 'datacredito']),
}));
vi.mock('../pago.guard', () => ({
  leerSenalPagoEstudio: vi.fn(async () => 'pagado'),
  senalIndicaPagado: () => true,
  assertPagoEstudio: vi.fn(),
  estudioYaCobrado: vi.fn(async () => true),
  ESTADO_ESPERANDO_PAGO: 'pago_pendiente',
}));

import { ejecutarEstudio } from '../estudios.service';

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
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
});

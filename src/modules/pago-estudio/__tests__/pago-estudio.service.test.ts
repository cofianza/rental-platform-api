import { describe, it, expect, vi, beforeEach } from 'vitest';

// Opcion B (Adenda 2 §7): el gestor paga por la pasarela; no hay "a cuenta".
// Mismo mock de Supabase que autorizaciones.service.test.ts: builder
// encadenable + colas de resultados por tabla + registro de operaciones.

const { mockFrom, ops, queues, enqueue, mockGetUser, mockCreateLink, mockCancelLink, mockTransition } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'or', 'order', 'limit'];
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
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockGetUser: vi.fn(async () => ({ data: { user: { email: 'gestor@inmo.co' } } })),
    mockCreateLink: vi.fn(async () => ({ url: 'https://mp.test/checkout/1', externalId: 'pref-1' })),
    mockCancelLink: vi.fn(async () => undefined),
    mockTransition: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t), auth: { admin: { getUserById: (...a: unknown[]) => mockGetUser(...(a as [])) } } },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: { PAGO_CREATED: 'pago_created', PAGO_LINK_RESENT: 'pago_link_resent' },
  AUDIT_ENTITIES: { PAGO: 'pago' },
}));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/email', () => ({ sendPaymentLinkEmail: vi.fn(async () => undefined) }));
vi.mock('@/modules/pagos/gateway', () => ({
  getPaymentGateway: () => ({ provider: 'mercadopago', createPaymentLink: mockCreateLink, cancelPaymentLink: mockCancelLink }),
}));
vi.mock('@/modules/pagos/pago-state-machine', () => ({ transitionPagoState: (...a: unknown[]) => mockTransition(...(a as [])) }));
vi.mock('@/modules/pagos/pagos.service', () => ({ attachFacturas: vi.fn(async (p: unknown[]) => p) }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(async () => undefined),
  findPerfilIdByEmail: vi.fn(async () => null),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn(async () => undefined) }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(async () => undefined),
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
}));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn(async () => undefined) }));

import { pagarGestor } from '../pago-estudio.service';

const EXP = '11111111-1111-1111-1111-111111111111';

function datosComunes() {
  enqueue('perfiles', { data: { nombre: 'Ana', apellido: 'Gestora', razon_social: 'Inmo SAS' }, error: null });
}
function cobroNuevo() {
  enqueue('expedientes', { data: { id: EXP, numero: 'EXP-1', estado: 'en_revision', inmueble_id: null }, error: null });
  enqueue('configuracion_sistema', { data: { valor: '80000' }, error: null });
  enqueue('pagos', { data: null, error: null }); // insert pendiente
  enqueue('pagos', { data: { id: 'pago-nuevo', estado: 'pendiente', metodo: 'pasarela', payment_link_url: 'https://mp.test/checkout/1' }, error: null }); // CAS update
}

describe('pagarGestor (opcion B por pasarela)', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    vi.clearAllMocks();
  });

  it('sin pago previo: crea el cobro PENDIENTE en la pasarela a nombre del gestor (nada de "completado")', async () => {
    datosComunes();
    enqueue('pagos', { data: [], error: null }); // pagarGestor: no hay pago
    enqueue('pagos', { data: [], error: null }); // crearCobroPasarela: tampoco
    cobroNuevo();

    const pago = await pagarGestor(EXP, 'user-1', undefined, 'inmobiliaria');

    expect(pago.payment_link_url).toBe('https://mp.test/checkout/1');
    const insert = ops.find((o) => o.table === 'pagos' && o.method === 'insert');
    expect(insert?.args[0]).toMatchObject({ metodo: 'pasarela', estado: 'pendiente', email_pagador: 'gestor@inmo.co', nombre_pagador: 'Inmo SAS' });
    expect(mockCreateLink).toHaveBeenCalledOnce();
  });

  it('si ya tiene SU checkout abierto, devuelve el mismo sin crear otro', async () => {
    datosComunes();
    const suyo = { id: 'p1', estado: 'pendiente', metodo: 'pasarela', email_pagador: 'GESTOR@inmo.co', payment_link_url: 'https://mp.test/viejo' };
    enqueue('pagos', { data: [suyo], error: null });

    const pago = await pagarGestor(EXP, 'user-1', undefined, 'inmobiliaria');

    expect(pago).toEqual(suyo);
    expect(mockCreateLink).not.toHaveBeenCalled();
  });

  it('con un enlace vivo del prospecto: 409 sin la bandera; con la bandera lo cancela y cobra', async () => {
    const delProspecto = { id: 'p-pros', estado: 'pendiente', metodo: 'pasarela', email_pagador: 'prospecto@x.co', payment_link_url: 'https://mp.test/pros', external_id: 'pref-pros' };

    datosComunes();
    enqueue('pagos', { data: [delProspecto], error: null });
    await expect(pagarGestor(EXP, 'user-1', undefined, 'inmobiliaria')).rejects.toMatchObject({ errorCode: 'PAGO_ESTUDIO_PENDIENTE' });
    expect(mockTransition).not.toHaveBeenCalled();

    datosComunes();
    enqueue('pagos', { data: [delProspecto], error: null }); // pagarGestor lo ve
    enqueue('pagos', { data: [], error: null }); // crearCobroPasarela: ya no hay activo
    cobroNuevo();
    const pago = await pagarGestor(EXP, 'user-1', undefined, 'inmobiliaria', { reemplazarPendiente: true });

    expect(mockTransition).toHaveBeenCalledWith(expect.objectContaining({ pagoId: 'p-pros', targetEstado: 'cancelado' }));
    expect(mockCancelLink).toHaveBeenCalledWith('pref-pros');
    expect(pago.id).toBe('pago-nuevo');
  });
});

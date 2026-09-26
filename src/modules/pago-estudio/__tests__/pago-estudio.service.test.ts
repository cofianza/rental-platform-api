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
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'gt', 'or', 'order', 'limit'];
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
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
}));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn(async () => undefined) }));
vi.mock('@/modules/autorizaciones/autorizaciones.service', () => ({ enviarEnlaceAutorizacion: vi.fn(async () => undefined) }));

import { pagarGestor, cancelarYLiberarCredito, getEstadoPagoEstudio, reenviarLink, enviarLinkPago } from '../pago-estudio.service';
import { assertExpedienteAccess } from '@/lib/tenantScope';
import { findPerfilIdByEmail } from '@/modules/notificaciones/notificaciones.service';
import { enviarTemplate } from '@/modules/whatsapp';
import { sendPaymentLinkEmail } from '@/lib/email';

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
    // Gana la última decisión: si antes eligió «enviar link» (C), ya no le toca al prospecto.
    expect(ops.find((o) => o.table === 'estudios' && o.method === 'update')?.args[0]).toEqual({ pago_por: 'inmobiliaria' });
  });

  it('con un cobro anterior FALLIDO lo cancela y expira su link antes de abrir el nuevo', async () => {
    // 'fallido' no es terminal: la maquina permite fallido->completado porque MP
    // deja reintentar dentro del mismo checkout. O sea el link viejo sigue
    // siendo pagable. Si abrimos otro encima quedan dos cobros vivos: el
    // prospecto puede pagar los dos, y si paga el viejo el webhook choca con
    // uq_pagos_estudio_activo (ya ocupado por el nuevo 'pendiente'), reintenta
    // en bucle y la plata cobrada no se acredita nunca.
    const fallido = {
      id: 'p-fallido',
      estado: 'fallido',
      metodo: 'pasarela',
      email_pagador: 'prospecto@x.co',
      payment_link_url: 'https://mp.test/viejo',
      external_id: 'pref-vieja',
    };

    datosComunes();
    enqueue('pagos', { data: [fallido], error: null }); // pagarGestor
    enqueue('pagos', { data: [fallido], error: null }); // crearCobroPasarela
    cobroNuevo();

    const pago = await pagarGestor(EXP, 'user-1', undefined, 'inmobiliaria');

    expect(mockTransition).toHaveBeenCalledWith(
      expect.objectContaining({ pagoId: 'p-fallido', targetEstado: 'cancelado' }),
    );
    expect(mockCancelLink).toHaveBeenCalledWith('pref-vieja');
    expect(pago.payment_link_url).toBe('https://mp.test/checkout/1');
    expect(ops.filter((o) => o.table === 'pagos' && o.method === 'insert')).toHaveLength(1);
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

  it.each(['cerrado', 'rechazado'])('P1: con el estudio %s no abre el cobro (se tendría que devolver): 409', async (estado) => {
    datosComunes();
    enqueue('pagos', { data: [], error: null });
    enqueue('expedientes', { data: { id: EXP, numero: 'EXP-1', estado, inmueble_id: null }, error: null });

    await expect(pagarGestor(EXP, 'user-1', undefined, 'inmobiliaria')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'EXPEDIENTE_CERRADO',
    });
    expect(ops.some((o) => o.table === 'pagos' && o.method === 'insert')).toBe(false);
    expect(mockCreateLink).not.toHaveBeenCalled();
  });

  it("con el pago del prospecto 'procesando' (PSE/efectivo en curso) no lo cancela ni con la bandera: 409", async () => {
    // Expirar la preference no detiene un PSE o un recibo de efectivo ya
    // generado: si se aprueba despues cae sobre un pago cancelado y el estudio
    // se cobra dos veces.
    const enCurso = { id: 'p-pse', estado: 'procesando', metodo: 'pasarela', email_pagador: 'prospecto@x.co', payment_link_url: 'https://mp.test/pros', external_id: 'pref-pros' };

    datosComunes();
    enqueue('pagos', { data: [enCurso], error: null });
    await expect(
      pagarGestor(EXP, 'user-1', undefined, 'inmobiliaria', { reemplazarPendiente: true }),
    ).rejects.toMatchObject({ errorCode: 'PAGO_EN_PROCESO', statusCode: 409 });

    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockCancelLink).not.toHaveBeenCalled();
    expect(mockCreateLink).not.toHaveBeenCalled();
  });
});

describe('cancelarYLiberarCredito', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    vi.clearAllMocks();
  });

  it('P22: sin saldo efectivo (lo disponible no alcanza lo que está en contra) no cancela el enlace: 409', async () => {
    enqueue('pagos', { data: [{ id: 'p-pros', estado: 'pendiente', metodo: 'pasarela', external_id: 'pref-pros' }], error: null });
    enqueue('lotes_creditos_estudios', {
      data: [{ id: 'lote-1', cantidad_disponible: 2, cantidad_inicial: 10, vence_en: null, origen: 'compra', created_at: '2026-09-01' }],
      error: null,
    });
    enqueue('compras_creditos_estudios', { data: [{ creditos_en_contra: 2 }], error: null });

    await expect(cancelarYLiberarCredito(EXP, 'user-1', undefined, 'inmobiliaria')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'CREDITOS_EN_CONTRA',
    });
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockCancelLink).not.toHaveBeenCalled();
  });

  it("no cancela un pago 'procesando' para gastar un credito encima: 409", async () => {
    enqueue('pagos', { data: [{ id: 'p-pse', estado: 'procesando', metodo: 'pasarela', external_id: 'pref-pros' }], error: null });

    await expect(cancelarYLiberarCredito(EXP, 'user-1', undefined, 'inmobiliaria')).rejects.toMatchObject({
      errorCode: 'PAGO_EN_PROCESO',
      statusCode: 409,
    });
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockCancelLink).not.toHaveBeenCalled();
  });
});

describe('getEstadoPagoEstudio', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    vi.clearAllMocks();
  });

  it('lanza las lecturas sin esperar al guard (antes 5 idas en serie)', async () => {
    let soltarGuard!: () => void;
    vi.mocked(assertExpedienteAccess).mockReturnValueOnce(new Promise<void>((r) => (soltarGuard = r)));
    enqueue('configuracion_sistema', { data: { valor: '80000' }, error: null });
    enqueue('pagos', { data: [], error: null });
    enqueue('estudios', { data: { pago_por: 'arrendatario' }, error: null });

    const estado = getEstadoPagoEstudio(EXP, 'user-1', 'inmobiliaria');
    // Con el guard aun pendiente, las cuatro consultas ya salieron.
    const tablas = new Set(ops.map((o) => o.table));
    for (const t of ['configuracion_sistema', 'pagos', 'autorizaciones_habeas_data', 'estudios']) {
      expect(tablas.has(t)).toBe(true);
    }
    soltarGuard();

    await expect(estado).resolves.toMatchObject({ estado: 'esperando_autorizacion', autorizado: false, monto: 80000 });
  });

  it('si el guard da 404 no devuelve nada de lo leido', async () => {
    vi.mocked(assertExpedienteAccess).mockRejectedValueOnce(Object.assign(new Error('Estudio no encontrado'), { statusCode: 404 }));
    enqueue('pagos', { data: [{ id: 'p1', estado: 'completado', metodo: 'pasarela', monto: 80000, email_pagador: 'x@y.co' }], error: null });

    await expect(getEstadoPagoEstudio(EXP, 'intruso', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('reenviarLink', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    vi.clearAllMocks();
  });

  // Con «cada miembro ve solo lo suyo»: el estudio NO asignado de un compañero.
  // Antes bastaba ser de la organización (perfilEsDuenoDeInmueble en true).
  it('el asesor restringido no reenvía (ni desvía) el link de pago de un estudio de un compañero: 403', async () => {
    vi.mocked(assertExpedienteAccess).mockRejectedValueOnce(Object.assign(new Error('Estudio no encontrado'), { statusCode: 404, errorCode: 'EXPEDIENTE_NOT_FOUND' }));
    enqueue('expedientes', { data: { inmuebles: { propietario_id: 'companero', inmobiliaria_id: 'org-1' } }, error: null });
    enqueue('pagos', {
      data: [{ id: 'p1', estado: 'pendiente', metodo: 'pasarela', email_pagador: 'prospecto@x.co', payment_link_url: 'https://mp.test/1' }],
      error: null,
    });

    await expect(reenviarLink(EXP, 'asesor', undefined, { email: 'desvio@correo.co' } as never, 'inmobiliaria')).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'PAGO_ESTUDIO_FORBIDDEN',
    });
    expect(assertExpedienteAccess).toHaveBeenCalledWith(EXP, 'asesor', 'inmobiliaria');
    expect(ops.filter((o) => o.table === 'pagos')).toEqual([]);
  });
});

// A10: el checkout de la opcion B (lo paga la agencia) no es un cobro al
// arrendatario, lo mire quien lo mire.
describe('A10 — quien paga el cobro pendiente', () => {
  const pagoGestor = {
    id: 'p-b', estado: 'pendiente', metodo: 'pasarela', monto: 80000,
    email_pagador: 'titular@inmo.co', nombre_pagador: 'Inmo SAS', creado_por: 'titular',
    payment_link_url: 'https://mp.test/checkout/b',
  };
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    vi.clearAllMocks();
  });

  it('getEstadoPagoEstudio marca paga=gestor; al solicitante no le llega ni el enlace ni el correo', async () => {
    vi.mocked(findPerfilIdByEmail).mockResolvedValue('titular');
    enqueue('pagos', { data: [pagoGestor], error: null });
    const r = await getEstadoPagoEstudio(EXP, 'otro-miembro', 'inmobiliaria');
    expect(r).toMatchObject({ paga: 'gestor', pago: { payment_link_url: 'https://mp.test/checkout/b' } });

    enqueue('pagos', { data: [pagoGestor], error: null });
    const s = await getEstadoPagoEstudio(EXP, 'prospecto', 'solicitante');
    expect(s).toMatchObject({ paga: 'gestor', pago: { payment_link_url: null, email_pagador: null } });
  });

  it('el enlace del prospecto (opcion C) queda paga=arrendatario', async () => {
    vi.mocked(findPerfilIdByEmail).mockResolvedValue('prospecto');
    enqueue('pagos', { data: [{ ...pagoGestor, email_pagador: 'prospecto@x.co' }], error: null });
    const r = await getEstadoPagoEstudio(EXP, 'titular', 'inmobiliaria');
    expect(r).toMatchObject({ paga: 'arrendatario' });
  });

  it('reenviarLink no le manda al prospecto el checkout de la agencia (ni correo ni WhatsApp)', async () => {
    vi.mocked(findPerfilIdByEmail).mockResolvedValue('titular');
    enqueue('pagos', { data: [pagoGestor], error: null });
    await expect(reenviarLink(EXP, 'otro-miembro', undefined, undefined, 'inmobiliaria')).rejects.toMatchObject({
      errorCode: 'PAGO_ES_DEL_GESTOR',
    });
    expect(enviarTemplate).not.toHaveBeenCalled();
    expect(sendPaymentLinkEmail).not.toHaveBeenCalled();
  });
});

describe('B fallida → «Mejor que pague el arrendatario»', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    vi.clearAllMocks();
  });

  it('cierra el checkout fallido de la agencia y queda esperando la autorización del prospecto', async () => {
    vi.mocked(findPerfilIdByEmail).mockResolvedValue('titular');
    enqueue('pagos', {
      data: [{ id: 'p-b', estado: 'fallido', metodo: 'pasarela', email_pagador: 'titular@inmo.co', creado_por: 'titular', external_id: 'pref-b' }],
      error: null,
    });

    const r = await enviarLinkPago(EXP, { email_pagador: 'prospecto@x.co', nombre_pagador: 'Pedro' }, 'titular', undefined, 'inmobiliaria');

    expect(r).toMatchObject({ estado: 'esperando_autorizacion', pago: null });
    expect(mockTransition).toHaveBeenCalledWith(expect.objectContaining({ pagoId: 'p-b', targetEstado: 'cancelado' }));
    expect(mockCancelLink).toHaveBeenCalledWith('pref-b');
    expect(ops.find((o) => o.table === 'estudios' && o.method === 'update')?.args[0]).toEqual({ pago_por: 'arrendatario' });
    expect(mockCreateLink).not.toHaveBeenCalled();
  });
});

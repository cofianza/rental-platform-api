import { describe, it, expect, vi, beforeEach } from 'vitest';

// Aviso de pago confirmado: "recibimos tu pago" solo si pagó el solicitante.
// En la opción B paga el gestor con su propio correo. Mock de Supabase con
// colas por tabla, como mp-webhook-cancelled.

const { mockFrom, queues, enqueue, mockNotificar, mockResponsable } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'eq', 'neq', 'in', 'order', 'limit'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) chain[m] = () => chain;
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockNotificar: vi.fn(async () => undefined),
    mockResponsable: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn(async () => undefined) }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: mockNotificar,
  findPerfilIdByEmail: vi.fn(async () => 'sol-user'),
  notificarResponsableExpediente: mockResponsable,
}));

import { transitionPagoStateChecked } from '../pago-state-machine';

const EXP = 'exp-1';

function completarPagoDe(email_pagador: string, nombre_pagador: string) {
  enqueue(
    'pagos',
    { data: { id: 'pago-1', estado: 'pendiente', expediente_id: EXP, concepto: 'estudio' }, error: null },
    { data: { id: 'pago-1', estado: 'completado', expediente_id: EXP, concepto: 'estudio', email_pagador, nombre_pagador }, error: null },
  );
  enqueue('expedientes', {
    data: {
      numero: 'EXP-1',
      inmuebles: { direccion: 'Calle 1 # 2-3', propietario_id: 'inmo-owner' },
      solicitantes: { email: 'juan@correo.co', nombre: 'Juan', apellido: 'Pérez' },
    },
    error: null,
  });
  return transitionPagoStateChecked({ pagoId: 'pago-1', targetEstado: 'completado', origen: 'webhook' });
}

const mensajeA = (userId: string) =>
  (mockNotificar.mock.calls as unknown as Array<[{ userId: string; mensaje: string }]>).find(([n]) => n.userId === userId)?.[0]
    .mensaje;

describe('aviso de pago confirmado según quién pagó', () => {
  beforeEach(() => {
    queues.clear();
    vi.clearAllMocks();
  });

  it('opción B (pagó la inmobiliaria): al arrendatario no le dice "recibimos tu pago"', async () => {
    await completarPagoDe('gestor@inmo.co', 'Inmobiliaria Sol SAS');

    await vi.waitFor(() => expect(mockNotificar).toHaveBeenCalledTimes(2));
    expect(mensajeA('sol-user')).toBe('Se confirmó el pago de evaluación crediticia de tu estudio.');
    expect(mensajeA('inmo-owner')).toBe('Pago de evaluación crediticia de Calle 1 # 2-3 confirmado (pagó Inmobiliaria Sol SAS).');
  });

  it('opción C (pagó el arrendatario): "recibimos tu pago" y el dueño ve su nombre', async () => {
    await completarPagoDe('Juan@Correo.co', 'Juan Pérez');

    await vi.waitFor(() => expect(mockNotificar).toHaveBeenCalledTimes(2));
    expect(mensajeA('sol-user')).toBe('Recibimos tu pago de evaluación crediticia.');
    expect(mensajeA('inmo-owner')).toContain('(pagó Juan Pérez)');
  });
});

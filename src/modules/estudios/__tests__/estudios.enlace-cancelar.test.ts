import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// "Enviar enlace" y "Cancelar" del gestor contra la maquina de estados:
// en 'pago_pendiente' el estudio no puede salir de la espera (el pago ya no lo
// despertaria) y en 'en_proceso' la respuesta del buro tiene que poder
// registrarse. Mismo mock de Supabase del modulo: colas POR TABLA + `ops`.
// ============================================================

const { mockEnv, ops, queues, enqueue, mockFrom, mockRpc, mockCancelarPagos } = vi.hoisted(() => {
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
    mockRpc: vi.fn(async () => ({ error: null })),
    mockCancelarPagos: vi.fn(async () => undefined),
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: mockRpc, storage: { from: vi.fn() } } }));
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
vi.mock('@/modules/pagos/pagos.service', () => ({ cancelarPagosPendientesDeExpediente: mockCancelarPagos }));

import { sendSelfServiceLink, cancelEstudio, ejecutarEstudio } from '../estudios.service';
import { assertExpedienteAccess } from '@/lib/tenantScope';

const fila = (estado: string) => ({ id: 'est-1', expediente_id: 'exp-1', tipo: 'individual', estado, resultado: 'pendiente' });

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('enviar enlace del formulario', () => {
  it.each(['pago_pendiente', 'en_proceso'])('en %s responde 409 y no toca el estudio', async (estado) => {
    enqueue('estudios', { data: fila(estado), error: null });
    await expect(sendSelfServiceLink('est-1', 'u-1', undefined, undefined, 'administrador')).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(ops.some((o) => o.method === 'update')).toBe(false);
  });

  it('el UPDATE es CAS sobre el estado leido: si cambio entretanto, 409', async () => {
    enqueue('estudios', { data: fila('solicitado'), error: null }, { data: [], error: null });
    enqueue('expedientes', {
      data: { solicitante_id: 's-1', inmuebles: null, solicitantes: { nombre: 'A', apellido: 'B', email: 'a@b.co' } },
      error: null,
    });
    await expect(sendSelfServiceLink('est-1', 'u-1', undefined, undefined, 'administrador')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'ESTUDIO_ESTADO_CAMBIO',
    });
    expect(ops).toContainEqual({ table: 'estudios', method: 'eq', args: ['estado', 'solicitado'] });
  });
});

describe('cancelar la evaluacion', () => {
  it('en en_proceso responde 409 sin llamar a la RPC', async () => {
    enqueue('estudios', { data: fila('en_proceso'), error: null });
    await expect(cancelEstudio('est-1', 'u-1', undefined, 'administrador')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'ESTUDIO_EN_PROCESO',
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("en pago_pendiente con el pago del prospecto 'procesando' (PSE/efectivo) no cancela: 409", async () => {
    enqueue('estudios', { data: fila('pago_pendiente'), error: null });
    enqueue('pagos', { data: [{ id: 'p-1' }], error: null });
    await expect(cancelEstudio('est-1', 'u-1', undefined, 'administrador')).rejects.toMatchObject({
      errorCode: 'PAGO_EN_PROCESO',
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('en pago_pendiente cancela y deja sin efecto el enlace de pago si no queda otra evaluacion viva', async () => {
    enqueue('estudios', { data: fila('pago_pendiente'), error: null }, { data: [], error: null }, { data: fila('cancelado'), error: null });
    enqueue('pagos', { data: [], error: null });
    await cancelEstudio('est-1', 'u-1', undefined, 'administrador');
    expect(mockRpc).toHaveBeenCalledWith('fn_cancelar_estudio', { p_estudio_id: 'est-1' });
    expect(mockCancelarPagos).toHaveBeenCalledWith('exp-1', 'Evaluación cancelada', ['estudio']);
  });

  it('si el co-arrendatario sigue vivo en el expediente, el pago compartido no se toca', async () => {
    enqueue('estudios', { data: fila('pago_pendiente'), error: null }, { data: [{ id: 'est-coa' }], error: null }, { data: fila('cancelado'), error: null });
    enqueue('pagos', { data: [], error: null });
    await cancelEstudio('est-1', 'u-1', undefined, 'administrador');
    expect(mockCancelarPagos).not.toHaveBeenCalled();
  });
});

// Con «cada miembro ve solo lo suyo», el asesor restringido tiene el id del
// estudio NO asignado de un compañero: assertExpedienteAccess lo niega. Antes
// bastaba ser de la organización (perfilEsDuenoDeInmueble, aquí en true).
describe('estudio de un compañero, para el asesor restringido', () => {
  const fueraDeCartera = () => vi.mocked(assertExpedienteAccess).mockRejectedValueOnce(Object.assign(new Error('Estudio no encontrado'), { statusCode: 404, errorCode: 'EXPEDIENTE_NOT_FOUND' }));

  it('enviar el enlace del formulario: 403 sin reescribir el correo ni tocar el estudio', async () => {
    fueraDeCartera();
    enqueue('estudios', { data: fila('solicitado'), error: null });
    enqueue('expedientes', {
      data: { solicitante_id: 's-1', solicitantes: { nombre: 'A', apellido: 'B', email: 'a@b.co' } },
      error: null,
    });
    await expect(sendSelfServiceLink('est-1', 'asesor', undefined, 'desvio@correo.co', 'inmobiliaria')).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'ESTUDIO_FORBIDDEN',
    });
    expect(assertExpedienteAccess).toHaveBeenCalledWith('exp-1', 'asesor', 'inmobiliaria');
    expect(ops.some((o) => o.method === 'update')).toBe(false);
  });

  it('en su cartera sí pasa el guard (llega al CAS del estudio)', async () => {
    enqueue('estudios', { data: fila('solicitado'), error: null }, { data: [], error: null });
    enqueue('expedientes', {
      data: { solicitante_id: 's-1', solicitantes: { nombre: 'A', apellido: 'B', email: 'a@b.co' } },
      error: null,
    });
    await expect(sendSelfServiceLink('est-1', 'asesor', undefined, undefined, 'inmobiliaria')).rejects.toMatchObject({
      errorCode: 'ESTUDIO_ESTADO_CAMBIO',
    });
  });

  it('ejecutar la consulta al buró (facturable): 403 sin leer nada más', async () => {
    fueraDeCartera();
    enqueue('estudios', { data: fila('solicitado'), error: null });
    // Lo que leía la regla anterior para dejarlo pasar.
    enqueue('expedientes', { data: { inmueble_id: 'inm-1' }, error: null });
    enqueue('inmuebles', { data: { propietario_id: 'companero', inmobiliaria_id: 'org-1' }, error: null });
    await expect(ejecutarEstudio('est-1', 'asesor', undefined, 'inmobiliaria')).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'ESTUDIO_FORBIDDEN',
    });
    expect(assertExpedienteAccess).toHaveBeenCalledWith('exp-1', 'asesor', 'inmobiliaria');
    expect(ops.filter((o) => o.table !== 'estudios')).toEqual([]);
  });
});

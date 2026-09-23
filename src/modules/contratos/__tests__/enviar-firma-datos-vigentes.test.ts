import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Enviar a firma: el PDF tiene que llevar los datos de contacto y de pago
// vigentes (teléfono corregido en el modal, cuenta de recaudo cambiada después
// de generar el borrador). Mock de Supabase con colas POR TABLA, como
// contratos-v3-guards.test.
// ============================================================

const { mockEnv, mockFrom, ops, queues, enqueue } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'or', 'order', 'limit'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
      chain[m] = () => {
        ops.push({ table, method: m });
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
    mockEnv: { FIRMA_MULTIPARTE_ENABLED: false, CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 },
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => {
      queues.set(table, [...(queues.get(table) ?? []), ...items]);
    },
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t), rpc: vi.fn(), storage: { from: vi.fn() } },
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
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(async () => undefined),
  findPerfilIdByEmail: vi.fn(async () => null),
}));

import { enviarContratoAFirma, camposDesactualizadosParaFirma } from '../contratos.service';

const snapshot = {
  arrendatario: { celular: '3001112233', correo: 'juan@x.co' },
  inmobiliaria: { telefono: '3009998877', banco: 'Bancolombia', numero_cuenta: '123' },
};

describe('camposDesactualizadosParaFirma', () => {
  it('detecta el teléfono corregido después de generar el borrador', () => {
    const actual = {
      arrendatario: { celular: '3104445566', correo: 'juan@x.co' },
      inmobiliaria: { telefono: '3009998877', banco: 'Bancolombia', numero_cuenta: '123' },
    };
    expect(camposDesactualizadosParaFirma(snapshot, actual)).toEqual(['arrendatario.celular']);
  });

  it('sin cambios, o con un campo que el snapshot nunca tuvo, no pide regenerar', () => {
    const actual = { ...snapshot, arrendador: { cuenta_titular_nombre: 'Ana' } };
    expect(camposDesactualizadosParaFirma(snapshot, actual)).toEqual([]);
    expect(camposDesactualizadosParaFirma(null, actual)).toEqual([]);
  });
});

describe('enviarContratoAFirma con datos que cambiaron', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
  });

  it('pendiente_firma sin sobre activo: 409 y no se envía nada con el PDF viejo', async () => {
    enqueue('contratos', {
      data: {
        id: 'cto-1', estado: 'pendiente_firma', expediente_id: 'exp-1', storage_key: 'k.pdf',
        destinacion: null, datos_variables: snapshot,
      },
      error: null,
    });
    enqueue('solicitudes_firma', { data: null, error: null });
    enqueue('expedientes', {
      data: {
        id: 'exp-1', numero: 'EXP-1', estado: 'aprobado', inmueble_id: 'inm-1', solicitante_id: 'sol-1',
        inmuebles: {
          id: 'inm-1', direccion: 'Calle 1', ciudad: 'Manizales', valor_arriendo: 1_500_000,
          propietario_id: 'prop-1', inmobiliaria_id: null, uso: 'vivienda',
        },
        solicitantes: {
          id: 'sol-1', nombre: 'Juan', apellido: 'Pérez', tipo_documento: 'cc', numero_documento: '10',
          email: 'juan@x.co', telefono: '3104445566',
        },
      },
      error: null,
    });
    enqueue('perfiles', {
      data: {
        id: 'prop-1', nombre: 'Ana', apellido: 'Gómez', rol: 'propietario',
        whatsapp_recaudo: '3009998877', cuenta_recaudo_banco: 'Bancolombia', cuenta_recaudo_numero: '123',
      },
      error: null,
    });

    await expect(enviarContratoAFirma('cto-1', 'u1', 'propietario')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'CONTRATO_DATOS_DESACTUALIZADOS',
    });
    expect(ops.filter((o) => ['insert', 'update'].includes(o.method))).toEqual([]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// «Me interesa» sin cuenta (P9 + multitenant-seguridad-6): la confirmación al
// interesado no lleva la dirección, y el mismo correo o WhatsApp repetido en
// 24 h se guarda sin volver a disparar avisos. Mismo mock de Supabase con
// colas por tabla que moras.
// ============================================================

const { mockFrom, enqueue, resetQueues, mocks } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'eq', 'gte']) chain[m] = () => chain;
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    resetQueues: () => queues.clear(),
    mocks: {
      confirmacion: vi.fn(),
      avisoDueno: vi.fn(),
      whatsapp: vi.fn(),
      inApp: vi.fn(),
    },
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/email', () => ({
  sendInteresadoConfirmacionEmail: mocks.confirmacion,
  sendNuevoInteresadoEmail: mocks.avisoDueno,
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: mocks.whatsapp }));
vi.mock('../../notificaciones/notificaciones.service', () => ({ notificarUsuario: mocks.inApp }));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedInmuebleIds: vi.fn(),
  resolveOrgCanonicalPerfilId: async (id: string) => id,
  resolveNombreDueno: async () => 'Inmobiliaria Norte',
}));

import { registrarInteresPublico } from '../interesados.service';
import { registrarInteresSchema } from '../interesados.schema';

const INMUEBLE = {
  id: 'inm1', propietario_id: 'p1', inmobiliaria_id: 'org1', tipo: 'apartamento', ciudad: 'Bogotá',
  barrio: 'Chapinero', direccion: 'Calle 60 # 9-20 apto 301', codigo: 'A-17', visible_vitrina: true, estado: 'disponible',
};
const INPUT = { nombre: 'Ana Pérez', telefono: '3001112233', email: 'Ana@Correo.co', acepta: true as const };
const META = { ip: '1.2.3.4', userAgent: 'test' };

beforeEach(() => {
  resetQueues();
  Object.values(mocks).forEach((m) => m.mockClear());
  enqueue('inmuebles', { data: INMUEBLE, error: null });
  enqueue('perfiles', { data: { whatsapp_recaudo: '3015556677', telefono: null, email_recaudo: 'dueno@inmo.co' }, error: null });
});

describe('registrarInteresPublico', () => {
  it('la confirmación al interesado no lleva la dirección; el aviso al dueño sí', async () => {
    enqueue('inmueble_interesados', { count: 0 }, { count: 0 }, { error: null });

    await registrarInteresPublico('inm1', INPUT, META);

    const label = mocks.confirmacion.mock.calls[0][1].inmuebleLabel as string;
    expect(label).toBe('Apartamento en Chapinero, Bogotá (cód. A-17)');
    expect(label).not.toContain('Calle 60');
    expect(mocks.avisoDueno.mock.calls[0][1].inmuebleLabel).toContain('Calle 60 # 9-20');
  });

  it('el mismo correo o WhatsApp en 24 h se guarda, pero sin volver a avisar ni confirmar', async () => {
    enqueue('inmueble_interesados', { count: 0 }, { count: 1 }, { error: null });

    await registrarInteresPublico('inm1', INPUT, META);

    expect(mocks.inApp).not.toHaveBeenCalled();
    expect(mocks.whatsapp).not.toHaveBeenCalled();
    expect(mocks.avisoDueno).not.toHaveBeenCalled();
    expect(mocks.confirmacion).not.toHaveBeenCalled();
  });
});

describe('registrarInteresSchema', () => {
  it('rechaza etiquetas y enlaces en nombre y teléfono', () => {
    const ok = (nombre: string, telefono = '3001112233') =>
      registrarInteresSchema.safeParse({ ...INPUT, nombre, telefono }).success;
    expect(ok('<a href="https://falso.co">Paga aquí</a>')).toBe(false);
    expect(ok('Visita www.falso.co')).toBe(false);
    expect(ok('Ana', 'http://falso.co')).toBe(false);
    expect(ok('María José Pérez-Gómez')).toBe(true);
  });
});

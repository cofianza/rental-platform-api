import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// «Me interesa» sin cuenta (P9 + multitenant-seguridad-6): la confirmación al
// interesado no lleva la dirección, y el mismo correo o WhatsApp repetido en
// 24 h se guarda sin volver a disparar avisos. Mismo mock de Supabase con
// colas por tabla que moras.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues, mocks } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'eq', 'gte', 'order', 'limit']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
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
  ops.length = 0;
  Object.values(mocks).forEach((m) => m.mockClear());
  enqueue('inmuebles', { data: INMUEBLE, error: null });
  enqueue('perfiles', { data: { whatsapp_recaudo: '3015556677', telefono: null, email_recaudo: 'dueno@inmo.co' }, error: null });
});

describe('registrarInteresPublico', () => {
  it('la confirmación al interesado no lleva la dirección; el aviso al dueño sí', async () => {
    enqueue('inmueble_interesados', { data: [], error: null }, { error: null }); // sin leads en 24 h, insert

    await registrarInteresPublico('inm1', INPUT, META);

    const { inmuebleLabel: label, ...resto } = mocks.confirmacion.mock.calls[0][1] as { inmuebleLabel: string };
    expect(label).toBe('Apartamento en Chapinero, Bogotá (cód. A-17)');
    expect(label).not.toContain('Calle 60');
    expect(resto).toEqual({}); // ni el nombre que escribió: el correo no está verificado
    expect(mocks.avisoDueno.mock.calls[0][1].inmuebleLabel).toContain('Calle 60 # 9-20');
  });

  it('el mismo WhatsApp en 24 h (escrito distinto) se guarda, pero sin volver a avisar ni confirmar', async () => {
    // Mismo número por dígitos: «+57 300 111 2233» = «3001112233».
    enqueue('inmueble_interesados', { data: [{ email: 'otra@correo.co', telefono: '+57 300 111 2233' }], error: null }, { error: null });

    await registrarInteresPublico('inm1', INPUT, META);

    // El lead queda guardado igual.
    const insert = ops.find((o) => o.table === 'inmueble_interesados' && o.method === 'insert');
    expect(insert?.args[0]).toMatchObject({ inmueble_id: 'inm1', email: 'ana@correo.co', telefono: '3001112233' });
    expect(mocks.inApp).not.toHaveBeenCalled();
    expect(mocks.whatsapp).not.toHaveBeenCalled();
    expect(mocks.avisoDueno).not.toHaveBeenCalled();
    expect(mocks.confirmacion).not.toHaveBeenCalled();
  });
});

describe('aviso de interesado nuevo (P37)', () => {
  const conResponsable = (responsable: string | null) => {
    resetQueues();
    enqueue('inmuebles', { data: { ...INMUEBLE, miembro_responsable_id: responsable }, error: null });
    enqueue('perfiles', { data: { whatsapp_recaudo: '3015556677', telefono: null, email_recaudo: 'dueno@inmo.co' }, error: null });
    enqueue('inmueble_interesados', { data: [], error: null }, { error: null });
  };

  it('en la app, al titular y al responsable asignado; WhatsApp y correo solo a la organización', async () => {
    conResponsable('m1');
    await registrarInteresPublico('inm1', INPUT, META);
    expect(mocks.inApp.mock.calls.map((c) => (c[0] as { userId: string }).userId)).toEqual(['p1', 'm1']);
    expect(mocks.whatsapp.mock.calls.map((c) => (c[0] as { to: string }).to)).toEqual(['3015556677']);
    expect(mocks.avisoDueno.mock.calls.map((c) => c[0])).toEqual(['dueno@inmo.co']);
  });

  it('si el responsable es el titular, un solo aviso en la app', async () => {
    conResponsable('p1');
    await registrarInteresPublico('inm1', INPUT, META);
    expect(mocks.inApp).toHaveBeenCalledTimes(1);
  });
});

describe('registrarInteresSchema', () => {
  it('rechaza etiquetas, enlaces y dominios con cualquier terminación; el teléfono solo con dígitos', () => {
    const ok = (campos: Record<string, string>) => registrarInteresSchema.safeParse({ ...INPUT, ...campos }).success;
    // Se rechazan, en el nombre y en el mensaje.
    for (const falso of ['pago-seguro.info', 'FALSO．CO', 'is.gd/x', 'hxxps://falso.xyz', 'falso。app', 'reserva.click', '<b>Paga</b>']) {
      expect(ok({ nombre: `Ana ${falso}` }), `nombre: ${falso}`).toBe(false);
      expect(ok({ mensaje: `Paga en ${falso}` }), `mensaje: ${falso}`).toBe(false);
    }
    expect(ok({ telefono: 'http://falso.co' })).toBe(false);
    expect(ok({ telefono: '300 111 2233 falso.co' })).toBe(false);
    // El nombre solo con letras: sin números ni símbolos.
    expect(ok({ nombre: 'Ana 3001112233' })).toBe(false);
    expect(ok({ nombre: 'Ana @falso' })).toBe(false);
    // Pasan.
    for (const nombre of ['María José', "O'Neil", 'O’Neil', 'J.R.', 'Ana M. Pérez-Gómez']) {
      expect(ok({ nombre }), nombre).toBe(true);
    }
    for (const mensaje of ['8 a.m a 5 p.m', 'No.301 Torre 2', 'Hola. ¿Está disponible? Me interesa.', 'Canon de $1.500.000']) {
      expect(ok({ mensaje }), mensaje).toBe(true);
    }
    expect(ok({ telefono: '+57 300-111-2233' })).toBe(true);
  });
});

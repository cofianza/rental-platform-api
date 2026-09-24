/**
 * Vitrina y contrato tipo deciden con la cartera (assertInmuebleAccess), no con
 * la membresía de la organización: el miembro restringido no pausa, publica ni
 * toca el contrato tipo del inmueble de un compañero que su lista le oculta.
 * La regla misma se prueba en tenantScope.cartera.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAssertInmueble, ops } = vi.hoisted(() => ({
  mockAssertInmueble: vi.fn(),
  ops: [] as Array<{ tabla: string; op: string }>,
}));

vi.mock('@/lib/supabase', () => {
  const chainFor = (tabla: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'in']) chain[m] = () => chain;
    chain.update = () => {
      ops.push({ tabla, op: 'update' });
      return chain;
    };
    chain.single = async () => ({
      data: { id: 'inm-1', estado: 'disponible', propietario_id: 'companero', contrato_tipo_storage_key: 'k.pdf' },
      error: null,
    });
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
    return chain;
  };
  const bucket = () => {
    ops.push({ tabla: 'storage', op: 'uso' });
    return {
      createSignedUrl: async () => ({ data: { signedUrl: 'https://x' }, error: null }),
      remove: async () => ({ error: null }),
      upload: async () => ({ error: null }),
    };
  };
  return {
    supabase: { from: (t: string) => chainFor(t), rpc: async () => ({ data: [], error: null }), storage: { from: bucket } },
  };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/tenantScope', () => ({
  assertInmuebleAccess: (...a: unknown[]) => mockAssertInmueble(...a),
  // La regla anterior: ser de la organización bastaba.
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
  resolveInmobiliariaIdForPerfil: vi.fn(async () => null),
  esOwnerDeOrg: vi.fn(),
  esMiembroSoloLectura: vi.fn(),
  resolveOrgMemberPerfilIds: vi.fn(),
}));
vi.mock('../../notificaciones/notificaciones.service', () => ({ notificarYCorreo: vi.fn() }));
vi.mock('../../estudios/estudios-simultaneos.guard', () => ({ errorReservaPerdida: vi.fn() }));

import { toggleVisibility } from '../inmuebles.service';
import { eliminarContratoTipo, obtenerUrlContratoTipo, subirContratoTipo } from '../inmueble-contrato-tipo.service';

const fueraDeCartera = Object.assign(new Error('Inmueble no encontrado'), { statusCode: 404, errorCode: 'INMUEBLE_NOT_FOUND' });
const pdf = { buffer: Buffer.from('%PDF'), originalname: 'c.pdf', size: 4, mimetype: 'application/pdf' };

beforeEach(() => {
  ops.length = 0;
  mockAssertInmueble.mockReset();
  mockAssertInmueble.mockRejectedValue(fueraDeCartera);
});

describe('inmueble de un compañero, para el miembro restringido', () => {
  it('vitrina: 404 y no la cambia', async () => {
    await expect(toggleVisibility('inm-1', false, 'asesor', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockAssertInmueble).toHaveBeenCalledWith('inm-1', 'asesor', 'inmobiliaria');
    expect(ops).toEqual([]);
  });

  it('contrato tipo (ver, subir, eliminar): 404 sin tocar el archivo ni la fila', async () => {
    await expect(obtenerUrlContratoTipo('inm-1', 'asesor', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    await expect(subirContratoTipo('inm-1', pdf, 'asesor', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    await expect(eliminarContratoTipo('inm-1', 'asesor', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockAssertInmueble).toHaveBeenCalledTimes(3);
    expect(ops).toEqual([]);
  });

  it('en su cartera sí cambia la vitrina', async () => {
    mockAssertInmueble.mockResolvedValue(undefined);
    await toggleVisibility('inm-1', false, 'asesor', 'inmobiliaria');
    expect(ops).toContainEqual({ tabla: 'inmuebles', op: 'update' });
  });
});

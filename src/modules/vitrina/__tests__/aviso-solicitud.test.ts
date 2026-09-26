/**
 * P37: el estudio nuevo que entra por la vitrina se avisa por WhatsApp y
 * correo a la organización (su titular, no quien registró el inmueble) y en la
 * app al titular y al responsable asignado del inmueble.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks, filas } = vi.hoisted(() => ({
  mocks: { inApp: vi.fn(), whatsapp: vi.fn(), correo: vi.fn() },
  filas: {
    inmuebles: { propietario_id: 'asesor', inmobiliaria_id: 'org1', miembro_responsable_id: 'resp', direccion: 'Calle 1 # 2-3' } as Record<string, unknown>,
    solicitantes: { nombre: 'Ana', apellido: 'Pérez', email: 'ana@correo.co', telefono: '3001112233' },
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: 'inmuebles' | 'solicitantes') => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: filas[t], error: null });
      return chain;
    },
  },
  supabaseAuth: {},
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../registration/registration.service', () => ({ recordTermsAcceptance: vi.fn() }));
vi.mock('../../notificaciones/notificaciones.service', () => ({ notificarUsuario: mocks.inApp }));
vi.mock('../../whatsapp', () => ({ enviarTemplate: mocks.whatsapp }));
vi.mock('@/lib/tenantScope', () => ({
  resolvePerfilCanonicoDeInmueble: async () => 'titular',
  resolveContactoDueno: async () => ({ nombre: 'Inmobiliaria Norte', whatsapp: '3015556677' }),
}));
vi.mock('../../interesados/interesados.service', () => ({
  correoDelDueno: async () => 'dueno@inmo.co',
  destinatariosInApp: (a: string, b: string | null) => [...new Set([a, b].filter(Boolean))],
}));
vi.mock('@/lib/email', () => ({ sendNuevoInteresadoEmail: mocks.correo }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'https://app' } }));

import { notificarPropietarioNuevaSolicitud } from '../vitrina.service';

beforeEach(() => Object.values(mocks).forEach((m) => m.mockClear()));

describe('aviso de estudio nuevo desde la vitrina', () => {
  it('WhatsApp y correo al titular; en la app, al titular y al responsable', async () => {
    await notificarPropietarioNuevaSolicitud('exp1', 'inm1', 'sol1');
    expect(mocks.inApp.mock.calls.map((c) => (c[0] as { userId: string }).userId)).toEqual(['titular', 'resp']);
    expect(mocks.whatsapp).toHaveBeenCalledWith(expect.objectContaining({ to: '3015556677', variables: ['Ana Pérez', 'Calle 1 # 2-3'] }));
    expect(mocks.correo).toHaveBeenCalledWith(
      'dueno@inmo.co',
      expect.objectContaining({ duenoNombre: 'Inmobiliaria Norte', interesadoNombre: 'Ana Pérez', panelUrl: 'https://app/expedientes/exp1' }),
    );
  });
});

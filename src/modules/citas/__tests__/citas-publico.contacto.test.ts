import { describe, it, expect, vi, beforeEach } from 'vitest';

// P17: la página pública de la visita le dice al arrendatario a quién
// escribirle (la inmobiliaria o el propietario); el soporte de Cofianza solo
// si el dueño no tiene número.

const { mockCita, mockContacto } = vi.hoisted(() => ({
  mockCita: vi.fn(),
  mockContacto: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) c[m] = () => c;
  c.maybeSingle = async () => ({ data: mockCita(), error: null });
  return { supabase: { from: () => c } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/companyConfig', () => ({ getCompany: async () => ({ email: 'hola@cofianza.co' }) }));
vi.mock('@/lib/tenantScope', () => ({
  resolvePerfilCanonicoDeInmueble: async () => 'titular1',
  resolveContactoDueno: (...a: unknown[]) => mockContacto(...a),
}));
vi.mock('../../disponibilidad/disponibilidad.service', () => ({ slotEstaDisponible: vi.fn(), getSlotsPorInmueble: vi.fn() }));
vi.mock('../citas.service', () => ({
  notificarCitaCreada: vi.fn(),
  notificarCitaCancelada: vi.fn(),
  notificarPropietarioConfirmacionAsistencia: vi.fn(),
}));
vi.mock('../citas.permissions', () => ({ assertInmuebleAdmiteVisitas: vi.fn() }));

import { getCitaPublica } from '../citas-publico.service';

beforeEach(() => {
  mockCita.mockReturnValue({
    id: 'c1', estado: 'cancelada', fecha_propuesta: null, fecha_confirmada: null, acuse_solicitante_at: null, expediente_id: 'exp1',
    expediente: {
      inmueble: { id: 'i1', direccion: 'Cra 7', ciudad: 'Bogotá', propietario_id: 'asesor1', inmobiliaria_id: 'org1', estado: 'disponible', reservado_por_expediente_id: null },
      solicitante: { nombre: 'Ana', apellido: 'Pérez' },
    },
  });
});

describe('getCitaPublica — contacto (P17)', () => {
  it('trae el WhatsApp de la inmobiliaria', async () => {
    mockContacto.mockResolvedValue({ nombre: 'Inmobiliaria Norte', whatsapp: '+573015556677' });
    const v = await getCitaPublica('tok');
    expect(v.contacto).toEqual({ nombre: 'Inmobiliaria Norte', whatsapp: '+573015556677', email: null });
  });

  it('sin número del dueño, el correo de soporte de Cofianza', async () => {
    mockContacto.mockResolvedValue({ nombre: 'Juan Pérez', whatsapp: null });
    const v = await getCitaPublica('tok');
    expect(v.contacto).toEqual({ nombre: 'Cofianza', whatsapp: null, email: 'hola@cofianza.co' });
  });
});

describe('getCitaPublica — dirección (P9)', () => {
  const conEstado = (estado: string) =>
    mockCita.mockReturnValue({
      id: 'c1', estado, fecha_propuesta: null, fecha_confirmada: null, acuse_solicitante_at: null, expediente_id: 'exp1',
      expediente: {
        inmueble: {
          id: 'i1', direccion: 'Cra 7 # 45-10 apto 301', ciudad: 'Bogotá', tipo: 'apartamento', barrio: 'Chapinero',
          propietario_id: 'asesor1', inmobiliaria_id: 'org1', estado: 'disponible', reservado_por_expediente_id: null,
        },
        solicitante: { nombre: 'Ana', apellido: 'Pérez' },
      },
    });

  beforeEach(() => mockContacto.mockResolvedValue({ nombre: 'Inmobiliaria Norte', whatsapp: '+573015556677' }));

  it('confirmada: la dirección exacta', async () => {
    conEstado('confirmada');
    expect((await getCitaPublica('tok')).inmueble).toEqual({
      direccion: 'Cra 7 # 45-10 apto 301', tipo: 'apartamento', barrio: 'Chapinero', ciudad: 'Bogotá',
    });
  });

  it('sin confirmar: tipo, barrio y ciudad, sin la dirección', async () => {
    conEstado('solicitada');
    expect((await getCitaPublica('tok')).inmueble).toEqual({ direccion: null, tipo: 'apartamento', barrio: 'Chapinero', ciudad: 'Bogotá' });
  });

  it('cancelada: nada del inmueble', async () => {
    conEstado('cancelada');
    expect((await getCitaPublica('tok')).inmueble).toBeNull();
  });
});

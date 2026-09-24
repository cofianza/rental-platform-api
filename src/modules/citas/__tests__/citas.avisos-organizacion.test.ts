import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// P37: la solicitud de visita avisa al WhatsApp de la organización (no al del
// asesor que registró el inmueble) y al responsable asignado: el del estudio
// o, si el estudio no tiene, el del inmueble.
// ============================================================

const { mockFrom, enqueue, resetQueues, mocks } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) chain[m] = () => chain;
    chain.single = async () => next(table);
    chain.maybeSingle = async () => next(table);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    resetQueues: () => queues.clear(),
    mocks: { whatsapp: vi.fn(), inApp: vi.fn(), responsable: vi.fn(), correo: vi.fn() },
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: string) => mockFrom(t),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'titular@norte.co' } } }) } },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'https://www.cofianza.co' } }));
vi.mock('../../orchestrator/orchestrator.emails', () => ({
  sendCitaSolicitadaPropietarioEmail: mocks.correo,
  sendCitaConfirmadaSolicitanteEmail: vi.fn(),
  sendCitaReprogramadaSolicitanteEmail: vi.fn(),
  sendCitaCanceladaEmail: vi.fn(),
}));
vi.mock('../../notificaciones/notificaciones.service', () => ({
  notificarUsuario: mocks.inApp,
  findPerfilIdByEmail: async () => null,
  notificarResponsableExpediente: mocks.responsable,
}));
vi.mock('../../whatsapp', () => ({ enviarTemplate: mocks.whatsapp }));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: vi.fn(),
  resolveMembershipInmobiliariaIds: vi.fn(),
  getActiveMembership: vi.fn(),
  resolveOrgCanonicalPerfilId: vi.fn(),
  resolvePerfilCanonicoDeInmueble: async () => 'titular1',
  resolveContactoDueno: async () => ({ nombre: 'Inmobiliaria Norte', whatsapp: '+573015556677' }),
}));

import { notificarCitaCreada } from '../citas.service';

function prepararEstudio(responsableEstudio: string | null) {
  enqueue('expedientes', { data: { id: 'exp1', solicitante_id: 's1', inmueble_id: 'i1', miembro_responsable_id: responsableEstudio } });
  enqueue('solicitantes', { data: { nombre: 'Ana', apellido: 'Pérez', email: 'ana@correo.co', telefono: '3001112233' } });
  // Lo registró asesor1 (sin teléfono en su perfil); el responsable del inmueble es asesor2.
  enqueue('inmuebles', {
    data: { direccion: 'Cra 7 # 45-10', ciudad: 'Bogotá', propietario_id: 'asesor1', inmobiliaria_id: 'org1', miembro_responsable_id: 'asesor2' },
  });
}

beforeEach(() => {
  resetQueues();
  Object.values(mocks).forEach((m) => m.mockClear());
});

describe('solicitud de visita (P37)', () => {
  it('avisa al WhatsApp de la organización, al titular y al responsable del inmueble', async () => {
    prepararEstudio(null);
    await notificarCitaCreada('c1', 'exp1', '2026-10-02T15:00:00.000Z', false);

    expect(mocks.whatsapp).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+573015556677', template: 'CITA_SOLICITADA_DUENO' }),
    );
    expect(mocks.whatsapp.mock.calls[0][0].variables[0]).toBe('Inmobiliaria Norte');
    expect(mocks.inApp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'titular1', tipo: 'cita.solicitada' }));
    expect(mocks.correo).toHaveBeenCalledWith(expect.objectContaining({ email: 'titular@norte.co' }));
    expect(mocks.responsable).toHaveBeenCalledWith(
      expect.objectContaining({ miembroId: 'asesor2', excluirPerfilId: 'titular1' }),
    );
  });

  it('si el estudio tiene su propio responsable, la copia va a ese', async () => {
    prepararEstudio('asesor3');
    await notificarCitaCreada('c1', 'exp1', '2026-10-02T15:00:00.000Z', false);
    expect(mocks.responsable).toHaveBeenCalledWith(expect.objectContaining({ miembroId: 'asesor3' }));
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Aviso de reserva (Flujo §4.2): no se le dice "tu estudio sigue vigente" a
// quien ya tuvo contrato sobre ese estudio (revisión V3, 2026-09-22).
// ============================================================

const { queues, inserts, mockNotificar } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  return { queues, inserts, mockNotificar: vi.fn(async () => undefined) };
});

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'neq', 'eq']) chain[m] = () => chain;
    chain.insert = (row: Record<string, unknown>) => {
      inserts.push({ table, row });
      return chain;
    };
    chain.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve(queues.get(table)?.shift() ?? { data: null, error: null }).then(ok, ko);
    return chain;
  };
  return { supabase: { from: (t: string) => chainFor(t) } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../notificaciones/notificaciones.service', () => ({
  notificarYCorreo: mockNotificar,
  findPerfilIdByEmail: async (email: string | null) => (email ? `perfil-${email}` : null),
}));

import { avisarCandidatosDeReserva, type CandidatoAfectado } from '../reserva-inmueble.notificaciones';

const cand = (expediente_id: string): CandidatoAfectado => ({
  expediente_id,
  expediente_numero: null,
  solicitante_id: null,
  solicitante_nombre: null,
  solicitante_apellido: null,
  solicitante_email: `${expediente_id}@correo.co`,
});
const aviso = (...ids: string[]) =>
  avisarCandidatosDeReserva({ afectados: ids.map(cand), inmuebleCodigo: 'INM-1', expedienteGanadorId: 'ganador' });

beforeEach(() => {
  queues.clear();
  inserts.length = 0;
  vi.clearAllMocks();
});

describe('avisarCandidatosDeReserva', () => {
  it('no avisa al estudio que ya tuvo contrato; sí a los demás', async () => {
    queues.set('contratos', [{ data: [{ expediente_id: 'ex-arrendatario' }], error: null }]);
    await aviso('ex-arrendatario', 'candidato');
    expect(inserts.map((i) => i.row.expediente_id)).toEqual(['candidato']);
    expect(mockNotificar).toHaveBeenCalledTimes(1);
    expect(mockNotificar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'perfil-candidato@correo.co' }));
  });

  it('si no se pueden leer los contratos, no avisa a nadie', async () => {
    queues.set('contratos', [{ data: null, error: { message: 'caída' } }]);
    await aviso('candidato');
    expect(inserts).toHaveLength(0);
    expect(mockNotificar).not.toHaveBeenCalled();
  });
});

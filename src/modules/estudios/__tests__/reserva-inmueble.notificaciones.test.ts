import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Aviso de reserva (Flujo §4.2): no se le dice "tu estudio sigue vigente" a
// quien ya tuvo contrato sobre ese estudio (revisión V3, 2026-09-22).
// ============================================================

const { queues, inserts, updates, filtros, mockNotificar, mockCitaCancelada, mockInApp, mockResponsable, mockCorreo } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; row: Record<string, unknown> }> = [];
  const filtros: Array<{ table: string; m: string; args: unknown[] }> = [];
  return {
    queues, inserts, updates, filtros,
    mockNotificar: vi.fn(async () => undefined),
    mockCitaCancelada: vi.fn(async () => undefined),
    mockInApp: vi.fn(async () => undefined),
    mockResponsable: vi.fn(async () => undefined),
    mockCorreo: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'neq', 'eq'])
      chain[m] = (...args: unknown[]) => {
        filtros.push({ table, m, args });
        return chain;
      };
    chain.insert = (row: Record<string, unknown>) => {
      inserts.push({ table, row });
      return chain;
    };
    chain.update = (row: Record<string, unknown>) => {
      updates.push({ table, row });
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
  notificarUsuario: mockInApp,
  notificarResponsableExpediente: mockResponsable,
  // Sin cuenta: los correos que empiezan por "sin-cuenta".
  findPerfilIdByEmail: async (email: string | null) => (email && !email.startsWith('sin-cuenta') ? `perfil-${email}` : null),
}));
vi.mock('../../orchestrator/orchestrator.emails', () => ({ sendResponsableAsignadoEmail: mockCorreo }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'https://app.test' } }));

vi.mock('../../citas/citas.service', () => ({ notificarCitaCancelada: mockCitaCancelada }));

import {
  avisarCandidatosDeReserva,
  cancelarVisitasDeOtros,
  MOTIVO_VISITA_INMUEBLE_RESERVADO,
  type CandidatoAfectado,
} from '../reserva-inmueble.notificaciones';

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
  updates.length = 0;
  filtros.length = 0;
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

  it('avisa al dueño del inmueble y al responsable de cada estudio afectado', async () => {
    queues.set('contratos', [{ data: [], error: null }]);
    queues.set('expedientes', [{
      data: [{ id: 'candidato', miembro_responsable_id: 'miembro-1', inmuebles: { propietario_id: 'dueno-1' } }],
      error: null,
    }]);
    await aviso('candidato');
    expect(mockInApp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'dueno-1', tipo: 'inmueble.reservado_por_otro' }));
    expect(mockResponsable).toHaveBeenCalledWith(
      expect.objectContaining({ expedienteId: 'candidato', miembroId: 'miembro-1', excluirPerfilId: 'dueno-1' }),
    );
  });

  it('al prospecto sin cuenta le llega el correo igual', async () => {
    queues.set('contratos', [{ data: [], error: null }]);
    await avisarCandidatosDeReserva({
      afectados: [{ ...cand('x'), solicitante_email: 'sin-cuenta@correo.co' }],
      inmuebleCodigo: 'INM-1',
      expedienteGanadorId: 'ganador',
    });
    expect(mockNotificar).not.toHaveBeenCalled();
    expect(mockCorreo).toHaveBeenCalledWith(expect.objectContaining({ email: 'sin-cuenta@correo.co', link: '/vitrina' }));
  });

  it('solo al estudio con la evaluación completada le promete reasignarlo', async () => {
    queues.set('contratos', [{ data: [], error: null }]);
    queues.set('estudios', [{ data: [{ expediente_id: 'completo' }], error: null }]);
    await aviso('completo', 'en-curso');
    const mensaje = (id: string) =>
      (mockNotificar.mock.calls as unknown as Array<[{ userId: string; mensaje: string }]>)
        .find(([a]) => a.userId === `perfil-${id}@correo.co`)?.[0].mensaje;
    expect(mensaje('completo')).toMatch(/puede usarse para otra propiedad/);
    expect(mensaje('en-curso')).not.toMatch(/puede usarse|reasignarse/);
    const timeline = (id: string) => inserts.find((i) => i.row.expediente_id === id)?.row.descripcion as string;
    expect(timeline('completo')).toMatch(/puede reasignarse/);
    expect(timeline('en-curso')).toMatch(/cuando su evaluación se complete/);
  });

  it('si no se pueden leer los contratos, no avisa a nadie', async () => {
    queues.set('contratos', [{ data: null, error: { message: 'caída' } }]);
    await aviso('candidato');
    expect(inserts).toHaveLength(0);
    expect(mockNotificar).not.toHaveBeenCalled();
  });
});

describe('cancelarVisitasDeOtros', () => {
  it('cancela las visitas vivas de los demás estudios del inmueble y avisa a cada solicitante', async () => {
    queues.set('expedientes', [{ data: [{ id: 'solo-visita' }], error: null }]);
    queues.set('citas', [{
      data: [{ id: 'c1', expediente_id: 'solo-visita', fecha_propuesta: '2026-10-01T15:00:00Z', fecha_confirmada: null }],
      error: null,
    }]);
    await cancelarVisitasDeOtros('inm-1', 'ganador');

    const exp = filtros.filter((f) => f.table === 'expedientes');
    expect(exp).toContainEqual({ table: 'expedientes', m: 'eq', args: ['inmueble_id', 'inm-1'] });
    expect(exp).toContainEqual({ table: 'expedientes', m: 'neq', args: ['id', 'ganador'] });
    expect(updates).toEqual([
      { table: 'citas', row: expect.objectContaining({ estado: 'cancelada', motivo_cancelacion: MOTIVO_VISITA_INMUEBLE_RESERVADO }) },
    ]);
    const citas = filtros.filter((f) => f.table === 'citas');
    expect(citas).toContainEqual({ table: 'citas', m: 'in', args: ['expediente_id', ['solo-visita']] });
    expect(citas).toContainEqual({ table: 'citas', m: 'in', args: ['estado', ['solicitada', 'confirmada']] });
    expect(mockCitaCancelada).toHaveBeenCalledWith(
      'solo-visita', '2026-10-01T15:00:00Z', MOTIVO_VISITA_INMUEBLE_RESERVADO, 'administrador',
    );
  });

  it('sin otros estudios sobre el inmueble no toca las citas', async () => {
    queues.set('expedientes', [{ data: [], error: null }]);
    await cancelarVisitasDeOtros('inm-1', 'ganador');
    expect(updates).toEqual([]);
    expect(mockCitaCancelada).not.toHaveBeenCalled();
  });
});

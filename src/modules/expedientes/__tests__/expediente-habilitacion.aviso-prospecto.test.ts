/**
 * Política §11: cuando un estudio condicionado se cierra por "Cambiar estado" o
 * por la ponderación, el prospecto recibe el correo (con el derecho de
 * apelación si no se aprobó) en su propio correo, no el gestor que creó la ficha.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAprobado, mockRechazado, mockNotificar, mockFindPerfil } = vi.hoisted(() => ({
  mockAprobado: vi.fn(async (..._a: unknown[]) => undefined),
  mockRechazado: vi.fn(async (..._a: unknown[]) => undefined),
  mockNotificar: vi.fn(async (..._a: unknown[]) => undefined),
  mockFindPerfil: vi.fn(async (..._a: unknown[]): Promise<string | null> => 'perfil-prospecto'),
}));

const fila = {
  solicitantes: { email: 'ana@correo.co', nombre: 'Ana', apellido: 'Pérez' },
  inmuebles: { direccion: 'Calle 1 # 2-3', ciudad: 'Medellín' },
};
vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: fila, error: null }) }) }) }) },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config/env', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('../expediente-habilitacion.permissions', () => ({ assertHabilitacionPermission: vi.fn() }));
vi.mock('../../orchestrator/orchestrator.emails', () => ({
  sendEstudioHabilitadoEmail: vi.fn(),
  sendEstudioNoHabilitadoEmail: vi.fn(),
  sendEstudioAprobadoEmail: (...a: unknown[]) => mockAprobado(...a),
  sendEstudioRechazadoEmail: (...a: unknown[]) => mockRechazado(...a),
}));
vi.mock('../../estudios/estudios-simultaneos.guard', () => ({ errorNoAdmision: vi.fn() }));
vi.mock('../../estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn() }));
vi.mock('../../pago-estudio/pago-estudio.service', () => ({ enviarLinkPago: vi.fn() }));
vi.mock('../../notificaciones/notificaciones.service', () => ({
  notificarUsuario: (...a: unknown[]) => mockNotificar(...a),
  notificarYCorreo: vi.fn(),
  notificarResponsableExpediente: vi.fn(),
  findPerfilIdByEmail: (...a: unknown[]) => mockFindPerfil(...a),
}));

import { avisarSolicitanteDecision } from '../expediente-habilitacion.service';
import { MOTIVO_PROSPECTO_DECISION_COFIANZA } from '../../estudios/rutas-resultado';

beforeEach(() => vi.clearAllMocks());

describe('avisarSolicitanteDecision', () => {
  it('rechazo: correo con apelación al correo del prospecto y aviso a su perfil', async () => {
    await avisarSolicitanteDecision('exp-1', 'rechazado', 'Motivo del conjunto');

    expect(mockRechazado).toHaveBeenCalledWith({ email: 'ana@correo.co', nombre: 'Ana Pérez', motivoGeneral: 'Motivo del conjunto' });
    expect(mockAprobado).not.toHaveBeenCalled();
    expect(mockFindPerfil).toHaveBeenCalledWith('ana@correo.co');
    expect(mockNotificar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'perfil-prospecto', tipo: 'estudio.rechazado' }));
  });

  it('rechazo de un analista (sin motivo): el texto neutro, no «tu evaluación crediticia no cumplió»', async () => {
    await avisarSolicitanteDecision('exp-1', 'rechazado');

    expect(mockRechazado).toHaveBeenCalledWith({
      email: 'ana@correo.co',
      nombre: 'Ana Pérez',
      motivoGeneral: MOTIVO_PROSPECTO_DECISION_COFIANZA,
    });
  });

  it('aprobado: correo de aprobado sin score', async () => {
    mockFindPerfil.mockResolvedValueOnce(null);
    await avisarSolicitanteDecision('exp-1', 'aprobado');

    expect(mockAprobado).toHaveBeenCalledWith(expect.objectContaining({ email: 'ana@correo.co', score: null }));
    expect(mockNotificar).not.toHaveBeenCalled();
  });
});

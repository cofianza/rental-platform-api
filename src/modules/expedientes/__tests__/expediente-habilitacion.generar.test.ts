/**
 * generarContratoExpediente se traga los errores de generarContrato (el
 * expediente queda aprobado y se reintenta desde la pestaña Contratos), salvo
 * los que el gestor tiene que leer. DESTINACION_NO_HABILITADA (Contratos V3)
 * es uno de ellos: tragarlo dejaría un "aprobado" mudo sobre un inmueble que
 * nunca va a poder contratar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@/lib/errors';

const { mockGenerarContrato } = vi.hoisted(() => ({ mockGenerarContrato: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config/env', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('../expediente-habilitacion.permissions', () => ({
  assertHabilitacionPermission: vi.fn(async () => ({ estado: 'aprobado', expedienteId: 'exp-1', numero: 'EXP-1' })),
}));
vi.mock('../../orchestrator/orchestrator.emails', () => ({
  sendEstudioHabilitadoEmail: vi.fn(),
  sendEstudioNoHabilitadoEmail: vi.fn(),
  sendEstudioAprobadoEmail: vi.fn(),
}));
vi.mock('../../estudios/estudios-simultaneos.guard', () => ({ errorNoAdmision: vi.fn() }));
vi.mock('../../estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn() }));
vi.mock('../../pago-estudio/pago-estudio.service', () => ({ enviarLinkPago: vi.fn() }));
vi.mock('../../notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(),
  findPerfilIdByEmail: vi.fn(),
}));
vi.mock('@/modules/contratos/contratos.service', () => ({ generarContrato: mockGenerarContrato }));

import { generarContratoExpediente } from '../expediente-habilitacion.service';

const DATOS = { duracion_contrato_meses: 12, fecha_inicio_contrato: '2026-10-01' };

describe('generarContratoExpediente — errores que suben al gestor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('DESTINACION_NO_HABILITADA sube', async () => {
    mockGenerarContrato.mockRejectedValueOnce(AppError.badRequest('x', 'DESTINACION_NO_HABILITADA'));
    await expect(generarContratoExpediente('exp-1', 'user-1', 'propietario', DATOS)).rejects.toMatchObject({
      errorCode: 'DESTINACION_NO_HABILITADA',
    });
  });

  it('un error cualquiera se sigue tragando: aprobado sin contrato', async () => {
    mockGenerarContrato.mockRejectedValueOnce(new Error('boom'));
    await expect(generarContratoExpediente('exp-1', 'user-1', 'propietario', DATOS)).resolves.toMatchObject({
      contrato_id: null,
    });
    expect(mockGenerarContrato).toHaveBeenCalledTimes(1);
  });
});

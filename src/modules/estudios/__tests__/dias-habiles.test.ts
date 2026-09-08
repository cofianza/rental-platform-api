import { describe, it, expect, vi } from 'vitest';

// ============================================================
// diasHabilesTranscurridos vive en estudios.service.ts (Politica §8: plazo de
// 15 dias habiles para re-evaluar). Es pura, pero el modulo arrastra todo el
// grafo de imports del servicio: se mockea lo que toca red o Supabase.
// ============================================================

const { mockEnv } = vi.hoisted(() => ({
  // Proxy permisivo: los flags *_ENABLED apagados, todo lo demas un string.
  // Nada de esto se lee al importar salvo la configuracion de los providers.
  mockEnv: new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => (typeof k === 'string' && k.endsWith('_ENABLED') ? false : 'x'),
  }),
}));

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/email', () => ({ sendEstudioFormEmail: vi.fn() }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({})) }));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: vi.fn(),
  perfilEsDuenoDeInmueble: vi.fn(),
  assertExpedienteAccess: vi.fn(),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(),
  findPerfilIdByEmail: vi.fn(),
  notificarResponsableExpediente: vi.fn(),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));

import { diasHabilesTranscurridos } from '../estudios.service';

const d = (iso: string) => new Date(iso);

describe('diasHabilesTranscurridos (Politica §8: 15 dias habiles)', () => {
  // 2026-09-07 es lunes.
  it('mismo dia = 0', () => {
    expect(diasHabilesTranscurridos(d('2026-09-07T15:00:00Z'), d('2026-09-07T20:00:00Z'))).toBe(0);
  });

  it('lunes -> martes = 1', () => {
    expect(diasHabilesTranscurridos(d('2026-09-07T15:00:00Z'), d('2026-09-08T15:00:00Z'))).toBe(1);
  });

  it('viernes -> lunes = 1 (salta el fin de semana)', () => {
    expect(diasHabilesTranscurridos(d('2026-09-04T15:00:00Z'), d('2026-09-07T15:00:00Z'))).toBe(1);
  });

  it('tres semanas exactas = 15 (dentro del plazo); un dia habil mas = 16 (fuera)', () => {
    expect(diasHabilesTranscurridos(d('2026-09-07T15:00:00Z'), d('2026-09-28T15:00:00Z'))).toBe(15);
    expect(diasHabilesTranscurridos(d('2026-09-07T15:00:00Z'), d('2026-09-29T15:00:00Z'))).toBe(16);
  });

  it('cuenta por fecha de Bogota (UTC-5), no por fecha UTC', () => {
    // 2026-09-08T03:00Z todavia es 7 de septiembre a las 22:00 en Bogota.
    expect(diasHabilesTranscurridos(d('2026-09-07T15:00:00Z'), d('2026-09-08T03:00:00Z'))).toBe(0);
  });

  it('hasta anterior a desde = 0, nunca negativo', () => {
    expect(diasHabilesTranscurridos(d('2026-09-08T15:00:00Z'), d('2026-09-07T15:00:00Z'))).toBe(0);
  });
});

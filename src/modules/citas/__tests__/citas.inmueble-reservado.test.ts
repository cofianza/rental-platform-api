/**
 * Visitas sobre un inmueble ya comprometido: reservado para otro candidato,
 * arrendado o inactivo no admite visitas nuevas ni reprogramadas; el estudio
 * que tiene la reserva sí puede seguir con las suyas.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/tenantScope', () => ({ resolveAllowedInmuebleIds: vi.fn(), resolveMembershipInmobiliariaIds: vi.fn() }));

import { assertInmuebleAdmiteVisitas } from '../citas.permissions';

const codigo = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { errorCode?: string }).errorCode;
  }
};

describe('assertInmuebleAdmiteVisitas', () => {
  it('reservado para otro candidato: 409 INMUEBLE_RESERVADO', () => {
    expect(codigo(() => assertInmuebleAdmiteVisitas('exp-b', 'ocupado', 'exp-a'))).toBe('INMUEBLE_RESERVADO');
  });

  it('el estudio que tiene la reserva sí agenda', () => {
    expect(codigo(() => assertInmuebleAdmiteVisitas('exp-a', 'ocupado', 'exp-a'))).toBeNull();
  });

  it('arrendado sin titular o inactivo: 409 INMUEBLE_NO_DISPONIBLE', () => {
    expect(codigo(() => assertInmuebleAdmiteVisitas('exp-b', 'ocupado', null))).toBe('INMUEBLE_NO_DISPONIBLE');
    expect(codigo(() => assertInmuebleAdmiteVisitas('exp-b', 'inactivo', null))).toBe('INMUEBLE_NO_DISPONIBLE');
  });

  it('disponible: pasa', () => {
    expect(codigo(() => assertInmuebleAdmiteVisitas('exp-b', 'disponible', null))).toBeNull();
  });
});

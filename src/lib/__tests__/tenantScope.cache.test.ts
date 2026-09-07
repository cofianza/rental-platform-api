/**
 * Cache de membresias en tenantScope: una sola consulta por perfil dentro
 * del TTL, y la invalidacion vuelve a consultar. Es la unica pieza con
 * estado del scoping multi-tenant — si se rompe, un miembro revocado
 * seguiria viendo la cartera hasta 30 s DESPUES de la mutacion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, filas } = vi.hoisted(() => {
  const filas: Array<Record<string, unknown>> = [];
  // Chain minimo: from().select().eq().eq() -> thenable con { data, error }
  const chain = {
    select: () => chain,
    eq: () => chain,
    then: (resolve: (v: unknown) => void) => resolve({ data: [...filas], error: null }),
  };
  return { mockFrom: vi.fn(() => chain), filas };
});
vi.mock('@/lib/supabase', () => ({ supabase: { from: mockFrom } }));

import {
  resolveMembershipInmobiliariaIds,
  resolveVisibilityScope,
  invalidateMembresiasCache,
} from '@/lib/tenantScope';

describe('tenantScope — cache de membresias', () => {
  beforeEach(() => {
    mockFrom.mockClear();
    invalidateMembresiasCache();
    filas.length = 0;
    filas.push({ inmobiliaria_id: 'org-1', rol_miembro: 'owner', inmobiliarias: { miembros_ven_todo: true } });
  });

  it('consulta una sola vez por perfil dentro del TTL, aunque lo pidan 3 resolvers', async () => {
    expect(await resolveMembershipInmobiliariaIds('p1')).toEqual(['org-1']);
    expect(await resolveVisibilityScope('p1', 'inmobiliaria')).toEqual({ kind: 'org', orgIds: ['org-1'] });
    await resolveMembershipInmobiliariaIds('p1');
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('otro perfil es otra entrada', async () => {
    await resolveMembershipInmobiliariaIds('p1');
    await resolveMembershipInmobiliariaIds('p2');
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('invalidar (revocacion) vuelve a la BD y refleja el cambio', async () => {
    await resolveMembershipInmobiliariaIds('p1');
    filas.length = 0; // revocado
    expect(await resolveMembershipInmobiliariaIds('p1')).toEqual(['org-1']); // aun cacheado
    invalidateMembresiasCache();
    expect(await resolveMembershipInmobiliariaIds('p1')).toEqual([]);
    expect(await resolveVisibilityScope('p1', 'inmobiliaria')).toEqual({ kind: 'own', perfilId: 'p1' });
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });
});

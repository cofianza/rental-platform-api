/**
 * Cache de membresias en tenantScope: una sola consulta por perfil dentro
 * del TTL, y la invalidacion vuelve a consultar. Es la unica pieza con
 * estado del scoping multi-tenant — si se rompe, un miembro revocado
 * seguiria viendo la cartera hasta 30 s DESPUES de la mutacion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, filas, ops, respuestas } = vi.hoisted(() => {
  const filas: Array<Record<string, unknown>> = [];
  const ops: Array<{ metodo: string; args: unknown[] }> = [];
  // Resultados para los terminales (maybeSingle/single) de ensureOrgConOwner.
  const respuestas: Array<Record<string, unknown>> = [];
  const siguiente = () => respuestas.shift() ?? { data: null, error: null };
  // Chain minimo: cualquier filtro devuelve el mismo builder; el `await`
  // directo resuelve con las filas de membresia.
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => void) => resolve({ data: [...filas], error: null }),
    maybeSingle: async () => siguiente(),
    single: async () => siguiente(),
  };
  for (const m of ['select', 'eq', 'order', 'insert', 'limit']) {
    chain[m] = (...args: unknown[]) => {
      ops.push({ metodo: m, args });
      return chain;
    };
  }
  return { mockFrom: vi.fn(() => chain), filas, ops, respuestas };
});
vi.mock('@/lib/supabase', () => ({ supabase: { from: mockFrom } }));

import {
  resolveMembershipInmobiliariaIds,
  resolveVisibilityScope,
  invalidateMembresiasCache,
  ensureOrgConOwner,
} from '@/lib/tenantScope';

describe('tenantScope — cache de membresias', () => {
  beforeEach(() => {
    mockFrom.mockClear();
    ops.length = 0;
    respuestas.length = 0;
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

  it('la consulta va ordenada: sin orden, un perfil con dos organizaciones caia en una distinta cada vez', async () => {
    await resolveMembershipInmobiliariaIds('p1');
    const orden = ops.filter((o) => o.metodo === 'order').map((o) => o.args[0]);
    expect(orden).toContain('created_at');
    // Desempate: el backfill inserta todas las membresias con el mismo
    // created_at, y entre empates Postgres tampoco garantiza orden.
    expect(orden).toContain('id');
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

describe('ensureOrgConOwner', () => {
  beforeEach(() => {
    mockFrom.mockClear();
    ops.length = 0;
    respuestas.length = 0;
    invalidateMembresiasCache();
    filas.length = 0;
  });

  it('si falla el insert de la membresia, lanza: la org no puede quedar con un titular sin membresia', async () => {
    respuestas.push(
      { data: null, error: null },              // no existe org previa
      { data: { id: 'org-9' }, error: null },   // se crea la org
      { data: null, error: null },              // la membresia aun no existe
    );
    // El insert de la membresia se resuelve por `await` del builder, que
    // devuelve las filas vacias mas el error que dejemos aqui.
    const chain = mockFrom('inmobiliaria_miembros') as unknown as Record<string, unknown>;
    const thenOriginal = chain.then;
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: new Error('insert falló') });

    await expect(ensureOrgConOwner('p1', 'Mi Inmobiliaria')).rejects.toThrow('insert falló');

    chain.then = thenOriginal;
  });

  it('tras crear la org invalida el cache, para que el titular la vea de una', async () => {
    await resolveMembershipInmobiliariaIds('p1'); // deja el perfil cacheado sin orgs
    const llamadasAntes = mockFrom.mock.calls.length;

    respuestas.push(
      { data: null, error: null },
      { data: { id: 'org-9' }, error: null },
      { data: null, error: null },              // la membresia aun no existe
    );
    expect(await ensureOrgConOwner('p1', 'Mi Inmobiliaria')).toBe('org-9');

    filas.push({ inmobiliaria_id: 'org-9', rol_miembro: 'owner', inmobiliarias: { miembros_ven_todo: true } });
    expect(await resolveMembershipInmobiliariaIds('p1')).toEqual(['org-9']);
    expect(mockFrom.mock.calls.length).toBeGreaterThan(llamadasAntes);
  });
});

describe('ensureOrgConOwner — reparacion', () => {
  beforeEach(() => {
    mockFrom.mockClear();
    ops.length = 0;
    respuestas.length = 0;
    invalidateMembresiasCache();
    filas.length = 0;
  });

  it('org ya creada pero SIN membresia: la inserta en vez de devolverla rota', async () => {
    respuestas.push(
      { data: { id: 'org-7' }, error: null },   // la org ya existe
      { data: null, error: null },              // pero no hay membresia
    );

    expect(await ensureOrgConOwner('p1', 'Mi Inmobiliaria')).toBe('org-7');

    // Sin la reparacion, el early-return devolvia el id y nunca insertaba:
    // la cuenta quedaba sin poder invitar a nadie, para siempre.
    const inserts = ops.filter((o) => o.metodo === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[0]).toMatchObject({
      inmobiliaria_id: 'org-7',
      perfil_id: 'p1',
      rol_miembro: 'owner',
      estado: 'activo',
    });
  });

  it('org ya creada y CON membresia: no inserta nada', async () => {
    respuestas.push(
      { data: { id: 'org-7' }, error: null },   // la org ya existe
      { data: { id: 'm-1' }, error: null },     // y la membresia tambien
    );

    expect(await ensureOrgConOwner('p1', 'Mi Inmobiliaria')).toBe('org-7');
    expect(ops.filter((o) => o.metodo === 'insert')).toHaveLength(0);
  });
});

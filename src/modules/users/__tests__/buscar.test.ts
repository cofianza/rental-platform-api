import { describe, it, expect, vi } from 'vitest';

// ============================================================
// Buscador de perfiles (selector de propietario): el término del usuario no
// puede cambiar el filtro `or` de PostgREST (comas, paréntesis, comodines).
// ============================================================

const { ors } = vi.hoisted(() => ({ ors: [] as string[] }));

vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order']) chain[m] = () => chain;
  chain.or = (f: string) => {
    ors.push(f);
    return chain;
  };
  chain.limit = async () => ({ data: [], error: null });
  return { supabase: { from: () => chain }, supabaseAuth: {} };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/email', () => ({ sendWelcomeEmail: vi.fn() }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));

import { buscarPerfilesActivos, terminoBusqueda } from '../users.service';

describe('buscarPerfilesActivos', () => {
  it('quita lo que cambia el filtro y conserva nombres con tilde', async () => {
    expect(terminoBusqueda('María José')).toBe('María José');
    expect(terminoBusqueda('a,rol.eq.administrador)')).toBe('arol.eq.administrador');
    expect(terminoBusqueda('"*%(x)')).toBe('x');
    await buscarPerfilesActivos('ana,estado.eq.inactivo');
    expect(ors.at(-1)).toBe('nombre.ilike.%anaestado.eq.inactivo%,apellido.ilike.%anaestado.eq.inactivo%,razon_social.ilike.%anaestado.eq.inactivo%');
  });

  it('con menos de 2 caracteres útiles no consulta', async () => {
    const antes = ors.length;
    expect(await buscarPerfilesActivos('(,)')).toEqual([]);
    expect(ors.length).toBe(antes);
  });
});

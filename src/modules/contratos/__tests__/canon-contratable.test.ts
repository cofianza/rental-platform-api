import { describe, it, expect, vi, beforeEach } from 'vitest';

// El contrato no puede afianzar un canon que el estudio no evaluó: máximo =
// canon evaluado + TOLERANCIA_CANON, sin pasar el tope (y nunca menos que lo evaluado).
const { resultado } = vi.hoisted(() => ({ resultado: { data: null as unknown } }));
vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: resultado.data, error: null });
  return { supabase: { from: () => chain, storage: { from: () => ({}) } }, supabaseAuth: {} };
});
vi.mock('@/config', () => ({ env: { RESEND_API_KEY: 're_test', CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));
vi.mock('@/config/env', () => ({ env: { RESEND_API_KEY: 're_test', CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/calibracion', async (orig) => {
  const actual = await orig<typeof import('@/lib/calibracion')>();
  return { ...actual, getCalibracion: async () => ({ ...actual.CALIBRACION_DEFAULT, TOLERANCIA_CANON: 15 }) };
});

import { assertCanonContratable } from '../contratos.service';

beforeEach(() => {
  resultado.data = null;
});

describe('assertCanonContratable', () => {
  it('hasta lo evaluado + 15 % pasa; un peso más, 409', async () => {
    resultado.data = { canon_evaluado: 2_000_000 };
    await expect(assertCanonContratable('e1', 2_300_000, 'vivienda')).resolves.toBeUndefined();
    await expect(assertCanonContratable('e1', 2_300_001, 'vivienda')).rejects.toMatchObject({
      errorCode: 'CANON_REQUIERE_NUEVA_EVALUACION',
      statusCode: 409,
    });
  });

  it('el tope de vivienda manda aunque la tolerancia dé más', async () => {
    resultado.data = { canon_evaluado: 2_800_000 };
    await expect(assertCanonContratable('e1', 3_000_000, 'vivienda')).resolves.toBeUndefined();
    await expect(assertCanonContratable('e1', 3_000_001, 'vivienda')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('sin canon evaluado (estudio anterior al congelado) no bloquea', async () => {
    resultado.data = { canon_evaluado: null };
    await expect(assertCanonContratable('e1', 9_000_000, 'vivienda')).resolves.toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// El contrato no puede afianzar un canon que el estudio no evaluó: máximo =
// canon evaluado + TOLERANCIA_CANON, sin pasar el tope (y nunca menos que lo evaluado).
const { resultado, mockEscalar } = vi.hoisted(() => ({
  resultado: { data: null as unknown, sombra: null as unknown },
  mockEscalar: vi.fn(),
}));
vi.mock('@/lib/supabase', () => {
  const chainDe = (tabla: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
    chain.maybeSingle = async () => ({
      data: tabla === 'estudios_scorecard_sombra' ? resultado.sombra : resultado.data,
      error: null,
    });
    return chain;
  };
  return { supabase: { from: chainDe, storage: { from: () => ({}) } }, supabaseAuth: {} };
});
vi.mock('@/config', () => ({ env: { RESEND_API_KEY: 're_test', CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));
vi.mock('@/config/env', () => ({ env: { RESEND_API_KEY: 're_test', CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/calibracion', async (orig) => {
  const actual = await orig<typeof import('@/lib/calibracion')>();
  return { ...actual, getCalibracion: async () => ({ ...actual.CALIBRACION_DEFAULT, TOLERANCIA_CANON: 15 }) };
});

// Adenda 1 contratos §2.4: el aviso a la Gerencia se prueba en tope-coafianzamiento.test.ts.
vi.mock('../tope-coafianzamiento', () => ({ escalarTopeCanon: (...a: unknown[]) => mockEscalar(...a) }));

import { assertCanonContratable } from '../contratos.service';

beforeEach(() => {
  resultado.data = null;
  resultado.sombra = null;
  mockEscalar.mockReset();
});

describe('assertCanonContratable', () => {
  it('hasta lo evaluado + 15 % pasa; un peso más, 409 (nueva evaluación, sin escalar)', async () => {
    resultado.data = { canon_evaluado: 2_000_000 };
    await expect(assertCanonContratable('e1', 2_300_000, 'vivienda')).resolves.toBeUndefined();
    await expect(assertCanonContratable('e1', 2_300_001, 'vivienda')).rejects.toMatchObject({
      errorCode: 'CANON_REQUIERE_NUEVA_EVALUACION',
      statusCode: 409,
    });
    expect(mockEscalar).not.toHaveBeenCalled();
  });

  it('el tope de vivienda manda aunque la tolerancia dé más: bloquea y escala a la Gerencia General', async () => {
    resultado.data = { canon_evaluado: 2_800_000 };
    await expect(assertCanonContratable('e1', 3_000_000, 'vivienda')).resolves.toBeUndefined();
    mockEscalar.mockResolvedValueOnce(true);
    const e = await assertCanonContratable('e1', 3_000_001, 'vivienda').catch((x: unknown) => x);
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CANON_EXCEDE_TOPE' });
    expect((e as Error).message).toContain('se envió a la Gerencia General de Cofianza para evaluar un coafianzamiento');
    expect(mockEscalar).toHaveBeenCalledWith('e1', 3_000_001, 3_000_000, 'contrato');
  });

  it('si el aviso a la Gerencia no quedó registrado, el mensaje no dice que se envió', async () => {
    resultado.data = { canon_evaluado: 2_800_000 };
    mockEscalar.mockResolvedValueOnce(false);
    const e = await assertCanonContratable('e1', 3_000_001, 'vivienda').catch((x: unknown) => x);
    expect((e as Error).message).toContain('Escríbele a Cofianza para evaluar un coafianzamiento');
    expect((e as Error).message).not.toContain('se envió');
  });

  it('A7: dentro de la tolerancia recalcula canon/ingreso con el ingreso ajustado (tope 40 %)', async () => {
    resultado.data = { id: 'est1', canon_evaluado: 2_000_000 };
    resultado.sombra = { ingreso_inferido_ajustado_cop: 5_500_000 };
    // 2.200.000 / 5.500.000 = 40 % exacto: cumple.
    await expect(assertCanonContratable('e1', 2_200_000, 'vivienda')).resolves.toBeUndefined();
    await expect(assertCanonContratable('e1', 2_200_001, 'vivienda')).rejects.toMatchObject({
      errorCode: 'CANON_INGRESO_EXCEDE',
      statusCode: 409,
    });
    // Igual o menor a lo evaluado no se recalcula (V3: «sin restricción»).
    resultado.sombra = { ingreso_inferido_ajustado_cop: 1_000_000 };
    await expect(assertCanonContratable('e1', 2_000_000, 'vivienda')).resolves.toBeUndefined();
  });

  it('A7: sin ingreso ajustado de la corrida no bloquea', async () => {
    resultado.data = { id: 'est1', canon_evaluado: 2_000_000 };
    resultado.sombra = null;
    await expect(assertCanonContratable('e1', 2_300_000, 'vivienda')).resolves.toBeUndefined();
  });

  it('sin canon evaluado (estudio anterior al congelado) no bloquea', async () => {
    resultado.data = { canon_evaluado: null };
    await expect(assertCanonContratable('e1', 9_000_000, 'vivienda')).resolves.toBeUndefined();
  });
});

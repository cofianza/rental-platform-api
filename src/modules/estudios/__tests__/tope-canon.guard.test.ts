import { describe, it, expect, vi } from 'vitest';

// Fila que devuelve la lectura del inmueble (select/eq encadenan, maybeSingle resuelve).
const { fila, mockFrom } = vi.hoisted(() => {
  const fila: { current: unknown } = { current: null };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => ({ data: fila.current, error: null });
  return { fila, mockFrom: vi.fn(() => chain) };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config/env', () => ({ env: { CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));
vi.mock('@/lib/calibracion', () => ({
  getCalibracion: vi.fn(async () => ({ CANON_MAX_TRANSITORIO: 3_000_000, TOPE_CANON_COMERCIAL: 4_000_000 })),
}));

import {
  assertCanonDentroDelTope,
  evaluarTopeCanon,
  errorTopeExcedido,
  CANON_EXCEDE_TOPE_ERROR_CODE,
  CODIGO_POLITICA_TOPE_CANON,
} from '../tope-canon.guard';

// ============================================================
// Politica V4.1 §6 llama a esta salida CANON_MAX_TRANSITORIO. El errorCode de
// la API se conserva (la web discrimina por el); el nombre de la Politica
// viaja en details.codigo_politica.
// ============================================================

describe('tope de canon — codigo de la Politica §6', () => {
  it('conserva el errorCode que usa la web y agrega codigo_politica', () => {
    const veredicto = evaluarTopeCanon({ canonCop: 3_000_001, topeCop: 3_000_000 });
    expect(veredicto.ok).toBe(false);
    if (veredicto.ok) return;

    const err = errorTopeExcedido(veredicto);
    expect(err.statusCode).toBe(400);
    expect(err.errorCode).toBe(CANON_EXCEDE_TOPE_ERROR_CODE);
    expect(err.errorCode).toBe('CANON_EXCEDE_TOPE');
    expect(err.details).toMatchObject({
      motivo: 'excede_tope',
      codigo_politica: 'CANON_MAX_TRANSITORIO',
      canon_cop: 3_000_001,
      tope_cop: 3_000_000,
    });
    expect(CODIGO_POLITICA_TOPE_CANON).toBe('CANON_MAX_TRANSITORIO');
  });

  it('el tope es inclusivo: exactamente el tope pasa', () => {
    expect(evaluarTopeCanon({ canonCop: 3_000_000, topeCop: 3_000_000 }).ok).toBe(true);
  });
});

// ============================================================
// Contratos V3, Fase 1: el tope por destinacion esta cableado, pero mientras
// el comercial no se habilite todo inmueble usa el de vivienda.
// ============================================================

describe('assertCanonDentroDelTope — tope por destinacion', () => {
  it('Fase 1: un comercial de 3.500.000 se bloquea con el tope de vivienda', async () => {
    fila.current = { valor_arriendo: 3_500_000, uso: 'comercial' };
    await expect(assertCanonDentroDelTope({ inmuebleId: 'inm-1', origen: 'test' })).rejects.toMatchObject({
      errorCode: 'CANON_EXCEDE_TOPE',
      details: { codigo_politica: 'CANON_MAX_TRANSITORIO', tope_cop: 3_000_000 },
    });
    expect(mockFrom).toHaveBeenCalledWith('inmuebles');
  });

  it('vivienda en el tope pasa', async () => {
    fila.current = { valor_arriendo: 3_000_000, uso: 'vivienda' };
    await expect(assertCanonDentroDelTope({ inmuebleId: 'inm-1', origen: 'test' })).resolves.toEqual({
      canonCop: 3_000_000,
    });
  });
});

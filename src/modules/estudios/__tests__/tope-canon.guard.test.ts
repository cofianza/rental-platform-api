import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config/env', () => ({ env: { CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));
vi.mock('@/lib/calibracion', () => ({
  getCalibracion: vi.fn(async () => ({ CANON_MAX_TRANSITORIO: 3_000_000 })),
}));

import {
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

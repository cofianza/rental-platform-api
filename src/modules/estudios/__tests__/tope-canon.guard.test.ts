import { describe, it, expect, vi } from 'vitest';

// Fila que devuelve la lectura del inmueble (select/eq encadenan, maybeSingle resuelve).
// Desde el estudio, primero se lee su inmueble_id.
const { fila, mockFrom } = vi.hoisted(() => {
  const fila: { current: unknown } = { current: null };
  const chainFor = (t: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => ({ data: t === 'expedientes' ? { inmueble_id: 'inm-1' } : fila.current, error: null });
    return chain;
  };
  return { fila, mockFrom: vi.fn((t: string) => chainFor(t)) };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config/env', () => ({ env: { CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));
vi.mock('@/lib/calibracion', () => ({
  getCalibracion: vi.fn(async () => ({ CANON_MAX_TRANSITORIO: 3_000_000, TOPE_CANON_COMERCIAL: 4_000_000 })),
}));
// Adenda 1 contratos §2.4: el escalamiento se prueba en contratos/__tests__/tope-coafianzamiento.test.ts.
const mockEscalar = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true));
vi.mock('@/modules/contratos/tope-coafianzamiento', () => ({ escalarTopeCanon: mockEscalar }));

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

// ============================================================
// Adenda 1 contratos §2.4: al bloquear la evaluación (habilitar o pagar) por el
// tope, el caso se escala a la Gerencia General, una vez por estudio.
// ============================================================

describe('assertCanonDentroDelTope — escalamiento a la Gerencia General', () => {
  it('con estudio: escala y el mensaje dice que se envió', async () => {
    mockEscalar.mockClear();
    fila.current = { valor_arriendo: 3_500_000, uso: 'vivienda' };
    const e = await assertCanonDentroDelTope({ expedienteId: 'exp-1', origen: 'habilitarEstudio' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ errorCode: 'CANON_EXCEDE_TOPE' });
    expect((e as Error).message).toContain('El caso se envió a la Gerencia General de Cofianza para evaluar un coafianzamiento');
    expect((e as Error).message).toMatch(/no se genero ningun cobro/i);
    expect(mockEscalar).toHaveBeenCalledWith('exp-1', 3_500_000, 3_000_000, 'estudio');
  });

  it('si no quedó registrado, el mensaje de siempre', async () => {
    mockEscalar.mockClear().mockResolvedValueOnce(false);
    fila.current = { valor_arriendo: 3_500_000, uso: 'vivienda' };
    const e = await assertCanonDentroDelTope({ expedienteId: 'exp-1', origen: 'pagarGestor' }).catch((x: unknown) => x);
    expect((e as Error).message).toContain('escribirnos para revisar el caso');
    expect((e as Error).message).not.toContain('se envió');
  });

  it('sin estudio todavía, o ya cobrado (solo advierte), no escala', async () => {
    mockEscalar.mockClear();
    fila.current = { valor_arriendo: 3_500_000, uso: 'vivienda' };
    await expect(assertCanonDentroDelTope({ inmuebleId: 'inm-1', origen: 'createExpediente' })).rejects.toMatchObject({
      errorCode: 'CANON_EXCEDE_TOPE',
    });
    await expect(
      assertCanonDentroDelTope({ expedienteId: 'exp-1', origen: 'solicitarReEvaluacion', soloAdvertir: true }),
    ).resolves.toEqual({ canonCop: 3_500_000 });
    expect(mockEscalar).not.toHaveBeenCalled();
  });
});

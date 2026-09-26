import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fila que devuelve la lectura del inmueble (select/eq encadenan, maybeSingle resuelve).
// Desde el estudio, primero se lee su inmueble_id.
// `arrendatario` es el solicitante: directo (solicitanteId) o embebido en el expediente.
const { fila, arrendatario, mockFrom } = vi.hoisted(() => {
  const fila: { current: unknown } = { current: null };
  const arrendatario: { current: unknown } = { current: null };
  const chainFor = (t: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => ({
      data:
        t === 'expedientes' ? { inmueble_id: 'inm-1', solicitantes: arrendatario.current }
        : t === 'solicitantes' ? arrendatario.current
        : fila.current,
      error: null,
    });
    return chain;
  };
  return { fila, arrendatario, mockFrom: vi.fn((t: string) => chainFor(t)) };
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
import { motivoNoAfianzable } from '../../inmuebles/destinacion';

beforeEach(() => {
  arrendatario.current = { tipo_persona: 'natural', tipo_documento: 'cc' };
});

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
// el comercial no se habilite todo inmueble usa el de vivienda. Solo se ve en
// lo ya cobrado: lo nuevo comercial ni siquiera nace (punto 3, abajo).
// ============================================================

describe('assertCanonDentroDelTope — tope por destinacion', () => {
  it('Fase 1: un comercial ya cobrado se contrasta con el tope de vivienda (solo advierte)', async () => {
    fila.current = { valor_arriendo: 3_500_000, uso: 'comercial' };
    await expect(
      assertCanonDentroDelTope({ inmuebleId: 'inm-1', origen: 'test', soloAdvertir: true }),
    ).resolves.toEqual({ canonCop: 3_500_000 });
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

// ============================================================
// Punto 3 (respuestas-por-documento-2026-09-25): sin contrato comercial ni de
// persona juridica en la plataforma, el estudio no nace ni se cobra.
// ============================================================

describe('motivoNoAfianzable — regla pura', () => {
  it('vivienda con persona natural pasa', () => {
    expect(motivoNoAfianzable('vivienda', { tipo_persona: 'natural', tipo_documento: 'cc' })).toBeNull();
    expect(motivoNoAfianzable('vivienda', null)).toBeNull();
  });

  it('comercial, local_comercial y mixto: destinacion', () => {
    for (const uso of ['comercial', 'local_comercial', 'mixto']) {
      expect(motivoNoAfianzable(uso, { tipo_persona: 'natural', tipo_documento: 'cc' })).toBe('destinacion');
    }
  });

  it('persona juridica o NIT (en cualquier caja): persona_juridica', () => {
    expect(motivoNoAfianzable('vivienda', { tipo_persona: 'juridica', tipo_documento: 'cc' })).toBe('persona_juridica');
    expect(motivoNoAfianzable('vivienda', { tipo_persona: 'natural', tipo_documento: 'nit' })).toBe('persona_juridica');
    expect(motivoNoAfianzable('vivienda', { tipo_persona: null, tipo_documento: 'NIT' })).toBe('persona_juridica');
  });

  it('uso desconocido no bloquea (la regla es comercial o mixto)', () => {
    expect(motivoNoAfianzable(null, null)).toBeNull();
  });
});

describe('assertCanonDentroDelTope — estudio no afianzable', () => {
  it('mixto: 409 antes del tope, sin escalar, y el mensaje dice que no se cobra', async () => {
    mockEscalar.mockClear();
    fila.current = { valor_arriendo: 3_500_000, uso: 'mixto' };
    const e = await assertCanonDentroDelTope({ expedienteId: 'exp-1', origen: 'habilitarEstudio' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'ESTUDIO_NO_AFIANZABLE', details: { motivo: 'destinacion' } });
    expect((e as Error).message).toContain('uso comercial o mixto');
    expect((e as Error).message).toContain('no se cobra el estudio');
    expect((e as Error).message).toContain('hola@cofianza.co');
    expect(mockEscalar).not.toHaveBeenCalled();
  });

  it('NIT del expediente: 409 persona_juridica', async () => {
    fila.current = { valor_arriendo: 2_000_000, uso: 'vivienda' };
    arrendatario.current = { tipo_persona: 'natural', tipo_documento: 'nit' };
    await expect(assertCanonDentroDelTope({ expedienteId: 'exp-1', origen: 'pagarGestor' })).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'ESTUDIO_NO_AFIANZABLE',
      details: { motivo: 'persona_juridica' },
    });
  });

  it('crear desde el inmueble: lee el solicitante que le pasan', async () => {
    mockFrom.mockClear();
    fila.current = { valor_arriendo: 2_000_000, uso: 'vivienda' };
    arrendatario.current = { tipo_persona: 'juridica', tipo_documento: 'nit' };
    await expect(
      assertCanonDentroDelTope({ inmuebleId: 'inm-1', solicitanteId: 'sol-1', origen: 'createExpediente' }),
    ).rejects.toMatchObject({ errorCode: 'ESTUDIO_NO_AFIANZABLE' });
    expect(mockFrom).toHaveBeenCalledWith('solicitantes');
  });

  it('ya cobrado (soloAdvertir): no se toca, ni se lee el solicitante', async () => {
    mockFrom.mockClear();
    fila.current = { valor_arriendo: 2_000_000, uso: 'comercial' };
    arrendatario.current = { tipo_persona: 'juridica', tipo_documento: 'nit' };
    await expect(
      assertCanonDentroDelTope({ expedienteId: 'exp-1', origen: 'solicitarReEvaluacion', soloAdvertir: true }),
    ).resolves.toEqual({ canonCop: 2_000_000 });
    // Una sola lectura del expediente (la del inmueble): la del solicitante no corre.
    expect(mockFrom.mock.calls.filter(([t]) => t === 'expedientes')).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  DESTINOS,
  DESTINACION_NO_HABILITADA,
  destinacionDeUso,
  destinacionParaContrato,
  topeCanonPara,
} from '../destinacion';

// Fase 2 inyectada: prueba hoy que habilitar comercial basta.
const FASE2 = { ...DESTINOS, comercial: { ...DESTINOS.comercial, habilitado: true } };
const CAL = { CANON_MAX_TRANSITORIO: 3e6, TOPE_CANON_COMERCIAL: 4e6 };

function errorDe(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    return err as AppError;
  }
  throw new Error('no lanzo');
}

describe('destinacionDeUso', () => {
  it('mapea los cuatro valores del enum', () => {
    expect(destinacionDeUso('vivienda')).toBe('vivienda');
    expect(destinacionDeUso('comercial')).toBe('comercial');
    expect(destinacionDeUso('local_comercial')).toBe('comercial');
    expect(destinacionDeUso('mixto')).toBeNull();
  });

  it('null y claves del prototipo no tienen destinacion', () => {
    expect(destinacionDeUso(null)).toBeNull();
    expect(destinacionDeUso('constructor')).toBeNull();
  });
});

describe('destinacionParaContrato', () => {
  it('vivienda pasa', () => {
    expect(destinacionParaContrato('vivienda')).toBe('vivienda');
  });

  it.each(['comercial', 'local_comercial'])('%s: 400 no_habilitada, nombra el arrendamiento comercial', (uso) => {
    const err = errorDe(() => destinacionParaContrato(uso));
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(400);
    expect(err.errorCode).toBe(DESTINACION_NO_HABILITADA);
    expect(err.details).toMatchObject({ motivo: 'no_habilitada', destinacion: 'comercial', uso });
    expect(err.message).toContain('arrendamiento comercial');
  });

  it('mixto: lo revisa la Gerencia General', () => {
    const err = errorDe(() => destinacionParaContrato('mixto'));
    expect(err.errorCode).toBe(DESTINACION_NO_HABILITADA);
    expect(err.details).toMatchObject({ motivo: 'mixto', destinacion: null });
    expect(err.message).toContain('Gerencia General');
  });

  it('uso desconocido', () => {
    const err = errorDe(() => destinacionParaContrato('bodega'));
    expect(err.errorCode).toBe(DESTINACION_NO_HABILITADA);
    expect(err.details).toMatchObject({ motivo: 'uso_desconocido', uso: 'bodega' });
    expect(errorDe(() => destinacionParaContrato(undefined)).details).toMatchObject({ motivo: 'uso_desconocido', uso: null });
  });

  it('Fase 2: comercial pasa y mixto sigue bloqueado', () => {
    expect(destinacionParaContrato('comercial', FASE2)).toBe('comercial');
    expect(destinacionParaContrato('local_comercial', FASE2)).toBe('comercial');
    expect(errorDe(() => destinacionParaContrato('mixto', FASE2)).errorCode).toBe(DESTINACION_NO_HABILITADA);
  });
});

describe('topeCanonPara', () => {
  it('Fase 1: todo uso aplica el tope de vivienda', () => {
    for (const uso of ['vivienda', 'comercial', 'local_comercial', 'mixto', 'bodega', null, undefined]) {
      expect(topeCanonPara(uso, CAL)).toEqual({ topeCop: 3e6, clave: 'CANON_MAX_TRANSITORIO' });
    }
  });

  it('Fase 2: comercial aplica su propio tope', () => {
    expect(topeCanonPara('comercial', CAL, FASE2)).toEqual({ topeCop: 4e6, clave: 'TOPE_CANON_COMERCIAL' });
    expect(topeCanonPara('vivienda', CAL, FASE2)).toEqual({ topeCop: 3e6, clave: 'CANON_MAX_TRANSITORIO' });
    expect(topeCanonPara('mixto', CAL, FASE2)).toEqual({ topeCop: 3e6, clave: 'CANON_MAX_TRANSITORIO' });
  });
});

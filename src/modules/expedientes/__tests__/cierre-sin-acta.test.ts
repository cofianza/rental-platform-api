import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Constancia del cierre sin acta (Adenda 1 contratos, respuesta 21): se lee
// aparte y nunca tumba al que la pide, ni sin la migración 20260930000002.
// ============================================================

const { queues, mockWarn } = vi.hoisted(() => ({
  queues: new Map<string, Array<Record<string, unknown>>>(),
  mockWarn: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) chain[m] = () => chain;
    chain.maybeSingle = async () => {
      const r = queues.get(table)?.shift();
      if (r instanceof Error) throw r;
      return r ?? { data: null, error: null };
    };
    return chain;
  };
  return { supabase: { from: (t: string) => chainFor(t) } };
});
vi.mock('@/lib/logger', () => ({ logger: { warn: mockWarn, error: vi.fn(), info: vi.fn() } }));

import { faltaColumna, leerCierreSinActa } from '../cierre-sin-acta';

beforeEach(() => {
  queues.clear();
  mockWarn.mockClear();
});

describe('leerCierreSinActa', () => {
  it('con cierre: quién (nombre), cuándo y por qué', async () => {
    queues.set('expedientes', [
      { data: { cierre_sin_acta_en: '2026-09-23T15:00:00Z', cierre_sin_acta_por: 'ad1', cierre_sin_acta_motivo: 'No hubo acta' }, error: null },
    ]);
    queues.set('perfiles', [{ data: { nombre: 'Ana', apellido: 'Admin' }, error: null }]);
    expect(await leerCierreSinActa('e1')).toEqual({ en: '2026-09-23T15:00:00Z', porNombre: 'Ana Admin', motivo: 'No hubo acta' });
  });

  it('sin cierre sin acta: null', async () => {
    queues.set('expedientes', [{ data: { cierre_sin_acta_en: null, cierre_sin_acta_por: null, cierre_sin_acta_motivo: null }, error: null }]);
    expect(await leerCierreSinActa('e1')).toBeNull();
  });

  it.each(['42703', 'PGRST204'])('sin la migración (%s): null y sin ruido en el log', async (code) => {
    queues.set('expedientes', [{ data: null, error: { code, message: 'column does not exist' } }]);
    expect(await leerCierreSinActa('e1')).toBeNull();
    expect(mockWarn).not.toHaveBeenCalled();
    expect(faltaColumna({ code })).toBe(true);
  });

  it('otro error, o una excepción: null con aviso en el log', async () => {
    queues.set('expedientes', [{ data: null, error: { code: '57014', message: 'timeout' } }, new Error('red caída') as never]);
    expect(await leerCierreSinActa('e1')).toBeNull();
    expect(await leerCierreSinActa('e1')).toBeNull();
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });
});

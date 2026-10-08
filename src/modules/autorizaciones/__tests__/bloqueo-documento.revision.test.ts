import { describe, it, expect, vi, beforeEach } from 'vitest';

// Revisión 2026-10-08 (BLQ-2): un acierto que no se pudo contar no es «no
// coincide»; y tras «no soy yo» la inmobiliaria no ve «pendiente de reenvío».

const { queues } = vi.hoisted(() => ({ queues: new Map<string, Array<Record<string, unknown>>>() }));

vi.mock('@/lib/supabase', () => {
  const next = (t: string) => queues.get(t)?.shift() ?? { data: null, error: null };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'is', 'in', 'order', 'limit']) chain[m] = () => chain;
    chain.maybeSingle = async () => next(table);
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(next(table)).then(res, rej);
    return chain;
  };
  return { supabase: { from } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { estadoBloqueoParaRol, registrarIntentoDocumento } from '../bloqueo-documento';

const intento = (coincide: boolean) => ({
  autorizacionId: 'aut-1',
  expedienteId: 'exp-1',
  tipoDigitado: 'cc',
  valorDigitado: '123',
  coincide,
  origen: 'confirmacion' as const,
  maxIntentos: 3,
});

describe('registrarIntentoDocumento sin poder contar', () => {
  beforeEach(() => queues.clear());
  const conteoFalla = () =>
    queues.set('autorizacion_intentos_documento', [{ data: null, error: null }, { count: null, error: { message: 'down' } }]);

  it('un acierto responde 503 reintentable, no «sin intentos»', async () => {
    conteoFalla();
    await expect(registrarIntentoDocumento(intento(true))).rejects.toMatchObject({ statusCode: 503, errorCode: 'INTENTOS_NO_VERIFICABLES' });
  });
  it('un fallido sigue fallando cerrado (0)', async () => {
    conteoFalla();
    await expect(registrarIntentoDocumento(intento(false))).resolves.toBe(0);
  });
});

describe('estadoBloqueoParaRol', () => {
  const corregidoTrasNoSoyYo = { estado: 'pendiente_reenvio' as const, motivo: 'no_soy_yo' };
  it('la inmobiliaria sigue viendo la identidad rechazada; Cofianza, pendiente de reenvío', () => {
    expect(estadoBloqueoParaRol(corregidoTrasNoSoyYo, false)).toBe('identidad_rechazada');
    expect(estadoBloqueoParaRol(corregidoTrasNoSoyYo, true)).toBe('pendiente_reenvio');
  });
  it('otros bloqueos no cambian', () => {
    expect(estadoBloqueoParaRol({ estado: 'pendiente_reenvio', motivo: 'intentos' }, false)).toBe('pendiente_reenvio');
    expect(estadoBloqueoParaRol({ estado: null, motivo: null }, false)).toBeNull();
  });
});

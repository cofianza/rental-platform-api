/**
 * H43: la regla "una cuenta de solicitante por documento" del registro corre
 * también cuando el documento se escribe después (Mi cuenta, datos fiscales,
 * el gestor). Una sola función para todos los caminos.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { tablas, inIds } = vi.hoisted(() => ({
  tablas: {} as Record<string, unknown[]>,
  inIds: [] as string[][],
}));

vi.mock('@/lib/supabase', () => {
  const chainFor = (tabla: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) chain[m] = () => chain;
    chain.in = (_c: string, ids: string[]) => {
      inIds.push(ids);
      return chain;
    };
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: tablas[tabla] ?? [], error: null }).then(ok);
    return chain;
  };
  return { supabase: { from: (t: string) => chainFor(t) } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/tenantScope', () => ({}));

import { existeOtraCuentaConDocumento } from '../solicitantes.service';

const PERFILES = [
  { id: 'cuenta-a', rol: 'solicitante' },
  { id: 'cuenta-b', rol: 'solicitante' },
  { id: 'dueno', rol: 'propietario' },
];

describe('existeOtraCuentaConDocumento', () => {
  beforeEach(() => {
    for (const k of Object.keys(tablas)) delete tablas[k];
    inIds.length = 0;
    tablas.perfiles = PERFILES;
  });

  it('registro (sin ficha): encuentra la cuenta propia que ya tiene ese documento', async () => {
    tablas.solicitantes = [{ id: 'f', creado_por: 'cuenta-a', inmobiliaria_id: null }];
    expect(await existeOtraCuentaConDocumento('cc', '123', undefined)).toBe(true);
  });

  it('fichas de agencia o de propietario no cuentan como cuenta', async () => {
    tablas.solicitantes = [
      { id: 'f1', creado_por: 'asesor', inmobiliaria_id: 'inmo-1' },
      { id: 'f2', creado_por: 'dueno', inmobiliaria_id: null },
    ];
    expect(await existeOtraCuentaConDocumento('cc', '123', undefined)).toBe(false);
  });

  it('después del registro: la cuenta no choca consigo misma', async () => {
    tablas.solicitantes = [{ id: 'f', creado_por: 'cuenta-a', inmobiliaria_id: null }];
    expect(await existeOtraCuentaConDocumento('cc', '123', { creado_por: 'cuenta-a' })).toBe(false);
  });

  it('después del registro: otra cuenta con ese documento -> duplicado', async () => {
    tablas.solicitantes = [{ id: 'f', creado_por: 'cuenta-b', inmobiliaria_id: null }];
    expect(await existeOtraCuentaConDocumento('cc', '123', { creado_por: 'cuenta-a', inmobiliaria_id: null })).toBe(true);
    expect(inIds[0]).toEqual(['cuenta-b', 'cuenta-a']);
  });

  it('la ficha que se edita es de agencia: no aplica (ni consulta)', async () => {
    tablas.solicitantes = [{ id: 'f', creado_por: 'cuenta-b', inmobiliaria_id: null }];
    expect(await existeOtraCuentaConDocumento('cc', '123', { creado_por: 'asesor', inmobiliaria_id: 'inmo-1' })).toBe(false);
    expect(inIds).toEqual([]);
  });

  it('la ficha que se edita es de un propietario (sin inmobiliaria): no aplica', async () => {
    tablas.solicitantes = [{ id: 'f', creado_por: 'cuenta-b', inmobiliaria_id: null }];
    expect(await existeOtraCuentaConDocumento('cc', '123', { creado_por: 'dueno', inmobiliaria_id: null })).toBe(false);
  });
});

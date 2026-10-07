import { describe, it, expect, vi } from 'vitest';

// Listado del backoffice de migración: una sola consulta con embeds y la forma de la respuesta.

const { ops, chain } = vi.hoisted(() => {
  const ops: Array<{ method: string; args: unknown[] }> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'neq', 'order'])
    chain[m] = (...args: unknown[]) => {
      ops.push({ method: m, args });
      return chain;
    };
  return { ops, chain };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: () => chain } }));
vi.mock('@/lib/gerenciaGeneral', () => ({ esGerenciaGeneral: () => false }));

import { listarInmobiliarias } from '../habilitacion.service';

const hab = (over: Record<string, unknown> = {}) => ({
  destinacion: 'vivienda',
  estado: 'habilitada',
  convenio_vigente_confirmado: true,
  convenio_migracion_storage_key: 'k1',
  plantilla_storage_key: 'k2',
  ...over,
});

describe('listarInmobiliarias', () => {
  it('arma nombre, titular, habilitaciones con faltantes y suspensión en una consulta', async () => {
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: [
          {
            id: 'o1',
            nombre: 'Org 1',
            estado: 'activa',
            migracion_suspendida_en: '2026-10-01T00:00:00Z',
            migracion_suspendida_motivo: 'declaración falsa',
            owner: { id: 'p1', nombre: 'Ana', apellido: 'Pérez', razon_social: 'Inmo S.A.S.', ciudad: 'Bogotá', estado: 'activo' },
            migracion_habilitaciones: [hab(), hab({ destinacion: 'comercial', plantilla_storage_key: null })],
          },
          { id: 'o2', nombre: 'Org 2', estado: 'activa', migracion_suspendida_en: null, owner: null, migracion_habilitaciones: null },
        ],
        error: null,
      }).then(resolve);

    const out = await listarInmobiliarias();

    expect(ops.filter((o) => o.method === 'select')).toHaveLength(1);
    expect(ops).toContainEqual({ method: 'neq', args: ['estado', 'cerrada'] });
    expect(out[0]).toEqual({
      id: 'o1',
      nombre: 'Inmo S.A.S.',
      estado: 'activa',
      titular: { id: 'p1', nombre: 'Ana Pérez' },
      ciudad: 'Bogotá',
      estado_cuenta: 'activo',
      habilitaciones: [
        { destinacion: 'vivienda', estado: 'habilitada', faltantes: [] },
        { destinacion: 'comercial', estado: 'habilitada', faltantes: ['cargar la plantilla de contrato revisada'] },
      ],
      suspension: { desde: '2026-10-01T00:00:00Z', motivo: 'declaración falsa' },
    });
    expect(out[1]).toMatchObject({ nombre: 'Org 2', titular: null, ciudad: null, habilitaciones: [], suspension: null });
  });
});

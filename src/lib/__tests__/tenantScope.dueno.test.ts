import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Dueño canónico del inmueble y su contacto (P17, P28, P37), con las funciones
// reales de tenantScope y solo Supabase simulado: el titular principal de la
// organización del inmueble, no quien lo registró; el WhatsApp de recaudo antes
// que el teléfono; y sin «Hola» como nombre.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    resetQueues: () => queues.clear(),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));

import {
  invalidateMembresiasCache,
  resolveContactoDueno,
  resolveNombreDueno,
  resolvePerfilCanonicoDeInmueble,
} from '../tenantScope';

beforeEach(() => {
  resetQueues();
  ops.length = 0;
  invalidateMembresiasCache();
});

describe('resolvePerfilCanonicoDeInmueble', () => {
  it('inmueble de una inmobiliaria: su titular principal, aunque lo haya registrado un asesor', async () => {
    enqueue('inmobiliarias', { data: { owner_perfil_id: 'titular1' } });
    await expect(resolvePerfilCanonicoDeInmueble({ propietario_id: 'asesor1', inmobiliaria_id: 'org1' })).resolves.toBe('titular1');
    expect(ops).toContainEqual({ table: 'inmobiliarias', method: 'eq', args: ['id', 'org1'] });
  });

  it('propietario individual: él mismo, sin consultar organizaciones', async () => {
    await expect(resolvePerfilCanonicoDeInmueble({ propietario_id: 'prop1', inmobiliaria_id: null })).resolves.toBe('prop1');
    expect(ops).toEqual([]);
  });

  it('organización sin titular registrado: queda quien registró el inmueble', async () => {
    enqueue('inmobiliarias', { data: { owner_perfil_id: null } });
    await expect(resolvePerfilCanonicoDeInmueble({ propietario_id: 'asesor1', inmobiliaria_id: 'org1' })).resolves.toBe('asesor1');
  });
});

describe('resolveContactoDueno', () => {
  it('el WhatsApp de recaudo antes que el teléfono, y el nombre de la inmobiliaria', async () => {
    enqueue('perfiles',
      { data: { whatsapp_recaudo: '+573015556677', telefono: '3009998877' } },
      { data: { nombre: 'Laura', apellido: 'Ríos', razon_social: null } },
    );
    enqueue('inmobiliaria_miembros', { data: [{ inmobiliaria_id: 'org1', rol_miembro: 'owner', inmobiliarias: { nombre: 'Norte', miembros_ven_todo: true } }] });
    enqueue('inmobiliarias', { data: { nombre: 'Inmobiliaria Norte' } });
    await expect(resolveContactoDueno('titular1')).resolves.toEqual({ nombre: 'Inmobiliaria Norte', whatsapp: '+573015556677' });
  });

  it('sin WhatsApp de recaudo, el teléfono; sin ningún nombre, null y no «Hola»', async () => {
    enqueue('perfiles',
      { data: { whatsapp_recaudo: null, telefono: '3009998877' } },
      { data: { nombre: '', apellido: '', razon_social: null } },
    );
    enqueue('inmobiliaria_miembros', { data: [] });
    await expect(resolveContactoDueno('prop1')).resolves.toEqual({ nombre: null, whatsapp: '3009998877' });
  });

  it('resolveNombreDueno sigue saludando con «Hola» cuando no hay nombre', async () => {
    enqueue('perfiles', { data: { nombre: null, apellido: null, razon_social: null } });
    enqueue('inmobiliaria_miembros', { data: [] });
    await expect(resolveNombreDueno('prop1')).resolves.toBe('Hola');
  });
});

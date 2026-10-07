import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Migración — cruces contra la base (§1.3): un inmueble ajeno con fianza viva
// de Cofianza se rechaza; sin fianza viva solo advierte.
// Mock de Supabase con colas por tabla (patrón de acta-firma.test.ts).
// ============================================================

const { ops, queues, enqueue, chainFor } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: [], error: null };
  };
  const PASSTHROUGH = ['select', 'eq', 'is', 'in', 'or', 'order', 'range'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH)
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    chainFor,
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => chainFor(t), storage: { from: vi.fn() } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn() }));
vi.mock('@/lib/colombia-municipios', async (orig) => ({ ...(await orig<object>()), getCatalog: vi.fn() }));
vi.mock('@/lib/companyConfig', () => ({ getCompany: vi.fn() }));
vi.mock('../acta', () => ({ generarActa: vi.fn() }));
vi.mock('../cartera.service', () => ({ avisarExposicionLote: vi.fn() }));
vi.mock('../habilitacion.service', () => ({ BUCKET: 'b', faltantesHabilitacion: vi.fn(), getOrg: vi.fn(), listarHabilitaciones: vi.fn() }));

import { cruzarConBase } from '../migracion.service';
import { claveInmueble, type ResultadoFila } from '../validacion';

const ORG = { id: 'org1', nombre: 'Inmo' } as never;

const fila = (direccion: string): ResultadoFila =>
  ({
    n_fila: 2,
    resultado: 'aceptada',
    motivos: [],
    advertencias: [],
    datos: { direccion, municipio: 'Medellín' },
    clave_inmueble: claveInmueble(direccion, 'Medellín'),
  }) as unknown as ResultadoFila;

beforeEach(() => {
  ops.length = 0;
  queues.clear();
});

describe('cruzarConBase', () => {
  it('inmueble de otra inmobiliaria con contrato vivo: rechazo sin nombrar a la otra', async () => {
    const r = fila('Calle 10 # 20-30');
    enqueue('inmuebles', { data: [], error: null }, { data: [{ id: 'i9', direccion: 'Calle 10 # 20-30', ciudad: 'Medellín' }], error: null });
    enqueue('contratos', { data: [], error: null }, { data: [{ id: 'c9', expedientes: { inmueble_id: 'i9' } }], error: null });
    await cruzarConBase(ORG, [r]);
    expect(r.resultado).toBe('rechazada');
    expect(r.motivos).toEqual(['Inmueble ya vinculado a una fianza activa de Cofianza.']);
    const consultaAjena = ops.filter((o) => o.table === 'contratos' && o.method === 'in');
    expect(consultaAjena).toContainEqual(expect.objectContaining({ args: ['expedientes.inmueble_id', ['i9']] }));
  });

  it('misma dirección ajena sin fianza viva: solo advierte', async () => {
    const r = fila('Calle 10 # 20-30');
    enqueue('inmuebles', { data: [], error: null }, { data: [{ id: 'i9', direccion: 'Calle 10 # 20-30', ciudad: 'Medellín' }], error: null });
    await cruzarConBase(ORG, [r]);
    expect(r.resultado).toBe('advertencia');
    expect(r.motivos).toEqual([]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Soportes del condicionado: el estudio 'con_coarrendatario' (se crea cuando
// el invitado acepta, despues del del titular) no puede pasar a ser el
// "activo". Si pasaba, los soportes del titular dejaban de listarse y las
// cargas nuevas quedaban colgadas del estudio del co-arrendatario.
// ============================================================

const { ops, queues, mockFrom } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'in', 'order']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.single = async () => next(table);
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown) => Promise.resolve(next(table)).then(resolve);
    return chain;
  };
  return { ops, queues, mockFrom: vi.fn((t: string) => chainFor(t)) };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: string) => mockFrom(t),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
  },
  supabaseAuth: {},
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/tenantScope', () => ({ perfilEsDuenoDeInmueble: vi.fn(async () => true) }));
vi.mock('../../notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn(async () => undefined) }));

import { listarSoportes, getContextoDocumentosPublico } from '../expediente-soportes.service';

const EXP = '550e8400-e29b-41d4-a716-446655440000';
const TITULAR = '880e8400-e29b-41d4-a716-446655440000';
const COA = '990e8400-e29b-41d4-a716-446655440000';

// El del co-arrendatario es el mas reciente: es justo el caso que fallaba.
const estudios = [
  { id: TITULAR, created_at: '2026-09-01T10:00:00Z', tipo: 'individual' },
  { id: COA, created_at: '2026-09-05T10:00:00Z', tipo: 'con_coarrendatario' },
];

const estudioListado = () =>
  ops.find((o) => o.table === 'estudios_documentos_soporte' && o.method === 'eq' && o.args[0] === 'estudio_id')?.args[1];

beforeEach(() => {
  queues.clear();
  ops.length = 0;
});

describe('soportes del condicionado con co-arrendatario', () => {
  it('el panel lista los soportes del estudio del titular', async () => {
    queues.set('expedientes', [
      { data: { id: EXP, estado: 'condicionado', creado_por: null, inmuebles: null, solicitantes: null, estudios }, error: null },
    ]);

    await listarSoportes(EXP, 'analista-1', 'operador_analista');

    const sel = ops.find((o) => o.table === 'expedientes' && o.method === 'select');
    expect(String(sel?.args[0])).toContain('estudios(id, created_at, tipo)');
    expect(estudioListado()).toBe(TITULAR);
  });

  it('el enlace publico tambien usa el estudio del titular', async () => {
    queues.set('expedientes', [
      { data: { id: EXP, estado: 'condicionado', token_documentos_expiracion: null, inmuebles: null, solicitantes: null, estudios }, error: null },
    ]);

    await getContextoDocumentosPublico('tok');

    expect(estudioListado()).toBe(TITULAR);
  });

  it('solo con el estudio del co-arrendatario no hay evaluacion del titular', async () => {
    queues.set('expedientes', [
      { data: { id: EXP, estado: 'condicionado', creado_por: null, inmuebles: null, solicitantes: null, estudios: [estudios[1]] }, error: null },
    ]);

    await expect(listarSoportes(EXP, 'analista-1', 'operador_analista')).rejects.toMatchObject({ errorCode: 'SIN_ESTUDIO' });
  });
});

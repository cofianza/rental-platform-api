import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Alcance de las fichas de solicitantes = la llave del índice único
// COALESCE(inmobiliaria_id, creado_por). Antes bastaba con haber creado la
// ficha: el ex-miembro la seguía leyendo y editando, y el titular no podía
// corregir la de un compañero. Mock de Supabase con colas por tabla + `ops`.
// ============================================================

const { ops, enqueue, queues, mockOrg, mockScope, mockPermitidos, chainFor } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'is', 'in', 'or', 'order', 'range']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  const enqueue = (table: string, ...items: Res[]) => {
    queues.set(table, [...(queues.get(table) ?? []), ...items]);
  };
  return {
    ops,
    enqueue,
    queues,
    mockOrg: vi.fn(async (_id: string): Promise<string | null> => null),
    mockScope: vi.fn(async (_id: string): Promise<{ kind: string }> => ({ kind: 'org' })),
    mockPermitidos: vi.fn((): string[] => []),
    chainFor,
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => chainFor(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/tenantScope', () => ({
  resolveInmobiliariaIdForPerfil: (id: string) => mockOrg(id),
  resolveVisibilityScope: (id: string) => mockScope(id),
  resolveAllowedExpedienteIds: async () => mockPermitidos(),
}));

import { listApplicants, updateApplicant, searchByDocument } from '../solicitantes.service';

const ors = () => ops.filter((o) => o.table === 'solicitantes' && o.method === 'or').map((o) => o.args[0]);

beforeEach(() => {
  ops.length = 0;
  queues.clear();
  mockOrg.mockReset();
  mockOrg.mockResolvedValue(null);
  mockScope.mockResolvedValue({ kind: 'org' });
  mockPermitidos.mockReturnValue([]);
});

describe('alcance de fichas', () => {
  it('sin organización (ex-miembro): solo las suyas que no son de ninguna org', async () => {
    await listApplicants({} as never, 'ex-1', 'inmobiliaria');
    expect(ors()).toEqual(['and(creado_por.eq.ex-1,inmobiliaria_id.is.null)']);
  });

  it('con organización: todas las de su org, no las que el perfil creó para otra', async () => {
    mockOrg.mockResolvedValue('org-B');
    await searchByDocument({ document_type: 'cc', document_number: '1' } as never, 'm-1', 'inmobiliaria');
    expect(ors()).toEqual(['inmobiliaria_id.eq.org-B']);
  });

  it('roles internos: sin filtro', async () => {
    await listApplicants({} as never, 'adm', 'administrador');
    expect(ors()).toEqual([]);
  });

  it('el ex-miembro no puede editar la ficha que registró para la agencia', async () => {
    enqueue('solicitantes', { data: null, error: { code: 'PGRST116' } });
    await expect(updateApplicant('s-1', { telefono: '3000000000' } as never, 'ex-1', undefined, 'inmobiliaria'))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(ors()).toEqual(['and(creado_por.eq.ex-1,inmobiliaria_id.is.null)']);
    expect(ops.some((o) => o.method === 'update')).toBe(false);
  });

  it('el titular corrige la ficha que registró otro miembro', async () => {
    mockOrg.mockResolvedValue('org-A');
    const ficha = { data: { id: 's-1', creado_por: 'otro', inmobiliaria_id: 'org-A' }, error: null };
    // lectura previa, UPDATE, re-lectura
    enqueue('solicitantes', ficha, { data: null, error: null }, ficha);
    await updateApplicant('s-1', { telefono: '3000000000' } as never, 'titular', undefined, 'inmobiliaria');
    expect(ors()[0]).toBe('inmobiliaria_id.eq.org-A');
    expect(ops.some((o) => o.table === 'solicitantes' && o.method === 'update')).toBe(true);
  });

  it('un miembro restringido no edita la ficha que registró otro si no es de sus estudios', async () => {
    mockOrg.mockResolvedValue('org-A');
    mockScope.mockResolvedValue({ kind: 'own' });
    mockPermitidos.mockReturnValue([]);
    enqueue('solicitantes', { data: { id: 's-1', creado_por: 'otro', inmobiliaria_id: 'org-A' }, error: null });
    await expect(
      updateApplicant('s-1', { telefono: '3000000000' } as never, 'restringido', undefined, 'inmobiliaria'),
    ).rejects.toMatchObject({ errorCode: 'FICHA_DE_OTRO_MIEMBRO' });
    expect(ops.some((o) => o.table === 'solicitantes' && o.method === 'update')).toBe(false);
  });
});

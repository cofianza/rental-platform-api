/**
 * La matrícula inmobiliaria del inmueble (la imprime el contrato V4) no está en
 * la RPC update_inmueble_con_cambios: se guarda aparte, con su fila de
 * historial, y NO viaja en p_data (la RPC la descartaría y dejaría un cambio
 * falso en el historial).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ops, rpcs, fila } = vi.hoisted(() => ({
  ops: [] as Array<{ tabla: string; op: string; row?: Record<string, unknown> }>,
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  fila: { current: {} as Record<string, unknown> },
}));

vi.mock('@/lib/supabase', () => {
  const chainFor = (tabla: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'in']) chain[m] = () => chain;
    chain.single = async () => ({ data: { ...fila.current }, error: null });
    chain.update = (row: Record<string, unknown>) => {
      ops.push({ tabla, op: 'update', row });
      return chain;
    };
    chain.insert = (row: Record<string, unknown>) => {
      ops.push({ tabla, op: 'insert', row });
      return chain;
    };
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
    return chain;
  };
  return {
    supabase: {
      from: (t: string) => chainFor(t),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn, args });
        return { data: fn === 'update_inmueble_con_cambios' ? { changes_count: 1 } : [], error: null };
      },
    },
  };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/tenantScope', () => ({
  assertInmuebleAccess: vi.fn(async () => undefined),
  resolveInmobiliariaIdForPerfil: vi.fn(async () => null),
  esOwnerDeOrg: vi.fn(), esMiembroSoloLectura: vi.fn(), resolveOrgMemberPerfilIds: vi.fn(),
  perfilEsDuenoDeInmueble: vi.fn(),
}));
vi.mock('../../notificaciones/notificaciones.service', () => ({ notificarYCorreo: vi.fn() }));
vi.mock('../../estudios/estudios-simultaneos.guard', () => ({ errorReservaPerdida: vi.fn() }));

import { updateInmueble } from '../inmuebles.service';

describe('updateInmueble — matrícula inmobiliaria', () => {
  beforeEach(() => {
    ops.length = 0;
    rpcs.length = 0;
    fila.current = { id: 'inm-1', propietario_id: 'p1', estado: 'disponible', matricula_inmobiliaria: null, perfiles: null };
  });

  it('se guarda aparte con su historial y no viaja a la RPC', async () => {
    await updateInmueble('inm-1', { barrio: 'Laureles', matricula_inmobiliaria: ' 001-123 ' } as never, 'u1', 'administrador');
    const rpc = rpcs.find((r) => r.fn === 'update_inmueble_con_cambios');
    expect(rpc?.args.p_data).toEqual({ barrio: 'Laureles' });
    expect(ops).toContainEqual({ tabla: 'inmuebles', op: 'update', row: { matricula_inmobiliaria: '001-123' } });
    expect(ops).toContainEqual({
      tabla: 'cambios_inmuebles',
      op: 'insert',
      row: expect.objectContaining({ campo: 'matricula_inmobiliaria', valor_anterior: null, valor_nuevo: '001-123' }),
    });
  });

  it('sin cambio real no escribe nada', async () => {
    fila.current.matricula_inmobiliaria = '001-123';
    await updateInmueble('inm-1', { matricula_inmobiliaria: '001-123' } as never, 'u1', 'administrador');
    expect(ops.filter((o) => o.row && 'matricula_inmobiliaria' in o.row)).toEqual([]);
    expect(ops.filter((o) => o.tabla === 'cambios_inmuebles')).toEqual([]);
  });
});

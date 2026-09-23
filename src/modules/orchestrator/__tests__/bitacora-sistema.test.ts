import { describe, it, expect, vi, beforeEach } from 'vitest';

// La bitácora (usuario_id uuid con FK a perfiles) perdía las consultas al buró
// que arrancan solas: el orquestador pasaba el id de `solicitantes` como
// usuario, y los caminos de sistema pasaban ''. Mock de Supabase con colas por
// tabla, como el resto de los módulos.

const { mockFrom, ops, queues, enqueue, mockEjecutarEstudio } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'eq', 'neq', 'in', 'order', 'limit'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
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
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockEjecutarEstudio: vi.fn(async (..._args: unknown[]) => undefined),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/config/env', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('../orchestrator.emails', () => ({}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({}));
vi.mock('@/modules/whatsapp', () => ({}));
vi.mock('@/lib/tenantScope', () => ({}));
vi.mock('@/modules/estudios/reglas-duras', () => ({}));
vi.mock('@/modules/estudios/pago.guard', () => ({
  leerSenalPagoEstudio: vi.fn(async () => 'pagado'),
  senalIndicaPagado: (s: string) => s === 'pagado',
  siguientePasoEstudio: vi.fn(),
  ESTADO_ESPERANDO_PAGO: 'pago_pendiente',
}));
vi.mock('@/modules/estudios/estudios.service', () => ({
  ejecutarEstudio: (...args: unknown[]) => mockEjecutarEstudio(...args),
}));

import { onHabeasDataAutorizado } from '../orchestrator.service';
import { logAudit } from '@/lib/auditLog';

const SOLICITANTE_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('consultas al buró que arrancan solas', () => {
  it('el orquestador ejecuta como sistema, no con el id de solicitantes', async () => {
    enqueue('estudios', { data: { id: 'est-1', estado: 'solicitado', datos_formulario: {}, pago_por: null }, error: null });
    enqueue('solicitantes', {
      data: { nombre: 'Ana', apellido: 'Pérez', tipo_documento: 'cc', numero_documento: '123', email: 'a@b.co', telefono: '' },
      error: null,
    });

    await onHabeasDataAutorizado({ expedienteId: 'exp-1', solicitanteId: SOLICITANTE_ID, autorizacionId: 'aut-1' });

    expect(mockEjecutarEstudio).toHaveBeenCalledWith('est-1', '');
  });

  it("logAudit escribe usuario_id NULL cuando la ejecución es de sistema ('')", async () => {
    logAudit({ usuarioId: '', accion: 'estudio_provider_executed', entidad: 'estudio', entidadId: 'est-1' });

    const insert = ops.find((o) => o.table === 'bitacora' && o.method === 'insert');
    expect((insert!.args[0] as { usuario_id: string | null }).usuario_id).toBeNull();
  });
});

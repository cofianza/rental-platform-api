import { describe, it, expect, vi, beforeEach } from 'vitest';

// Adenda de precios §3.1 (extinción de cupos vencidos) y §3.7 (alerta de saldo
// bajo). Mock de Supabase con colas por tabla, como creditos-estudios.cupo.

const { mockFrom, mockRpc, ops, queues, enqueue, mockNotificar } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'gt', 'lte', 'or', 'order', 'limit', 'gte'];
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
    mockRpc: vi.fn(),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockNotificar: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: mockRpc } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/modules/pagos/gateway', () => ({ getPaymentGateway: vi.fn() }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({ ALERTA_SALDO_MINIMO_CUPOS: 3 })) }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn(async () => undefined) }));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onEstudioPagado: vi.fn(async () => undefined) }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: mockNotificar }));
vi.mock('@/lib/tenantScope', () => ({
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
  resolveInmobiliariaIdForPerfil: vi.fn(async () => 'org-1'),
  resolveOrgOwnerPerfilIds: vi.fn(async () => ['owner-1', 'cotitular-1']),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cruzaUmbralSaldo,
  avisarSiSaldoBajo,
  extinguirCuposVencidos,
  liberarEstudioConCredito,
  asegurarReservaParaConsulta,
  armarDetallePaquetes,
} from '../creditos-estudios.service';

const SQL = readFileSync(join(__dirname, '../../../../supabase/migrations/20261003000201_extincion_cupos_vencidos.sql'), 'utf8');
const rpcs = (fn: string) => mockRpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);
const destinatarios = () => mockNotificar.mock.calls.map((c) => (c as unknown as [{ userId: string }])[0].userId);

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('§3.1: extinción de los cupos vencidos', () => {
  it('extingue cada lote vencido con saldo con la RPC y avisa una vez por organización al cruzar el umbral', async () => {
    enqueue('lotes_creditos_estudios', { data: [{ id: 'lote-a' }, { id: 'lote-b' }], error: null });
    mockRpc
      .mockResolvedValueOnce({ data: [{ lote_perfil_id: 'owner-1', extinguidos: 2, saldo_restante: 1 }], error: null })
      .mockResolvedValueOnce({ data: [{ lote_perfil_id: 'owner-1', extinguidos: 1, saldo_restante: 1 }], error: null });

    expect(await extinguirCuposVencidos()).toBe(3);

    expect(rpcs('extinguir_lote_vencido')).toEqual([{ p_lote_id: 'lote-a' }, { p_lote_id: 'lote-b' }]);
    // 1 + 3 extinguidos = 4 → 1: cruza el 3, un solo aviso por titular.
    expect(destinatarios()).toEqual(['owner-1', 'cotitular-1']);
    // Solo lee lotes: no escribe en tablas ni toca reservas o pagos.
    expect(ops.filter((o) => ['insert', 'update', 'delete'].includes(o.method))).toEqual([]);
    expect(ops.some((o) => o.table === 'movimientos_creditos_estudios' || o.table === 'pagos')).toBe(false);
  });

  it('es idempotente: si otro ciclo ya extinguió el lote, la RPC no devuelve fila y no hay aviso', async () => {
    enqueue('lotes_creditos_estudios', { data: [{ id: 'lote-a' }], error: null });
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    expect(await extinguirCuposVencidos()).toBe(0);
    expect(mockNotificar).not.toHaveBeenCalled();
  });

  it('la RPC solo actúa con el lote bloqueado, vencido y con saldo, y lo deja en 0 con un «expiracion»', () => {
    const cuerpo = SQL.slice(SQL.indexOf('FUNCTION public.extinguir_lote_vencido'), SQL.indexOf('REVOKE EXECUTE ON FUNCTION public.extinguir_lote_vencido'));
    expect(cuerpo).toMatch(/l\.vence_en <= NOW\(\)\s+AND l\.cantidad_disponible > 0\s+FOR UPDATE/);
    expect(cuerpo).toContain('IF NOT FOUND THEN RETURN; END IF;');
    expect(cuerpo).toContain("'expiracion', -v_lote.cantidad_disponible");
    // No toca reservas: ni movimientos de reserva ni pagos.
    expect(cuerpo).not.toMatch(/'reserva'|pago_id|UPDATE movimientos/);
    expect(SQL).toMatch(/REVOKE EXECUTE ON FUNCTION public\.extinguir_lote_vencido\(UUID\) FROM PUBLIC, anon/);
  });

  it('la reserva que vuelve a un lote vencido se extingue en el acto con un «expiracion»', () => {
    const cuerpo = SQL.slice(SQL.indexOf('FUNCTION public.liberar_reserva_credito'));
    expect(cuerpo).toMatch(/IF v_resultado = 'extinguido' THEN[\s\S]*'expiracion', -1/);
  });

  it('el detalle muestra como vencido (no agotado) el lote que el barrido dejó en 0, con su reserva abierta intacta', () => {
    const [fila] = armarDetallePaquetes(
      [{ id: 'lote-a', compra_id: null, cantidad_inicial: 5, cantidad_disponible: 0, vence_en: '2026-09-01T00:00:00Z', origen: 'compra', created_at: '2026-03-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' }],
      new Map(),
      [
        { lote_id: 'lote-a', tipo: 'reserva', cantidad: -1, pago_id: 'pago-1' },
        { lote_id: 'lote-a', tipo: 'expiracion', cantidad: -4, pago_id: null },
      ],
      new Date('2026-09-10T00:00:00Z'),
    );
    expect(fila).toMatchObject({ estado: 'vencido', reservados: 1, consumidos: 0, disponibles: 0 });
  });
});

describe('§3.7: alerta de saldo bajo', () => {
  it.each([
    [3, 2, true],
    [5, 1, true],
    [2, 1, false],
    [4, 3, false],
    [0, 0, false],
  ])('de %i a %i cruza el umbral 3: %s', (antes, despues, cruza) => {
    expect(cruzaUmbralSaldo(antes, despues, 3)).toBe(cruza);
  });

  it('avisa a los titulares activos con trato de usted y el enlace al saldo', async () => {
    await avisarSiSaldoBajo('owner-1', 3, 2);
    expect(destinatarios()).toEqual(['owner-1', 'cotitular-1']);
    const aviso = (mockNotificar.mock.calls[0] as unknown as [{ tipo: string; mensaje: string; link: string }])[0];
    expect(aviso).toMatchObject({ tipo: 'creditos.saldo_bajo', link: '/configuracion/creditos-estudios' });
    expect(aviso.mensaje).toContain('A su organización le quedan 2 cupos disponibles');
  });

  it('sin cruzar el umbral no avisa', async () => {
    await avisarSiSaldoBajo('owner-1', 2, 1);
    expect(mockNotificar).not.toHaveBeenCalled();
  });

  it('liberar con crédito avisa cuando la reserva deja el saldo por debajo de 3', async () => {
    enqueue('expedientes', { data: { id: 'exp-1', numero: 'EXP-1', estado: 'en_revision', inmueble_id: 'inm-1', solicitante_id: 'sol-1' }, error: null });
    enqueue('inmuebles', { data: { propietario_id: 'owner-1', inmobiliaria_id: 'org-1', direccion: 'Calle 1', ciudad: 'Bogotá' }, error: null });
    enqueue('compras_creditos_estudios', { data: [], error: null });
    enqueue('pagos', { data: [], error: null }, { data: { id: 'pago-1' }, error: null });
    enqueue('configuracion_sistema', { data: { valor: '80000' }, error: null });
    mockRpc.mockResolvedValueOnce({ data: [{ lote_id: 'lote-1', saldo_restante: 2 }], error: null });

    await liberarEstudioConCredito('exp-1', 'owner-1', 'gestor-1');
    expect(destinatarios()).toEqual(['owner-1', 'cotitular-1']);
  });

  it('volver a reservar para reintentar la consulta también avisa si cruza', async () => {
    enqueue('pagos', { data: { id: 'pago-1' }, error: null });
    mockRpc.mockResolvedValueOnce({ data: 'reservado', error: null });
    enqueue('movimientos_creditos_estudios', { data: { perfil_id: 'owner-1', saldo_resultante: 2 }, error: null });

    await asegurarReservaParaConsulta('exp-1', 'u-1');
    expect(destinatarios()).toEqual(['owner-1', 'cotitular-1']);
  });

  it('con saldo 0 dice que ya no quedan cupos', async () => {
    await avisarSiSaldoBajo('owner-1', 3, 0);
    const aviso = (mockNotificar.mock.calls[0] as unknown as [{ mensaje: string }])[0];
    expect(aviso.mensaje).toContain('ya no tiene cupos disponibles');
  });
});

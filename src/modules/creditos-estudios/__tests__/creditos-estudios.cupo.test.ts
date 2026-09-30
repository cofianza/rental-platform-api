import { describe, it, expect, vi, beforeEach } from 'vitest';

// Adenda de precios §2: el cupo se reserva al liberar el estudio, se consume
// solo con resultado de la consulta (c) y se libera en (a), (b) o §2.5. Mock
// de Supabase con colas por tabla, como creditos-estudios.saldo.

const { mockFrom, mockRpc, ops, queues, enqueue, mockTransition } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'gt', 'or', 'order', 'limit', 'gte', 'range'];
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
    mockTransition: vi.fn(async () => ({ pago: null, transitioned: true })),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: mockRpc } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/modules/pagos/gateway', () => ({ getPaymentGateway: vi.fn() }));
vi.mock('@/modules/pagos/pago-state-machine', () => ({ transitionPagoStateChecked: mockTransition }));
const { mockCerrarFallido } = vi.hoisted(() => ({ mockCerrarFallido: vi.fn(async () => undefined) }));
vi.mock('@/modules/pago-estudio/pago-estudio.service', () => ({ cerrarCobroEstudioFallido: mockCerrarFallido, getMontoEstudio: async () => 95_200 }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn(async () => undefined) }));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onEstudioPagado: vi.fn(async () => undefined) }));
vi.mock('@/modules/facturacion/facturacion.service', () => ({ crearFacturaDesdeCompraCreditos: vi.fn(async () => ({})) }));
vi.mock('@/lib/tenantScope', () => ({
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  liberarEstudioConCredito,
  registrarDesenlaceConsulta,
  asegurarReservaParaConsulta,
  getSaldoCreditos,
  armarDetallePaquetes,
  contarReservasAbiertas,
  desenlaceDeFalla,
  listMovimientos,
  NOTA_CONSUMO_CONFIRMADO,
} from '../creditos-estudios.service';

const updates = (table: string) => ops.filter((o) => o.table === table && o.method === 'update').map((o) => o.args[0]);
const inserts = (table: string) => ops.filter((o) => o.table === table && o.method === 'insert').map((o) => o.args[0]);

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  mockTransition.mockResolvedValue({ pago: null, transitioned: true });
});


const rpcs = (fn: string) => mockRpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);
const pagoCompletado = (id: string | null = 'pago-1') => enqueue('pagos', { data: id ? { id } : null, error: null });

describe('§2.1: al liberar el estudio el cupo se RESERVA, no se consume', () => {
  it('liberar reserva un cupo con la RPC y lo dice en la línea de tiempo', async () => {
    enqueue('expedientes', { data: { id: 'exp-1', numero: 'EXP-1', estado: 'en_revision', inmueble_id: 'inm-1', solicitante_id: 'sol-1' }, error: null });
    enqueue('inmuebles', { data: { propietario_id: 'owner-1', inmobiliaria_id: 'org-1', direccion: 'Calle 1', ciudad: 'Bogotá' }, error: null });
    enqueue('compras_creditos_estudios', { data: [], error: null });
    enqueue('pagos', { data: [], error: null }, { data: { id: 'pago-1' }, error: null });
    mockRpc.mockResolvedValueOnce({ data: [{ lote_id: 'lote-1', saldo_restante: 4 }], error: null });

    expect(await liberarEstudioConCredito('exp-1', 'owner-1', 'gestor-1')).toMatchObject({ pago_id: 'pago-1', lote_id: 'lote-1' });

    expect(rpcs('consume_credito_estudio')[0]).toMatchObject({ p_perfil_id: 'owner-1', p_pago_id: 'pago-1' });
    const tl = inserts('eventos_timeline')[0] as { descripcion: string };
    expect(tl.descripcion).toContain('cupo reservado');
  });

  it('la RPC de la migración registra el movimiento como «reserva» (no «consumo»)', () => {
    const sql = readFileSync(join(__dirname, '../../../../supabase/migrations/20261003000001_consumo_cupo_reserva.sql'), 'utf8');
    const cuerpo = sql.slice(sql.indexOf('FUNCTION public.consume_credito_estudio'), sql.indexOf('REVOKE EXECUTE ON FUNCTION public.consume_credito_estudio'));
    expect(cuerpo).toContain("'reserva', -1");
    expect(cuerpo).not.toContain("'consumo', -1");
  });
});

describe('§2.2: tres desenlaces, solo (c) consume', () => {
  it('(c) confirma el consumo con el estudio y la referencia del proveedor, y guarda el desenlace', async () => {
    pagoCompletado();
    mockRpc.mockResolvedValueOnce({ data: 'consumido', error: null });

    await registrarDesenlaceConsulta({ estudioId: 'est-1', expedienteId: 'exp-1', desenlace: 'c_resultado', referencia: 'TU-123', usuarioId: 'u-1' });

    expect(updates('estudios')).toEqual([{ desenlace_consulta: 'c_resultado' }]);
    expect(rpcs('confirmar_consumo_credito')).toEqual([{ p_pago_id: 'pago-1', p_estudio_id: 'est-1', p_referencia: 'TU-123', p_usuario_id: 'u-1' }]);
    expect(rpcs('liberar_reserva_credito')).toEqual([]);
  });

  it.each([
    ['a_no_existe', 'a'],
    ['b_falla', 'b'],
  ] as const)('(%s) libera la reserva al mismo lote con literal %s y lo deja en la línea de tiempo', async (desenlace, literal) => {
    pagoCompletado();
    enqueue('estudios', { data: null, error: null }, { data: [{ id: 'est-1', estado: 'fallido', referencia_proveedor: null, desenlace_consulta: desenlace }], error: null });
    mockRpc.mockResolvedValueOnce({ data: 'liberado', error: null });

    await registrarDesenlaceConsulta({ estudioId: 'est-1', expedienteId: 'exp-1', desenlace });

    expect(updates('estudios')).toEqual([{ desenlace_consulta: desenlace }]);
    expect(rpcs('liberar_reserva_credito')[0]).toMatchObject({ p_pago_id: 'pago-1', p_literal: literal, p_estudio_id: 'est-1' });
    expect(rpcs('confirmar_consumo_credito')).toEqual([]);
    expect(inserts('eventos_timeline')[0]).toMatchObject({ metadata: expect.objectContaining({ evento: 'cupo_liberado', literal }) });
  });

  it('§2.5: sin llegar a la consulta (sin autorización) libera con literal 2.5 y no guarda desenlace', async () => {
    pagoCompletado();
    enqueue('estudios', { data: [{ id: 'est-1', estado: 'fallido', referencia_proveedor: null, desenlace_consulta: null }], error: null });
    mockRpc.mockResolvedValueOnce({ data: 'liberado', error: null });

    await registrarDesenlaceConsulta({ estudioId: 'est-1', expedienteId: 'exp-1', desenlace: null });

    expect(updates('estudios')).toEqual([]);
    expect(rpcs('liberar_reserva_credito')[0]).toMatchObject({ p_literal: '2.5' });
  });

  it('un lote vencido: la liberación extingue el cupo y lo dice', async () => {
    pagoCompletado();
    enqueue('estudios', { data: null, error: null }, { data: [], error: null });
    mockRpc.mockResolvedValueOnce({ data: 'extinguido', error: null });

    await registrarDesenlaceConsulta({ estudioId: 'est-1', expedienteId: 'exp-1', desenlace: 'b_falla' });

    expect((inserts('eventos_timeline')[0] as { descripcion: string }).descripcion).toContain('se extingue');
  });

  it('M2: si el cupo cubrió saldo en contra de un contracargo (a_deuda), no dice que volvió al saldo', async () => {
    pagoCompletado();
    enqueue('estudios', { data: null, error: null }, { data: [], error: null });
    mockRpc.mockResolvedValueOnce({ data: 'a_deuda', error: null });

    await registrarDesenlaceConsulta({ estudioId: 'est-1', expedienteId: 'exp-1', desenlace: 'b_falla' });

    const { descripcion } = inserts('eventos_timeline')[0] as { descripcion: string };
    expect(descripcion).toContain('saldo en contra');
    expect(descripcion).not.toContain('volvió al saldo');
  });

  it('sin pago completado de la evaluación: solo guarda el desenlace', async () => {
    pagoCompletado(null);

    await registrarDesenlaceConsulta({ estudioId: 'est-1', expedienteId: 'exp-1', desenlace: 'b_falla' });

    expect(updates('estudios')).toEqual([{ desenlace_consulta: 'b_falla' }]);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('decisiones 2-4: cómo se clasifica una consulta fallida', () => {
  const f = (o: Partial<Parameters<typeof desenlaceDeFalla>[0]>) =>
    desenlaceDeFalla({ bloqueadoPorAutorizacion: false, apellidoNoCoincide: false, documentoNoEncontrado: false, ...o });
  it('documento inexistente o mal formado → (a)', () => expect(f({ documentoNoEncontrado: true })).toBe('a_no_existe'));
  it('apellido que no coincide → (b), aunque el mensaje hable del documento', () =>
    expect(f({ apellidoNoCoincide: true, documentoNoEncontrado: true })).toBe('b_falla'));
  it('caída, error o configuración → (b)', () => expect(f({})).toBe('b_falla'));
  it('sin autorización no se llegó a consultar → §2.5 (null)', () => expect(f({ bloqueadoPorAutorizacion: true })).toBeNull());
});

describe('decisión 1: un cupo ampara el estudio completo (cascada, re-consulta, co-arrendatario)', () => {
  it('la segunda confirmación del mismo pago no consume otro cupo (la RPC responde ya_consumido)', async () => {
    pagoCompletado();
    pagoCompletado();
    mockRpc.mockResolvedValueOnce({ data: 'consumido', error: null }).mockResolvedValueOnce({ data: 'ya_consumido', error: null });

    await registrarDesenlaceConsulta({ estudioId: 'est-1', expedienteId: 'exp-1', desenlace: 'c_resultado', referencia: 'DC-1' });
    await registrarDesenlaceConsulta({ estudioId: 'est-1', expedienteId: 'exp-1', desenlace: 'c_resultado', referencia: 'TU-2' });

    expect(rpcs('confirmar_consumo_credito')).toHaveLength(2);
    expect(rpcs('consume_credito_estudio')).toEqual([]);
    const sql = readFileSync(join(__dirname, '../../../../supabase/migrations/20261003000001_consumo_cupo_reserva.sql'), 'utf8');
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS uq_movimientos_creditos_consumo_pago\s+ON movimientos_creditos_estudios\(pago_id\) WHERE literal = 'c'/);
  });

  it('si otro estudio del expediente ya dio resultado, la falla del co-arrendatario no libera el cupo', async () => {
    pagoCompletado();
    enqueue('estudios', { data: null, error: null }, {
      data: [
        { id: 'est-titular', estado: 'completado', referencia_proveedor: 'TU-1', desenlace_consulta: 'c_resultado' },
        { id: 'est-coarr', estado: 'fallido', referencia_proveedor: null, desenlace_consulta: 'b_falla' },
      ],
      error: null,
    });

    await registrarDesenlaceConsulta({ estudioId: 'est-coarr', expedienteId: 'exp-1', desenlace: 'b_falla' });

    expect(rpcs('liberar_reserva_credito')).toEqual([]);
  });
});

describe('decisión 5: falla y reintento con resultado = un solo cupo', () => {
  it('antes de reintentar se vuelve a reservar el cupo liberado', async () => {
    pagoCompletado();
    mockRpc.mockResolvedValueOnce({ data: 'reservado', error: null });

    await asegurarReservaParaConsulta('exp-1', 'u-1');

    expect(rpcs('reactivar_reserva_credito')).toEqual([{ p_pago_id: 'pago-1', p_usuario_id: 'u-1' }]);
  });

  it('sin cupos para volver a reservar, no se consulta', async () => {
    pagoCompletado();
    mockRpc.mockResolvedValueOnce({ data: 'sin_saldo', error: null });

    await expect(asegurarReservaParaConsulta('exp-1', 'u-1')).rejects.toMatchObject({ errorCode: 'SIN_SALDO_CREDITOS' });
  });

  it('ejecución del sistema (userId vacío): la RPC recibe p_usuario_id null, no \'\' (uuid)', async () => {
    pagoCompletado();
    mockRpc.mockResolvedValueOnce({ data: 'no_aplica', error: null });

    await asegurarReservaParaConsulta('exp-1', '');

    expect(rpcs('reactivar_reserva_credito')).toEqual([{ p_pago_id: 'pago-1', p_usuario_id: null }]);
  });

  it('ejecución del sistema: confirmar y liberar el cupo tampoco mandan \'\' como usuario', async () => {
    pagoCompletado();
    mockRpc.mockResolvedValueOnce({ data: 'consumido', error: null });
    await registrarDesenlaceConsulta({ estudioId: 'est-1', expedienteId: 'exp-1', desenlace: 'c_resultado', referencia: 'TU-1', usuarioId: '' });
    expect(rpcs('confirmar_consumo_credito')[0]).toMatchObject({ p_usuario_id: null });

    pagoCompletado();
    enqueue('estudios', { data: [], error: null });
    mockRpc.mockResolvedValueOnce({ data: 'liberado', error: null });
    await registrarDesenlaceConsulta({ estudioId: 'est-1', expedienteId: 'exp-1', desenlace: 'b_falla', usuarioId: '' });
    expect(rpcs('liberar_reserva_credito')[0]).toMatchObject({ p_usuario_id: null });
  });

  it('un pago de pasarela no toca cupos', async () => {
    pagoCompletado(null);
    await asegurarReservaParaConsulta('exp-1', 'u-1');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('saldo: el disponible excluye las reservas', () => {
  it('contarReservasAbiertas: solo cuentan los pagos cuyo último movimiento es la reserva', () => {
    expect(
      contarReservasAbiertas([
        { pago_id: 'p1', tipo: 'reserva' },
        { pago_id: 'p2', tipo: 'reserva' },
        { pago_id: 'p2', tipo: 'consumo' },
        { pago_id: 'p3', tipo: 'reserva' },
        { pago_id: 'p3', tipo: 'liberacion' },
        { pago_id: 'p4', tipo: 'reserva' },
        { pago_id: 'p4', tipo: 'liberacion' },
        { pago_id: 'p4', tipo: 'reserva' }, // reintento
        { pago_id: null, tipo: 'ajuste' },
      ]),
    ).toBe(2);
  });

  it('getSaldoCreditos: saldo_total sale de los lotes (ya sin las reservas) y saldo_reservado aparte', async () => {
    enqueue('lotes_creditos_estudios', {
      data: [{ id: 'l1', cantidad_disponible: 3, cantidad_inicial: 5, vence_en: null, origen: 'compra', created_at: '2026-09-01T00:00:00Z' }],
      error: null,
    });
    enqueue('compras_creditos_estudios', { data: [], error: null });
    enqueue('movimientos_creditos_estudios', {
      data: [
        { pago_id: 'p1', tipo: 'reserva' },
        { pago_id: 'p2', tipo: 'reserva' },
        { pago_id: 'p2', tipo: 'consumo' },
      ],
      error: null,
    });

    const saldo = await getSaldoCreditos('owner-1');

    expect(saldo).toMatchObject({ saldo_total: 3, saldo_efectivo: 3, saldo_reservado: 1 });
  });

  it('detalle por paquete: separa consumidos, reservados y lo que volvió', () => {
    const ahora = new Date('2026-09-29T12:00:00Z');
    const detalle = armarDetallePaquetes(
      [{ id: 'l1', compra_id: null, cantidad_inicial: 5, cantidad_disponible: 3, vence_en: null, origen: 'compra', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-28T00:00:00Z' }],
      new Map(),
      [
        { lote_id: 'l1', tipo: 'reserva', cantidad: -1, pago_id: 'p1' },
        { lote_id: 'l1', tipo: 'consumo', cantidad: 0, pago_id: 'p1' }, // (c)
        { lote_id: 'l1', tipo: 'reserva', cantidad: -1, pago_id: 'p2' }, // abierta
        { lote_id: 'l1', tipo: 'reserva', cantidad: -1, pago_id: 'p3' },
        { lote_id: 'l1', tipo: 'liberacion', cantidad: 1, pago_id: 'p3' }, // (a)
      ],
      ahora,
    );
    expect(detalle[0]).toMatchObject({ comprados: 5, consumidos: 1, reservados: 1, disponibles: 3 });
  });
});

describe('historial de créditos: notas que ve la inmobiliaria', () => {
  it('sin referencias internas y con la confirmación del consumo explicada (cantidad 0)', async () => {
    enqueue('movimientos_creditos_estudios', {
      data: [
        // Escritas por las RPC en SQL y por filas de antes del cambio.
        { id: 'm1', tipo: 'consumo', cantidad: 0, literal: 'c', notas: 'Consumo: la consulta a centrales produjo resultado (Adenda de precios §2.2 c)' },
        { id: 'm2', tipo: 'liberacion', cantidad: 1, literal: 'a', notas: 'La persona no existe en la central consultada (Adenda de precios §2.2 a): el cupo no se consume.' },
        { id: 'm3', tipo: 'liberacion', cantidad: 1, literal: '2.5', notas: 'El prospecto no autorizó dentro del plazo (Adenda de precios §2.5; Flujo §14: 15 días).' },
        { id: 'm4', tipo: 'ajuste', cantidad: -2, notas: 'Vencimiento del paquete: los cupos no usados se extinguen (Adenda de precios §3.1).' },
        { id: 'm5', tipo: 'compra', cantidad: 5, notas: 'Compra de 5 estudios — sesion cs_test_123' },
        { id: 'm6', tipo: 'reserva', cantidad: -1, notas: null },
      ],
      error: null,
      count: 6,
    });

    const { movimientos } = await listMovimientos('perfil-1', {});

    expect(movimientos.map((m) => m.notas)).toEqual([
      NOTA_CONSUMO_CONFIRMADO,
      'La persona no existe en la central consultada: el cupo no se consume.',
      'El prospecto no autorizó dentro del plazo.',
      'Vencimiento del paquete: los cupos no usados se extinguen.',
      'Compra de 5 estudios.',
      null,
    ]);
    expect(NOTA_CONSUMO_CONFIRMADO).toBe('Consumo confirmado: la consulta dio resultado (el cupo ya estaba reservado).');
  });
});

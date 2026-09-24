import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// P28: con WHATSAPP_MORA_PLANTILLAS_V2 el WhatsApp de mora dice a dónde mandar
// el comprobante (al arrendador por su WhatsApp de recaudo; en Fase 3, al
// correo de soporte). Apagada, siguen las v1 que Meta ya aprobó.
// ============================================================

const { mockFrom, enqueue, resetQueues, mockEnviarTemplate, mockEnv, mockContacto } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'in', 'order', 'limit']) chain[m] = () => chain;
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    resetQueues: () => queues.clear(),
    mockEnviarTemplate: vi.fn(async (..._a: unknown[]) => 'aceptado'),
    mockEnv: { WHATSAPP_MORA_PLANTILLAS_V2: true },
    mockContacto: vi.fn(async (..._a: unknown[]) => ({ nombre: 'Inmobiliaria Norte', whatsapp: '+573015556677' as string | null })),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/lib/companyConfig', () => ({ getCompany: async () => ({ email: 'hola@cofianza.co' }) }));
vi.mock('../../whatsapp', () => ({ enviarTemplate: mockEnviarTemplate }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn() }));
vi.mock('@/modules/users/users.service', () => ({ listOperators: async () => [] }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(),
  resolveAllowedExpedienteIds: async () => null,
  resolvePerfilCanonicoDeInmueble: async () => 'titular1',
  resolveContactoDueno: mockContacto,
}));

import { escalarMora } from '../moras.service';

/** Escalar como Cofianza desde `estado`; encola lectura, update, horario y detalle. */
function prepararEscalado(estado: 'fase_1' | 'fase_2') {
  enqueue('moras_tickets',
    {
      data: {
        id: 'm1', ticket_numero: 'MOR-1', estado, expediente_id: 'exp1', reportado_por: 'u1',
        reportado_at: '2026-09-01T12:00:00Z', fecha_vencimiento_canon: '2026-09-05',
        inquilino_telefono: '3001112233', inquilino_nombre: 'Ana Pérez', inmueble_direccion: 'Cra 7', monto_mora: 1_500_000,
      },
      error: null,
    },
    { data: [{ id: 'm1' }], error: null }, // update de fase
    { data: [], error: null }, // moras del teléfono: sin gestión previa
    { data: null, error: null }, // whatsapp_programado_para
    { data: { id: 'm1' }, error: null }, // getMoraById
  );
  enqueue('expedientes', { data: { inmuebles: { propietario_id: 'p1', inmobiliaria_id: 'org1' } }, error: null });
}
const envio = () => mockEnviarTemplate.mock.calls[0][0] as { template: string; variables: string[] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T10:00:00-05:00')); // martes, en horario de cobranza
  resetQueues();
  mockEnviarTemplate.mockClear();
  mockContacto.mockClear();
  mockEnv.WHATSAPP_MORA_PLANTILLAS_V2 = true;
});
afterEach(() => vi.useRealTimers());

describe('plantillas de mora v2 (P28)', () => {
  it('Fase 2: el comprobante va al arrendador por su WhatsApp de recaudo', async () => {
    prepararEscalado('fase_1');
    await escalarMora('m1', {}, 'op', 'operador_analista');
    expect(envio().template).toBe('MORA_FASE_2_V2');
    expect(envio().variables.slice(4)).toEqual(['Inmobiliaria Norte', '+573015556677']);
  });

  it('Fase 3: el comprobante va al correo de soporte de Cofianza', async () => {
    prepararEscalado('fase_2');
    await escalarMora('m1', {}, 'op', 'operador_analista');
    expect(envio().template).toBe('MORA_FASE_3_V2');
    expect(envio().variables[4]).toBe('hola@cofianza.co');
  });

  it('sin WhatsApp del arrendador, o con la variable apagada, sigue la v1', async () => {
    mockContacto.mockResolvedValueOnce({ nombre: 'Juan Pérez', whatsapp: null });
    prepararEscalado('fase_1');
    await escalarMora('m1', {}, 'op', 'operador_analista');
    expect(envio()).toMatchObject({ template: 'MORA_FASE_2' });
    expect(envio().variables).toHaveLength(4);

    mockEnviarTemplate.mockClear();
    mockEnv.WHATSAPP_MORA_PLANTILLAS_V2 = false;
    prepararEscalado('fase_1');
    await escalarMora('m1', {}, 'op', 'operador_analista');
    expect(envio()).toMatchObject({ template: 'MORA_FASE_2' });
    expect(mockContacto).toHaveBeenCalledTimes(1); // apagada, ni lo busca
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// P34 por «Registrar resultado»: cuando un analista rechaza a mano, el banner
// del gestor muestra el motivo que escribió para él (no «La evaluación
// crediticia del titular fue rechazada…») y al prospecto le llega el texto
// neutro, no el de «mejora tu perfil crediticio». Colas de Supabase por tabla.

const { ops, queues, enqueue, mockRechazado } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  return {
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockRechazado: vi.fn(async (..._a: unknown[]) => undefined),
  };
});

vi.mock('@/lib/supabase', () => {
  const next = (t: string) => queues.get(t)?.shift() ?? { data: null, error: null };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'in', 'order', 'limit']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.single = chain.maybeSingle = async () => next(table);
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(next(table)).then(res, rej);
    return chain;
  };
  return { supabase: { from } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/config/env', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('../orchestrator.emails', () => ({ sendEstudioRechazadoEmail: mockRechazado }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(async () => undefined),
  notificarResponsableExpediente: vi.fn(async () => undefined),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ resolveNombreDueno: vi.fn() }));
vi.mock('@/modules/estudios/reglas-duras', () => ({
  inferirReglasDurasDesdeMotivo: () => [],
  motivoProspectoReglasDuras: () => 'regla dura',
}));
vi.mock('@/modules/inmuebles/inmuebles.service', () => ({ liberarReservaDeExpediente: vi.fn(async () => undefined) }));

import { onEstudioCompletado } from '../orchestrator.service';
import { MOTIVO_PROSPECTO_DECISION_COFIANZA } from '@/modules/estudios/rutas-resultado';

function encolarRechazo() {
  enqueue(
    'expedientes',
    { data: { id: 'exp-1', numero: 'EXP-1', inmueble_id: 'inm-1', solicitante_id: 'sol-1', creado_por: 'gestor-1' }, error: null },
    { data: { estado: 'en_revision' }, error: null }, // ya en revisión: no transiciona
    { data: { estado: 'en_revision' }, error: null }, // → rechazado
  );
  enqueue('solicitantes', { data: { nombre: 'Ana', apellido: 'Pérez', email: 'ana@correo.co', telefono: null }, error: null });
  enqueue('inmuebles', { data: { id: 'inm-1', direccion: 'Calle 1', ciudad: 'Cali', valor_arriendo: 1, propietario_id: 'dueno-1' }, error: null });
}

const motivoDelBanner = () =>
  ops
    .filter((o) => o.table === 'expedientes' && o.method === 'update')
    .map((o) => (o.args[0] as { motivo_rechazo?: string }).motivo_rechazo)
    .find(Boolean);

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('rechazo registrado por un analista', () => {
  it('el banner lleva su motivo para el gestor y el prospecto recibe el texto neutro', async () => {
    encolarRechazo();
    await onEstudioCompletado({
      estudioId: 'est-1', expedienteId: 'exp-1', resultado: 'rechazado', score: null, solicitanteId: '',
      motivoAnalista: 'No cumple la política de Cofianza.',
    });

    expect(motivoDelBanner()).toBe('No cumple la política de Cofianza.');
    expect(mockRechazado).toHaveBeenCalledWith(expect.objectContaining({ motivoGeneral: MOTIVO_PROSPECTO_DECISION_COFIANZA }));
  });

  it('el rechazo automático del buró sigue como siempre', async () => {
    encolarRechazo();
    await onEstudioCompletado({ estudioId: 'est-1', expedienteId: 'exp-1', resultado: 'rechazado', score: 380, solicitanteId: '' });

    expect(motivoDelBanner()).toMatch(/evaluación crediticia del titular/);
    expect(mockRechazado).toHaveBeenCalledWith(expect.objectContaining({ motivoGeneral: null }));
  });
});

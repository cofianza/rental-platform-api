import { describe, it, expect, vi, beforeEach } from 'vitest';

// generarContrato reserva el inmueble y avisa a los demás candidatos: sin
// plantilla no se reserva, y si el contrato no llega a guardarse la reserva que
// hizo esta llamada se suelta y nadie recibe el aviso.
const { queues, enqueue, mockReservar, mockLiberar, mockAvisar } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  return {
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockReservar: vi.fn(),
    mockLiberar: vi.fn(async () => true),
    mockAvisar: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/supabase', () => {
  const next = (t: string) => queues.get(t)?.shift() ?? { data: null, error: null };
  const from = (t: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'or', 'order', 'limit', 'gte', 'lte']) {
      chain[m] = () => chain;
    }
    chain.single = chain.maybeSingle = async () => next(t);
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(next(t)).then(res, rej);
    return chain;
  };
  return { supabase: { from, rpc: vi.fn(async () => ({ data: null, error: null })), storage: { from: vi.fn() } } };
});
vi.mock('@/config', () => ({ env: { CONTRATOS_V3_ENABLED: false, RESEND_API_KEY: 're_test' } }));
vi.mock('@/config/env', () => ({ env: { CONTRATOS_V3_ENABLED: false, RESEND_API_KEY: 're_test' } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', async (orig) => ({ ...(await orig<typeof import('@/lib/auditLog')>()), logAudit: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(async () => undefined),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn(), findPerfilIdByEmail: vi.fn() }));
vi.mock('@/modules/perfil-arrendador/perfil-arrendador.service', () => ({
  checkPerfilCompletitud: vi.fn(async () => ({ completo: true, faltantes: [] })),
}));
vi.mock('@/modules/inmuebles/inmuebles.service', () => ({
  reservarInmuebleParaContrato: (...a: unknown[]) => mockReservar(...a),
  liberarReservaDeExpediente: (...a: unknown[]) => mockLiberar(...a),
}));
vi.mock('@/modules/estudios/reserva-inmueble.notificaciones', () => ({
  avisarCandidatosDeReserva: (...a: unknown[]) => mockAvisar(...a),
}));
vi.mock('../contratos.pdf', () => ({ generateContractPdf: vi.fn(async () => Buffer.from('pdf')) }));

import { generarContrato } from '../contratos.service';
import type { GenerarContratoInput } from '../contratos.schema';

const EXP = 'exp-1';
const generar = () => generarContrato(EXP, {} as GenerarContratoInput, 'admin-1', undefined, 'administrador');

beforeEach(() => {
  queues.clear();
  vi.clearAllMocks();
  mockReservar.mockResolvedValue({
    reservado: true,
    ya_reservado: false,
    afectados: [{ expediente_id: 'exp-2', expediente_numero: 'EXP-2', solicitante_id: 's2', solicitante_nombre: 'B', solicitante_apellido: null, solicitante_email: 'b@x.co' }],
  });
  enqueue('expedientes', {
    data: {
      id: EXP,
      numero: 'EXP-1',
      estado: 'aprobado',
      inmueble_id: 'inm-1',
      solicitante_id: 'sol-1',
      inmuebles: { id: 'inm-1', direccion: 'Calle 1', ciudad: 'Medellín', valor_arriendo: 2_000_000, propietario_id: 'prop-1', inmobiliaria_id: null, uso: 'vivienda' },
      solicitantes: { id: 'sol-1', nombre: 'Juan', apellido: 'Pérez', tipo_documento: 'cc', numero_documento: '1' },
    },
    error: null,
  });
  enqueue('perfiles', { data: { id: 'prop-1', nombre: 'Ana', apellido: 'Gómez', rol: 'propietario' }, error: null });
  enqueue('contratos', { data: [], error: null }); // sin contrato V3
});

describe('generarContrato y la reserva del inmueble', () => {
  it('sin plantilla activa no reserva ni avisa', async () => {
    await expect(generar()).rejects.toMatchObject({ errorCode: 'PLANTILLA_NOT_FOUND' });
    expect(mockReservar).not.toHaveBeenCalled();
    expect(mockAvisar).not.toHaveBeenCalled();
  });

  it('si el insert falla, suelta la reserva que hizo y no avisa a los demás', async () => {
    enqueue('plantillas_contrato', {
      data: { id: 'pl-1', nombre: 'Legacy', contenido: 'Texto', contenido_html: null, variables: [], activa: true, version: 1 },
      error: null,
    });
    enqueue('contratos', { data: null, error: { message: 'boom' } });

    await expect(generar()).rejects.toMatchObject({ errorCode: 'CONTRATO_CREATE_ERROR' });
    expect(mockLiberar).toHaveBeenCalledWith(EXP);
    expect(mockAvisar).not.toHaveBeenCalled();
  });

  it('si la reserva ya era de este estudio (reintento), no la suelta', async () => {
    mockReservar.mockResolvedValue({ reservado: false, ya_reservado: true, afectados: [] });
    enqueue('plantillas_contrato', {
      data: { id: 'pl-1', nombre: 'Legacy', contenido: 'Texto', contenido_html: null, variables: [], activa: true, version: 1 },
      error: null,
    });
    enqueue('contratos', { data: null, error: { message: 'boom' } });

    await expect(generar()).rejects.toMatchObject({ errorCode: 'CONTRATO_CREATE_ERROR' });
    expect(mockLiberar).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Lo que el TITULAR (rol solicitante) recibe de los estudios de su expediente:
// ni el estudio de su co-arrendatario (otra persona, Ley 1266) ni el crudo del
// buro de su propio estudio (trae el score que la Politica §11 le oculta).
// Mismo mock de Supabase que coarrendatarios: builder encadenable + colas POR
// TABLA y `ops` para afirmar el filtro de la consulta.
// ============================================================

const { mockEnv, ops, queues, enqueue, mockFrom } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'eq', 'neq', 'is', 'in', 'or', 'gte', 'order', 'limit', 'range'];
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
    // Flags *_ENABLED / MOTOR_* apagados; lo demas un string.
    mockEnv: new Proxy({} as Record<string, unknown>, {
      get: (_t, k) => (typeof k === 'string' && (k.endsWith('_ENABLED') || k.startsWith('MOTOR_')) ? false : 'x'),
    }),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockFrom: vi.fn((table: string) => chainFor(table)),
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/email', () => ({ sendEstudioFormEmail: vi.fn() }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({ DIAS_EXPIRACION_ESTUDIO: 30 })) }));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: vi.fn(),
  perfilEsDuenoDeInmueble: vi.fn(),
  assertExpedienteAccess: vi.fn(async () => undefined),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(),
  findPerfilIdByEmail: vi.fn(),
  notificarResponsableExpediente: vi.fn(),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));

import { getEstudioById, listEstudios, getCertificadoViewUrl, buscarEstudioVigentePorDocumento } from '../estudios.service';
import { descargarCertificado } from '../certificado.service';
import { tarifasDelEstudio } from '../tarifa-override.service';
import { contrasteIngresoProspecto } from '@/modules/autorizaciones/ingreso-declarado';
import { resolveAllowedExpedienteIds } from '@/lib/tenantScope';
import { getCalibracion } from '@/lib/calibracion';

const fila = (tipo: string) => ({
  id: 'est-1',
  expediente_id: 'exp-1',
  tipo,
  estado: 'completado',
  resultado: 'aprobado',
  score: 780,
  respuesta_proveedor: { score: 780, obligaciones: [] },
  token_self_service: 'tok',
  datos_formulario: { numero_documento: '123' },
});

beforeEach(() => {
  queues.clear();
  ops.length = 0;
});

describe('estudios del expediente vistos por el titular', () => {
  it('el estudio del co-arrendatario le da 404 por id', async () => {
    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    await expect(getEstudioById('est-1', 'u-1', 'solicitante')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('en su propio estudio no le viajan el crudo del buro ni el token; si su cedula', async () => {
    enqueue('estudios', { data: fila('individual'), error: null });
    const e = (await getEstudioById('est-1', 'u-1', 'solicitante')) as Record<string, unknown>;
    expect(e.respuesta_proveedor).toBeNull();
    expect(e.token_self_service).toBeNull();
    expect(e.score).toBeNull();
    expect(e.datos_formulario).toEqual({ numero_documento: '123' });
  });

  it('el gestor sigue viendo el estudio del co-arrendatario completo', async () => {
    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    const e = (await getEstudioById('est-1', 'u-1', 'operador_analista')) as Record<string, unknown>;
    expect(e.respuesta_proveedor).toEqual({ score: 780, obligaciones: [] });
  });

  it('el listado del titular excluye el del co-arrendatario en la consulta (el total sale bien)', async () => {
    enqueue('expedientes', { data: { id: 'exp-1' }, error: null });
    await listEstudios('exp-1', { page: 1, limit: 10 } as never, 'u-1', 'solicitante');
    expect(ops).toContainEqual({ table: 'estudios', method: 'neq', args: ['tipo', 'con_coarrendatario'] });

    ops.length = 0;
    enqueue('expedientes', { data: { id: 'exp-1' }, error: null });
    await listEstudios('exp-1', { page: 1, limit: 10 } as never, 'u-2', 'inmobiliaria');
    expect(ops.some((o) => o.method === 'neq')).toBe(false);
  });
});

describe('las demas rutas por id que el titular alcanza', () => {
  // El 404 del guard, no el de "no hay certificado".
  const OCULTO = { statusCode: 404, errorCode: 'ESTUDIO_NOT_FOUND' };
  // El id le llega por GET /expedientes/:id/coarrendatario y por la notificacion.
  it('certificado (url y descarga) y tarifa del estudio del co-arrendatario: 404', async () => {
    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    await expect(getCertificadoViewUrl('est-1', 'u-1', 'solicitante')).rejects.toMatchObject(OCULTO);

    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    await expect(descargarCertificado('est-1', 'u-1', 'solicitante')).rejects.toMatchObject(OCULTO);
    expect(ops.some((o) => o.table === 'estudios_certificados')).toBe(false);

    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    await expect(tarifasDelEstudio('est-1', 'u-1', 'solicitante')).rejects.toMatchObject(OCULTO);
  });

  it('el gestor si baja el certificado del co-arrendatario', async () => {
    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    // Pasa el guard y llega a buscar el certificado (no hay: 404 de certificado).
    await expect(descargarCertificado('est-1', 'u-1', 'operador_analista')).rejects.toMatchObject({
      errorCode: 'CERTIFICADO_NOT_FOUND',
    });
  });

  it('/vigente con la cedula del co-arrendatario no le trae su estudio', async () => {
    vi.mocked(resolveAllowedExpedienteIds).mockResolvedValueOnce(['exp-1']);
    vi.mocked(getCalibracion).mockResolvedValueOnce({ VIGENCIA_CRC_DIAS: 60 } as never);
    await buscarEstudioVigentePorDocumento('cc', '123', 'u-1', 'solicitante');
    expect(ops).toContainEqual({ table: 'estudios', method: 'neq', args: ['tipo', 'con_coarrendatario'] });
  });
});

describe('§5.2 estudio vigente por documento', () => {
  it('filtra el numero en SQL antes del limit (con mas de 25 evaluaciones en la ventana no se pierde)', async () => {
    vi.mocked(resolveAllowedExpedienteIds).mockResolvedValueOnce(null);
    vi.mocked(getCalibracion).mockResolvedValueOnce({ VIGENCIA_CRC_DIAS: 60 } as never);
    await buscarEstudioVigentePorDocumento('cc', ' 123 ', 'u-1', 'operador_analista');
    expect(ops).toContainEqual({ table: 'estudios', method: 'eq', args: ['datos_formulario->>numero_documento', '123'] });
  });
});

describe('contraste de ingreso (Adenda §8) sin cifras', () => {
  it('el motivo que va a observaciones no lleva el declarado, el estimado ni el umbral', async () => {
    enqueue('autorizacion_perfil_prospecto', { data: { ingreso_declarado_cop: 9_000_000 }, error: null });
    const motivo = await contrasteIngresoProspecto('exp-1', 3_000_000, 50);
    expect(motivo).toMatch(/Revision manual \(Adenda §8\)/);
    expect(motivo).not.toMatch(/\d{3}|%/);
  });
});

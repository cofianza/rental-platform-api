import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Firma V3 — reconciliación, activación, firma incompleta, webhook, cancelar
// y reenviar (Entrega 5, diseño §13 casos 7-14).
//
// Mock de Supabase con colas POR TABLA (mismo patrón que asistente.service.test):
// `maybeSingle`/`single` y el `await` directo consumen el siguiente resultado
// de la cola de esa tabla; una tabla sin cola responde { data: null }. Todas
// las llamadas quedan en `ops` para afirmar el ORDEN de las escrituras.
// ============================================================

const { mockEnv, ops, queues, enqueue, mockRpc, chainFor, download, auco, efectos } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'or', 'order', 'limit', 'gt'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH)
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  const mockRpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    ops.push({ table: `rpc:${fn}`, method: String(args.p_nuevo_estado), args: [args] });
    return next(`rpc:${fn}`);
  });
  const registra = (table: string, method: string) =>
    vi.fn(async (...args: unknown[]) => {
      ops.push({ table, method, args });
    });
  return {
    mockEnv: { CONTRATOS_V3_ENABLED: true, AUCO_SENDER_EMAIL: 'firma@cofianza.co', AUCO_WEBHOOK_SECRET: undefined as string | undefined, FIRMA_BIOMETRIA_ENABLED: false },
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockRpc,
    chainFor,
    download: vi.fn(async () => ({ data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null })),
    auco: {
      getDocumentStatus: vi.fn(),
      getDocumentRoadmap: vi.fn(),
      cancelDocument: registra('auco', 'cancel'),
      uploadDocumentForSignature: vi.fn(),
    },
    efectos: {
      bloquearInmuebleOcupado: registra('efecto', 'ocupar'),
      archivarPdfFirmadoEnStorage: registra('efecto', 'archivar'),
      cancelarPagos: registra('efecto', 'cancelar-pagos'),
      enviarCorreoNotificacion: registra('efecto', 'correo'),
      notificarUsuario: registra('efecto', 'notificar'),
      listOperators: vi.fn(async () => [{ id: 'op1', rol: 'operador_analista' }, { id: 'ad1', rol: 'administrador' }]),
      logAudit: vi.fn(),
    },
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: string) => chainFor(t),
    rpc: (fn: string, args: Record<string, unknown>) => mockRpc(fn, args),
    storage: { from: () => ({ download }) },
  },
  supabaseAuth: {},
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: efectos.logAudit,
  AUDIT_ACTIONS: {
    FIRMA_COMPLETADA: 'firma_completada',
    FIRMA_SOLICITUD_CREATED: 'firma_solicitud_created',
    FIRMA_PLAZO_PRORROGADO: 'firma_plazo_prorrogado',
    FIRMA_AVISO_ACEPTADO: 'firma_aviso_aceptado',
  },
  AUDIT_ENTITIES: { CONTRATO: 'contrato' },
}));
// El acuse: m1 es titular de org1 (la inmobiliaria del contrato).
vi.mock('@/lib/tenantScope', async (orig) => ({
  ...(await orig<typeof import('@/lib/tenantScope')>()),
  resolveMembershipInmobiliariaIds: vi.fn(async (id: string) => (id === 'm1' ? ['org1'] : ['otra-org'])),
  resolveRolMiembro: vi.fn(async () => 'owner'),
}));
vi.mock('@/lib/auco', async (orig) => ({ ...(await orig<typeof import('@/lib/auco')>()), ...auco }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: async () => ({ DIAS_EXPIRACION_FIRMA: 15, VIGENCIA_CRC_DIAS: 60 }) }));
vi.mock('@/modules/inmuebles/inmuebles.service', () => ({ bloquearInmuebleOcupado: efectos.bloquearInmuebleOcupado }));
vi.mock('@/modules/firma/firma.service', () => ({ archivarPdfFirmadoEnStorage: efectos.archivarPdfFirmadoEnStorage }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  enviarCorreoNotificacion: efectos.enviarCorreoNotificacion,
  notificarUsuario: efectos.notificarUsuario,
}));
vi.mock('@/modules/users/users.service', () => ({ listOperators: efectos.listOperators }));
vi.mock('@/modules/pagos/pagos.service', () => ({ cancelarPagosPendientesDeExpediente: efectos.cancelarPagos }));

import {
  aceptarAviso,
  cancelarFirmaV3,
  crearSobre,
  estadoEnviado,
  exigirAcuseDelEstudio,
  prorrogarPlazo,
  reenviar,
  reintentar,
} from '../firma.service';
import { reconciliarSobre, webhookAucoV3 } from '../reconciliar';
import { AVISO_FIRMA_INCOMPLETA_VERSION, finDelDia } from '../reglas';
import { fechaBogota } from '../../formato';

// ── Datos ──

const HOY = new Date().toISOString();
/** Un proceso vivo todavía no vence: su plazo es a futuro. */
const EN_10_DIAS = new Date(Date.now() + 10 * 86_400_000).toISOString();
const PARTES = [
  { id: 'p1', rol: 'arrendatario', orden: 1, nombre: 'Ana', tipo_documento: 'cc', numero_documento: '1', email: 'ana@x.co', telefono: '3001112233' },
  { id: 'p2', rol: 'arrendador', orden: 2, nombre: 'Inmo', tipo_documento: 'nit', numero_documento: '9', email: 'inmo@x.co', telefono: '3004445566',
    representante_legal_nombre: 'Caro', representante_legal_tipo_documento: 'cc', representante_legal_documento: '5' },
];
const sobre = (x: Record<string, unknown> = {}) => ({
  id: 's1', contrato_id: 'c1', intento: 1, estado: 'en_firma', auco_code: 'AUCO1', expira_en: EN_10_DIAS,
  firmantes: [{ parteId: 'p1', estado: 'notificado' }, { parteId: 'p2', estado: 'pendiente' }],
  motivo: null, motivo_detalle: null, cerrado_en: null, auco_cancelado_en: null, aviso_entregado_en: null,
  aviso_detalle: null, enviado_por: 'u1', created_at: HOY, updated_at: '2026-09-22T10:00:00.000001+00:00', ...x,
});
const contrato = (x: Record<string, unknown> = {}) => ({
  id: 'c1', estado: 'pendiente_firma', numero: 'CTO-2026-0001', expediente_id: 'e1', fecha_firma: null,
  datos_variables: { documento: { entrada: { inmueble: { direccion: 'Calle 1' } }, snapshot: { estudio: { fechaCompletado: HOY } }, final: { ruta: 'A' } } },
  ...x,
});
const EXPEDIENTE = { data: { inmueble_id: 'i1', inmobiliaria_id: 'org1', miembro_responsable_id: 'm2' }, error: null };
/** La org: m1 titular, m2 miembro (responsable del estudio), m3 miembro, u1 miembro (envió). */
const MIEMBROS = [
  { perfil_id: 'm1', rol_miembro: 'owner' },
  { perfil_id: 'm2', rol_miembro: 'miembro' },
  { perfil_id: 'm3', rol_miembro: 'miembro' },
  { perfil_id: 'u1', rol_miembro: 'miembro' },
];
const org = (venTodo = false, miembros = MIEMBROS) => {
  enqueue('inmobiliarias', { data: { miembros_ven_todo: venTodo }, error: null });
  enqueue('inmobiliaria_miembros', { data: miembros, error: null });
};
const ok = (data: unknown) => ({ data, error: null });
const roadmap = (n: number) => ({
  participants: [{ id: '01', phone: '+573001112233' }, { id: '02', phone: '+573004445566' }],
  activityLog: [
    { action: 'PARTICIPANT_SIGN', participant: '01', timestamp: '2026-09-20T10:00:00Z' },
    { action: 'PARTICIPANT_SIGN', participant: '02', timestamp: '2026-09-21T15:30:00Z' },
  ].slice(0, n),
});
const statusFinish = { status: 'FINISH', signProfile: [{ id: 'G1', email: 'ana@x.co', status: 'FINISH' }, { id: 'G2', email: 'inmo@x.co', status: 'FINISH' }] };

const DIA = 86_400_000;
/** Medianoche (Bogotá) del día que cae dentro de n días: así vencen los plazos de firma. */
const finDeDiaEn = (n: number, desde = Date.now()) => new Date(finDelDia(fechaBogota(new Date(desde + n * DIA)))).toISOString();

const escrituras = () => ops.filter((o) => ['insert', 'update', 'delete'].includes(o.method) || o.table.startsWith('rpc:') || o.table === 'efecto' || o.table === 'auco');
const tabla = (t: string, m: string) => ops.filter((o) => o.table === t && o.method === m);

beforeEach(() => {
  ops.length = 0;
  queues.clear();
  vi.clearAllMocks();
  mockEnv.AUCO_WEBHOOK_SECRET = undefined;
});

// ── Activación ──

describe('reconciliarSobre: FINISH', () => {
  it('con todas las firmas en el roadmap activa la fianza con la fecha de la última firma y NO cierra el estudio', async () => {
    enqueue('contrato_v3_sobres', ok(sobre()), ok([{ id: 's1' }])); // leer, CAS
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contratos', ok(contrato()), ok(contrato()), ok(null)); // fin del CRC, leerContrato, update fecha_firma
    enqueue('expedientes', EXPEDIENTE, EXPEDIENTE);
    org();
    auco.getDocumentStatus.mockResolvedValue(statusFinish);
    auco.getDocumentRoadmap.mockResolvedValue(roadmap(2));

    await reconciliarSobre('s1');

    const cas = tabla('contrato_v3_sobres', 'update')[0].args[0] as Record<string, unknown>;
    expect(cas).toMatchObject({ estado: 'completo', cerrado_en: '2026-09-21T15:30:00.000Z' });
    expect(tabla('contratos', 'update')[0].args[0]).toEqual({ fecha_firma: '2026-09-21T15:30:00.000Z' });
    expect(tabla('rpc:transicionar_contrato', 'vigente')).toHaveLength(1);
    expect(efectos.bloquearInmuebleOcupado).toHaveBeenCalledWith('i1');
    const aviso = tabla('notificaciones', 'insert')[0].args[0] as Array<{ user_id: string; tipo: string }>;
    expect(aviso.map((n) => n.user_id)).toEqual(['m1', 'm2', 'u1']); // titular + responsable + quien envió; m3 no ve el estudio
    expect(aviso[0].tipo).toBe('contrato.fianza_activa');
    // la constancia va al final
    const ultimo = tabla('contrato_v3_sobres', 'update').at(-1)!.args[0] as Record<string, unknown>;
    expect(ultimo.aviso_entregado_en).toBeTruthy();
    // §12.2: nada de cerrar el expediente
    expect(ops.some((o) => o.table === 'expedientes' && o.method === 'update')).toBe(false);
  });

  it('con una firma faltante en el roadmap no activa: solo sincroniza firmantes (reintenta el barrido)', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ firmantes: [{ parteId: 'p1', estado: 'firmado', firmadoEn: '2026-09-20T10:00:00Z' }, { parteId: 'p2', estado: 'firmado', firmadoEn: '2026-09-21T15:30:00Z' }] })));
    enqueue('contrato_partes', ok(PARTES));
    auco.getDocumentStatus.mockResolvedValue(statusFinish);
    auco.getDocumentRoadmap.mockResolvedValue(roadmap(1));

    await reconciliarSobre('s1');
    const updates = tabla('contrato_v3_sobres', 'update').map((o) => o.args[0] as Record<string, unknown>);
    expect(updates.every((u) => u.estado === undefined && u.cerrado_en === undefined)).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(tabla('notificaciones', 'insert')).toEqual([]);
  });

  it('si otro proceso ganó el CAS, no hay segunda transición ni segundo aviso', async () => {
    enqueue('contrato_v3_sobres', ok(sobre()), ok([])); // CAS perdido
    enqueue('contrato_partes', ok(PARTES));
    auco.getDocumentStatus.mockResolvedValue(statusFinish);
    auco.getDocumentRoadmap.mockResolvedValue(roadmap(2));

    await reconciliarSobre('s1');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(tabla('notificaciones', 'insert')).toEqual([]);
  });
});

// ── Firma incompleta ──

describe('reconciliarSobre: EXPIRED / REJECTED', () => {
  it('EXPIRED pasa a FIRMA INCOMPLETA y entrega el aviso con constancia', async () => {
    enqueue('contrato_v3_sobres', ok(sobre()), ok([{ id: 's1' }]));
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contratos', ok(contrato()), ok({ estado: 'firma_incompleta' }));
    enqueue('expedientes', EXPEDIENTE);
    org(true);
    auco.getDocumentStatus.mockResolvedValue({ status: 'EXPIRED', signProfile: [] });

    await reconciliarSobre('s1');

    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toMatchObject({ estado: 'incompleto', motivo: 'EXPIRED' });
    expect(tabla('rpc:transicionar_contrato', 'firma_incompleta')).toHaveLength(1);
    const avisos = tabla('notificaciones', 'insert');
    expect(avisos).toHaveLength(1); // un solo insert, con el error verificado
    const filas = avisos[0].args[0] as Array<{ user_id: string; tipo: string; mensaje: string }>;
    expect(filas.map((n) => n.user_id)).toEqual(['m1', 'm2', 'm3', 'u1']); // miembros_ven_todo: todos
    const fila = filas[0];
    expect(fila.tipo).toBe('contrato.firma_incompleta');
    expect(fila.mensaje).toContain('NO está operando');
    const constancia = tabla('contrato_v3_sobres', 'update').at(-1)!.args[0] as Record<string, unknown>;
    expect(constancia).toMatchObject({ aviso_detalle: { texto_version: AVISO_FIRMA_INCOMPLETA_VERSION } });
    // Adenda 1, respuesta 11: el aviso (app y correo) dice que hay que aceptarlo para reenviar o cancelar.
    expect(fila.mensaje).toContain('primero acepta este aviso en la plataforma');
    expect(tabla('efecto', 'correo')[0].args[0]).toMatchObject({ mensaje: fila.mensaje });
    // §11.7.3: los links de garantía y primer canon creados EN FIRMA se anulan.
    expect(tabla('efecto', 'cancelar-pagos')[0].args).toEqual(['e1', expect.any(String), ['garantia', 'primer_canon']]);
  });

  describe('respaldo del vencimiento (Auco no marca EXPIRED)', () => {
    const vencido = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const pendiente = { status: 'PENDING', signProfile: [] };
    // Las respuestas "Once" que un test no consuma no deben pasar al siguiente.
    beforeEach(() => auco.getDocumentStatus.mockReset());

    it('vencido el plazo: se anula en Auco y después queda FIRMA INCOMPLETA con su aviso', async () => {
      enqueue(
        'contrato_v3_sobres',
        ok(sobre({ expira_en: vencido(120) })), // lectura
        ok(null), // constancia de la anulación en Auco
        ok(sobre({ expira_en: vencido(120), updated_at: '2026-09-23T10:00:00+00:00' })), // relectura
        ok([{ id: 's1' }]), // CAS
      );
      enqueue('contrato_partes', ok(PARTES));
      enqueue('contratos', ok(contrato()), ok({ estado: 'firma_incompleta' }));
      enqueue('expedientes', EXPEDIENTE);
      org(true);
      auco.getDocumentStatus.mockResolvedValueOnce(pendiente).mockResolvedValueOnce({ status: 'REJECTED', signProfile: [] });

      await reconciliarSobre('s1');

      const anulacion = ops.findIndex((o) => o.table === 'auco' && o.method === 'cancel');
      const cierre = tabla('contrato_v3_sobres', 'update').find((o) => (o.args[0] as { estado?: string }).estado === 'incompleto');
      expect(cierre?.args[0]).toMatchObject({ estado: 'incompleto', motivo: 'EXPIRED' });
      // Primero Auco, después el cierre aquí.
      expect(anulacion).toBeGreaterThanOrEqual(0);
      expect(anulacion).toBeLessThan(ops.indexOf(cierre!));
      // El CAS usa el updated_at releído, no el de antes de la anulación.
      expect(ops.filter((o) => o.table === 'contrato_v3_sobres' && o.method === 'eq').map((o) => o.args)).toContainEqual([
        'updated_at',
        '2026-09-23T10:00:00+00:00',
      ]);
      expect(tabla('rpc:transicionar_contrato', 'firma_incompleta')).toHaveLength(1);
    });

    it('si la última firma le ganó a la anulación (FINISH), no se cierra ni se alerta un conflicto: decide la hora de esa firma', async () => {
      enqueue('contrato_v3_sobres', ok(sobre({ expira_en: vencido(120) })));
      enqueue('contrato_partes', ok(PARTES));
      auco.cancelDocument.mockRejectedValueOnce(new Error('ya firmado'));
      auco.getDocumentStatus.mockResolvedValueOnce(pendiente).mockResolvedValueOnce(statusFinish);

      await reconciliarSobre('s1');

      expect(tabla('contrato_v3_sobres', 'update')).toEqual([]); // ni cierre ni "no se pudo anular"
      expect(tabla('notificaciones', 'insert')).toEqual([]); // sin la alerta falsa firma.conflicto
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('antes del plazo no toca nada; vencido, cierra sin esperar a Auco (allá vence después, Adenda 1)', async () => {
      enqueue('contrato_v3_sobres', ok(sobre({ expira_en: vencido(-5) })));
      enqueue('contrato_partes', ok(PARTES));
      auco.getDocumentStatus.mockResolvedValueOnce(pendiente);
      await reconciliarSobre('s1');
      expect(tabla('auco', 'cancel')).toHaveLength(0);
      expect(escrituras()).toEqual([]);

      enqueue('contrato_v3_sobres', ok(sobre({ expira_en: vencido(1) })));
      enqueue('contrato_partes', ok(PARTES));
      auco.getDocumentStatus.mockResolvedValueOnce(pendiente).mockResolvedValueOnce({ status: 'REJECTED', signProfile: [] });
      await reconciliarSobre('s1');
      expect(tabla('auco', 'cancel')).toHaveLength(1);
    });
  });

  it('si el insert del aviso falla, NO se escribe la constancia (el barrido reintenta)', async () => {
    enqueue('contrato_v3_sobres', ok(sobre()), ok([{ id: 's1' }]));
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contratos', ok(contrato()), ok({ estado: 'firma_incompleta' }));
    enqueue('expedientes', EXPEDIENTE);
    org();
    enqueue('notificaciones', { data: null, error: { message: 'caída' } });
    auco.getDocumentStatus.mockResolvedValue({ status: 'REJECTED', signProfile: [{ email: 'ana@x.co', status: 'REJECT' }] });

    await expect(reconciliarSobre('s1', { message: 'no estoy de acuerdo' })).rejects.toThrow();
    const updates = tabla('contrato_v3_sobres', 'update').map((o) => o.args[0] as Record<string, unknown>);
    expect(updates[0]).toMatchObject({ estado: 'incompleto', motivo: 'REJECTED', motivo_detalle: 'no estoy de acuerdo' });
    expect(updates.some((u) => 'aviso_entregado_en' in u)).toBe(false);
  });

  it('BLOCK de un firmante no cierra el sobre: sigue EN FIRMA y avisa a los operadores', async () => {
    enqueue('contrato_v3_sobres', ok(sobre()), ok([{ id: 's1' }]));
    enqueue('contrato_partes', ok(PARTES));
    auco.getDocumentStatus.mockResolvedValue({ status: 'CREATED', signProfile: [{ email: 'ana@x.co', status: 'BLOCK' }] });

    await reconciliarSobre('s1');
    const cas = tabla('contrato_v3_sobres', 'update')[0].args[0] as Record<string, unknown>;
    expect(cas.estado).toBeUndefined();
    expect(mockRpc).not.toHaveBeenCalled();
    expect((tabla('notificaciones', 'insert')[0].args[0] as Array<{ tipo: string }>)[0].tipo).toBe('firma.bloqueada');
  });
});

describe('reconciliarSobre: ecos y sobres viejos', () => {
  it('un evento de un sobre ya cancelado no escribe nada (el eco de nuestra cancelación)', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'cancelado', auco_cancelado_en: HOY })));
    await reconciliarSobre('s1', { code: 'AUCO1', message: 'cancelado' });
    expect(escrituras()).toEqual([]);
    expect(auco.getDocumentStatus).not.toHaveBeenCalled();
  });

  it('un sobre incompleto con el aviso ya entregado no vuelve a avisar', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'incompleto', aviso_entregado_en: HOY })));
    await reconciliarSobre('s1');
    expect(escrituras()).toEqual([]);
  });

  it('curación: un sobre completo sin aviso entregado termina la activación', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'completo', cerrado_en: '2026-09-21T15:30:00.000Z' })));
    enqueue('contratos', ok(contrato({ estado: 'pendiente_firma' })), ok(null));
    enqueue('expedientes', EXPEDIENTE);
    org();
    await reconciliarSobre('s1');
    expect(tabla('rpc:transicionar_contrato', 'vigente')).toHaveLength(1);
    expect(auco.getDocumentStatus).not.toHaveBeenCalled();
  });

  it('un contrato movido por fuera (cancelado) no recibe la fecha de activación: avisa el conflicto a los administradores', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'completo', cerrado_en: '2026-09-21T15:30:00.000Z' })));
    enqueue('contratos', ok(contrato({ estado: 'cancelado' })));
    enqueue('expedientes', EXPEDIENTE);
    await reconciliarSobre('s1');
    expect(tabla('contratos', 'update')).toEqual([]);
    expect(mockRpc).not.toHaveBeenCalled();
    const aviso = tabla('notificaciones', 'insert')[0].args[0] as Array<{ user_id: string; tipo: string }>;
    expect(aviso.map((n) => [n.user_id, n.tipo])).toEqual([['ad1', 'firma.conflicto']]);
  });

  it('curación de un contrato que ya se terminó: sin aviso ni alarma, solo la constancia de omitido', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'completo', cerrado_en: '2026-09-21T15:30:00.000Z' })));
    enqueue('contratos', ok(contrato({ estado: 'finalizado' })));
    enqueue('expedientes', EXPEDIENTE);
    await reconciliarSobre('s1');
    expect(tabla('notificaciones', 'insert')).toEqual([]);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toMatchObject({ aviso_detalle: { omitido: 'finalizado' } });
  });

  it('un contrato ya activo sin fecha (activación a medias) la recibe, sin volver a transicionar', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'completo', cerrado_en: '2026-09-21T15:30:00.000Z' })));
    enqueue('contratos', ok(contrato({ estado: 'vigente' })), ok(null));
    enqueue('expedientes', EXPEDIENTE);
    org();
    await reconciliarSobre('s1');
    const fecha = ops.filter((o) => o.table === 'contratos' && o.method === 'eq').map((o) => o.args);
    expect(tabla('contratos', 'update')[0].args[0]).toEqual({ fecha_firma: '2026-09-21T15:30:00.000Z' });
    expect(fecha).toContainEqual(['estado', 'vigente']);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('un sobre incompleto viejo (ya hubo reenvío) no toca el contrato: constancia de "superado"', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'incompleto', motivo: 'EXPIRED' })), ok(sobre({ id: 's2', intento: 2 })));
    await reconciliarSobre('s1');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(tabla('notificaciones', 'insert')).toEqual([]);
    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toMatchObject({ aviso_detalle: { omitido: 'superado', por: 's2' } });
  });

  it('sin nadie activo a quien avisar no escribe la constancia (el barrido reintenta)', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'incompleto', motivo: 'EXPIRED' })));
    enqueue('contratos', ok(contrato({ estado: 'firma_incompleta' })), ok({ estado: 'firma_incompleta' }));
    enqueue('expedientes', EXPEDIENTE);
    org(false, [{ perfil_id: 'm3', rol_miembro: 'miembro' }]); // ni titular ni responsable ni remitente activos
    await expect(reconciliarSobre('s1')).rejects.toThrow(/miembros activos/);
    expect(tabla('contrato_v3_sobres', 'update')).toEqual([]);
  });
});

describe('reconciliarSobre: adopción de un proceso sin registrar', () => {
  const ID = '3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607';
  const custom = (id: string) => [`cofianza_sobre: '${id}'`];

  it('solo adopta el `code` si Auco confirma en `custom` que el proceso es de ESTE sobre', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ id: ID, estado: 'creando', auco_code: null })));
    auco.getDocumentStatus.mockResolvedValue({ status: 'CREATED', signProfile: [], custom: custom('0f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607') });
    await reconciliarSobre(ID, { code: 'AJENO' });
    expect(escrituras()).toEqual([]);

    enqueue('contrato_v3_sobres', ok(sobre({ id: ID, estado: 'creando', auco_code: null })), ok([{ id: ID }]));
    auco.getDocumentStatus.mockResolvedValue({ status: 'CREATED', signProfile: [], custom: custom(ID) });
    await reconciliarSobre(ID, { code: 'PROPIO' });
    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toEqual({ auco_code: 'PROPIO', estado: 'en_firma' });
  });

  it('el proceso de un sobre que quedó fallido se anula en Auco (confirmado por `custom`)', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ id: ID, estado: 'fallido', auco_code: null })));
    auco.getDocumentStatus.mockResolvedValue({ status: 'CREATED', signProfile: [], custom: custom(ID) });
    await reconciliarSobre(ID, { code: 'TARDIO' });
    expect(auco.cancelDocument).toHaveBeenCalledWith('TARDIO', { message: expect.any(String), email: 'firma@cofianza.co' });
    const updates = tabla('contrato_v3_sobres', 'update').map((o) => o.args[0] as Record<string, unknown>);
    expect(updates[0]).toEqual({ auco_code: 'TARDIO' });
    expect(updates[1].auco_cancelado_en).toBeTruthy();
  });

  it('si esa anulación falló, se reintenta después (el sobre fallido ya tiene su code)', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ id: ID, estado: 'fallido', auco_code: 'TARDIO', updated_at: '2026-01-01T00:00:00Z' })));
    await reconciliarSobre(ID);
    expect(auco.cancelDocument).toHaveBeenCalledWith('TARDIO', {
      message: 'Proceso anulado: el envío no quedó registrado en Cofianza',
      email: 'firma@cofianza.co',
    });
    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toMatchObject({ auco_cancelado_en: expect.any(String) });
  });
});

// ── Webhook ──

describe('webhookAucoV3', () => {
  // La reconciliación va con setTimeout: con timers falsos no se escapa a otra prueba.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const res = () => {
    const r = { status: vi.fn(() => r), json: vi.fn(() => r) };
    return r;
  };

  it('un código que no es de un sobre V3 pasa al webhook anterior intacto', async () => {
    enqueue('contrato_v3_sobres', ok(null));
    const next = vi.fn();
    const r = res();
    await webhookAucoV3({ method: 'POST', body: { code: 'LEGACY', status: 'FINISH' }, headers: {} } as never, r as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(r.status).not.toHaveBeenCalled();
  });

  it('un sobre V3 responde 200 enseguida; sin `code` lo encuentra por `custom`', async () => {
    enqueue('contrato_v3_sobres', ok({ id: '3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607' }), ok(null));
    const next = vi.fn();
    const r = res();
    await webhookAucoV3(
      { method: 'POST', body: { status: 'BLOCKED', custom: ["cofianza_sobre: '3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607'"] }, headers: {} } as never,
      r as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('con secreto configurado y equivocado ni consulta la base: decide el webhook anterior (su 401)', async () => {
    mockEnv.AUCO_WEBHOOK_SECRET = 'bien';
    const next = vi.fn();
    const r = res();
    await webhookAucoV3({ method: 'POST', body: { code: 'AUCO1' }, headers: { authorization: 'mal' } } as never, r as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(r.status).not.toHaveBeenCalled();
    expect(ops).toEqual([]);
  });

  it('una ráfaga de eventos del mismo sobre reconcilia UNA vez, con el último evento', async () => {
    const ID = 'a1b2c3d4-0000-4000-8000-000000000001'; // otro id: el de la prueba anterior quedó programado
    const custom = [`cofianza_sobre: '${ID}'`];
    for (let i = 0; i < 2; i++) enqueue('contrato_v3_sobres', ok(null), ok({ id: ID })); // por code (no está) y por custom
    for (const code of ['X1', 'X2'])
      await webhookAucoV3({ method: 'POST', body: { code, status: 'CREATE', custom }, headers: {} } as never, res() as never, vi.fn());
    expect(auco.getDocumentStatus).not.toHaveBeenCalled();

    enqueue('contrato_v3_sobres', ok(sobre({ id: ID, estado: 'creando', auco_code: null })), ok([{ id: ID }]));
    auco.getDocumentStatus.mockResolvedValue({ status: 'CREATED', signProfile: [], custom });
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(tabla('contrato_v3_sobres', 'update')).toHaveLength(1));
    expect(auco.getDocumentStatus).toHaveBeenCalledTimes(1);
    expect(auco.getDocumentStatus).toHaveBeenCalledWith('X2');
  });

  it('el motivo del rechazo solo se toma de un webhook autenticado; si no, sale de Auco', async () => {
    const rechazo = async (headers: Record<string, string>) => {
      ops.length = 0;
      enqueue('contrato_v3_sobres', ok({ id: 's1' }), ok(sobre()), ok([{ id: 's1' }]), ok(sobre({ id: 's2' })));
      enqueue('contrato_partes', ok(PARTES));
      auco.getDocumentStatus.mockResolvedValue({ status: 'REJECTED', signProfile: [{ email: 'ana@x.co', status: 'REJECT' }] });
      await webhookAucoV3({ method: 'POST', body: { code: 'AUCO1', message: '<a href=x>clic aquí</a>' }, headers } as never, res() as never, vi.fn());
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => expect(tabla('contrato_v3_sobres', 'update').length).toBeGreaterThan(0));
      return (tabla('contrato_v3_sobres', 'update')[0].args[0] as Record<string, unknown>).motivo_detalle;
    };
    expect(await rechazo({})).toBe('el arrendatario');
    mockEnv.AUCO_WEBHOOK_SECRET = 'bien';
    expect(await rechazo({ authorization: 'bien' })).toBe('<a href=x>clic aquí</a>');
  });

  it('si la tabla no existe todavía (migración sin correr), decide el webhook anterior', async () => {
    enqueue('contrato_v3_sobres', { data: null, error: { message: 'relation does not exist' } });
    const next = vi.fn();
    await webhookAucoV3({ method: 'POST', body: { code: 'X' }, headers: {} } as never, res() as never, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

// ── Cancelar ──

describe('cancelarFirmaV3', () => {
  // Cada caso arranca con la consulta de sobreCompleto (null = nadie firmó todo).
  it('marca el sobre cancelado ANTES de ir a Auco', async () => {
    enqueue('contrato_v3_sobres', ok(null), ok(sobre()), ok([{ id: 's1' }]));
    await cancelarFirmaV3('c1');
    const i = ops.findIndex((o) => o.table === 'contrato_v3_sobres' && o.method === 'update');
    const j = ops.findIndex((o) => o.table === 'auco' && o.method === 'cancel');
    expect((ops[i].args[0] as Record<string, unknown>).estado).toBe('cancelado');
    expect(i).toBeLessThan(j);
    expect(auco.cancelDocument).toHaveBeenCalledWith('AUCO1', { message: expect.any(String), email: 'firma@cofianza.co' });
  });

  it('si Auco falla y ya firmaron todos: el sobre vuelve a en_firma, se reconcilia y responde 409', async () => {
    enqueue('contrato_v3_sobres', ok(null), ok(sobre()), ok([{ id: 's1' }]), ok(null), ok(null));
    auco.cancelDocument.mockRejectedValueOnce(new Error('ya firmado'));
    auco.getDocumentStatus.mockResolvedValue({ status: 'FINISH', signProfile: [] });
    await expect(cancelarFirmaV3('c1')).rejects.toMatchObject({ errorCode: 'CONTRATO_YA_FIRMADO' });
    const vuelta = tabla('contrato_v3_sobres', 'update').map((o) => o.args[0] as Record<string, unknown>);
    expect(vuelta[1]).toMatchObject({ estado: 'en_firma' });
  });

  it('si Auco no responde: el sobre vuelve y 502', async () => {
    enqueue('contrato_v3_sobres', ok(null), ok(sobre()), ok([{ id: 's1' }]));
    auco.cancelDocument.mockRejectedValueOnce(new Error('timeout'));
    auco.getDocumentStatus.mockRejectedValue(new Error('caído'));
    await expect(cancelarFirmaV3('c1')).rejects.toMatchObject({ errorCode: 'AUCO_NO_DISPONIBLE' });
  });

  it('desde FIRMA INCOMPLETA no toca Auco; con la firma completa responde 409', async () => {
    enqueue('contrato_v3_sobres', ok(null), ok(sobre({ estado: 'incompleto' })));
    await cancelarFirmaV3('c1');
    expect(auco.cancelDocument).not.toHaveBeenCalled();
    enqueue('contrato_v3_sobres', ok({ id: 's0' }), ok(sobre({ id: 's0', estado: 'completo' })));
    await expect(cancelarFirmaV3('c1')).rejects.toMatchObject({ errorCode: 'FIRMA_COMPLETA' });
    expect(auco.cancelDocument).not.toHaveBeenCalled();
  });

  it('Auco responde 200 sin cancelar (`errors.cant`): si el proceso sigue vivo, vuelve a en_firma y 502', async () => {
    enqueue('contrato_v3_sobres', ok(null), ok(sobre()), ok([{ id: 's1' }]));
    auco.cancelDocument.mockResolvedValueOnce({ errors: { cant: 1 } } as never);
    auco.getDocumentStatus.mockResolvedValue({ status: 'CREATED', signProfile: [] });
    await expect(cancelarFirmaV3('c1')).rejects.toMatchObject({ errorCode: 'AUCO_NO_DISPONIBLE' });
    const updates = tabla('contrato_v3_sobres', 'update').map((o) => o.args[0] as Record<string, unknown>);
    expect(updates.map((u) => u.estado)).toEqual(['cancelado', 'en_firma']);
  });

  it('si Auco ya lo había cerrado (vencido o rechazado), queda anulado sin error', async () => {
    enqueue('contrato_v3_sobres', ok(null), ok(sobre()), ok([{ id: 's1' }]));
    auco.cancelDocument.mockResolvedValueOnce({ success: false } as never);
    auco.getDocumentStatus.mockResolvedValue({ status: 'EXPIRED', signProfile: [] });
    await cancelarFirmaV3('c1');
    const updates = tabla('contrato_v3_sobres', 'update').map((o) => o.args[0] as Record<string, unknown>);
    expect(updates[0].estado).toBe('cancelado');
    expect(updates[1].auco_cancelado_en).toBeTruthy();
    expect(updates).toHaveLength(2);
  });
});

// ── Crear y reenviar ──

describe('crearSobre', () => {
  const preparar = () => {
    enqueue('contratos', ok(contrato()), ok({ destinacion: 'vivienda', storage_key: 'final.pdf' }));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_partes', ok(PARTES));
  };

  it('manda order, label, custom y el vencimiento del parámetro; registra el código de Auco', async () => {
    preparar();
    enqueue('contrato_v3_sobres', ok(null), ok({ id: 's1' }), ok(sobre({ estado: 'creando', auco_code: null })), ok([{ id: 's1' }]), ok(sobre()));
    auco.uploadDocumentForSignature.mockResolvedValue('AUCO9');
    await crearSobre('c1', 'u1');
    const [input, timeout] = auco.uploadDocumentForSignature.mock.calls[0] as [Record<string, unknown>, number];
    expect(timeout).toBe(120_000);
    expect(input.custom).toEqual({ cofianza_sobre: 's1' });
    const perfiles = input.signProfile as Array<{ order: string; label: boolean; name: string }>;
    expect(perfiles.map((p) => [p.name, p.order, p.label])).toEqual([['Ana', '1', true], ['Caro', '2', true]]);
    // Adenda 1 (respuesta 10): 15 días hasta la medianoche; Auco, el máximo con la prórroga (30), que queda guardado.
    const insertado = tabla('contrato_v3_sobres', 'insert')[0].args[0] as { expira_en: string; auco_expira_en: string };
    expect(insertado.expira_en).toBe(finDeDiaEn(15));
    expect(input.expiredDate).toBe(finDeDiaEn(30));
    expect(insertado.auco_expira_en).toBe(finDeDiaEn(30));
    expect(input.message).toContain(`Tienes hasta el ${fechaBogota(finDeDiaEn(15)).split('-').reverse().join('/')}`);
    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toEqual({ auco_code: 'AUCO9', estado: 'en_firma' });
  });

  it('el plazo nunca pasa la vigencia del CRC (Adenda 1, respuesta 10)', async () => {
    const completado = new Date(Date.now() - 50 * DIA).toISOString(); // al CRC le quedan ~10 días
    enqueue('contratos', ok(contrato({ datos_variables: { documento: { snapshot: { estudio: { fechaCompletado: completado } } } } })), ok({ destinacion: 'vivienda', storage_key: 'final.pdf' }));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contrato_v3_sobres', ok(null), ok({ id: 's1' }), ok(sobre({ estado: 'creando', auco_code: null })), ok([{ id: 's1' }]), ok(sobre()));
    auco.uploadDocumentForSignature.mockResolvedValue('AUCO9');
    await crearSobre('c1', 'u1');
    // El fin exacto (completado + 60 días), no el fin del día calendario.
    const finCrc = new Date(Date.parse(completado) + 60 * DIA).toISOString();
    expect((tabla('contrato_v3_sobres', 'insert')[0].args[0] as { expira_en: string }).expira_en).toBe(finCrc);
    expect((auco.uploadDocumentForSignature.mock.calls[0] as [Record<string, unknown>])[0].expiredDate).toBe(finCrc);
  });

  it('el fin del CRC es su fecha_vencimiento (la de /verificar) cuando el snapshot la trae', async () => {
    const vence = new Date(Date.now() + 8 * DIA + 3_600_000).toISOString();
    const dv = { documento: { snapshot: { estudio: { fechaCompletado: HOY }, crc: { fechaVencimiento: vence } } } };
    enqueue('contratos', ok(contrato({ datos_variables: dv })), ok({ destinacion: 'vivienda', storage_key: 'final.pdf' }));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contrato_v3_sobres', ok(null), ok({ id: 's1' }), ok(sobre({ estado: 'creando', auco_code: null })), ok([{ id: 's1' }]), ok(sobre()));
    auco.uploadDocumentForSignature.mockResolvedValue('AUCO9');
    await crearSobre('c1', 'u1');
    expect((tabla('contrato_v3_sobres', 'insert')[0].args[0] as { expira_en: string }).expira_en).toBe(vence);
  });

  it('con menos de 3 días de CRC no se abre el proceso: 409 CRC_SIN_MARGEN, sin sobre ni Auco', async () => {
    const vence = new Date(Date.now() + 2 * DIA).toISOString();
    const dv = { documento: { snapshot: { estudio: { fechaCompletado: HOY }, crc: { fechaVencimiento: vence } } } };
    enqueue('contratos', ok(contrato({ datos_variables: dv })), ok({ destinacion: 'vivienda', storage_key: 'final.pdf' }));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_partes', ok(PARTES));
    const e = await crearSobre('c1', 'u1').catch((x: unknown) => x);
    expect(e).toMatchObject({ statusCode: 409, errorCode: 'CRC_SIN_MARGEN', message: expect.stringContaining('renovar la evaluación') });
    expect(tabla('contrato_v3_sobres', 'insert')).toEqual([]);
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });

  it('con el CRC vencido no se abre el proceso: 409 CRC_VENCIDO sin sobre ni Auco', async () => {
    enqueue('contratos', ok(contrato({ datos_variables: { documento: { snapshot: { estudio: { fechaCompletado: '2020-01-01' } } } } })), ok({ destinacion: 'vivienda', storage_key: 'final.pdf' }));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_partes', ok(PARTES));
    await expect(crearSobre('c1', 'u1')).rejects.toMatchObject({ errorCode: 'CRC_VENCIDO' });
    expect(tabla('contrato_v3_sobres', 'insert')).toEqual([]);
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });

  it('sin la migración 20260930000001 registra el sobre sin el vencimiento de Auco (tolerante)', async () => {
    preparar();
    enqueue(
      'contrato_v3_sobres',
      ok(null),
      { data: null, error: { code: 'PGRST204', message: "Could not find the 'auco_expira_en' column" } },
      ok({ id: 's1' }),
      ok(sobre({ estado: 'creando', auco_code: null })),
      ok([{ id: 's1' }]),
      ok(sobre()),
    );
    auco.uploadDocumentForSignature.mockResolvedValue('AUCO9');
    await crearSobre('c1', 'u1');
    const inserts = tabla('contrato_v3_sobres', 'insert').map((o) => o.args[0] as Record<string, unknown>);
    expect(inserts).toHaveLength(2);
    expect(inserts[1]).not.toHaveProperty('auco_expira_en');
    expect(auco.uploadDocumentForSignature).toHaveBeenCalledTimes(1);
  });

  it('dos clics: el índice de sobre vivo responde 409', async () => {
    preparar();
    enqueue('contrato_v3_sobres', ok(null), { data: null, error: { code: '23505', message: 'dup' } });
    await expect(crearSobre('c1', 'u1')).rejects.toMatchObject({ errorCode: 'FIRMA_YA_EN_CURSO' });
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });

  it('si Auco falla, el sobre queda fallido y responde 502', async () => {
    preparar();
    enqueue('contrato_v3_sobres', ok(null), ok({ id: 's1' }), ok(sobre({ estado: 'creando', auco_code: null })), ok([{ id: 's1' }]));
    auco.uploadDocumentForSignature.mockRejectedValue(new Error('Auco API error (400): teléfono inválido'));
    await expect(crearSobre('c1', 'u1')).rejects.toMatchObject({ errorCode: 'AUCO_UPLOAD_FAILED' });
    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toMatchObject({ estado: 'fallido', motivo: 'AUCO_UPLOAD' });
  });

  it('upload con timeout pero el webhook ya adoptó el proceso: no es error', async () => {
    preparar();
    enqueue('contrato_v3_sobres', ok(null), ok({ id: 's1' }), ok(sobre({ estado: 'creando', auco_code: null })), ok([]), ok(sobre({ auco_code: 'AUCO7' })));
    auco.uploadDocumentForSignature.mockRejectedValue(new Error('timeout'));
    expect(await crearSobre('c1', 'u1')).toMatchObject({ estado: 'en_firma', auco_code: 'AUCO7' });
    // La adopción no registra nada: el envío queda en el timeline desde aquí.
    expect(tabla('eventos_timeline', 'insert')[0].args[0]).toMatchObject({ usuario_id: 'u1', metadata: { auco_code: 'AUCO7' } });
  });

  it('el webhook de creación llegó antes que la respuesta del upload: devuelve el sobre sin anular nada', async () => {
    preparar();
    enqueue('contrato_v3_sobres', ok(null), ok({ id: 's1' }), ok(sobre({ estado: 'creando', auco_code: null })), ok([]), ok(sobre({ auco_code: 'AUCO9' })));
    auco.uploadDocumentForSignature.mockResolvedValue('AUCO9');
    expect(await crearSobre('c1', 'u1')).toMatchObject({ auco_code: 'AUCO9' });
    expect(auco.cancelDocument).not.toHaveBeenCalled();
    expect(tabla('eventos_timeline', 'insert')).toHaveLength(1);
  });

  it('lo cancelaron mientras subía: se anula también en Auco y 409', async () => {
    preparar();
    enqueue('contrato_v3_sobres', ok(null), ok({ id: 's1' }), ok(sobre({ estado: 'creando', auco_code: null })), ok([]), ok(sobre({ estado: 'cancelado', auco_code: null })));
    auco.uploadDocumentForSignature.mockResolvedValue('AUCO9');
    await expect(crearSobre('c1', 'u1')).rejects.toMatchObject({ errorCode: 'CONTRATO_ESTADO_CAMBIADO' });
    expect(auco.cancelDocument).toHaveBeenCalledWith('AUCO9', expect.anything());
  });

  it('partes incompletas (un generar concurrente las borró): 500 y no sale nada', async () => {
    enqueue('contratos', ok(contrato()), ok({ destinacion: 'vivienda', storage_key: 'final.pdf' }));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_partes', ok([PARTES[0]]));
    await expect(crearSobre('c1', 'u1')).rejects.toMatchObject({ errorCode: 'CONTRATO_PARTES_INCOMPLETAS' });
  });
});

describe('reenviar', () => {
  it('con el estudio cerrado responde 409 sin tocar nada', async () => {
    enqueue('contratos', ok(contrato({ estado: 'firma_incompleta' })));
    enqueue('expedientes', { data: { ...EXPEDIENTE.data, estado: 'cerrado' }, error: null });
    await expect(reenviar('c1', 'u1')).rejects.toMatchObject({ errorCode: 'EXPEDIENTE_CERRADO' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('con el estudio vencido responde 409 sin tocar nada', async () => {
    enqueue('contratos', ok(contrato({ estado: 'firma_incompleta', datos_variables: { documento: { snapshot: { estudio: { fechaCompletado: '2020-01-01' } } } } })));
    enqueue('expedientes', EXPEDIENTE);
    await expect(reenviar('c1', 'u1')).rejects.toMatchObject({ errorCode: 'CRC_VENCIDO' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('si Auco falla al reenviar, el contrato vuelve a FIRMA INCOMPLETA', async () => {
    enqueue('contratos', ok(contrato({ estado: 'firma_incompleta' })));
    enqueue('expedientes', EXPEDIENTE, EXPEDIENTE);
    // crearSobre: leerContrato + destinacion; partes; sobres
    enqueue('contratos', ok(contrato()), ok({ destinacion: 'vivienda', storage_key: 'final.pdf' }));
    enqueue('contrato_partes', ok(PARTES));
    enqueue(
      'contrato_v3_sobres',
      ok(sobre({ estado: 'incompleto' })),
      ok({ id: 's2' }),
      ok(sobre({ id: 's2', intento: 2, estado: 'creando', auco_code: null })),
      ok([{ id: 's2' }]),
    );
    auco.uploadDocumentForSignature.mockRejectedValue(new Error('Auco caído'));
    await expect(reenviar('c1', 'u1')).rejects.toMatchObject({ errorCode: 'AUCO_UPLOAD_FAILED' });
    expect(ops.filter((o) => o.table === 'rpc:transicionar_contrato').map((o) => o.method)).toEqual(['pendiente_firma', 'firma_incompleta']);
  });
});

describe('reintentar y la vista', () => {
  it('no reintenta si el último proceso está incompleto o firmado por todos (solo fallido/cancelado/ninguno)', async () => {
    enqueue('contratos', ok(contrato()));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_v3_sobres', ok(null), ok(sobre({ estado: 'incompleto' })));
    await expect(reintentar('c1', 'u1')).rejects.toMatchObject({ errorCode: 'FIRMA_YA_EN_CURSO' });

    enqueue('contratos', ok(contrato()));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_v3_sobres', ok({ id: 's1' }), ok(sobre({ estado: 'completo', aviso_entregado_en: HOY })));
    await expect(reintentar('c1', 'u1')).rejects.toMatchObject({ errorCode: 'FIRMA_COMPLETA' });
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });

  it('la vista no ofrece "Reintentar" con el proceso completo, y sí con uno fallido', async () => {
    const vista = async (s: ReturnType<typeof sobre>) => {
      enqueue('contratos', ok(contrato()));
      enqueue('expedientes', EXPEDIENTE);
      enqueue('contrato_v3_sobres', ok(s));
      enqueue('contrato_partes', ok(PARTES));
      return (await estadoEnviado('c1'))!.reintento;
    };
    expect(await vista(sobre({ estado: 'completo' }))).toBe(false);
    expect(await vista(sobre({ estado: 'incompleto' }))).toBe(false);
    expect(await vista(sobre({ estado: 'fallido', auco_code: null }))).toBe(true);
  });

  it('FIANZA ACTIVA: período en curso con la prórroga y el acta pendiente con los datos para el inventario', async () => {
    enqueue('contratos', ok(contrato({
      estado: 'vigente', fecha_inicio: '2020-01-15', duracion_meses: 12, fecha_firma: HOY,
      datos_variables: {
        asistente: { paso2: { amoblado: true }, paso3: { fechaEntrega: '2020-01-20' } },
        documento: { entrada: { inmueble: { direccion: 'Calle 1', municipio: 'Medellín' } }, snapshot: { estudio: { fechaCompletado: HOY } }, final: { ruta: 'A' } },
      },
    })));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'completo' })));
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contrato_archivos', ok([]));
    const e = (await estadoEnviado('c1'))!;
    expect(e.vigencia).toMatchObject({ inicio: '2020-01-15', vencimientoInicial: '2021-01-15' });
    expect(e.vigencia!.prorrogas).toBeGreaterThanOrEqual(5); // hoy es 2026 o después
    expect(e.vigencia!.venceEl >= new Date().toISOString().slice(0, 10)).toBe(true);
    expect(e.acta).toMatchObject({
      pendiente: true,
      archivos: [],
      datos: { fechaEntrega: '2020-01-20', amoblado: true, inmueble: { direccion: 'Calle 1', municipio: 'Medellín' } },
    });
    expect(e.acta!.datos.partes).toEqual([{ rol: 'arrendatario', nombre: 'Ana' }, { rol: 'arrendador', nombre: 'Caro' }]);
  });

  it('TERMINADO: fecha de terminación, sin período en curso y el acta ya cargada', async () => {
    enqueue('contratos', ok(contrato({ estado: 'finalizado', fecha_terminacion: HOY, fecha_inicio: '2026-01-01', duracion_meses: 12 })));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'completo' })));
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contrato_archivos', ok([{ id: 'a1', nombre_archivo: 'acta.pdf', created_at: HOY }]));
    const e = (await estadoEnviado('c1'))!;
    expect(e).toMatchObject({ estado: 'finalizado', fechaTerminacion: HOY, vigencia: null });
    expect(e.acta).toMatchObject({ pendiente: false, archivos: [{ id: 'a1', nombre: 'acta.pdf', subidoEn: HOY }] });
    expect(e.reintento).toBe(false);
  });

  it('cerrado sin acta (Adenda 1 contratos, respuesta 21): el acta no queda pendiente y trae quién, cuándo y por qué', async () => {
    enqueue('contratos', ok(contrato({ estado: 'vigente', fecha_inicio: '2026-01-01', duracion_meses: 12 })));
    enqueue('expedientes', EXPEDIENTE, ok({ cierre_sin_acta_en: HOY, cierre_sin_acta_por: 'ad1', cierre_sin_acta_motivo: 'La inmobiliaria no levantó el acta' }));
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'completo' })));
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contrato_archivos', ok([]));
    enqueue('perfiles', ok({ nombre: 'Ana', apellido: 'Admin' }));
    const e = (await estadoEnviado('c1'))!;
    expect(e.acta).toMatchObject({
      pendiente: false,
      archivos: [],
      cierreSinActa: { en: HOY, porNombre: 'Ana Admin', motivo: 'La inmobiliaria no levantó el acta' },
    });
  });

  it('sin la migración del cierre sin acta (columna inexistente) el acta sigue pendiente y la vista no se cae', async () => {
    enqueue('contratos', ok(contrato({ estado: 'vigente', fecha_inicio: '2026-01-01', duracion_meses: 12 })));
    enqueue('expedientes', EXPEDIENTE, { data: null, error: { code: '42703', message: 'column expedientes.cierre_sin_acta_en does not exist' } });
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'completo' })));
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contrato_archivos', ok([]));
    const e = (await estadoEnviado('c1'))!;
    expect(e.acta).toMatchObject({ pendiente: true, cierreSinActa: null });
  });

  it('EN FIRMA no trae acta ni período (no se lee contrato_archivos)', async () => {
    enqueue('contratos', ok(contrato()));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_v3_sobres', ok(sobre()));
    enqueue('contrato_partes', ok(PARTES));
    const e = (await estadoEnviado('c1'))!;
    expect(e).toMatchObject({ acta: null, vigencia: null });
    expect(ops.some((o) => o.table === 'contrato_archivos')).toBe(false);
  });
});

describe('activación: §12.1', () => {
  it('deja constancia de que el acta de entrega está pendiente y lo dice en el aviso', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'completo', cerrado_en: '2026-09-21T15:30:00.000Z' })));
    enqueue('contratos', ok(contrato()), ok(null));
    enqueue('expedientes', EXPEDIENTE);
    org();
    await reconciliarSobre('s1');
    const eventos = tabla('eventos_timeline', 'insert').map((o) => o.args[0] as { descripcion: string; metadata: Record<string, unknown> });
    expect(eventos.some((ev) => ev.metadata.acta === 'pendiente' && ev.descripcion.startsWith('Acta de entrega e inventario pendiente'))).toBe(true);
    const aviso = (tabla('notificaciones', 'insert')[0].args[0] as Array<{ mensaje: string }>)[0];
    expect(aviso.mensaje).toContain('acta de entrega e inventario');
  });
});

// ── Adenda 1 del módulo de contratos: prórroga (respuesta 10) y acuse (respuesta 11) ──

const ADENDA = { plazo_prorrogado_en: null, auco_expira_en: null, aviso_aceptado_en: null, aviso_aceptado_detalle: null };
const SIN_MIGRACION = { data: null, error: { code: '42703', message: 'column contrato_v3_sobres.plazo_prorrogado_en does not exist' } };
const AVISO = { texto_version: 'e5-11.7.4-v2', texto: 'La fianza de COFIANZA S.A.S. NO está operando…', destinatarios: ['m1'] };
const incompleto = (x: Record<string, unknown> = {}) =>
  sobre({ estado: 'incompleto', motivo: 'EXPIRED', aviso_entregado_en: HOY, aviso_detalle: AVISO, ...x });

describe('prorrogarPlazo', () => {
  const preparar = (s = sobre(), adenda: Record<string, unknown> = ok(ADENDA), c = contrato()) => {
    enqueue('contratos', ok(c));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_v3_sobres', ok(s), adenda);
  };

  it('una vez, otros 15 días hasta la medianoche, con la marca como candado y en la línea de tiempo', async () => {
    preparar();
    enqueue('contrato_v3_sobres', ok([{ id: 's1' }]));
    await prorrogarPlazo('c1', 'u1');
    const upd = tabla('contrato_v3_sobres', 'update')[0].args[0] as Record<string, unknown>;
    expect(upd).toMatchObject({ expira_en: finDeDiaEn(15, Date.parse(EN_10_DIAS)), plazo_prorrogado_por: 'u1' });
    const filtros = ops.filter((o) => o.table === 'contrato_v3_sobres' && ['is', 'eq', 'gt'].includes(o.method)).map((o) => [o.method, ...o.args]);
    expect(filtros).toContainEqual(['is', 'plazo_prorrogado_en', null]);
    expect(filtros).toContainEqual(['eq', 'estado', 'en_firma']);
    // Nunca sobre un plazo que venció entre la lectura y la escritura.
    expect(filtros).toContainEqual(['gt', 'expira_en', expect.any(String)]);
    expect((tabla('eventos_timeline', 'insert')[0].args[0] as { descripcion: string }).descripcion).toContain('prorrogado hasta el');
    expect(efectos.logAudit).toHaveBeenCalledWith(expect.objectContaining({ accion: 'firma_plazo_prorrogado' }));
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled(); // Auco ya vence en el máximo
  });

  it('tampoco pasa el vencimiento que se le mandó a Auco (allá no se puede mover)', async () => {
    const vencimientoAuco = new Date(Date.parse(EN_10_DIAS) + 3 * DIA).toISOString();
    preparar(sobre(), ok({ ...ADENDA, auco_expira_en: vencimientoAuco }));
    enqueue('contrato_v3_sobres', ok([{ id: 's1' }]));
    await prorrogarPlazo('c1', 'u1');
    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toMatchObject({ expira_en: vencimientoAuco });
  });

  it('la segunda vez responde 409 sin tocar el plazo', async () => {
    preparar(sobre(), ok({ ...ADENDA, plazo_prorrogado_en: HOY }));
    await expect(prorrogarPlazo('c1', 'u1')).rejects.toMatchObject({ errorCode: 'PRORROGA_YA_USADA' });
    expect(tabla('contrato_v3_sobres', 'update')).toEqual([]);
  });

  it('sin margen de CRC no hay prórroga, y dice por qué', async () => {
    const completado = new Date(Date.now() - 55 * DIA).toISOString(); // el CRC vence antes que el plazo actual
    preparar(sobre(), ok(ADENDA), contrato({ datos_variables: { documento: { snapshot: { estudio: { fechaCompletado: completado } } } } }));
    const e = await prorrogarPlazo('c1', 'u1').catch((x: unknown) => x);
    expect(e).toMatchObject({ errorCode: 'PRORROGA_NO_PERMITIDA', message: expect.stringContaining('vigencia del certificado de riesgo') });
    expect(tabla('contrato_v3_sobres', 'update')).toEqual([]);
  });

  it('fuera de EN FIRMA, o sin la migración, no prorroga', async () => {
    enqueue('contratos', ok(contrato({ estado: 'firma_incompleta' })));
    enqueue('expedientes', EXPEDIENTE);
    await expect(prorrogarPlazo('c1', 'u1')).rejects.toMatchObject({ errorCode: 'SIN_SOBRE_ACTIVO' });
    preparar(sobre(), SIN_MIGRACION);
    await expect(prorrogarPlazo('c1', 'u1')).rejects.toMatchObject({ statusCode: 503, errorCode: 'PRORROGA_NO_DISPONIBLE' });
    expect(tabla('contrato_v3_sobres', 'update')).toEqual([]);
  });

  it('la vista ofrece la prórroga con el plazo nuevo; usada, dice cuándo', async () => {
    const vista = async (adenda: Record<string, unknown>) => {
      enqueue('contratos', ok(contrato()));
      enqueue('expedientes', EXPEDIENTE);
      enqueue('contrato_v3_sobres', ok(sobre()), adenda);
      enqueue('contrato_partes', ok(PARTES));
      return (await estadoEnviado('c1'))!.prorroga;
    };
    expect(await vista(ok(ADENDA))).toEqual({ puede: true, motivo: null, hasta: finDeDiaEn(15, Date.parse(EN_10_DIAS)), usadaEn: null });
    expect(await vista(ok({ ...ADENDA, plazo_prorrogado_en: HOY }))).toEqual({ puede: false, motivo: null, hasta: null, usadaEn: HOY });
    expect(await vista(SIN_MIGRACION)).toMatchObject({ puede: false, motivo: expect.stringContaining('no está disponible') });
  });
});

describe('acuse del aviso de firma incompleta', () => {
  const MIEMBRO = { id: 'm1', rol: 'inmobiliaria', email: 'carla@inmo.co', ip: '1.2.3.4' };
  const preparar = (s = incompleto()) => {
    enqueue('contratos', ok(contrato({ estado: 'firma_incompleta' })));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_v3_sobres', ok({ id: 's1' }), ok(s)); // ultimoIncompleto: id y sobre
  };

  it('un miembro de la inmobiliaria lo acepta: queda quién, cuándo, desde dónde y qué texto', async () => {
    preparar();
    enqueue('perfiles', ok({ nombre: 'Carla', apellido: 'Ríos' }));
    enqueue('contrato_v3_sobres', ok([{ id: 's1' }]));
    await aceptarAviso('c1', MIEMBRO);
    const upd = tabla('contrato_v3_sobres', 'update')[0].args[0] as Record<string, unknown>;
    expect(upd).toMatchObject({
      aviso_aceptado_por: 'm1',
      aviso_aceptado_en: expect.any(String),
      aviso_aceptado_detalle: { nombre: 'Carla Ríos', email: 'carla@inmo.co', rolMiembro: 'owner', ip: '1.2.3.4', textoVersion: 'e5-11.7.4-v2' },
    });
    // Nunca se reescribe el acuse de otro miembro.
    expect(ops.filter((o) => o.table === 'contrato_v3_sobres' && o.method === 'is').map((o) => o.args)).toContainEqual(['aviso_aceptado_en', null]);
    expect((tabla('eventos_timeline', 'insert')[0].args[0] as { descripcion: string }).descripcion).toContain('Carla Ríos aceptó el aviso');
  });

  it('Cofianza o alguien de otra inmobiliaria no lo aceptan por ella: 403', async () => {
    preparar();
    await expect(aceptarAviso('c1', { ...MIEMBRO, id: 'ad1', rol: 'administrador' })).rejects.toMatchObject({ statusCode: 403 });
    preparar();
    await expect(aceptarAviso('c1', { ...MIEMBRO, id: 'x9' })).rejects.toMatchObject({ errorCode: 'AVISO_SOLO_INMOBILIARIA' });
    expect(tabla('contrato_v3_sobres', 'update')).toEqual([]);
  });

  it('sin el aviso entregado todavía no hay nada que aceptar; sin la migración, 503', async () => {
    preparar(incompleto({ aviso_entregado_en: null, aviso_detalle: null }));
    await expect(aceptarAviso('c1', MIEMBRO)).rejects.toMatchObject({ errorCode: 'AVISO_NO_ENTREGADO' });
    preparar();
    enqueue('perfiles', ok({ nombre: 'Carla', apellido: 'Ríos' }));
    enqueue('contrato_v3_sobres', { data: null, error: { code: 'PGRST204', message: "Could not find the 'aviso_aceptado_en' column" } });
    await expect(aceptarAviso('c1', MIEMBRO)).rejects.toMatchObject({ statusCode: 503, errorCode: 'ACUSE_NO_DISPONIBLE' });
  });

  it('la vista muestra quién lo aceptó y cuándo', async () => {
    enqueue('contratos', ok(contrato({ estado: 'firma_incompleta' })));
    enqueue('expedientes', EXPEDIENTE);
    enqueue(
      'contrato_v3_sobres',
      ok(incompleto()), // último sobre
      ok({ id: 's1' }),
      ok(incompleto()), // último incompleto
      ok({ ...ADENDA, aviso_aceptado_en: HOY, aviso_aceptado_detalle: { nombre: 'Carla Ríos' } }),
    );
    enqueue('contrato_partes', ok(PARTES));
    const e = (await estadoEnviado('c1'))!;
    expect(e.aviso).toEqual({ texto: AVISO.texto, entregadoEn: HOY, aceptado: { nombre: 'Carla Ríos', en: HOY } });
    expect(e.acuseDisponible).toBe(true);
    expect(e.prorroga).toBeNull();
  });

  it('sin la migración la vista dice que el acuse no está disponible (la web no bloquea ni ofrece el botón)', async () => {
    enqueue('contratos', ok(contrato({ estado: 'firma_incompleta' })));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_v3_sobres', ok(incompleto()), ok({ id: 's1' }), ok(incompleto()), SIN_MIGRACION);
    enqueue('contrato_partes', ok(PARTES));
    const e = (await estadoEnviado('c1'))!;
    expect(e.acuseDisponible).toBe(false);
    expect(e.aviso).toMatchObject({ texto: AVISO.texto, aceptado: null });
  });

  describe('sin acuse, la inmobiliaria no reenvía, no cancela ni cierra el estudio', () => {
    const estadoIncompleto = () => {
      enqueue('contratos', ok(contrato({ estado: 'firma_incompleta' })));
      enqueue('expedientes', EXPEDIENTE);
    };

    it('reenviar: 409 AVISO_SIN_ACUSE antes de tocar el contrato', async () => {
      estadoIncompleto();
      enqueue('contrato_v3_sobres', ok({ id: 's1' }), ok(incompleto()), ok(ADENDA));
      await expect(reenviar('c1', 'm1', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 409, errorCode: 'AVISO_SIN_ACUSE' });
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('con el acuse, o si actúa Cofianza, sigue (la transición es lo siguiente)', async () => {
      estadoIncompleto();
      enqueue('contrato_v3_sobres', ok({ id: 's1' }), ok(incompleto()), ok({ ...ADENDA, aviso_aceptado_en: HOY }));
      enqueue('rpc:transicionar_contrato', { data: null, error: { message: 'Transicion no permitida' } });
      await expect(reenviar('c1', 'm1', 'inmobiliaria')).rejects.toMatchObject({ errorCode: 'CONTRATO_ESTADO_CAMBIADO' });
      estadoIncompleto();
      enqueue('rpc:transicionar_contrato', { data: null, error: { message: 'Transicion no permitida' } });
      await expect(reenviar('c1', 'ad1', 'administrador')).rejects.toMatchObject({ errorCode: 'CONTRATO_ESTADO_CAMBIADO' });
      expect(mockRpc).toHaveBeenCalledTimes(2);
    });

    it('cerrar el estudio: la misma puerta; sin la migración no frena (sigue como antes)', async () => {
      enqueue('contratos', ok([{ id: 'c1', estado: 'firma_incompleta' }]));
      enqueue('contrato_v3_sobres', ok({ id: 's1' }), ok(incompleto()), ok(ADENDA));
      await expect(exigirAcuseDelEstudio('e1', 'inmobiliaria')).rejects.toMatchObject({ errorCode: 'AVISO_SIN_ACUSE' });

      enqueue('contratos', ok([{ id: 'c1', estado: 'firma_incompleta' }]));
      enqueue('contrato_v3_sobres', ok({ id: 's1' }), ok(incompleto()), SIN_MIGRACION);
      await exigirAcuseDelEstudio('e1', 'inmobiliaria');

      ops.length = 0;
      await exigirAcuseDelEstudio('e1', 'operador_analista');
      expect(ops).toEqual([]);
    });

    it('con el aviso todavía sin entregar pide esperar, no el acuse; sin la migración no pide nada', async () => {
      estadoIncompleto();
      enqueue('contrato_v3_sobres', ok({ id: 's1' }), ok(incompleto({ aviso_entregado_en: null, aviso_detalle: null })), ok(ADENDA));
      await expect(reenviar('c1', 'm1', 'inmobiliaria')).rejects.toMatchObject({ errorCode: 'AVISO_NO_ENTREGADO' });

      estadoIncompleto();
      enqueue('contrato_v3_sobres', ok({ id: 's1' }), ok(incompleto({ aviso_entregado_en: null, aviso_detalle: null })), SIN_MIGRACION);
      enqueue('rpc:transicionar_contrato', { data: null, error: { message: 'Transicion no permitida' } });
      await expect(reenviar('c1', 'm1', 'inmobiliaria')).rejects.toMatchObject({ errorCode: 'CONTRATO_ESTADO_CAMBIADO' }); // pasó la puerta
    });

    it('si no se puede leer el sobre del aviso, falla cerrado (503), nunca deja pasar sin acuse', async () => {
      estadoIncompleto();
      enqueue('contrato_v3_sobres', { data: null, error: { message: 'timeout' } });
      await expect(reenviar('c1', 'm1', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });
});

describe('Adenda 1 (respuesta 10): una firma fuera del plazo no activa la fianza', () => {
  const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  /** Roadmap con las dos firmas: la del arrendador (la última) a la hora dada. */
  const firmas = (ultima: string) => ({
    participants: [{ id: '01', phone: '+573001112233' }, { id: '02', phone: '+573004445566' }],
    activityLog: [
      { action: 'PARTICIPANT_SIGN', participant: '01', timestamp: hace(180) },
      { action: 'PARTICIPANT_SIGN', participant: '02', timestamp: ultima },
    ],
  });
  beforeEach(() => {
    auco.getDocumentStatus.mockReset();
    auco.getDocumentRoadmap.mockReset();
  });

  it('la última firma 30 min después del plazo (más que la tolerancia de reloj): FIRMA INCOMPLETA con su aviso', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ expira_en: hace(60) })), ok([{ id: 's1' }]));
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contratos', ok(contrato()), ok(contrato()), ok({ estado: 'firma_incompleta' }));
    enqueue('expedientes', EXPEDIENTE, EXPEDIENTE);
    org();
    auco.getDocumentStatus.mockResolvedValue(statusFinish);
    auco.getDocumentRoadmap.mockResolvedValue(firmas(hace(30)));

    await reconciliarSobre('s1');

    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toMatchObject({
      estado: 'incompleto',
      motivo: 'FUERA_PLAZO',
      motivo_detalle: expect.stringContaining('la última firma fue el'),
    });
    expect(tabla('rpc:transicionar_contrato', 'vigente')).toHaveLength(0);
    expect(tabla('rpc:transicionar_contrato', 'firma_incompleta')).toHaveLength(1);
    const aviso = (tabla('notificaciones', 'insert')[0].args[0] as Array<{ tipo: string; mensaje: string }>)[0];
    expect(aviso).toMatchObject({ tipo: 'contrato.firma_incompleta', mensaje: expect.stringContaining('después del plazo para firmar') });
  });

  it('dentro de la tolerancia de reloj (5 min después del plazo) sí activa', async () => {
    enqueue('contrato_v3_sobres', ok(sobre({ expira_en: hace(60) })), ok([{ id: 's1' }]));
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contratos', ok(contrato()), ok(contrato()), ok(null));
    enqueue('expedientes', EXPEDIENTE, EXPEDIENTE);
    org();
    auco.getDocumentStatus.mockResolvedValue(statusFinish);
    auco.getDocumentRoadmap.mockResolvedValue(firmas(hace(55)));

    await reconciliarSobre('s1');

    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toMatchObject({ estado: 'completo' });
    expect(tabla('rpc:transicionar_contrato', 'vigente')).toHaveLength(1);
  });

  it('en ningún caso después del fin del CRC, ni dentro de la tolerancia', async () => {
    const plazo = hace(60); // el plazo era el fin del CRC
    const conCrc = contrato({ datos_variables: { documento: { snapshot: { estudio: { fechaCompletado: HOY }, crc: { fechaVencimiento: plazo } } } } });
    enqueue('contrato_v3_sobres', ok(sobre({ expira_en: plazo })), ok([{ id: 's1' }]));
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contratos', ok(conCrc), ok(conCrc), ok({ estado: 'firma_incompleta' }));
    enqueue('expedientes', EXPEDIENTE, EXPEDIENTE);
    org();
    auco.getDocumentStatus.mockResolvedValue(statusFinish);
    auco.getDocumentRoadmap.mockResolvedValue(firmas(hace(55)));

    await reconciliarSobre('s1');

    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toMatchObject({ estado: 'incompleto', motivo: 'FUERA_PLAZO' });
    expect(tabla('rpc:transicionar_contrato', 'vigente')).toHaveLength(0);
  });

  it('reenviar con menos de 3 días de CRC: 409 antes de tocar el contrato, y la vista dice por qué', async () => {
    const cercano = contrato({
      estado: 'firma_incompleta',
      datos_variables: { documento: { snapshot: { estudio: { fechaCompletado: HOY }, crc: { fechaVencimiento: new Date(Date.now() + 2 * DIA).toISOString() } } } },
    });
    enqueue('contratos', ok(cercano));
    enqueue('expedientes', EXPEDIENTE);
    await expect(reenviar('c1', 'ad1', 'administrador')).rejects.toMatchObject({ statusCode: 409, errorCode: 'CRC_SIN_MARGEN' });
    expect(mockRpc).not.toHaveBeenCalled();

    enqueue('contratos', ok(cercano));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_v3_sobres', ok(incompleto()), ok({ id: 's1' }), ok(incompleto()), ok(ADENDA));
    enqueue('contrato_partes', ok(PARTES));
    expect((await estadoEnviado('c1'))!.reenvio).toEqual({
      puede: false,
      motivo: expect.stringMatching(/menos de tres días.*cancela el contrato/),
    });
  });
});

describe('Ruta B con firmas (Adenda 1, respuesta 6): label + position con las marcas congeladas', () => {
  const PAG = { ancho: 500, alto: 750, rotacion: 0 };
  /** Congeladas al enviar: el arrendatario en la pág. 2 (y sus iniciales en la 1), el arrendador en la 2. */
  const CONGELADAS = {
    marcas: [
      { parte: 'arrendatario', pagina: 2, x: 0.2, y: 0.9 },
      { parte: 'arrendatario', pagina: 1, x: 0.5, y: 0.95 },
      { parte: 'arrendador', pagina: 2, x: 0.7, y: 0.9 },
    ],
    paginas: { 1: PAG, 2: PAG },
  };
  /** firmasPropio null = sin marcas congeladas. */
  const rutaB = (x: Record<string, unknown> = {}, firmasPropio: unknown = CONGELADAS) =>
    contrato({
      datos_variables: {
        documento: { snapshot: { estudio: { fechaCompletado: HOY } }, final: { ruta: 'B', firmasPropio } },
        // Las del borrador no cuentan fuera de borrador: manda lo congelado en documento.final.
        propio: { firmas: [{ parte: 'arrendatario', pagina: 1, x: 0.1, y: 0.1 }] },
      },
      ...x,
    });
  const pos = (page: number, x: number, y: number) => ({ page, x, y, w: 150, h: 50 });
  const POSICIONES = [[pos(2, 0.35, 0.9), pos(1, 0.65, 0.95)], [pos(2, 0.85, 0.9)]];
  const subido = () => (auco.uploadDocumentForSignature.mock.calls[0] as [{ signProfile: Array<{ name: string; label: boolean; position?: unknown }> }])[0];

  it('crearSobre: cada firmante con label (anclas del Anexo) y position (sus rayas del PDF propio)', async () => {
    enqueue('contratos', ok(rutaB()), ok({ destinacion: 'vivienda', storage_key: 'final.pdf' }));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_partes', ok(PARTES));
    enqueue('contrato_v3_sobres', ok(null), ok({ id: 's1' }), ok(sobre({ estado: 'creando', auco_code: null })), ok([{ id: 's1' }]), ok(sobre()));
    auco.uploadDocumentForSignature.mockResolvedValue('AUCO9');
    await crearSobre('c1', 'u1');
    expect(subido().signProfile.map((p) => [p.name, p.label, p.position])).toEqual([
      ['Ana', true, POSICIONES[0]],
      ['Caro', true, POSICIONES[1]],
    ]);
  });

  it('crearSobre sin las marcas congeladas (o incompletas): 409 con quién falta, sin sobre ni Auco', async () => {
    for (const congeladas of [null, { ...CONGELADAS, marcas: CONGELADAS.marcas.filter((m) => m.parte !== 'arrendador') }]) {
      enqueue('contratos', ok(rutaB({}, congeladas)), ok({ destinacion: 'vivienda', storage_key: 'final.pdf' }));
      enqueue('expedientes', EXPEDIENTE);
      enqueue('contrato_partes', ok(PARTES));
      await expect(crearSobre('c1', 'u1')).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'RUTA_B_FIRMAS_INCOMPLETAS',
        message: expect.stringContaining('Arrendador (Caro)'),
      });
    }
    expect(tabla('contrato_v3_sobres', 'insert')).toEqual([]);
    expect(auco.uploadDocumentForSignature).not.toHaveBeenCalled();
  });

  it('reenviar: el proceso nuevo lleva exactamente las posiciones congeladas', async () => {
    enqueue('contratos', ok(rutaB({ estado: 'firma_incompleta' })));
    enqueue('expedientes', EXPEDIENTE, EXPEDIENTE);
    enqueue('contratos', ok(rutaB()), ok({ destinacion: 'vivienda', storage_key: 'final.pdf' }));
    enqueue('contrato_partes', ok(PARTES), ok(PARTES)); // la revisión previa del reenvío y la de crearSobre
    enqueue(
      'contrato_v3_sobres',
      ok(sobre({ estado: 'incompleto' })),
      ok({ id: 's2' }),
      ok(sobre({ id: 's2', intento: 2, estado: 'creando', auco_code: null })),
      ok([{ id: 's2' }]),
      ok(sobre({ id: 's2', intento: 2 })),
    );
    auco.uploadDocumentForSignature.mockResolvedValue('AUCO10');
    await reenviar('c1', 'u1');
    expect(subido().signProfile.map((p) => p.position)).toEqual(POSICIONES);
  });

  it('reenviar sin las marcas congeladas: 409 antes de tocar el contrato', async () => {
    enqueue('contratos', ok(rutaB({ estado: 'firma_incompleta' }, null)));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_partes', ok(PARTES));
    await expect(reenviar('c1', 'ad1', 'administrador')).rejects.toMatchObject({ errorCode: 'RUTA_B_FIRMAS_INCOMPLETAS' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('la vista ofrece reenviar y reintentar con las marcas completas; sin ellas, dice qué falta', async () => {
    const vista = async (c: ReturnType<typeof contrato>) => {
      enqueue('contratos', ok(c));
      enqueue('expedientes', EXPEDIENTE);
      enqueue('contrato_v3_sobres', ok(incompleto()), ok({ id: 's1' }), ok(incompleto()), ok(ADENDA));
      enqueue('contrato_partes', ok(PARTES));
      return (await estadoEnviado('c1'))!;
    };
    expect((await vista(rutaB({ estado: 'firma_incompleta' }))).reenvio).toEqual({ puede: true, motivo: null });
    expect((await vista(rutaB({ estado: 'firma_incompleta' }, null))).reenvio).toEqual({
      puede: false,
      motivo: expect.stringContaining('Falta ubicar en el contrato de la inmobiliaria dónde firma: Arrendatario (Ana), Arrendador (Caro)'),
    });

    enqueue('contratos', ok(rutaB()));
    enqueue('expedientes', EXPEDIENTE);
    enqueue('contrato_v3_sobres', ok(sobre({ estado: 'fallido', auco_code: null })));
    enqueue('contrato_partes', ok(PARTES));
    expect((await estadoEnviado('c1'))!.reintento).toBe(true);
  });
});

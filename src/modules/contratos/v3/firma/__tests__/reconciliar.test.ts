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
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'or', 'order', 'limit'];
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
    mockEnv: { AUCO_SENDER_EMAIL: 'firma@cofianza.co', AUCO_WEBHOOK_SECRET: undefined as string | undefined, FIRMA_BIOMETRIA_ENABLED: false },
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
  AUDIT_ACTIONS: { FIRMA_COMPLETADA: 'firma_completada', FIRMA_SOLICITUD_CREATED: 'firma_solicitud_created' },
  AUDIT_ENTITIES: { CONTRATO: 'contrato' },
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

import { cancelarFirmaV3, crearSobre, estadoEnviado, reenviar, reintentar } from '../firma.service';
import { reconciliarSobre, webhookAucoV3 } from '../reconciliar';

// ── Datos ──

const HOY = new Date().toISOString();
const PARTES = [
  { id: 'p1', rol: 'arrendatario', orden: 1, nombre: 'Ana', tipo_documento: 'cc', numero_documento: '1', email: 'ana@x.co', telefono: '3001112233' },
  { id: 'p2', rol: 'arrendador', orden: 2, nombre: 'Inmo', tipo_documento: 'nit', numero_documento: '9', email: 'inmo@x.co', telefono: '3004445566',
    representante_legal_nombre: 'Caro', representante_legal_tipo_documento: 'cc', representante_legal_documento: '5' },
];
const sobre = (x: Record<string, unknown> = {}) => ({
  id: 's1', contrato_id: 'c1', intento: 1, estado: 'en_firma', auco_code: 'AUCO1', expira_en: HOY,
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
    enqueue('contratos', ok(contrato()), ok(null)); // leerContrato, update fecha_firma
    enqueue('expedientes', EXPEDIENTE);
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
    expect(constancia).toMatchObject({ aviso_detalle: { texto_version: 'e5-11.7.4-v2' } });
    // §11.7.3: los links de garantía y primer canon creados EN FIRMA se anulan.
    expect(tabla('efecto', 'cancelar-pagos')[0].args).toEqual(['e1', expect.any(String), ['garantia', 'primer_canon']]);
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
    const dias = (Date.parse(String(input.expiredDate)) - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(14.9);
    expect(tabla('contrato_v3_sobres', 'update')[0].args[0]).toEqual({ auco_code: 'AUCO9', estado: 'en_firma' });
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

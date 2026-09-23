import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Adenda 2 §9 — verificacion de identidad antes de la firma. Mismo mock de
// Supabase que autorizaciones/coarrendatarios: colas de resultados POR TABLA
// y `ops` para afirmar QUE se escribio. Una tabla sin cola responde
// { data: null, error: null }.
// ============================================================

const {
  mockFrom,
  ops,
  queues,
  enqueue,
  mockCotejar,
  mockCrearSobre,
  mockDerivar,
  mockEvaluar,
  mockSendFirmaEmail,
  mockNotificar,
  mockTransicion,
  mockListOperators,
  mockUpload,
  v3,
} = vi.hoisted(() => {
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
    mockCotejar: vi.fn(),
    mockCrearSobre: vi.fn(async () => ({ solicitud_id: 's1' })),
    mockDerivar: vi.fn(),
    mockEvaluar: vi.fn(() => ({ puede_enviar: true })),
    mockSendFirmaEmail: vi.fn(async () => undefined),
    mockNotificar: vi.fn(async () => undefined),
    mockTransicion: vi.fn(async () => ({})),
    mockListOperators: vi.fn(async () => [{ id: 'analista-1', rol: 'operador_analista' }]),
    mockUpload: vi.fn(async () => 'AUCO1'),
    // Lecturas del módulo de firma V3 (reconciliar.ts); la lógica de firma.service corre de verdad.
    v3: {
      leerContrato: vi.fn(async () => ({
        id: 'c1', estado: 'pendiente_firma', numero: 'CTO-2026-0001', expediente_id: 'e1', fecha_firma: null,
        datos_variables: { documento: { final: { ruta: 'A' } } }, inmuebleId: null, orgId: null,
      })),
      leerPartes: vi.fn(),
      leerSobre: vi.fn(async () => ({ id: 's1', intento: 1, estado: 'creando' })),
      ultimoSobre: vi.fn(async () => null),
    },
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (t: string) => mockFrom(t),
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null }) }) },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({
  env: { FRONTEND_URL: 'https://www.cofianza.co', FIRMA_BIOMETRIA_ENABLED: true, AUCO_SENDER_EMAIL: 'firma@cofianza.co' },
}));
vi.mock('@/lib/auditLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auditLog')>()),
  logAudit: vi.fn(),
}));
vi.mock('@/lib/calibracion', () => ({
  getCalibracion: vi.fn(async () => ({ UMBRAL_SIMILITUD_BIOMETRICA: 80, DIAS_EXPIRACION_FIRMA: 15 })),
}));
vi.mock('@/lib/auco', async (orig) => ({
  ...(await orig<typeof import('@/lib/auco')>()),
  uploadDocumentForSignature: (...a: unknown[]) => mockUpload(...a),
  cancelDocument: vi.fn(),
  getDocumentStatus: vi.fn(),
}));
vi.mock('@/modules/contratos/v3/firma/reconciliar', () => ({
  ...v3,
  reconciliarSobre: vi.fn(),
  transicionar: vi.fn(),
  // CRC vigente: el proceso de firma no puede pasar su vigencia (Adenda 1 del módulo de contratos).
  vigenciaEstudio: vi.fn(async () => ({ fin: Date.parse('2099-12-31T23:59:59-05:00') })),
}));
vi.mock('@/lib/email', () => ({ sendFirmaEmail: (...a: unknown[]) => mockSendFirmaEmail(...a) }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: (...a: unknown[]) => mockNotificar(...a),
}));
vi.mock('@/modules/users/users.service', () => ({ listOperators: (...a: unknown[]) => mockListOperators(...a) }));
vi.mock('@/modules/autorizaciones/biometria', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/autorizaciones/biometria')>()),
  cotejarConAuco: (...a: unknown[]) => mockCotejar(...a),
}));
vi.mock('../firma-multiparte.service', () => ({
  derivarFirmantes: (...a: unknown[]) => mockDerivar(...a),
  evaluarFirmantes: (...a: unknown[]) => mockEvaluar(...a),
  crearSolicitudFirmaMultiparte: (...a: unknown[]) => mockCrearSobre(...a),
  // Los usa la firma V3 (reglas.construirSignProfile).
  mapTipoDocumentoToAuco: () => 'CC',
  aucoDeriveCountry: () => 'CO',
}));
vi.mock('@/modules/contratos/contrato-workflow.service', () => ({
  executeContratoTransition: (...a: unknown[]) => mockTransicion(...a),
}));

// Import AFTER mocks
import {
  iniciarVerificacionIdentidad,
  registrarConsentimiento,
  verificarBiometriaFirma,
  continuarSinVerificar,
  listarVerificaciones,
  revisarVerificacion,
  CONSENTIMIENTO_FIRMA,
} from '../verificacion-identidad.service';

const T = 'firma_verificacion_identidad';
const TOKEN = 'a'.repeat(64);
const FUTURO = new Date(Date.now() + 3600_000).toISOString();

const fila = (extra: Record<string, unknown> = {}) => ({
  data: {
    id: 'v1',
    contrato_id: 'c1',
    nombre: 'Ana Pérez',
    tipo_documento: 'CC',
    numero_documento: '1020304050',
    token_expiracion: FUTURO,
    enviado_por: 'gestor-1',
    estado: 'pendiente',
    opcion: null,
    resultado: null,
    revision: null,
    ...extra,
  },
  error: null,
});

const resumen = (estado: string, similitud: number | null, extra: Record<string, unknown> = {}) => ({
  fuente: 'aucoface',
  estado,
  code: 'AUCO-1',
  verificado_en: new Date().toISOString(),
  similitud,
  umbral: 80,
  motivo: estado === 'no_coincide' ? `La foto no coincide con el documento (similitud ${similitud}%, minimo 80%)` : null,
  documento_coincide: true,
  documento_ocr_masked: '*******050',
  nombre_ocr: null,
  ...extra,
});

const updatesDe = (table: string) => ops.filter((o) => o.table === table && o.method === 'update').map((o) => o.args[0] as Record<string, unknown>);

beforeEach(() => {
  ops.length = 0;
  queues.clear();
  vi.clearAllMocks();
  enqueue('contratos', { data: { expedientes: { numero: 'EXP-2026-0010', inmuebles: { direccion: 'Cra 7 # 45-10', ciudad: 'Bogotá' } } }, error: null });
});

describe('iniciarVerificacionIdentidad (Enviar a firma con biometria)', () => {
  it('sin fila: la crea con token y le escribe al arrendatario — el sobre NO sale todavia', async () => {
    mockDerivar.mockResolvedValue([
      { rol_firmante: 'arrendatario', nombre: 'Ana Pérez', email: 'ana@correo.co', tipo_documento: 'CC', numero_documento: '1020304050' },
    ]);
    const r = await iniciarVerificacionIdentidad('c1', 'gestor-1');

    expect(r.pendiente).toBe(true);
    const insert = ops.find((o) => o.table === T && o.method === 'insert')!.args[0] as Record<string, string>;
    expect(insert).toMatchObject({ contrato_id: 'c1', rol: 'arrendatario', email: 'ana@correo.co', enviado_por: 'gestor-1' });
    expect(insert.token).toHaveLength(64);
    expect(mockSendFirmaEmail).toHaveBeenCalledWith(
      'ana@correo.co',
      'Ana Pérez',
      `https://www.cofianza.co/verificar-identidad/${insert.token}`,
      72,
      expect.anything(),
      expect.objectContaining({ boton: 'Confirmar mi identidad' }),
    );
    expect(mockCrearSobre).not.toHaveBeenCalled();
  });

  it('ya verificada: no reenvia nada y deja salir el sobre', async () => {
    enqueue(T, { data: { id: 'v1', estado: 'no_coincide' }, error: null });
    const r = await iniciarVerificacionIdentidad('c1', 'gestor-1');
    expect(r.pendiente).toBe(false);
    expect(mockSendFirmaEmail).not.toHaveBeenCalled();
  });

  it('firmante sin telefono: falla ANTES de que el arrendatario se tome la foto', async () => {
    mockDerivar.mockResolvedValue([{ rol_firmante: 'arrendatario', nombre: 'Ana', email: 'ana@correo.co' }]);
    mockEvaluar.mockReturnValueOnce({ puede_enviar: false });
    await expect(iniciarVerificacionIdentidad('c1', 'gestor-1')).rejects.toMatchObject({ errorCode: 'FIRMANTE_DATOS_INCOMPLETOS' });
    expect(ops.some((o) => o.table === T && o.method === 'insert')).toBe(false);
  });
});

describe('pagina publica: consentimiento §9.2/§9.3', () => {
  it('"prefiero un analista": registra la evidencia, avisa a los analistas y el sobre sale igual', async () => {
    enqueue(T, fila(), { data: null, error: null }, { data: [{ id: 'v1' }], error: null });
    const r = await registrarConsentimiento(TOKEN, 'analista', { ip: '181.1.2.3', dispositivo: 'Mozilla/5.0 (iPhone)' });

    expect(r.completada).toBe(true);
    const [evidencia, cierre] = updatesDe(T);
    expect(evidencia).toMatchObject({
      opcion: 'analista',
      ip: '181.1.2.3',
      dispositivo: 'Mozilla/5.0 (iPhone)',
      texto_version: CONSENTIMIENTO_FIRMA.version,
    });
    expect(evidencia.texto).toContain(CONSENTIMIENTO_FIRMA.opciones.analista);
    expect(evidencia.opcion_en).toBeTruthy();
    expect(cierre.estado).toBe('omitida');
    expect(mockNotificar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'analista-1', tipo: 'firma.identidad_revision' }));
    expect(mockCrearSobre).toHaveBeenCalledWith('c1', 'gestor-1');
  });

  it('"autorizo": registra la evidencia y espera las fotos (no cierra ni saca el sobre)', async () => {
    enqueue(T, fila());
    const r = await registrarConsentimiento(TOKEN, 'autoriza', { ip: '181.1.2.3' });
    expect(r.completada).toBe(false);
    expect(updatesDe(T)).toHaveLength(1);
    expect(mockCrearSobre).not.toHaveBeenCalled();
  });

  it('enlace vencido: 410', async () => {
    enqueue(T, fila({ token_expiracion: new Date(Date.now() - 1000).toISOString() }));
    await expect(registrarConsentimiento(TOKEN, 'autoriza', {})).rejects.toMatchObject({ statusCode: 410 });
  });
});

describe('pagina publica: cotejo (umbral del panel, nunca rechaza)', () => {
  const imgs = { documentImage: 'data:image/jpeg;base64,AAA', photo: 'data:image/jpeg;base64,BBB' };

  it('sin haber autorizado no se coteja', async () => {
    enqueue(T, fila());
    await expect(verificarBiometriaFirma(TOKEN, imgs)).rejects.toMatchObject({ errorCode: 'SIN_CONSENTIMIENTO' });
    expect(mockCotejar).not.toHaveBeenCalled();
  });

  it('cotejo limpio: cierra como verificada, sin analista, y sale el sobre', async () => {
    enqueue(T, fila({ opcion: 'autoriza' }), { data: [{ id: 'v1' }], error: null });
    mockCotejar.mockResolvedValue(resumen('verificada', 91.4));
    const r = await verificarBiometriaFirma(TOKEN, imgs);

    expect(mockCotejar).toHaveBeenCalledWith('v1', expect.objectContaining({ numero_documento: '1020304050' }), 80);
    expect(r).toEqual({ completada: true, motivo: null });
    expect(updatesDe(T)[0].estado).toBe('verificada');
    expect(mockNotificar).not.toHaveBeenCalled();
    expect(mockCrearSobre).toHaveBeenCalledWith('c1', 'gestor-1');
  });

  it('no coincide: NO cierra (puede reintentar), guarda el intento y no le muestra el porcentaje', async () => {
    enqueue(T, fila({ opcion: 'autoriza' }));
    mockCotejar.mockResolvedValue(resumen('no_coincide', 62));
    const r = await verificarBiometriaFirma(TOKEN, imgs);

    expect(r.completada).toBe(false);
    expect(r.motivo).not.toMatch(/62|80/);
    expect(updatesDe(T)[0]).not.toHaveProperty('estado');
    expect(mockCrearSobre).not.toHaveBeenCalled();
  });

  it('continuar tras un intento fallido: cierra con ese resultado, avisa al analista y el sobre sale', async () => {
    enqueue(T, fila({ opcion: 'autoriza', resultado: resumen('no_coincide', 62) }), { data: [{ id: 'v1' }], error: null });
    const r = await continuarSinVerificar(TOKEN);

    expect(r.completada).toBe(true);
    expect(updatesDe(T)[0].estado).toBe('no_coincide');
    expect(mockNotificar).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'firma.identidad_revision' }));
    expect(mockCrearSobre).toHaveBeenCalledWith('c1', 'gestor-1');
  });

  it('si Auco falla al crear el sobre, la persona no se entera: se le avisa a quien envio el contrato', async () => {
    enqueue(T, fila({ opcion: 'autoriza' }), { data: [{ id: 'v1' }], error: null });
    mockCotejar.mockResolvedValue(resumen('verificada', 95));
    mockCrearSobre.mockRejectedValueOnce(new Error('Auco 503'));
    const r = await verificarBiometriaFirma(TOKEN, imgs);

    expect(r.completada).toBe(true);
    expect(mockNotificar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'gestor-1', tipo: 'contrato.firma_error' }));
  });
});

describe('panel del contrato y revision del analista', () => {
  const filaRevision = { id: 'v1', rol: 'arrendatario', nombre: 'Ana', email: 'ana@correo.co', estado: 'no_coincide', resultado: resumen('no_coincide', 62) };

  it('la inmobiliaria solo ve pendiente/completada: el resultado del cotejo es de Cofianza (§9.2)', async () => {
    enqueue(T, { data: [filaRevision], error: null });
    const [v] = await listarVerificaciones('c1', 'inmobiliaria');
    expect(v.estado).toBe('completada');
    expect(v).not.toHaveProperty('similitud');
    expect(v).not.toHaveProperty('resultado');
  });

  it('el analista ve similitud, motivo y que requiere su revision', async () => {
    enqueue(T, { data: [filaRevision], error: null });
    const [v] = await listarVerificaciones('c1', 'operador_analista');
    expect(v).toMatchObject({ estado: 'no_coincide', similitud: 62, requiere_analista: true });
  });

  it('suplantacion: cancela el contrato y queda registrada', async () => {
    enqueue(T, fila({ estado: 'no_coincide', resultado: resumen('no_coincide', 62) }));
    queues.set('contratos', [{ data: { estado: 'pendiente_firma' }, error: null }]);
    const user = { id: 'analista-1', email: 'a@cofianza.co', rol: 'operador_analista' as const, activo: true };
    await revisarVerificacion('c1', 'v1', { resultado: 'suplantacion', nota: 'Llamé al titular: no conoce el trámite.' }, user);

    expect(mockTransicion).toHaveBeenCalledWith('c1', expect.objectContaining({ nuevo_estado: 'cancelado' }), user);
    expect(updatesDe(T)[0]).toMatchObject({ revision: 'suplantacion', revisado_por: 'analista-1' });
  });

  it('suplantacion sobre un contrato V3 con FIANZA ACTIVA: queda registrada, NO cancela y avisa a los administradores', async () => {
    enqueue(T, fila({ estado: 'no_coincide', resultado: resumen('no_coincide', 62) }));
    queues.set('contratos', [{ data: { estado: 'vigente', destinacion: 'vivienda', numero: 'CTO-2026-0001' }, error: null }]);
    mockListOperators.mockResolvedValueOnce([{ id: 'op-1', rol: 'operador_analista' }, { id: 'admin-1', rol: 'administrador' }]);
    const user = { id: 'analista-1', email: 'a@cofianza.co', rol: 'operador_analista' as const, activo: true };
    await revisarVerificacion('c1', 'v1', { resultado: 'suplantacion', nota: 'El titular no conoce el trámite.' }, user);

    expect(mockTransicion).not.toHaveBeenCalled();
    expect(updatesDe(T)[0]).toMatchObject({ revision: 'suplantacion', revisado_por: 'analista-1' });
    expect(mockNotificar).toHaveBeenCalledTimes(1);
    expect(mockNotificar).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1', tipo: 'firma.suplantacion_fianza_activa' }));
  });

  it('una verificacion limpia no se revisa', async () => {
    enqueue(T, fila({ estado: 'verificada', resultado: resumen('verificada', 95) }));
    const user = { id: 'analista-1', email: 'a@cofianza.co', rol: 'operador_analista' as const, activo: true };
    await expect(
      revisarVerificacion('c1', 'v1', { resultado: 'confirmada', nota: 'Todo en orden con la cédula.' }, user),
    ).rejects.toMatchObject({ errorCode: 'VERIFICACION_SIN_REVISION' });
  });
});

// ============================================================
// Contratos V3 (Entrega 5 §8): arrendatario Y coarrendatario verifican antes
// del sobre, y el sobre sale cuando se cierra la ULTIMA verificacion.
// ============================================================

const PARTES = [
  { id: 'p1', rol: 'arrendatario', orden: 1, nombre: 'Ana Pérez', tipo_documento: 'cc', numero_documento: '1020304050', email: 'ana@correo.co', telefono: '3001112233' },
  { id: 'p2', rol: 'coarrendatario', orden: 2, nombre: 'Beto Ruiz', tipo_documento: 'cc', numero_documento: '2030405060', email: 'beto@correo.co', telefono: '3004445566' },
  { id: 'p3', rol: 'arrendador', orden: 3, nombre: 'Inmobiliaria SAS', tipo_documento: 'nit', numero_documento: '900', email: 'inmo@correo.co', telefono: '3007778899',
    representante_legal_nombre: 'Caro Díaz', representante_legal_tipo_documento: 'cc', representante_legal_documento: '5060' },
] as never[];
const CTX_V3 = { data: { destinacion: 'vivienda', expedientes: { numero: 'EXP-2026-0010', inmuebles: { direccion: 'Cra 7 # 45-10', ciudad: 'Bogotá' } } }, error: null };

describe('contratos V3', () => {
  const imgs = { documentImage: 'data:image/jpeg;base64,AAA', photo: 'data:image/jpeg;base64,BBB' };

  /** Lo que crearSobre lee y escribe después de leerContrato/leerPartes (mockeados). */
  const encolarSobre = () => {
    enqueue('contratos', { data: { destinacion: 'vivienda', storage_key: 'contratos/e1/c1/final.pdf' }, error: null });
    enqueue('contrato_v3_sobres', { data: { id: 's1' }, error: null }, { data: [{ id: 's1' }], error: null });
  };

  it('iniciar: toma las partes de contrato_partes y escribe al arrendatario y al coarrendatario (cotitular), nunca al arrendador', async () => {
    queues.set('contratos', [CTX_V3]);
    v3.leerPartes.mockResolvedValue(PARTES);
    const r = await iniciarVerificacionIdentidad('c1', 'gestor-1');

    expect(r.pendiente).toBe(true);
    const inserts = ops.filter((o) => o.table === T && o.method === 'insert').map((o) => o.args[0] as Record<string, string>);
    expect(inserts.map((i) => [i.rol, i.email])).toEqual([['arrendatario', 'ana@correo.co'], ['cotitular', 'beto@correo.co']]);
    expect(mockSendFirmaEmail.mock.calls.map((c) => c[0])).toEqual(['ana@correo.co', 'beto@correo.co']);
    expect(mockSendFirmaEmail).toHaveBeenCalledWith(
      'beto@correo.co', 'Beto Ruiz', expect.stringContaining('/verificar-identidad/'), 72, expect.anything(),
      expect.objectContaining({ intro: expect.stringContaining('cuando sea tu turno de firmar') }),
    );
    expect(mockDerivar).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('reenvio: reutiliza las cerradas y solo renueva a quien sigue pendiente', async () => {
    queues.set('contratos', [CTX_V3]);
    v3.leerPartes.mockResolvedValue(PARTES);
    enqueue(T, { data: { id: 'v1', estado: 'verificada' }, error: null }, { data: { id: 'v2', estado: 'pendiente' }, error: null });
    const r = await iniciarVerificacionIdentidad('c1', 'gestor-1');

    expect(r.pendiente).toBe(true);
    expect(ops.filter((o) => o.table === T && o.method === 'insert')).toHaveLength(0);
    expect(updatesDe(T)).toHaveLength(1);
    expect(mockSendFirmaEmail.mock.calls.map((c) => c[0])).toEqual(['beto@correo.co']);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('todas ya cerradas: el sobre sale de una vez (y si Auco falla, el error le llega a quien envia)', async () => {
    queues.set('contratos', [CTX_V3]);
    v3.leerPartes.mockResolvedValue(PARTES);
    enqueue(T, { data: { id: 'v1', estado: 'verificada' }, error: null }, { data: { id: 'v2', estado: 'omitida' }, error: null });
    enqueue(T, { count: 0, error: null }); // crearSobre: identidad pendiente
    encolarSobre();
    expect((await iniciarVerificacionIdentidad('c1', 'gestor-1')).pendiente).toBe(false);
    expect(mockSendFirmaEmail).not.toHaveBeenCalled();
    expect(mockUpload).toHaveBeenCalledTimes(1);

    queues.set('contratos', [CTX_V3]);
    enqueue(T, { data: { id: 'v1', estado: 'verificada' }, error: null }, { data: { id: 'v2', estado: 'omitida' }, error: null });
    enqueue(T, { count: 0, error: null });
    encolarSobre();
    mockUpload.mockRejectedValueOnce(new Error('Auco 503'));
    await expect(iniciarVerificacionIdentidad('c1', 'gestor-1')).rejects.toMatchObject({ errorCode: 'AUCO_UPLOAD_FAILED' });
  });

  it('dos verificaciones: la primera que cierra no crea el sobre; la segunda sí (y nunca el sobre del flujo anterior)', async () => {
    mockCotejar.mockResolvedValue(resumen('verificada', 95));
    v3.leerPartes.mockResolvedValue(PARTES);

    // 1.ª: cierra la del arrendatario; queda la del coarrendatario pendiente.
    queues.set('contratos', [CTX_V3]);
    enqueue(T, fila({ opcion: 'autoriza' }), { data: [{ id: 'v1' }], error: null }, { count: 1, error: null });
    expect(await verificarBiometriaFirma(TOKEN, imgs)).toEqual({ completada: true, motivo: null });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(ops.some((o) => o.table === 'contrato_v3_sobres')).toBe(false);

    // 2.ª: cierra la del coarrendatario → no queda ninguna pendiente → sale el sobre V3.
    queues.set('contratos', [CTX_V3]);
    encolarSobre();
    enqueue(
      T,
      fila({ id: 'v2', nombre: 'Beto Ruiz', opcion: 'autoriza' }),
      { data: [{ id: 'v2' }], error: null },
      { count: 0, error: null }, // continuarTrasIdentidad
      { count: 0, error: null }, // crearSobre
    );
    expect(await verificarBiometriaFirma(TOKEN, imgs)).toEqual({ completada: true, motivo: null });

    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [input] = mockUpload.mock.calls[0] as unknown as [{ custom: Record<string, string>; signProfile: unknown[] }];
    expect(input.custom).toEqual({ cofianza_sobre: 's1' });
    expect(input.signProfile).toHaveLength(3);
    expect(mockCrearSobre).not.toHaveBeenCalled();
  });

  it('si cancelaron el contrato mientras verificaban, la última verificación no crea el sobre', async () => {
    mockCotejar.mockResolvedValue(resumen('verificada', 95));
    v3.leerContrato.mockResolvedValueOnce({
      id: 'c1', estado: 'cancelado', numero: 'CTO-2026-0001', expediente_id: 'e1', fecha_firma: null,
      datos_variables: { documento: { final: { ruta: 'A' } } }, inmuebleId: null, orgId: null,
    });
    queues.set('contratos', [CTX_V3]);
    enqueue(T, fila({ opcion: 'autoriza' }), { data: [{ id: 'v1' }], error: null }, { count: 0, error: null });
    expect(await verificarBiometriaFirma(TOKEN, imgs)).toEqual({ completada: true, motivo: null });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(ops.some((o) => o.table === 'contrato_v3_sobres')).toBe(false);
  });

  it('un contrato del flujo anterior sigue creando su sobre con crearSolicitudFirmaMultiparte', async () => {
    enqueue(T, fila({ opcion: 'autoriza' }), { data: [{ id: 'v1' }], error: null });
    mockCotejar.mockResolvedValue(resumen('verificada', 95));
    await verificarBiometriaFirma(TOKEN, imgs);

    expect(mockCrearSobre).toHaveBeenCalledWith('c1', 'gestor-1');
    expect(v3.leerContrato).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

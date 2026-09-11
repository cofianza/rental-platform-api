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
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'https://www.cofianza.co' } }));
vi.mock('@/lib/auditLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auditLog')>()),
  logAudit: vi.fn(),
}));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({ UMBRAL_SIMILITUD_BIOMETRICA: 80 })) }));
vi.mock('@/lib/email', () => ({ sendFirmaEmail: (...a: unknown[]) => mockSendFirmaEmail(...a) }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: (...a: unknown[]) => mockNotificar(...a),
}));
vi.mock('@/modules/users/users.service', () => ({ listOperators: vi.fn(async () => [{ id: 'analista-1' }]) }));
vi.mock('@/modules/autorizaciones/biometria', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/autorizaciones/biometria')>()),
  cotejarConAuco: (...a: unknown[]) => mockCotejar(...a),
}));
vi.mock('../firma-multiparte.service', () => ({
  derivarFirmantes: (...a: unknown[]) => mockDerivar(...a),
  evaluarFirmantes: (...a: unknown[]) => mockEvaluar(...a),
  crearSolicitudFirmaMultiparte: (...a: unknown[]) => mockCrearSobre(...a),
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

  it('una verificacion limpia no se revisa', async () => {
    enqueue(T, fila({ estado: 'verificada', resultado: resumen('verificada', 95) }));
    const user = { id: 'analista-1', email: 'a@cofianza.co', rol: 'operador_analista' as const, activo: true };
    await expect(
      revisarVerificacion('c1', 'v1', { resultado: 'confirmada', nota: 'Todo en orden con la cédula.' }, user),
    ).rejects.toMatchObject({ errorCode: 'VERIFICACION_SIN_REVISION' });
  });
});

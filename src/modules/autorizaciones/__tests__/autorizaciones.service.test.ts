import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock de Supabase: builder encadenable + colas de resultados POR TABLA.
//
// El anterior armaba a mano una cadena por test (select→eq→eq→order→limit→
// maybeSingle) y se rompia con cada `.is()` o `.or()` nuevo del servicio: 25
// de 26 tests en rojo desde 2026-09-03, cero señal justo en el modulo que
// custodia la evidencia legal de la firma.
//
// Aqui cualquier metodo de filtro devuelve el mismo builder; los terminales
// (`maybeSingle`, `single`) y el `await` directo del builder consumen el
// siguiente resultado de la cola DE ESA TABLA. Una tabla sin cola responde
// `{ data: null, error: null }`: las lecturas auxiliares (perfil del
// prospecto, estudios, timeline) no obligan a re-escribir cada test cuando el
// servicio agrega una. Todo lo que se llamo queda en `ops` para poder afirmar
// QUE se escribio, no solo que no exploto.
// ============================================================

const { mockEnv, mockFrom, ops, queues, enqueue, mockEnviarMensaje, mockAssertAccess, mockEstudioYaCobrado, mockOnHabeas, mockNotificarUsuario, mockNotificarResponsable } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'or', 'lt', 'gt', 'gte', 'lte', 'order', 'limit'];
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
  const mockFrom = vi.fn((table: string) => chainFor(table));
  const enqueue = (table: string, ...items: Res[]) => {
    queues.set(table, [...(queues.get(table) ?? []), ...items]);
  };
  return {
    mockEnv: {
      FRONTEND_URL: 'http://localhost:3000',
      AUTORIZACION_VIGENCIA_MESES: 12,
      AUCO_BIOMETRIA_ENABLED: false,
      AUCO_BIOMETRIA_UMBRAL_SIMILITUD: 70,
      AUCO_BIOMETRIA_TIMEOUT_MS: 20000,
      AUCO_API_URL: 'https://dev.auco.ai/v1.5/ext',
      AUCO_PUBLIC_KEY: 'puk_x',
      AUCO_PRIVATE_KEY: 'prk_x',
      AUCO_SENDER_EMAIL: 'qa@cofianza.co',
      BURO_REQUEST_TIMEOUT_MS: 8000,
      AUCO_BACKGROUND_CHECK_ENABLED: false,
      AUCO_BACKGROUND_TIMEOUT_MS: 90000,
    },
    mockFrom,
    ops,
    queues,
    enqueue,
    mockEnviarMensaje: vi.fn(async () => ({ estado: 'enviado' })),
    mockAssertAccess: vi.fn(async () => undefined),
    mockEstudioYaCobrado: vi.fn(async () => false),
    mockOnHabeas: vi.fn(async () => undefined),
    mockNotificarUsuario: vi.fn(async () => undefined),
    mockNotificarResponsable: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: {
    AUTORIZACION_ENLACE_SENT: 'autorizacion_enlace_sent',
    AUTORIZACION_FIRMADA: 'autorizacion_firmada',
    AUTORIZACION_REVOCADA: 'autorizacion_revocada',
    AUTORIZACION_BIOMETRIA: 'autorizacion_biometria',
  },
  AUDIT_ENTITIES: { AUTORIZACION: 'autorizacion' },
}));
vi.mock('@/config', () => ({ env: mockEnv }));

const mockSendAutorizacionEmail = vi.fn().mockResolvedValue(undefined);
const mockSendOtpEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/email', () => ({
  sendAutorizacionEmail: (...args: unknown[]) => mockSendAutorizacionEmail(...args),
  sendOtpEmail: (...args: unknown[]) => mockSendOtpEmail(...args),
}));
vi.mock('@/modules/whatsapp/whatsapp.service', () => ({
  enviarMensaje: (...args: unknown[]) => mockEnviarMensaje(...args),
}));
vi.mock('@/modules/whatsapp/templates', () => ({
  WHATSAPP_TEMPLATES: {
    AUTORIZACION_LINK: { id: 'cofianza_autorizacion_link', language: 'es_CO' },
    AUTORIZACION_OTP: { id: 'cofianza_otp_autorizacion', language: 'es_CO' },
  },
}));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: (...args: unknown[]) => mockAssertAccess(...args),
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
}));
vi.mock('@/modules/estudios/pago.guard', () => ({
  estudioYaCobrado: (...args: unknown[]) => mockEstudioYaCobrado(...args),
}));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({
  onHabeasDataAutorizado: (...args: unknown[]) => mockOnHabeas(...args),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: (...args: unknown[]) => mockNotificarUsuario(...args),
  notificarResponsableExpediente: (...args: unknown[]) => mockNotificarResponsable(...args),
  notificarYCorreo: vi.fn(async () => undefined),
}));
vi.mock('@/modules/users/users.service', () => ({ listOperators: vi.fn(async () => []) }));

// Import AFTER mocks
import {
  getAutorizacionForExpediente,
  getAutorizacionByToken,
  enviarEnlaceAutorizacion,
  firmarAutorizacion,
  enviarOtpCode,
  verificarOtpCode,
  revocarAutorizacion,
} from '../autorizaciones.service';
import { TEXTO_LEGAL, TEXTO_LEGAL_BIOMETRIA, VERSION_TERMINOS, VERSION_TERMINOS_BIOMETRIA } from '../autorizaciones.texto';

// ============================================================
// Fixtures
// ============================================================

const EXPEDIENTE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '660e8400-e29b-41d4-a716-446655440000';
const AUTORIZACION_ID = '770e8400-e29b-41d4-a716-446655440000';
const TOKEN = 'a'.repeat(64);
const FUTURE_DATE = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
const PAST_DATE = new Date(Date.now() - 1000).toISOString();

const expedienteConSolicitante = {
  id: EXPEDIENTE_ID,
  numero: 'EXP-2026-0001',
  estado: 'en_revision',
  solicitante_id: 'sol-uuid',
  solicitantes: {
    id: 'sol-uuid',
    nombre: 'Juan',
    apellido: 'Perez',
    email: 'juan@test.com',
    telefono: null as string | null,
    tipo_documento: 'cc',
    numero_documento: '123456789',
  },
  inmuebles: { id: 'inm-uuid', direccion: 'Calle 1 #2-3', ciudad: 'Bogota', barrio: 'Centro', propietario_id: null, inmobiliaria_id: null },
};

const autorizacionPendiente = {
  id: AUTORIZACION_ID,
  estado: 'pendiente',
  token_expiracion: FUTURE_DATE,
  texto_autorizado: 'Texto legal de autorizacion',
  version_terminos: '2.0',
  metodo_firma: null,
  solicitantes: { nombre: 'Juan', apellido: 'Perez', telefono: '+573001112233', tipo_documento: 'cc', numero_documento: '123456789' },
  // OJO: el servicio lee `expedientes.numero` y lo devuelve como numero_expediente.
  expedientes: { numero: 'EXP-2026-0001', inmuebles: { direccion: 'Calle 1 #2-3', ciudad: 'Bogota', barrio: 'Centro' } },
};

/** Fila que lee firmarAutorizacion. Sin expediente: no dispara hooks. */
const paraFirmar = {
  id: AUTORIZACION_ID,
  estado: 'pendiente',
  token_expiracion: FUTURE_DATE,
  texto_autorizado: 'Texto legal',
  solicitante_id: 'sol-uuid',
  expediente_id: null as string | null,
  solicitantes: { tipo_documento: 'cc', numero_documento: '123456789' },
};

const otpVerificado = { id: 'otp-uuid', codigo: '123456', expira_en: FUTURE_DATE, verificado: true };
const CANVAS = { metodo_firma: 'canvas' as const, datos_firma: 'data:image/png;base64,AAA' };
const OTP = { metodo_firma: 'otp' as const, codigo_otp: '123456' };

const opsDe = (table: string, method: string) => ops.filter((o) => o.table === table && o.method === method);

describe('autorizaciones.service', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    vi.clearAllMocks();
    mockEnv.AUCO_BIOMETRIA_ENABLED = false;
    mockEnviarMensaje.mockResolvedValue({ estado: 'enviado' });
    mockEstudioYaCobrado.mockResolvedValue(false);
    mockSendOtpEmail.mockResolvedValue(undefined);
  });

  // ============================================================
  // getAutorizacionForExpediente
  // ============================================================

  describe('getAutorizacionForExpediente', () => {
    it('debe retornar null si no hay autorizacion', async () => {
      enqueue('expedientes', { data: { id: EXPEDIENTE_ID } });
      enqueue('autorizaciones_habeas_data', { data: null });

      const result = await getAutorizacionForExpediente(EXPEDIENTE_ID, USER_ID, 'administrador');
      expect(result).toBeNull();
      expect(mockAssertAccess).toHaveBeenCalledWith(EXPEDIENTE_ID, USER_ID, 'administrador');
      expect(mockFrom).toHaveBeenCalledWith('expedientes');
      expect(mockFrom).toHaveBeenCalledWith('autorizaciones_habeas_data');
      // Solo la fila del TITULAR: la del co-arrendatario comparte expediente_id.
      expect(opsDe('autorizaciones_habeas_data', 'is')[0].args).toEqual(['coarrendatario_id', null]);
    });

    it('debe lanzar error si expediente no existe', async () => {
      enqueue('expedientes', { data: null, error: { message: 'not found' } });
      await expect(getAutorizacionForExpediente(EXPEDIENTE_ID)).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'EXPEDIENTE_NOT_FOUND',
      });
    });

    it('a la inmobiliaria NO le muestra el ingreso declarado (§8.2), a Cofianza si', async () => {
      const fila = { id: AUTORIZACION_ID, estado: 'autorizado' };
      const perfil = { identidad_confirmada: true, situacion_laboral: 'empleado', donde_labora: 'Acme', ingreso_declarado_cop: 5_000_000, presentacion: 'solo' };

      enqueue('expedientes', { data: { id: EXPEDIENTE_ID } });
      enqueue('autorizaciones_habeas_data', { data: fila });
      enqueue('autorizacion_perfil_prospecto', { data: perfil });
      const agencia = await getAutorizacionForExpediente(EXPEDIENTE_ID, USER_ID, 'inmobiliaria');
      expect(agencia).toMatchObject({ id: AUTORIZACION_ID, perfil_prospecto: { identidad_confirmada: true, presentacion: 'solo' } });
      expect(agencia?.perfil_prospecto).not.toHaveProperty('ingreso_declarado_cop');
      expect(agencia?.perfil_prospecto).not.toHaveProperty('situacion_laboral');

      enqueue('expedientes', { data: { id: EXPEDIENTE_ID } });
      enqueue('autorizaciones_habeas_data', { data: fila });
      enqueue('autorizacion_perfil_prospecto', { data: perfil });
      const cofianza = await getAutorizacionForExpediente(EXPEDIENTE_ID, USER_ID, 'administrador');
      expect(cofianza?.perfil_prospecto).toMatchObject({ ingreso_declarado_cop: 5_000_000, situacion_laboral: 'empleado', donde_labora: 'Acme' });
      expect(cofianza?.perfil_prospecto).toHaveProperty('discrepancia_ingreso');
    });
  });

  // ============================================================
  // enviarEnlaceAutorizacion
  // ============================================================

  describe('enviarEnlaceAutorizacion', () => {
    it('debe crear autorizacion y enviar email', async () => {
      enqueue('expedientes', { data: expedienteConSolicitante });
      enqueue(
        'autorizaciones_habeas_data',
        { data: null },                      // ¿ya hay una firmada vigente? no
        { error: null },                     // expirar pendientes anteriores
        { data: { id: AUTORIZACION_ID } },   // insert
      );

      const result = await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID, '127.0.0.1');

      expect(result).toMatchObject({ id: AUTORIZACION_ID, estado: 'pendiente' });
      expect(result.token_expiracion).toBeDefined();
      expect(mockSendAutorizacionEmail).toHaveBeenCalledWith(
        'juan@test.com',
        'Juan Perez',
        expect.stringContaining('http://localhost:3000/autorizar/'),
        48,
      );
      // Sin celular no hay WhatsApp.
      expect(mockEnviarMensaje).not.toHaveBeenCalled();
      // §8.4: se congela el texto y la version que de verdad se presentaron.
      const insert = opsDe('autorizaciones_habeas_data', 'insert')[0].args[0] as Record<string, unknown>;
      expect(insert).toMatchObject({ estado: 'pendiente', texto_autorizado: TEXTO_LEGAL, version_terminos: VERSION_TERMINOS });
      expect(String(insert.token)).toHaveLength(64);
      // Las pendientes anteriores DEL TITULAR se expiran (no las del co-arrendatario).
      expect(opsDe('autorizaciones_habeas_data', 'update')[0].args[0]).toEqual({ estado: 'expirado' });
      expect(opsDe('autorizaciones_habeas_data', 'is').some((o) => o.args[0] === 'coarrendatario_id')).toBe(true);
    });

    it('manda tambien el enlace por WhatsApp cuando hay celular', async () => {
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, telefono: '+573001112233' } } });
      enqueue('autorizaciones_habeas_data', { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });

      await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID);

      expect(mockEnviarMensaje).toHaveBeenCalledWith(expect.objectContaining({
        to: '+573001112233',
        template_id: 'cofianza_autorizacion_link',
        variables: ['Juan', expect.stringContaining('/autorizar/')],
      }));
    });

    it('con la biometria encendida presenta y congela el texto 3.0-biometria', async () => {
      mockEnv.AUCO_BIOMETRIA_ENABLED = true;
      enqueue('expedientes', { data: expedienteConSolicitante });
      enqueue('autorizaciones_habeas_data', { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });

      await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID);

      const insert = opsDe('autorizaciones_habeas_data', 'insert')[0].args[0] as Record<string, unknown>;
      expect(insert).toMatchObject({ texto_autorizado: TEXTO_LEGAL_BIOMETRIA, version_terminos: VERSION_TERMINOS_BIOMETRIA });
      expect(insert.texto_autorizado).not.toBe(TEXTO_LEGAL);
    });

    it('no re-crea el enlace si ya hay una firma vigente (AUTORIZACION_YA_FIRMADA)', async () => {
      enqueue('expedientes', { data: expedienteConSolicitante });
      enqueue('autorizaciones_habeas_data', { data: { id: 'firmada-uuid' } });

      await expect(enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_YA_FIRMADA',
      });
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toHaveLength(0);
      expect(mockSendAutorizacionEmail).not.toHaveBeenCalled();
    });

    it('debe lanzar error si expediente no existe', async () => {
      enqueue('expedientes', { data: null, error: { message: 'not found' } });
      await expect(enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID)).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'EXPEDIENTE_NOT_FOUND',
      });
    });

    it('debe lanzar error si solicitante no tiene email', async () => {
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, email: '' } } });
      await expect(enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'SOLICITANTE_SIN_EMAIL',
      });
    });
  });

  // ============================================================
  // getAutorizacionByToken
  // ============================================================

  describe('getAutorizacionByToken', () => {
    it('debe retornar datos publicos para token valido, con PII minimizada', async () => {
      enqueue('autorizaciones_habeas_data', { data: autorizacionPendiente });

      const result = await getAutorizacionByToken(TOKEN);

      expect(result).toMatchObject({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        texto_legal: 'Texto legal de autorizacion',
        version_terminos: '2.0',
        biometria: { requerida: false, estado: null },
        solicitante: { nombre: 'Juan', apellido: 'Perez', tipo_documento: 'cc', numero_documento_masked: '••••6789', telefono_masked: '••• ••33' },
        expediente: { numero_expediente: 'EXP-2026-0001', inmueble: { ciudad: 'Bogota' } },
      });
      // Ni el email ni el documento completo viajan al portador del enlace.
      expect(JSON.stringify(result)).not.toContain('123456789');
      expect(JSON.stringify(result)).not.toContain('@');
    });

    it('debe lanzar error si token no existe', async () => {
      enqueue('autorizaciones_habeas_data', { data: null });
      await expect(getAutorizacionByToken(TOKEN)).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'AUTORIZACION_NOT_FOUND',
      });
    });

    it('debe lanzar error si token expirado, y marcarla expirada', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...autorizacionPendiente, token_expiracion: PAST_DATE } }, { error: null });

      await expect(getAutorizacionByToken(TOKEN)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_EXPIRADA',
      });
      expect(opsDe('autorizaciones_habeas_data', 'update')[0].args[0]).toEqual({ estado: 'expirado' });
    });

    it('ya firmada -> AUTORIZACION_YA_FIRMADA (el front muestra exito idempotente)', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...autorizacionPendiente, estado: 'autorizado' } });
      await expect(getAutorizacionByToken(TOKEN)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_YA_FIRMADA',
      });
    });

    it('revocada -> AUTORIZACION_ESTADO_INVALIDO', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...autorizacionPendiente, estado: 'revocado' } });
      await expect(getAutorizacionByToken(TOKEN)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_ESTADO_INVALIDO',
      });
    });
  });

  // ============================================================
  // firmarAutorizacion
  // ============================================================

  describe('firmarAutorizacion', () => {
    // Adenda 1 §7 (Gerencia, 07/09/2026): "No se implementa OTP en el flujo de
    // autorizacion del estudio." La aceptacion por casilla firma SIN OTP; el
    // riesgo del enlace reenviado (Flujo §12) queda aceptado y registrado por
    // la Gerencia General. Si alguien vuelve a exigir OTP a la casilla, este
    // test se cae — y la decision documentada es la de la Adenda.
    it('casilla firma SIN OTP (Adenda §7) y congela la evidencia del §8.4', async () => {
      enqueue('autorizaciones_habeas_data', { data: paraFirmar }, { data: [{ id: AUTORIZACION_ID }] });

      const result = await firmarAutorizacion(TOKEN, { metodo_firma: 'casilla' }, '192.168.1.1', 'Mozilla/5.0');

      expect(result).toMatchObject({ estado: 'autorizado', pago_requerido: false });
      expect(mockFrom).not.toHaveBeenCalledWith('autorizacion_otps');
      const update = opsDe('autorizaciones_habeas_data', 'update')[0].args[0] as Record<string, unknown>;
      expect(update).toMatchObject({
        estado: 'autorizado',
        metodo_firma: 'casilla',
        ip_autorizacion: '192.168.1.1',
        user_agent: 'Mozilla/5.0',
        numero_documento_aceptante: '123456789',
        tipo_documento_aceptante: 'cc',
      });
    });

    it('otp SIN OTP verificado NO firma (OTP_NO_VERIFICADO)', async () => {
      enqueue('autorizaciones_habeas_data', { data: paraFirmar });
      enqueue('autorizacion_otps', { data: null });

      await expect(firmarAutorizacion(TOKEN, OTP, '1.1.1.1', 'UA')).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'OTP_NO_VERIFICADO',
      });
      expect(opsDe('autorizaciones_habeas_data', 'update')).toHaveLength(0);
    });

    it('debe firmar con metodo canvas (sin OTP, Adenda §7)', async () => {
      enqueue('autorizaciones_habeas_data', { data: paraFirmar }, { data: [{ id: AUTORIZACION_ID }] });

      const result = await firmarAutorizacion(TOKEN, CANVAS, '192.168.1.1', 'Mozilla/5.0');

      expect(result).toMatchObject({ estado: 'autorizado', pago_requerido: false });
      expect(result.hash_documento).toHaveLength(64); // SHA-256 hex
      expect(result.autorizado_en).toBeDefined();

      // §8.4: evidencia congelada en la fila, y la transicion es atomica
      // (update ... eq estado='pendiente').
      const update = opsDe('autorizaciones_habeas_data', 'update')[0].args[0] as Record<string, unknown>;
      expect(update).toMatchObject({
        estado: 'autorizado',
        metodo_firma: 'canvas',
        ip_autorizacion: '192.168.1.1',
        user_agent: 'Mozilla/5.0',
        numero_documento_aceptante: '123456789',
        tipo_documento_aceptante: 'cc',
        vigencia_meses: 12,
      });
      expect(update.vigente_hasta).toBeDefined();
      expect(opsDe('autorizaciones_habeas_data', 'eq').some((o) => o.args[0] === 'estado' && o.args[1] === 'pendiente')).toBe(true);
    });

    it('debe firmar con metodo OTP cuando hay OTP verificado', async () => {
      enqueue('autorizaciones_habeas_data', { data: paraFirmar }, { data: [{ id: AUTORIZACION_ID }] });
      enqueue('autorizacion_otps', { data: otpVerificado });

      const result = await firmarAutorizacion(TOKEN, OTP, '192.168.1.1');
      expect(result.estado).toBe('autorizado');
      expect(result.hash_documento).toHaveLength(64);
    });

    it('OTP verificado pero caducado -> OTP_EXPIRADO', async () => {
      enqueue('autorizaciones_habeas_data', { data: paraFirmar });
      enqueue('autorizacion_otps', { data: { ...otpVerificado, expira_en: PAST_DATE } });

      await expect(firmarAutorizacion(TOKEN, OTP)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'OTP_EXPIRADO',
      });
    });

    it('doble submit: el segundo no re-firma ni re-dispara nada (AUTORIZACION_YA_FIRMADA)', async () => {
      // El UPDATE condicionado no afecta filas; la relectura dice 'autorizado'.
      enqueue('autorizaciones_habeas_data', { data: paraFirmar }, { data: [] }, { data: { estado: 'autorizado' } });
      enqueue('autorizacion_otps', { data: otpVerificado });

      await expect(firmarAutorizacion(TOKEN, OTP)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_YA_FIRMADA',
      });
      expect(mockOnHabeas).not.toHaveBeenCalled();
    });

    it('con expediente: dispara el orquestador y avisa al gestor (§9)', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...paraFirmar, expediente_id: EXPEDIENTE_ID } }, { data: [{ id: AUTORIZACION_ID }] });
      enqueue('autorizacion_otps', { data: otpVerificado });
      enqueue('expedientes', { data: { numero: 'EXP-2026-0001', inmuebles: { propietario_id: 'prop-1', direccion: 'Calle 1' }, solicitantes: { nombre: 'Juan', apellido: 'Perez' } } });

      const result = await firmarAutorizacion(TOKEN, OTP);
      expect(result.estado).toBe('autorizado');

      // Los dos hooks son fire-and-forget detras de un import() dinamico:
      // se esperan, no se asume que ya corrieron al volver la promesa.
      await vi.waitFor(() => expect(mockOnHabeas).toHaveBeenCalled());
      await vi.waitFor(() => expect(mockNotificarResponsable).toHaveBeenCalled());
      expect(mockOnHabeas).toHaveBeenCalledWith(expect.objectContaining({ expedienteId: EXPEDIENTE_ID, autorizacionId: AUTORIZACION_ID }));
      expect(mockNotificarUsuario).toHaveBeenCalledWith(expect.objectContaining({ userId: 'prop-1', tipo: 'autorizacion.firmada' }));
      expect(mockNotificarResponsable).toHaveBeenCalledWith(expect.objectContaining({ expedienteId: EXPEDIENTE_ID, tipo: 'autorizacion.firmada' }));
    });

    it('§6.3 opcion C: pago_requerido=true solo si el estudio no esta pagado y le toca al arrendatario', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...paraFirmar, expediente_id: EXPEDIENTE_ID } }, { data: [{ id: AUTORIZACION_ID }] });
      enqueue('autorizacion_otps', { data: otpVerificado });
      enqueue('estudios', { data: { pago_por: 'arrendatario' } });

      const result = await firmarAutorizacion(TOKEN, OTP);
      expect(result.pago_requerido).toBe(true);
    });

    it('ya firmada -> AUTORIZACION_YA_FIRMADA; revocada -> AUTORIZACION_NO_VIGENTE', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...paraFirmar, estado: 'autorizado' } });
      await expect(firmarAutorizacion(TOKEN, CANVAS)).rejects.toMatchObject({ statusCode: 400, errorCode: 'AUTORIZACION_YA_FIRMADA' });

      enqueue('autorizaciones_habeas_data', { data: { ...paraFirmar, estado: 'revocado' } });
      await expect(firmarAutorizacion(TOKEN, CANVAS)).rejects.toMatchObject({ statusCode: 400, errorCode: 'AUTORIZACION_NO_VIGENTE' });
    });

    it('debe lanzar error si token expirado', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...paraFirmar, token_expiracion: PAST_DATE } });
      await expect(firmarAutorizacion(TOKEN, CANVAS)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_EXPIRADA',
      });
    });

    it('debe lanzar error si autorizacion no encontrada', async () => {
      enqueue('autorizaciones_habeas_data', { data: null });
      await expect(firmarAutorizacion(TOKEN, CANVAS)).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'AUTORIZACION_NOT_FOUND',
      });
    });
  });

  // ============================================================
  // enviarOtpCode
  // ============================================================

  describe('enviarOtpCode', () => {
    const paraOtp = (telefono: string | null = null) => ({
      id: AUTORIZACION_ID,
      estado: 'pendiente',
      token_expiracion: FUTURE_DATE,
      solicitantes: { nombre: 'Juan', apellido: 'Perez', email: 'juan@test.com', telefono },
    });

    it('debe generar y enviar OTP por correo', async () => {
      enqueue('autorizaciones_habeas_data', { data: paraOtp() });
      enqueue(
        'autorizacion_otps',
        { data: null },              // cooldown: sin OTP previo
        { error: null },             // invalidar OTPs no verificados
        { data: { id: 'otp-1' } },   // insert
      );

      const result = await enviarOtpCode(TOKEN);

      expect(result.mensaje).toBe('Codigo OTP enviado al correo del solicitante');
      expect(result.expira_en).toBeDefined();
      expect(mockSendOtpEmail).toHaveBeenCalledWith('juan@test.com', 'Juan Perez', expect.stringMatching(/^\d{6}$/));
      expect(mockEnviarMensaje).not.toHaveBeenCalled();
      // Un solo codigo activo a la vez.
      expect(opsDe('autorizacion_otps', 'update')).toHaveLength(1);
      expect(opsDe('autorizacion_otps', 'insert')[0].args[0]).toMatchObject({ autorizacion_id: AUTORIZACION_ID, codigo: expect.stringMatching(/^\d{6}$/) });
    });

    it('con celular lo manda tambien por WhatsApp como plantilla de autenticacion', async () => {
      enqueue('autorizaciones_habeas_data', { data: paraOtp('+573001112233') });
      enqueue('autorizacion_otps', { data: null }, { error: null }, { data: { id: 'otp-1' } });

      const result = await enviarOtpCode(TOKEN);

      expect(result.mensaje).toBe('Codigo OTP enviado por WhatsApp y correo');
      expect(mockEnviarMensaje).toHaveBeenCalledWith(expect.objectContaining({
        to: '+573001112233',
        template_id: 'cofianza_otp_autorizacion',
        is_authentication: true,
      }));
    });

    it('si ningun canal entrega, borra el OTP y falla (OTP_DELIVERY_FAILED)', async () => {
      mockSendOtpEmail.mockRejectedValueOnce(new Error('resend down'));
      mockEnviarMensaje.mockResolvedValueOnce({ estado: 'fallido', error: 'meta down' });
      enqueue('autorizaciones_habeas_data', { data: paraOtp('+573001112233') });
      enqueue('autorizacion_otps', { data: null }, { error: null }, { data: { id: 'otp-1' } }, { error: null });

      await expect(enviarOtpCode(TOKEN)).rejects.toMatchObject({ statusCode: 400, errorCode: 'OTP_DELIVERY_FAILED' });
      expect(opsDe('autorizacion_otps', 'delete')).toHaveLength(1);
    });

    it('debe lanzar error si autorizacion no encontrada', async () => {
      enqueue('autorizaciones_habeas_data', { data: null });
      await expect(enviarOtpCode(TOKEN)).rejects.toMatchObject({ statusCode: 404, errorCode: 'AUTORIZACION_NOT_FOUND' });
    });

    it('ya firmada -> AUTORIZACION_YA_FIRMADA', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...paraOtp(), estado: 'autorizado' } });
      await expect(enviarOtpCode(TOKEN)).rejects.toMatchObject({ statusCode: 400, errorCode: 'AUTORIZACION_YA_FIRMADA' });
    });

    it('debe lanzar error si cooldown activo', async () => {
      enqueue('autorizaciones_habeas_data', { data: paraOtp() });
      enqueue('autorizacion_otps', { data: { created_at: new Date(Date.now() - 10 * 1000).toISOString() } });

      await expect(enviarOtpCode(TOKEN)).rejects.toMatchObject({ statusCode: 429, errorCode: 'OTP_COOLDOWN' });
      expect(opsDe('autorizacion_otps', 'insert')).toHaveLength(0);
    });
  });

  // ============================================================
  // verificarOtpCode
  // ============================================================

  describe('verificarOtpCode', () => {
    const auth = { id: AUTORIZACION_ID, estado: 'pendiente', token_expiracion: FUTURE_DATE };
    const otpPendiente = { id: 'otp-uuid', codigo: '123456', expira_en: FUTURE_DATE, verificado: false };

    it('debe verificar OTP correcto', async () => {
      enqueue('autorizaciones_habeas_data', { data: auth });
      enqueue('autorizacion_otps', { data: otpPendiente }, { error: null });

      const result = await verificarOtpCode(TOKEN, '123456');

      expect(result).toEqual({ verificado: true, mensaje: 'Codigo OTP verificado correctamente' });
      expect(opsDe('autorizacion_otps', 'update')[0].args[0]).toEqual({ verificado: true });
    });

    it('debe lanzar error si codigo incorrecto', async () => {
      enqueue('autorizaciones_habeas_data', { data: auth });
      enqueue('autorizacion_otps', { data: otpPendiente });
      await expect(verificarOtpCode(TOKEN, '999999')).rejects.toMatchObject({ statusCode: 400, errorCode: 'OTP_INCORRECTO' });
      expect(opsDe('autorizacion_otps', 'update')).toHaveLength(0);
    });

    it('debe lanzar error si OTP expirado', async () => {
      enqueue('autorizaciones_habeas_data', { data: auth });
      enqueue('autorizacion_otps', { data: { ...otpPendiente, expira_en: PAST_DATE } });
      await expect(verificarOtpCode(TOKEN, '123456')).rejects.toMatchObject({ statusCode: 400, errorCode: 'OTP_EXPIRADO' });
    });

    it('debe lanzar error si no hay OTP pendiente', async () => {
      enqueue('autorizaciones_habeas_data', { data: auth });
      enqueue('autorizacion_otps', { data: null });
      await expect(verificarOtpCode(TOKEN, '123456')).rejects.toMatchObject({ statusCode: 400, errorCode: 'OTP_NOT_FOUND' });
    });

    it('debe lanzar error si autorizacion no encontrada', async () => {
      enqueue('autorizaciones_habeas_data', { data: null });
      await expect(verificarOtpCode(TOKEN, '123456')).rejects.toMatchObject({ statusCode: 404, errorCode: 'AUTORIZACION_NOT_FOUND' });
    });
  });

  // ============================================================
  // revocarAutorizacion
  // ============================================================

  describe('revocarAutorizacion', () => {
    const motivo = { motivo: 'Revocacion por solicitud del titular' };

    it('debe revocar la autorizacion activa DEL TITULAR', async () => {
      enqueue('autorizaciones_habeas_data', { data: { id: AUTORIZACION_ID, estado: 'autorizado' } }, { error: null });

      const result = await revocarAutorizacion(EXPEDIENTE_ID, motivo, USER_ID, 'administrador', '127.0.0.1');

      expect(result).toMatchObject({ estado: 'revocado' });
      expect(result.fecha_revocacion).toBeDefined();
      expect(mockAssertAccess).toHaveBeenCalledWith(EXPEDIENTE_ID, USER_ID, 'administrador');
      expect(opsDe('autorizaciones_habeas_data', 'update')[0].args[0]).toMatchObject({ estado: 'revocado', motivo_revocacion: motivo.motivo });
      // Sujeto: el titular (coarrendatario_id IS NULL), nunca "la mas reciente".
      expect(opsDe('autorizaciones_habeas_data', 'is').some((o) => o.args[0] === 'coarrendatario_id' && o.args[1] === null)).toBe(true);
    });

    it('con coarrendatario_id revoca la del co-arrendatario, no la del titular', async () => {
      enqueue('autorizaciones_habeas_data', { data: { id: 'coa-auth', estado: 'autorizado' } }, { error: null });

      await revocarAutorizacion(EXPEDIENTE_ID, { ...motivo, coarrendatario_id: 'coa-1' }, USER_ID);

      expect(opsDe('autorizaciones_habeas_data', 'eq').some((o) => o.args[0] === 'coarrendatario_id' && o.args[1] === 'coa-1')).toBe(true);
      expect(opsDe('autorizaciones_habeas_data', 'is').some((o) => o.args[0] === 'coarrendatario_id')).toBe(false);
    });

    it('debe lanzar error si no hay autorizacion activa', async () => {
      enqueue('autorizaciones_habeas_data', { data: null });
      await expect(revocarAutorizacion(EXPEDIENTE_ID, motivo, USER_ID)).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'AUTORIZACION_NOT_FOUND',
      });
      expect(opsDe('autorizaciones_habeas_data', 'update')).toHaveLength(0);
    });
  });
});

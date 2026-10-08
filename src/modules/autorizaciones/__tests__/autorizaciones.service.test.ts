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

const { mockEnv, mockFrom, ops, queues, enqueue, mockEnviarMensaje, mockAssertAccess, mockEstudioYaCobrado, mockOnHabeas, mockNotificarUsuario, mockNotificarResponsable, mockOrgDelPerfil } = vi.hoisted(() => {
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
    // B18: organización activa del dueño del inmueble (null = propietario individual).
    mockOrgDelPerfil: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
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
    SOLICITANTE_UPDATED: 'solicitante_updated',
  },
  AUDIT_ENTITIES: { AUTORIZACION: 'autorizacion', SOLICITANTE: 'solicitante' },
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
    AUTORIZACION_LINK: { id: 'cofianza_autorizacion_link_v2', language: 'es_CO' },
    AUTORIZACION_OTP: { id: 'cofianza_otp_autorizacion', language: 'es_CO' },
  },
}));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: (...args: unknown[]) => mockAssertAccess(...args),
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
  resolveInmobiliariaIdForPerfil: (...args: unknown[]) => mockOrgDelPerfil(...args),
  resolveAllowedExpedienteIds: (...args: unknown[]) => mockBlq.allowed(...args),
}));
// BLQ: cierre por límite de correcciones, Gerencia General y WhatsApp a titulares.
const mockBlq = vi.hoisted(() => ({
  allowed: vi.fn(async (..._a: unknown[]): Promise<string[] | null> => null),
  executeTransition: vi.fn(async (..._a: unknown[]) => ({})),
  gerenciaIds: vi.fn(async () => ['gg-1']),
  enviarTemplate: vi.fn(async (..._a: unknown[]) => 'enviado'),
}));
vi.mock('@/modules/expedientes/expediente-workflow.service', () => ({
  executeTransition: (...a: unknown[]) => mockBlq.executeTransition(...a),
}));
vi.mock('@/modules/beneficios/beneficios.service', () => ({ gerenciaGeneralIds: () => mockBlq.gerenciaIds() }));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: (...a: unknown[]) => mockBlq.enviarTemplate(...a) }));
vi.mock('@/modules/estudios/pago.guard', async (importOriginal) => ({
  // errorNoAfianzableSegunCobro, real: lee la tabla `pagos` de la cola.
  ...(await importOriginal<typeof import('@/modules/estudios/pago.guard')>()),
  estudioYaCobrado: (...args: unknown[]) => mockEstudioYaCobrado(...args),
  // Misma fuente que estudioYaCobrado en los tests; 'no_verificable' se prueba aparte.
  leerSenalPagoEstudio: async (...args: unknown[]) => ((await mockEstudioYaCobrado(...args)) ? 'pagado' : 'no_pagado'),
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
vi.mock('@/modules/pago-estudio/pago-estudio.service', () => ({
  getPrecioEstudio: vi.fn(async () => ({ base: 150000, iva: 28500, total: 178500, tarifaIva: 19 })),
  montoProspecto: (m: number, t?: number | null) => `$${m.toLocaleString('es-CO')}${t && t > 0 ? ' (IVA incluido)' : ''}`,
}));
// Flujo §14 / Adenda §9: el enlace vive DIAS_EXPIRACION_ESTUDIO dias.
// BLQ §9: límites del bloqueo por documento (ALERTA_BLOQUEO_WHATSAPP se cambia por test).
const mockCal = vi.hoisted(() => ({
  DIAS_EXPIRACION_ESTUDIO: 15,
  UMBRAL_DIFERENCIA_INGRESO: 50,
  UMBRAL_SIMILITUD_BIOMETRICA: 80,
  MAX_INTENTOS_DOCUMENTO: 3,
  MAX_CORRECCIONES_DOCUMENTO: 2,
  MAX_REENVIOS_ENLACE: 3,
  ALERTA_BLOQUEO_WHATSAPP: 0,
}));
vi.mock('@/lib/calibracion', () => ({
  getCalibracion: vi.fn(async () => mockCal),
}));

// Import AFTER mocks
import {
  getAutorizacionForExpediente,
  getAutorizacionByToken,
  enviarEnlaceAutorizacion,
  firmarAutorizacion,
  enviarOtpCode,
  verificarOtpCode,
  revocarAutorizacion,
  getPagoProspectoPorToken,
  confirmarIdentidadProspecto,
  reportarIdentidadProspecto,
  documentoCoincide,
  verificarBiometriaProspecto,
  omitirBiometriaProspecto,
  guardarPerfilProspecto,
  corregirDocumentoProspecto,
  getTrazaAutorizacion,
  listBloqueosPendientes,
} from '../autorizaciones.service';
import { derivarEstadoBloqueo } from '../bloqueo-documento';
import { logAudit } from '@/lib/auditLog';
import { logger } from '@/lib/logger';
import { TEXTO_LEGAL, TEXTO_LEGAL_BIOMETRIA, VERSION_TERMINOS, VERSION_TERMINOS_BIOMETRIA } from '../autorizaciones.texto';
import { firmarSchema } from '../autorizaciones.schema';
// Precargados a proposito: el servicio los importa en segundo plano y, con dos
// import() concurrentes del mismo mock, vitest puede saltarse el mock y cargar
// el modulo real (mismo limite que en expediente-workflow.service.test).
import '@/modules/notificaciones/notificaciones.service';
import '@/modules/users/users.service';
import '@/modules/expedientes/expediente-workflow.service';
import '@/modules/beneficios/beneficios.service';
import '@/modules/whatsapp';

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
// §8.1: toda firma lleva el documento que escribio el prospecto (el de la ficha).
const DOC = { numero_documento: '123456789' };
const CANVAS = { metodo_firma: 'canvas' as const, datos_firma: 'data:image/png;base64,AAA', ...DOC };
const OTP = { metodo_firma: 'otp' as const, codigo_otp: '123456', ...DOC };
const CASILLA = { metodo_firma: 'casilla' as const, ...DOC };

const opsDe = (table: string, method: string) => ops.filter((o) => o.table === table && o.method === method);

describe('autorizaciones.service', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    vi.clearAllMocks();
    mockEnv.AUCO_BIOMETRIA_ENABLED = false;
    mockCal.ALERTA_BLOQUEO_WHATSAPP = 0;
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
      // Solo la fila del TITULAR: la del coarrendatario comparte expediente_id.
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

    it('lanza las lecturas sin esperar al guard, y con 404 no devuelve nada', async () => {
      let soltarGuard!: () => void;
      mockAssertAccess.mockReturnValueOnce(new Promise<undefined>((r) => (soltarGuard = () => r(undefined))));
      enqueue('expedientes', { data: { id: EXPEDIENTE_ID } });
      enqueue('autorizaciones_habeas_data', { data: { id: AUTORIZACION_ID, estado: 'pendiente' } });

      const pendiente = getAutorizacionForExpediente(EXPEDIENTE_ID, USER_ID, 'inmobiliaria');
      // Con el guard aún pendiente, las tres consultas ya salieron (antes 4 idas en serie).
      for (const t of ['expedientes', 'autorizaciones_habeas_data', 'autorizacion_perfil_prospecto']) {
        expect(mockFrom).toHaveBeenCalledWith(t);
      }
      soltarGuard();
      await expect(pendiente).resolves.toMatchObject({ id: AUTORIZACION_ID });

      mockAssertAccess.mockRejectedValueOnce(Object.assign(new Error('Estudio no encontrado'), { statusCode: 404 }));
      enqueue('expedientes', { data: { id: EXPEDIENTE_ID } });
      enqueue('autorizaciones_habeas_data', { data: { id: AUTORIZACION_ID, estado: 'autorizado' } });
      await expect(getAutorizacionForExpediente(EXPEDIENTE_ID, 'intruso', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
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
        { count: 0 },                        // BLQ §4: enlaces previos (primer envío)
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
        15 * 24, // Flujo §14 "Plazo de expiracion: 15 dias", no 48 h
        // M5: el correo dice lo mismo que el WhatsApp v2 (quién pide y dónde).
        { quienSolicita: 'El propietario del inmueble', direccion: 'Calle 1 #2-3, Bogota' },
      );
      // Sin celular no hay WhatsApp.
      expect(mockEnviarMensaje).not.toHaveBeenCalled();
      // §8.4: se congela el texto y la version que de verdad se presentaron.
      const insert = opsDe('autorizaciones_habeas_data', 'insert')[0].args[0] as Record<string, unknown>;
      // El token caduca con el estudio (15 dias calibrables), no antes.
      const expira = new Date(String(insert.token_expiracion)).getTime();
      expect(expira).toBeGreaterThan(Date.now() + 14 * 24 * 60 * 60 * 1000);
      expect(expira).toBeLessThanOrEqual(Date.now() + 15 * 24 * 60 * 60 * 1000 + 1000);
      expect(insert).toMatchObject({ estado: 'pendiente', texto_autorizado: TEXTO_LEGAL, version_terminos: VERSION_TERMINOS });
      expect(String(insert.token)).toHaveLength(64);
      // Las pendientes anteriores DEL TITULAR se expiran (no las del coarrendatario).
      expect(opsDe('autorizaciones_habeas_data', 'update')[0].args[0]).toEqual({ estado: 'expirado' });
      expect(opsDe('autorizaciones_habeas_data', 'is').some((o) => o.args[0] === 'coarrendatario_id')).toBe(true);
    });

    it('manda tambien el enlace por WhatsApp cuando hay celular', async () => {
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, telefono: '+573001112233' } } });
      enqueue('autorizaciones_habeas_data', { count: 0 }, { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });

      await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID);

      // Plantilla v2: nombre, quién pide (sin inmobiliaria: genérico, nunca el
      // nombre de una persona), dirección, enlace y días de vigencia.
      expect(mockEnviarMensaje).toHaveBeenCalledWith(expect.objectContaining({
        to: '+573001112233',
        template_id: 'cofianza_autorizacion_link_v2',
        variables: ['Juan', 'El propietario del inmueble', 'Calle 1 #2-3, Bogota', expect.stringContaining('/autorizar/'), '15'],
      }));
    });

    it('B15: si no se puede leer la inmobiliaria, el WhatsApp dice un sujeto neutro (nunca «El propietario»)', async () => {
      enqueue('expedientes', {
        data: {
          ...expedienteConSolicitante,
          solicitantes: { ...expedienteConSolicitante.solicitantes, telefono: '+573001112233' },
          inmuebles: { ...expedienteConSolicitante.inmuebles, inmobiliaria_id: 'org-1' },
        },
      });
      enqueue('autorizaciones_habeas_data', { count: 0 }, { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });
      enqueue('inmobiliarias', { data: null, error: { message: 'timeout' } });

      await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID);

      expect(mockEnviarMensaje).toHaveBeenCalledWith(expect.objectContaining({
        variables: ['Juan', 'Quien tramita su arriendo', 'Calle 1 #2-3, Bogota', expect.stringContaining('/autorizar/'), '15'],
      }));
    });

    it('con inmobiliaria, la plantilla dice su nombre como quien pide el estudio', async () => {
      enqueue('expedientes', {
        data: {
          ...expedienteConSolicitante,
          solicitantes: { ...expedienteConSolicitante.solicitantes, telefono: '+573001112233' },
          inmuebles: { ...expedienteConSolicitante.inmuebles, inmobiliaria_id: 'org-1' },
        },
      });
      enqueue('autorizaciones_habeas_data', { count: 0 }, { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });
      enqueue('inmobiliarias', { data: { nombre: 'Inmobiliaria Norte' } });

      await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID);

      expect(mockEnviarMensaje).toHaveBeenCalledWith(expect.objectContaining({
        variables: ['Juan', 'Inmobiliaria Norte', 'Calle 1 #2-3, Bogota', expect.stringContaining('/autorizar/'), '15'],
      }));
    });

    it('M5: el correo nombra a la inmobiliaria aunque el prospecto no tenga celular', async () => {
      enqueue('expedientes', {
        data: { ...expedienteConSolicitante, inmuebles: { ...expedienteConSolicitante.inmuebles, inmobiliaria_id: 'org-1' } },
      });
      enqueue('autorizaciones_habeas_data', { count: 0 }, { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });
      enqueue('inmobiliarias', { data: { nombre: 'Inmobiliaria Norte' } });

      await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID);

      expect(mockSendAutorizacionEmail.mock.calls[0][4]).toEqual({
        quienSolicita: 'Inmobiliaria Norte',
        direccion: 'Calle 1 #2-3, Bogota',
      });
      expect(mockEnviarMensaje).not.toHaveBeenCalled();
    });

    it('B18: inmueble de inmobiliaria con inmobiliaria_id null → la organización de su dueño', async () => {
      mockOrgDelPerfil.mockResolvedValueOnce('org-9');
      enqueue('expedientes', {
        data: {
          ...expedienteConSolicitante,
          solicitantes: { ...expedienteConSolicitante.solicitantes, telefono: '+573001112233' },
          inmuebles: { ...expedienteConSolicitante.inmuebles, propietario_id: 'titular-1', inmobiliaria_id: null },
        },
      });
      enqueue('autorizaciones_habeas_data', { count: 0 }, { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });
      enqueue('inmobiliarias', { data: { nombre: 'Inmobiliaria Sur' } });

      await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID);

      expect(mockOrgDelPerfil).toHaveBeenCalledWith('titular-1');
      expect(opsDe('inmobiliarias', 'eq')[0].args).toEqual(['id', 'org-9']);
      expect(mockSendAutorizacionEmail.mock.calls[0][4]).toMatchObject({ quienSolicita: 'Inmobiliaria Sur' });
      expect(mockEnviarMensaje).toHaveBeenCalledWith(expect.objectContaining({
        variables: ['Juan', 'Inmobiliaria Sur', 'Calle 1 #2-3, Bogota', expect.stringContaining('/autorizar/'), '15'],
      }));
    });

    it('B18: propietario individual (sin organización) sigue siendo «El propietario del inmueble»', async () => {
      enqueue('expedientes', {
        data: { ...expedienteConSolicitante, inmuebles: { ...expedienteConSolicitante.inmuebles, propietario_id: 'prop-1' } },
      });
      enqueue('autorizaciones_habeas_data', { count: 0 }, { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });

      await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID);

      expect(mockOrgDelPerfil).toHaveBeenCalledWith('prop-1');
      expect(mockFrom).not.toHaveBeenCalledWith('inmobiliarias');
      expect(mockSendAutorizacionEmail.mock.calls[0][4]).toMatchObject({ quienSolicita: 'El propietario del inmueble' });
    });

    it('con la biometria encendida presenta y congela el texto 3.0-biometria', async () => {
      mockEnv.AUCO_BIOMETRIA_ENABLED = true;
      enqueue('expedientes', { data: expedienteConSolicitante });
      enqueue('autorizaciones_habeas_data', { count: 0 }, { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });

      await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID);

      const insert = opsDe('autorizaciones_habeas_data', 'insert')[0].args[0] as Record<string, unknown>;
      expect(insert).toMatchObject({ texto_autorizado: TEXTO_LEGAL_BIOMETRIA, version_terminos: VERSION_TERMINOS_BIOMETRIA });
      expect(insert.texto_autorizado).not.toBe(TEXTO_LEGAL);
    });

    it('no re-crea el enlace si ya hay una firma vigente (AUTORIZACION_YA_FIRMADA)', async () => {
      enqueue('expedientes', { data: expedienteConSolicitante });
      enqueue('autorizaciones_habeas_data', { count: 1 }, { data: { id: 'firmada-uuid' } });

      await expect(enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_YA_FIRMADA',
      });
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toHaveLength(0);
      expect(mockSendAutorizacionEmail).not.toHaveBeenCalled();
    });

    it('firma vigente con el MISMO documento de la ficha: sigue sin re-crear el enlace', async () => {
      enqueue('expedientes', { data: expedienteConSolicitante });
      enqueue('autorizaciones_habeas_data', { count: 1 }, {
        data: { id: 'firmada-uuid', numero_documento_aceptante: '123.456.789', tipo_documento_aceptante: 'cc' },
      });

      await expect(enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID)).rejects.toMatchObject({
        errorCode: 'AUTORIZACION_YA_FIRMADA',
      });
    });

    it('cédula corregida (por «Corregir documento») con una firma vieja del documento errado: emite un enlace nuevo sin tocar la firma', async () => {
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, numero_documento: '923456789' } } });
      enqueue(
        'autorizaciones_habeas_data',
        { count: 1 },
        // Firmó con la cédula errada que tenía la ficha.
        { data: { id: 'firmada-uuid', numero_documento_aceptante: '123456789', tipo_documento_aceptante: 'cc' } },
        { data: [] },
        { data: { id: AUTORIZACION_ID } },
      );

      const result = await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID);

      expect(result).toMatchObject({ id: AUTORIZACION_ID, estado: 'pendiente' });
      // La firma vieja no se toca (solo se expiran las pendientes).
      expect(opsDe('autorizaciones_habeas_data', 'update').map((o) => o.args[0])).toEqual([{ estado: 'expirado' }]);
      // Es un reenvío: queda en la traza.
      expect(opsDe('autorizacion_envios', 'insert')[0].args[0]).toMatchObject({ autorizacion_id: AUTORIZACION_ID, es_reenvio: true });
    });

    it('BLQ §3.5: la ficha ya tiene documento y el enlace trae otro → 409 hacia «Corregir documento», sin tocar nada', async () => {
      enqueue('expedientes', { data: expedienteConSolicitante });
      enqueue('autorizaciones_habeas_data', { count: 0 });
      const err = await enviarEnlaceAutorizacion(
        EXPEDIENTE_ID, USER_ID, undefined, { tipo_documento: 'cc', numero_documento: '923456789' }, 'inmobiliaria',
      ).catch((e) => e);
      expect(err).toMatchObject({ statusCode: 409, errorCode: 'DOCUMENTO_REQUIERE_CORRECCION' });
      expect(opsDe('solicitantes', 'update')).toEqual([]);
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toEqual([]);
    });

    it('documento que faltaba y ya lo tiene otro solicitante de la inmobiliaria: 409 que dice la causa, sin emitir', async () => {
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, numero_documento: '' } } });
      enqueue('autorizaciones_habeas_data', { count: 0 });
      enqueue('solicitantes', { error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_solicitantes_documento_por_agencia"' } });

      const err = await enviarEnlaceAutorizacion(
        EXPEDIENTE_ID, USER_ID, undefined, { tipo_documento: 'cc', numero_documento: '923456789' }, 'inmobiliaria',
      ).catch((e) => e);

      expect(err).toMatchObject({ statusCode: 409, errorCode: 'DOCUMENTO_DUPLICADO' });
      expect(err.message).toMatch(/^Esa cédula ya está registrada para otro solicitante de su inmobiliaria\./);
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toEqual([]);
    });

    describe('BLQ §4: reenvíos', () => {
      it('la inmobiliaria recibe 409 en el cuarto reenvío; nada se escribe', async () => {
        enqueue('expedientes', { data: expedienteConSolicitante });
        enqueue('autorizaciones_habeas_data', { count: 4 }, { data: { id: 'aut-4', estado: 'expirado', created_at: '2026-10-01T00:00:00Z' } });
        const err = await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID, undefined, { email: 'otro@correo.co' }, 'inmobiliaria').catch((e) => e);
        expect(err).toMatchObject({ statusCode: 409, errorCode: 'MAX_REENVIOS_ENLACE' });
        expect(err.message).toContain('Comuníquese con Cofianza');
        expect(opsDe('solicitantes', 'update')).toEqual([]);
        expect(opsDe('autorizaciones_habeas_data', 'insert')).toEqual([]);
      });

      it('el tercer reenvío de la inmobiliaria todavía sale', async () => {
        enqueue('expedientes', { data: expedienteConSolicitante });
        enqueue('autorizaciones_habeas_data', { count: 3 }, { data: { id: 'aut-3', estado: 'expirado', created_at: '2026-10-01T00:00:00Z' } }, { data: null }, { data: [{ id: 'aut-3' }] }, { data: { id: AUTORIZACION_ID } });
        await expect(enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID, undefined, undefined, 'inmobiliaria')).resolves.toMatchObject({ id: AUTORIZACION_ID });
      });

      it('el administrador queda exento del límite, con traza', async () => {
        const { logAudit } = await import('@/lib/auditLog');
        enqueue('expedientes', { data: expedienteConSolicitante });
        enqueue('autorizaciones_habeas_data', { count: 9 }, { data: null }, { data: [{ id: 'aut-9' }] }, { data: { id: AUTORIZACION_ID } });
        await expect(enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID, undefined, undefined, 'administrador')).resolves.toMatchObject({ id: AUTORIZACION_ID });
        expect(vi.mocked(logAudit).mock.calls.at(-1)![0].detalle).toMatchObject({ es_reenvio: true, reenvio_numero: 9 });
        // El enlace anterior queda «reemplazado» (§4.2).
        const cierre = opsDe('autorizacion_envios', 'update')[0];
        expect(cierre.args[0]).toMatchObject({ motivo_cierre: 'reemplazado' });
        expect(opsDe('autorizacion_envios', 'in')[0].args).toEqual(['autorizacion_id', ['aut-9']]);
      });

      it('después de «no soy yo» la inmobiliaria recibe 409 «Comuníquese con Cofianza»', async () => {
        enqueue('expedientes', { data: expedienteConSolicitante });
        enqueue('autorizaciones_habeas_data', { count: 1 }, { data: { id: 'aut-1', estado: 'expirado', created_at: '2026-10-01T00:00:00Z' } });
        enqueue('autorizacion_envios', { data: { motivo_cierre: 'no_soy_yo' } });
        const err = await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID, undefined, undefined, 'propietario').catch((e) => e);
        expect(err).toMatchObject({ statusCode: 409, errorCode: 'IDENTIDAD_RECHAZADA' });
        expect(err.message).toContain('Comuníquese con Cofianza');
        expect(opsDe('autorizaciones_habeas_data', 'insert')).toEqual([]);
      });

      it('guarda el resultado por canal con el destino enmascarado', async () => {
        enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, telefono: '+573001112233' } } });
        enqueue('autorizaciones_habeas_data', { count: 0 }, { data: null }, { data: [] }, { data: { id: AUTORIZACION_ID } });
        await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID);
        const fila = opsDe('autorizacion_envios', 'insert')[0].args[0] as { es_reenvio: boolean; envios: unknown[] };
        expect(fila.es_reenvio).toBe(false);
        expect(fila.envios).toEqual([
          { canal: 'correo', destino_enmascarado: 'ju***@test.com', estado: 'enviado' },
          { canal: 'whatsapp', destino_enmascarado: '••• ••33', estado: 'enviado' },
        ]);
        expect(JSON.stringify(fila)).not.toContain('juan@test.com');
      });
    });

    // Con «cada miembro ve solo lo suyo»: el estudio NO asignado de un compañero.
    // Antes bastaba ser de la organización (perfilEsDuenoDeInmueble en true).
    it('el asesor restringido no envía la autorización de un estudio de un compañero: 403 sin crear nada', async () => {
      mockAssertAccess.mockRejectedValueOnce(Object.assign(new Error('Estudio no encontrado'), { statusCode: 404, errorCode: 'EXPEDIENTE_NOT_FOUND' }));
      enqueue('expedientes', { data: expedienteConSolicitante });
      enqueue('autorizaciones_habeas_data', { count: 0 }, { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });

      await expect(
        enviarEnlaceAutorizacion(EXPEDIENTE_ID, 'asesor', undefined, { email: 'desvio@correo.co' }, 'inmobiliaria'),
      ).rejects.toMatchObject({ statusCode: 403, errorCode: 'AUTORIZACION_FORBIDDEN' });
      expect(mockAssertAccess).toHaveBeenCalledWith(EXPEDIENTE_ID, 'asesor', 'inmobiliaria');
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toHaveLength(0);
      expect(opsDe('solicitantes', 'update')).toHaveLength(0);
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

    it('H43: ficha sin documento (auto-registro liviano) -> SOLICITANTE_SIN_DOCUMENTO sin crear enlace', async () => {
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, numero_documento: '' } } });
      await expect(enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'SOLICITANTE_SIN_DOCUMENTO',
      });
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toEqual([]);
    });

    it('H43: el gestor escribe el documento que faltaba y el enlace sale', async () => {
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, numero_documento: '' } } });
      enqueue('autorizaciones_habeas_data', { count: 0 }, { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });
      const result = await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID, undefined, { tipo_documento: 'cc', numero_documento: '123456789' });
      expect(result).toMatchObject({ id: AUTORIZACION_ID, estado: 'pendiente' });
      expect(opsDe('solicitantes', 'update')[0].args[0]).toEqual({ numero_documento: '123456789' });
    });

    it('H43: el gestor escribe un documento que ya es de OTRA cuenta de solicitante -> 409 sin guardar ni emitir', async () => {
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, numero_documento: '', creado_por: 'cuenta-a', inmobiliaria_id: null } } });
      enqueue('solicitantes', { data: [{ id: 'ficha-b', creado_por: 'cuenta-b', inmobiliaria_id: null }] });
      enqueue('perfiles', { data: [{ id: 'cuenta-a', rol: 'solicitante' }, { id: 'cuenta-b', rol: 'solicitante' }] });
      await expect(
        enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID, undefined, { tipo_documento: 'cc', numero_documento: '123456789' }),
      ).rejects.toMatchObject({ statusCode: 409, errorCode: 'DOCUMENT_ALREADY_EXISTS' });
      expect(opsDe('solicitantes', 'update')).toEqual([]);
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toEqual([]);
    });

    it('Adenda §6.1: el gestor escribe un NIT -> 409 ESTUDIO_NO_AFIANZABLE sin guardar ni emitir', async () => {
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, numero_documento: '' } } });
      await expect(
        enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID, undefined, { tipo_documento: 'nit', numero_documento: '900123456' }),
      ).rejects.toMatchObject({ statusCode: 409, errorCode: 'ESTUDIO_NO_AFIANZABLE' });
      expect(opsDe('solicitantes', 'update')).toEqual([]);
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toEqual([]);
    });

    // Revisión 2026-09-29, M6: el gestor ya pagó (o reservó el cupo) y luego escribe el NIT.
    it('M6: NIT con la evaluación ya pagada -> 409 sin «sin cobro» y aviso a Cofianza', async () => {
      const { listOperators } = await import('@/modules/users/users.service');
      const { notificarYCorreo } = await import('@/modules/notificaciones/notificaciones.service');
      vi.mocked(listOperators).mockResolvedValueOnce([{ id: 'op-1' }] as never);
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, numero_documento: '' } } });
      enqueue('pagos', { data: { id: 'pago-1' }, error: null });
      const err = await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID, undefined, { tipo_documento: 'nit', numero_documento: '900123456' }).catch((e) => e);
      expect(err).toMatchObject({ statusCode: 409, errorCode: 'ESTUDIO_NO_AFIANZABLE', details: { ya_cobrado: true } });
      expect(err.message).not.toContain('No se generó ningún cobro');
      expect(err.message).toContain('Cofianza revisará la devolución');
      expect(notificarYCorreo).toHaveBeenCalledWith(expect.objectContaining({ userId: 'op-1', link: `/expedientes/${EXPEDIENTE_ID}` }));
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toEqual([]);
    });

    it('Adenda §6.1: ficha de persona jurídica (aunque tenga cédula) -> 409 ESTUDIO_NO_AFIANZABLE sin emitir', async () => {
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, tipo_persona: 'juridica' } } });
      await expect(enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID)).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'ESTUDIO_NO_AFIANZABLE',
      });
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toEqual([]);
    });

    it('H43: ficha de agencia con el documento de una cuenta: no aplica la regla y el enlace sale', async () => {
      enqueue('expedientes', { data: { ...expedienteConSolicitante, solicitantes: { ...expedienteConSolicitante.solicitantes, numero_documento: '', creado_por: 'asesor', inmobiliaria_id: 'inmo-1' } } });
      enqueue('autorizaciones_habeas_data', { count: 0 }, { data: null }, { error: null }, { data: { id: AUTORIZACION_ID } });
      await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID, undefined, { tipo_documento: 'cc', numero_documento: '123456789' });
      expect(opsDe('perfiles', 'select')).toEqual([]);
      expect(opsDe('solicitantes', 'update')[0].args[0]).toEqual({ numero_documento: '123456789' });
    });

    it('estudio cerrado o rechazado: no se le pide la autorizacion al prospecto', async () => {
      for (const estado of ['cerrado', 'rechazado']) {
        enqueue('expedientes', { data: { ...expedienteConSolicitante, estado } });
        await expect(enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID)).rejects.toMatchObject({ errorCode: 'ESTUDIO_NO_ACTIVO' });
      }
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toHaveLength(0);
      expect(mockSendAutorizacionEmail).not.toHaveBeenCalled();
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
        solicitante: { nombre: 'Juan', apellido: 'Perez', tipo_documento: 'cc', telefono_masked: '••• ••33' },
        expediente: { numero_expediente: 'N.° 2026-0001', inmueble: { ciudad: 'Bogota' } },
      });
      // Ni el email ni el documento (tampoco enmascarado: lo escribe el prospecto, §8.1).
      expect(JSON.stringify(result)).not.toContain('123456789');
      expect(JSON.stringify(result)).not.toContain('6789');
      expect(result.solicitante).not.toHaveProperty('numero_documento_masked');
      expect(JSON.stringify(result)).not.toContain('@');
    });

    // A11: el enlace creado con el interruptor apagado congelo el texto sin la
    // clausula de datos sensibles; encender la biometria despues no puede
    // pedirle la selfie con ese texto.
    it('biometria requerida solo si el interruptor esta encendido Y el texto firmado es 3.0-biometria', async () => {
      mockEnv.AUCO_BIOMETRIA_ENABLED = true;
      enqueue('autorizaciones_habeas_data', { data: autorizacionPendiente });
      expect((await getAutorizacionByToken(TOKEN)).biometria.requerida).toBe(false);

      enqueue('autorizaciones_habeas_data', { data: { ...autorizacionPendiente, version_terminos: '3.0-biometria' } });
      expect((await getAutorizacionByToken(TOKEN)).biometria.requerida).toBe(true);

      mockEnv.AUCO_BIOMETRIA_ENABLED = false;
      enqueue('autorizaciones_habeas_data', { data: { ...autorizacionPendiente, version_terminos: '3.0-biometria' } });
      expect((await getAutorizacionByToken(TOKEN)).biometria.requerida).toBe(false);
    });

    it('A1/A2: dice quién pide el estudio y avisa el cobro antes de firmar', async () => {
      enqueue('autorizaciones_habeas_data', {
        data: {
          ...autorizacionPendiente,
          expediente_id: 'exp-1',
          expedientes: { ...autorizacionPendiente.expedientes, inmuebles: { ...autorizacionPendiente.expedientes.inmuebles, inmobiliaria_id: 'org-1' } },
        },
      });
      enqueue('inmobiliarias', { data: { nombre: 'Inmobiliaria Norte' } });
      mockEstudioYaCobrado.mockResolvedValueOnce(false);
      enqueue('estudios', { data: { pago_por: 'arrendatario' } });
      enqueue('pagos', { data: null });

      const result = await getAutorizacionByToken(TOKEN);

      expect(result.solicitado_por).toBe('Inmobiliaria Norte');
      // Adenda de precios §1.2: al prospecto, el total con el IVA incluido.
      expect(result.pago).toEqual({ requerido: true, monto_formateado: '$178.500 (IVA incluido)' });
    });

    it('B15: si falla la lectura, null («no sé») y no «El propietario» ni «sin cobro»', async () => {
      enqueue('autorizaciones_habeas_data', {
        data: {
          ...autorizacionPendiente,
          expediente_id: 'exp-1',
          expedientes: { ...autorizacionPendiente.expedientes, inmuebles: { ...autorizacionPendiente.expedientes.inmuebles, inmobiliaria_id: 'org-1' } },
        },
      });
      enqueue('inmobiliarias', { data: null, error: { message: 'timeout' } });
      mockEstudioYaCobrado.mockResolvedValueOnce(false);
      enqueue('estudios', { data: null, error: { message: 'timeout' } });

      const result = await getAutorizacionByToken(TOKEN);

      expect(result.solicitado_por).toBeNull();
      expect(result.pago).toBeNull();
    });

    it('A2: si lo paga la inmobiliaria no hay aviso de cobro; sin inmobiliaria, nombre genérico', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...autorizacionPendiente, expediente_id: 'exp-1' } });
      mockEstudioYaCobrado.mockResolvedValueOnce(false);
      enqueue('estudios', { data: { pago_por: 'inmobiliaria' } });

      const result = await getAutorizacionByToken(TOKEN);

      expect(result.solicitado_por).toBe('El propietario del inmueble');
      expect(result.pago).toEqual({ requerido: false, monto_formateado: null });
    });

    it('B17: sin pagador elegido (pago_por null) no afirma «sin costo»: requerido null', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...autorizacionPendiente, expediente_id: 'exp-1' } });
      enqueue('estudios', { data: { pago_por: null } });

      const result = await getAutorizacionByToken(TOKEN);

      expect(result.pago).toEqual({ requerido: null, monto_formateado: null });
    });

    it('B17: ya pagado manda sobre el pagador sin elegir (requerido false)', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...autorizacionPendiente, expediente_id: 'exp-1' } });
      mockEstudioYaCobrado.mockResolvedValueOnce(true);
      enqueue('estudios', { data: { pago_por: null } });

      expect((await getAutorizacionByToken(TOKEN)).pago).toEqual({ requerido: false, monto_formateado: null });
    });

    it('B16: pagado, pagador y fila de pago se leen a la vez; un fallo que no hacía falta no cuenta', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...autorizacionPendiente, expediente_id: 'exp-1' } });
      let soltar!: (v: boolean) => void;
      mockEstudioYaCobrado.mockImplementationOnce(() => new Promise<boolean>((r) => { soltar = r; }));
      // Si ya está pagado, el error leyendo el pagador no importa (igual que antes).
      enqueue('estudios', { data: null, error: { message: 'timeout' } });

      const pendiente = getAutorizacionByToken(TOKEN);
      await vi.waitFor(() => expect(mockFrom).toHaveBeenCalledWith('pagos'));
      expect(mockFrom).toHaveBeenCalledWith('estudios');
      soltar(true);

      expect((await pendiente).pago).toEqual({ requerido: false, monto_formateado: null });
    });

    it('B18: la pantalla pública también resuelve la inmobiliaria por el dueño del inmueble', async () => {
      mockOrgDelPerfil.mockResolvedValueOnce('org-9');
      enqueue('autorizaciones_habeas_data', {
        data: {
          ...autorizacionPendiente,
          expedientes: {
            ...autorizacionPendiente.expedientes,
            inmuebles: { ...autorizacionPendiente.expedientes.inmuebles, inmobiliaria_id: null, propietario_id: 'titular-1' },
          },
        },
      });
      enqueue('inmobiliarias', { data: { nombre: 'Inmobiliaria Sur' } });

      expect((await getAutorizacionByToken(TOKEN)).solicitado_por).toBe('Inmobiliaria Sur');
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

    it('estudio cancelado o rechazado con la autorizacion pendiente -> ESTUDIO_NO_ACTIVO (no se firma)', async () => {
      for (const estado of ['cerrado', 'rechazado']) {
        enqueue('autorizaciones_habeas_data', {
          data: { ...autorizacionPendiente, expedientes: { ...autorizacionPendiente.expedientes, estado } },
        });
        await expect(getAutorizacionByToken(TOKEN)).rejects.toMatchObject({ statusCode: 400, errorCode: 'ESTUDIO_NO_ACTIVO' });
      }
      // Tambien con el enlace ya vencido: "pide otro" seria mandarlo a pedir algo que no existe.
      enqueue('autorizaciones_habeas_data', {
        data: { ...autorizacionPendiente, token_expiracion: PAST_DATE, expedientes: { ...autorizacionPendiente.expedientes, estado: 'cerrado' } },
      });
      await expect(getAutorizacionByToken(TOKEN)).rejects.toMatchObject({ errorCode: 'ESTUDIO_NO_ACTIVO' });
    });

    it('ya firmada Y vencida -> AUTORIZACION_YA_FIRMADA: reabrirla tarde no dice "pide otro"', async () => {
      enqueue('autorizaciones_habeas_data', {
        data: { ...autorizacionPendiente, estado: 'autorizado', token_expiracion: PAST_DATE },
      });
      await expect(getAutorizacionByToken(TOKEN)).rejects.toMatchObject({ errorCode: 'AUTORIZACION_YA_FIRMADA' });
      expect(opsDe('autorizaciones_habeas_data', 'update')).toHaveLength(0);
    });
  });

  // ============================================================
  // getPagoProspectoPorToken — la pantalla de "ya firmaste"
  // ============================================================

  describe('getPagoProspectoPorToken', () => {
    const firmadaHace = (ms: number) => ({
      data: {
        id: AUTORIZACION_ID,
        estado: 'autorizado',
        expediente_id: EXPEDIENTE_ID,
        autorizado_en: new Date(Date.now() - ms).toISOString(),
      },
    });

    it('recién firmada y sin cobro todavía: preparando', async () => {
      enqueue('autorizaciones_habeas_data', firmadaHace(10_000));
      enqueue('estudios', { data: { pago_por: 'arrendatario' } });
      expect(await getPagoProspectoPorToken(TOKEN)).toMatchObject({ estado: 'preparando', payment_link_url: null });
    });

    it('a los 2 minutos sin fila de pago: sin_enlace (deja de prometer el enlace)', async () => {
      enqueue('autorizaciones_habeas_data', firmadaHace(3 * 60_000));
      enqueue('estudios', { data: { pago_por: 'arrendatario' } });
      expect(await getPagoProspectoPorToken(TOKEN)).toMatchObject({ estado: 'sin_enlace', payment_link_url: null });
    });

    it('B16: el pagador y la fila de pago se piden a la vez; si no le toca pagar, no_aplica', async () => {
      enqueue('autorizaciones_habeas_data', firmadaHace(10_000));
      enqueue('estudios', { data: { pago_por: 'inmobiliaria' } });
      enqueue('pagos', { data: { estado: 'pendiente', monto: 150000, payment_link_url: 'https://mp/x' } });
      expect(await getPagoProspectoPorToken(TOKEN)).toEqual({ estado: 'no_aplica', monto_formateado: null, payment_link_url: null });
      expect(mockFrom).toHaveBeenCalledWith('pagos');
    });

    it('con el cobro creado: el enlace, aunque la firma sea vieja', async () => {
      enqueue('autorizaciones_habeas_data', firmadaHace(3 * 60_000));
      enqueue('estudios', { data: { pago_por: 'arrendatario' } });
      enqueue('pagos', { data: { estado: 'pendiente', monto: 150000, payment_link_url: 'https://mp/x' } });
      expect(await getPagoProspectoPorToken(TOKEN)).toMatchObject({ estado: 'pendiente', payment_link_url: 'https://mp/x' });
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

      const result = await firmarAutorizacion(TOKEN, CASILLA, '192.168.1.1', 'Mozilla/5.0');

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
      // Sin estudio no hay fila del perfil del prospecto donde marcar la identidad.
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')).toHaveLength(0);
    });

    it('guarda «Analítica de su perfil» tal como la marcó el prospecto (el body pasa por el schema)', async () => {
      enqueue('autorizaciones_habeas_data', { data: paraFirmar }, { data: [{ id: AUTORIZACION_ID }] });
      // Lo mismo que manda /autorizar al confirmar (paso 4).
      const body = firmarSchema.parse({
        metodo_firma: 'casilla',
        numero_documento: '123456789',
        consentimientos_opcionales: { analitica: true, comercial: false, historial_referencia: false },
      });

      await firmarAutorizacion(TOKEN, body, '1.1.1.1', 'UA');

      expect(opsDe('autorizaciones_habeas_data', 'update')[0].args[0]).toMatchObject({
        consent_analitica: true,
        consent_comercial: false,
        consent_historial_referencia: false,
      });
    });

    it('el documento escrito coincide (con puntos y espacios): la identidad queda confirmada en el perfil (§8.1)', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...paraFirmar, expediente_id: EXPEDIENTE_ID } }, { data: [{ id: AUTORIZACION_ID }] });

      const result = await firmarAutorizacion(TOKEN, { metodo_firma: 'casilla', numero_documento: '123.456 789' }, '1.1.1.1', 'UA');
      expect(result.estado).toBe('autorizado');

      // Mismas columnas que el PASO 5 (/perfil), en la fila 1:1 del expediente.
      const upsert = opsDe('autorizacion_perfil_prospecto', 'upsert')[0];
      expect(upsert.args[0]).toMatchObject({
        expediente_id: EXPEDIENTE_ID,
        autorizacion_id: AUTORIZACION_ID,
        identidad_confirmada: true,
        identidad_reporte: null,
      });
      expect((upsert.args[0] as Record<string, unknown>).identidad_confirmada_en).toEqual(expect.any(String));
      expect(upsert.args[1]).toEqual({ onConflict: 'expediente_id' });
      // La firma sigue igual: casilla sin OTP.
      expect(mockFrom).not.toHaveBeenCalledWith('autorizacion_otps');
    });

    it('firma con el documento correcto pero con los fallidos ya agotados (ráfaga): no firma', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...paraFirmar, expediente_id: EXPEDIENTE_ID } });
      enqueue('autorizacion_intentos_documento', { count: 3 });
      await expect(
        firmarAutorizacion(TOKEN, { metodo_firma: 'casilla', numero_documento: paraFirmar.solicitantes.numero_documento }, '1.1.1.1', 'UA'),
      ).rejects.toMatchObject({ statusCode: 400, errorCode: 'DOCUMENTO_NO_COINCIDE' });
      expect(mockOnHabeas).not.toHaveBeenCalled();
    });

    it('el documento escrito NO coincide y agota los intentos: no firma, detiene el enlace y alerta (§8.1/§12, BLQ §1)', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...paraFirmar, expediente_id: EXPEDIENTE_ID } });
      enqueue('autorizacion_intentos_documento', { error: null }, { count: 3 });

      await expect(
        firmarAutorizacion(TOKEN, { metodo_firma: 'casilla', numero_documento: '123456780' }, '1.1.1.1', 'UA'),
      ).rejects.toMatchObject({ statusCode: 400, errorCode: 'DOCUMENTO_NO_COINCIDE', details: { intentos_restantes: 0 } });
      // El intento queda con origen 'firma'.
      expect(opsDe('autorizacion_intentos_documento', 'insert')[0].args[0]).toMatchObject({ origen: 'firma', coincide: false });

      // Ni firma ni orquestador: la unica escritura sobre la autorizacion es expirarla.
      const updates = opsDe('autorizaciones_habeas_data', 'update');
      expect(updates).toHaveLength(1);
      expect(updates[0].args[0]).toEqual({ estado: 'expirado' });
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')[0].args[0]).toMatchObject({
        expediente_id: EXPEDIENTE_ID,
        identidad_reporte: 'datos_incorrectos',
      });
      expect(mockOnHabeas).not.toHaveBeenCalled();
      // El aviso al gestor dice que no coincidio, nunca el numero escrito.
      // (Filtrado por tipo: los avisos fire-and-forget de otros tests pueden caer aqui.)
      const avisoReporte = () =>
        (mockNotificarResponsable.mock.calls as unknown as Array<[{ tipo: string; mensaje: string }]>)
          .map((c) => c[0])
          .find((a) => a.tipo === 'autorizacion.bloqueo_documento');
      await vi.waitFor(() => expect(avisoReporte()).toBeDefined());
      const aviso = avisoReporte()!;
      expect(aviso.mensaje).toContain('no coincide con el registrado');
      expect(aviso.mensaje).not.toContain('123456780');
    });

    it('estudio cancelado o rechazado: no firma ni dispara nada (ESTUDIO_NO_ACTIVO)', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...paraFirmar, expediente_id: EXPEDIENTE_ID, expedientes: { estado: 'cerrado' } } });
      await expect(firmarAutorizacion(TOKEN, CASILLA)).rejects.toMatchObject({ errorCode: 'ESTUDIO_NO_ACTIVO' });
      expect(opsDe('autorizaciones_habeas_data', 'update')).toHaveLength(0);
      expect(mockOnHabeas).not.toHaveBeenCalled();

      // Ya firmada antes del cierre: sigue siendo el exito idempotente.
      enqueue('autorizaciones_habeas_data', { data: { ...paraFirmar, estado: 'autorizado', expedientes: { estado: 'cerrado' } } });
      await expect(firmarAutorizacion(TOKEN, CASILLA)).rejects.toMatchObject({ errorCode: 'AUTORIZACION_YA_FIRMADA' });
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
  // confirmarIdentidadProspecto — §8.1: el prospecto escribe su documento
  // ============================================================

  describe('biometria de la autorizacion: umbral del panel (Adenda 2 §9 y §10)', () => {
    const pendiente = {
      id: AUTORIZACION_ID,
      estado: 'pendiente',
      token_expiracion: FUTURE_DATE,
      expediente_id: EXPEDIENTE_ID,
      solicitante_id: 'sol-uuid',
      version_terminos: '3.0-biometria',
      solicitantes: { numero_documento: '123456789' },
      expedientes: { estado: 'en_revision' },
    };

    it('omitirla guarda el 80 % del panel, no el 70 % del env', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      await omitirBiometriaProspecto(TOKEN);
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')[0].args[0]).toMatchObject({
        biometria: { estado: 'omitida', umbral: 80 },
      });
    });

    it('el cotejo responde con el mismo umbral', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      const r = await verificarBiometriaProspecto(TOKEN, { documentImage: 'x', photo: 'y' });
      expect(r.umbral).toBe(80);
    });
  });

  describe('guardarPerfilProspecto: ¿RUT activo? (Politica Anexo A.3/A.4)', () => {
    const pendiente = {
      id: AUTORIZACION_ID,
      estado: 'pendiente',
      token_expiracion: FUTURE_DATE,
      expediente_id: EXPEDIENTE_ID,
      solicitante_id: 'sol-uuid',
      version_terminos: '3.0',
      solicitantes: { numero_documento: '123456789' },
      expedientes: { estado: 'en_revision' },
    };

    it('va en un UPDATE aparte: si la columna no existe, lo demas del perfil ya quedo guardado', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      enqueue('autorizacion_perfil_prospecto', { error: null }, { error: { message: 'column "tiene_rut" does not exist' } });
      const r = await guardarPerfilProspecto(TOKEN, { situacion_laboral: 'independiente', tiene_rut: false });
      expect(r).toEqual({ guardado: true });
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')[0].args[0]).toMatchObject({ situacion_laboral: 'independiente' });
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')[0].args[0]).not.toHaveProperty('tiene_rut');
      expect(opsDe('autorizacion_perfil_prospecto', 'update')[0].args[0]).toEqual({ tiene_rut: false });
    });

    it('sin independiente no se guarda la respuesta del RUT', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      await guardarPerfilProspecto(TOKEN, { situacion_laboral: 'empleado', tiene_rut: true });
      expect(opsDe('autorizacion_perfil_prospecto', 'update')).toHaveLength(0);
    });
  });

  describe('confirmarIdentidadProspecto', () => {
    const pendiente = {
      id: AUTORIZACION_ID,
      estado: 'pendiente',
      token_expiracion: FUTURE_DATE,
      expediente_id: EXPEDIENTE_ID,
      solicitante_id: 'sol-uuid',
      version_terminos: '3.0',
      solicitantes: { numero_documento: '1.023.456.789' },
      expedientes: { estado: 'en_revision' },
    };

    it('coincide (normalizando puntos y espacios): confirma la identidad y no revela nada', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      enqueue('autorizacion_intentos_documento', { error: null }, { count: 0 });
      const r = await confirmarIdentidadProspecto(TOKEN, { numero_documento: ' 1023 456789' });
      expect(r).toEqual({ coincide: true });
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')[0].args[0]).toMatchObject({
        expediente_id: EXPEDIENTE_ID,
        autorizacion_id: AUTORIZACION_ID,
        identidad_confirmada: true,
        identidad_reporte: null,
      });
      expect(opsDe('autorizaciones_habeas_data', 'update')).toHaveLength(0);
    });

    it('no coincide y agota los intentos: mismo camino que "los datos estan mal" — detiene el enlace y avisa al gestor', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      enqueue('autorizacion_intentos_documento', { error: null }, { count: 3 });
      const r = await confirmarIdentidadProspecto(TOKEN, { numero_documento: '1023456788' }, '1.1.1.1', 'UA');
      expect(r).toEqual({ coincide: false, intentos_restantes: 0 });
      // BLQ §7: el enlace se cierra por intentos.
      expect(opsDe('autorizacion_envios', 'update')[0].args[0]).toMatchObject({ motivo_cierre: 'intentos' });
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')[0].args[0]).toMatchObject({ identidad_reporte: 'datos_incorrectos' });
      expect(opsDe('autorizaciones_habeas_data', 'update')[0].args[0]).toEqual({ estado: 'expirado' });
      await vi.waitFor(() => expect(mockNotificarResponsable).toHaveBeenCalled());
    });

    it('estudio cerrado: ESTUDIO_NO_ACTIVO sin tocar nada', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...pendiente, expedientes: { estado: 'cerrado' } } });
      await expect(confirmarIdentidadProspecto(TOKEN, { numero_documento: '1023456789' })).rejects.toMatchObject({
        errorCode: 'ESTUDIO_NO_ACTIVO',
      });
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')).toHaveLength(0);
    });

    it('el reporte manual sigue igual (mismo camino)', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      expect(await reportarIdentidadProspecto(TOKEN, { motivo: 'no_soy_yo' })).toEqual({ reportado: true });
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')[0].args[0]).toMatchObject({ identidad_reporte: 'no_soy_yo' });
      expect(opsDe('autorizaciones_habeas_data', 'update')[0].args[0]).toEqual({ estado: 'expirado' });
    });

    it('M1: reintento de un reporte que sí entró (enlace ya detenido por él) = éxito, sin escribir de nuevo', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...pendiente, estado: 'expirado' } }, { data: { id: AUTORIZACION_ID } });
      enqueue('autorizacion_perfil_prospecto', { data: { identidad_reporte: 'no_soy_yo' } });
      expect(await reportarIdentidadProspecto(TOKEN, { motivo: 'no_soy_yo' })).toEqual({ reportado: true });
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')).toHaveLength(0);
      expect(opsDe('autorizaciones_habeas_data', 'update')).toHaveLength(0);
    });

    it('M1: enlace ya no pendiente y SIN reporte (vencido, firmado en otra pestaña) = sigue el error', async () => {
      enqueue('autorizaciones_habeas_data', { data: { ...pendiente, estado: 'autorizado' } }, { data: { id: AUTORIZACION_ID } });
      enqueue('autorizacion_perfil_prospecto', { data: null });
      await expect(reportarIdentidadProspecto(TOKEN, { motivo: 'datos_incorrectos' })).rejects.toMatchObject({
        errorCode: 'AUTORIZACION_NO_VIGENTE',
      });
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')).toHaveLength(0);
    });

    it('documentoCoincide: sin numero en la ficha no hay nada que confirmar', () => {
      expect(documentoCoincide('1.023.456.789', '1023456789')).toBe(true);
      expect(documentoCoincide('ab-12 3', 'AB123')).toBe(true);
      expect(documentoCoincide('1023456789', null)).toBe(false);
      expect(documentoCoincide('', '')).toBe(false);
      expect(documentoCoincide('102345678', '1023456789')).toBe(false);
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

      expect(result.mensaje).toBe('Código OTP enviado al correo del solicitante');
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

      expect(result.mensaje).toBe('Código OTP enviado por WhatsApp y correo');
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

      expect(result).toEqual({ verificado: true, mensaje: 'Código OTP verificado correctamente' });
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
    const motivo = { canal: 'correo' as const, fecha_solicitud: '2026-09-20', motivo: 'Correo del titular pidiendo revocar' };

    it('debe revocar la autorizacion activa DEL TITULAR', async () => {
      enqueue('autorizaciones_habeas_data', { data: { id: AUTORIZACION_ID, estado: 'autorizado' } }, { error: null });

      const result = await revocarAutorizacion(EXPEDIENTE_ID, motivo, USER_ID, 'administrador', '127.0.0.1');

      expect(result).toMatchObject({ estado: 'revocado' });
      expect(result.fecha_revocacion).toBeDefined();
      expect(mockAssertAccess).toHaveBeenCalledWith(EXPEDIENTE_ID, USER_ID, 'administrador');
      // Fecha, canal y soporte de la solicitud del titular quedan en la fila (Ley 1581 art. 8).
      expect(opsDe('autorizaciones_habeas_data', 'update')[0].args[0]).toMatchObject({
        estado: 'revocado',
        motivo_revocacion: 'Solicitud del titular recibida por correo electrónico el 20/09/2026. Soporte: Correo del titular pidiendo revocar',
      });
      // Sujeto: el titular (coarrendatario_id IS NULL), nunca "la mas reciente".
      expect(opsDe('autorizaciones_habeas_data', 'is').some((o) => o.args[0] === 'coarrendatario_id' && o.args[1] === null)).toBe(true);
    });

    it('con coarrendatario_id revoca la del coarrendatario, no la del titular', async () => {
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

  // ============================================================
  // BLQ: bloqueo por documento (07/10/2026)
  // ============================================================

  describe('BLQ §1: intentos en el mismo enlace', () => {
    const pendiente = {
      id: AUTORIZACION_ID,
      estado: 'pendiente',
      token_expiracion: FUTURE_DATE,
      expediente_id: EXPEDIENTE_ID,
      solicitante_id: 'sol-uuid',
      version_terminos: '3.0',
      solicitantes: { numero_documento: '1023456789', tipo_documento: 'cc' },
      expedientes: { estado: 'en_revision' },
    };

    it('primer fallo: le quedan 2, el enlace sigue vivo y nada revela el número', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      enqueue('autorizacion_intentos_documento', { error: null }, { count: 1 });
      const r = await confirmarIdentidadProspecto(TOKEN, { numero_documento: '1023456788' }, '1.1.1.1', 'UA');
      expect(r).toEqual({ coincide: false, intentos_restantes: 2 });
      expect(JSON.stringify(r)).not.toContain('1023456789');
      expect(opsDe('autorizaciones_habeas_data', 'update')).toHaveLength(0);
      expect(opsDe('autorizacion_intentos_documento', 'insert')[0].args[0]).toMatchObject({
        autorizacion_id: AUTORIZACION_ID,
        expediente_id: EXPEDIENTE_ID,
        tipo_digitado: 'cc',
        valor_digitado: '1023456788',
        coincide: false,
        origen: 'confirmacion',
        ip: '1.1.1.1',
        user_agent: 'UA',
      });
      // El conteo es por enlace: un enlace nuevo reinicia el contador.
      expect(opsDe('autorizacion_intentos_documento', 'eq')[0].args).toEqual(['autorizacion_id', AUTORIZACION_ID]);
    });

    it('un acierto después de un fallo confirma la identidad', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      enqueue('autorizacion_intentos_documento', { error: null }, { count: 1 });
      expect(await confirmarIdentidadProspecto(TOKEN, { numero_documento: '1.023.456.789' })).toEqual({ coincide: true });
      expect(opsDe('autorizacion_intentos_documento', 'insert')[0].args[0]).toMatchObject({ coincide: true });
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')[0].args[0]).toMatchObject({ identidad_confirmada: true });
      expect(opsDe('autorizaciones_habeas_data', 'update')).toHaveLength(0);
    });

    it('ráfaga en paralelo: un acierto con los fallidos ya agotados no vale ni confirma la identidad', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      enqueue('autorizacion_intentos_documento', { error: null }, { count: 3 });
      expect(await confirmarIdentidadProspecto(TOKEN, { numero_documento: '1023456789' })).toEqual({ coincide: false, intentos_restantes: 0 });
      expect(opsDe('autorizacion_perfil_prospecto', 'upsert')).toHaveLength(0);
    });

    it('detener es idempotente: si otra petición ya expiró el enlace, no se repite el aviso', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente }, { data: [] });
      enqueue('autorizacion_intentos_documento', { error: null }, { count: 3 });
      await confirmarIdentidadProspecto(TOKEN, { numero_documento: '1023456788' });
      await new Promise((r) => setTimeout(r, 0));
      expect(opsDe('autorizacion_envios', 'update')).toHaveLength(0);
      expect(opsDe('eventos_timeline', 'insert')).toHaveLength(0);
      expect(mockNotificarResponsable).not.toHaveBeenCalled();
    });

    it('falla cerrado: si no se puede registrar el intento, se detiene al primer fallo', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      enqueue('autorizacion_intentos_documento', { error: { message: 'relation does not exist', code: '42P01' } });
      const r = await confirmarIdentidadProspecto(TOKEN, { numero_documento: '1023456788' });
      expect(r).toEqual({ coincide: false, intentos_restantes: 0 });
      expect(opsDe('autorizaciones_habeas_data', 'update')[0].args[0]).toEqual({ estado: 'expirado' });
    });

    it('lo digitado no va al logger, a la bitácora ni al timeline', async () => {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      enqueue('autorizacion_intentos_documento', { error: { message: 'x' } });
      await confirmarIdentidadProspecto(TOKEN, { numero_documento: '5550001112' });
      await vi.waitFor(() => expect(opsDe('eventos_timeline', 'insert')).toHaveLength(1));
      const visto = JSON.stringify([
        vi.mocked(logAudit).mock.calls,
        vi.mocked(logger.warn).mock.calls,
        opsDe('eventos_timeline', 'insert'),
        mockNotificarResponsable.mock.calls,
      ]);
      expect(visto).not.toContain('5550001112');
    });
  });

  describe('BLQ §2: alerta prioritaria y WhatsApp', () => {
    const pendiente = {
      id: AUTORIZACION_ID,
      estado: 'pendiente',
      token_expiracion: FUTURE_DATE,
      expediente_id: EXPEDIENTE_ID,
      solicitante_id: 'sol-uuid',
      version_terminos: '3.0',
      solicitantes: { numero_documento: '1023456789', tipo_documento: 'cc' },
      expedientes: { estado: 'en_revision' },
    };
    const expAviso = (responsable: string | null) => ({
      data: {
        numero: '2026-0042',
        miembro_responsable_id: responsable,
        solicitantes: { nombre: 'Juan', apellido: 'Pérez' },
        inmuebles: { propietario_id: 'prop-1', inmobiliaria_id: 'inmo-1', direccion: 'Calle 1' },
      },
    });
    const avisoResponsable = () =>
      (mockNotificarResponsable.mock.calls as unknown as Array<[Record<string, unknown>]>).map((c) => c[0]).find((a) => a.tipo === 'autorizacion.bloqueo_documento');

    async function agotar(conCupo: boolean) {
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      enqueue('autorizacion_intentos_documento', { error: null }, { count: 3 });
      if (conCupo) enqueue('movimientos_creditos_estudios', { data: [{ id: 'mov-1' }] });
      await confirmarIdentidadProspecto(TOKEN, { numero_documento: '1023456788' });
      await vi.waitFor(() => expect(avisoResponsable()).toBeDefined());
      return avisoResponsable()!;
    }

    it('texto del §2.2 con el nombre y la mención del cupo; sin WhatsApp con el interruptor apagado', async () => {
      enqueue('expedientes', expAviso('miembro-1'));
      const aviso = await agotar(true);
      expect(aviso).toMatchObject({ titulo: 'Verificación de identidad detenida', miembroId: 'miembro-1', payload: { prioridad: 'alta' } });
      expect(aviso.mensaje).toBe(
        'El estudio de Juan Pérez no pudo continuar: el número de documento no coincide con el registrado. ' +
          'Verifique el documento del prospecto, corrija el dato y reenvíe el enlace. No se consumió ningún cupo de su paquete.',
      );
      expect(aviso.whatsapp).toBeUndefined();
      expect(mockBlq.enviarTemplate).not.toHaveBeenCalled();
    });

    it('sin cupo dice que no hubo cobro adicional', async () => {
      enqueue('expedientes', expAviso('miembro-1'));
      expect((await agotar(false)).mensaje).toContain('No se generó ningún cobro adicional.');
    });

    it('con ALERTA_BLOQUEO_WHATSAPP=1 el responsable recibe la plantilla con el botón al estudio', async () => {
      mockCal.ALERTA_BLOQUEO_WHATSAPP = 1;
      enqueue('expedientes', expAviso('miembro-1'));
      const aviso = await agotar(false);
      expect(aviso.whatsapp).toEqual({
        template: 'ESTUDIO_BLOQUEADO_DOCUMENTO',
        variables: ['', 'Juan Pérez', '2026-0042'],
        reservaNombre: 'señor(a)',
        urlButtons: [EXPEDIENTE_ID],
      });
      expect(mockBlq.enviarTemplate).not.toHaveBeenCalled();
    });

    it('sin responsable, el WhatsApp va a los titulares de la organización', async () => {
      mockCal.ALERTA_BLOQUEO_WHATSAPP = 1;
      enqueue('expedientes', expAviso(null));
      enqueue('inmobiliaria_miembros', { data: [{ perfil_id: 'owner-1' }] });
      enqueue('perfiles', { data: [{ nombre: 'Ana', apellido: 'Gómez', telefono: '+573001234567' }] });
      await agotar(false);
      await vi.waitFor(() => expect(mockBlq.enviarTemplate).toHaveBeenCalled());
      expect(mockBlq.enviarTemplate.mock.calls[0][0]).toMatchObject({
        to: '+573001234567',
        template: 'ESTUDIO_BLOQUEADO_DOCUMENTO',
        variables: ['Ana Gómez', 'Juan Pérez', '2026-0042'],
        urlButtons: [EXPEDIENTE_ID],
      });
    });

    it('«no soy yo» no manda WhatsApp aunque el interruptor esté encendido', async () => {
      mockCal.ALERTA_BLOQUEO_WHATSAPP = 1;
      enqueue('autorizaciones_habeas_data', { data: pendiente });
      enqueue('expedientes', expAviso('miembro-1'));
      await reportarIdentidadProspecto(TOKEN, { motivo: 'no_soy_yo' });
      const aviso = () =>
        (mockNotificarResponsable.mock.calls as unknown as Array<[Record<string, unknown>]>).map((c) => c[0]).find((a) => a.tipo === 'autorizacion.identidad_reportada');
      await vi.waitFor(() => expect(aviso()).toBeDefined());
      expect(aviso()!.whatsapp).toBeUndefined();
      expect(opsDe('autorizacion_envios', 'update')[0].args[0]).toMatchObject({ motivo_cierre: 'no_soy_yo' });
    });
  });

  describe('BLQ §3: corrección ciega del documento', () => {
    const USER = { id: USER_ID, rol: 'inmobiliaria', email: 'asesor@inmo.co' } as never;
    const BODY = { tipo_documento: 'cc', numero_documento: '1023456780', fuente_verificacion: 'documento_fisico' as const };
    // Copia por test: el servicio escribe el documento corregido sobre la fila leída.
    const expRow = () => ({
      data: {
        id: EXPEDIENTE_ID,
        numero: '2026-0042',
        estado: 'en_revision',
        solicitante_id: 'sol-uuid',
        solicitantes: { ...expedienteConSolicitante.solicitantes, numero_documento: '1023456789', inmobiliaria_id: 'inmo-1', creado_por: 'asesor' },
      },
    });

    it('con la consulta hecha o en proceso: 409, sin tocar la ficha', async () => {
      enqueue('expedientes', expRow());
      enqueue('estudios', { data: [{ estado: 'completado', referencia_proveedor: 'DC-1' }] });
      await expect(corregirDocumentoProspecto(EXPEDIENTE_ID, BODY, USER)).rejects.toMatchObject({ statusCode: 409, errorCode: 'ESTUDIO_CON_CONSULTA' });
      expect(opsDe('solicitantes', 'update')).toEqual([]);
    });

    it('con la ficha usada en otro estudio vivo: 409', async () => {
      enqueue('expedientes', expRow(), { data: [{ id: 'otro-exp' }] });
      enqueue('estudios', { data: [] }, { data: [] });
      enqueue('autorizaciones_habeas_data', { count: 1 });
      enqueue('contratos', { count: 0 });
      await expect(corregirDocumentoProspecto(EXPEDIENTE_ID, BODY, USER)).rejects.toMatchObject({ statusCode: 409, errorCode: 'FICHA_COMPARTIDA' });
      expect(opsDe('solicitantes', 'update')).toEqual([]);
    });

    it('el mismo documento: 400 (si el registro está bien, solo se reenvía)', async () => {
      enqueue('expedientes', expRow());
      await expect(
        corregirDocumentoProspecto(EXPEDIENTE_ID, { ...BODY, numero_documento: '1.023.456.789' }, USER),
      ).rejects.toMatchObject({ statusCode: 400, errorCode: 'DOCUMENTO_SIN_CAMBIOS' });
    });

    it('con el enlace vivo: corrige la ficha y la evaluación, expira el enlace y no lo reenvía', async () => {
      enqueue('expedientes', expRow(), { data: [] });
      enqueue('estudios', { data: [] }, { data: [{ id: 'est-1', datos_formulario: { numero_documento: '1023456789', tipo_documento: 'cc', nombre_completo: 'Juan Perez' } }] });
      enqueue('correcciones_documento', { count: 0 }, { error: null });
      // Último enlace (sin «no soy yo») y luego el enlace vivo que se expira.
      enqueue('autorizaciones_habeas_data', { data: null }, { data: [{ id: 'aut-viva' }] });

      const r = await corregirDocumentoProspecto(EXPEDIENTE_ID, BODY, USER, '1.1.1.1');

      expect(r).toEqual({ correcciones_restantes: 1, estado_bloqueo: 'pendiente_reenvio' });
      expect(mockAssertAccess).toHaveBeenCalledWith(EXPEDIENTE_ID, USER_ID, 'inmobiliaria');
      expect(opsDe('solicitantes', 'update')[0].args[0]).toEqual({ numero_documento: '1023456780' });
      expect(opsDe('correcciones_documento', 'insert')[0].args[0]).toMatchObject({
        numero_anterior: '1023456789',
        numero_nuevo: '1023456780',
        fuente_verificacion: 'documento_fisico',
        usuario_id: USER_ID,
      });
      expect(opsDe('estudios', 'update')[0].args[0]).toEqual({
        datos_formulario: { numero_documento: '1023456780', tipo_documento: 'cc', nombre_completo: 'Juan Perez' },
      });
      expect(opsDe('autorizaciones_habeas_data', 'update')[0].args[0]).toEqual({ estado: 'expirado' });
      expect(opsDe('autorizacion_envios', 'update')[0].args[0]).toMatchObject({ motivo_cierre: 'correccion' });
      expect(opsDe('autorizaciones_habeas_data', 'insert')).toEqual([]);
      expect(mockSendAutorizacionEmail).not.toHaveBeenCalled();
      expect(vi.mocked(logAudit).mock.calls.at(-1)![0].detalle).toMatchObject({
        before: { numero_documento: '1023456789' },
        after: { numero_documento: '1023456780' },
        fuente_verificacion: 'documento_fisico',
      });
    });

    it('si no se puede registrar la corrección, la ficha vuelve a lo anterior (503)', async () => {
      enqueue('expedientes', expRow(), { data: [] });
      enqueue('estudios', { data: [] });
      enqueue('correcciones_documento', { count: 0 }, { error: { message: 'boom' } });
      await expect(corregirDocumentoProspecto(EXPEDIENTE_ID, BODY, USER)).rejects.toMatchObject({ statusCode: 503 });
      expect(opsDe('solicitantes', 'update').map((o) => o.args[0])).toEqual([
        { numero_documento: '1023456780' },
        { tipo_documento: 'cc', numero_documento: '1023456789' },
      ]);
    });

    it('la que pasa el límite cierra el estudio sin acuse, avisa a la Gerencia General y responde 409', async () => {
      const { notificarYCorreo } = await import('@/modules/notificaciones/notificaciones.service');
      enqueue('expedientes', expRow(), { data: [] });
      enqueue('estudios', { data: [] });
      enqueue('correcciones_documento', { count: 2 });
      await expect(corregirDocumentoProspecto(EXPEDIENTE_ID, BODY, USER)).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'LIMITE_CORRECCIONES_DOCUMENTO',
      });
      expect(mockBlq.executeTransition).toHaveBeenCalledWith(
        EXPEDIENTE_ID,
        expect.objectContaining({ nuevo_estado: 'cerrado', etiqueta: 'Cancelar estudio' }),
        USER,
        { sinAcuse: true },
      );
      expect(notificarYCorreo).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'gg-1',
          mensaje: 'El estudio N.° 2026-0042 se cerró por superar el límite de correcciones del documento. Debe crearse un estudio nuevo.',
        }),
      );
      expect(opsDe('solicitantes', 'update')).toEqual([]);
    });

    it('después de «no soy yo» la inmobiliaria no corrige (409): solo Cofianza', async () => {
      enqueue('expedientes', expRow(), { data: [] });
      enqueue('estudios', { data: [] });
      enqueue('autorizaciones_habeas_data', { data: { id: 'aut-1', estado: 'expirado', created_at: '2026-10-01T00:00:00Z' } });
      enqueue('autorizacion_envios', { data: { motivo_cierre: 'no_soy_yo' } });
      const err = await corregirDocumentoProspecto(EXPEDIENTE_ID, BODY, USER).catch((e) => e);
      expect(err).toMatchObject({ statusCode: 409, errorCode: 'IDENTIDAD_RECHAZADA' });
      expect(opsDe('solicitantes', 'update')).toEqual([]);
      expect(opsDe('correcciones_documento', 'insert')).toEqual([]);
    });

    it('fuera de su cartera: el guard de tenantScope corta antes de leer', async () => {
      mockAssertAccess.mockRejectedValueOnce(Object.assign(new Error('Estudio no encontrado'), { statusCode: 404 }));
      await expect(corregirDocumentoProspecto(EXPEDIENTE_ID, BODY, USER)).rejects.toMatchObject({ statusCode: 404 });
      expect(mockFrom).not.toHaveBeenCalledWith('expedientes');
    });
  });

  describe('BLQ §7: traza interna', () => {
    it('a la inmobiliaria nunca: 403 sin leer nada', async () => {
      await expect(getTrazaAutorizacion(EXPEDIENTE_ID, 'inmobiliaria')).rejects.toMatchObject({ statusCode: 403 });
      expect(mockFrom).not.toHaveBeenCalledWith('autorizacion_intentos_documento');
    });

    it('a Cofianza: lo digitado, el cierre de cada enlace (vencido derivado) y el cupo', async () => {
      enqueue('autorizacion_intentos_documento', { data: [{ autorizacion_id: 'a1', valor_digitado: '1023456788', coincide: false }] });
      enqueue('autorizacion_envios', { data: [{ autorizacion_id: 'a1', motivo_cierre: 'intentos', cerrado_at: '2026-10-02T00:00:00Z', envios: [] }] });
      enqueue('autorizaciones_habeas_data', {
        data: [
          { id: 'a1', estado: 'expirado', token_expiracion: FUTURE_DATE, created_at: '2026-10-01T00:00:00Z' },
          { id: 'a2', estado: 'pendiente', token_expiracion: PAST_DATE, created_at: '2026-10-03T00:00:00Z' },
        ],
      });
      enqueue('movimientos_creditos_estudios', { data: [{ tipo: 'reserva' }, { tipo: 'liberacion', literal: '2.5' }] });
      const t = await getTrazaAutorizacion(EXPEDIENTE_ID, 'administrador');
      expect(t.intentos[0]).toMatchObject({ valor_digitado: '1023456788' });
      expect(t.enlaces.map((e) => e.motivo_cierre)).toEqual(['intentos', 'vencido']);
      expect(t.cupo).toHaveLength(2);
    });
  });

  describe('BLQ §2.1: banner de bloqueos pendientes', () => {
    it('sin cartera visible: lista vacía sin consultar', async () => {
      mockBlq.allowed.mockResolvedValueOnce([]);
      expect(await listBloqueosPendientes(USER_ID, 'inmobiliaria')).toEqual([]);
      expect(mockFrom).not.toHaveBeenCalledWith('autorizacion_envios');
    });

    it('solo los de su cartera, sin corrección ni reenvío posterior', async () => {
      mockBlq.allowed.mockResolvedValueOnce(['e1', 'e2', 'e3']);
      enqueue('autorizacion_envios', {
        data: [
          { autorizacion_id: 'a1', expediente_id: 'e1', cerrado_at: '2026-10-05T00:00:00Z', motivo_cierre: 'datos_incorrectos' },
          { autorizacion_id: 'a2', expediente_id: 'e2', cerrado_at: '2026-10-04T00:00:00Z' },
          { autorizacion_id: 'a3', expediente_id: 'e3', cerrado_at: '2026-10-03T00:00:00Z' },
        ],
      });
      enqueue('autorizaciones_habeas_data', {
        data: [
          { id: 'a1', expediente_id: 'e1', created_at: '2026-10-01T00:00:00Z' },
          { id: 'a2-nuevo', expediente_id: 'e2', created_at: '2026-10-06T00:00:00Z' }, // ya se reenvió
          { id: 'a3', expediente_id: 'e3', created_at: '2026-10-01T00:00:00Z' },
        ],
      });
      enqueue('correcciones_documento', { data: [{ expediente_id: 'e3', created_at: '2026-10-04T00:00:00Z' }] }); // ya se corrigió
      enqueue('expedientes', {
        data: [
          { id: 'e1', numero: '2026-0001', estado: 'en_revision', solicitantes: { nombre: 'Ana', apellido: 'Ruiz' } },
          { id: 'e2', numero: '2026-0002', estado: 'en_revision' },
          { id: 'e3', numero: '2026-0003', estado: 'en_revision' },
        ],
      });
      const r = await listBloqueosPendientes(USER_ID, 'inmobiliaria');
      expect(r).toEqual([{ expediente_id: 'e1', numero: 'N.° 2026-0001', prospecto: 'Ana Ruiz', bloqueado_en: '2026-10-05T00:00:00Z', motivo: 'datos_incorrectos' }]);
      expect(opsDe('autorizacion_envios', 'in').some((o) => o.args[0] === 'expediente_id')).toBe(true);
    });
  });

  describe('BLQ §8: estado derivado', () => {
    const base = { autorizacionEstado: 'expirado', autorizacionCreadaEn: '2026-10-01T00:00:00Z', ultimaCorreccionEn: null };
    it('intentos o datos incorrectos = bloqueado; no soy yo = identidad rechazada', () => {
      expect(derivarEstadoBloqueo({ ...base, motivo: 'intentos' })).toBe('bloqueado_documento');
      expect(derivarEstadoBloqueo({ ...base, motivo: 'datos_incorrectos' })).toBe('bloqueado_documento');
      expect(derivarEstadoBloqueo({ ...base, motivo: 'no_soy_yo' })).toBe('identidad_rechazada');
      expect(derivarEstadoBloqueo({ ...base, motivo: 'reemplazado' })).toBeNull();
    });
    it('una corrección posterior deja «pendiente de reenvío»; firmado, nada', () => {
      expect(derivarEstadoBloqueo({ ...base, motivo: 'intentos', ultimaCorreccionEn: '2026-10-02T00:00:00Z' })).toBe('pendiente_reenvio');
      expect(derivarEstadoBloqueo({ ...base, motivo: 'intentos', ultimaCorreccionEn: '2026-09-30T00:00:00Z' })).toBe('bloqueado_documento');
      expect(derivarEstadoBloqueo({ ...base, autorizacionEstado: 'autorizado', motivo: null })).toBeNull();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock chain builders
// ============================================================

const mockMaybeSingle = vi.fn();
const mockSingle = vi.fn();
const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle, single: mockSingle }));
const mockOrder = vi.fn(() => ({ limit: mockLimit, maybeSingle: mockMaybeSingle }));
const mockIs = vi.fn(() => ({ limit: mockLimit, maybeSingle: mockMaybeSingle }));
const mockEq: ReturnType<typeof vi.fn> = vi.fn((): Record<string, unknown> => ({
  eq: mockEq,
  single: mockSingle,
  maybeSingle: mockMaybeSingle,
  order: mockOrder,
  limit: mockLimit,
  is: mockIs,
}));
const mockSelect = vi.fn((_cols?: string, _opts?: Record<string, unknown>) => ({
  eq: mockEq,
  single: mockSingle,
}));
const mockInsert = vi.fn(() => ({
  select: vi.fn(() => ({ single: mockSingle })),
}));
const mockUpdate = vi.fn(() => ({
  eq: mockEq,
}));
const mockFrom = vi.fn((_table?: string) => ({
  select: mockSelect,
  insert: mockInsert,
  update: mockUpdate,
}));

// ============================================================
// Module mocks
// ============================================================

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: {
    AUTORIZACION_ENLACE_SENT: 'autorizacion_enlace_sent',
    AUTORIZACION_FIRMADA: 'autorizacion_firmada',
    AUTORIZACION_REVOCADA: 'autorizacion_revocada',
  },
  AUDIT_ENTITIES: {
    AUTORIZACION: 'autorizacion',
  },
}));

const mockSendAutorizacionEmail = vi.fn().mockResolvedValue(undefined);
const mockSendOtpEmail = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/email', () => ({
  sendAutorizacionEmail: (...args: unknown[]) => mockSendAutorizacionEmail(...args),
  sendOtpEmail: (...args: unknown[]) => mockSendOtpEmail(...args),
}));

vi.mock('@/config', () => ({
  env: {
    FRONTEND_URL: 'http://localhost:3000',
  },
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
} from '../autorizaciones.service';

// ============================================================
// Fixtures
// ============================================================

const EXPEDIENTE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '660e8400-e29b-41d4-a716-446655440000';
const AUTORIZACION_ID = '770e8400-e29b-41d4-a716-446655440000';
const TOKEN = 'a'.repeat(64);
const FUTURE_DATE = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
const PAST_DATE = new Date(Date.now() - 1000).toISOString();

const mockExpedienteWithSolicitante = {
  id: EXPEDIENTE_ID,
  numero_expediente: 'EXP-2026-0001',
  estado: 'en_revision',
  solicitante_id: 'sol-uuid',
  solicitantes: {
    id: 'sol-uuid',
    nombre: 'Juan',
    apellido: 'Perez',
    email: 'juan@test.com',
    tipo_documento: 'CC',
    numero_documento: '123456789',
  },
  inmuebles: {
    id: 'inm-uuid',
    direccion: 'Calle 1 #2-3',
    ciudad: 'Bogota',
    barrio: 'Centro',
  },
};

const mockAutorizacionPendiente = {
  id: AUTORIZACION_ID,
  estado: 'pendiente',
  token_expiracion: FUTURE_DATE,
  texto_autorizado: 'Texto legal de autorizacion',
  version_terminos: '1.0',
  metodo_firma: null,
  solicitante_id: 'sol-uuid',
  solicitantes: {
    nombre: 'Juan',
    apellido: 'Perez',
    email: 'juan@test.com',
  },
  expedientes: {
    numero_expediente: 'EXP-2026-0001',
    inmuebles: {
      direccion: 'Calle 1 #2-3',
      ciudad: 'Bogota',
      barrio: 'Centro',
    },
  },
};

// ============================================================
// Helper: setup from() calls sequentially
// ============================================================

function setupFromCall(returnValue: Record<string, unknown>) {
  mockFrom.mockReturnValueOnce(returnValue);
}

function setupSelectSingle(data: unknown, error: unknown = null) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data, error }),
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data, error }),
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data, error }),
          }),
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data, error }),
            }),
            maybeSingle: vi.fn().mockResolvedValue({ data, error }),
          }),
          is: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data, error }),
            }),
          }),
          limit: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data, error }),
          }),
        }),
      }),
    }),
  };
}

function setupSelectMaybeSingle(data: unknown, error: unknown = null) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data, error }),
          }),
        }),
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data, error }),
            }),
          }),
          is: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data, error }),
            }),
          }),
        }),
        maybeSingle: vi.fn().mockResolvedValue({ data, error }),
      }),
    }),
  };
}

function setupUpdate(error: unknown = null) {
  return {
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error }),
      }),
    }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error }),
      }),
    }),
  };
}

function setupInsertWithSelect(data: unknown, error: unknown = null) {
  return {
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data, error }),
      }),
    }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data, error }),
      }),
    }),
  };
}

function setupInsertNoSelect(error: unknown = null) {
  return {
    insert: vi.fn().mockResolvedValue({ error }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: null, error }),
      }),
    }),
  };
}

// ============================================================
// Tests
// ============================================================

describe('autorizaciones.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // getAutorizacionForExpediente
  // ============================================================

  describe('getAutorizacionForExpediente', () => {
    it('debe retornar null si no hay autorizacion', async () => {
      // 1st call: expedientes check
      setupFromCall(setupSelectSingle({ id: EXPEDIENTE_ID }));
      // 2nd call: autorizaciones query
      setupFromCall(setupSelectMaybeSingle(null));

      const result = await getAutorizacionForExpediente(EXPEDIENTE_ID);
      expect(result).toBeNull();
      expect(mockFrom).toHaveBeenCalledWith('expedientes');
      expect(mockFrom).toHaveBeenCalledWith('autorizaciones_habeas_data');
    });

    it('debe lanzar error si expediente no existe', async () => {
      setupFromCall(setupSelectSingle(null, { message: 'not found' }));

      await expect(
        getAutorizacionForExpediente(EXPEDIENTE_ID),
      ).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'EXPEDIENTE_NOT_FOUND',
      });
    });
  });

  // ============================================================
  // enviarEnlaceAutorizacion
  // ============================================================

  describe('enviarEnlaceAutorizacion', () => {
    it('debe crear autorizacion y enviar email', async () => {
      // 1st from: expedientes with joins
      setupFromCall(setupSelectSingle(mockExpedienteWithSolicitante));
      // 2nd from: update existing pending → expirado
      setupFromCall(setupUpdate());
      // 3rd from: insert new autorizacion
      setupFromCall(setupInsertWithSelect({ id: AUTORIZACION_ID }));

      const result = await enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID, '127.0.0.1');

      expect(result).toMatchObject({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
      });
      expect(result.token_expiracion).toBeDefined();
      expect(mockSendAutorizacionEmail).toHaveBeenCalledWith(
        'juan@test.com',
        'Juan Perez',
        expect.stringContaining('http://localhost:3000/autorizar/'),
        48,
      );
    });

    it('debe lanzar error si expediente no existe', async () => {
      setupFromCall(setupSelectSingle(null, { message: 'not found' }));

      await expect(
        enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID),
      ).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'EXPEDIENTE_NOT_FOUND',
      });
    });

    it('debe lanzar error si solicitante no tiene email', async () => {
      const expSinEmail = {
        ...mockExpedienteWithSolicitante,
        solicitantes: { ...mockExpedienteWithSolicitante.solicitantes, email: '' },
      };
      setupFromCall(setupSelectSingle(expSinEmail));

      await expect(
        enviarEnlaceAutorizacion(EXPEDIENTE_ID, USER_ID),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'SOLICITANTE_SIN_EMAIL',
      });
    });
  });

  // ============================================================
  // getAutorizacionByToken
  // ============================================================

  describe('getAutorizacionByToken', () => {
    it('debe retornar datos publicos para token valido', async () => {
      setupFromCall(setupSelectSingle(mockAutorizacionPendiente));

      const result = await getAutorizacionByToken(TOKEN);

      expect(result).toMatchObject({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        texto_legal: 'Texto legal de autorizacion',
        solicitante: { nombre: 'Juan', apellido: 'Perez' },
        expediente: {
          numero_expediente: 'EXP-2026-0001',
          inmueble: { ciudad: 'Bogota' },
        },
      });
    });

    it('debe lanzar error si token no existe', async () => {
      setupFromCall(setupSelectSingle(null, { code: 'PGRST116' }));

      await expect(
        getAutorizacionByToken(TOKEN),
      ).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'AUTORIZACION_NOT_FOUND',
      });
    });

    it('debe lanzar error si token expirado', async () => {
      const expirada = { ...mockAutorizacionPendiente, token_expiracion: PAST_DATE };
      setupFromCall(setupSelectSingle(expirada));
      // The service also updates estado to 'expirado' — need update mock
      setupFromCall(setupUpdate());

      await expect(
        getAutorizacionByToken(TOKEN),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_EXPIRADA',
      });
    });

    it('debe lanzar error si autorizacion ya fue firmada', async () => {
      const firmada = { ...mockAutorizacionPendiente, estado: 'autorizado', token_expiracion: FUTURE_DATE };
      setupFromCall(setupSelectSingle(firmada));

      await expect(
        getAutorizacionByToken(TOKEN),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_ESTADO_INVALIDO',
      });
    });
  });

  // ============================================================
  // firmarAutorizacion
  // ============================================================

  describe('firmarAutorizacion', () => {
    it('debe firmar con metodo canvas exitosamente', async () => {
      // 1st from: get autorizacion by token
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        token_expiracion: FUTURE_DATE,
        texto_autorizado: 'Texto legal',
        solicitante_id: 'sol-uuid',
      }));
      // 2nd from: update to autorizado
      setupFromCall(setupUpdate());

      const result = await firmarAutorizacion(
        TOKEN,
        { metodo_firma: 'canvas', datos_firma: 'data:image/png;base64,AAA' },
        '192.168.1.1',
        'Mozilla/5.0',
      );

      expect(result).toMatchObject({
        estado: 'autorizado',
      });
      expect(result.hash_documento).toHaveLength(64); // SHA-256 hex
      expect(result.autorizado_en).toBeDefined();
    });

    it('debe firmar con metodo OTP cuando hay OTP verificado', async () => {
      // 1st from: get autorizacion
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        token_expiracion: FUTURE_DATE,
        texto_autorizado: 'Texto legal',
        solicitante_id: 'sol-uuid',
      }));
      // 2nd from: check verified OTP
      setupFromCall(setupSelectMaybeSingle({ id: 'otp-uuid', codigo: '123456', verificado: true }));
      // 3rd from: update to autorizado
      setupFromCall(setupUpdate());

      const result = await firmarAutorizacion(
        TOKEN,
        { metodo_firma: 'otp', codigo_otp: '123456' },
        '192.168.1.1',
      );

      expect(result.estado).toBe('autorizado');
      expect(result.hash_documento).toHaveLength(64);
    });

    it('debe lanzar error si OTP no verificado', async () => {
      // 1st from: get autorizacion
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        token_expiracion: FUTURE_DATE,
        texto_autorizado: 'Texto legal',
        solicitante_id: 'sol-uuid',
      }));
      // 2nd from: no verified OTP found
      setupFromCall(setupSelectMaybeSingle(null));

      await expect(
        firmarAutorizacion(TOKEN, { metodo_firma: 'otp', codigo_otp: '123456' }),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'OTP_NO_VERIFICADO',
      });
    });

    it('debe lanzar error si autorizacion ya procesada', async () => {
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'autorizado',
        token_expiracion: FUTURE_DATE,
      }));

      await expect(
        firmarAutorizacion(TOKEN, { metodo_firma: 'canvas', datos_firma: 'data:image/png;base64,AAA' }),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_ESTADO_INVALIDO',
      });
    });

    it('debe lanzar error si token expirado', async () => {
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        token_expiracion: PAST_DATE,
      }));

      await expect(
        firmarAutorizacion(TOKEN, { metodo_firma: 'canvas', datos_firma: 'data:image/png;base64,AAA' }),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_EXPIRADA',
      });
    });

    it('debe lanzar error si autorizacion no encontrada', async () => {
      setupFromCall(setupSelectSingle(null, { message: 'not found' }));

      await expect(
        firmarAutorizacion(TOKEN, { metodo_firma: 'canvas', datos_firma: 'data:image/png;base64,AAA' }),
      ).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'AUTORIZACION_NOT_FOUND',
      });
    });
  });

  // ============================================================
  // enviarOtpCode
  // ============================================================

  describe('enviarOtpCode', () => {
    it('debe generar y enviar OTP exitosamente', async () => {
      // 1st from: get autorizacion with solicitante
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        token_expiracion: FUTURE_DATE,
        solicitantes: { nombre: 'Juan', apellido: 'Perez', email: 'juan@test.com' },
      }));
      // 2nd from: check cooldown — no previous OTP
      setupFromCall(setupSelectMaybeSingle(null));
      // 3rd from: insert OTP
      setupFromCall(setupInsertNoSelect());

      const result = await enviarOtpCode(TOKEN);

      expect(result.mensaje).toContain('Codigo OTP enviado');
      expect(result.expira_en).toBeDefined();
      expect(mockSendOtpEmail).toHaveBeenCalledWith(
        'juan@test.com',
        'Juan Perez',
        expect.stringMatching(/^\d{6}$/),
      );
    });

    it('debe lanzar error si autorizacion no encontrada', async () => {
      setupFromCall(setupSelectSingle(null, { message: 'not found' }));

      await expect(enviarOtpCode(TOKEN)).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'AUTORIZACION_NOT_FOUND',
      });
    });

    it('debe lanzar error si autorizacion ya procesada', async () => {
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'autorizado',
        token_expiracion: FUTURE_DATE,
        solicitantes: { nombre: 'Juan', apellido: 'Perez', email: 'juan@test.com' },
      }));

      await expect(enviarOtpCode(TOKEN)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'AUTORIZACION_ESTADO_INVALIDO',
      });
    });

    it('debe lanzar error si cooldown activo', async () => {
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        token_expiracion: FUTURE_DATE,
        solicitantes: { nombre: 'Juan', apellido: 'Perez', email: 'juan@test.com' },
      }));
      // Recent OTP created 10 seconds ago
      setupFromCall(setupSelectMaybeSingle({
        created_at: new Date(Date.now() - 10 * 1000).toISOString(),
      }));

      await expect(enviarOtpCode(TOKEN)).rejects.toMatchObject({
        statusCode: 429,
        errorCode: 'OTP_COOLDOWN',
      });
    });
  });

  // ============================================================
  // verificarOtpCode
  // ============================================================

  describe('verificarOtpCode', () => {
    it('debe verificar OTP correcto', async () => {
      // 1st from: get autorizacion
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        token_expiracion: FUTURE_DATE,
      }));
      // 2nd from: find OTP
      setupFromCall(setupSelectMaybeSingle({
        id: 'otp-uuid',
        codigo: '123456',
        expira_en: FUTURE_DATE,
        verificado: false,
      }));
      // 3rd from: update OTP as verified
      setupFromCall(setupUpdate());

      const result = await verificarOtpCode(TOKEN, '123456');

      expect(result).toMatchObject({
        verificado: true,
        mensaje: 'Codigo OTP verificado correctamente',
      });
    });

    it('debe lanzar error si codigo incorrecto', async () => {
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        token_expiracion: FUTURE_DATE,
      }));
      setupFromCall(setupSelectMaybeSingle({
        id: 'otp-uuid',
        codigo: '123456',
        expira_en: FUTURE_DATE,
        verificado: false,
      }));

      await expect(
        verificarOtpCode(TOKEN, '999999'),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'OTP_INCORRECTO',
      });
    });

    it('debe lanzar error si OTP expirado', async () => {
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        token_expiracion: FUTURE_DATE,
      }));
      setupFromCall(setupSelectMaybeSingle({
        id: 'otp-uuid',
        codigo: '123456',
        expira_en: PAST_DATE,
        verificado: false,
      }));

      await expect(
        verificarOtpCode(TOKEN, '123456'),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'OTP_EXPIRADO',
      });
    });

    it('debe lanzar error si no hay OTP pendiente', async () => {
      setupFromCall(setupSelectSingle({
        id: AUTORIZACION_ID,
        estado: 'pendiente',
        token_expiracion: FUTURE_DATE,
      }));
      setupFromCall(setupSelectMaybeSingle(null));

      await expect(
        verificarOtpCode(TOKEN, '123456'),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'OTP_NOT_FOUND',
      });
    });

    it('debe lanzar error si autorizacion no encontrada', async () => {
      setupFromCall(setupSelectSingle(null, { message: 'not found' }));

      await expect(
        verificarOtpCode(TOKEN, '123456'),
      ).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'AUTORIZACION_NOT_FOUND',
      });
    });
  });

  // ============================================================
  // revocarAutorizacion
  // ============================================================

  describe('revocarAutorizacion', () => {
    it('debe revocar autorizacion activa', async () => {
      // 1st from: find active autorizacion
      setupFromCall(setupSelectMaybeSingle({ id: AUTORIZACION_ID, estado: 'autorizado' }));
      // 2nd from: update to revocado
      setupFromCall(setupUpdate());

      const result = await revocarAutorizacion(
        EXPEDIENTE_ID,
        { motivo: 'Revocacion por solicitud del titular' },
        USER_ID,
        '127.0.0.1',
      );

      expect(result).toMatchObject({
        estado: 'revocado',
      });
      expect(result.fecha_revocacion).toBeDefined();
    });

    it('debe lanzar error si no hay autorizacion activa', async () => {
      setupFromCall(setupSelectMaybeSingle(null));

      await expect(
        revocarAutorizacion(
          EXPEDIENTE_ID,
          { motivo: 'Revocacion por solicitud del titular' },
          USER_ID,
        ),
      ).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'AUTORIZACION_NOT_FOUND',
      });
    });
  });
});

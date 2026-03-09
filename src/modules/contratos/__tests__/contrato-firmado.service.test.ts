import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock chain builders
// ============================================================

const mockSingle = vi.fn();
const mockLimit = vi.fn(() => ({ single: mockSingle }));
const mockOrder = vi.fn(() => ({ limit: mockLimit }));
const mockEq: ReturnType<typeof vi.fn> = vi.fn((): Record<string, unknown> => ({
  eq: mockEq,
  single: mockSingle,
  select: mockSelect,
  order: mockOrder,
  limit: mockLimit,
}));
const mockSelect = vi.fn((_cols?: string) => ({
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

const mockUpload = vi.fn();
const mockDownload = vi.fn();
const mockCreateSignedUrl = vi.fn();
const mockStorageFrom = vi.fn(() => ({
  upload: mockUpload,
  download: mockDownload,
  createSignedUrl: mockCreateSignedUrl,
}));

// ============================================================
// Module mocks
// ============================================================

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    storage: { from: (bucket: string) => mockStorageFrom(bucket) },
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
    CONTRATO_FIRMADO_UPLOADED: 'contrato_firmado_uploaded',
    CONTRATO_FIRMADO_DOWNLOADED: 'contrato_firmado_downloaded',
    CONTRATO_FIRMADO_VERIFIED: 'contrato_firmado_verified',
  },
  AUDIT_ENTITIES: {
    CONTRATO: 'contrato',
  },
}));

// Import AFTER mocks
import {
  subirContratoFirmado,
  descargarContratoFirmado,
  getInfoFirma,
  verificarIntegridad,
  getLogAccesos,
} from '../contrato-firmado.service';

// ============================================================
// Fixtures
// ============================================================

const CONTRATO_ID = '550e8400-e29b-41d4-a716-446655440001';
const EXPEDIENTE_ID = '550e8400-e29b-41d4-a716-446655440002';
const USER_ID = '660e8400-e29b-41d4-a716-446655440001';

const mockContratoFirmado = {
  id: CONTRATO_ID,
  expediente_id: EXPEDIENTE_ID,
  estado: 'firmado',
  firmado_storage_key: null,
  firmado_nombre_archivo: null,
  firmado_hash_integridad: null,
  firmado_ip: null,
  firmado_user_agent: null,
  firmado_referencia_otp: null,
  firmado_notas: null,
  firmado_tamano_bytes: null,
  firmado_subido_por: null,
  firmado_subido_en: null,
};

const mockContratoConFirmado = {
  ...mockContratoFirmado,
  firmado_storage_key: `contratos/${EXPEDIENTE_ID}/${CONTRATO_ID}/firmado.pdf`,
  firmado_nombre_archivo: 'contrato-firmado.pdf',
  firmado_hash_integridad: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
  firmado_tamano_bytes: 102400,
  firmado_subido_por: USER_ID,
  firmado_subido_en: '2026-03-01T00:00:00.000Z',
};

const mockFile = {
  buffer: Buffer.from('fake-pdf-content'),
  originalname: 'contrato-firmado.pdf',
  size: 1024,
};

// ============================================================
// Helpers
// ============================================================

function setupSelectSingle(data: unknown, error: unknown = null) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data, error }),
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data, error }),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data, error }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data, error }),
        }),
        single: vi.fn().mockResolvedValue({ data, error }),
      }),
    }),
  };
}

function setupMultipleFromCalls(...calls: Array<{ data: unknown; error: unknown }>) {
  for (const call of calls) {
    mockFrom.mockReturnValueOnce(setupSelectSingle(call.data, call.error));
  }
}

// ============================================================
// Tests
// ============================================================

describe('contrato-firmado.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================
  // subirContratoFirmado
  // ==========================================================

  describe('subirContratoFirmado', () => {
    it('should throw CONTRATO_NOT_FOUND if contrato does not exist', async () => {
      setupMultipleFromCalls({ data: null, error: { message: 'not found' } });

      await expect(
        subirContratoFirmado(CONTRATO_ID, mockFile, {}, USER_ID),
      ).rejects.toThrow('Contrato no encontrado');
    });

    it('should throw INVALID_STATE if estado is borrador', async () => {
      setupMultipleFromCalls({
        data: { ...mockContratoFirmado, estado: 'borrador' },
        error: null,
      });

      await expect(
        subirContratoFirmado(CONTRATO_ID, mockFile, {}, USER_ID),
      ).rejects.toThrow('Solo se puede subir');
    });

    it('should throw FIRMADO_ALREADY_EXISTS if already has firmado', async () => {
      setupMultipleFromCalls({
        data: mockContratoConFirmado,
        error: null,
      });

      await expect(
        subirContratoFirmado(CONTRATO_ID, mockFile, {}, USER_ID),
      ).rejects.toThrow('ya tiene un documento firmado');
    });

    it('should throw STORAGE_ERROR if upload fails', async () => {
      setupMultipleFromCalls({
        data: mockContratoFirmado,
        error: null,
      });
      mockUpload.mockResolvedValueOnce({ error: { message: 'storage error' } });

      await expect(
        subirContratoFirmado(CONTRATO_ID, mockFile, {}, USER_ID),
      ).rejects.toThrow('Error al almacenar');
    });

    it('should upload successfully and return updated contrato', async () => {
      const updatedContrato = { ...mockContratoConFirmado };

      // 1st from(): fetchContratoFirmado → contratos select
      mockFrom.mockReturnValueOnce(setupSelectSingle(mockContratoFirmado, null));
      // Upload succeeds
      mockUpload.mockResolvedValueOnce({ error: null });
      // 2nd from(): update contratos
      mockFrom.mockReturnValueOnce(setupSelectSingle(updatedContrato, null));
      // 3rd from(): registrarAcceso insert
      mockFrom.mockReturnValueOnce({
        insert: vi.fn().mockResolvedValue({ error: null }),
      });

      const result = await subirContratoFirmado(
        CONTRATO_ID,
        mockFile,
        { referencia_otp: 'OTP-123', notas: 'Nota test' },
        USER_ID,
        '192.168.1.1',
        'Mozilla/5.0',
      );

      expect(result).toBeDefined();
      expect(mockStorageFrom).toHaveBeenCalledWith('documentos-expedientes');
      expect(mockUpload).toHaveBeenCalledWith(
        `contratos/${EXPEDIENTE_ID}/${CONTRATO_ID}/firmado.pdf`,
        mockFile.buffer,
        { contentType: 'application/pdf', upsert: false },
      );
    });
  });

  // ==========================================================
  // descargarContratoFirmado
  // ==========================================================

  describe('descargarContratoFirmado', () => {
    it('should throw NO_FIRMADO if no firmado_storage_key', async () => {
      setupMultipleFromCalls({
        data: mockContratoFirmado,
        error: null,
      });

      await expect(
        descargarContratoFirmado(CONTRATO_ID, USER_ID, 'administrador'),
      ).rejects.toThrow('no tiene documento firmado');
    });

    it('should throw DOWNLOAD_FORBIDDEN for gerencia_consulta', async () => {
      setupMultipleFromCalls({
        data: mockContratoConFirmado,
        error: null,
      });

      await expect(
        descargarContratoFirmado(CONTRATO_ID, USER_ID, 'gerencia_consulta'),
      ).rejects.toThrow('No tiene permiso');
    });

    it('should allow admin to download and return signed URL', async () => {
      const signedUrl = 'https://storage.example.com/signed-url';

      // 1st from(): fetchContratoFirmado
      mockFrom.mockReturnValueOnce(setupSelectSingle(mockContratoConFirmado, null));
      // createSignedUrl
      mockCreateSignedUrl.mockResolvedValueOnce({
        data: { signedUrl },
        error: null,
      });
      // 2nd from(): registrarAcceso
      mockFrom.mockReturnValueOnce({
        insert: vi.fn().mockResolvedValue({ error: null }),
      });

      const result = await descargarContratoFirmado(CONTRATO_ID, USER_ID, 'administrador', '10.0.0.1');

      expect(result).toEqual({
        url: signedUrl,
        nombre_archivo: 'contrato-firmado.pdf',
        tipo_mime: 'application/pdf',
        expires_in: 600,
      });
      expect(mockCreateSignedUrl).toHaveBeenCalledWith(
        mockContratoConFirmado.firmado_storage_key,
        600,
        { download: 'contrato-firmado.pdf' },
      );
    });

    it('should check expediente ownership for propietario role', async () => {
      const expedienteWithOwner = {
        id: EXPEDIENTE_ID,
        solicitante_id: 'other-user',
        inmuebles: { propietario_id: USER_ID },
      };

      // 1st from(): fetchContratoFirmado
      mockFrom.mockReturnValueOnce(setupSelectSingle(mockContratoConFirmado, null));
      // 2nd from(): expedientes check
      mockFrom.mockReturnValueOnce(setupSelectSingle(expedienteWithOwner, null));
      // createSignedUrl
      mockCreateSignedUrl.mockResolvedValueOnce({
        data: { signedUrl: 'https://url' },
        error: null,
      });
      // 3rd from(): registrarAcceso
      mockFrom.mockReturnValueOnce({
        insert: vi.fn().mockResolvedValue({ error: null }),
      });

      const result = await descargarContratoFirmado(CONTRATO_ID, USER_ID, 'propietario');
      expect(result.url).toBe('https://url');
    });

    it('should reject propietario who is not the owner', async () => {
      const expedienteOtherOwner = {
        id: EXPEDIENTE_ID,
        solicitante_id: 'other-user-1',
        inmuebles: { propietario_id: 'other-user-2' },
      };

      // 1st from(): fetchContratoFirmado
      mockFrom.mockReturnValueOnce(setupSelectSingle(mockContratoConFirmado, null));
      // 2nd from(): expedientes check
      mockFrom.mockReturnValueOnce(setupSelectSingle(expedienteOtherOwner, null));

      await expect(
        descargarContratoFirmado(CONTRATO_ID, USER_ID, 'propietario'),
      ).rejects.toThrow('No tiene permiso');
    });
  });

  // ==========================================================
  // getInfoFirma
  // ==========================================================

  describe('getInfoFirma', () => {
    it('should return info with tiene_firmado=false when no firmado', async () => {
      // 1st from(): contratos
      mockFrom.mockReturnValueOnce(setupSelectSingle(mockContratoFirmado, null));

      const result = await getInfoFirma(CONTRATO_ID);

      expect(result.tiene_firmado).toBe(false);
      expect(result.firmado_nombre_archivo).toBeNull();
    });

    it('should return info with tiene_firmado=true and user details', async () => {
      const perfil = { id: USER_ID, nombre: 'Juan', apellido: 'Perez' };

      // 1st from(): contratos
      mockFrom.mockReturnValueOnce(setupSelectSingle(mockContratoConFirmado, null));
      // 2nd from(): perfiles lookup
      mockFrom.mockReturnValueOnce(setupSelectSingle(perfil, null));

      const result = await getInfoFirma(CONTRATO_ID);

      expect(result.tiene_firmado).toBe(true);
      expect(result.firmado_nombre_archivo).toBe('contrato-firmado.pdf');
      expect(result.firmado_subido_por).toEqual(perfil);
    });

    it('should throw if contrato not found', async () => {
      setupMultipleFromCalls({ data: null, error: { message: 'not found' } });

      await expect(getInfoFirma(CONTRATO_ID)).rejects.toThrow('Contrato no encontrado');
    });
  });

  // ==========================================================
  // verificarIntegridad
  // ==========================================================

  describe('verificarIntegridad', () => {
    it('should throw NO_FIRMADO if no firmado document', async () => {
      setupMultipleFromCalls({ data: mockContratoFirmado, error: null });

      await expect(
        verificarIntegridad(CONTRATO_ID, USER_ID),
      ).rejects.toThrow('no tiene documento firmado');
    });

    it('should return valido=true when hashes match', async () => {
      // Compute the real hash so it matches
      const crypto = await import('node:crypto');
      const fileContent = Buffer.from('test-pdf-content');
      const expectedHash = crypto.createHash('sha256').update(fileContent).digest('hex');

      const contratoWithCorrectHash = {
        ...mockContratoConFirmado,
        firmado_hash_integridad: expectedHash,
      };

      // 1st from(): fetchContratoFirmado
      mockFrom.mockReturnValueOnce(setupSelectSingle(contratoWithCorrectHash, null));
      // download
      const blob = new Blob([fileContent]);
      mockDownload.mockResolvedValueOnce({ data: blob, error: null });
      // 2nd from(): registrarAcceso
      mockFrom.mockReturnValueOnce({
        insert: vi.fn().mockResolvedValue({ error: null }),
      });

      const result = await verificarIntegridad(CONTRATO_ID, USER_ID);

      expect(result.valido).toBe(true);
      expect(result.hash_almacenado).toBe(expectedHash);
      expect(result.hash_recalculado).toBe(expectedHash);
    });

    it('should return valido=false when hashes do not match', async () => {
      const contratoWithWrongHash = {
        ...mockContratoConFirmado,
        firmado_hash_integridad: 'wrong-hash-value-that-does-not-match-anything',
      };

      // 1st from(): fetchContratoFirmado
      mockFrom.mockReturnValueOnce(setupSelectSingle(contratoWithWrongHash, null));
      // download
      const blob = new Blob([Buffer.from('tampered-content')]);
      mockDownload.mockResolvedValueOnce({ data: blob, error: null });
      // 2nd from(): registrarAcceso
      mockFrom.mockReturnValueOnce({
        insert: vi.fn().mockResolvedValue({ error: null }),
      });

      const result = await verificarIntegridad(CONTRATO_ID, USER_ID);

      expect(result.valido).toBe(false);
      expect(result.hash_almacenado).toBe('wrong-hash-value-that-does-not-match-anything');
      expect(result.hash_recalculado).not.toBe(result.hash_almacenado);
    });

    it('should throw STORAGE_ERROR if download fails', async () => {
      // 1st from(): fetchContratoFirmado
      mockFrom.mockReturnValueOnce(setupSelectSingle(mockContratoConFirmado, null));
      // download fails
      mockDownload.mockResolvedValueOnce({ data: null, error: { message: 'download error' } });

      await expect(
        verificarIntegridad(CONTRATO_ID, USER_ID),
      ).rejects.toThrow('Error al obtener el archivo');
    });
  });

  // ==========================================================
  // getLogAccesos
  // ==========================================================

  describe('getLogAccesos', () => {
    it('should throw if contrato not found', async () => {
      setupMultipleFromCalls({ data: null, error: { message: 'not found' } });

      await expect(getLogAccesos(CONTRATO_ID)).rejects.toThrow('Contrato no encontrado');
    });

    it('should return mapped accesos', async () => {
      const rawAccesos = [
        {
          id: 'acc-1',
          tipo_accion: 'descarga',
          ip: '10.0.0.1',
          user_agent: 'Chrome',
          created_at: '2026-03-01T12:00:00Z',
          usuario_id: USER_ID,
          perfiles: { id: USER_ID, nombre: 'Juan', apellido: 'Perez' },
        },
        {
          id: 'acc-2',
          tipo_accion: 'verificacion',
          ip: null,
          user_agent: null,
          created_at: '2026-03-02T12:00:00Z',
          usuario_id: null,
          perfiles: null,
        },
      ];

      // 1st from(): contrato exists check
      mockFrom.mockReturnValueOnce(setupSelectSingle({ id: CONTRATO_ID }, null));
      // 2nd from(): contrato_accesos_firmado query
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: rawAccesos, error: null }),
            }),
          }),
        }),
      });

      const result = await getLogAccesos(CONTRATO_ID);

      expect(result.accesos).toHaveLength(2);
      expect(result.accesos[0]).toEqual({
        id: 'acc-1',
        tipo_accion: 'descarga',
        ip: '10.0.0.1',
        user_agent: 'Chrome',
        created_at: '2026-03-01T12:00:00Z',
        usuario: { id: USER_ID, nombre: 'Juan', apellido: 'Perez' },
      });
      expect(result.accesos[1].usuario).toBeNull();
    });
  });
});

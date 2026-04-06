import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TransUnionProvider } from '../transunion.provider';
import type { ProviderSolicitudInput } from '../types';

// ── Mock env ────────────────────────────────────────────────
vi.mock('@/config/env', () => ({
  env: {
    TRANSUNION_API_URL: 'https://tucoapplicationserviceuat.transunion.co/ws/v1/rest/consultarCombo',
    TRANSUNION_USERNAME: 'testuser',
    TRANSUNION_PASSWORD: 'testpass',
    TRANSUNION_POLICY_ID: '3176',
    TRANSUNION_CONSULTA_MOTIVO: '22',
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Helpers ─────────────────────────────────────────────────

const baseInput: ProviderSolicitudInput = {
  estudio_id: '550e8400-e29b-41d4-a716-446655440000',
  tipo: 'individual',
  nombre_completo: 'Juan Perez',
  tipo_documento: 'cc',
  numero_documento: '12345678',
  email: 'juan@test.com',
  telefono: '3001234567',
};

function mockSuccessResponse(score: string = '658') {
  return {
    Tercero: {
      NombreTitular: 'PEREZ JUAN',
      TipoIdentificacion: '1',
      NumeroIdentificacion: '12345678',
      Estado: 'VIGENTE',
      RangoEdad: '30-35',
    },
    CreditVision_5694: {
      transactionId: 'TXN-ABC-123',
      resultadoOperacion: 'Exitoso',
      fechaCorte: [
        {
          variables: [
            { nombre: 'CREDITVISION', valor: score },
            { nombre: 'OTRA_VARIABLE', valor: '100' },
          ],
        },
      ],
    },
    Informacion_Comercial_154: {
      Consolidado: {
        Registro: {
          NumeroObligaciones: '6',
          TotalSaldo: '160002470',
          SaldoObligacionesMora: '5000000',
          ValorMora: '500000',
        },
        ResumenPrincipal: [],
      },
    },
  };
}

function mockExclusionResponse(exclusionCode: string = '-5') {
  return {
    Tercero: {
      NombreTitular: 'PEREZ JUAN',
      TipoIdentificacion: '1',
      NumeroIdentificacion: '12345678',
    },
    CreditVision_5694: {
      transactionId: 'TXN-EXC-456',
      resultadoOperacion: 'Exitoso',
      fechaCorte: [
        {
          variables: [
            { nombre: 'CREDITVISION', valor: exclusionCode },
          ],
        },
      ],
    },
    Informacion_Comercial_154: {
      Consolidado: { Registro: {} },
    },
  };
}

function mockErrorResponse(codigo: number, mensaje: string) {
  return { codigo, mensaje, idtransaccion: 'TXN-ERR-789' };
}

// ── Tests ───────────────────────────────────────────────────

describe('TransUnionProvider', () => {
  let provider: TransUnionProvider;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    provider = new TransUnionProvider();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('solicitar()', () => {
    it('deberia retornar score y resultado aprobado para score >= 600', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockSuccessResponse('658')), { status: 200 }),
      );

      const result = await provider.solicitar(baseInput);

      expect(result.referencia_proveedor).toBe('TXN-ABC-123');
      expect(result.status).toBe('completed');
      expect(result.mensaje).toContain('658');
    });

    it('deberia retornar resultado condicionado para score 400-599', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockSuccessResponse('450')), { status: 200 }),
      );

      const result = await provider.solicitar(baseInput);
      const cached = await provider.obtenerResultado(result.referencia_proveedor);

      expect(cached.score).toBe(450);
      expect(cached.resultado).toBe('condicionado');
    });

    it('deberia retornar resultado rechazado para score < 400', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockSuccessResponse('250')), { status: 200 }),
      );

      const result = await provider.solicitar(baseInput);
      const cached = await provider.obtenerResultado(result.referencia_proveedor);

      expect(cached.score).toBe(250);
      expect(cached.resultado).toBe('rechazado');
    });

    it('deberia manejar exclusion CreditVision como condicionado', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockExclusionResponse('-5')), { status: 200 }),
      );

      const result = await provider.solicitar(baseInput);

      expect(result.status).toBe('completed');
      expect(result.mensaje).toContain('exclusion');

      const cached = await provider.obtenerResultado(result.referencia_proveedor);
      expect(cached.score).toBeNull();
      expect(cached.resultado).toBe('condicionado');
      expect(cached.observaciones).toContain('codigo -5');
      expect(cached.observaciones).toContain('sin informacion crediticia');
    });

    it('deberia lanzar error para tercero no encontrado (codigo 23)', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockErrorResponse(23, 'El Tercero consultado no existe.')), { status: 200 }),
      );

      await expect(provider.solicitar(baseInput)).rejects.toThrow('no existe');
    });

    it('deberia lanzar error de autenticacion para codigo 13', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockErrorResponse(13, 'Usuario o contrasena invalidos')), { status: 200 }),
      );

      await expect(provider.solicitar(baseInput)).rejects.toThrow('invalidos');
    });

    it('deberia lanzar error por timeout de red', async () => {
      fetchSpy.mockImplementationOnce(() => {
        const error = new DOMException('The operation was aborted', 'AbortError');
        return Promise.reject(error);
      });
      // Segundo intento (retry) también falla
      fetchSpy.mockImplementationOnce(() => {
        const error = new DOMException('The operation was aborted', 'AbortError');
        return Promise.reject(error);
      });

      await expect(provider.solicitar(baseInput)).rejects.toThrow('timeout');
    });

    it('deberia lanzar error para tipo documento no soportado', async () => {
      const input = { ...baseInput, tipo_documento: 'rut' };
      await expect(provider.solicitar(input)).rejects.toThrow('no soportado');
    });

    it('deberia lanzar error si faltan datos de documento', async () => {
      const input = { ...baseInput, numero_documento: '' };
      await expect(provider.solicitar(input)).rejects.toThrow('requeridos');
    });
  });

  describe('mapeo tipo_documento', () => {
    const tiposValidos = [
      ['cc', '1'],
      ['nit', '2'],
      ['ce', '3'],
      ['ti', '4'],
      ['pasaporte', '5'],
    ] as const;

    for (const [tipo, esperado] of tiposValidos) {
      it(`deberia mapear "${tipo}" al codigo "${esperado}"`, async () => {
        fetchSpy.mockResolvedValueOnce(
          new Response(JSON.stringify(mockSuccessResponse('700')), { status: 200 }),
        );

        const input = { ...baseInput, tipo_documento: tipo };
        await provider.solicitar(input);

        const call = fetchSpy.mock.calls[0];
        const body = JSON.parse(call[1]?.body as string);
        expect(body.tipoIdentificacion).toBe(esperado);
      });
    }
  });

  describe('consultarEstado()', () => {
    it('deberia retornar completed si la referencia existe en cache', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockSuccessResponse('700')), { status: 200 }),
      );

      const solicitud = await provider.solicitar(baseInput);
      const estado = await provider.consultarEstado(solicitud.referencia_proveedor);

      expect(estado.status).toBe('completed');
      expect(estado.progreso_porcentaje).toBe(100);
    });

    it('deberia retornar failed si la referencia no existe', async () => {
      const estado = await provider.consultarEstado('REF-INEXISTENTE');

      expect(estado.status).toBe('failed');
      expect(estado.mensaje).toContain('no encontrada');
    });
  });

  describe('obtenerResultado()', () => {
    it('deberia retornar resultado cacheado con datos_crudos completos', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockSuccessResponse('658')), { status: 200 }),
      );

      const solicitud = await provider.solicitar(baseInput);
      const resultado = await provider.obtenerResultado(solicitud.referencia_proveedor);

      expect(resultado.score).toBe(658);
      expect(resultado.resultado).toBe('aprobado');
      expect(resultado.datos_crudos).toHaveProperty('Tercero');
      expect(resultado.datos_crudos).toHaveProperty('CreditVision_5694');
      expect(resultado.datos_crudos).toHaveProperty('Informacion_Comercial_154');
    });

    it('deberia lanzar error para referencia inexistente', async () => {
      await expect(provider.obtenerResultado('REF-NOPE')).rejects.toThrow('no encontrado');
    });
  });

  describe('cancelar()', () => {
    it('deberia retornar cancelado=false (TransUnion es sincrono)', async () => {
      const result = await provider.cancelar('REF-123');
      expect(result.cancelado).toBe(false);
      expect(result.mensaje).toContain('sincrona');
    });
  });

  describe('verificarDisponibilidad()', () => {
    it('deberia retornar disponible=true si TransUnion responde', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockErrorResponse(1, 'Numero identificacion requerido')), { status: 200 }),
      );

      const health = await provider.verificarDisponibilidad();

      expect(health.disponible).toBe(true);
      expect(health.latencia_ms).toBeGreaterThanOrEqual(0);
      expect(health.ultimo_error).toBeNull();
    });

    it('deberia retornar disponible=false si hay error de conexion', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const health = await provider.verificarDisponibilidad();

      expect(health.disponible).toBe(false);
      expect(health.ultimo_error).toContain('ECONNREFUSED');
    });
  });
});

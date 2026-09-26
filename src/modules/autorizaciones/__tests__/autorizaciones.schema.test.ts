import { describe, it, expect } from 'vitest';
import {
  expedienteIdParamsSchema,
  tokenParamsSchema,
  firmarSchema,
  confirmarIdentidadSchema,
  revocarSchema,
  verificarOtpSchema,
} from '../autorizaciones.schema';

// ============================================================
// expedienteIdParamsSchema
// ============================================================

describe('expedienteIdParamsSchema', () => {
  it('debe aceptar un UUID valido', () => {
    const result = expedienteIdParamsSchema.safeParse({
      expedienteId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('debe rechazar un string que no es UUID', () => {
    const result = expedienteIdParamsSchema.safeParse({
      expedienteId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('debe rechazar un string vacio', () => {
    const result = expedienteIdParamsSchema.safeParse({
      expedienteId: '',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// tokenParamsSchema
// ============================================================

describe('tokenParamsSchema', () => {
  it('debe aceptar un token de 64 caracteres (hex)', () => {
    const token = 'a'.repeat(64);
    const result = tokenParamsSchema.safeParse({ token });
    expect(result.success).toBe(true);
  });

  it('debe aceptar un token de 32 caracteres (minimo)', () => {
    const token = 'b'.repeat(32);
    const result = tokenParamsSchema.safeParse({ token });
    expect(result.success).toBe(true);
  });

  it('debe rechazar un token menor a 32 caracteres', () => {
    const result = tokenParamsSchema.safeParse({ token: 'short' });
    expect(result.success).toBe(false);
  });

  it('debe rechazar un token mayor a 64 caracteres', () => {
    const token = 'c'.repeat(65);
    const result = tokenParamsSchema.safeParse({ token });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// firmarSchema
// ============================================================

// §8.1: la firma lleva el documento que escribio el prospecto.
const DOC = { numero_documento: '1.023.456.789' };

describe('firmarSchema', () => {
  it('debe aceptar firma canvas con datos_firma', () => {
    const result = firmarSchema.safeParse({
      metodo_firma: 'canvas',
      datos_firma: 'data:image/png;base64,' + 'A'.repeat(200),
      ...DOC,
    });
    expect(result.success).toBe(true);
  });

  it('debe rechazar firma canvas sin datos_firma', () => {
    const result = firmarSchema.safeParse({
      metodo_firma: 'canvas',
      ...DOC,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('datos_firma');
    }
  });

  it('debe aceptar firma otp con codigo_otp', () => {
    const result = firmarSchema.safeParse({
      metodo_firma: 'otp',
      codigo_otp: '123456',
      ...DOC,
    });
    expect(result.success).toBe(true);
  });

  it('debe rechazar firma otp sin codigo_otp', () => {
    const result = firmarSchema.safeParse({
      metodo_firma: 'otp',
      ...DOC,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('codigo_otp');
    }
  });

  it('debe rechazar metodo_firma invalido', () => {
    const result = firmarSchema.safeParse({
      metodo_firma: 'sms',
      datos_firma: 'data:image/png;base64,' + 'A'.repeat(200),
    });
    expect(result.success).toBe(false);
  });

  it('debe rechazar datos_firma demasiado cortos', () => {
    const result = firmarSchema.safeParse({
      metodo_firma: 'canvas',
      datos_firma: 'short',
    });
    expect(result.success).toBe(false);
  });

  it('debe rechazar codigo_otp con longitud distinta a 6', () => {
    const result = firmarSchema.safeParse({
      metodo_firma: 'otp',
      codigo_otp: '12345',
    });
    expect(result.success).toBe(false);
  });

  it('debe aceptar canvas con datos_firma y ignorar codigo_otp', () => {
    const result = firmarSchema.safeParse({
      metodo_firma: 'canvas',
      datos_firma: 'data:image/png;base64,' + 'A'.repeat(200),
      codigo_otp: '123456',
      ...DOC,
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================
// revocarSchema
// ============================================================

describe('revocarSchema', () => {
  it('debe aceptar un motivo de 10+ caracteres', () => {
    const result = revocarSchema.safeParse({
      motivo: 'Revocacion por solicitud del titular de datos',
    });
    expect(result.success).toBe(true);
  });

  it('debe rechazar un motivo menor a 10 caracteres', () => {
    const result = revocarSchema.safeParse({
      motivo: 'corto',
    });
    expect(result.success).toBe(false);
  });

  it('debe rechazar un motivo mayor a 1000 caracteres', () => {
    const result = revocarSchema.safeParse({
      motivo: 'x'.repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it('debe aceptar un motivo de exactamente 1000 caracteres', () => {
    const result = revocarSchema.safeParse({
      motivo: 'x'.repeat(1000),
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================
// verificarOtpSchema
// ============================================================

describe('verificarOtpSchema', () => {
  it('debe aceptar un codigo de 6 digitos', () => {
    const result = verificarOtpSchema.safeParse({ codigo: '123456' });
    expect(result.success).toBe(true);
  });

  it('debe rechazar un codigo de 5 digitos', () => {
    const result = verificarOtpSchema.safeParse({ codigo: '12345' });
    expect(result.success).toBe(false);
  });

  it('debe rechazar un codigo de 7 digitos', () => {
    const result = verificarOtpSchema.safeParse({ codigo: '1234567' });
    expect(result.success).toBe(false);
  });

  it('debe rechazar un codigo vacio', () => {
    const result = verificarOtpSchema.safeParse({ codigo: '' });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// firmarSchema / confirmarIdentidadSchema — documento escrito (Flujo §8.1)
// ============================================================

describe('documento escrito por el prospecto (§8.1)', () => {
  it('la firma sin numero_documento no pasa (un cliente viejo no dispara el reporte)', () => {
    const result = firmarSchema.safeParse({ metodo_firma: 'casilla' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.path.join('.'))).toContain('numero_documento');
  });

  it('la casilla con el documento pasa; los espacios de los extremos se recortan', () => {
    const result = firmarSchema.safeParse({ metodo_firma: 'casilla', numero_documento: '  1023456789 ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.numero_documento).toBe('1023456789');
  });

  it('confirmar-identidad exige el numero y rechaza uno vacio', () => {
    expect(confirmarIdentidadSchema.safeParse({ numero_documento: '1.023.456.789' }).success).toBe(true);
    expect(confirmarIdentidadSchema.safeParse({ numero_documento: '   ' }).success).toBe(false);
    expect(confirmarIdentidadSchema.safeParse({}).success).toBe(false);
  });
});

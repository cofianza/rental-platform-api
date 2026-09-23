/**
 * Misma regla de contraseña en todos los registros: el miembro invitado y el
 * solicitante solo pedían 8 caracteres, así que "12345678" pasaba.
 */
import { describe, it, expect } from 'vitest';
import { registrarMiembroSchema } from '@/modules/inmobiliaria-miembros/inmobiliaria-miembros.schema';
import { registerSolicitanteSchema } from '@/modules/vitrina/vitrina.schema';

const miembro = { nombre: 'Ana', apellido: 'Paz', telefono: '+573001112233' };
const solicitante = {
  nombre: 'Ana',
  apellido: 'Paz',
  email: 'ana@ejemplo.co',
  telefono: '3001112233',
  tipo_documento: 'cc',
  numero_documento: '123',
  accept_terms: true,
  accept_data_treatment: true,
};

describe('política de contraseña', () => {
  it.each(['12345678', 'abcdefgh', 'Abcdefgh'])('rechaza "%s"', (password) => {
    expect(registrarMiembroSchema.safeParse({ ...miembro, password }).success).toBe(false);
    expect(registerSolicitanteSchema.safeParse({ ...solicitante, password, confirm_password: password }).success).toBe(false);
  });

  it('acepta mayúscula + minúscula + número', () => {
    const password = 'Secreta123';
    expect(registrarMiembroSchema.safeParse({ ...miembro, password }).success).toBe(true);
    expect(registerSolicitanteSchema.safeParse({ ...solicitante, password, confirm_password: password }).success).toBe(true);
  });

  it('el miembro conserva el tope de 72 (bcrypt)', () => {
    expect(registrarMiembroSchema.safeParse({ ...miembro, password: 'Aa1' + 'x'.repeat(70) }).success).toBe(false);
  });
});

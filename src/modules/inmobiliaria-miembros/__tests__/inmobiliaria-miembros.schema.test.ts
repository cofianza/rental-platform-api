import { describe, it, expect } from 'vitest';
import {
  invitarMiembroSchema,
  cambiarRolMiembroSchema,
} from '../inmobiliaria-miembros.schema';

describe('invitarMiembroSchema', () => {
  it('normaliza el email a minúsculas y aplica rol_miembro=miembro por defecto', () => {
    const out = invitarMiembroSchema.parse({ email: 'Persona@Ejemplo.COM' });
    expect(out.email).toBe('persona@ejemplo.com');
    expect(out.rol_miembro).toBe('miembro');
  });

  it('acepta rol_miembro=solo_lectura (viewer)', () => {
    const out = invitarMiembroSchema.parse({ email: 'a@b.com', rol_miembro: 'solo_lectura' });
    expect(out.rol_miembro).toBe('solo_lectura');
  });

  it('rechaza invitar directamente como owner (co-titular se promueve, no se invita)', () => {
    expect(() => invitarMiembroSchema.parse({ email: 'a@b.com', rol_miembro: 'owner' })).toThrow();
  });

  it('rechaza emails inválidos', () => {
    expect(() => invitarMiembroSchema.parse({ email: 'no-es-email' })).toThrow();
  });
});

describe('cambiarRolMiembroSchema', () => {
  it.each(['owner', 'miembro', 'solo_lectura'])('acepta rol %s', (rol) => {
    expect(cambiarRolMiembroSchema.parse({ rol_miembro: rol }).rol_miembro).toBe(rol);
  });

  it('rechaza roles desconocidos', () => {
    expect(() => cambiarRolMiembroSchema.parse({ rol_miembro: 'admin' })).toThrow();
  });
});

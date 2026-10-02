/**
 * Registro v2: los schemas de propietario e inmobiliaria siguen aceptando el
 * payload de la web anterior y validan los campos nuevos (todos opcionales).
 */
import { describe, it, expect } from 'vitest';
import {
  registerPropietarioSchema,
  registerInmobiliariaSchema,
  digitoVerificacionNit,
} from '../registration.schema';

const comunes = {
  email: 'ana@ejemplo.co',
  telefono: '+57 3001112233',
  password: 'Secreta123',
  confirm_password: 'Secreta123',
  accept_terms: true,
  accept_data_treatment: true,
};
// Payloads de la web anterior, tal cual los envía hoy.
const propietario = {
  ...comunes,
  nombre: 'Ana',
  apellido: 'Paz',
  tipo_documento: 'cc',
  numero_documento: '1040567890',
  direccion: 'Calle 10 # 20-30',
};
const NIT = `900123456-${digitoVerificacionNit('900123456')}`;
const inmobiliaria = {
  ...comunes,
  razon_social: 'Inmobiliaria Norte S.A.S.',
  nit: NIT,
  direccion_comercial: 'Carrera 43A # 1-50',
  ciudad: 'Medellín',
  nombre_representante_nombre: 'Luis',
  nombre_representante_apellido: 'Gómez',
  cargo_representante: 'Gerente',
  afianzadora_tipo: 'ninguna',
};

const prop = (extra: Record<string, unknown> = {}) => registerPropietarioSchema.safeParse({ ...propietario, ...extra });
const inmo = (extra: Record<string, unknown> = {}) => registerInmobiliariaSchema.safeParse({ ...inmobiliaria, ...extra });

describe('schemas de registro', () => {
  it('aceptan el payload de la web anterior', () => {
    expect(prop().success).toBe(true);
    expect(inmo().success).toBe(true);
  });

  it('propietario sin dirección pasa', () => {
    expect(prop({ direccion: undefined }).success).toBe(true);
  });

  it.each(['12345678', 'abcdefgh', 'Abcdefgh'])('rechazan la contraseña "%s"', (password) => {
    expect(prop({ password, confirm_password: password }).success).toBe(false);
    expect(inmo({ password, confirm_password: password }).success).toBe(false);
  });

  it('rechazan contraseñas que no coinciden', () => {
    expect(prop({ confirm_password: 'Secreta124' }).success).toBe(false);
    expect(inmo({ confirm_password: 'Secreta124' }).success).toBe(false);
  });

  it('NIT con dígito de verificación malo falla', () => {
    const dvMalo = (digitoVerificacionNit('900123456') + 1) % 10;
    expect(inmo({ nit: `900123456-${dvMalo}` }).success).toBe(false);
    expect(inmo({ nit: '900123456' }).success).toBe(false);
  });

  it('los documentos se guardan sin puntos ni espacios', () => {
    const p = prop({ numero_documento: '71.234.567' });
    expect(p.success && p.data.numero_documento).toBe('71234567');
    expect(prop({ numero_documento: ' . ' }).success).toBe(false);
    const pasaporte = prop({ tipo_documento: 'pasaporte', numero_documento: 'AB-12 3' });
    expect(pasaporte.success && pasaporte.data.numero_documento).toBe('AB123');

    const i = inmo({ representante_tipo_documento: 'cc', representante_documento: '71.234.567' });
    expect(i.success && i.data.representante_documento).toBe('71234567');
  });

  it('documento del representante: el tipo y el número van juntos', () => {
    expect(inmo({ representante_tipo_documento: 'cc' }).success).toBe(false);
    expect(inmo({ representante_documento: '71234567' }).success).toBe(false);
    expect(inmo({ representante_tipo_documento: 'nit', representante_documento: '71234567' }).success).toBe(false);
    expect(inmo({ representante_tipo_documento: 'cc', representante_documento: '7' }).success).toBe(false);
  });

  // El teclado del celular deja un espacio tras el nombre («Roberto »): se
  // guardaba así y el correo saludaba «Hola Roberto , gracias…».
  it('los nombres se guardan sin espacios sobrantes, y uno solo de espacios no cuenta', () => {
    const p = prop({ nombre: 'Roberto ', apellido: ' Díaz ' });
    expect(p.success && [p.data.nombre, p.data.apellido]).toEqual(['Roberto', 'Díaz']);
    expect(prop({ nombre: '   ' }).success).toBe(false);

    const i = inmo({ nombre_representante_nombre: 'Luis ', nombre_representante_apellido: ' Gómez' });
    expect(i.success && [i.data.nombre_representante_nombre, i.data.nombre_representante_apellido]).toEqual(['Luis', 'Gómez']);
    expect(inmo({ nombre_representante_apellido: ' ' }).success).toBe(false);
  });

  it('el celular sin indicativo dice «indicativo del país» (no «lada», que es de México)', () => {
    const r = prop({ telefono: '3001112233' });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0].message).toBe(
      'Teléfono inválido. Debe incluir el indicativo del país (ej: +57 3001234567)',
    );
  });

  it('origen, rango de inmuebles y sitio web: solo valores de la lista', () => {
    expect(prop({ origen: 'redes' }).success).toBe(true);
    expect(prop({ origen: 'volante' }).success).toBe(false);
    expect(inmo({ origen: 'evento', inmuebles_gestionados: '300+', sitio_web: 'https://inmonorte.co' }).success).toBe(true);
    expect(inmo({ origen: 'volante' }).success).toBe(false);
    expect(inmo({ inmuebles_gestionados: '5' }).success).toBe(false);
    expect(inmo({ sitio_web: 'inmonorte' }).success).toBe(false);
    expect(inmo({ sitio_web: 'javascript:alert(1)' }).success).toBe(false);
  });
});

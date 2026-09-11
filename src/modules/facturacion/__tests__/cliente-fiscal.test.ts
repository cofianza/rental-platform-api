import { describe, it, expect } from 'vitest';
import {
  aplicarOverride,
  clienteDesdePerfil,
  clienteDesdeSolicitante,
  faltantesFiscales,
  type PerfilFiscal,
} from '../cliente-fiscal';

// Adenda 2 §7, opcion B: la factura del estudio sale a nombre de quien pago.

const inmobiliaria: PerfilFiscal = {
  nombre: 'Laura',
  apellido: 'Gómez',
  tipo_documento: 'cc',
  numero_documento: '43000111',
  razon_social: 'Inmobiliaria Centro S.A.S.',
  nit: '901.234.567-8',
  domicilio_direccion: 'Calle 10 # 20-30',
  direccion_comercial: 'Otra dirección',
  direccion: null,
  telefono: '3001234567',
  whatsapp_recaudo: null,
  email_recaudo: 'cartera@centro.co',
  municipio_codigo: '05001',
  municipio_nombre: 'Medellín',
};

describe('clienteDesdePerfil', () => {
  it('inmobiliaria con NIT: persona jurídica, NIT sin DV y el DV aparte', () => {
    const c = clienteDesdePerfil(inmobiliaria, 'gestor@centro.co');
    expect(c).toMatchObject({
      tipo_persona: 'juridica',
      tipo_documento: 'nit',
      numero_documento: '901234567',
      digito_verificacion: '8',
      razon_social: 'Inmobiliaria Centro S.A.S.',
      email: 'cartera@centro.co',
      direccion: 'Calle 10 # 20-30',
      municipio_codigo: '05001',
    });
    expect(faltantesFiscales(c)).toEqual([]);
  });

  it('propietario sin NIT: persona natural con su cédula; sin email de recaudo usa el de quien pagó', () => {
    const c = clienteDesdePerfil({ ...inmobiliaria, nit: null, razon_social: null, email_recaudo: null }, 'dueno@correo.co');
    expect(c).toMatchObject({
      tipo_persona: 'natural',
      tipo_documento: 'cc',
      numero_documento: '43000111',
      nombre_completo: 'Laura Gómez',
      email: 'dueno@correo.co',
    });
    expect(faltantesFiscales(c)).toEqual([]);
  });

  it('sin municipio DANE o sin DV la factura no sale sola: quedan los faltantes', () => {
    const c = clienteDesdePerfil({ ...inmobiliaria, nit: '901234567', municipio_codigo: null }, null);
    expect(faltantesFiscales(c)).toEqual(['municipio_codigo', 'digito_verificacion']);
  });
});

describe('clienteDesdeSolicitante + aplicarOverride', () => {
  it('lo corregido en el modal gana sobre lo guardado', () => {
    const base = clienteDesdeSolicitante({
      tipo_persona: null,
      nombre: 'Ana',
      apellido: 'Pérez',
      razon_social: null,
      email: 'ana@correo.co',
      telefono: null,
      tipo_documento: 'cc',
      numero_documento: '1020304050',
      digito_verificacion: null,
      direccion: null,
      municipio_id: '11001',
      municipio_nombre: 'Bogotá',
      tribute_code: null,
    });
    expect(faltantesFiscales(base)).toEqual(['direccion', 'telefono']);
    const c = aplicarOverride(base, { direccion: 'Cra 7 # 45-10', telefono: '3109998877' });
    expect(faltantesFiscales(c)).toEqual([]);
    expect(c).toMatchObject({ municipio_codigo: '11001', tribute_code: 'ZZ', tipo_persona: 'natural' });
  });
});

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type { MunicipioCO } from '@/lib/colombia-municipios';
import type { FilaArchivo, ValorCelda } from '../plantilla';
import {
  aplicarConflicto,
  claveInmueble,
  exposicionDe,
  fecha,
  normalizarDireccion,
  numero,
  resolverMunicipio,
  validarFila,
  validarFilas,
  type ContextoValidacion,
} from '../validacion';

const MUNICIPIOS: MunicipioCO[] = [
  { code: '05001', name: 'Medellín', department: { code: '05', name: 'Antioquia' } },
  { code: '11001', name: 'Bogotá, D.c.', department: { code: '11', name: 'Bogotá, D.c.' } },
  { code: '25473', name: 'Mosquera', department: { code: '25', name: 'Cundinamarca' } },
  { code: '52473', name: 'Mosquera', department: { code: '52', name: 'Nariño' } },
  { code: '13001', name: 'Cartagena De Indias', department: { code: '13', name: 'Bolívar' } },
];

const ctx = (extra: Partial<ContextoValidacion> = {}): ContextoValidacion => ({
  hoy: '2026-10-07',
  parametros: {
    CANON_MAX_TRANSITORIO: 3_000_000,
    TOPE_CANON_COMERCIAL: 4_000_000,
    MESES_SIN_MORA_REQUERIDOS: 6,
    TARIFA_MIGRACION_REPORTABLE: 2,
    RECARGO_NO_REPORTABLE: 0.5,
  },
  habilitaciones: { vivienda: { habeas_subrogatario: true }, comercial: { habeas_subrogatario: true } },
  municipios: MUNICIPIOS,
  ...extra,
});

const BASE: Record<string, ValorCelda> = {
  direccion: 'Calle 10 # 20-30 Apto 301',
  municipio: 'Medellín',
  codigo_interno: 'APT-1',
  destinacion: 'Vivienda',
  tipo_inmueble: 'Apartamento',
  estrato: 4,
  arrendatario_tipo_persona: 'Natural',
  arrendatario_nombre: 'Ana María',
  arrendatario_apellido: 'Pérez Gómez',
  arrendatario_tipo_documento: 'CC',
  arrendatario_numero_documento: '1.020.304.050',
  arrendatario_celular: '300 111 2233',
  arrendatario_email: 'Ana@Correo.co',
  canon: 2_500_000,
  iva_canon_pct: null,
  fecha_inicio: new Date(Date.UTC(2025, 0, 15)),
  fecha_vencimiento: '14/01/2027',
  paga_servicios: 'Arrendatario',
  paga_administracion: 'No aplica',
  cuota_administracion: null,
  al_dia: 'Sí',
  mora_reciente: 'No',
  plantilla_entregada: 'Sí',
  observaciones: null,
};

const fila = (cambios: Record<string, ValorCelda> = {}, n = 2): FilaArchivo => ({ n_fila: n, celdas: { ...BASE, ...cambios } });

describe('validarFila', () => {
  it('una fila completa y al día se acepta, reportable, con la tarifa base y los datos que lee la activación', () => {
    const r = validarFila(fila(), ctx());
    expect(r.motivos).toEqual([]);
    expect(r.resultado).toBe('aceptada');
    expect(r.reportable).toBe(true);
    expect(r.tarifa_pct).toBe(2);
    expect(r.documento_arrendatario).toBe('1020304050');
    expect(r.clave_inmueble).toBe('CL 10 20 30 AP 301|medellin');
    expect(r.datos).toMatchObject({
      municipio: 'Medellín',
      departamento: 'Antioquia',
      destinacion: 'vivienda',
      tipo_inmueble: 'apartamento',
      estrato: 4,
      canon: 2_500_000,
      iva_canon_pct: 0,
      fecha_inicio: '2025-01-15',
      fecha_vencimiento: '2027-01-14',
      arrendatario: { tipo_persona: 'natural', tipo_documento: 'cc', celular: '573001112233', email: 'ana@correo.co', apellido: 'Pérez Gómez' },
      declaraciones: { al_dia: true, mora_reciente: false, plantilla_entregada: true },
    });
  });

  it('§1.3: mora a la fecha y mora en los últimos meses se rechazan con su motivo', () => {
    const r = validarFila(fila({ al_dia: 'No', mora_reciente: 'Si' }), ctx());
    expect(r.resultado).toBe('rechazada');
    expect(r.motivos).toContain('Contrato declarado en mora a la fecha de migración.');
    expect(r.motivos).toContain('Contrato con mora declarada en los últimos 6 meses.');
  });

  it('§1.2.5: tope por destinación sobre el canon sin IVA', () => {
    expect(validarFila(fila({ canon: '$ 3.000.001' }), ctx()).motivos[0]).toMatch(/tope de vivienda/);
    expect(validarFila(fila({ canon: 3_000_000 }), ctx()).resultado).toBe('aceptada');
    const comercial = validarFila(fila({ destinacion: 'Comercial', tipo_inmueble: 'Local', canon: 3_500_000, iva_canon_pct: 19 }), ctx());
    expect(comercial.resultado).toBe('aceptada');
    expect(comercial.datos.iva_canon_pct).toBe(19);
    expect(validarFila(fila({ destinacion: 'Comercial', canon: 4_000_001, iva_canon_pct: 0 }), ctx()).resultado).toBe('rechazada');
  });

  it('IVA: vacío en comercial advierte y toma 0; en vivienda se ignora con advertencia', () => {
    const c = validarFila(fila({ destinacion: 'Comercial' }), ctx());
    expect(c.resultado).toBe('advertencia');
    expect(c.datos.iva_canon_pct).toBe(0);
    const v = validarFila(fila({ iva_canon_pct: 19 }), ctx());
    expect(v.resultado).toBe('advertencia');
    expect(v.datos.iva_canon_pct).toBe(0);
  });

  it('destinación mixta: rechazo que remite a la Gerencia General', () => {
    expect(validarFila(fila({ destinacion: 'Mixta' }), ctx()).motivos).toContain(
      'Destinación mixta: requiere decisión de la Gerencia General caso por caso.',
    );
  });

  it('sin habilitación para la destinación, se rechaza', () => {
    const r = validarFila(fila({ destinacion: 'Comercial', iva_canon_pct: 0 }), ctx({ habilitaciones: { vivienda: { habeas_subrogatario: true } } }));
    expect(r.motivos).toContain('La inmobiliaria no está habilitada para migrar contratos de destinación comercial.');
  });

  it('§1.3: vencido antes de la migración se rechaza; poco plazo restante no (§1.3.1); sin iniciar se rechaza', () => {
    expect(validarFila(fila({ fecha_vencimiento: '2026-10-06' }), ctx()).resultado).toBe('rechazada');
    expect(validarFila(fila({ fecha_vencimiento: '2026-10-08' }), ctx()).resultado).toBe('aceptada');
    expect(validarFila(fila({ fecha_inicio: '2026-11-01' }), ctx()).motivos).toContain(
      'El contrato aún no ha iniciado: solo se migran contratos en ejecución.',
    );
  });

  it('§5.1.3 / §5.2.2: formato anterior = NO REPORTABLE con recargo y advertencia', () => {
    const r = validarFila(fila({ plantilla_entregada: 'No' }), ctx());
    expect(r.resultado).toBe('advertencia');
    expect(r.reportable).toBe(false);
    expect(r.reportable_motivo).toBe('formato_anterior');
    expect(r.tarifa_pct).toBe(2.5);
    expect(r.datos.tarifa_base_pct).toBe(2); // la base a la que baja al pasar a REPORTABLE
  });

  it('valores que no caben en las columnas de la activación se rechazan en la validación', () => {
    const largo = validarFila(fila({ arrendatario_nombre: 'A'.repeat(301) }), ctx());
    expect(largo.motivos).toContain('Nombre o razón social del arrendatario de más de 300 caracteres.');
    const correo = validarFila(fila({ arrendatario_email: `${'a'.repeat(250)}@correo.co` }), ctx());
    expect(correo.motivos).toContain('Correo electrónico del arrendatario no válido.');
    const cuota = validarFila(fila({ paga_administracion: 'Arrendatario', cuota_administracion: 100_000_000 }), ctx());
    expect(cuota.motivos).toContain('«Cuota de administración»: valor no válido.');
  });

  it('§5.1.1: plantilla sin autorización al subrogatario = NO REPORTABLE aunque se firmó sobre ella', () => {
    const r = validarFila(fila(), ctx({ habilitaciones: { vivienda: { habeas_subrogatario: false } } }));
    expect(r.resultado).toBe('aceptada');
    expect(r.reportable).toBe(false);
    expect(r.reportable_motivo).toBe('plantilla_sin_autorizacion');
    expect(r.tarifa_pct).toBe(2.5);
  });

  it('campos obligatorios incompletos se listan en un solo motivo', () => {
    const r = validarFila(fila({ arrendatario_email: null, plantilla_entregada: null, arrendatario_apellido: '' }), ctx());
    expect(r.resultado).toBe('rechazada');
    expect(r.motivos[0]).toMatch(/^Campos obligatorios incompletos: .*apellidos.*correo electrónico.*plantilla/);
  });

  it('persona jurídica: NIT sin dígito de verificación, sin apellidos; con CC se rechaza', () => {
    const r = validarFila(
      fila({ arrendatario_tipo_persona: 'Jurídica', arrendatario_nombre: 'Comercial S.A.S.', arrendatario_apellido: null, arrendatario_tipo_documento: 'NIT', arrendatario_numero_documento: '900.123.456-7' }),
      ctx(),
    );
    expect(r.resultado).toBe('aceptada');
    expect(r.documento_arrendatario).toBe('900123456');
    expect(r.datos.arrendatario).toMatchObject({ tipo_persona: 'juridica', apellido: '', razon_social: 'Comercial S.A.S.' });
    expect(
      validarFila(fila({ arrendatario_tipo_persona: 'Jurídica', arrendatario_apellido: null }), ctx()).motivos,
    ).toContain('Un arrendatario persona jurídica se identifica con NIT.');
  });

  it('coarrendatario: se exige nombre, documento y un contacto', () => {
    const ok = validarFila(fila({ coarrendatario1_nombre: 'Luis Ruiz', coarrendatario1_tipo_documento: 'CE', coarrendatario1_numero_documento: 'E-12345', coarrendatario1_email: 'luis@x.co' }), ctx());
    expect(ok.resultado).toBe('aceptada');
    expect(ok.datos.coarrendatarios).toEqual([{ nombre: 'Luis Ruiz', tipo_documento: 'ce', numero_documento: 'E12345', celular: null, email: 'luis@x.co' }]);
    const mal = validarFila(fila({ coarrendatario2_nombre: 'Sin documento' }), ctx());
    expect(mal.motivos).toContain('Coarrendatario 2: faltan nombre, tipo o número de documento.');
    expect(mal.motivos).toContain('Coarrendatario 2: indique un celular o un correo electrónico.');
  });

  it('valores fuera de la lista y celular inválido se rechazan', () => {
    const r = validarFila(fila({ tipo_inmueble: 'Castillo', arrendatario_celular: '12345' }), ctx());
    expect(r.motivos.some((m) => m.startsWith('«Tipo de inmueble»: valor no permitido'))).toBe(true);
    expect(r.motivos).toContain('Celular del arrendatario no válido (10 dígitos de Colombia).');
  });
});

describe('validarFilas / aplicarConflicto / exposición', () => {
  it('el mismo inmueble dos veces en el archivo: la segunda se rechaza', () => {
    const [a, b] = validarFilas([fila({}, 2), fila({ direccion: 'CL 10 No. 20 30 AP 301' }, 3)], ctx());
    expect(a.resultado).toBe('aceptada');
    expect(b.motivos).toContain('Inmueble repetido en el archivo (también en la fila 2).');
  });

  it('un cruce con la base suma su motivo o vincula el inmueble existente', () => {
    const r = validarFila(fila(), ctx());
    aplicarConflicto(r, { inmueble_id: 'inm-1' });
    expect(r.datos.inmueble_id).toBe('inm-1');
    expect(r.resultado).toBe('aceptada');
    aplicarConflicto(r, { advertencia: 'otra org' });
    expect(r.resultado).toBe('advertencia');
    aplicarConflicto(r, { motivo: 'ya existe' });
    expect(r.resultado).toBe('rechazada');
  });

  it('exposición = 18 cánones por fila no rechazada', () => {
    const rs = validarFilas([fila({}, 2), fila({ direccion: 'Calle 1 # 1-1', canon: 1_000_000 }, 3), fila({ direccion: 'Calle 2 # 2-2', al_dia: 'No' }, 4)], ctx());
    expect(exposicionDe(rs)).toBe(18 * 3_500_000);
  });
});

describe('normalización', () => {
  it('direcciones equivalentes dan la misma clave', () => {
    expect(normalizarDireccion('Carrera 43A # 1 Sur - 50, Interior 201')).toBe('KR 43A 1 SUR 50 IN 201');
    expect(normalizarDireccion('Kra 43 a N° 1 sur 50 int. 201')).toBe('KR 43A 1 SUR 50 IN 201');
    expect(claveInmueble('Calle 1 # 2-3', 'Bogotá')).toBe(claveInmueble('CL 1 2 3', 'Bogotá, D.C.'));
  });

  it('municipio: homónimos piden departamento; Bogotá y nombres cortos se resuelven', () => {
    expect(resolverMunicipio('Mosquera', MUNICIPIOS)).toHaveProperty('error');
    expect(resolverMunicipio('Mosquera, Nariño', MUNICIPIOS)).toMatchObject({ municipio: { code: '52473' } });
    expect(resolverMunicipio('Mosquera (Cundinamarca)', MUNICIPIOS)).toMatchObject({ municipio: { code: '25473' } });
    expect(resolverMunicipio('bogota', MUNICIPIOS)).toMatchObject({ municipio: { code: '11001' } });
    expect(resolverMunicipio('Cartagena', MUNICIPIOS)).toMatchObject({ municipio: { code: '13001' } });
    expect(resolverMunicipio('Gotham', MUNICIPIOS)).toHaveProperty('error');
  });

  it('números en pesos y fechas en los formatos de la plantilla', () => {
    expect(numero('$ 1.500.000')).toBe(1_500_000);
    expect(numero('1,500,000')).toBe(1_500_000);
    expect(numero('1.500.000,50')).toBe(1_500_000.5);
    expect(numero('19%')).toBe(19);
    expect(numero('abc')).toBeNaN();
    expect(fecha('2026-02-30')).toBe('invalida');
    expect(fecha('5/3/2026')).toBe('2026-03-05');
    expect(fecha(46000)).toBe('2025-12-09');
  });
});

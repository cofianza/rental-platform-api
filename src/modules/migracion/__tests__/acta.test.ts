import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/pdfRenderer', () => ({ renderHtmlToPdf: vi.fn() }));
vi.mock('../habilitacion.service', () => ({ BUCKET: 'documentos-expedientes' }));

import { htmlActa, type DatosActa } from '../acta';
import type { DatosFila, ResultadoFila } from '../validacion';

const datos = (extra: Partial<DatosFila> = {}): DatosFila => ({
  direccion: 'Calle 10 # 20-30',
  municipio: 'Medellín',
  departamento: 'Antioquia',
  codigo_interno: null,
  destinacion: 'vivienda',
  tipo_inmueble: 'Apartamento',
  estrato: 4,
  canon: 2_500_000,
  iva_canon_pct: 0,
  cuota_administracion: null,
  fecha_inicio: '2025-01-15',
  fecha_vencimiento: '2027-01-14',
  arrendatario: {
    tipo_persona: 'natural',
    nombre: 'Ana <b>María</b>',
    apellido: 'Pérez',
    razon_social: null,
    tipo_documento: 'CC',
    numero_documento: '1020304050',
    celular: null,
    email: null,
  },
  coarrendatarios: [],
  paga_servicios: null,
  paga_administracion: null,
  declaraciones: { al_dia: true, mora_reciente: false, plantilla_entregada: true },
  observaciones: null,
  ...extra,
});

const fila = (n: number, extra: Partial<ResultadoFila>): ResultadoFila => ({
  n_fila: n,
  resultado: 'aceptada',
  motivos: [],
  advertencias: [],
  datos: datos(),
  clave_inmueble: 'x',
  documento_arrendatario: 'CC1020304050',
  reportable: true,
  reportable_motivo: null,
  tarifa_pct: 2,
  ...extra,
});

const base: DatosActa = {
  empresa: {
    name: 'COFIANZA S.A.S.',
    nit: '902.038.122-7',
    address: 'Dirección',
    phone: '',
    email: 'hola@cofianza.co',
    website: '',
    certificateValidityDays: 30,
  },
  inmobiliaria: { id: 'org-1', nombre: 'Inmobiliaria Uno' },
  habilitaciones: [{ destinacion: 'vivienda', revisado_en: '2026-10-01T15:00:00Z' }],
  lote: { numero: 'MIG-2026-001', rep_legal_nombre: 'Luis Gómez', rep_legal_documento: 'CC 123' },
  generadaEn: new Date('2026-10-07T15:00:00Z'),
  filas: [
    fila(2, {}),
    fila(3, { resultado: 'advertencia', reportable: false, tarifa_pct: 2.5 }),
    fila(4, { resultado: 'rechazada', motivos: ['Canon por encima del tope de la destinación.'], reportable: null, tarifa_pct: null }),
  ],
  mesesSinMora: 6,
  diasRespuestaAuditoria: 5,
};

describe('htmlActa', () => {
  const html = htmlActa(base);

  it('lleva las dos anclas de firma en orden: representante legal y Cofianza', () => {
    expect(html.match(/\{\{signature:\d\}\}/g)).toEqual(['{{signature:0}}', '{{signature:1}}']);
    expect(html.indexOf('{{signature:0}}')).toBeLessThan(html.indexOf('Representante legal de Inmobiliaria Uno'));
  });

  it('separa aceptados (con advertencia incluidos) de rechazados con su motivo', () => {
    expect(html).toContain('Contratos aceptados (2)');
    expect(html).toContain('Contratos rechazados (1)');
    expect(html).toContain('Canon por encima del tope de la destinación.');
  });

  it('marca REPORTABLE / NO REPORTABLE y la tarifa de cada contrato', () => {
    expect(html.match(/class="marca">REPORTABLE</g)).toHaveLength(1);
    expect(html.match(/class="marca">NO REPORTABLE</g)).toHaveLength(1);
    expect(html).toContain('2 % + IVA');
    expect(html).toContain('2,5 % + IVA');
  });

  it('imprime canon, fechas y la declaración con los meses sin mora de calibración', () => {
    expect(html).toContain('$ 2.500.000');
    expect(html).toContain('15/01/2025 a 14/01/2027');
    expect(htmlActa({ ...base, mesesSinMora: 9 })).toContain('no ha tenido mora en los últimos 9 meses');
    expect(html).toContain('dentro de los 5 días hábiles');
  });

  it('escapa lo que viene del archivo', () => {
    expect(html).not.toContain('<b>María</b>');
    expect(html).toContain('Ana &lt;b&gt;María&lt;/b&gt; Pérez');
  });
});

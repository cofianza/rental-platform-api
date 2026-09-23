/**
 * Contrato V4 (la plantilla activa): la migración 20260929000028 sobre el HTML
 * sembrado. Un extranjero no sale como «C.C.», la cuenta va a nombre del
 * titular real y las matrículas vacías no dejan frases rotas. Si alguien cambia
 * la plantilla o la migración y los REPLACE dejan de encajar, esto lo dice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { renderTemplate } from '@/lib/templateEngine';

const MIG = path.resolve(__dirname, '../../../../supabase/migrations');
const seed = readFileSync(path.join(MIG, '20260604000001_seed_plantilla_contrato_v4.sql'), 'utf8');
const sql = readFileSync(path.join(MIG, '20260929000028_contrato_v4_identificacion.sql'), 'utf8');

const html = (() => {
  let h = seed.split('$contrato$')[1];
  const re = /REPLACE\(\s*contenido_html,\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\s*\)/g;
  const pares = [...sql.matchAll(re)].map((m) => [m[1].replace(/''/g, "'"), m[2].replace(/''/g, "'")]);
  expect(pares).toHaveLength(5);
  for (const [viejo, nuevo] of pares) {
    expect(h).toContain(viejo);
    h = h.split(viejo).join(nuevo);
  }
  return h;
})();

const base = {
  arrendatario: { nombre_completo: 'Ana Ruiz', tipo_documento_label: 'C.E.', cedula: '998877' },
  cotitular: {},
  inmueble: { direccion: 'Cra 1 # 2-3', municipio: 'Medellín', matricula_inmobiliaria: '' },
};

describe('Contrato V4 — identificación de las partes', () => {
  it('propietario persona natural con arrendatario extranjero: sin «C.C.» ni frases vacías', () => {
    const out = renderTemplate(html, {
      ...base,
      inmobiliaria: { razon_social: 'Juan Pérez', nit: '123', direccion: 'Calle 5', cuenta_titular_nombre: 'Juan Pérez' },
    });
    expect(out).toContain('C.E.: 998877');
    expect(out).not.toContain('C.C.: 998877');
    expect(out).toContain('Juan Pérez, NIT 123, Domicilio: Calle 5.');
    expect(out).not.toContain('expedida por');
    expect(out).not.toContain('Matrícula Inmobiliaria:');
  });

  it('inmobiliaria completa: matrícula, representante y cuenta a nombre del titular', () => {
    const out = renderTemplate(html, {
      ...base,
      inmueble: { ...base.inmueble, matricula_inmobiliaria: '001-12345' },
      inmobiliaria: {
        razon_social: 'Arriendos SAS', nit: '900', direccion: 'Calle 9',
        matricula_arrendador: 'M-77', matricula_expedida_por: 'Alcaldía de Medellín',
        matricula_fecha: '15 de marzo de 2021', representante_legal: 'Luisa Gómez',
        cuenta_titular_nombre: 'Fiducia XYZ',
      },
    });
    expect(out).toContain(
      'Matrícula de Arrendador No. M-77 expedida por Alcaldía de Medellín el 15 de marzo de 2021, representada legalmente por Luisa Gómez. Domicilio: Calle 9.',
    );
    expect(out).toContain('Matrícula Inmobiliaria: 001-12345');
    expect(out).toContain('a nombre de Fiducia XYZ');
  });
});

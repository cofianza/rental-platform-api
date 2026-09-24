/**
 * Contrato V4 (la plantilla activa del flujo anterior): la migración
 * 20261001000006 sobre el HTML que hay en producción (semilla + 20260623000004 +
 * 20260624000001 + 20260929000028, idéntico byte a byte al 2026-09-24). Si
 * alguien cambia la plantilla o la migración y los REPLACE dejan de encajar,
 * esto lo dice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { renderTemplate } from '@/lib/templateEngine';

const MIG = path.resolve(__dirname, '../../../../supabase/migrations');
const leer = (f: string) => readFileSync(path.join(MIG, f), 'utf8');
const lit = (s: string) => s.replace(/''/g, "'");
const PAR = /REPLACE\(\s*contenido_html,\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\s*\)/;

/** Aplica los UPDATE … REPLACE de una migración como Postgres, respetando sus guardas. */
function aplicar(html: string, sql: string): string {
  for (const u of sql.split('UPDATE plantillas_contrato').slice(1)) {
    const m = PAR.exec(u);
    if (!m) continue;
    const guardas = [...u.matchAll(/position\('((?:[^']|'')*)' in contenido_html\) (>|=) 0/g)];
    const likes = [...u.matchAll(/contenido_html LIKE '%((?:[^']|'')*)%'/g)];
    const pasa =
      guardas.every(([, t, op]) => (op === '>') === html.includes(lit(t))) && likes.every(([, t]) => html.includes(lit(t)));
    if (pasa) html = html.split(lit(m[1])).join(lit(m[2]));
  }
  return html;
}

const vigente = ['20260623000004_firma_linea_arriba.sql', '20260624000001_firma_linea_altura.sql', '20260929000028_contrato_v4_identificacion.sql'].reduce(
  (h, f) => aplicar(h, leer(f)),
  leer('20260604000001_seed_plantilla_contrato_v4.sql').split('$contrato$')[1],
);
const MIGRACION = leer('20261001000006_contrato_v4_decisiones.sql');
const nueva = aplicar(vigente, MIGRACION);

const INMOBILIARIA = {
  inmobiliaria: { razon_social: 'Arriendos SAS', nit: '900.123.456-7', representante_legal: 'Luisa Gómez', direccion: 'Calle 9', comision_porcentaje: '8%' },
  arrendador: { es_inmobiliaria: true, tipo_documento_label: 'NIT', numero_documento: '900123456' },
};
const PROPIETARIO = {
  inmobiliaria: { razon_social: 'Juan Pérez', nit: '1020', representante_legal: '', direccion: 'Calle 5', comision_porcentaje: '' },
  arrendador: { es_inmobiliaria: false, tipo_documento_label: 'C.C.', numero_documento: '1020' },
};
const TITULOS = [
  'Imputación del pago',
  'Autorización para reportar a centrales de riesgo',
  'Tratamiento de datos personales',
  'Compra del inmueble arrendado',
  'Mérito ejecutivo',
  'Notificaciones y domicilio contractual',
  'Firma y perfeccionamiento del contrato',
  'Integralidad del acuerdo',
];
const ORDINALES = ['Primera', 'Segunda', 'Tercera', 'Cuarta', 'Quinta', 'Sexta', 'Séptima', 'Octava', 'Novena'];

describe('migración 20261001000006 sobre la plantilla V4 de producción', () => {
  it('cada REPLACE encuentra su texto y aplicarla dos veces no cambia nada', () => {
    const pares = [...MIGRACION.matchAll(new RegExp(PAR.source, 'g'))].map((m) => lit(m[1]));
    expect(pares.length).toBeGreaterThan(0);
    for (const viejo of pares) expect(vigente).toContain(viejo);
    expect(nueva).not.toBe(vigente);
    expect(aplicar(nueva, MIGRACION)).toBe(nueva);
  });

  it('P12, inmobiliaria con comisión: la cláusula 21 y la numeración de siempre', () => {
    const out = renderTemplate(nueva, INMOBILIARIA);
    expect(out).toContain('<h2>Cláusula Vigésima Primera. Comisión inmobiliaria</h2>');
    expect(out).toContain('un porcentaje equivalente al 8% más IVA sobre el canon acordado');
    TITULOS.forEach((t, i) => expect(out).toContain(`<h2>Cláusula Vigésima ${ORDINALES[i + 1]}. ${t}</h2>`));
    expect(out).toContain('Arriendos SAS, NIT 900.123.456-7, representada legalmente por Luisa Gómez. Domicilio: Calle 9.');
    expect(out).toMatch(/<strong>EL ARRENDADOR<\/strong><br>Arriendos SAS<br>NIT: 900\.123\.456-7<br>Luisa Gómez — Representante Legal<\/p>/);
  });

  it('P12, sin comisión o propietario directo: la cláusula se suprime y las siguientes se renumeran', () => {
    const out = renderTemplate(nueva, PROPIETARIO);
    expect(out).not.toContain('Comisión inmobiliaria');
    expect(out).not.toContain('más IVA sobre el canon acordado');
    TITULOS.forEach((t, i) => expect(out).toContain(`<h2>Cláusula Vigésima ${ORDINALES[i]}. ${t}</h2>`));
    expect(out).not.toContain('Vigésima Novena');
  });

  it('propietario directo: se identifica con su documento, sin NIT ni representante legal', () => {
    const out = renderTemplate(nueva, PROPIETARIO);
    expect(out).toContain('Juan Pérez, identificado(a) con C.C. 1020, Domicilio: Calle 5.');
    expect(out).toContain('<strong>EL ARRENDADOR</strong><br>Juan Pérez<br>C.C.: 1020</p>');
    // Las anclas de firma de Auco siguen encontrando la línea del arrendador.
    expect(out).toMatch(/<div class="firma-line"><\/div>\s*<p>\s*<strong>EL ARRENDADOR<\/strong>/);
  });

  it('cobertura: la fianza cubre solo el canon, sin tabla por modalidad', () => {
    const out = renderTemplate(nueva, { ...INMOBILIARIA, cob: { canones: 'Sí', servicios: 'Sí', admin_ph: 'Sí', danos: 'Sí', penal: 'Sí' } });
    expect(out).toContain('con un tope máximo de dieciocho (18) cánones de arrendamiento, lo que ocurra primero.');
    expect(out).toContain('La cobertura comprende únicamente el canon de arrendamiento. NO están cubiertas las cuotas de administración, los servicios públicos, los daños al inmueble');
    expect(out).not.toContain('Cubierto por la fianza');
    expect(out).not.toContain('Sí</td>');
    expect(out).not.toContain('Cualquier ampliación de cobertura deberá constar en el CRC');
  });

  it('P31: sin fecha de suscripción; cierre del bloque XI que remite a la cláusula de firma, con su número', () => {
    const cierre = (n: string) =>
      'El presente contrato se perfecciona con la firma de LAS PARTES. Cuando se suscriba de manera física, se firma en dos (2) ejemplares del mismo tenor y a un solo efecto, uno para cada parte. ' +
      `Cuando se suscriba mediante firma electrónica, se otorga en un único ejemplar electrónico del cual cada parte recibirá copia, en los términos de la Cláusula ${n}.`;
    const conComision = renderTemplate(nueva, INMOBILIARIA);
    expect(conComision).toContain(cierre('Vigésima Octava'));
    expect(conComision).toContain('<h2>Cláusula Vigésima Octava. Firma y perfeccionamiento del contrato</h2>');
    const sinComision = renderTemplate(nueva, PROPIETARIO);
    expect(sinComision).toContain(cierre('Vigésima Séptima'));
    expect(sinComision).toContain('<h2>Cláusula Vigésima Séptima. Firma y perfeccionamiento del contrato</h2>');
    expect(nueva).not.toContain('fecha_firma');
    expect(nueva).not.toContain('En señal de conformidad');
  });
});

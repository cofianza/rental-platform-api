import { describe, it, expect, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import { anclarFirmas, pieTexto } from '../documento';
import { verificarSinMarcadores, type Resultado } from '../motor';
import { PLANTILLA_ANEXO, PLANTILLA_VIVIENDA } from '../plantilla-vivienda';
import { renderizarAnexo, type DatosVivienda, type Persona } from '../vivienda';

// vivienda.ts → documento.ts → pdfRenderer → logger → env, que exige las variables de entorno
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ============================================================
// Anexo de Condiciones de Afianzamiento (Entrega 5 §4.4): lo que firman las
// partes en la Ruta B. La fidelidad contra el Word la cubre fidelidad.test.ts;
// aquí van las variantes: con coarrendatario y C.C. sale en modo final en las
// dos modalidades; sin coarrendatario o con otro documento quedan borradores
// sin aprobar (a-c-*, a-j-*) y el modo final se bloquea. COFIANZA no firma.
// ============================================================

const persona = (
  nombre: string,
  numeroDocumento: string,
  email: string,
  tipoDocumento: Persona['tipoDocumento'] = 'cc',
): Persona => ({
  tipoPersona: 'natural',
  nombre,
  tipoDocumento,
  numeroDocumento,
  email,
  telefono: '3001234567',
  direccion: 'Calle 10 # 20-30',
  municipio: 'Medellín',
});

const ARRENDADOR: Persona = {
  ...persona(
    'INMOBILIARIA EJEMPLO S.A.S.',
    '900123456',
    'contratos@inmobiliaria-ejemplo.co',
    'nit',
  ),
  tipoPersona: 'juridica',
  digitoVerificacion: '7',
  representanteLegalNombre: 'Ana María Gómez Restrepo',
  matriculaNumero: 'MA-2019-0456',
  matriculaExpedidaPor: 'Alcaldía de Medellín',
};
const ARRENDATARIO = persona('Juan Carlos Pérez Mejía', '1020304050', 'juan.perez@correo.co');
const COARRENDATARIO = persona('María Fernanda López Arango', '43123456', 'maria.lopez@correo.co');

/** En la Ruta B el contrato lo pone EL ARRENDADOR: el Anexo solo lee estos datos. */
function datos(o: { coa?: boolean; trasladada?: boolean } = {}): DatosVivienda {
  return {
    numero: 'CTO-2026-0001',
    ciudadFirma: 'Medellín',
    fechaDocumento: '2026-09-21',
    arrendador: ARRENDADOR,
    arrendatario: ARRENDATARIO,
    coarrendatarios: o.coa === false ? [] : [COARRENDATARIO],
    inmueble: {
      direccion: 'Carrera 43A # 1-50, apartamento 1201',
      municipio: 'Medellín',
      propiedadHorizontal: false,
      usos: { carro: null, moto: null, util: null },
    },
    canonCop: 2_500_000,
    vigenciaMeses: 12,
    fechaInicio: '2026-10-01',
    cuenta: {
      tipo: 'de ahorros',
      numero: '123-456789-01',
      banco: 'Bancolombia',
      titular: 'INMOBILIARIA EJEMPLO S.A.S.',
      nit: '900.123.456-7',
    },
    modalidad: o.trasladada === false ? 'tradicional' : 'trasladada',
    crc: { numero: 'CRC-2026-0042', fecha: '2026-09-15' },
    primaPct: 10,
    tarifaPct: 2.5,
    cashbackPct: 30,
    comisionPct: 0,
    administracion: null,
  };
}

const revision = (d: DatosVivienda) =>
  renderizarAnexo(d, { modo: 'revision', logoInmobiliaria: null });
const final = (d: DatosVivienda) => () =>
  renderizarAnexo(d, { modo: 'final', logoInmobiliaria: null });

/** errorCode y details del AppError que lanza fn; undefined si no lanza. */
function falla(fn: () => unknown): { code: string; details: unknown } | undefined {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { code: e.errorCode, details: e.details };
  }
  return undefined;
}

const ids = (r: { pendientes: { id: string }[] }) => r.pendientes.map((p) => p.id).sort();
const pendientesDe = (e: ReturnType<typeof falla>) =>
  (e!.details as { pendientes: { id: string; tipo: string }[] }).pendientes;
const textos = (r: Resultado) => r.lineas.map((l) => l.texto);
const deKind = (r: Resultado, kind: string) => r.lineas.filter((l) => l.kind === kind);

// Las 11 redacciones en singular sin coarrendatario (spec §2.4): el Anexo no
// las trae en el Word, así que son borradores hasta que Gerencia las apruebe.
const A_C_IDS = Array.from({ length: 11 }, (_, k) => `a-c-${String(k + 1).padStart(2, '0')}`);
// "C.C." está fijo en el Word (cuadro y firmas) para arrendatario y coarrendatario.
const A_J_IDS = [
  'a-j-cuadro-arrendatario',
  'a-j-cuadro-coa',
  'a-j-firma-arrendatario',
  'a-j-firma-coa',
].sort();

describe('modo final con coarrendatario y C.C.', () => {
  it.each([
    ['Trasladada', true],
    ['Tradicional', false],
  ])('%s sale sin pendientes ni marcadores', (_nombre, trasladada) => {
    const r = renderizarAnexo(datos({ trasladada }), {
      modo: 'final',
      logoInmobiliaria: null,
    });
    expect(r.pendientes).toEqual([]);
    expect(r.html).not.toMatch(/class="pendiente"/);
    expect(() => verificarSinMarcadores(r.lineas, { sinCoarrendatario: false })).not.toThrow();
  });

  it('la casilla marcada es la de la modalidad, y solo una', () => {
    const casilla = (d: DatosVivienda) =>
      revision(d).html.match(/<span class="casilla">X?<\/span>/g);
    expect(casilla(datos())).toEqual([
      '<span class="casilla"></span>',
      '<span class="casilla">X</span>',
    ]);
    expect(casilla(datos({ trasladada: false }))).toEqual([
      '<span class="casilla">X</span>',
      '<span class="casilla"></span>',
    ]);
  });
});

describe('el cuadro inicial', () => {
  const celdas = textos(revision(datos())).slice(3, 29);

  it('trae el CRC, el contrato asociado (CTO) y la vigencia en dd/mm/aaaa', () => {
    expect(celdas).toContain('CRC-2026-0042 del 15 de septiembre de 2026');
    expect(celdas).toContain('CTO-2026-0001');
    expect(celdas).toContain('doce ( 12 ) meses, del 01/10/2026 al 01/10/2027');
  });

  it('identifica a las partes con su documento', () => {
    expect(celdas).toContain('INMOBILIARIA EJEMPLO S.A.S. · NIT 900.123.456-7');
    expect(celdas).toContain('Juan Carlos Pérez Mejía · C.C. 1020304050');
    expect(celdas).toContain('María Fernanda López Arango · C.C. 43123456');
  });

  it('sin coarrendatario la fila desaparece, sin dejar rastro ni pedir aprobación', () => {
    const sin = textos(revision(datos({ coa: false })));
    expect(sin.filter((t) => /coarrendatari/i.test(t))).toEqual([]);
    expect(ids(revision(datos({ coa: false })))).toEqual(A_C_IDS);
  });
});

describe('las cláusulas se numeran y se remiten solas', () => {
  const r = revision(datos());

  it('son treinta, de PRIMERA a TRIGÉSIMA', () => {
    const cabeceras = textos(r)
      .map((t) => /^\*\*([A-ZÁÉÍÓÚ ]+): /.exec(t)?.[1])
      .filter(Boolean);
    expect(cabeceras).toHaveLength(30);
    expect(cabeceras[0]).toBe('PRIMERA');
    expect(cabeceras.at(-1)).toBe('TRIGÉSIMA');
  });

  it('las tres remisiones del Word salen del número impreso', () => {
    expect(r.refs.map((x) => [x.origen, x.destino, x.texto])).toEqual([
      ['no-escritas', 'imputacion', 'Cláusula Décima'],
      ['prorrogas', 'valores', 'Cláusula Novena'],
      ['cashback', 'imputacion/faltantes', 'Parágrafo de la Cláusula Décima'],
    ]);
  });
});

describe('sin coarrendatario', () => {
  it('el modo final se bloquea con los a-c-* sin aprobar', () => {
    const e = falla(final(datos({ coa: false })));
    expect(e?.code).toBe('PLANTILLA_TEXTO_PENDIENTE');
    expect(
      pendientesDe(e)
        .map((p) => p.id)
        .sort(),
    ).toEqual(A_C_IDS);
    expect(new Set(pendientesDe(e).map((p) => p.tipo))).toEqual(new Set(['borrador']));
  });

  it('en revisión el singular se resalta y no queda mención al coarrendatario', () => {
    const r = revision(datos({ coa: false }));
    expect(r.html).toMatch(/class="pendiente"/);
    expect(textos(r).join('\n')).not.toMatch(/coarrendatari/i);
    expect(() => verificarSinMarcadores(r.lineas, { sinCoarrendatario: true })).not.toThrow();
  });
});

describe('documento distinto de C.C.', () => {
  const ce = (p: Persona) => ({ ...p, tipoDocumento: 'ce' as const });
  const d = { ...datos(), arrendatario: ce(ARRENDATARIO), coarrendatarios: [ce(COARRENDATARIO)] };

  it('deja pendientes los a-j-* del cuadro y de las firmas, y no pasa a final', () => {
    expect(ids(revision(d))).toEqual(A_J_IDS);
    expect(falla(final(d))?.code).toBe('PLANTILLA_TEXTO_PENDIENTE');
  });

  it('imprime el tipo real de documento', () => {
    expect(textos(revision(d))).toContain('Juan Carlos Pérez Mejía · C.E. 1020304050');
  });
});

describe('firmas: arrendatario, coarrendatario y arrendador, sin COFIANZA', () => {
  it('son tres bloques con coarrendatario y dos sin él', () => {
    expect(deKind(revision(datos()), 'firma').map((l) => l.texto)).toEqual([
      '**EL ARRENDATARIO** Juan Carlos Pérez Mejía C.C. N° 1020304050',
      '**EL COARRENDATARIO** María Fernanda López Arango C.C. N° 43123456',
      '**EL ARRENDADOR** Ana María Gómez Restrepo Representante Legal NIT 900.123.456-7',
    ]);
    expect(deKind(revision(datos({ coa: false })), 'firma')).toHaveLength(2);
  });

  it('las anclas de Auco caen una por bloque, en el orden de firma', () => {
    // cada bloque se lleva su ancla, y el índice es el de contrato_partes.orden
    expect(
      anclarFirmas(revision(datos()).html, 3)
        .split('<p class="k-firma"')
        .slice(1)
        .map((b) => /\{\{signature:(\d)\}\}[\s\S]*?<b>(EL [A-ZÁ]+)<\/b>/.exec(b)?.slice(1)),
    ).toEqual([
      ['0', 'EL ARRENDATARIO'],
      ['1', 'EL COARRENDATARIO'],
      ['2', 'EL ARRENDADOR'],
    ]);
    expect(() => anclarFirmas(revision(datos({ coa: false })).html, 3)).toThrow(AppError);
  });
});

describe('el pie', () => {
  it('lleva el CRC y no lleva número de contrato ni iniciales', () => {
    expect(pieTexto(PLANTILLA_ANEXO.pie, 'fidelidad', { rotulo: 'CRC N°', iniciales: false })).toBe(
      'Anexo de Condiciones de Afianzamiento COFIANZA · CRC N° ▢ Página ▢ de ▢',
    );
  });

  it('el del contrato de vivienda no cambia', () => {
    expect(pieTexto(PLANTILLA_VIVIENDA.pie, 'fidelidad')).toBe(
      'Contrato de arrendamiento de vivienda urbana · N° ▢ · Iniciales: ▢ Página ▢ de ▢',
    );
  });
});

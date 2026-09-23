import { describe, it, expect, vi } from 'vitest';

// reglas → portabilidad → tope-canon.guard → supabase/env/calibracion: se
// mockean para no exigir variables de entorno. calibracion queda REAL (sus
// defaults son los que rigen el asistente).
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/config/env', () => ({ env: { CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));
vi.mock('@/config', () => ({ env: { CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));

import { CALIBRACION_DEFAULT, type Calibracion } from '@/lib/calibracion';
import type { Tarifas } from '@/modules/estudios/tarifas';
import {
  armarDatosVivienda,
  avisoCanon,
  avisosDePendientes,
  evaluarBloqueos,
  evaluarCanon,
  faltantes,
  maximoSinNuevaEvaluacionCop,
  noImprimibles,
  partirNit,
  prefill,
  type AsistenteCompleto,
  type Fuentes,
  type PerfilArrendador,
} from '../asistente.reglas';
import { paso1Schema, paso2Schema, paso3Schema, paso5Schema } from '../asistente.schema';
import type { Bloqueo, Contacto } from '../asistente.types';
import { renderizarVivienda } from '../vivienda';

// ============================================================
// Reglas puras del asistente V3 (diseño §5.2-§5.5, pruebas §7 1-13): bloqueos,
// canon pactado, prefill/faltantes, imprimibles, avisos, el armado de
// DatosVivienda contra la plantilla real (sin Chromium) y el schema de pasos.
// ============================================================

const HOY = '2026-09-15';
const EXP = 'exp-1';
const cal: Calibracion = { ...CALIBRACION_DEFAULT };

const TARIFAS: Tarifas = {
  via: 'condicionada_coarrendatario',
  con_coarrendatario: true,
  tarifa_mensual_pct: 2.5,
  tarifa_mensual_cop: 50_000,
  iva_pct: 19,
  tarifa_mensual_con_iva_cop: 59_500,
  prima_vinculacion_pct: 10,
  prima_vinculacion_cop: 200_000,
  cashback_pct: 30,
  negociada: false,
  override: null,
};

const PERFIL: PerfilArrendador = {
  razon_social: 'INMOBILIARIA EJEMPLO S.A.S.',
  nit: '900.123.456-8',
  representante_legal: 'Ana María Gómez Restrepo',
  representante_legal_tipo_documento: 'cc',
  representante_legal_documento: '43987654',
  matricula_arrendador: 'MA-2019-0456',
  matricula_expedida_por: 'Alcaldía de Medellín',
  domicilio_direccion: 'Calle 50 # 40-20, oficina 301',
  domicilio_ciudad: 'Medellín',
  email_recaudo: 'contratos@inmobiliaria-ejemplo.co',
  whatsapp_recaudo: '+573001112233',
  logo_storage_key: null,
  cuenta_recaudo_banco: 'Bancolombia',
  cuenta_recaudo_tipo: 'ahorros',
  cuenta_recaudo_numero: '123-456789-01',
  cuenta_recaudo_titular_nombre: 'INMOBILIARIA EJEMPLO S.A.S.',
  // Sin puntos a propósito: así "900.123.456-8" en el PDF solo puede ser el NIT del arrendador.
  cuenta_recaudo_titular_nit: '900123456-8',
};

const COA: NonNullable<Fuentes['coarrendatario']> = {
  id: 'coa-1',
  nombre: 'María Fernanda',
  apellido: 'López Arango',
  tipo_documento: 'cc',
  numero_documento: '43123456',
  email: 'maria.lopez@correo.co',
  telefono: '3007654321',
  estado: 'estudio_completado',
  estudio_id: 'est-coa',
  direccion: null,
  municipio: null,
  estudio: { estado: 'completado', resultado: 'aprobado' },
};

function fuentes(o: Partial<Fuentes> = {}): Fuentes {
  return {
    expediente: {
      id: EXP,
      numero: 'EXP-2026-0100',
      estado: 'aprobado',
      duracion_contrato_meses: null,
      fecha_inicio_contrato: null,
    },
    inmueble: {
      id: 'inm-1',
      codigo: 'INM-001',
      direccion: 'Carrera 43A # 1-50, apartamento 1201',
      ciudad: 'Medellín',
      uso: 'vivienda',
      estado: 'disponible',
      reservado_por_expediente_id: null,
      inmobiliaria_id: 'org-1',
      valorArriendoCop: 2_000_000,
      propiedad_horizontal: true,
      parqueadero: true,
      cuarto_util: false,
      nombre_copropiedad: null,
      parqueadero_numero: null,
      parqueadero_moto: null,
      parqueadero_moto_numero: null,
      cuarto_util_numero: null,
      administracionCop: null,
    },
    solicitante: {
      nombre: 'Juan Carlos',
      apellido: 'Pérez Mejía',
      tipo_documento: 'cc',
      numero_documento: '1020304050',
      tipo_persona: 'natural',
      email: 'juan.perez@correo.co',
      telefono: '3001234567',
      direccion: 'Calle 10 # 20-30',
      ciudad: 'Medellín',
    },
    estudio: {
      id: 'est-1',
      resultado: 'aprobado',
      fecha_completado: '2026-09-01T15:00:00Z',
      canonEvaluadoCop: 2_000_000,
    },
    crc: {
      id: 'crc-1',
      codigo: 'CRC-2026-0042',
      version: 1,
      fecha_emision: '2026-09-01T16:00:00Z',
      fecha_vencimiento: '2026-10-31T16:00:00Z',
      pdf_storage_key: 'certificados/est-1.pdf',
    },
    tarifas: TARIFAS,
    ingresoAjustadoCop: null,
    coarrendatario: COA,
    arrendador: PERFIL,
    modalidadFianzaDefecto: null,
    completitudFaltantes: [],
    legacyVivos: 0,
    v3: null,
    ...o,
  };
}

const contacto = (email: string): Contacto => ({
  direccion: 'Calle 10 # 20-30',
  municipio: 'Medellín',
  email,
  telefono: '3001234567',
});

/** Co-tenant + PH + Trasladada, todo C.C. */
const PASOS: AsistenteCompleto = {
  paso1: { ruta: 'A', modalidad: 'trasladada', canonCop: 2_000_000 },
  paso2: {
    usos: { carro: '12', moto: null, util: null },
    amoblado: false,
    ocupantes: 3,
    propiedadHorizontal: true,
    nombreCopropiedad: 'Edificio Torres del Parque',
  },
  paso3: {
    vigenciaMeses: 12,
    fechaInicio: '2026-10-01',
    fechaEntrega: '2026-10-01',
    comisionPct: 8,
    administracion: { aCargoDe: 'arrendatario', valorCop: 350_000, incluidaEnCanon: false },
  },
  paso4: { omitir: true },
  paso5: {
    ciudadFirma: 'Medellín',
    contactos: {
      arrendador: contacto('contratos@inmobiliaria-ejemplo.co'),
      arrendatario: contacto('juan.perez@correo.co'),
      coarrendatario: contacto('maria.lopez@correo.co'),
    },
  },
};

/** Sin coarrendatario + sin PH + Tradicional. */
const PASOS_SOLO: AsistenteCompleto = {
  ...PASOS,
  paso1: { ...PASOS.paso1, modalidad: 'tradicional' },
  paso2: { ...PASOS.paso2, propiedadHorizontal: false, nombreCopropiedad: null },
  paso3: { ...PASOS.paso3, administracion: null },
  paso5: { ...PASOS.paso5, contactos: { ...PASOS.paso5.contactos, coarrendatario: null } },
};
const SOLO: Partial<Fuentes> = {
  coarrendatario: null,
  tarifas: { ...TARIFAS, via: 'automatica', con_coarrendatario: false, prima_vinculacion_pct: 20, tarifa_mensual_pct: 2 },
};

const codigos = (bs: Bloqueo[]) => bs.map((b) => b.codigo);
const bloqueos = (o: Partial<Fuentes>, hoy = HOY, c = cal) => evaluarBloqueos(fuentes(o), hoy, c);

describe('evaluarBloqueos — caso limpio', () => {
  it('el fixture base no tiene bloqueos', () => {
    expect(bloqueos({})).toEqual([]);
  });
});

// 1. B1
describe('B1 — vigencia de la evaluación (A4)', () => {
  const est = (fecha_completado: string | null) => ({
    estudio: { id: 'est-1', resultado: 'aprobado', fecha_completado, canonEvaluadoCop: 2_000_000 },
  });

  it('completada 2026-07-23 (Bogotá): el día 60 pasa, el 61 bloquea', () => {
    expect(codigos(bloqueos(est('2026-07-23T12:00:00-05:00'), '2026-09-21'))).not.toContain('ESTUDIO_VENCIDO');
    const b = bloqueos(est('2026-07-23T12:00:00-05:00'), '2026-09-22');
    expect(codigos(b)).toContain('ESTUDIO_VENCIDO');
    expect(b.find((x) => x.codigo === 'ESTUDIO_VENCIDO')!.mensaje).toBe(
      'La evaluación se completó el 23/07/2026 y ya tiene más de 60 días calendario. Se requiere nueva evaluación.',
    );
  });

  it('sin fecha de completado bloquea (fail-closed)', () => {
    const b = bloqueos(est(null));
    expect(b.find((x) => x.codigo === 'ESTUDIO_VENCIDO')!.mensaje).toBe(
      'La evaluación no tiene fecha de completado y no se puede verificar su vigencia. Se requiere nueva evaluación.',
    );
  });

  it('2026-07-24T00:30Z es 19:30 del 23 en Bogotá: cuenta como el 23', () => {
    expect(codigos(bloqueos(est('2026-07-24T00:30:00Z'), '2026-09-21'))).not.toContain('ESTUDIO_VENCIDO');
    expect(codigos(bloqueos(est('2026-07-24T00:30:00Z'), '2026-09-22'))).toContain('ESTUDIO_VENCIDO');
  });
});

// 2. B2
describe('evaluarCanon — canon pactado (B2)', () => {
  const f = (ev: number, ingreso: number | null = null) =>
    fuentes({
      estudio: { id: 'est-1', resultado: 'aprobado', fecha_completado: '2026-09-01T15:00:00Z', canonEvaluadoCop: ev },
      ingresoAjustadoCop: ingreso,
    });

  it('igual al evaluado pasa aunque la relación canon/ingreso sea del 60 %', () => {
    const v = evaluarCanon(f(2_000_000, 3_333_334), 2_000_000, cal)!;
    expect(v.bloqueo).toBeNull();
    expect(v.veredicto).toBe('igual_o_menor');
    expect(v.canonIngreso).toBeNull();
  });

  it('menor o igual al evaluado pasa aunque supere el tope', () => {
    const v = evaluarCanon(f(2_000_000), 1_900_000, { ...cal, CANON_MAX_TRANSITORIO: 1_500_000 })!;
    expect(v.bloqueo).toBeNull();
    expect(v.veredicto).toBe('igual_o_menor');
  });

  it('+15 % exacto (2.300.000) pasa; un peso más, CANON_FUERA_DE_TOLERANCIA', () => {
    const ok = evaluarCanon(f(2_000_000), 2_300_000, cal)!;
    expect(ok.bloqueo).toBeNull();
    expect(ok.veredicto).toBe('dentro_tolerancia');

    const mal = evaluarCanon(f(2_000_000), 2_300_001, cal)!;
    expect(mal.bloqueo).toMatchObject({ codigo: 'CANON_FUERA_DE_TOLERANCIA', paso: 1 });
    expect(mal.bloqueo!.mensaje).toContain('el máximo sin nueva evaluación es');
  });

  it('dentro de la tolerancia pero canon/ingreso 40,004 % → CANON_INGRESO_EXCEDE', () => {
    const v = evaluarCanon(f(1_900_000, 5_000_000), 2_000_200, cal)!;
    expect(v.bloqueo).toMatchObject({ codigo: 'CANON_INGRESO_EXCEDE', paso: 1 });
    expect(v.bloqueo!.mensaje).toContain('40,004 %');
    expect(v.canonIngresoPct).toBeCloseTo(40.004, 6);
  });

  it('sin ingreso pasa con canonIngreso no_evaluable', () => {
    const v = evaluarCanon(f(2_000_000, null), 2_100_000, cal)!;
    expect(v.bloqueo).toBeNull();
    expect(v.veredicto).toBe('dentro_tolerancia');
    expect(v.canonIngreso).toBe('no_evaluable');
  });

  it('evaluado 2.900.000 y pactado 3.100.000 → CANON_EXCEDE_TOPE (el tope va primero)', () => {
    const v = evaluarCanon(f(2_900_000), 3_100_000, cal)!;
    expect(v.bloqueo).toMatchObject({ codigo: 'CANON_EXCEDE_TOPE', paso: 1 });
  });

  it('máximo sin nueva evaluación = 2.300.000 sobre 2.000.000', () => {
    expect(maximoSinNuevaEvaluacionCop(f(2_000_000), cal)).toBe(2_300_000);
  });

  it('el aviso previo al paso 1 cambia la última frase', () => {
    const b = evaluarCanon(f(2_000_000), 2_300_001, cal)!.bloqueo!;
    const aviso = avisoCanon(b);
    expect(aviso).not.toContain('Se requiere nueva evaluación.');
    expect(aviso.endsWith('Puedes pactar un canon menor en el paso 1; si no, se requerirá nueva evaluación.')).toBe(true);
  });
});

// 3. B2a
describe('B2a — sin canon evaluado', () => {
  it('bloquea con CANON_SIN_EVALUADO', () => {
    const b = bloqueos({
      estudio: { id: 'est-1', resultado: 'aprobado', fecha_completado: '2026-09-01T15:00:00Z', canonEvaluadoCop: null },
    });
    expect(codigos(b)).toEqual(['CANON_SIN_EVALUADO']);
  });
});

// 4. B4
describe('B4 — estado del inmueble', () => {
  const inm = (estado: string, reservado_por_expediente_id: string | null) => ({
    inmueble: { ...fuentes().inmueble, estado, reservado_por_expediente_id },
  });

  it('ocupado por este mismo estudio pasa', () => {
    expect(bloqueos(inm('ocupado', EXP))).toEqual([]);
  });

  it('ocupado por otro, o sin titular, bloquea con INMUEBLE_OCUPADO', () => {
    expect(codigos(bloqueos(inm('ocupado', 'exp-otro')))).toEqual(['INMUEBLE_OCUPADO']);
    expect(codigos(bloqueos(inm('ocupado', null)))).toEqual(['INMUEBLE_OCUPADO']);
  });

  it('inactivo bloquea con INMUEBLE_INACTIVO y lleva al inmueble', () => {
    expect(bloqueos(inm('inactivo', null))).toEqual([
      expect.objectContaining({ codigo: 'INMUEBLE_INACTIVO', accion: 'inmueble' }),
    ]);
  });
});

// 5. partirNit
describe('partirNit', () => {
  it('separa el número y el DV válido', () => {
    expect(partirNit('900.123.456-8')).toEqual({ numero: '900123456', dv: '8' });
  });
  it('sin DV o con DV inválido → null', () => {
    expect(partirNit('900123456')).toBeNull();
    expect(partirNit('900123456-7')).toBeNull();
    expect(partirNit(null)).toBeNull();
  });
});

// 6. G3
describe('G3 — partes admitidas', () => {
  const sol = (o: Partial<Fuentes['solicitante']>) => ({ solicitante: { ...fuentes().solicitante, ...o } });

  it('arrendatario con T.I., NIT o persona jurídica → ARRENDATARIO_NO_ADMITIDO', () => {
    expect(codigos(bloqueos(sol({ tipo_documento: 'ti' })))).toEqual(['ARRENDATARIO_NO_ADMITIDO']);
    expect(codigos(bloqueos(sol({ tipo_documento: 'nit' })))).toEqual(['ARRENDATARIO_NO_ADMITIDO']);
    expect(codigos(bloqueos(sol({ tipo_persona: 'juridica' })))).toEqual(['ARRENDATARIO_NO_ADMITIDO']);
  });

  it('coarrendatario aceptado sin estudio → COARRENDATARIO_SIN_EVALUAR', () => {
    const b = bloqueos({ coarrendatario: { ...COA, estado: 'aceptado', estudio_id: null, estudio: null } });
    expect(codigos(b)).toEqual(['COARRENDATARIO_SIN_EVALUAR']);
  });

  it('coarrendatario con evaluación rechazada → COARRENDATARIO_RECHAZADO', () => {
    const b = bloqueos({ coarrendatario: { ...COA, estudio: { estado: 'completado', resultado: 'rechazado' } } });
    expect(codigos(b)).toEqual(['COARRENDATARIO_RECHAZADO']);
  });

  it('coarrendatario con el mismo documento del arrendatario → COARRENDATARIO_NO_ADMITIDO', () => {
    const b = bloqueos({ coarrendatario: { ...COA, tipo_documento: 'cc', numero_documento: '1.020.304.050' } });
    expect(codigos(b)).toEqual(['COARRENDATARIO_NO_ADMITIDO']);
  });
});

// 7. G4 y G2b
describe('G4 / G2b — tarifa imprimible y CRC al día', () => {
  it('cashback 25 → TARIFA_NO_SOPORTADA', () => {
    const b = bloqueos({ tarifas: { ...TARIFAS, cashback_pct: 25, negociada: true } });
    expect(b).toEqual([expect.objectContaining({ codigo: 'TARIFA_NO_SOPORTADA' })]);
    expect(b[0].mensaje).toContain('cashback de 25 %');
  });

  it('prima 2,555 % → TARIFA_NO_SOPORTADA (más de dos decimales)', () => {
    const b = bloqueos({ tarifas: { ...TARIFAS, prima_vinculacion_pct: 2.555 } });
    expect(b).toEqual([
      expect.objectContaining({
        codigo: 'TARIFA_NO_SOPORTADA',
        mensaje: 'La tarifa tiene porcentajes con más de dos decimales; el contrato no los puede imprimir. Escríbenos para revisarla.',
      }),
    ]);
  });

  const override = (autorizado_en: string) => ({
    tarifas: {
      ...TARIFAS,
      negociada: true,
      tarifa_mensual_pct: 2.2,
      override: { tarifa_mensual_pct: 2.2, autorizado_por: 'gerencia', autorizado_en },
    },
  });

  it('override autorizado DESPUÉS de emitir el CRC → CRC_DESACTUALIZADO', () => {
    expect(bloqueos(override('2026-09-02T10:00:00Z'))).toEqual([
      expect.objectContaining({ codigo: 'CRC_DESACTUALIZADO', accion: 'estudio' }),
    ]);
  });

  it('override anterior al CRC, o sin override, no bloquea', () => {
    expect(bloqueos(override('2026-09-01T10:00:00Z'))).toEqual([]);
    expect(bloqueos({ tarifas: { ...TARIFAS, override: null } })).toEqual([]);
  });
});

// 8. G1
describe('G1 — perfil del arrendador', () => {
  it('detalle lleva los faltantes de completitud y los tres propios del V3', () => {
    const b = bloqueos({
      arrendador: {
        ...PERFIL,
        matricula_expedida_por: null,
        nit: '900123456',
        representante_legal_documento: null,
      },
      completitudFaltantes: ['Razón social'],
    });
    expect(b).toEqual([
      expect.objectContaining({
        codigo: 'PERFIL_ARRENDADOR_INCOMPLETO',
        accion: 'datos_contrato',
        detalle: [
          'Razón social',
          'Matrícula expedida por',
          'NIT con dígito de verificación válido (ej. 900.123.456-8)',
          'Tipo y número de documento del representante legal',
        ],
      }),
    ]);
  });

  it('bloquea antes de generar si la matrícula no cabe en contrato_partes (40)', () => {
    const b = bloqueos({ arrendador: { ...PERFIL, matricula_arrendador: 'M'.repeat(41) } });
    expect(b).toEqual([
      expect.objectContaining({
        codigo: 'PERFIL_ARRENDADOR_INCOMPLETO',
        detalle: ['Matrícula de arrendador (máximo 40 caracteres)'],
      }),
    ]);
    expect(bloqueos({ arrendador: { ...PERFIL, matricula_arrendador: 'M'.repeat(40) } })).toEqual([]);
  });
});

// 9. armarDatosVivienda → plantilla real
describe('armarDatosVivienda → renderizarVivienda (revisión, sin Chromium)', () => {
  const render = (f: Fuentes, a: AsistenteCompleto) =>
    renderizarVivienda(armarDatosVivienda(f, a, HOY, 'CTO-2026-0007'), { modo: 'revision', logoInmobiliaria: null });

  it('coarrendatario + PH + Trasladada, todo C.C., fechado el 15 → sin pendientes', () => {
    expect(render(fuentes(), PASOS).pendientes).toEqual([]);
  });

  it('sin coarrendatario + sin PH + Tradicional → pendientes b, d y c-*', () => {
    const ids = render(fuentes(SOLO), PASOS_SOLO).pendientes.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['b', 'd']));
    expect(ids.some((i) => i.startsWith('c-'))).toBe(true);
  });

  it('la cuenta sale "de ahorros" y el NIT con su DV una sola vez', () => {
    const { html } = render(fuentes(), PASOS);
    expect(html).toContain('de ahorros');
    expect(html).toContain('900.123.456-8');
    expect(html).not.toContain('900.123.456-8-8');
    expect(html).not.toContain('9.001.234.568');
  });

  it('las partes salen de las fuentes y el paso 5', () => {
    const d = armarDatosVivienda(fuentes(), PASOS, HOY, 'CTO-2026-0007');
    expect(d.arrendador).toMatchObject({ numeroDocumento: '900123456', digitoVerificacion: '8', tipoDocumento: 'nit' });
    expect(d.arrendatario.nombre).toBe('Juan Carlos Pérez Mejía');
    expect(d.coarrendatarios).toHaveLength(1);
    expect(d.crc).toEqual({ numero: 'CRC-2026-0042', fecha: '2026-09-01' });
    expect(d.fechaDocumento).toBe(HOY);
  });
});

// 10. noImprimibles
describe('noImprimibles', () => {
  it('el fixture limpio no tiene nada que marcar', () => {
    expect(noImprimibles(armarDatosVivienda(fuentes(), PASOS, HOY, 'CTO-2026-0007'))).toEqual([]);
  });

  it('marca "XXX" en un nombre', () => {
    const f = fuentes({ solicitante: { ...fuentes().solicitante, nombre: 'Juan XXX' } });
    expect(noImprimibles(armarDatosVivienda(f, PASOS, HOY, 'CTO-2026-0007'))).toEqual(['arrendatario.nombre']);
  });

  it('marca "coarrendatario" en una dirección cuando no hay coarrendatario', () => {
    const f = fuentes({ ...SOLO, inmueble: { ...fuentes().inmueble, direccion: 'Casa del coarrendatario' } });
    expect(noImprimibles(armarDatosVivienda(f, PASOS_SOLO, HOY, 'CTO-2026-0007'))).toEqual(['inmueble.direccion']);
  });
});

// 11. faltantes
describe('faltantes', () => {
  it('completo → nada', () => {
    expect(faltantes(PASOS, fuentes(), HOY)).toEqual([]);
  });

  it('cada paso sin guardar', () => {
    expect(faltantes({}, fuentes(), HOY)).toEqual(
      [1, 2, 3, 4, 5].map((paso) => ({ paso, mensaje: 'Falta guardar este paso.' })),
    );
  });

  it('PH sin administración → paso 3', () => {
    expect(faltantes({ ...PASOS, paso3: { ...PASOS.paso3, administracion: null } }, fuentes(), HOY)).toEqual([
      { paso: 3, mensaje: 'Con propiedad horizontal completa la cuota de administración; sin ella, quítala.' },
    ]);
  });

  it('coarrendatario sin contacto → paso 5', () => {
    const a = { ...PASOS, paso5: { ...PASOS.paso5, contactos: { ...PASOS.paso5.contactos, coarrendatario: null } } };
    expect(faltantes(a, fuentes(), HOY)).toEqual([
      { paso: 5, mensaje: 'Revisa los datos de notificación del coarrendatario.' },
    ]);
  });

  it('fecha de iniciación de ayer → paso 3', () => {
    const a = { ...PASOS, paso3: { ...PASOS.paso3, fechaInicio: '2026-09-14' } };
    expect(faltantes(a, fuentes(), HOY)).toEqual([
      { paso: 3, mensaje: 'La fecha de iniciación o de entrega ya pasó; actualízala.' },
    ]);
  });
});

// 12. avisosDePendientes
describe('avisosDePendientes', () => {
  const CIERRE = 'Mientras haya textos pendientes, el contrato no se puede enviar a firma.';
  const avisos = (...ids: string[]) => avisosDePendientes(ids.map((id) => ({ id })));

  it('sin pendientes no hay avisos', () => {
    expect(avisos()).toEqual([]);
  });

  it('un aviso por prefijo, más el cierre', () => {
    expect(avisos('b')).toEqual(['Modalidad Tradicional: el texto de la cláusula CUARTA está pendiente de Gerencia.', CIERRE]);
    expect(avisos('d')).toEqual([
      'Inmueble sin propiedad horizontal: el texto de la cláusula de administración está pendiente de Gerencia.',
      CIERRE,
    ]);
    expect(avisos('c-01', 'c-02', 'c-07')).toEqual([
      'Sin coarrendatario: 3 ajustes de redacción en singular pendientes de aprobación.',
      CIERRE,
    ]);
    expect(avisos('j-arrendatario', 'j-coa')).toEqual([
      'Documento distinto de cédula de ciudadanía: su mención en las firmas está pendiente de aprobación.',
      CIERRE,
    ]);
    expect(avisos('k-dia1')).toEqual([
      'Documento fechado el día 1.º: esa redacción está pendiente; generarlo otro día la resuelve.',
      CIERRE,
    ]);
  });
});

// 13. Schema
describe('schema de los pasos', () => {
  const p5 = (direccion: string) => ({ ...PASOS.paso5, contactos: { ...PASOS.paso5.contactos, arrendador: { ...contacto('a@b.co'), direccion } } });

  it.each(['Calle XXX', 'Calle ___', 'Calle {a}', 'NO APLICA', 'null', 'Casa del coarrendatario', 'Calle\u00071', 'x'.repeat(301)])(
    'rechaza texto no imprimible: %j',
    (direccion) => {
      expect(paso5Schema.safeParse(p5(direccion)).success).toBe(false);
    },
  );

  it('acepta el paso 5 limpio y normaliza el celular', () => {
    const r = paso5Schema.parse({
      ...PASOS.paso5,
      contactos: { ...PASOS.paso5.contactos, arrendatario: { ...contacto('j@p.co'), telefono: '+57 300 123 4567' } },
    });
    expect(r.contactos.arrendatario.telefono).toBe('+573001234567');
  });

  it('acepta las rutas A y B (Entrega 5) y nada más', () => {
    expect(paso1Schema.safeParse({ ...PASOS.paso1, ruta: 'B' }).success).toBe(true);
    const r = paso1Schema.safeParse({ ...PASOS.paso1, ruta: 'C' });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe('Elige la ruta del contrato');
  });

  it('comisión: 2,555 no, 2,55 sí', () => {
    expect(paso3Schema.safeParse({ ...PASOS.paso3, comisionPct: 2.555 }).success).toBe(false);
    expect(paso3Schema.safeParse({ ...PASOS.paso3, comisionPct: 2.55 }).success).toBe(true);
  });

  it('PH sin nombre de copropiedad no pasa', () => {
    expect(paso2Schema.safeParse({ ...PASOS.paso2, nombreCopropiedad: null }).success).toBe(false);
    expect(paso2Schema.safeParse(PASOS.paso2).success).toBe(true);
  });

  it('B5 estructural: una clave extra (deposito) no pasa', () => {
    expect(paso3Schema.safeParse({ ...PASOS.paso3, deposito: 1_000_000 }).success).toBe(false);
  });
});

describe('prefill: trazabilidad 2026-09-22 (§7.2, §1.3/§1.4, §8.7.2)', () => {
  const HOY = '2026-09-15';
  it('sin datos extra: modalidad vacía, parqueadero sí sin número, cuota y dirección del coarrendatario vacías', () => {
    const p = prefill(fuentes(), HOY, CALIBRACION_DEFAULT);
    expect(p[1]).not.toHaveProperty('modalidad');
    expect(p[2].usos).toEqual({ carro: '', moto: null, util: null });
    expect(p[2]).not.toHaveProperty('nombreCopropiedad');
    expect(p[3]).not.toHaveProperty('administracion');
    expect(p[5].contactos?.coarrendatario).toMatchObject({ direccion: '', municipio: '' });
  });

  it('con el convenio, el registro del inmueble y la aceptación del coarrendatario', () => {
    const f = fuentes({
      modalidadFianzaDefecto: 'tradicional',
      inmueble: {
        ...fuentes().inmueble,
        nombre_copropiedad: 'Edificio Torres del Parque',
        parqueadero_numero: '12',
        parqueadero_moto: true,
        parqueadero_moto_numero: 'M-4',
        cuarto_util: true,
        cuarto_util_numero: 'D-3',
        administracionCop: 350_000,
      },
      coarrendatario: { ...COA, direccion: 'Carrera 70 # 1-2', municipio: 'Envigado' },
    });
    const p = prefill(f, HOY, CALIBRACION_DEFAULT);
    expect(p[1].modalidad).toBe('tradicional');
    expect(p[2]).toMatchObject({ usos: { carro: '12', moto: 'M-4', util: 'D-3' }, nombreCopropiedad: 'Edificio Torres del Parque' });
    expect(p[3].administracion).toEqual({ valorCop: 350_000 });
    expect(p[5].contactos?.coarrendatario).toMatchObject({ direccion: 'Carrera 70 # 1-2', municipio: 'Envigado' });
  });

  it('sin propiedad horizontal no precarga copropiedad ni cuota', () => {
    const f = fuentes({
      inmueble: { ...fuentes().inmueble, propiedad_horizontal: false, nombre_copropiedad: 'X', administracionCop: 350_000 },
    });
    const p = prefill(f, HOY, CALIBRACION_DEFAULT);
    expect(p[2]).not.toHaveProperty('nombreCopropiedad');
    expect(p[3]).not.toHaveProperty('administracion');
  });
});

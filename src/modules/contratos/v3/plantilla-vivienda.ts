/**
 * Contratos V3 — plantilla del contrato de arrendamiento de vivienda urbana
 * (Entrega 2, diseño §3).
 *
 * El texto vive en recursos/contratos/vivienda/*.txt, una línea por párrafo
 * del Word fijado por sha256 (fidelidad.test.ts lo compara párrafo a
 * párrafo). Aquí solo va el catálogo cerrado de campos, cifras, condiciones y
 * roles que la plantilla puede usar (diseño §3.4): el parser rechaza
 * cualquier otro. Se parsea una vez al cargar el módulo; si la plantilla es
 * inválida, el require ya falla.
 */

import { parsearPlantilla, type DefPlantilla } from './motor';

const de = (grupo: string, ...campos: string[]) => campos.map((c) => `${grupo}.${c}`);
const CONTACTO = ['direccion', 'municipio', 'email', 'celular'];
const PERSONA = ['nombre', 'tipoDocumento', 'documento', ...CONTACTO];

const TEXTOS = [
  'ciudadFirma',
  // arrendador.nit ya viene formateado con su dígito de verificación
  ...de(
    'arrendador',
    'nombre',
    'nit',
    'representante',
    'matricula',
    'matriculaExpedidaPor',
    ...CONTACTO,
  ),
  ...de('arrendatario', ...PERSONA),
  // coa.* en la cláusula del coarrendatario; parte.* solo dentro de @cada coarrendatario
  ...de('coa', 'nombre', 'tipoDocumento', 'documento'),
  ...de('parte', ...PERSONA),
  ...de('inmueble', 'direccion', 'municipio'),
  ...de('usos', 'carro', 'moto', 'util'),
  ...de('cuenta', 'tipo', 'numero', 'banco', 'titular', 'nit'),
  'modalidad',
  'crc.numero',
];

// Las cifras del resumen: cada una entra al libro de coherencia (diseño §4.2.7).
const CIFRAS = [
  'canon',
  'comisionPct',
  'comisionCop',
  'primaPct',
  'primaCop',
  'tarifaPct',
  'tarifaCop',
  'adminCop',
  'totalIngreso',
  'totalMensual',
] as const;

const DEF: DefPlantilla = {
  codigo: 'vivienda',
  partes: ['1-preliminar.txt', '2-bloques-I-IV.txt', '3-bloques-V-VIII.txt', '4-bloques-IX-XI.txt'],
  campos: {
    ...Object.fromEntries(TEXTOS.map((c) => [c, 'texto' as const])),
    ...Object.fromEntries(CIFRAS.map((c) => [c, 'numero' as const])),
    vigenciaMeses: 'numero',
    fechaDocumento: 'fecha',
    fechaInicio: 'fecha',
    fechaVencimiento: 'fecha',
    'crc.fecha': 'fecha',
  },
  cifras: CIFRAS,
  condiciones: [
    'coa', // hay coarrendatario
    'trasladada', // modalidad Trasladada
    'comision', // comisión de intermediación > 0
    'ph', // propiedad horizontal
    'adminArrendatario', // la cuota de administración la paga EL ARRENDATARIO
    'adminIncluida', // la cuota va incluida en el canon
    'adminAparte', // adminArrendatario && !adminIncluida
    // uso conexo declarado
    'carro',
    'moto',
    'util',
    // el documento de la parte es cédula de ciudadanía
    'arrendatario.cc',
    'coa.cc',
    'parte.cc',
    'diaPlural', // el día del documento no es 1
  ],
  roles: ['coarrendatario'],
};

export const PLANTILLA_VIVIENDA = parsearPlantilla(DEF);

/**
 * Anexo de Condiciones de Afianzamiento (Entrega 5, diseño §4.4): lo que
 * firman las partes en la Ruta B, cuando el contrato lo pone la inmobiliaria.
 * Comparte el contexto de vivienda (vivienda.ts:contexto), así que sus campos
 * son un subconjunto de los de arriba más `numero` (el Word imprime el número
 * del contrato asociado en el cuadro; el del contrato lo lleva en el pie).
 */
const DEF_ANEXO: DefPlantilla = {
  codigo: 'anexo-vivienda',
  partes: ['anexo.txt'],
  campos: {
    ...Object.fromEntries(
      [
        'numero',
        'ciudadFirma',
        ...de(
          'arrendador',
          'nombre',
          'nit',
          'representante',
          'matricula',
          'matriculaExpedidaPor',
          ...CONTACTO,
        ),
        ...de('arrendatario', ...PERSONA),
        ...de('coa', 'nombre', 'tipoDocumento', 'documento'),
        ...de('parte', ...PERSONA),
        ...de('inmueble', 'direccion', 'municipio'),
        'crc.numero',
      ].map((c) => [c, 'texto' as const]),
    ),
    ...Object.fromEntries(
      ['canon', 'vigenciaMeses', 'primaPct', 'primaCop', 'tarifaPct', 'tarifaCop'].map((c) => [
        c,
        'numero' as const,
      ]),
    ),
    fechaDocumento: 'fecha',
    fechaInicio: 'fecha',
    fechaVencimiento: 'fecha',
    'crc.fecha': 'fecha',
  },
  cifras: ['canon', 'primaPct', 'primaCop', 'tarifaPct', 'tarifaCop'],
  condiciones: [
    'coa', // hay coarrendatario
    'trasladada', // modalidad Trasladada
    // el documento de la parte es cédula de ciudadanía
    'arrendatario.cc',
    'coa.cc',
    'parte.cc',
  ],
  roles: ['coarrendatario'],
};

export const PLANTILLA_ANEXO = parsearPlantilla(DEF_ANEXO);

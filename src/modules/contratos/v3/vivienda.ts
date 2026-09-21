/**
 * Contratos V3 — contrato de arrendamiento de vivienda urbana (Entrega 2, diseño §5).
 *
 * DatosVivienda → validarDatos → contexto → renderizar → verificarCoherencia
 * → pdfContrato. En modo 'final' el propio renderizar rechaza textos pendientes
 * (PLANTILLA_TEXTO_PENDIENTE) y marcadores sin llenar (PLANTILLA_MARCADOR).
 *
 * Quién arma DatosVivienda (desde contrato_partes y el CRC, filtrando por
 * tenantScope) es el cargador de Entrega 3. Hasta entonces ninguna ruta ni
 * módulo existente importa este archivo (diseño §1.10).
 */

import { AppError } from '@/lib/errors';
import { pctDe } from '@/modules/estudios/tarifas';
import { APROBACIONES } from './aprobaciones';
import { pdfContrato, type LogoPdf } from './documento';
import { sumarMeses } from './formato';
import {
  renderizar,
  verificarCoherencia,
  type Adicional,
  type Contexto,
  type Linea,
  type Pendiente,
  type Resultado,
} from './motor';
import { PLANTILLA_VIVIENDA } from './plantilla-vivienda';

type TipoDoc = 'cc' | 'ce' | 'pasaporte' | 'nit' | 'ti';

/** Una fila de contrato_partes (Entrega 1) en camelCase. */
export interface Persona {
  tipoPersona: 'natural' | 'juridica';
  nombre: string;
  tipoDocumento: TipoDoc;
  numeroDocumento: string;
  digitoVerificacion?: string | null;
  representanteLegalNombre?: string | null;
  matriculaNumero?: string | null;
  matriculaExpedidaPor?: string | null;
  email: string;
  telefono: string;
  direccion: string;
  municipio: string;
}

export interface DatosVivienda {
  numero: string; // contratos.numero; 'BORRADOR' en modo revisión
  ciudadFirma: string;
  fechaDocumento: string; // fechas ISO AAAA-MM-DD
  arrendador: Persona;
  arrendatario: Persona;
  coarrendatarios: Persona[];
  inmueble: {
    direccion: string;
    municipio: string;
    propiedadHorizontal: boolean;
    usos: Record<'carro' | 'moto' | 'util', string | null>; // null = NO; el texto es el número
  };
  canonCop: number;
  vigenciaMeses: number;
  fechaInicio: string;
  cuenta: { tipo: string; numero: string; banco: string; titular: string; nit: string };
  modalidad: 'trasladada' | 'tradicional';
  crc: { numero: string; fecha: string };
  primaPct: number;
  tarifaPct: number;
  cashbackPct: number;
  comisionPct: number;
  /** null ⇔ el inmueble no es de propiedad horizontal. */
  administracion: {
    aCargoDe: 'arrendador' | 'arrendatario';
    valorCop: number;
    incluidaEnCanon: boolean;
  } | null;
}

export interface OpcionesVivienda {
  modo: 'final' | 'revision';
  logoInmobiliaria: LogoPdf | null;
  adicionales?: Adicional[];
}

// El Word dice "treinta por ciento (30%)" en letras: otro porcentaje no se puede imprimir.
const CASHBACK_DEL_WORD = 30;
const LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
// El logo va crudo al src de la cabecera: solo base64 limpio, nada que cierre el atributo.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const NUMERO_CONTRATO = /^CTO-\d{4}-\d{4,}$/;

const noSoporta = (regla: string, msg: string) =>
  new AppError(400, 'PLANTILLA_NO_SOPORTA', msg, { regla });
const faltante = (campo: string, msg: string) =>
  new AppError(400, 'PLANTILLA_DATO_FALTANTE', msg, { campo });

/**
 * Lo que esta plantilla no sabe escribir (PLANTILLA_NO_SOPORTA) y lo que el
 * motor no ve pero va en el PDF (el número del pie, el logo de la cabecera).
 */
export function validarDatos(
  d: DatosVivienda,
  o: Pick<OpcionesVivienda, 'modo' | 'logoInmobiliaria'>,
): void {
  const logo = o.logoInmobiliaria;
  const reglas: [regla: string, falla: boolean, msg: string][] = [
    [
      'coarrendatarios',
      d.coarrendatarios.length > 1,
      'El contrato de vivienda admite a lo sumo un coarrendatario',
    ],
    [
      'persona_juridica',
      [d.arrendatario, ...d.coarrendatarios].some((p) => p.tipoPersona === 'juridica'),
      'El contrato de vivienda es para arrendatarios y coarrendatarios personas naturales',
    ],
    [
      'arrendador_nit',
      d.arrendador.tipoDocumento !== 'nit',
      'El arrendador debe identificarse con NIT',
    ],
    [
      'cashback',
      d.cashbackPct !== CASHBACK_DEL_WORD,
      `El contrato fija el cashback en ${CASHBACK_DEL_WORD}%; no admite ${d.cashbackPct}%`,
    ],
    [
      'vigencia',
      !Number.isInteger(d.vigenciaMeses) || d.vigenciaMeses < 2,
      'La vigencia debe ser de al menos dos meses enteros',
    ],
    [
      'propiedad_horizontal',
      d.inmueble.propiedadHorizontal !== (d.administracion !== null),
      'La cuota de administración va si y solo si el inmueble es de propiedad horizontal',
    ],
    [
      'logo',
      !!logo &&
        (!LOGO_MIMES.includes(logo.mime) ||
          !BASE64.test(logo.base64) ||
          Buffer.byteLength(logo.base64, 'base64') > LOGO_MAX_BYTES),
      'El logo de la inmobiliaria debe ser PNG, JPEG o WebP de hasta 2 MB',
    ],
  ];
  const falla = reglas.find(([, mal]) => mal);
  if (falla) throw noSoporta(falla[0], falla[2]);

  if (o.modo === 'final' ? !NUMERO_CONTRATO.test(d.numero) : !d.numero?.trim())
    throw faltante('numero', 'Falta el número del contrato (CTO-AAAA-NNNN) para el pie de página');
}

/** NIT del arrendador con su dígito de verificación: "900123456" + "7" → "900.123.456-7". */
function nit(p: Persona): string {
  const dv = p.digitoVerificacion?.trim() ?? '';
  if (!/^\d$/.test(dv))
    throw faltante(
      'arrendador.digitoVerificacion',
      'Falta el dígito de verificación del NIT del arrendador',
    );
  return `${p.numeroDocumento.replace(/\D/g, '').replace(/\B(?=(\d{3})+$)/g, '.')}-${dv}`;
}

/** Campos de una persona sin prefijo: el @cada los lee así; arriba van con 'rol.'. */
const persona = (p: Persona) => ({
  nombre: p.nombre,
  tipoDocumento: p.tipoDocumento,
  documento: p.numeroDocumento,
  direccion: p.direccion,
  municipio: p.municipio,
  email: p.email,
  celular: p.telefono,
});

const con = (prefijo: string, o: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [`${prefijo}.${k}`, v]));

const MODALIDAD = { trasladada: 'Trasladada', tradicional: 'Tradicional' } as const;

/**
 * Condiciones y valores del contrato (catálogo §3.4). Un campo sin dato (usos
 * en NO, coarrendatario ausente, administración sin PH) no se pone: si la
 * plantilla lo imprimiera igual, el motor falla con PLANTILLA_DATO_FALTANTE.
 */
export function contexto(d: DatosVivienda): Contexto {
  const adm = d.administracion;
  const coa = d.coarrendatarios[0];
  const usos = d.inmueble.usos;
  const trasladada = d.modalidad === 'trasladada';
  const comision = d.comisionPct > 0;
  const adminArrendatario = adm?.aCargoDe === 'arrendatario';
  const adminIncluida = adm?.incluidaEnCanon ?? false;
  const adminAparte = adminArrendatario && !adminIncluida;
  const cop = (pct: number) => pctDe(d.canonCop, pct)!;
  const [comisionCop, primaCop, tarifaCop] = [
    cop(d.comisionPct),
    cop(d.primaPct),
    cop(d.tarifaPct),
  ];

  let fechaVencimiento: string;
  try {
    fechaVencimiento = sumarMeses(d.fechaInicio, d.vigenciaMeses);
  } catch (e) {
    throw faltante('fechaInicio', `Fecha de iniciación inválida: ${(e as Error).message}`);
  }

  return {
    condiciones: {
      coa: !!coa,
      trasladada,
      comision,
      ph: d.inmueble.propiedadHorizontal,
      adminArrendatario,
      adminIncluida,
      adminAparte,
      carro: usos.carro !== null,
      moto: usos.moto !== null,
      util: usos.util !== null,
      'arrendatario.cc': d.arrendatario.tipoDocumento === 'cc',
      ...(coa && { 'coa.cc': coa.tipoDocumento === 'cc' }),
      diaPlural: !d.fechaDocumento.endsWith('-01'),
    },
    valores: {
      ciudadFirma: d.ciudadFirma,
      fechaDocumento: d.fechaDocumento,
      fechaInicio: d.fechaInicio,
      fechaVencimiento,
      vigenciaMeses: d.vigenciaMeses,
      ...con('arrendador', persona(d.arrendador)),
      'arrendador.nit': nit(d.arrendador),
      'arrendador.representante': d.arrendador.representanteLegalNombre ?? '',
      'arrendador.matricula': d.arrendador.matriculaNumero ?? '',
      'arrendador.matriculaExpedidaPor': d.arrendador.matriculaExpedidaPor ?? '',
      ...con('arrendatario', persona(d.arrendatario)),
      ...(coa && con('coa', persona(coa))),
      'inmueble.direccion': d.inmueble.direccion,
      'inmueble.municipio': d.inmueble.municipio,
      ...Object.fromEntries(
        Object.entries(usos)
          .filter(([, v]) => v !== null)
          .map(([k, v]) => [`usos.${k}`, v as string]),
      ),
      ...con('cuenta', d.cuenta),
      modalidad: MODALIDAD[d.modalidad],
      'crc.numero': d.crc.numero,
      'crc.fecha': d.crc.fecha,
      canon: d.canonCop,
      comisionPct: d.comisionPct,
      comisionCop,
      primaPct: d.primaPct,
      primaCop,
      tarifaPct: d.tarifaPct,
      tarifaCop,
      ...(adm && { adminCop: adm.valorCop }),
      totalIngreso: d.canonCop + (comision ? comisionCop : 0) + (trasladada ? primaCop : 0),
      totalMensual: d.canonCop + (trasladada ? tarifaCop : 0) + (adminAparte ? adm!.valorCop : 0),
    },
    roles: {
      coarrendatario: d.coarrendatarios.map((p) => ({
        condiciones: { cc: p.tipoDocumento === 'cc' },
        valores: persona(p),
      })),
    },
  };
}

/** Las cifras del resumen que no están en ninguna cláusula se recalculan sobre lo impreso. */
export const DERIVADAS: Record<string, (v: (c: string) => number) => number> = {
  comisionCop: (v) => pctDe(v('canon'), v('comisionPct'))!,
  primaCop: (v) => pctDe(v('canon'), v('primaPct'))!,
  tarifaCop: (v) => pctDe(v('canon'), v('tarifaPct'))!,
};

/** Todo menos el PDF (puro, sin Chromium): lo usan las pruebas y generarContratoVivienda. */
export function renderizarVivienda(d: DatosVivienda, o: OpcionesVivienda): Resultado {
  validarDatos(d, o);
  const r = renderizar(PLANTILLA_VIVIENDA, contexto(d), {
    modo: o.modo,
    adicionales: o.adicionales,
    aprobados: APROBACIONES,
  });
  verificarCoherencia(r.asientos, DERIVADAS);
  return r;
}

/**
 * PDF del contrato de vivienda. En 'revision' sale con marca de agua BORRADOR
 * y los pendientes resaltados; en 'final', solo si no queda nada pendiente.
 */
export async function generarContratoVivienda(
  d: DatosVivienda,
  o: OpcionesVivienda,
): Promise<{ pdf: Buffer; pendientes: Pendiente[]; version: string; lineas: Linea[] }> {
  const r = renderizarVivienda(d, o);
  const pdf = await pdfContrato(r.html, {
    pie: PLANTILLA_VIVIENDA.pie,
    numero: d.numero,
    logo: o.logoInmobiliaria,
    borrador: o.modo !== 'final',
  });
  return { pdf, pendientes: r.pendientes, version: PLANTILLA_VIVIENDA.version, lineas: r.lineas };
}

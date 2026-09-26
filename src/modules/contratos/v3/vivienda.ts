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
import { anclarFirmas, esc, pdfContrato, type LogoPdf } from './documento';
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
import { PLANTILLA_ANEXO, PLANTILLA_VIVIENDA } from './plantilla-vivienda';

type TipoDoc = 'cc' | 'ce' | 'pasaporte' | 'nit' | 'ti' | 'ppt' | 'pep';

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
  /**
   * Ruta B: el número que la inmobiliaria le puso a SU contrato, si lo tiene.
   * El Anexo lo imprime en «Contrato asociado N°» y en la página divisoria; sin
   * él, va `numero` (el consecutivo de Cofianza). Solo el Anexo lo usa.
   */
  numeroContratoPropio?: string;
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
  /** TARIFA_IVA de calibración: la prima causa IVA (Adenda 1 §1.1). */
  ivaPct: number;
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
  /** Mete las anclas {{signature:i}} de Auco en las rayas de firma (Entrega 5 §3.3). */
  anclas?: boolean;
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
  // Sin las tarifas del CRC no hay fianza que liquidar: mejor fallar que imprimir 0 % o la prima sin IVA.
  if (![d.primaPct, d.tarifaPct, d.cashbackPct, d.ivaPct].every((n) => Number.isFinite(n) && n >= 0))
    throw faltante('tarifas', 'Faltan las tarifas del CRC (prima, tarifa, cashback o IVA) para liquidar la fianza');
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

/** Con IVA sobre la cifra ya redondeada, como tarifa_mensual_con_iva_cop (tarifas.ts). */
const conIva = (cop: number, ivaPct: number) => Math.round(cop * (1 + ivaPct / 100));

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
  const primaIvaCop = conIva(primaCop, d.ivaPct);

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
    },
    valores: {
      // solo lo imprime el Anexo (su cuadro trae el "Contrato asociado N°"); la
      // plantilla de vivienda no declara `numero` y el motor ignora lo que sobra
      numero: d.numeroContratoPropio || d.numero,
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
      primaCop, // sin IVA: no se imprime, va a la bitácora de la vista previa
      primaIvaCop,
      tarifaPct: d.tarifaPct,
      tarifaCop,
      ...(adm && { adminCop: adm.valorCop }),
      totalIngreso: d.canonCop + (comision ? comisionCop : 0) + (trasladada ? primaIvaCop : 0),
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

/**
 * Las cifras del resumen que no están en ninguna cláusula se recalculan sobre
 * lo impreso. El porcentaje de IVA no se imprime: entra con los datos.
 */
export const derivadas = (ivaPct: number): Record<string, (v: (c: string) => number) => number> => ({
  comisionCop: (v) => pctDe(v('canon'), v('comisionPct'))!,
  primaIvaCop: (v) => conIva(pctDe(v('canon'), v('primaPct'))!, ivaPct),
  tarifaCop: (v) => pctDe(v('canon'), v('tarifaPct'))!,
});

/** Todo menos el PDF (puro, sin Chromium): lo usan las pruebas y generarContratoVivienda. */
export function renderizarVivienda(d: DatosVivienda, o: OpcionesVivienda): Resultado {
  validarDatos(d, o);
  const r = renderizar(PLANTILLA_VIVIENDA, contexto(d), {
    modo: o.modo,
    adicionales: o.adicionales,
    aprobados: APROBACIONES,
  });
  verificarCoherencia(r.asientos, derivadas(d.ivaPct));
  return r;
}

/** Un bloque de firma por parte: arrendatario, coarrendatario(s) y arrendador. */
const conAnclas = (html: string, d: DatosVivienda, o: OpcionesVivienda) =>
  o.anclas ? anclarFirmas(html, 2 + d.coarrendatarios.length) : html;

/**
 * PDF del contrato de vivienda. En 'revision' sale con marca de agua BORRADOR
 * y los pendientes resaltados; en 'final', solo si no queda nada pendiente.
 */
export async function generarContratoVivienda(
  d: DatosVivienda,
  o: OpcionesVivienda,
): Promise<{ pdf: Buffer; pendientes: Pendiente[]; version: string; lineas: Linea[] }> {
  const r = renderizarVivienda(d, o);
  const pdf = await pdfContrato(conAnclas(r.html, d, o), {
    pie: PLANTILLA_VIVIENDA.pie,
    numero: d.numero,
    logo: o.logoInmobiliaria,
    borrador: o.modo !== 'final',
  });
  return { pdf, pendientes: r.pendientes, version: PLANTILLA_VIVIENDA.version, lineas: r.lineas };
}

// ── Anexo de Condiciones de Afianzamiento (Ruta B, Entrega 5 §4.4) ──

/**
 * Mismo flujo que renderizarVivienda con la plantilla del Anexo: los mismos
 * DatosVivienda (el Anexo imprime un subconjunto) y el mismo contexto. Sin
 * cláusulas adicionales: en la Ruta B las pone EL ARRENDADOR en su documento.
 */
export function renderizarAnexo(d: DatosVivienda, o: OpcionesVivienda): Resultado {
  validarDatos(d, o);
  const r = renderizar(PLANTILLA_ANEXO, contexto(d), { modo: o.modo, aprobados: APROBACIONES });
  verificarCoherencia(r.asientos, derivadas(d.ivaPct));
  return r;
}

/**
 * Página divisoria de la Ruta B (Adenda 1 del módulo de contratos, respuesta 6):
 * el PDF de la inmobiliaria va antes, intacto, y esta página de Cofianza, con el
 * formato del Anexo, marca dónde termina ese contrato y dónde empieza el Anexo.
 * Va como primera página del PDF del Anexo: así también sale en la vista previa.
 */
export function paginaDivisoria(d: DatosVivienda): string {
  return (
    '<section class="divisoria">' +
    '<p class="k-titulo">PÁGINA DIVISORIA</p>' +
    `<p class="k-nota">Contrato de arrendamiento N° ${esc(d.numeroContratoPropio || d.numero)}</p>` +
    `<p class="k-p">Aquí termina el contrato de arrendamiento aportado por EL ARRENDADOR, ${esc(d.arrendador.nombre)}, ` +
    'que ocupa las páginas anteriores tal como lo cargó, sin modificaciones de COFIANZA S.A.S.</p>' +
    '<p class="k-p">En la página siguiente empieza el ANEXO DE CONDICIONES DE AFIANZAMIENTO COFIANZA de este contrato.</p>' +
    '</section>'
  );
}

/** PDF del Anexo, precedido de la página divisoria. El pie lleva el CRC, no el número del contrato ni iniciales. */
export async function generarAnexoVivienda(
  d: DatosVivienda,
  o: OpcionesVivienda,
): Promise<{ pdf: Buffer; pendientes: Pendiente[]; version: string; lineas: Linea[] }> {
  const r = renderizarAnexo(d, o);
  const pdf = await pdfContrato(paginaDivisoria(d) + conAnclas(r.html, d, o), {
    pie: PLANTILLA_ANEXO.pie,
    rotulo: 'CRC N°',
    numero: d.crc.numero,
    iniciales: false,
    logo: o.logoInmobiliaria,
    borrador: o.modo !== 'final',
  });
  return { pdf, pendientes: r.pendientes, version: PLANTILLA_ANEXO.version, lineas: r.lineas };
}

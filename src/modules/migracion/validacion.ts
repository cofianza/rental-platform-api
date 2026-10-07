// ============================================================
// Validación de filas de migración de cartera — PURA (spec §1.2, §1.3, §5).
//
// Sin Supabase ni reloj: recibe la fecha de hoy, los parámetros de calibración,
// las habilitaciones utilizables y el catálogo de municipios. Los cruces contra
// la base (inmueble ocupado, fila viva en otro lote…) los resuelve el servicio
// y se aplican con aplicarConflictos.
// ============================================================

import type { Calibracion } from '@/lib/calibracion';
import type { MunicipioCO } from '@/lib/colombia-municipios';
import { normalize } from '@/lib/colombia-municipios';
import { telefonoNormalizado } from '@/lib/telefono';
import { TIPOS_INMUEBLE } from '@/modules/inmuebles/inmuebles.schema';
import {
  COLUMNAS,
  DESTINACIONES,
  PAGADORES_ADMINISTRACION,
  PAGADORES_SERVICIOS,
  TIPOS_DOCUMENTO_ARCHIVO,
  TIPOS_INMUEBLE_ARCHIVO,
  TIPOS_PERSONA_ARCHIVO,
  type FilaArchivo,
  type ValorCelda,
} from './plantilla';

export type Destinacion = 'vivienda' | 'comercial';
export type Resultado = 'aceptada' | 'advertencia' | 'rechazada';

export type ParametrosMigracion = Pick<
  Calibracion,
  | 'CANON_MAX_TRANSITORIO'
  | 'TOPE_CANON_COMERCIAL'
  | 'MESES_SIN_MORA_REQUERIDOS'
  | 'TARIFA_MIGRACION_REPORTABLE'
  | 'RECARGO_NO_REPORTABLE'
>;

export interface ContextoValidacion {
  /** AAAA-MM-DD en Bogotá: la «fecha de la migración» de §1.3. */
  hoy: string;
  parametros: ParametrosMigracion;
  /** Solo las destinaciones con habilitación utilizable (§1.1.5). */
  habilitaciones: Partial<Record<Destinacion, { habeas_subrogatario: boolean | null }>>;
  municipios: readonly MunicipioCO[];
}

export interface Persona {
  nombre: string;
  tipo_documento: string;
  numero_documento: string;
  celular: string | null;
  email: string | null;
}

/** Forma de migracion_filas.datos (la que lee fn_activar_lote_migracion). Nulos solo en filas rechazadas. */
export interface DatosFila {
  direccion: string | null;
  municipio: string | null;
  departamento: string | null;
  codigo_interno: string | null;
  inmueble_id?: string;
  destinacion: Destinacion | null;
  tipo_inmueble: string | null;
  estrato: number | null;
  canon: number | null;
  iva_canon_pct: number;
  cuota_administracion: number | null;
  /** TARIFA_MIGRACION_REPORTABLE al validar: la base a la que baja al pasar a REPORTABLE (§5.2.5). */
  tarifa_base_pct?: number;
  fecha_inicio: string | null;
  fecha_vencimiento: string | null;
  arrendatario: {
    tipo_persona: 'natural' | 'juridica' | null;
    nombre: string | null;
    apellido: string;
    razon_social: string | null;
    tipo_documento: string | null;
    numero_documento: string | null;
    celular: string | null;
    email: string | null;
  };
  coarrendatarios: Persona[];
  paga_servicios: string | null;
  paga_administracion: string | null;
  declaraciones: { al_dia: boolean | null; mora_reciente: boolean | null; plantilla_entregada: boolean | null };
  observaciones: string | null;
}

export interface ResultadoFila {
  n_fila: number;
  resultado: Resultado;
  motivos: string[];
  advertencias: string[];
  datos: DatosFila;
  clave_inmueble: string | null;
  documento_arrendatario: string | null;
  reportable: boolean | null;
  reportable_motivo: string | null;
  tarifa_pct: number | null;
}

// ── Lectura de celdas ──

const texto = (v: ValorCelda): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s || null;
};

const norm = (s: string) => normalize(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Valor de una lista cerrada; undefined = no está en la lista. */
function deLista<T extends string>(v: ValorCelda, lista: readonly T[]): T | null | undefined {
  const s = texto(v);
  if (s == null) return null;
  return lista.find((x) => norm(x) === norm(s));
}

function siNo(v: ValorCelda): boolean | null | undefined {
  if (typeof v === 'boolean') return v;
  const s = texto(v);
  if (s == null) return null;
  const n = norm(s);
  if (['si', 's', 'yes', 'true', 'verdadero'].includes(n)) return true;
  if (['no', 'n', 'false', 'falso'].includes(n)) return false;
  return undefined;
}

/** Pesos: 1500000, «$ 1.500.000», «1,500,000», «1.500.000,50». NaN = no es número. */
export function numero(v: ValorCelda): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  let s = texto(v);
  if (s == null) return null;
  s = s.replace(/[$\s%]|COP/gi, '');
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** AAAA-MM-DD desde una fecha de Excel, un serial o «AAAA-MM-DD» / «DD/MM/AAAA». 'invalida' si no se entiende. */
export function fecha(v: ValorCelda): string | null | 'invalida' {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'invalida' : v.toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10);
  const s = texto(v);
  if (s == null) return null;
  let a: number, m: number, d: number;
  let r = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (r) [a, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s))) [d, m, a] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else return 'invalida';
  const f = new Date(Date.UTC(a, m - 1, d));
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return 'invalida';
  return f.toISOString().slice(0, 10);
}

// ── Normalización de dirección y municipio ──

const ABREVIATURAS: Record<string, string> = {
  CALLE: 'CL', CLL: 'CL', CL: 'CL',
  CARRERA: 'KR', CRA: 'KR', CR: 'KR', KRA: 'KR', KR: 'KR', CARR: 'KR',
  AVENIDA: 'AV', AV: 'AV', AVDA: 'AV',
  DIAGONAL: 'DG', DIAG: 'DG', DG: 'DG',
  TRANSVERSAL: 'TV', TRANSV: 'TV', TV: 'TV',
  APARTAMENTO: 'AP', APTO: 'AP', APT: 'AP', AP: 'AP',
  INTERIOR: 'IN', INT: 'IN',
  BLOQUE: 'BL', BLQ: 'BL',
  LOCAL: 'LC', OFICINA: 'OF', OFIC: 'OF',
};
const RELLENO = new Set(['N', 'NO', 'NRO', 'NUM', 'NUMERO']); // «N°», «No.», «#»

/** «Calle 10 # 20-30 Apto 301» y «CL 10 No. 20 30 AP 301» dan lo mismo: «CL 10 20 30 AP 301». */
export function normalizarDireccion(direccion: string): string {
  const tokens = normalize(direccion)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !RELLENO.has(t))
    .map((t) => ABREVIATURAS[t] ?? t);
  // «10 A» = «10A».
  return tokens.join(' ').replace(/\b(\d+) ([A-Z])\b/g, '$1$2');
}

// «Bogotá», «Bogota D.C.» y «Bogotá, D.C.» son el mismo.
const normMunicipio = (s: string) => norm(s).replace(/\bd ?c\b/g, '').trim();

/** Clave del inmueble para cruces: dirección normalizada + municipio normalizado. */
export const claveInmueble = (direccion: string, municipio: string) =>
  `${normalizarDireccion(direccion)}|${normMunicipio(municipio)}`;

/** «Medellín», «Medellín, Antioquia», «Mosquera - Cundinamarca» o «Mosquera (Nariño)». */
export function resolverMunicipio(
  entrada: string,
  catalogo: readonly MunicipioCO[],
): { municipio: MunicipioCO } | { error: string } {
  const [nombre, depto] = entrada
    .replace(/[()]/g, ',')
    .split(/,| - /)
    .map((p) => p.trim())
    .filter(Boolean);
  const n = normMunicipio(nombre ?? '');
  let candidatos = catalogo.filter((m) => normMunicipio(m.name) === n);
  // «Cartagena» = «Cartagena de Indias» cuando no hay otro que empiece igual.
  if (!candidatos.length) candidatos = catalogo.filter((m) => normMunicipio(m.name).startsWith(`${n} `));
  if (depto) candidatos = candidatos.filter((m) => normMunicipio(m.department.name) === normMunicipio(depto));
  if (candidatos.length === 1) return { municipio: candidatos[0] };
  if (!candidatos.length) return { error: `Municipio «${entrada}» no reconocido.` };
  return { error: `El municipio «${nombre}» existe en varios departamentos: escríbalo como «Municipio, Departamento».` };
}

// ── Documentos y contacto ──

const TIPO_DOC_BD: Record<(typeof TIPOS_DOCUMENTO_ARCHIVO)[number], string> = {
  CC: 'cc', CE: 'ce', PPT: 'ppt', PEP: 'pep', Pasaporte: 'pasaporte', NIT: 'nit',
};

/** Sin puntos ni espacios; NIT sin dígito de verificación. null = inválido. */
export function normalizarDocumento(tipo: string, numeroDoc: string): string | null {
  let s = numeroDoc.toUpperCase();
  if (tipo === 'nit') s = s.split('-')[0];
  s = s.replace(/[^A-Z0-9]/g, '');
  if (['cc', 'nit'].includes(tipo) && !/^\d+$/.test(s)) return null;
  return s.length >= 3 && s.length <= 20 ? s : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const celularValido = (c: string) => /^573\d{9}$/.test(telefonoNormalizado(c));

// ── Validación de una fila ──

const ENCABEZADO = Object.fromEntries(COLUMNAS.map((c) => [c.clave, c.encabezado]));

export function validarFila(fila: FilaArchivo, ctx: ContextoValidacion): ResultadoFila {
  const c = fila.celdas;
  const motivos: string[] = [];
  const advertencias: string[] = [];
  const faltan: string[] = [];
  const p = ctx.parametros;

  const req = (clave: string): string | null => {
    const v = texto(c[clave]);
    if (v == null) faltan.push(ENCABEZADO[clave]);
    return v;
  };
  const reqLista = <T extends string>(clave: string, lista: readonly T[]): T | null => {
    if (texto(c[clave]) == null) {
      faltan.push(ENCABEZADO[clave]);
      return null;
    }
    const v = deLista(c[clave], lista);
    if (v === undefined) motivos.push(`«${ENCABEZADO[clave]}»: valor no permitido. Use ${lista.join(', ')}.`);
    return v ?? null;
  };
  const reqSiNo = (clave: string): boolean | null => {
    const v = siNo(c[clave]);
    if (v === null) faltan.push(ENCABEZADO[clave]);
    else if (v === undefined) motivos.push(`«${ENCABEZADO[clave]}»: responda Sí o No.`);
    return v ?? null;
  };

  // Inmueble
  const direccion = req('direccion');
  const municipioTxt = req('municipio');
  let municipio: MunicipioCO | null = null;
  if (municipioTxt) {
    const r = resolverMunicipio(municipioTxt, ctx.municipios);
    if ('error' in r) motivos.push(r.error);
    else municipio = r.municipio;
  }
  const codigoInterno = texto(c.codigo_interno);

  let destinacion: Destinacion | null = null;
  const destTxt = texto(c.destinacion);
  if (destTxt == null) faltan.push(ENCABEZADO.destinacion);
  else if (/^mixt/.test(norm(destTxt)))
    motivos.push('Destinación mixta: requiere decisión de la Gerencia General caso por caso.');
  else {
    const d = deLista(c.destinacion, DESTINACIONES);
    if (!d) motivos.push('«Destinación»: use Vivienda o Comercial.');
    else destinacion = d === 'Vivienda' ? 'vivienda' : 'comercial';
  }
  if (destinacion && !ctx.habilitaciones[destinacion])
    motivos.push(`La inmobiliaria no está habilitada para migrar contratos de destinación ${destinacion}.`);

  const tipoLabel = reqLista('tipo_inmueble', TIPOS_INMUEBLE_ARCHIVO);
  const tipoInmueble = tipoLabel ? TIPOS_INMUEBLE[TIPOS_INMUEBLE_ARCHIVO.indexOf(tipoLabel)] : null;

  let estrato: number | null = null;
  if (texto(c.estrato) == null) faltan.push(ENCABEZADO.estrato);
  else {
    const e = numero(c.estrato);
    if (e == null || !Number.isInteger(e) || e < 1 || e > 7) motivos.push('«Estrato»: debe ser un número entero del 1 al 7.');
    else estrato = e;
  }

  // Arrendatario
  const tipoPersonaLabel = reqLista('arrendatario_tipo_persona', TIPOS_PERSONA_ARCHIVO);
  const tipoPersona = tipoPersonaLabel ? (tipoPersonaLabel === 'Natural' ? 'natural' : 'juridica') : null;
  const nombre = req('arrendatario_nombre');
  // Topes de las columnas donde los inserta fn_activar_lote_migracion: un valor
  // más largo abortaría la activación de todo el lote ya firmado.
  if (nombre && nombre.length > 300) motivos.push('Nombre o razón social del arrendatario de más de 300 caracteres.');
  const apellido = texto(c.arrendatario_apellido);
  if (tipoPersona === 'natural' && !apellido) faltan.push(ENCABEZADO.arrendatario_apellido);
  const tipoDocLabel = reqLista('arrendatario_tipo_documento', TIPOS_DOCUMENTO_ARCHIVO);
  const tipoDoc = tipoDocLabel ? TIPO_DOC_BD[tipoDocLabel] : null;
  const numDocTxt = req('arrendatario_numero_documento');
  let documento: string | null = null;
  if (tipoDoc && numDocTxt) {
    documento = normalizarDocumento(tipoDoc, numDocTxt);
    if (!documento) motivos.push('Número de documento del arrendatario no válido.');
  }
  if (tipoPersona === 'juridica' && tipoDoc && tipoDoc !== 'nit')
    motivos.push('Un arrendatario persona jurídica se identifica con NIT.');
  if (tipoPersona === 'natural' && tipoDoc === 'nit')
    advertencias.push('Arrendatario persona natural identificado con NIT: verifique el tipo de persona.');

  const celular = req('arrendatario_celular');
  if (celular && !celularValido(celular)) motivos.push('Celular del arrendatario no válido (10 dígitos de Colombia).');
  const email = req('arrendatario_email');
  if (email && (email.length > 255 || !EMAIL.test(email))) motivos.push('Correo electrónico del arrendatario no válido.');

  // Coarrendatarios (§2.2 col. 6): si hay alguno, nombre, documento y un contacto.
  const coarrendatarios: Persona[] = [];
  for (const n of [1, 2] as const) {
    const k = (s: string) => `coarrendatario${n}_${s}`;
    if (!['nombre', 'tipo_documento', 'numero_documento', 'celular', 'email'].some((s) => texto(c[k(s)]) != null)) continue;
    const nom = texto(c[k('nombre')]);
    const tLabel = deLista(c[k('tipo_documento')], TIPOS_DOCUMENTO_ARCHIVO);
    const num = texto(c[k('numero_documento')]);
    const cel = texto(c[k('celular')]);
    const mail = texto(c[k('email')]);
    const doc = tLabel && num ? normalizarDocumento(TIPO_DOC_BD[tLabel], num) : null;
    if (!nom || !tLabel || !num) motivos.push(`Coarrendatario ${n}: faltan nombre, tipo o número de documento.`);
    else if (!doc) motivos.push(`Coarrendatario ${n}: número de documento no válido.`);
    if (!cel && !mail) motivos.push(`Coarrendatario ${n}: indique un celular o un correo electrónico.`);
    if (cel && !celularValido(cel)) motivos.push(`Coarrendatario ${n}: celular no válido.`);
    if (mail && !EMAIL.test(mail)) motivos.push(`Coarrendatario ${n}: correo electrónico no válido.`);
    if (nom && tLabel && doc)
      coarrendatarios.push({ nombre: nom, tipo_documento: TIPO_DOC_BD[tLabel], numero_documento: doc, celular: cel, email: mail });
  }

  // Canon e IVA (§1.2.5, §5.2.3: siempre sin IVA)
  let canon: number | null = null;
  if (texto(c.canon) == null) faltan.push(ENCABEZADO.canon);
  else {
    const v = numero(c.canon);
    if (v == null || Number.isNaN(v) || v <= 0) motivos.push('«Canon»: debe ser un valor en pesos mayor que cero.');
    else canon = Math.round(v);
  }
  if (canon && destinacion) {
    const tope = destinacion === 'vivienda' ? p.CANON_MAX_TRANSITORIO : p.TOPE_CANON_COMERCIAL;
    if (canon > tope)
      motivos.push(`Canon por encima del tope de ${destinacion} ($${tope.toLocaleString('es-CO')} sin IVA).`);
  }
  let iva = 0;
  const ivaVal = numero(c.iva_canon_pct);
  if (ivaVal != null && (Number.isNaN(ivaVal) || ivaVal < 0 || ivaVal > 100))
    motivos.push('«IVA del canon»: debe ser un porcentaje entre 0 y 100.');
  else if (destinacion === 'vivienda' && ivaVal) advertencias.push('En vivienda el canon no lleva IVA: se toma 0 %.');
  else if (destinacion === 'comercial') {
    if (ivaVal == null) advertencias.push('IVA del canon vacío: se toma 0 %.');
    else iva = ivaVal;
  }

  // Fechas (§1.2.1, §1.3; el plazo restante no es causal, §1.3.1)
  const leerFecha = (clave: string) => {
    const f = fecha(c[clave]);
    if (f === null) faltan.push(ENCABEZADO[clave]);
    if (f === 'invalida') motivos.push(`«${ENCABEZADO[clave]}»: fecha no válida.`);
    return f === 'invalida' ? null : f;
  };
  const inicio = leerFecha('fecha_inicio');
  const vence = leerFecha('fecha_vencimiento');
  if (inicio && vence && vence <= inicio) motivos.push('La fecha de vencimiento debe ser posterior a la de inicio.');
  if (vence && vence < ctx.hoy) motivos.push('Contrato con fecha de vencimiento anterior a la fecha de migración.');
  if (inicio && inicio > ctx.hoy) motivos.push('El contrato aún no ha iniciado: solo se migran contratos en ejecución.');

  // Pagos de servicios y administración (§2.2 col. 9-10)
  const pagaServicios = reqLista('paga_servicios', PAGADORES_SERVICIOS);
  const pagaAdmin = reqLista('paga_administracion', PAGADORES_ADMINISTRACION);
  let cuotaAdmin: number | null = null;
  const cuota = numero(c.cuota_administracion);
  if (cuota != null && (Number.isNaN(cuota) || cuota < 0 || cuota >= 100_000_000)) motivos.push('«Cuota de administración»: valor no válido.');
  else cuotaAdmin = cuota;
  if (pagaAdmin && pagaAdmin !== 'No aplica' && !cuotaAdmin)
    advertencias.push('Indica quién paga la administración pero no su valor.');

  // Declaraciones (§1.2.2-§1.2.4)
  const alDia = reqSiNo('al_dia');
  const mora = reqSiNo('mora_reciente');
  const plantilla = reqSiNo('plantilla_entregada');
  if (alDia === false) motivos.push('Contrato declarado en mora a la fecha de migración.');
  if (mora === true) motivos.push(`Contrato con mora declarada en los últimos ${p.MESES_SIN_MORA_REQUERIDOS} meses.`);

  if (faltan.length) motivos.unshift(`Campos obligatorios incompletos: ${faltan.join(', ')}.`);

  // Reportabilidad y tarifa (§5.1-§5.2), por contrato.
  let reportable: boolean | null = null;
  let reportableMotivo: string | null = null;
  let tarifa: number | null = null;
  if (destinacion && ctx.habilitaciones[destinacion] && plantilla !== null) {
    if (plantilla === false) {
      reportable = false;
      reportableMotivo = 'formato_anterior';
      advertencias.push('Firmado sobre un formato anterior al revisado: queda NO REPORTABLE salvo verificación individual del contrato.');
    } else if (ctx.habilitaciones[destinacion]!.habeas_subrogatario !== true) {
      reportable = false;
      reportableMotivo = 'plantilla_sin_autorizacion';
    } else reportable = true;
    tarifa = Math.round((p.TARIFA_MIGRACION_REPORTABLE + (reportable ? 0 : p.RECARGO_NO_REPORTABLE)) * 100) / 100;
  }

  const datos: DatosFila = {
    direccion,
    municipio: municipio?.name ?? municipioTxt,
    departamento: municipio?.department.name ?? null,
    codigo_interno: codigoInterno,
    destinacion,
    tipo_inmueble: tipoInmueble,
    estrato,
    canon,
    iva_canon_pct: iva,
    cuota_administracion: cuotaAdmin,
    ...(tarifa != null ? { tarifa_base_pct: p.TARIFA_MIGRACION_REPORTABLE } : {}),
    fecha_inicio: inicio,
    fecha_vencimiento: vence,
    arrendatario: {
      tipo_persona: tipoPersona,
      nombre,
      apellido: tipoPersona === 'juridica' ? '' : apellido ?? '',
      razon_social: tipoPersona === 'juridica' ? nombre : null,
      tipo_documento: tipoDoc,
      numero_documento: documento,
      celular: celular ? telefonoNormalizado(celular) : null,
      email: email?.toLowerCase() ?? null,
    },
    coarrendatarios,
    paga_servicios: pagaServicios,
    paga_administracion: pagaAdmin,
    declaraciones: { al_dia: alDia, mora_reciente: mora, plantilla_entregada: plantilla },
    observaciones: texto(c.observaciones),
  };

  return {
    n_fila: fila.n_fila,
    resultado: motivos.length ? 'rechazada' : advertencias.length ? 'advertencia' : 'aceptada',
    motivos,
    advertencias,
    datos,
    clave_inmueble: direccion && municipio ? claveInmueble(direccion, municipio.name) : null,
    documento_arrendatario: documento,
    reportable,
    reportable_motivo: reportableMotivo,
    tarifa_pct: tarifa,
  };
}

/** Valida el archivo completo: cada fila + inmuebles repetidos dentro del mismo archivo. */
export function validarFilas(filas: FilaArchivo[], ctx: ContextoValidacion): ResultadoFila[] {
  const resultados = filas.map((f) => validarFila(f, ctx));
  const vistas = new Map<string, number>();
  for (const r of resultados) {
    if (!r.clave_inmueble) continue;
    const previa = vistas.get(r.clave_inmueble);
    if (previa === undefined) vistas.set(r.clave_inmueble, r.n_fila);
    else aplicarConflicto(r, { motivo: `Inmueble repetido en el archivo (también en la fila ${previa}).` });
  }
  return resultados;
}

export interface Conflicto {
  motivo?: string;
  advertencia?: string;
  /** Inmueble existente de la org al que se vinculará el contrato. */
  inmueble_id?: string;
}

/** Suma a una fila lo que encontró el cruce contra la base y recalcula el resultado. */
export function aplicarConflicto(r: ResultadoFila, k: Conflicto): void {
  if (k.motivo) r.motivos.push(k.motivo);
  if (k.advertencia) r.advertencias.push(k.advertencia);
  if (k.inmueble_id) r.datos.inmueble_id = k.inmueble_id;
  r.resultado = r.motivos.length ? 'rechazada' : r.advertencias.length ? 'advertencia' : 'aceptada';
}

/** Exposición del lote (§8): 18 cánones por contrato aceptado. */
export const exposicionDe = (resultados: ResultadoFila[]): number =>
  resultados.filter((r) => r.resultado !== 'rechazada').reduce((s, r) => s + 18 * (r.datos.canon ?? 0), 0);

/**
 * % mensual vigente de un contrato migrado (A8): tarifa_pct desde tarifa_desde;
 * antes de esa fecha rige la del acta (el único cambio es el paso a REPORTABLE,
 * §5.2.5, que fija tarifa_desde al primer día del mes siguiente).
 */
export function tarifaVigenteMigracion(
  f: { tarifa_pct: number | string | null; tarifa_acta_pct: number | string | null; tarifa_desde: string | null },
  hoy: string,
): number | null {
  const pct = Number(f.tarifa_desde && f.tarifa_desde > hoy ? f.tarifa_acta_pct : f.tarifa_pct);
  return pct > 0 ? pct : null;
}

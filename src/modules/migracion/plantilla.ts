// ============================================================
// Plantilla de migración de cartera (spec §2.1-§2.2).
//
// COLUMNAS es la ÚNICA definición del archivo: la plantilla descargable, la
// lectura del archivo diligenciado y el reporte de validación salen de aquí.
// El archivo se lee por POSICIÓN y se exige que cada encabezado coincida
// (§2.1: no se admiten archivos con estructura propia de la inmobiliaria).
// ============================================================

import ExcelJS from 'exceljs';
import { AppError } from '@/lib/errors';

export const SI_NO = ['Sí', 'No'] as const;
export const DESTINACIONES = ['Vivienda', 'Comercial'] as const;
export const TIPOS_PERSONA_ARCHIVO = ['Natural', 'Jurídica'] as const;
export const TIPOS_DOCUMENTO_ARCHIVO = ['CC', 'CE', 'PPT', 'PEP', 'Pasaporte', 'NIT'] as const;
// Mismo orden y valores que TIPOS_INMUEBLE (inmuebles.schema.ts), en palabras.
export const TIPOS_INMUEBLE_ARCHIVO = [
  'Apartamento', 'Casa', 'Oficina', 'Local', 'Bodega',
  'Apartaestudio', 'Casa finca', 'Finca', 'Lote', 'Parqueadero',
] as const;
export const PAGADORES_SERVICIOS = ['Arrendatario', 'Arrendador'] as const;
export const PAGADORES_ADMINISTRACION = ['Arrendatario', 'Arrendador', 'No aplica'] as const;

interface Columna {
  clave: string;
  encabezado: string;
  ancho: number;
  lista?: readonly string[];
  tipo?: 'fecha' | 'numero' | 'entero';
}

const coarrendatario = (n: 1 | 2): Columna[] => [
  { clave: `coarrendatario${n}_nombre`, encabezado: `Coarrendatario ${n}: nombre completo`, ancho: 30 },
  { clave: `coarrendatario${n}_tipo_documento`, encabezado: `Coarrendatario ${n}: tipo de documento`, ancho: 16, lista: TIPOS_DOCUMENTO_ARCHIVO },
  { clave: `coarrendatario${n}_numero_documento`, encabezado: `Coarrendatario ${n}: número de documento`, ancho: 18 },
  { clave: `coarrendatario${n}_celular`, encabezado: `Coarrendatario ${n}: celular`, ancho: 16 },
  { clave: `coarrendatario${n}_email`, encabezado: `Coarrendatario ${n}: correo electrónico`, ancho: 28 },
];

// ponytail: dos coarrendatarios por fila; un tercero va en Observaciones hasta que aparezca el caso.
export const COLUMNAS: readonly Columna[] = [
  { clave: 'direccion', encabezado: 'Dirección del inmueble', ancho: 36 },
  { clave: 'municipio', encabezado: 'Municipio', ancho: 22 },
  { clave: 'codigo_interno', encabezado: 'Código interno del inmueble', ancho: 18 },
  { clave: 'destinacion', encabezado: 'Destinación', ancho: 14, lista: DESTINACIONES },
  { clave: 'tipo_inmueble', encabezado: 'Tipo de inmueble', ancho: 16, lista: TIPOS_INMUEBLE_ARCHIVO },
  { clave: 'estrato', encabezado: 'Estrato', ancho: 9, tipo: 'entero' },
  { clave: 'arrendatario_tipo_persona', encabezado: 'Arrendatario: tipo de persona', ancho: 16, lista: TIPOS_PERSONA_ARCHIVO },
  { clave: 'arrendatario_nombre', encabezado: 'Arrendatario: nombres o razón social', ancho: 30 },
  { clave: 'arrendatario_apellido', encabezado: 'Arrendatario: apellidos', ancho: 24 },
  { clave: 'arrendatario_tipo_documento', encabezado: 'Arrendatario: tipo de documento', ancho: 16, lista: TIPOS_DOCUMENTO_ARCHIVO },
  { clave: 'arrendatario_numero_documento', encabezado: 'Arrendatario: número de documento', ancho: 18 },
  { clave: 'arrendatario_celular', encabezado: 'Arrendatario: celular', ancho: 16 },
  { clave: 'arrendatario_email', encabezado: 'Arrendatario: correo electrónico', ancho: 28 },
  ...coarrendatario(1),
  ...coarrendatario(2),
  { clave: 'canon', encabezado: 'Canon mensual vigente sin IVA (COP)', ancho: 18, tipo: 'numero' },
  { clave: 'iva_canon_pct', encabezado: 'IVA del canon (%)', ancho: 12, tipo: 'numero' },
  { clave: 'fecha_inicio', encabezado: 'Fecha de inicio del contrato', ancho: 16, tipo: 'fecha' },
  { clave: 'fecha_vencimiento', encabezado: 'Fecha de vencimiento del contrato', ancho: 16, tipo: 'fecha' },
  { clave: 'paga_servicios', encabezado: 'Quién paga los servicios públicos', ancho: 16, lista: PAGADORES_SERVICIOS },
  { clave: 'paga_administracion', encabezado: 'Quién paga la cuota de administración', ancho: 16, lista: PAGADORES_ADMINISTRACION },
  { clave: 'cuota_administracion', encabezado: 'Valor de la cuota de administración (COP)', ancho: 18, tipo: 'numero' },
  { clave: 'al_dia', encabezado: '¿El contrato está al día en el canon a la fecha?', ancho: 14, lista: SI_NO },
  // El número sale de MESES_SIN_MORA_REQUERIDOS; al comparar encabezados se ignoran los dígitos.
  { clave: 'mora_reciente', encabezado: '¿Tuvo mora en los últimos {meses} meses?', ancho: 14, lista: SI_NO },
  { clave: 'plantilla_entregada', encabezado: '¿Se firmó sobre la plantilla de contrato entregada a Cofianza?', ancho: 16, lista: SI_NO },
  { clave: 'observaciones', encabezado: 'Observaciones', ancho: 40 },
];

export type ValorCelda = string | number | boolean | Date | null;

export interface FilaArchivo {
  /** Número de la fila en la hoja (la primera de datos es la 2), el que ve el analista. */
  n_fila: number;
  celdas: Record<string, ValorCelda>;
}

const HOJA = 'Contratos';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const encabezado = (c: Columna, meses: number) => c.encabezado.replace('{meses}', String(meses));
// Sin tildes, sin dígitos, sin espacios repetidos: la comparación tolera el número de meses.
const normEncabezado = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ\d]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// ── Ayuda de cada columna (solo presentación: no cambia encabezados ni lectura) ──

type Seccion = 'inmueble' | 'arrendatario' | 'coarrendatarios' | 'contrato' | 'declaraciones' | 'notas';
type Obligatoria = 'Sí' | 'No' | 'Condicional';
interface Ayuda {
  seccion: Seccion;
  obligatoria: Obligatoria;
  /** Qué escribir, en una o dos frases (va en la nota del encabezado y en el mensaje al escribir). */
  ayuda: string;
  ejemplo: string;
}

// Colores por sección: fuerte para el encabezado obligatorio, suave para el opcional.
const SECCIONES: Record<Seccion, { nombre: string; fuerte: string; suave: string }> = {
  inmueble: { nombre: 'Inmueble', fuerte: 'FF1D4ED8', suave: 'FFDBEAFE' },
  arrendatario: { nombre: 'Arrendatario', fuerte: 'FF047857', suave: 'FFD1FAE5' },
  coarrendatarios: { nombre: 'Coarrendatarios (si los hay)', fuerte: 'FF6D28D9', suave: 'FFEDE9FE' },
  contrato: { nombre: 'Contrato y valores', fuerte: 'FFB45309', suave: 'FFFEF3C7' },
  declaraciones: { nombre: 'Declaraciones', fuerte: 'FFB91C1C', suave: 'FFFEE2E2' },
  notas: { nombre: 'Observaciones', fuerte: 'FF374151', suave: 'FFF3F4F6' },
};

const coa = (n: 1 | 2): Record<string, Ayuda> => ({
  [`coarrendatario${n}_nombre`]: { seccion: 'coarrendatarios', obligatoria: 'Condicional', ayuda: 'Solo si el contrato tiene coarrendatario. Nombre y apellidos completos.', ejemplo: n === 1 ? 'Carlos Gómez Ruiz' : '' },
  [`coarrendatario${n}_tipo_documento`]: { seccion: 'coarrendatarios', obligatoria: 'Condicional', ayuda: 'Obligatorio si escribió el nombre. Elija de la lista.', ejemplo: n === 1 ? 'CC' : '' },
  [`coarrendatario${n}_numero_documento`]: { seccion: 'coarrendatarios', obligatoria: 'Condicional', ayuda: 'Obligatorio si escribió el nombre. Sin puntos ni espacios.', ejemplo: n === 1 ? '71234567' : '' },
  [`coarrendatario${n}_celular`]: { seccion: 'coarrendatarios', obligatoria: 'Condicional', ayuda: 'Celular o correo: al menos uno de los dos. 10 dígitos, sin +57.', ejemplo: n === 1 ? '3109876543' : '' },
  [`coarrendatario${n}_email`]: { seccion: 'coarrendatarios', obligatoria: 'Condicional', ayuda: 'Celular o correo: al menos uno de los dos.', ejemplo: n === 1 ? 'carlos@correo.com' : '' },
});

const AYUDA: Record<string, Ayuda> = {
  direccion: { seccion: 'inmueble', obligatoria: 'Sí', ayuda: 'Dirección completa, con apartamento o local si aplica.', ejemplo: 'Calle 10 # 43A-30, apto 501' },
  municipio: { seccion: 'inmueble', obligatoria: 'Sí', ayuda: 'Municipio del inmueble. Si el nombre existe en varios departamentos, escriba «Municipio, Departamento».', ejemplo: 'Medellín' },
  codigo_interno: { seccion: 'inmueble', obligatoria: 'No', ayuda: 'El código con el que usted identifica el inmueble, si tiene uno.', ejemplo: 'APT-501' },
  destinacion: { seccion: 'inmueble', obligatoria: 'Sí', ayuda: 'Elija de la lista: Vivienda o Comercial.', ejemplo: 'Vivienda' },
  tipo_inmueble: { seccion: 'inmueble', obligatoria: 'Sí', ayuda: 'Elija de la lista.', ejemplo: 'Apartamento' },
  estrato: { seccion: 'inmueble', obligatoria: 'Sí', ayuda: 'Número del 1 al 6 (7 si aplica).', ejemplo: '4' },
  arrendatario_tipo_persona: { seccion: 'arrendatario', obligatoria: 'Sí', ayuda: 'Natural (una persona) o Jurídica (una empresa).', ejemplo: 'Natural' },
  arrendatario_nombre: { seccion: 'arrendatario', obligatoria: 'Sí', ayuda: 'Persona: sus nombres. Empresa: la razón social completa.', ejemplo: 'Ana María' },
  arrendatario_apellido: { seccion: 'arrendatario', obligatoria: 'Condicional', ayuda: 'Obligatorio para persona natural. Para empresa déjelo vacío.', ejemplo: 'Pérez López' },
  arrendatario_tipo_documento: { seccion: 'arrendatario', obligatoria: 'Sí', ayuda: 'Elija de la lista. Una empresa se identifica con NIT.', ejemplo: 'CC' },
  arrendatario_numero_documento: { seccion: 'arrendatario', obligatoria: 'Sí', ayuda: 'Sin puntos ni espacios. NIT con o sin dígito de verificación.', ejemplo: '1020304050' },
  arrendatario_celular: { seccion: 'arrendatario', obligatoria: 'Sí', ayuda: 'Celular de Colombia de 10 dígitos, sin +57.', ejemplo: '3001234567' },
  arrendatario_email: { seccion: 'arrendatario', obligatoria: 'Sí', ayuda: 'Correo electrónico del arrendatario.', ejemplo: 'ana.perez@correo.com' },
  ...coa(1),
  ...coa(2),
  canon: { seccion: 'contrato', obligatoria: 'Sí', ayuda: 'Canon mensual que paga hoy, en pesos, SIN IVA y sin puntos. {topes}.', ejemplo: '1800000' },
  iva_canon_pct: { seccion: 'contrato', obligatoria: 'Condicional', ayuda: 'Solo para comercial: porcentaje de IVA del canon (por ejemplo 19). En vivienda déjelo vacío.', ejemplo: '' },
  fecha_inicio: { seccion: 'contrato', obligatoria: 'Sí', ayuda: 'Fecha en que empezó el contrato (DD/MM/AAAA).', ejemplo: '01/06/2025' },
  fecha_vencimiento: { seccion: 'contrato', obligatoria: 'Sí', ayuda: 'Fecha en que vence el período actual del contrato (DD/MM/AAAA). Si ya se prorrogó, la del período en curso.', ejemplo: '31/05/2026' },
  paga_servicios: { seccion: 'contrato', obligatoria: 'Sí', ayuda: 'Quién paga agua, luz y gas: elija de la lista.', ejemplo: 'Arrendatario' },
  paga_administracion: { seccion: 'contrato', obligatoria: 'Sí', ayuda: 'Quién paga la cuota de administración. «No aplica» si el inmueble no tiene.', ejemplo: 'Arrendador' },
  cuota_administracion: { seccion: 'contrato', obligatoria: 'Condicional', ayuda: 'Valor mensual de la administración en pesos, si aplica.', ejemplo: '250000' },
  al_dia: { seccion: 'declaraciones', obligatoria: 'Sí', ayuda: '¿El arrendatario está al día en el canon hoy? Sí o No. Si es No, el contrato no se puede migrar.', ejemplo: 'Sí' },
  mora_reciente: { seccion: 'declaraciones', obligatoria: 'Sí', ayuda: '¿Se atrasó en algún pago en los últimos meses indicados? Sí o No. Si es Sí, no se puede migrar.', ejemplo: 'No' },
  plantilla_entregada: { seccion: 'declaraciones', obligatoria: 'Sí', ayuda: '¿El contrato se firmó con la misma plantilla que entregó a Cofianza? Si es No, queda NO REPORTABLE (tarifa +0,5 puntos).', ejemplo: 'Sí' },
  observaciones: { seccion: 'notas', obligatoria: 'No', ayuda: 'Cualquier dato que debamos saber de este contrato (por ejemplo, un tercer coarrendatario).', ejemplo: '' },
};

/** Columnas que se escriben como texto: sin esto Excel quita ceros o las pasa a notación científica. */
const COMO_TEXTO = /numero_documento|celular|codigo_interno/;

// Ejemplos completos (hoja «Ejemplo»): una persona natural en vivienda y una empresa en comercial.
const EJEMPLO_COMERCIAL: Record<string, string> = {
  direccion: 'Carrera 50 # 52-30, local 102', municipio: 'Itagüí', codigo_interno: 'LOC-102', destinacion: 'Comercial',
  tipo_inmueble: 'Local', estrato: '4', arrendatario_tipo_persona: 'Jurídica', arrendatario_nombre: 'Panadería La Esquina S.A.S.',
  arrendatario_apellido: '', arrendatario_tipo_documento: 'NIT', arrendatario_numero_documento: '901234567-8',
  arrendatario_celular: '3157654321', arrendatario_email: 'gerencia@laesquina.com', canon: '3500000', iva_canon_pct: '19',
  fecha_inicio: '15/01/2024', fecha_vencimiento: '14/01/2027', paga_servicios: 'Arrendatario', paga_administracion: 'No aplica',
  cuota_administracion: '', al_dia: 'Sí', mora_reciente: 'No', plantilla_entregada: 'No', observaciones: 'Contrato firmado con un formato anterior.',
};

const blanco = { argb: 'FFFFFFFF' };
const borde: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFD1D5DB' } }, bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  left: { style: 'thin', color: { argb: 'FFD1D5DB' } }, right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
};

function pintarEncabezados(hoja: ExcelJS.Worksheet, meses: number, conNotas: boolean, conTopes: (t: string) => string = (t) => t): void {
  const fila = hoja.getRow(1);
  fila.height = 64;
  COLUMNAS.forEach((c, i) => {
    const a = AYUDA[c.clave];
    const sec = SECCIONES[a.seccion];
    const celda = fila.getCell(i + 1);
    const fuerte = a.obligatoria === 'Sí';
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fuerte ? sec.fuerte : sec.suave } };
    celda.font = { bold: true, color: fuerte ? blanco : { argb: sec.fuerte }, size: 10 };
    celda.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    celda.border = borde;
    if (conNotas)
      celda.note = {
        texts: [
          { font: { bold: true }, text: `${sec.nombre} · ${a.obligatoria === 'Sí' ? 'Obligatoria' : a.obligatoria === 'No' ? 'Opcional' : 'Obligatoria según el caso'}\n` },
          { text: `${conTopes(a.ayuda.replace('los últimos meses indicados', `los últimos ${meses} meses`))}${a.ejemplo ? `\nEjemplo: ${a.ejemplo}` : ''}` },
        ],
      };
  });
}

function formatoColumnas(hoja: ExcelJS.Worksheet): void {
  COLUMNAS.forEach((c, i) => {
    const col = hoja.getColumn(i + 1);
    if (c.tipo === 'fecha') col.numFmt = 'dd/mm/yyyy';
    else if (c.tipo === 'numero') col.numFmt = '#,##0';
    else if (COMO_TEXTO.test(c.clave)) col.numFmt = '@';
  });
}

/** Plantilla descargable (§2.1): instrucciones, la hoja para diligenciar con ayudas y un ejemplo. */
export async function generarPlantilla(opts: {
  meses: number;
  maxFilas: number;
  /** Topes de canon sin IVA (calibración); sin ellos el texto no menciona cifras. */
  topeVivienda?: number;
  topeComercial?: number;
}): Promise<Buffer> {
  const pesos = (n: number) => `$${n.toLocaleString('es-CO')}`;
  const topes =
    opts.topeVivienda && opts.topeComercial
      ? `Tope: vivienda ${pesos(opts.topeVivienda)} y comercial ${pesos(opts.topeComercial)} al mes`
      : 'Hay un tope de canon por destinación';
  const conTopes = (t: string) => t.replace('{topes}', topes);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Cofianza';

  // 1. Instrucciones (primera hoja: es lo primero que ve quien abre el archivo).
  const ayuda = wb.addWorksheet('Instrucciones', { properties: { tabColor: { argb: 'FF047857' } }, views: [{ showGridLines: false }] });
  ayuda.columns = [{ width: 4 }, { width: 38 }, { width: 16 }, { width: 70 }, { width: 30 }];
  // Para imprimir: todo el ancho en una página.
  ayuda.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  let r = 1;
  const linea = (texto: string, estilo: Partial<ExcelJS.Font> = {}, alto?: number) => {
    ayuda.mergeCells(r, 2, r, 5);
    const c = ayuda.getCell(r, 2);
    c.value = texto;
    c.font = { size: 11, ...estilo };
    c.alignment = { wrapText: true, vertical: 'top' };
    if (alto) ayuda.getRow(r).height = alto;
    r++;
  };
  linea('Plantilla de migración de cartera — Cofianza', { bold: true, size: 18, color: { argb: 'FF047857' } }, 30);
  linea('Con este archivo usted le pasa a Cofianza sus contratos de arrendamiento que ya están firmados y vigentes, para que Cofianza sea su fiador desde la firma del Acta de Migración.', { color: { argb: 'FF4B5563' } }, 32);
  r++;
  linea('Cómo diligenciarla', { bold: true, size: 13 });
  [
    '1. Vaya a la hoja «Contratos» y escriba UN contrato por fila, empezando en la fila 2.',
    '2. No cambie, mueva ni borre columnas, ni el nombre de las hojas. Si lo hace, el archivo no se podrá cargar.',
    '3. Al pararse en el título de una columna verá una nota con lo que debe escribir y un ejemplo. Al escribir en una celda también aparece una ayuda.',
    '4. Las columnas con listas (Sí/No, Vivienda/Comercial, tipo de documento…) tienen una flecha: elija el valor de la lista.',
    '5. Revise la hoja «Ejemplo»: tiene dos contratos llenos como guía (no la llene; no se carga).',
    `6. Máximo ${opts.maxFilas} contratos por archivo. Si tiene más, divídalos en varios archivos.`,
    '7. Guarde el archivo en formato Excel (.xlsx) y envíelo a Cofianza.',
  ].forEach((t) => linea(t, {}, 30));
  r++;
  linea('Colores de los títulos', { bold: true, size: 13 });
  for (const s of Object.values(SECCIONES)) {
    const c = ayuda.getCell(r, 2);
    c.value = s.nombre;
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.fuerte } };
    c.font = { bold: true, color: blanco };
    c.border = borde;
    ayuda.getCell(r, 3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.suave } };
    ayuda.getCell(r, 3).border = borde;
    r++;
  }
  linea('Color fuerte = columna obligatoria. Color suave = opcional u obligatoria solo en algunos casos.', { italic: true, color: { argb: 'FF4B5563' } });
  r++;
  linea('Antes de enviarla, tenga en cuenta', { bold: true, size: 13 });
  [
    'Solo se migran contratos vigentes, al día en el canon y SIN atrasos en los últimos ' + opts.meses + ' meses.',
    'El canon va SIN IVA. {topes}; los que lo superen se rechazan.',
    'No se aceptan inmuebles de destinación mixta, contratos ya vencidos ni inmuebles que ya tengan fianza de Cofianza.',
    'Las tres declaraciones (al día, sin mora y plantilla) se imprimen en el Acta de Migración que firma el representante legal. Declarar algo falso deja ese contrato sin cobertura.',
    'Si un contrato se firmó con un formato distinto al que entregó a Cofianza, márquelo «No» en la última declaración: queda NO REPORTABLE y su tarifa sube 0,5 puntos.',
  ].forEach((t) => linea(`• ${conTopes(t)}`, {}, 30));
  r++;
  linea('Qué va en cada columna', { bold: true, size: 13 });
  ['Columna', 'Obligatoria', 'Qué escribir', 'Ejemplo'].forEach((t, i) => {
    const c = ayuda.getCell(r, i + 2);
    c.value = t;
    c.font = { bold: true, color: blanco };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
    c.border = borde;
  });
  r++;
  COLUMNAS.forEach((col) => {
    const a = AYUDA[col.clave];
    const sec = SECCIONES[a.seccion];
    const vals = [
      encabezado(col, opts.meses),
      a.obligatoria === 'Condicional' ? 'Según el caso' : a.obligatoria,
      conTopes(a.ayuda.replace('los últimos meses indicados', `los últimos ${opts.meses} meses`)) + (col.lista ? `\nOpciones: ${col.lista.join(', ')}.` : ''),
      a.ejemplo,
    ];
    vals.forEach((v, i) => {
      const c = ayuda.getCell(r, i + 2);
      c.value = v;
      c.alignment = { wrapText: true, vertical: 'top' };
      c.border = borde;
      if (i === 0) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sec.suave } };
    });
    ayuda.getRow(r).height = col.lista ? 44 : 32;
    r++;
  });

  // 2. Contratos: la hoja que se carga (§2.1). Encabezados en la fila 1, datos desde la 2.
  const hoja = wb.addWorksheet(HOJA, { properties: { tabColor: { argb: 'FFF97316' } }, views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  hoja.columns = COLUMNAS.map((c) => ({ header: encabezado(c, opts.meses), key: c.clave, width: Math.max(c.ancho, 18) }));
  pintarEncabezados(hoja, opts.meses, true, conTopes);
  formatoColumnas(hoja);

  COLUMNAS.forEach((c, i) => {
    const a = AYUDA[c.clave];
    // Mensaje al pararse en la celda (Excel lo corta en 255 caracteres).
    const prompt = `${conTopes(a.ayuda.replace('los últimos meses indicados', `los últimos ${opts.meses} meses`))}${a.ejemplo ? ` Ej.: ${a.ejemplo}` : ''}`.slice(0, 250);
    let validacion: ExcelJS.DataValidation;
    if (c.lista) {
      validacion = {
        type: 'list', allowBlank: true, formulae: [`"${c.lista.join(',')}"`],
        showErrorMessage: true, errorTitle: 'Valor no permitido', error: `Elija un valor de la lista: ${c.lista.join(', ')}.`,
      };
    } else if (c.tipo === 'fecha') {
      validacion = {
        type: 'date', operator: 'greaterThan', allowBlank: true, formulae: [new Date(Date.UTC(1990, 0, 1))],
        showErrorMessage: true, errorTitle: 'Fecha no válida', error: 'Escriba una fecha válida en formato DD/MM/AAAA.',
      };
    } else {
      validacion = { type: 'any', allowBlank: true } as unknown as ExcelJS.DataValidation;
    }
    validacion.showInputMessage = true;
    validacion.promptTitle = c.encabezado.replace('{meses}', String(opts.meses)).slice(0, 32);
    validacion.prompt = prompt;
    for (let f = 2; f <= opts.maxFilas + 1; f++) hoja.getCell(f, i + 1).dataValidation = validacion;
  });

  // 3. Ejemplo: misma estructura con dos contratos llenos (no se lee al cargar).
  const ej = wb.addWorksheet('Ejemplo', { properties: { tabColor: { argb: 'FF9CA3AF' } }, views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  ej.columns = COLUMNAS.map((c) => ({ header: encabezado(c, opts.meses), key: c.clave, width: Math.max(c.ancho, 18) }));
  pintarEncabezados(ej, opts.meses, false);
  [Object.fromEntries(COLUMNAS.map((c) => [c.clave, AYUDA[c.clave].ejemplo])), EJEMPLO_COMERCIAL].forEach((datos) => {
    const fila = ej.addRow(datos);
    fila.eachCell((celda) => {
      celda.font = { color: { argb: 'FF6B7280' }, italic: true };
      celda.border = borde;
    });
  });

  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function valorCelda(v: ExcelJS.CellValue): ValorCelda {
  if (v == null) return null;
  if (v instanceof Date || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim() || null;
  if ('richText' in v) return v.richText.map((t) => t.text).join('').trim() || null;
  if ('formula' in v || 'sharedFormula' in v) return valorCelda((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
  if ('text' in v) return valorCelda(v.text as ExcelJS.CellValue);
  return null; // error de fórmula u otro tipo: como vacía
}

/**
 * Lee el archivo diligenciado. 400 si no es la plantilla de Cofianza. Omite las
 * filas vacías y corta apenas pasa de `max` contratos (§2.4.6).
 */
export async function leerArchivo(buffer: Buffer, max = Infinity): Promise<FilaArchivo[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw AppError.badRequest('No se pudo leer el archivo. Cárguelo en formato Excel (.xlsx).', 'MIGRACION_ARCHIVO_ILEGIBLE');
  }
  const hoja = wb.getWorksheet(HOJA) ?? wb.worksheets[0];
  if (!hoja) throw AppError.badRequest('El archivo no tiene hojas.', 'MIGRACION_PLANTILLA_INVALIDA');

  COLUMNAS.forEach((c, i) => {
    const leido = String(valorCelda(hoja.getCell(1, i + 1).value) ?? '');
    if (normEncabezado(leido) !== normEncabezado(c.encabezado.replace('{meses}', '')))
      throw AppError.badRequest(
        `El archivo no tiene la estructura de la plantilla de Cofianza: la columna ${i + 1} debería ser «${c.encabezado.replace('{meses}', 'N')}» y dice «${leido || '(vacía)'}». Descargue la plantilla vigente.`,
        'MIGRACION_PLANTILLA_INVALIDA',
      );
  });

  // eachRow (no getCell hasta rowCount): una celda con formato en la fila 1.048.576
  // haría instanciar un millón de filas antes de llegar al tope.
  const filas: FilaArchivo[] = [];
  hoja.eachRow({ includeEmpty: false }, (row, r) => {
    if (r === 1) return;
    const celdas: Record<string, ValorCelda> = {};
    let vacia = true;
    COLUMNAS.forEach((c, i) => {
      const v = valorCelda(row.getCell(i + 1).value);
      celdas[c.clave] = v;
      if (v !== null) vacia = false;
    });
    if (vacia) return;
    filas.push({ n_fila: r, celdas });
    if (filas.length > max)
      throw AppError.badRequest(
        `El archivo tiene más de ${max} contratos y el máximo por carga es ${max}. Divídalo en varios lotes.`,
        'MIGRACION_ARCHIVO_GRANDE',
      );
  });
  return filas;
}

export interface FilaReporte {
  n_fila: number;
  resultado: string;
  motivos: string[];
  advertencias: string[];
  reportable: boolean | null;
  tarifa_pct: number | null;
}

/** Reporte descargable de la validación (§2.4.1-§2.4.2): el resultado por fila + los datos tal como llegaron. */
export async function generarReporte(
  filas: FilaArchivo[],
  resultados: FilaReporte[],
  meses: number,
): Promise<{ buffer: Buffer; contentType: string }> {
  const porFila = new Map(resultados.map((r) => [r.n_fila, r]));
  const wb = new ExcelJS.Workbook();
  const hoja = wb.addWorksheet('Resultado', { views: [{ state: 'frozen', ySplit: 1 }] });
  hoja.columns = [
    { header: 'Fila', key: '_fila', width: 6 },
    { header: 'Resultado', key: '_resultado', width: 14 },
    { header: 'Motivos de rechazo', key: '_motivos', width: 50 },
    { header: 'Advertencias', key: '_advertencias', width: 50 },
    { header: 'Reportable', key: '_reportable', width: 12 },
    { header: 'Tarifa mensual (%)', key: '_tarifa', width: 12 },
    ...COLUMNAS.map((c) => ({ header: encabezado(c, meses), key: c.clave, width: c.ancho })),
  ];
  hoja.getRow(1).font = { bold: true };
  const ETIQUETA: Record<string, string> = { aceptada: 'Aceptable', advertencia: 'Con advertencia', rechazada: 'Rechazada' };
  for (const f of filas) {
    const r = porFila.get(f.n_fila);
    hoja.addRow({
      _fila: f.n_fila,
      _resultado: r ? ETIQUETA[r.resultado] ?? r.resultado : '',
      _motivos: r?.motivos.join('\n') ?? '',
      _advertencias: r?.advertencias.join('\n') ?? '',
      _reportable: r?.reportable == null ? '' : r.reportable ? 'Sí' : 'No',
      _tarifa: r?.tarifa_pct ?? '',
      ...f.celdas,
    });
  }
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), contentType: XLSX };
}

export const CONTENT_TYPE_XLSX = XLSX;

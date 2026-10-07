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

/** Plantilla descargable (§2.1) con listas desplegables en las columnas cerradas. */
export async function generarPlantilla(opts: { meses: number; maxFilas: number }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const hoja = wb.addWorksheet(HOJA, { views: [{ state: 'frozen', ySplit: 1 }] });
  hoja.columns = COLUMNAS.map((c) => ({ header: encabezado(c, opts.meses), key: c.clave, width: c.ancho }));
  const cab = hoja.getRow(1);
  cab.font = { bold: true };
  cab.alignment = { wrapText: true, vertical: 'middle' };
  cab.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };

  COLUMNAS.forEach((c, i) => {
    let validacion: ExcelJS.DataValidation | null = null;
    if (c.lista) {
      validacion = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${c.lista.join(',')}"`],
        showErrorMessage: true,
        errorTitle: 'Valor no permitido',
        error: `Elija un valor de la lista: ${c.lista.join(', ')}.`,
      };
    } else if (c.tipo === 'fecha') {
      validacion = {
        type: 'date',
        operator: 'greaterThan',
        allowBlank: true,
        formulae: [new Date(Date.UTC(1990, 0, 1))],
        showErrorMessage: true,
        error: 'Escriba una fecha válida (AAAA-MM-DD o DD/MM/AAAA).',
      };
    }
    const col = hoja.getColumn(i + 1);
    if (c.tipo === 'fecha') col.numFmt = 'yyyy-mm-dd';
    if (c.tipo === 'numero') col.numFmt = '#,##0';
    if (!validacion) return;
    for (let r = 2; r <= opts.maxFilas + 1; r++) hoja.getCell(r, i + 1).dataValidation = validacion;
  });

  const ayuda = wb.addWorksheet('Instrucciones');
  ayuda.getColumn(1).width = 120;
  [
    'Plantilla de migración de cartera — Cofianza',
    'Diligencie una fila por contrato en la hoja «Contratos». No cambie el orden ni el nombre de las columnas.',
    `Máximo ${opts.maxFilas} contratos por archivo. Si su cartera es mayor, divídala en varios archivos.`,
    'Fechas en formato AAAA-MM-DD o DD/MM/AAAA. Valores en pesos, sin decimales; el canon va SIN IVA.',
    'Municipio: si el nombre se repite en varios departamentos, escríbalo como «Municipio, Departamento».',
    'Persona jurídica: escriba la razón social en «nombres o razón social», deje vacíos los apellidos y use NIT.',
    'IVA del canon: solo aplica a destinación comercial. Si lo deja vacío se toma 0 %.',
    'Coarrendatarios: diligencie nombre, documento y al menos un dato de contacto de cada uno, si existen.',
    'Las tres declaraciones (al día, mora y plantilla) son obligatorias y se imprimen en el Acta de Migración que firma el representante legal.',
  ].forEach((t, i) => {
    ayuda.getCell(i + 1, 1).value = t;
    if (i === 0) ayuda.getCell(1, 1).font = { bold: true, size: 13 };
  });

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

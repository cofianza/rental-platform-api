// ============================================================
// Export — CSV/XLSX generation utilities (HP-364)
// ============================================================

import ExcelJS from 'exceljs';

const MAX_ROWS = 10000;
const BOM = '\uFEFF';

// ── Types ───────────────────────────────────────────────────

export interface ExportColumn {
  header: string;
  key: string;
  width?: number;
  isCurrency?: boolean;
  isDate?: boolean;
}

export interface ExportResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
  truncated: boolean;
  totalRows: number;
}

// ── Formatters ──────────────────────────────────────────────

function formatDateDDMMYYYY(val: unknown): string {
  if (!val || typeof val !== 'string') return '';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  } catch {
    return String(val);
  }
}

function formatCOP(val: unknown): string {
  const num = typeof val === 'number' ? val : Number(val);
  if (isNaN(num)) return '$0';
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(num);
}

function formatCell(val: unknown, col: ExportColumn): string {
  if (val === null || val === undefined) return '';
  if (col.isDate) return formatDateDDMMYYYY(val);
  if (col.isCurrency) return formatCOP(val);
  return String(val);
}

// ── CSV Generator ───────────────────────────────────────────

export function generateCSV(
  columns: ExportColumn[],
  rows: Record<string, unknown>[],
  entityName: string,
): ExportResult {
  const truncated = rows.length > MAX_ROWS;
  const data = truncated ? rows.slice(0, MAX_ROWS) : rows;

  const headerLine = columns.map((c) => `"${c.header}"`).join(',');
  const dataLines = data.map((row) =>
    columns.map((col) => {
      const formatted = formatCell(row[col.key], col);
      return `"${formatted.replace(/"/g, '""')}"`;
    }).join(','),
  );

  const csv = BOM + [headerLine, ...dataLines].join('\r\n');
  const today = new Date().toISOString().slice(0, 10);

  return {
    buffer: Buffer.from(csv, 'utf-8'),
    filename: `${entityName}_${today}.csv`,
    contentType: 'text/csv; charset=utf-8',
    truncated,
    totalRows: rows.length,
  };
}

// ── XLSX Generator ──────────────────────────────────────────

export async function generateXLSX(
  columns: ExportColumn[],
  rows: Record<string, unknown>[],
  entityName: string,
  sheetName: string,
): Promise<ExportResult> {
  const truncated = rows.length > MAX_ROWS;
  const data = truncated ? rows.slice(0, MAX_ROWS) : rows;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = columns.map((col) => ({
    header: col.header,
    key: col.key,
    width: col.width || 18,
  }));

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF333333' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  headerRow.alignment = { horizontal: 'center' };

  // Add data
  for (const row of data) {
    const rowData: Record<string, unknown> = {};
    for (const col of columns) {
      rowData[col.key] = formatCell(row[col.key], col);
    }
    sheet.addRow(rowData);
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const today = new Date().toISOString().slice(0, 10);

  return {
    buffer,
    filename: `${entityName}_${today}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    truncated,
    totalRows: rows.length,
  };
}

import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { COLUMNAS, generarPlantilla, generarReporte, leerArchivo } from '../plantilla';
import { validarFilas } from '../validacion';

async function diligenciar(plantilla: Buffer, filas: Record<string, unknown>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(plantilla as unknown as ExcelJS.Buffer);
  const hoja = wb.getWorksheet('Contratos')!;
  filas.forEach((f, i) =>
    COLUMNAS.forEach((c, j) => {
      if (f[c.clave] !== undefined) hoja.getCell(i + 2, j + 1).value = f[c.clave] as ExcelJS.CellValue;
    }),
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const CONTRATO = {
  direccion: 'Calle 10 # 20-30',
  municipio: 'Medellín',
  destinacion: 'Vivienda',
  tipo_inmueble: 'Casa',
  estrato: 3,
  arrendatario_tipo_persona: 'Natural',
  arrendatario_nombre: 'Ana',
  arrendatario_apellido: 'Pérez',
  arrendatario_tipo_documento: 'CC',
  arrendatario_numero_documento: '1020304050',
  arrendatario_celular: '3001112233',
  arrendatario_email: 'ana@correo.co',
  canon: 1_800_000,
  fecha_inicio: new Date(Date.UTC(2025, 5, 1)),
  fecha_vencimiento: new Date(Date.UTC(2026, 4, 31)),
  paga_servicios: 'Arrendatario',
  paga_administracion: 'Arrendador',
  cuota_administracion: 250_000,
  al_dia: 'Sí',
  mora_reciente: 'No',
  plantilla_entregada: 'Sí',
};

describe('plantilla de migración (ida y vuelta)', () => {
  it('la plantilla trae una columna por definición y listas desplegables en las cerradas', async () => {
    const buf = await generarPlantilla({ meses: 6, maxFilas: 10 });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const hoja = wb.getWorksheet('Contratos')!;
    expect(hoja.getRow(1).cellCount).toBe(COLUMNAS.length);
    expect(hoja.getCell(1, COLUMNAS.findIndex((c) => c.clave === 'mora_reciente') + 1).value).toBe('¿Tuvo mora en los últimos 6 meses?');
    const dest = hoja.getCell(2, COLUMNAS.findIndex((c) => c.clave === 'destinacion') + 1).dataValidation;
    expect(dest).toMatchObject({ type: 'list', formulae: ['"Vivienda,Comercial"'] });
    expect(wb.getWorksheet('Instrucciones')).toBeDefined();
  });

  it('lo diligenciado se lee igual, omite filas vacías y valida de punta a punta', async () => {
    const buf = await diligenciar(await generarPlantilla({ meses: 6, maxFilas: 10 }), [CONTRATO, {}, { ...CONTRATO, direccion: 'Calle 99 # 1-1', al_dia: 'No' }]);
    const filas = await leerArchivo(buf);
    expect(filas.map((f) => f.n_fila)).toEqual([2, 4]);
    expect(filas[0].celdas).toMatchObject({ direccion: 'Calle 10 # 20-30', estrato: 3, canon: 1_800_000, al_dia: 'Sí', codigo_interno: null });
    expect((filas[0].celdas.fecha_inicio as Date).toISOString().slice(0, 10)).toBe('2025-06-01');

    const rs = validarFilas(filas, {
      hoy: '2026-01-10',
      parametros: { CANON_MAX_TRANSITORIO: 3_000_000, TOPE_CANON_COMERCIAL: 4_000_000, MESES_SIN_MORA_REQUERIDOS: 6, TARIFA_MIGRACION_REPORTABLE: 2, RECARGO_NO_REPORTABLE: 0.5 },
      habilitaciones: { vivienda: { habeas_subrogatario: true } },
      municipios: [{ code: '05001', name: 'Medellín', department: { code: '05', name: 'Antioquia' } }],
    });
    expect(rs.map((r) => r.resultado)).toEqual(['aceptada', 'rechazada']);
    expect(rs[0].datos).toMatchObject({ fecha_inicio: '2025-06-01', fecha_vencimiento: '2026-05-31', cuota_administracion: 250_000 });

    // El reporte conserva los datos y agrega el resultado por fila.
    const { buffer } = await generarReporte(filas, rs, 6);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const hoja = wb.getWorksheet('Resultado')!;
    expect(hoja.getRow(2).getCell(2).value).toBe('Aceptable');
    expect(hoja.getRow(3).getCell(2).value).toBe('Rechazada');
    expect(String(hoja.getRow(3).getCell(3).value)).toContain('en mora a la fecha');
    expect(hoja.getRow(3).getCell(7).value).toBe('Calle 99 # 1-1');
  });

  it('una plantilla generada con otro número de meses sigue siendo válida', async () => {
    const buf = await diligenciar(await generarPlantilla({ meses: 12, maxFilas: 5 }), [CONTRATO]);
    expect(await leerArchivo(buf)).toHaveLength(1);
  });

  it('una fila con formato al final de la hoja no infla la lectura, y pasar el tope corta enseguida', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await diligenciar(await generarPlantilla({ meses: 6, maxFilas: 5 }), [CONTRATO, CONTRATO])) as unknown as ExcelJS.Buffer);
    wb.getWorksheet('Contratos')!.getCell(1_048_576, 1).style = { font: { bold: true } };
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect(await leerArchivo(buf)).toHaveLength(2);
    await expect(leerArchivo(buf, 1)).rejects.toMatchObject({ statusCode: 400, errorCode: 'MIGRACION_ARCHIVO_GRANDE' });
  });

  it('un archivo con estructura propia se rechaza (§2.1)', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Contratos').addRow(['Dirección', 'Ciudad']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(leerArchivo(buf)).rejects.toMatchObject({ statusCode: 400, errorCode: 'MIGRACION_PLANTILLA_INVALIDA' });
    await expect(leerArchivo(Buffer.from('no es excel'))).rejects.toMatchObject({ errorCode: 'MIGRACION_ARCHIVO_ILEGIBLE' });
  });
});

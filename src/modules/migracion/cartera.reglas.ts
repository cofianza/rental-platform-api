// ============================================================
// Reglas puras de la cartera migrada: estado de la spec (§6, derivado según
// A4), cifras del tablero (§8) y liquidación mensual de la tarifa (§4.7).
// Sin base de datos: las prueba cartera.reglas.test.ts.
// ============================================================

import { fechaBogota } from '@/modules/contratos/v3/formato';
import { masIva, pctDe } from '@/modules/estudios/tarifas';
import { tarifaVigenteMigracion } from './validacion';

export type EstadoMigracion =
  | 'rechazado_validacion'
  | 'borrador'
  | 'activa'
  | 'en_revision'
  | 'excluido'
  | 'terminado';

export const ETIQUETA_ESTADO_MIGRACION: Record<EstadoMigracion, string> = {
  rechazado_validacion: 'Rechazado en validación',
  borrador: 'Borrador',
  activa: 'Fianza activa por migración',
  en_revision: 'En revisión',
  excluido: 'Excluido por declaración falsa',
  terminado: 'Terminado',
};

/** Etiqueta de UNA fila: la exclusión por soportes no entregados (§7.3.3) no afirma una declaración falsa. */
export const etiquetaEstado = (estado: EstadoMigracion, excluidoMotivo: string | null): string =>
  estado === 'excluido' && excluidoMotivo === 'auditoria_no_entregada'
    ? 'Excluido por soportes de auditoría no entregados'
    : ETIQUETA_ESTADO_MIGRACION[estado];

export interface FilaParaEstado {
  resultado: string;
  en_revision: boolean;
  excluido_en: string | null;
  /** Estado del contrato creado al activar el lote; null si aún no existe. */
  contrato_estado: string | null;
}

/**
 * A4: el estado de la spec no es columna, se deriva. Rechazada → RECHAZADO EN
 * VALIDACIÓN; aceptada sin contrato → BORRADOR; contrato vigente → FIANZA
 * ACTIVA (EN REVISIÓN si la fila lo está); excluida → EXCLUIDO (la exclusión
 * por auditoría no entregada también es «sin cobertura desde el origen», §7.3.3);
 * cualquier otro final del contrato → TERMINADO.
 */
export function estadoMigracion(f: FilaParaEstado): EstadoMigracion {
  if (f.resultado === 'rechazada') return 'rechazado_validacion';
  if (f.excluido_en) return 'excluido';
  if (!f.contrato_estado) return 'borrador';
  if (f.contrato_estado === 'vigente') return f.en_revision ? 'en_revision' : 'activa';
  return 'terminado';
}

export function contarEstados(estados: EstadoMigracion[]): Record<EstadoMigracion, number> {
  const c = Object.fromEntries(Object.keys(ETIQUETA_ESTADO_MIGRACION).map((k) => [k, 0])) as Record<EstadoMigracion, number>;
  for (const e of estados) c[e]++;
  return c;
}

/** §8.3: exposición = 18 cánones por contrato activo (en revisión no suspende la cobertura). */
export const MESES_EXPOSICION = 18;
export const cubre = (e: EstadoMigracion) => e === 'activa' || e === 'en_revision';

const diasDelMes = (mes: string) => new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();

/** Primer día del mes siguiente a una fecha AAAA-MM-DD (§5.2.5). */
export function primerDiaMesSiguiente(fecha: string): string {
  const d = new Date(Date.UTC(Number(fecha.slice(0, 4)), Number(fecha.slice(5, 7)), 1));
  return d.toISOString().slice(0, 10);
}

export interface FilaParaLiquidar {
  canon: number;
  tarifa_pct: number | string | null;
  tarifa_acta_pct: number | string | null;
  tarifa_desde: string | null;
  /** contratos.fecha_firma = activación (A6). */
  activado_en: string;
  /** contratos.fecha_terminacion si terminó. */
  terminado_en: string | null;
}

export interface LineaLiquidacion {
  pct: number;
  dias: number;
  dias_mes: number;
  tarifa: number;
  iva: number;
  total: number;
}

/**
 * Tarifa de un contrato migrado en el mes AAAA-MM (§4.2, §4.7, §5.2): canon
 * sin IVA × % vigente al primer día del mes (el único cambio posterior, §5.2.5,
 * rige desde un día 1),
 * más IVA. El mes de la activación se cobra proporcional a los días que quedan,
 * contando el de la activación. null = no se causa ese mes.
 * ponytail: el mes de la terminación se cobra completo; si la Gerencia lo quiere proporcional, recortar aquí.
 */
export function liquidarMes(f: FilaParaLiquidar, mes: string, ivaPct: number): LineaLiquidacion | null {
  const diasMes = diasDelMes(mes);
  const primero = `${mes}-01`;
  const ultimo = `${mes}-${String(diasMes).padStart(2, '0')}`;
  const activacion = fechaBogota(f.activado_en);
  if (activacion > ultimo) return null;
  if (f.terminado_en && fechaBogota(f.terminado_en) < primero) return null;
  const pct = tarifaVigenteMigracion(f, primero);
  if (pct === null) return null;
  const dias = activacion >= primero ? diasMes - Number(activacion.slice(8, 10)) + 1 : diasMes;
  const tarifa = Math.round(((pctDe(f.canon, pct) ?? 0) * dias) / diasMes);
  const total = masIva(tarifa, ivaPct);
  return { pct, dias, dias_mes: diasMes, tarifa, iva: total - tarifa, total };
}

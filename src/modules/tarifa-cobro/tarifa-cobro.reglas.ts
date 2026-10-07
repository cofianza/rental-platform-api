// ============================================================
// Reglas puras del cobro de la tarifa mensual (plan cobro-tarifa-mensual, B2):
// qué contratos entran, qué meses se liquidan y con qué canon y %. El cálculo
// del mes es liquidarMes de la cartera migrada, sin copiarlo. Sin base de
// datos: las prueba tarifa-cobro.reglas.test.ts.
// ============================================================

import { fechaBogota } from '@/modules/contratos/v3/formato';
import { liquidarMes, primerDiaMesSiguiente, type FilaParaLiquidar } from '@/modules/migracion/cartera.reglas';

export type Modalidad = 'tradicional' | 'trasladada';

export interface ContratoCobro {
  id: string;
  numero: string | null;
  origen: string | null;
  estado: string;
  destinacion: string | null;
  /** timestamptz: la firma completa. */
  fecha_firma: string | null;
  /** DATE. */
  fecha_inicio: string | null;
  /** timestamptz del registro de la terminación. */
  fecha_terminacion: string | null;
  /** DATE, registrada por Cofianza: prevalece (A5). */
  fecha_terminacion_efectiva: string | null;
  valor_arriendo: number | string | null;
  /** V3: datos_variables->documento->entrada->tarifaPct. */
  tarifa_congelada: number | string | null;
  /** V3: datos_variables->documento->entrada->>modalidad. */
  modalidad: string | null;
  inmobiliaria_id: string | null;
  migracion: {
    tarifa_pct: number | string | null;
    tarifa_acta_pct: number | string | null;
    tarifa_desde: string | null;
    excluido_en: string | null;
  } | null;
}

export interface CondicionCobro {
  desde: string;
  canon_cop: number | string | null;
  tarifa_pct: number | string | null;
}

export const ESTADOS_COBRABLES = ['vigente', 'finalizado', 'cancelado'];

export const esMigrado = (c: Pick<ContratoCobro, 'origen'>) => c.origen === 'migracion';

/** Un DATE (AAAA-MM-DD) como el inicio de ese día en Bogotá; un instante, tal cual. fechaBogota('2026-05-01') daría 30/04. */
const instante = (d: string) => (d.length === 10 ? `${d}T05:00:00.000Z` : d);

/** Migrados: siempre Tradicional (Migr:9, 142). V3: la del documento; null = sin regla de cobro. */
export function modalidadDe(c: ContratoCobro): Modalidad | null {
  if (esMigrado(c)) return 'tradicional';
  return c.modalidad === 'tradicional' || c.modalidad === 'trasladada' ? c.modalidad : null;
}

/** D3: V3 desde max(firma, inicio) (la tarifa va «junto con cada canon», Anexo:57); migrado desde la firma. */
export function activacionDe(c: ContratoCobro): string | null {
  if (!c.fecha_firma) return null;
  if (esMigrado(c) || !c.fecha_inicio) return c.fecha_firma;
  return fechaBogota(c.fecha_firma) >= c.fecha_inicio ? c.fecha_firma : instante(c.fecha_inicio);
}

/**
 * D8: el corte depende del estado y de la terminación, nunca de fecha_fin (un V3
 * prorrogado sigue causando). La efectiva prevalece aunque siga vigente; sin
 * ninguna fecha en un contrato terminado, la del historial (TF-3).
 */
export function terminacionDe(c: ContratoCobro, delHistorial: string | null = null): string | null {
  if (c.fecha_terminacion_efectiva) return instante(c.fecha_terminacion_efectiva);
  if (c.estado === 'vigente') return null;
  return c.fecha_terminacion ?? delHistorial;
}

/** Selección (B2). Propietario directo, legacy y migrados excluidos no entran. */
export function entraAlCobro(c: ContratoCobro, terminacion: string | null, desde: string): boolean {
  if (!ESTADOS_COBRABLES.includes(c.estado) || !c.fecha_firma || !c.inmobiliaria_id) return false;
  if (esMigrado(c) ? !c.migracion || c.migracion.excluido_en : !c.destinacion) return false;
  return !terminacion || fechaBogota(terminacion) >= desde;
}

/** Lo vigente el día 1 del mes (D9): la última fila con ese dato y desde ≤ primero. */
function vigente(condiciones: CondicionCobro[], campo: 'canon_cop' | 'tarifa_pct', primero: string): number | null {
  const filas = condiciones.filter((x) => x.desde <= primero && x[campo] != null).sort((a, b) => a.desde.localeCompare(b.desde));
  return filas.length ? Number(filas[filas.length - 1][campo]) : null;
}

/** El contrato como FilaParaLiquidar del mes que empieza en `primero` (AAAA-MM-01). */
export function filaDeContrato(
  c: ContratoCobro,
  condiciones: CondicionCobro[],
  primero: string,
  terminacion: string | null,
): FilaParaLiquidar | null {
  const activado_en = activacionDe(c);
  if (!activado_en) return null;
  const canon = vigente(condiciones, 'canon_cop', primero) ?? Number(c.valor_arriendo ?? 0);
  const pct = vigente(condiciones, 'tarifa_pct', primero);
  // Un % registrado (otrosí de Gerencia o el congelado, D2) prevalece sobre el del documento o la fila.
  const tarifa =
    pct !== null
      ? { tarifa_pct: pct, tarifa_acta_pct: null, tarifa_desde: null }
      : esMigrado(c)
        ? { tarifa_pct: c.migracion?.tarifa_pct ?? null, tarifa_acta_pct: c.migracion?.tarifa_acta_pct ?? null, tarifa_desde: c.migracion?.tarifa_desde ?? null }
        : { tarifa_pct: c.tarifa_congelada, tarifa_acta_pct: null, tarifa_desde: null };
  return { canon, ...tarifa, activado_en, terminado_en: terminacion };
}

/** IVA de una línea con centavos, como lo calcula Factus; el redondeo al peso es uno por cuenta. */
export const ivaLinea = (base: number, ivaPct: number) => Math.round(base * ivaPct) / 100;

export interface CalculoLinea {
  pct: number;
  canon_base: number;
  dias: number;
  dias_mes: number;
  base_cop: number;
  iva_pct: number;
  iva_cop: number;
  total_cop: number;
}

/** D1, D4, D5: la línea del mes, o null si ese mes no causa tarifa. */
export function calcularLinea(
  c: ContratoCobro,
  condiciones: CondicionCobro[],
  primero: string,
  terminacion: string | null,
  ivaPct: number,
): CalculoLinea | null {
  const f = filaDeContrato(c, condiciones, primero, terminacion);
  const l = f && liquidarMes(f, primero.slice(0, 7), ivaPct);
  if (!f || !l || l.tarifa <= 0) return null;
  const iva = ivaLinea(l.tarifa, ivaPct);
  return {
    pct: l.pct,
    canon_base: f.canon,
    dias: l.dias,
    dias_mes: l.dias_mes,
    base_cop: l.tarifa,
    iva_pct: ivaPct,
    iva_cop: iva,
    total_cop: Math.round((l.tarifa + iva) * 100) / 100,
  };
}

/**
 * Los meses (AAAA-MM-01) que el contrato debe tener liquidados hasta `hasta`:
 * desde el mayor entre TARIFA_COBRO_DESDE (D16) y el de la activación, hasta el
 * de la terminación (D5: completo) si es anterior.
 */
export function mesesACobrar(activacion: string, terminacion: string | null, desde: string, hasta: string): string[] {
  const mesDe = (d: string) => `${fechaBogota(d).slice(0, 7)}-01`;
  let mes = mesDe(activacion) < desde ? desde : mesDe(activacion);
  const fin = terminacion && mesDe(terminacion) < hasta ? mesDe(terminacion) : hasta;
  const meses: string[] = [];
  for (; mes <= fin; mes = primerDiaMesSiguiente(mes)) meses.push(mes);
  return meses;
}

/**
 * D6: el mes M ya cortado hoy (AAAA-MM-DD, Bogotá). El último día del mes se
 * corta el siguiente; cualquier otro día, el en curso (su corte ya pasó, y si
 * no corrió, se recupera aquí).
 */
export function mesCortado(hoy: string): string {
  const siguiente = primerDiaMesSiguiente(hoy);
  const ultimoDia = new Date(Date.parse(siguiente) - 86_400_000).toISOString().slice(0, 10);
  return hoy === ultimoDia ? siguiente : `${hoy.slice(0, 7)}-01`;
}

/** Vence el día 10 del mes de la cuenta (AdPrecios:50, 52). */
export const venceCuenta = (periodo: string) => `${periodo.slice(0, 7)}-10`;

/**
 * Totales de la cuenta desde sus líneas vivas: base entera, IVA con centavos
 * sumado línea por línea (como Factus) y un solo ajuste al peso
 * (cash_rounding, como partirTotalConIva).
 */
export function totalesDe(lineas: Array<{ base_cop: number | string; iva_cop: number | string }>) {
  const base = lineas.reduce((s, l) => s + Number(l.base_cop), 0);
  const ivaCent = lineas.reduce((s, l) => s + Math.round(Number(l.iva_cop) * 100), 0);
  const exactoCent = base * 100 + ivaCent;
  const total = Math.round(exactoCent / 100);
  return {
    base_cop: base,
    iva_cop: ivaCent / 100,
    cash_rounding_cop: (total * 100 - exactoCent) / 100,
    total_cop: total,
  };
}

// ── B5/B6/B9 ──

/** El mes (AAAA-MM-01) de un instante o DATE, en Bogotá. */
export const mesDe = (d: string) => `${fechaBogota(instante(d)).slice(0, 7)}-01`;

export type Situacion = 'borrador' | 'bloqueada_fiscal' | 'emitiendo' | 'anulada' | 'emitida' | 'pagada' | 'parcial' | 'vencida';

/**
 * «Pagada», «parcial» y «vencida» no se guardan: salen de las líneas vivas de
 * una cuenta emitida. Pagada = nada pendiente ni sin recaudar; vencida pesa
 * más que parcial (lo que urge es el atraso).
 */
export function situacionDe(estado: string, venceEn: string, lineas: Array<{ estado: string }>, hoy: string): Situacion {
  if (estado !== 'emitida') return estado as Situacion;
  const vivas = lineas.filter((l) => l.estado !== 'anulada');
  if (!vivas.some((l) => l.estado === 'pendiente' || l.estado === 'no_recaudada')) return 'pagada';
  if (hoy > venceEn && vivas.some((l) => l.estado === 'pendiente')) return 'vencida';
  return vivas.some((l) => l.estado === 'pagada') ? 'parcial' : 'emitida';
}

/** B6: recordatorios a +1, +7 y +15 días del vencimiento (+7 por DIAS_ENTRE_COBROS_WHATSAPP). */
export const DIAS_RECORDATORIO = [1, 7, 15];

/**
 * El número de recordatorio que toca hoy, o null si ya salió. Una cuenta que
 * se ve por primera vez a los 10 días recibe uno solo (el 2), no dos seguidos.
 */
export function recordatorioQueToca(venceEn: string, hoy: string, enviados: number): number | null {
  const atraso = Math.round((Date.parse(hoy) - Date.parse(venceEn)) / 86_400_000);
  const n = DIAS_RECORDATORIO.filter((d) => atraso >= d).length;
  return n > enviados ? n : null;
}

/** D9: un canon que cambia a mitad de mes rige desde el día 1 del siguiente. */
export const periodoDesde = (fecha: string) => (fecha.slice(8, 10) === '01' ? fecha : primerDiaMesSiguiente(fecha));

/** El próximo aniversario (cada 12 meses desde fecha_inicio) en o después de hoy. 29-feb cae el 28 en año no bisiesto. */
export function proximoAniversario(fechaInicio: string, hoy: string): string {
  const [a, m, d] = fechaInicio.split('-').map(Number);
  for (let anio = Math.max(a + 1, Number(hoy.slice(0, 4))); ; anio++) {
    const dia = Math.min(d, new Date(Date.UTC(anio, m, 0)).getUTCDate());
    const f = `${anio}-${String(m).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    if (f >= hoy) return f;
  }
}

/** B9: el canon sugerido con IPC_ANUAL, al peso. Solo una propuesta: la inmobiliaria lo confirma. */
export const canonPropuesto = (canon: number, ipcAnual: number) => Math.round(canon * (1 + ipcAnual / 100));

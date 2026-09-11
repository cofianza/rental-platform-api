// ============================================================
// Tablero de calibracion — Adenda 1 §2.4
//
// "el tablero de calibracion debe mostrar el porcentaje de estudios resueltos
// con una sola central y con dos". La fuente es la traza que decidirConCascada
// (estudios.service.ts) deja en `estudios.cascada` al decidir: ahi queda
// `secundaria_consultada` y, si la segunda central RESPONDIO, tambien la
// columna `estudios.proveedor_secundario`. Sin traza (motor apagado, o estudio
// anterior a la Adenda) no se sabe con cuantas se decidio: se cuenta aparte
// como `sin_dato`, no como "una" — inflar "una central" con estudios que el
// motor nunca vio haria mentir el porcentaje que Gerencia quiere vigilar.
// ============================================================

import { supabase } from '@/lib/supabase';
import { fromSupabaseError } from '@/lib/errors';

export interface ResumenCascada {
  /** Inicio de la ventana (ISO). */
  desde: string;
  total: number;
  una_central: number;
  dos_centrales: number;
  sin_dato: number;
}

export type ClaseCascada = 'una_central' | 'dos_centrales' | 'sin_dato';

export interface FilaCascada {
  cascada?: { secundaria_consultada?: unknown } | null;
  proveedor_secundario?: string | null;
}

/** Pura: clasifica un estudio completado por cuantas centrales lo decidieron. */
export function clasificarCascada(fila: FilaCascada): ClaseCascada {
  // La columna se escribe solo cuando la segunda central respondio, y vale
  // aunque la traza no se haya podido persistir: las dos escrituras son
  // best-effort e independientes en decidirConCascada.
  if (fila.proveedor_secundario || fila.cascada?.secundaria_consultada === true)
    return 'dos_centrales';
  if (fila.cascada && typeof fila.cascada === 'object') return 'una_central';
  return 'sin_dato';
}

/** PostgREST corta en 1000 filas por respuesta; se pagina para no truncar. */
const PAGINA = 1000;

export async function resumenCascada(dias: number): Promise<ResumenCascada> {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  const resumen: ResumenCascada = {
    desde,
    total: 0,
    una_central: 0,
    dos_centrales: 0,
    sin_dato: 0,
  };

  for (let offset = 0; ; offset += PAGINA) {
    const { data, error } = await (
      supabase.from('estudios' as string) as ReturnType<typeof supabase.from>
    )
      .select('id, cascada, proveedor_secundario')
      .eq('estado', 'completado')
      .gte('fecha_completado', desde)
      .order('id', { ascending: true })
      .range(offset, offset + PAGINA - 1);
    if (error) throw fromSupabaseError(error);

    const filas = (data ?? []) as FilaCascada[];
    for (const fila of filas) {
      resumen.total += 1;
      resumen[clasificarCascada(fila)] += 1;
    }
    if (filas.length < PAGINA) break;
  }

  return resumen;
}

// ============================================================
// Tablero de revision manual y de DataCredito — Adenda 2 §5.1 y §8
//
// §5.1: "El tablero de calibracion debe mostrar el volumen de casos en
// revision manual y el tiempo promedio de resolucion, conforme al SLA de la
// Politica" (Politica §8: maximo 2 horas habiles desde el escalamiento).
// §8: "Desarrollo debe medir y reportar la tasa de falla de la API de
// Datacredito" y "el tablero debe incluir el conteo de evaluaciones escaladas
// a revision manual por ausencia de ingreso".
//
// Revision manual = expediente en 'condicionado'. Entra con el evento de
// timeline estado_nuevo='condicionado' y sale con el primero que tenga
// estado_anterior='condicionado' (aprobacion del analista, transicion o
// ponderacion con coarrendatario).
// ============================================================

/** Politica §8: "SLA — Revision manual por analista: maximo 2 horas habiles". */
export const SLA_REVISION_MANUAL_HORAS = 2;

const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;
/** Bogota: UTC-5 fijo (Colombia no tiene horario de verano). */
const OFFSET_BOGOTA_MS = -5 * HORA_MS;

/**
 * Horas habiles entre dos instantes: lunes a viernes de 8:00 a 18:00 de
 * Bogota. Pura.
 *
 * ponytail: la Politica no fija el horario ni descuenta festivos. Se asume
 * L-V 8-18 y un festivo cuenta como habil (el SLA sale un poco mas estricto,
 * nunca mas laxo). El horario oficial, si Gerencia lo define, es cambiar dos
 * numeros.
 */
export function horasHabilesEntre(desde: Date, hasta: Date): number {
  if (!(hasta.getTime() > desde.getTime())) return 0;
  const d0 = Math.floor((desde.getTime() + OFFSET_BOGOTA_MS) / DIA_MS);
  const d1 = Math.floor((hasta.getTime() + OFFSET_BOGOTA_MS) / DIA_MS);
  let ms = 0;
  for (let d = d0; d <= d1; d++) {
    // El dia 0 de la epoch (1970-01-01) fue jueves: (d + 4) % 7 = 0 es domingo.
    const diaSemana = (((d + 4) % 7) + 7) % 7;
    if (diaSemana === 0 || diaSemana === 6) continue;
    const medianocheUtc = d * DIA_MS - OFFSET_BOGOTA_MS;
    const a = Math.max(medianocheUtc + 8 * HORA_MS, desde.getTime());
    const b = Math.min(medianocheUtc + 18 * HORA_MS, hasta.getTime());
    if (b > a) ms += b - a;
  }
  return Math.round((ms / HORA_MS) * 10) / 10;
}

interface EventoEstado {
  expediente_id: string;
  created_at: string;
}

/**
 * Empareja cada salida de 'condicionado' con la entrada anterior mas reciente
 * del mismo expediente. Pura. Una salida sin entrada registrada se descarta
 * (no hay desde cuando medir).
 */
export function emparejarRevisiones(
  entradas: readonly EventoEstado[],
  salidas: readonly EventoEstado[],
): Array<{ expediente_id: string; desde: string; hasta: string }> {
  const pares: Array<{ expediente_id: string; desde: string; hasta: string }> = [];
  for (const s of salidas) {
    const previa = entradas
      .filter((e) => e.expediente_id === s.expediente_id && e.created_at <= s.created_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (previa) pares.push({ expediente_id: s.expediente_id, desde: previa.created_at, hasta: s.created_at });
  }
  return pares;
}

export interface ResumenRevisionManual {
  desde: string;
  sla_horas_habiles: number;
  /** Expedientes en revision manual en este momento. */
  en_revision_ahora: number;
  /** Casos que salieron de revision manual dentro de la ventana. */
  resueltas: number;
  promedio_horas_habiles: number | null;
  dentro_del_sla: number;
  /** Estudios completados en la ventana que escalaron por falta de ingreso (Adenda 2 §3). */
  escaladas_sin_ingreso: number;
  datacredito: {
    /** Consultas que llegaron a DataCredito (respondio o fallo). */
    consultas: number;
    /** La central no respondio (caida o mantenimiento). */
    caidas: number;
    /** Fallos por el dato (documento o apellido), no por la central. */
    errores_de_dato: number;
    tasa_caida_pct: number | null;
  };
}

export async function resumenRevisionManual(dias: number): Promise<ResumenRevisionManual> {
  const desde = new Date(Date.now() - dias * DIA_MS).toISOString();
  const db = (tabla: string) => supabase.from(tabla as string) as ReturnType<typeof supabase.from>;

  const [ahora, salidasRes, sinIngreso, bitacora] = await Promise.all([
    db('expedientes').select('id', { count: 'exact', head: true }).eq('estado', 'condicionado'),
    db('eventos_timeline').select('expediente_id, created_at').eq('estado_anterior', 'condicionado').gte('created_at', desde).limit(1000),
    db('estudios')
      .select('id', { count: 'exact', head: true })
      .eq('estado', 'completado')
      .gte('fecha_completado', desde)
      .ilike('observaciones', '%Adenda 2 §3%'),
    db('bitacora')
      .select('accion, tipo_fallo:detalle->>tipo_fallo')
      .in('accion', ['estudio_provider_executed', 'estudio_provider_failed'])
      .eq('detalle->>proveedor', 'datacredito')
      .gte('created_at', desde)
      .limit(5000),
  ]);
  for (const r of [ahora, salidasRes, sinIngreso, bitacora]) if (r.error) throw fromSupabaseError(r.error);

  const salidas = (salidasRes.data ?? []) as EventoEstado[];
  const ids = [...new Set(salidas.map((s) => s.expediente_id))];
  let entradas: EventoEstado[] = [];
  if (ids.length > 0) {
    const { data, error } = await db('eventos_timeline')
      .select('expediente_id, created_at')
      .eq('estado_nuevo', 'condicionado')
      .in('expediente_id', ids);
    if (error) throw fromSupabaseError(error);
    entradas = (data ?? []) as EventoEstado[];
  }
  const horas = emparejarRevisiones(entradas, salidas).map((p) => horasHabilesEntre(new Date(p.desde), new Date(p.hasta)));

  const filas = (bitacora.data ?? []) as Array<{ accion: string; tipo_fallo: string | null }>;
  const ejecutadas = filas.filter((f) => f.accion === 'estudio_provider_executed').length;
  const fallidas = filas.filter((f) => f.accion === 'estudio_provider_failed');
  const caidas = fallidas.filter((f) => f.tipo_fallo === 'no_disponible').length;
  const erroresDato = fallidas.filter((f) => f.tipo_fallo === 'documento_no_encontrado' || f.tipo_fallo === 'apellido_no_coincide').length;

  return {
    desde,
    sla_horas_habiles: SLA_REVISION_MANUAL_HORAS,
    en_revision_ahora: ahora.count ?? 0,
    resueltas: horas.length,
    promedio_horas_habiles: horas.length > 0 ? Math.round((horas.reduce((a, b) => a + b, 0) / horas.length) * 10) / 10 : null,
    dentro_del_sla: horas.filter((h) => h <= SLA_REVISION_MANUAL_HORAS).length,
    escaladas_sin_ingreso: sinIngreso.count ?? 0,
    datacredito: {
      consultas: ejecutadas + caidas,
      caidas,
      errores_de_dato: erroresDato,
      tasa_caida_pct: ejecutadas + caidas > 0 ? Math.round((caidas / (ejecutadas + caidas)) * 1000) / 10 : null,
    },
  };
}

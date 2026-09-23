/**
 * Parametros de calibracion del modelo — Adenda 1 a la Politica V4.1, §11.
 *
 * "Todos estos valores deben poder modificarse desde el panel de calibracion,
 * sin intervencion de desarrollo, unicamente por la Gerencia General, y todo
 * cambio debe quedar registrado con fecha, valor anterior, valor nuevo y
 * usuario."
 *
 * Mismo patron que companyConfig.ts: los DEFAULTS viven aqui, la tabla
 * `parametros_calibracion` los sobrescribe, y una tabla o clave inexistente
 * cae al default sin romper nada. Cache en memoria con TTL corto: los
 * parametros se leen en cada evaluacion y no puede costar un roundtrip.
 *
 * LOS CONSUMIDORES SON PUROS. El motor, las rutas, la expiracion y las tarifas
 * reciben los numeros por parametro; este modulo es el UNICO que habla con la
 * tabla. Asi los scripts/check-* siguen corriendo sin Supabase.
 */

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
import { env } from '@/config';

export type ClaveCalibracion =
  | 'FACTOR_AJUSTE_INGRESO'
  | 'UMBRAL_CASCADA_RECHAZO'
  | 'UMBRAL_CASCADA_APROBACION'
  | 'UMBRAL_DIFERENCIA_INGRESO'
  | 'VIGENCIA_CRC_DIAS'
  | 'DIAS_EXPIRACION_ESTUDIO'
  | 'UMBRAL_COARRENDATARIO'
  | 'CANON_MAX_TRANSITORIO'
  | 'TOPE_CANON_COMERCIAL'
  | 'UMBRAL_APROBACION_AUTOMATICA'
  | 'UMBRAL_ZONA_GRIS'
  | 'UMBRAL_SCORE_RECHAZO'
  | 'UMBRAL_SCORE_REVISION'
  | 'UMBRAL_SIMILITUD_BIOMETRICA'
  | 'TARIFA_IVA'
  | 'TOLERANCIA_CANON'
  | 'TOPE_CANON_INGRESO_RECALCULO'
  | 'VIGENCIA_MESES_DEFECTO'
  | 'MAX_CLAUSULAS_ADICIONALES'
  | 'DIAS_EXPIRACION_FIRMA';

export type Calibracion = Record<ClaveCalibracion, number>;

export interface DefinicionParametro {
  clave: ClaveCalibracion;
  valorDefault: number;
  /** Rango admisible. Un valor fuera de rango se rechaza en setParametro. */
  min: number;
  max: number;
  /** true = solo enteros. */
  entero: boolean;
  seccion: string;
  descripcion: string;
  /** Lo que la Adenda pide dejar registrado al lado del valor. */
  advertencia?: string;
}

/**
 * Los valores iniciales son los de la Adenda §11, salvo CANON_MAX_TRANSITORIO,
 * que se siembra con lo que ya corre en produccion (env, Flujo §4.4: 3.000.000)
 * porque la Adenda remite a la Politica (§6: 2.000.000) sin resolver la
 * contradiccion entre los dos documentos. Gerencia lo mueve desde el panel.
 */
export const PARAMETROS: readonly DefinicionParametro[] = [
  {
    clave: 'FACTOR_AJUSTE_INGRESO',
    valorDefault: 1.15,
    min: 1,
    max: 2,
    entero: false,
    seccion: 'Adenda §1.1',
    descripcion: 'Multiplica el ingreso estimado por la central antes de calcular DTI y canon/ingreso.',
    advertencia:
      'Amplia de hecho las reglas duras: con 1,15 el canon maximo del 40% admite hasta el 46% del ingreso real, y el DTI del 65% hasta el 74,7%. Decision deliberada de apetito de riesgo de la Gerencia General.',
  },
  {
    clave: 'UMBRAL_CASCADA_RECHAZO',
    valorDefault: 40,
    min: 0,
    max: 100,
    entero: true,
    seccion: 'Adenda §2.1',
    descripcion: 'Puntaje de la central primaria por debajo del cual se rechaza sin consultar la segunda.',
  },
  {
    clave: 'UMBRAL_CASCADA_APROBACION',
    valorDefault: 90,
    min: 0,
    max: 100,
    entero: true,
    seccion: 'Adenda §2.1',
    descripcion: 'Puntaje de la central primaria desde el cual se aprueba sin consultar la segunda.',
    advertencia:
      'Es una asuncion de riesgo, no una certeza matematica: un 90 en Datacredito podria tener 60 en TransUnion. Monitorear los primeros seis meses con una muestra consultada a posteriori.',
  },
  {
    clave: 'UMBRAL_DIFERENCIA_INGRESO',
    valorDefault: 50,
    min: 0,
    max: 500,
    entero: false,
    seccion: 'Adenda §8',
    descripcion: 'Diferencia (%) entre ingreso declarado y estimado que levanta bandera de revision manual. No rechaza.',
  },
  {
    clave: 'VIGENCIA_CRC_DIAS',
    valorDefault: 60,
    min: 1,
    max: 365,
    entero: true,
    seccion: 'Adenda §6',
    descripcion: 'Vigencia del CRC en dias calendario desde la fecha de evaluacion.',
  },
  {
    clave: 'DIAS_EXPIRACION_ESTUDIO',
    valorDefault: 15,
    min: 1,
    max: 90,
    entero: true,
    seccion: 'Adenda §9',
    descripcion: 'Dias desde el envio de la solicitud al prospecto para que el estudio expire sin autorizar. Aplica a las solicitudes enviadas desde el cambio: las ya enviadas conservan el vencimiento de su enlace.',
  },
  {
    clave: 'UMBRAL_COARRENDATARIO',
    valorDefault: 80,
    min: 0,
    max: 100,
    entero: true,
    seccion: 'Adenda §3',
    descripcion: 'Puntaje minimo del COARRENDATARIO para aprobar automaticamente a un titular en zona gris (70-84).',
  },
  {
    clave: 'CANON_MAX_TRANSITORIO',
    valorDefault: env.CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP,
    min: 100_000,
    max: 100_000_000,
    entero: true,
    seccion: 'Política §6 / Flujo §4.4 / Adenda contratos §2.1',
    descripcion: 'Canon máximo sin coafianzamiento para destinación VIVIENDA (COP), evaluado sobre el canon SIN IVA. Mientras el comercial no esté habilitado, también aplica a inmuebles comerciales y mixtos. Se deroga al entrar en vigencia el coafianzamiento.',
    advertencia: 'La Política §6 dice 2.000.000 y el Flujo §4.4 dice 3.000.000. Gerencia (Mario, 2026-09-09) resolvió 3.000.000 y la Adenda 1 del módulo de contratos (§2.1) lo confirma para vivienda, corrigiendo los 2.000.000 de la nota de envío; falta actualizar el texto de la Política §6.',
  },
  {
    clave: 'TOPE_CANON_COMERCIAL',
    valorDefault: 4_000_000,
    min: 100_000,
    max: 100_000_000,
    entero: true,
    seccion: 'Contratos comercial §2.1 / §12.1 / Adenda contratos §2.2',
    descripcion: 'Canon maximo sin coafianzamiento para destinacion COMERCIAL (COP), evaluado sobre el canon SIN IVA.',
    advertencia: 'Sin efecto hasta habilitar el arrendamiento comercial (Fase 2); mientras tanto los inmuebles comerciales y mixtos usan el tope de vivienda.',
  },
  {
    clave: 'UMBRAL_APROBACION_AUTOMATICA',
    valorDefault: 85,
    min: 0,
    max: 100,
    entero: true,
    seccion: 'Politica §3.1',
    descripcion: 'Puntaje normalizado desde el cual se aprueba automaticamente (firma solo).',
  },
  {
    clave: 'UMBRAL_ZONA_GRIS',
    valorDefault: 70,
    min: 0,
    max: 100,
    entero: true,
    seccion: 'Politica §3.1',
    descripcion: 'Puntaje normalizado desde el cual empieza la zona gris (hasta el umbral de aprobacion). Por debajo, rechazo.',
  },
  {
    clave: 'UMBRAL_SCORE_RECHAZO',
    valorDefault: 450,
    // ponytail: minimo 450 porque la tabla de V1 (scorecard.ts) no tiene banda
    // por debajo; bajarlo exige tocar la tabla, no solo el panel.
    min: 450,
    max: 700,
    entero: true,
    seccion: 'Adenda 2 §2',
    descripcion: 'Score externo de la central por debajo del cual se rechaza de inmediato, sin calcular el resto del modelo.',
  },
  {
    clave: 'UMBRAL_SCORE_REVISION',
    valorDefault: 599,
    min: 450,
    max: 900,
    entero: true,
    seccion: 'Adenda 2 §2',
    descripcion: 'Score externo hasta el cual el caso va a revision manual obligatoria (desde el umbral de rechazo). Prevalece sobre el rechazo por puntaje normalizado.',
    advertencia:
      'Subirlo manda mas casos a revision manual. Bajarlo de 599 no aprueba solos los scores de 600 hacia abajo: con el motor apagado, las centrales siguen marcando condicionado por debajo de 600.',
  },
  {
    clave: 'UMBRAL_SIMILITUD_BIOMETRICA',
    valorDefault: 80,
    min: 50,
    max: 100,
    entero: true,
    seccion: 'Adenda 2 §9',
    descripcion: 'Similitud minima (%) entre la selfie y la cedula para dar por verificada la identidad al firmar el contrato. Por debajo, un analista de Cofianza verifica por otro medio: nunca rechaza.',
    advertencia: 'Revisar a los tres meses cuantas verificaciones legitimas caen al analista; si son pocas, puede evaluarse bajarlo.',
  },
  {
    clave: 'TARIFA_IVA',
    valorDefault: 19,
    min: 0,
    max: 50,
    entero: false,
    seccion: 'Contratos comercial §3.3.2 / §12.2',
    descripcion: 'Tarifa general de IVA (%). Se suma a la tarifa mensual de la fianza y, en arrendamiento comercial, al canon.',
    advertencia: 'Es la tarifa legal: cambiarla solo si cambia la ley. Aplica a lo que se emita desde el cambio (hasta 60 s de cache). La facturacion electronica usa configuracion_sistema.iva_concepto_garantia (hoy 0, exento): pendiente de Gerencia.',
  },
  // Contratos V3 §14. Rigen SOLO para el asistente de contratos: el motor sigue
  // con su 40% (scorecard.ts) y la reasignacion con su 15% (portabilidad.ts).
  // Queda fuera PUNTOS_ADICIONALES_IPC (Ley 820 art. 20 lo fija; nadie lo
  // leeria). MAX_CLAUSULAS_ADICIONALES (Entrega 4) y DIAS_EXPIRACION_FIRMA
  // (Entrega 5) van al final.
  {
    clave: 'TOLERANCIA_CANON',
    valorDefault: 15,
    min: 0,
    max: 50,
    entero: false,
    seccion: 'Contratos V3 §14 / §2.2',
    descripcion: 'Maximo (%) en que el canon pactado en el contrato puede superar el canon evaluado sin exigir una nueva evaluacion. Inclusivo.',
    advertencia: 'Solo el contrato; la reasignacion conserva su 15 %.',
  },
  {
    clave: 'TOPE_CANON_INGRESO_RECALCULO',
    valorDefault: 40,
    min: 10,
    max: 100,
    entero: false,
    seccion: 'Contratos V3 §14 / §2.2',
    descripcion: 'Relacion canon/ingreso maxima (%) al recalcular con un canon pactado mayor que el evaluado. Si el ingreso no se conoce, no bloquea.',
    advertencia: 'No cambia la regla dura del motor (40 %).',
  },
  {
    clave: 'VIGENCIA_MESES_DEFECTO',
    valorDefault: 12,
    min: 2,
    max: 120,
    entero: true,
    seccion: 'Contratos V3 §14',
    descripcion: 'Vigencia (meses) con la que el asistente precarga el contrato cuando el estudio no trae una duracion.',
  },
  {
    clave: 'MAX_CLAUSULAS_ADICIONALES',
    valorDefault: 10,
    min: 1,
    max: 25,
    entero: true,
    seccion: 'Contratos V3 §14.5 / §5.1.6',
    descripcion: 'Cláusulas adicionales por contrato sin revisión de Cofianza. Por encima, el contrato queda bloqueado hasta que un administrador autorice ese conjunto exacto.',
    advertencia: 'El tope técnico es 25 (la numeración llega a QUINCUAGÉSIMA OCTAVA).',
  },
  {
    clave: 'DIAS_EXPIRACION_FIRMA',
    valorDefault: 15,
    min: 4,
    max: 60,
    entero: true,
    seccion: 'Contratos V3 §14.8 / §15.1',
    descripcion: 'Dias que el proceso de firma queda abierto en Auco. Al vencer, el contrato pasa a FIRMA INCOMPLETA: la fianza no opera y hay que reenviarlo.',
    advertencia: 'Auco exige mas de 3 dias. Un plazo largo no amplia la vigencia del estudio: para reenviar, el CRC debe seguir vigente.',
  },
];

export const CALIBRACION_DEFAULT: Calibracion = Object.fromEntries(
  PARAMETROS.map((p) => [p.clave, p.valorDefault]),
) as Calibracion;

/**
 * Adenda 1 del módulo de contratos, respuesta 17 (esquema escalonado): los
 * parámetros que afectan el riesgo —topes de canon, umbrales de score,
 * cobertura, vigencia del certificado, base de cálculo— solo los cambia la
 * Gerencia General; los operativos —días de firma, de reserva, de registro—
 * cualquier administrador. ÚNICA lista: lo que no está aquí es de riesgo (en
 * la duda, riesgo).
 */
const OPERATIVOS: ReadonlySet<ClaveCalibracion> = new Set<ClaveCalibracion>([
  'DIAS_EXPIRACION_ESTUDIO', // plazo del prospecto para autorizar
  'VIGENCIA_MESES_DEFECTO', // solo precarga el asistente; cada contrato fija la suya
  'DIAS_EXPIRACION_FIRMA',
]);

export type NivelParametro = 'riesgo' | 'operativo';

export const nivelDe = (clave: string): NivelParametro =>
  OPERATIVOS.has(clave as ClaveCalibracion) ? 'operativo' : 'riesgo';

/**
 * Gerencia General = administrador con el correo en GERENCIA_GENERAL_EMAILS.
 * Con la lista vacía, cualquier administrador (lo de antes de la Adenda).
 */
export function esGerenciaGeneral(u: { rol: string; email: string }): boolean {
  const lista = env.GERENCIA_GENERAL_EMAILS;
  return u.rol === 'administrador' && (lista.length === 0 || lista.includes(u.email.trim().toLowerCase()));
}

/** Pura: los operativos, cualquier administrador; los de riesgo, solo la Gerencia General. */
export const puedeEditarParametro = (clave: string, u: { rol: string; email: string }): boolean =>
  u.rol === 'administrador' && (nivelDe(clave) === 'operativo' || esGerenciaGeneral(u));

const CACHE_TTL_MS = 60_000;
// Si la lectura falla, el respaldo se cachea poco: un corte breve no debe dejar
// un minuto entero los valores de respaldo a todos los consumidores.
const CACHE_TTL_FALLO_MS = 5_000;
let cache: { value: Calibracion; expiresAt: number } | null = null;
// Última lectura buena: es el respaldo si la base falla (los defaults solo si
// nunca se pudo leer).
let ultimoBueno: Calibracion | null = null;

const db = (tabla: string) => supabase.from(tabla as string) as ReturnType<typeof supabase.from>;

export function invalidateCalibracionCache(): void {
  cache = null;
}

/** Pura: valida un valor contra su definicion. Devuelve el motivo del rechazo o null. */
export function validarParametro(clave: string, valor: unknown): { def: DefinicionParametro; error: string | null } | null {
  const def = PARAMETROS.find((p) => p.clave === clave);
  if (!def) return null;
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return { def, error: 'El valor debe ser numerico' };
  if (def.entero && !Number.isInteger(valor)) return { def, error: 'El valor debe ser entero' };
  if (valor < def.min || valor > def.max) return { def, error: `Fuera de rango (${def.min} a ${def.max})` };
  return { def, error: null };
}

/**
 * Parametros vigentes: defaults + lo guardado. Nunca lanza.
 */
export async function getCalibracion(): Promise<Calibracion> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  // Varias llamadas a la vez con el caché vencido (p. ej. una por estudio de un
  // listado) comparten la misma lectura.
  leyendo ??= leerCalibracion().finally(() => {
    leyendo = null;
  });
  return leyendo;
}

let leyendo: Promise<Calibracion> | null = null;

/** Lee la tabla directo (sin caché). Lanza si la base falla. */
async function leerTabla(): Promise<Calibracion> {
  const value: Calibracion = { ...CALIBRACION_DEFAULT };
  const { data, error } = await db('parametros_calibracion').select('clave, valor');
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<{ clave: string; valor: number | string }>) {
    const n = typeof row.valor === 'string' ? Number(row.valor) : row.valor;
    const v = validarParametro(row.clave, n);
    if (v && !v.error) value[row.clave as ClaveCalibracion] = n;
    else if (v) logger.warn({ clave: row.clave, valor: row.valor, error: v.error }, 'Calibracion: valor guardado invalido — se usa el default');
  }
  return value;
}

async function leerCalibracion(): Promise<Calibracion> {
  try {
    const value = await leerTabla();
    ultimoBueno = value;
    cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  } catch (e) {
    logger.warn(
      { error: e instanceof Error ? e.message : String(e) },
      'getCalibracion: no se pudo leer parametros_calibracion; se usa la ultima lectura buena o los defaults',
    );
    const value = ultimoBueno ?? { ...CALIBRACION_DEFAULT };
    cache = { value, expiresAt: Date.now() + CACHE_TTL_FALLO_MS };
    return value;
  }
}

// Parejas de umbrales que no pueden cruzarse: con la zona gris en o por encima
// de la aprobación nadie cae en zona gris, y con la cascada invertida se
// rechaza sin consultar la segunda central lo que debía aprobarse.
const PAREJAS_ORDENADAS: Array<[bajo: ClaveCalibracion, alto: ClaveCalibracion, nombreBajo: string, nombreAlto: string]> = [
  ['UMBRAL_ZONA_GRIS', 'UMBRAL_APROBACION_AUTOMATICA', 'La zona gris', 'la aprobación automática'],
  ['UMBRAL_CASCADA_RECHAZO', 'UMBRAL_CASCADA_APROBACION', 'El rechazo en cascada', 'la aprobación en cascada'],
];

/** Pura: revisa que el cambio de `clave` no cruce su pareja. Devuelve el motivo o null. */
export function validarCoherencia(c: Calibracion, clave: string): string | null {
  for (const [bajo, alto, nombreBajo, nombreAlto] of PAREJAS_ORDENADAS) {
    if ((clave === bajo || clave === alto) && c[bajo] >= c[alto]) {
      return `${nombreBajo} (${c[bajo]}) debe quedar por debajo de ${nombreAlto} (${c[alto]})`;
    }
  }
  return null;
}

export interface FilaParametro extends DefinicionParametro {
  valor: number;
  actualizado_en: string | null;
  actualizado_por: string | null;
}

/** Para el panel: definicion + valor vigente + quien lo toco. */
export async function listarParametros(): Promise<FilaParametro[]> {
  const vigente = await getCalibracion();
  let meta: Record<string, { actualizado_en: string | null; actualizado_por: string | null }> = {};
  try {
    const { data } = await db('parametros_calibracion').select('clave, actualizado_en, actualizado_por');
    for (const r of (data ?? []) as Array<{ clave: string; actualizado_en: string | null; actualizado_por: string | null }>) {
      meta[r.clave] = { actualizado_en: r.actualizado_en, actualizado_por: r.actualizado_por };
    }
  } catch {
    meta = {};
  }
  return PARAMETROS.map((p) => ({
    ...p,
    valor: vigente[p.clave],
    actualizado_en: meta[p.clave]?.actualizado_en ?? null,
    actualizado_por: meta[p.clave]?.actualizado_por ?? null,
  }));
}

/**
 * Cambia un parametro dejando el rastro que exige la Adenda §11 (fecha, valor
 * anterior, valor nuevo, usuario). Lanza si la clave no existe o el valor esta
 * fuera de rango — aqui SI se lanza: es una escritura de Gerencia, no un
 * camino caliente. Quién puede cambiar cada uno lo decide el llamador
 * (puedeEditarParametro).
 */
export async function setParametro(
  clave: string,
  valor: number,
  usuarioId: string,
  motivo?: string,
): Promise<FilaParametro & { valor_anterior: number }> {
  const v = validarParametro(clave, valor);
  if (!v) throw new Error(`Parametro desconocido: ${clave}`);
  if (v.error) throw new Error(`${clave}: ${v.error}`);

  // Se lee la tabla, no el caché: si el caché trae el respaldo de una lectura
  // fallida, el historial registraría como «anterior» un valor que no regía.
  let vigente: Calibracion;
  try {
    vigente = await leerTabla();
  } catch (e) {
    throw new AppError(
      500,
      'CALIBRACION_LECTURA_ERROR',
      `No se pudo leer el valor vigente de ${clave}; el valor no se modificó. ${e instanceof Error ? e.message : ''}`.trim(),
    );
  }
  const incoherencia = validarCoherencia({ ...vigente, [clave]: valor }, clave);
  if (incoherencia) throw AppError.badRequest(incoherencia, 'PARAMETRO_INVALIDO');

  const anterior = vigente[clave as ClaveCalibracion];
  const ahora = new Date().toISOString();

  // SIN HISTORIAL NO HAY CAMBIO. La Adenda §11 exige el rastro de cada cambio;
  // antes el valor se escribia primero y, si el historial fallaba, quedaba un
  // cambio vigente sin rastro (solo un log). Ahora el rastro va PRIMERO: si no
  // se puede escribir, el valor no se toca. No hay transaccion (dos tablas por
  // PostgREST), asi que el orden es la garantia.
  const { data: hist, error: histError } = await db('parametros_calibracion_historial')
    .insert({
      clave,
      valor_anterior: anterior,
      valor_nuevo: valor,
      usuario_id: usuarioId,
      motivo: motivo ?? null,
    } as never)
    .select('id')
    .single();
  if (histError || !hist) {
    logger.error({ clave, error: histError?.message ?? 'sin fila' }, 'Calibracion: no se pudo registrar el historial — el valor NO se cambio');
    throw new AppError(
      500,
      'CALIBRACION_HISTORIAL_ERROR',
      `No se pudo registrar el historial del cambio de ${clave}; el valor no se modifico. ${histError?.message ?? ''}`.trim(),
    );
  }
  const histId = (hist as { id?: string }).id;

  const { error } = await db('parametros_calibracion').upsert(
    {
      clave,
      valor,
      descripcion: v.def.descripcion,
      actualizado_en: ahora,
      actualizado_por: usuarioId,
    } as never,
    { onConflict: 'clave' } as never,
  );
  if (error) {
    // El valor no cambio: se retira el rastro recien escrito (best-effort) para
    // que el historial no cuente un cambio que nunca ocurrio.
    if (histId) {
      const { error: delError } = await db('parametros_calibracion_historial').delete().eq('id', histId);
      if (delError) {
        logger.error({ clave, histId, error: delError.message }, 'Calibracion: el valor NO cambio pero quedo una fila de historial huerfana');
      }
    }
    throw new AppError(500, 'CALIBRACION_GUARDAR_ERROR', `No se pudo guardar ${clave}: ${error.message}`);
  }

  invalidateCalibracionCache();
  ultimoBueno = { ...vigente, [clave]: valor };
  logger.info({ clave, anterior, nuevo: valor, usuarioId, motivo }, 'Calibracion: parametro actualizado');

  return {
    ...v.def,
    valor,
    valor_anterior: anterior,
    actualizado_en: ahora,
    actualizado_por: usuarioId,
  };
}

export interface EntradaHistorial {
  id: string;
  clave: string;
  valor_anterior: number | null;
  valor_nuevo: number;
  usuario_id: string | null;
  usuario_nombre: string | null;
  motivo: string | null;
  created_at: string;
}

export async function listarHistorial(limit = 100): Promise<EntradaHistorial[]> {
  const { data, error } = await db('parametros_calibracion_historial')
    .select('id, clave, valor_anterior, valor_nuevo, usuario_id, motivo, created_at, perfiles(nombre, apellido)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    logger.warn({ error: error.message }, 'Calibracion: no se pudo leer el historial');
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const p = r.perfiles as { nombre?: string; apellido?: string } | null;
    return {
      id: String(r.id),
      clave: String(r.clave),
      valor_anterior: r.valor_anterior == null ? null : Number(r.valor_anterior),
      valor_nuevo: Number(r.valor_nuevo),
      usuario_id: (r.usuario_id as string | null) ?? null,
      usuario_nombre: p ? `${p.nombre ?? ''} ${p.apellido ?? ''}`.trim() || null : null,
      motivo: (r.motivo as string | null) ?? null,
      created_at: String(r.created_at),
    };
  });
}

/**
 * Bloqueo por documento que no coincide (BLQ 07/10/2026, plan bloque 2).
 *
 * Solo datos: intentos del prospecto, enlaces emitidos y su cierre, y el estado
 * derivado («bloqueado por documento», «identidad rechazada», «pendiente de
 * reenvío»). No importa servicios de otros módulos: lo usan también
 * solicitantes y auth sin ciclos.
 *
 * `valor_digitado` es un dato personal, posiblemente de un tercero: se escribe
 * aquí y lo lee solo la traza interna de Cofianza. Nunca va al logger, a
 * logAudit ni al timeline.
 */
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;

export type MotivoCierre = 'intentos' | 'no_soy_yo' | 'datos_incorrectos' | 'reemplazado' | 'correccion';
export type EstadoBloqueo = 'bloqueado_documento' | 'identidad_rechazada' | 'pendiente_reenvio';

export const FUENTES_VERIFICACION = ['documento_fisico', 'copia_documento', 'confirmacion_telefonica'] as const;

// ============================================================
// Intentos (BLQ §1)
// ============================================================

/**
 * Registra un intento y devuelve los intentos que le quedan al enlace. Primero
 * inserta y después cuenta los fallidos de ESA autorización (el contador se
 * reinicia solo con un enlace nuevo). Dos peticiones simultáneas ven las dos el
 * conteo final y las dos detienen; detener es idempotente.
 *
 * El acierto también cuenta: en una ráfaga en paralelo, un acierto que llega
 * con los fallidos ya agotados devuelve 0 y no vale (si no, el límite sería un
 * oráculo para adivinar el documento de otra persona).
 *
 * Falla cerrado: si la escritura de un fallido o el conteo fallan, 0 (se
 * detiene al primer fallo, como antes). Nunca intentos ilimitados. Un acierto
 * que no se pudo contar lanza 503 (reintentable), nunca «no coincide».
 */
export async function registrarIntentoDocumento(a: {
  autorizacionId: string;
  expedienteId: string | null;
  tipoDigitado: string | null;
  valorDigitado: string;
  coincide: boolean;
  origen: 'confirmacion' | 'firma';
  ip?: string;
  userAgent?: string;
  maxIntentos: number;
}): Promise<number> {
  const { error } = await db('autorizacion_intentos_documento').insert({
    autorizacion_id: a.autorizacionId,
    expediente_id: a.expedienteId,
    tipo_digitado: a.tipoDigitado,
    valor_digitado: a.valorDigitado.slice(0, 30),
    coincide: a.coincide,
    origen: a.origen,
    ip: a.ip ? a.ip.slice(0, 45) : null,
    user_agent: a.userAgent ? a.userAgent.slice(0, 1000) : null,
  } as never);
  if (error) {
    // Sin el valor: solo el código del error.
    logger.warn({ autorizacionId: a.autorizacionId, code: (error as { code?: string }).code }, 'BLQ: no se pudo registrar el intento');
    if (!a.coincide) return 0;
  }
  const fallidos = await contarIntentosFallidos(a.autorizacionId);
  if (fallidos == null) {
    // Un acierto que no se pudo contar no es «no coincide»: si devolviera 0 la
    // página mostraría el proceso detenido con el enlace vivo y sin alerta.
    if (a.coincide) {
      throw new AppError(503, 'INTENTOS_NO_VERIFICABLES', 'No pudimos verificar su documento en este momento. Intente de nuevo en unos minutos.');
    }
    return 0;
  }
  return Math.max(0, a.maxIntentos - fallidos);
}

/** Fallidos del enlace. null = no se pudo contar. */
export async function contarIntentosFallidos(autorizacionId: string): Promise<number | null> {
  const { count, error } = await db('autorizacion_intentos_documento')
    .select('id', { count: 'exact', head: true })
    .eq('autorizacion_id', autorizacionId)
    .eq('coincide', false);
  return error ? null : count;
}

// ============================================================
// Enlaces emitidos (BLQ §4 y §7)
// ============================================================

export interface ResultadoCanal {
  canal: 'correo' | 'whatsapp';
  destino_enmascarado: string | null;
  estado: string;
  error?: string;
}

/** `ju***@dominio.com`: lo justo para reconocer el destino en la traza. */
export function enmascararEmail(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null;
  const [user, dominio] = email.split('@');
  return `${user.slice(0, 2)}***@${dominio}`;
}

/** Best-effort: el enlace ya salió; perder su traza no lo invalida. */
export async function registrarEnvio(a: {
  autorizacionId: string;
  expedienteId: string;
  generadoPor: string | null;
  esReenvio: boolean;
  envios: ResultadoCanal[];
}): Promise<void> {
  const { error } = await db('autorizacion_envios').insert({
    autorizacion_id: a.autorizacionId,
    expediente_id: a.expedienteId,
    generado_por: a.generadoPor || null,
    es_reenvio: a.esReenvio,
    envios: a.envios,
  } as never);
  if (error) logger.warn({ autorizacionId: a.autorizacionId, err: error.message }, 'BLQ: no se pudo registrar el envío del enlace');
}

/** Marca por qué se cerraron estos enlaces. Solo los que no tenían cierre: el primero manda. */
export async function cerrarEnvios(autorizacionIds: string[], motivo: MotivoCierre): Promise<void> {
  if (autorizacionIds.length === 0) return;
  const { error } = await db('autorizacion_envios')
    .update({ motivo_cierre: motivo, cerrado_at: new Date().toISOString() } as never)
    .in('autorizacion_id', autorizacionIds)
    .is('cerrado_at', null);
  if (error) logger.warn({ autorizacionIds, motivo, err: error.message }, 'BLQ: no se pudo registrar el cierre del enlace');
}

/** Enlaces del titular emitidos para el expediente (cada fila es un envío). Falla cerrado. */
export async function contarEnlacesTitular(expedienteId: string): Promise<number> {
  const { count, error } = await db('autorizaciones_habeas_data')
    .select('id', { count: 'exact', head: true })
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null);
  if (error) throw fromSupabaseError(error);
  return count ?? 0;
}

/** Correcciones del documento del titular en el expediente. Falla cerrado. */
export async function contarCorrecciones(expedienteId: string): Promise<number> {
  const { count, error } = await db('correcciones_documento')
    .select('id', { count: 'exact', head: true })
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null);
  if (error) {
    logger.warn({ expedienteId, err: error.message }, 'BLQ: no se pudieron contar las correcciones');
    throw new AppError(503, 'CORRECCIONES_NO_VERIFICABLES', 'No pudimos verificar las correcciones de este estudio. Intente de nuevo en unos minutos.');
  }
  return count ?? 0;
}

// ============================================================
// Estado derivado (BLQ §8)
// ============================================================

/**
 * Pura. `motivo` es el cierre del último enlace del titular (o, para enlaces de
 * antes del despliegue, el reporte guardado en autorizacion_perfil_prospecto).
 * Una corrección posterior a ese enlace lo deja «pendiente de reenvío»; un
 * reenvío crea otro enlace y el estado vuelve a ser el de ese.
 */
export function derivarEstadoBloqueo(e: {
  autorizacionEstado: string | null;
  autorizacionCreadaEn: string | null;
  motivo: string | null;
  ultimaCorreccionEn: string | null;
}): EstadoBloqueo | null {
  if (!e.autorizacionCreadaEn || e.autorizacionEstado === 'autorizado') return null;
  if (e.ultimaCorreccionEn && Date.parse(e.ultimaCorreccionEn) > Date.parse(e.autorizacionCreadaEn)) return 'pendiente_reenvio';
  if (e.autorizacionEstado !== 'expirado') return null;
  if (e.motivo === 'intentos' || e.motivo === 'datos_incorrectos') return 'bloqueado_documento';
  if (e.motivo === 'no_soy_yo') return 'identidad_rechazada';
  return null;
}

/**
 * BLQ §8.2: tras «no soy yo» solo Cofianza corrige y reenvía. Una corrección de
 * Cofianza deja el estado en «pendiente de reenvío», pero para la inmobiliaria
 * y el propietario sigue rechazada (la API les responde IDENTIDAD_RECHAZADA).
 */
export function estadoBloqueoParaRol(
  b: { estado: EstadoBloqueo | null; motivo: string | null },
  esCofianza: boolean,
): EstadoBloqueo | null {
  return b.estado === 'pendiente_reenvio' && b.motivo === 'no_soy_yo' && !esCofianza ? 'identidad_rechazada' : b.estado;
}

/** Último enlace del titular en el expediente. */
async function ultimoEnlaceTitular(expedienteId: string): Promise<{ id: string; estado: string; created_at: string } | null> {
  const { data } = await db('autorizaciones_habeas_data')
    .select('id, estado, created_at')
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as { id: string; estado: string; created_at: string } | null;
}

/** Por qué se cerró ese enlace (BLQ §7). Enlaces de antes del despliegue: el reporte del perfil. */
async function motivoCierreDe(aut: { id: string; estado: string }): Promise<string | null> {
  const { data: envio } = await db('autorizacion_envios').select('motivo_cierre').eq('autorizacion_id', aut.id).maybeSingle();
  if (envio || aut.estado !== 'expirado') return (envio as { motivo_cierre?: string | null } | null)?.motivo_cierre ?? null;
  const { data: rep } = await db('autorizacion_perfil_prospecto')
    .select('identidad_reporte')
    .eq('autorizacion_id', aut.id)
    .maybeSingle();
  return (rep as { identidad_reporte?: string | null } | null)?.identidad_reporte ?? null;
}

/**
 * Estado derivado del expediente (titular) y el motivo del cierre del último
 * enlace (para distinguir «intentos» de «los datos están mal»). null = sin bloqueo.
 */
export async function leerBloqueo(
  expedienteId: string,
  /** Último enlace del titular, si ya se leyó. */
  ultima?: { id: string; estado: string; created_at: string } | null,
): Promise<{ estado: EstadoBloqueo | null; motivo: string | null }> {
  const aut = ultima === undefined ? await ultimoEnlaceTitular(expedienteId) : ultima;
  if (!aut) return { estado: null, motivo: null };

  const [motivo, { data: corr }] = await Promise.all([
    motivoCierreDe(aut),
    db('correcciones_documento')
      .select('created_at')
      .eq('expediente_id', expedienteId)
      .is('coarrendatario_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const estado = derivarEstadoBloqueo({
    autorizacionEstado: aut.estado,
    autorizacionCreadaEn: aut.created_at,
    motivo,
    ultimaCorreccionEn: (corr as { created_at?: string } | null)?.created_at ?? null,
  });
  return { estado, motivo };
}

export async function estadoBloqueo(
  expedienteId: string,
  ultima?: { id: string; estado: string; created_at: string } | null,
): Promise<EstadoBloqueo | null> {
  return (await leerBloqueo(expedienteId, ultima)).estado;
}

/**
 * BLQ §8.2: el titular dijo «no soy yo» en el último enlace. Se decide por el
 * motivo del cierre y no por el estado derivado: una corrección posterior
 * deja el estado en «pendiente de reenvío», pero no borra el rechazo.
 */
export async function identidadRechazada(expedienteId: string): Promise<boolean> {
  const aut = await ultimoEnlaceTitular(expedienteId);
  return !!aut && (await motivoCierreDe(aut)) === 'no_soy_yo';
}

// ============================================================
// Otras vías de corrección (BLQ §3.5 y §3.6)
// ============================================================

/**
 * ¿La ficha ya tiene un enlace de autorización emitido en un expediente vivo?
 * Desde ese momento su identidad (documento y nombre) solo cambia por
 * «Corregir documento». Falla cerrado.
 */
export async function fichaConEnlaceVivo(solicitanteId: string): Promise<boolean> {
  const { data, error } = await db('autorizaciones_habeas_data')
    .select('id, expedientes(estado)')
    .eq('solicitante_id', solicitanteId)
    .is('coarrendatario_id', null)
    .not('expediente_id', 'is', null);
  if (error) throw fromSupabaseError(error);
  return ((data ?? []) as Array<{ expedientes?: { estado?: string } | null }>).some(
    (r) => !['cerrado', 'rechazado'].includes(r.expedientes?.estado ?? ''),
  );
}

export const MSG_DOCUMENTO_CON_ENLACE =
  'Este prospecto ya recibió el enlace de autorización: su documento solo se corrige con «Corregir documento» en el estudio, y su nombre no se puede cambiar. Si es otra persona, cree un estudio nuevo.';

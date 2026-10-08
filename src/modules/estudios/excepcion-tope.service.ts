// ============================================================
// Excepción de tope de canon — Adenda de precios v1.0 §7.1, §7.3, §7.4.
//
//   7.1 Por encima del tope el estudio pasa al ANALISTA: ni rechazo ni
//       aprobación automáticos. (El cobro y la consulta a las centrales
//       siguen: la Adenda exige que el analista evalúe, y sin consulta no hay
//       qué evaluar. Si la Gerencia no autoriza, no hay devolución: la consulta
//       ya produjo resultado, §2.4.)
//   7.3 El analista no aprueba por encima del tope: solo la Gerencia General
//       (esGerenciaGeneral). «Analista» = operador_analista y administradores
//       que no son Gerencia.
//   7.4 La excepción queda registrada: usuario, fecha y hora, canon autorizado
//       (expedientes.excepcion_tope_*), evento en la línea de tiempo y bitácora.
//
// El canon autorizado es un TECHO: el contrato no puede superarlo
// (calConExcepcion lo aplica donde se valida el canon del contrato). Mientras
// no existan condiciones de coafianzamiento (§10), cada excepción se decide
// caso por caso con el motivo escrito.
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getCalibracion, type Calibracion } from '@/lib/calibracion';
import { esGerenciaGeneral } from '@/lib/gerenciaGeneral';
import { assertExpedienteAccess } from '@/lib/tenantScope';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { topeCanonPara, type ClaveTopeCanon } from '../inmuebles/destinacion';
import { formatearCOP, leerInmuebleDelTope } from './tope-canon.guard';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;

export const SOLO_GERENCIA_GENERAL = 'SOLO_GERENCIA_GENERAL';

export interface TopeDelExpediente {
  canonCop: number | null;
  topeCop: number;
  /** expedientes.excepcion_tope_canon_cop; null si no hay excepción. */
  excepcionCop: number | null;
}

const positivo = (v: unknown): number | null => {
  const n = Number(v);
  return v !== null && v !== undefined && Number.isFinite(n) && n > 0 ? n : null;
};

/** Pura: el caso necesita a la Gerencia General para aprobarse. */
export function requiereGerencia(t: TopeDelExpediente): boolean {
  return t.canonCop !== null && t.canonCop > t.topeCop && t.excepcionCop === null;
}

/**
 * Pura: la calibración con el tope subido al canon autorizado. Todo lo que
 * valida el canon del contrato lee el tope de aquí (topeCanonPara), así que
 * con esto el techo del contrato pasa a ser el canon autorizado.
 */
export function calConExcepcion<T extends Pick<Calibracion, ClaveTopeCanon>>(cal: T, excepcion: unknown): T {
  const n = positivo(excepcion);
  if (n === null) return cal;
  return {
    ...cal,
    CANON_MAX_TRANSITORIO: Math.max(cal.CANON_MAX_TRANSITORIO, n),
    TOPE_CANON_COMERCIAL: Math.max(cal.TOPE_CANON_COMERCIAL, n),
  };
}

/** Canon del inmueble, tope de su destinación y excepción registrada. Falla cerrado. */
export async function leerTopeDelExpediente(expedienteId: string): Promise<TopeDelExpediente & { estado: string | null }> {
  const { data, error } = await db('expedientes')
    .select('inmueble_id, estado, excepcion_tope_canon_cop')
    .eq('id', expedienteId)
    .maybeSingle();
  if (error) throw new AppError(503, 'CANON_NO_VERIFICABLE', 'No pudimos verificar el canon del estudio. Inténtelo de nuevo en un momento.');
  if (!data) throw AppError.notFound('Estudio no encontrado', 'EXPEDIENTE_NOT_FOUND');
  const exp = data as { inmueble_id: string | null; estado: string | null; excepcion_tope_canon_cop: unknown };
  const [inm, cal] = await Promise.all([leerInmuebleDelTope({ inmuebleId: exp.inmueble_id }), getCalibracion()]);
  return {
    canonCop: positivo(inm?.valor_arriendo),
    topeCop: topeCanonPara(inm?.uso, cal).topeCop,
    excepcionCop: positivo(exp.excepcion_tope_canon_cop),
    estado: exp.estado,
  };
}

async function guardarExcepcion(
  expedienteId: string,
  canonAutorizadoCop: number,
  motivo: string,
  userId: string,
  t: TopeDelExpediente,
  ip?: string,
): Promise<void> {
  const en = new Date().toISOString();
  const { error } = await db('expedientes')
    .update({
      excepcion_tope_canon_cop: canonAutorizadoCop,
      excepcion_tope_por: userId,
      excepcion_tope_en: en,
      excepcion_tope_motivo: motivo,
      updated_at: en,
    } as never)
    .eq('id', expedienteId);
  if (error) {
    logger.error({ expedienteId, error: error.message }, 'Excepción de tope: no se pudo guardar');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo registrar la excepción de tope. Inténtelo de nuevo.');
  }
  const { error: tlError } = await db('eventos_timeline').insert({
    expediente_id: expedienteId,
    tipo: 'estudio',
    descripcion:
      `La Gerencia General autorizó la excepción de tope: canon autorizado de hasta ${formatearCOP(canonAutorizadoCop)} ` +
      `(tope vigente ${formatearCOP(t.topeCop)}). Motivo: ${motivo}`,
    usuario_id: userId,
    metadata: { excepcion_tope: true, canon_autorizado_cop: canonAutorizadoCop, canon_cop: t.canonCop, tope_cop: t.topeCop },
  } as never);
  if (tlError) logger.warn({ expedienteId, error: tlError.message }, 'Excepción de tope: no se pudo dejar el evento en la línea de tiempo');
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.EXPEDIENTE_EXCEPCION_TOPE,
    entidad: AUDIT_ENTITIES.EXPEDIENTE,
    entidadId: expedienteId,
    detalle: { canon_autorizado_cop: canonAutorizadoCop, canon_cop: t.canonCop, tope_cop: t.topeCop, motivo, anterior_cop: t.excepcionCop },
    ip,
  });
}

/**
 * §7.3: en todo camino que APRUEBA un estudio. Por encima del tope y sin
 * excepción, 403 salvo la Gerencia General; si aprueba ella directamente, la
 * excepción queda registrada (§7.4) con el canon del inmueble como techo.
 */
export async function assertAprobacionDentroDelTope(
  expedienteId: string,
  user: { id: string; rol: string; email: string },
  ip?: string,
): Promise<void> {
  const t = await leerTopeDelExpediente(expedienteId);
  if (!requiereGerencia(t)) return;
  if (!esGerenciaGeneral(user)) {
    // §7.3 «exigir escalamiento»: un caso que el motor dejó condicionado por
    // otra razón no pasó por retenerAprobadoSobreTope, así que la Gerencia no
    // se había enterado. Una vez por estudio (escalarTopeCanon deduplica).
    const enviado = await (await import('@/modules/contratos/tope-coafianzamiento'))
      .escalarTopeCanon(expedienteId, t.canonCop!, t.topeCop, 'estudio');
    throw AppError.forbidden(
      `El canon (${formatearCOP(t.canonCop!)}) supera el tope de ${formatearCOP(t.topeCop)}: ` +
        'la aprobación requiere la autorización de la Gerencia General.' +
        (enviado ? ' El caso ya está en la Gerencia General.' : ''),
      SOLO_GERENCIA_GENERAL,
    );
  }
  await guardarExcepcion(expedienteId, t.canonCop!, 'Aprobación directa de la Gerencia General.', user.id, t, ip);
}

/** §7.3-7.4: la Gerencia General autoriza la excepción (canon autorizado + motivo). */
export async function autorizarExcepcionTope(
  expedienteId: string,
  input: { canon_autorizado_cop: number; motivo: string },
  user: { id: string; rol: string; email: string },
  ip?: string,
): Promise<TopeDelExpediente> {
  if (!esGerenciaGeneral(user))
    throw AppError.forbidden('La excepción de tope de canon solo la autoriza la Gerencia General.', SOLO_GERENCIA_GENERAL);
  await assertExpedienteAccess(expedienteId, user.id, user.rol);
  const t = await leerTopeDelExpediente(expedienteId);
  if (t.estado === 'cerrado' || t.estado === 'rechazado')
    throw AppError.conflict('El estudio ya está cerrado: no admite una excepción de tope.', 'EXCEPCION_TOPE_ESTADO');
  if (input.canon_autorizado_cop <= t.topeCop)
    throw AppError.badRequest(
      `El canon autorizado debe superar el tope vigente (${formatearCOP(t.topeCop)}); hasta el tope no hace falta excepción.`,
      'EXCEPCION_TOPE_NO_APLICA',
    );
  const motivo = input.motivo.trim();
  await guardarExcepcion(expedienteId, input.canon_autorizado_cop, motivo, user.id, t, ip);
  return { ...t, excepcionCop: input.canon_autorizado_cop };
}

/** Cierra las dos notas de retenerAprobadoSobreTope; la lee retenidoSoloPorTope. */
const MARCA_RETENIDO_POR_TOPE = 'el estudio pasa a revisión y su aprobación requiere la autorización de la Gerencia General';
/** La de las notas escritas antes de 2026-10 (las filas guardadas no se reescriben). */
const MARCA_RETENIDO_POR_TOPE_ANTERIOR = '(Adenda de precios §7): el estudio pasa a revisión';

/**
 * Pura: el estudio quedó condicionado SOLO por el tope. La nota de
 * retenerAprobadoSobreTope se pone únicamente sobre un «aprobado», así que su
 * presencia en las observaciones dice que el buró o el motor lo aprobaban: no
 * hay documentos ni coarrendatario que pedir, falta la Gerencia General.
 */
export function retenidoSoloPorTope(observaciones: string | null | undefined): boolean {
  return !!observaciones && (observaciones.includes(MARCA_RETENIDO_POR_TOPE) || observaciones.includes(MARCA_RETENIDO_POR_TOPE_ANTERIOR));
}

/**
 * §7.1 en los caminos automáticos: un «aprobado» sobre el tope sin excepción
 * no aprueba solo; queda en revisión (condicionado) con la nota para el
 * analista. Nunca rechaza por el tope. Si no se puede leer, se retiene (lado
 * seguro: revisión humana).
 */
export async function retenerAprobadoSobreTope<T extends { resultado: string; observaciones: string | null }>(
  expedienteId: string,
  final: T,
): Promise<T> {
  if (final.resultado !== 'aprobado') return final;
  let t: TopeDelExpediente | null = null;
  try {
    t = await leerTopeDelExpediente(expedienteId);
    if (!requiereGerencia(t)) return final;
  } catch (e) {
    logger.warn({ expedienteId, error: e instanceof Error ? e.message : String(e) }, 'Tope 7.1: no se pudo leer el canon — el aprobado queda en revisión');
  }
  if (t?.canonCop) {
    void import('@/modules/contratos/tope-coafianzamiento')
      .then((m) => m.escalarTopeCanon(expedienteId, t!.canonCop!, t!.topeCop, 'estudio'))
      .catch(() => undefined);
  }
  const nota = t?.canonCop
    ? `El canon (${formatearCOP(t.canonCop)}) supera el tope de ${formatearCOP(t.topeCop)}: ${MARCA_RETENIDO_POR_TOPE} de Cofianza.`
    : `No se pudo verificar el canon contra el tope: ${MARCA_RETENIDO_POR_TOPE} de Cofianza.`;
  return { ...final, resultado: 'condicionado', observaciones: [final.observaciones, nota].filter(Boolean).join(' ') };
}

export interface TopeCanonDetalle {
  canon_cop: number | null;
  tope_cop: number;
  /** Por encima del tope y sin excepción: aprobar es solo de la Gerencia General. */
  requiere_gerencia: boolean;
  excepcion: { canon_autorizado_cop: number; por_nombre: string | null; en: string | null; motivo: string | null } | null;
}

/**
 * Para el detalle del estudio (roles de Cofianza). Aparte y sin fallar: si el
 * API sale antes que la migración 20261003000101, el detalle no se cae.
 */
export async function topeParaDetalle(expedienteId: string): Promise<TopeCanonDetalle | null> {
  try {
    const { data, error } = await db('expedientes')
      .select('excepcion_tope_por, excepcion_tope_en, excepcion_tope_motivo')
      .eq('id', expedienteId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const t = await leerTopeDelExpediente(expedienteId);
    const fila = data as { excepcion_tope_por: string | null; excepcion_tope_en: string | null; excepcion_tope_motivo: string | null } | null;
    let porNombre: string | null = null;
    if (t.excepcionCop !== null && fila?.excepcion_tope_por) {
      const { data: p } = await db('perfiles').select('nombre, apellido').eq('id', fila.excepcion_tope_por).maybeSingle();
      const perfil = p as { nombre?: string | null; apellido?: string | null } | null;
      porNombre = perfil ? `${perfil.nombre ?? ''} ${perfil.apellido ?? ''}`.trim() || null : null;
    }
    return {
      canon_cop: t.canonCop,
      tope_cop: t.topeCop,
      requiere_gerencia: requiereGerencia(t),
      excepcion:
        t.excepcionCop === null
          ? null
          : { canon_autorizado_cop: t.excepcionCop, por_nombre: porNombre, en: fila?.excepcion_tope_en ?? null, motivo: fila?.excepcion_tope_motivo ?? null },
    };
  } catch (e) {
    logger.warn({ expedienteId, error: e instanceof Error ? e.message : String(e) }, 'Detalle: no se pudo leer la excepción de tope');
    return null;
  }
}

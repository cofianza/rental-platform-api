/**
 * Adenda de precios v1.0 §5 — prima de vinculación en modalidad Trasladada.
 *
 * §5.1: la inmobiliaria la recauda del arrendatario por cuenta de Cofianza y
 * la remite el día 10, el del recaudo general. Con la fianza activa queda una
 * cuenta por cobrar a la inmobiliaria (cuentas_por_cobrar_inmobiliaria) que un
 * operador marca como remitida. Si no se remite no hay bloqueo: queda
 * 'pendiente' y visible.
 * §5.2: la prima no genera beneficio ni descuento. Se registra completa (con
 * IVA, la del contrato firmado); nada en la plataforma calcula un beneficio o
 * un descuento sobre ella, y lo que se construya para el beneficio del 10 %
 * (sobre la TARIFA MENSUAL) no debe leer esta tabla ni los pagos 'garantia'.
 * §5.3: el reporte de lo que Cofianza cobra sale con al menos 10 días de
 * anticipación: el último día del mes para lo que vence el día 10 siguiente.
 * Días calendario, en hora de Bogotá.
 */

import { AUDIT_ACTIONS, AUDIT_ENTITIES, logAudit } from '@/lib/auditLog';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { formatearPesos } from '@/lib/numerosEnLetras';
import { supabase } from '@/lib/supabase';
import { fechaBogota } from '@/modules/contratos/v3/formato';
import { enviarCorreoNotificacion, notificarUsuario } from '@/modules/notificaciones/notificaciones.service';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
const TABLA = 'cuentas_por_cobrar_inmobiliaria';
const ANTICIPACION_DIAS = 10;

const diasDelMes = (anio: number, mes: number) => new Date(Date.UTC(anio, mes, 0)).getUTCDate();
const dos = (n: number) => String(n).padStart(2, '0');
/** Día 10 del mes que queda `meses` después del de `iso` (AAAA-MM-DD). */
const dia10En = (iso: string, meses: number) => {
  const [a, m] = iso.split('-').map(Number);
  const t = a * 12 + (m - 1) + meses;
  return `${Math.floor(t / 12)}-${dos((t % 12) + 1)}-10`;
};
export const ddmmaaaa = (iso: string) => iso.split('-').reverse().join('/');

/**
 * Fecha límite de remisión (§5.1): el día 10 del mes siguiente a la activación.
 * Si la activación cae en los últimos 10 días del mes, el reporte del último
 * día ya no tendría 10 días de anticipación (§5.3): pasa al día 10 del mes
 * subsiguiente. `activacion` = AAAA-MM-DD en hora de Bogotá.
 */
export function venceRemision(activacion: string): string {
  const [a, m, d] = activacion.split('-').map(Number);
  return dia10En(activacion, d > diasDelMes(a, m) - ANTICIPACION_DIAS ? 2 : 1);
}

/** El vencimiento que se reporta hoy (§5.3), o null si hoy no es el último día del mes. */
export function venceReportadoHoy(hoy: string): string | null {
  const [a, m, d] = hoy.split('-').map(Number);
  return d === diasDelMes(a, m) ? dia10En(hoy, 1) : null;
}

const faltaTabla = (e: { code?: string } | null) => !!e && ['PGRST205', '42P01'].includes(e.code ?? '');

/**
 * Registra la prima Trasladada por remitir al activar el contrato. Idempotente
 * (UNIQUE contrato_id + concepto): una curación o un reintento no la duplican
 * ni le cambian la fecha. Lanza si la base falla, para que la activación se
 * reintente; sin la migración solo lo registra en el log.
 */
export async function registrarPrimaTrasladada(p: {
  inmobiliariaId: string;
  contratoId: string;
  montoCop: number;
  venceEn: string;
}): Promise<void> {
  const { error } = await db(TABLA).upsert(
    {
      inmobiliaria_id: p.inmobiliariaId,
      contrato_id: p.contratoId,
      concepto: 'prima_trasladada',
      monto_cop: p.montoCop,
      vence_en: p.venceEn,
    } as never,
    { onConflict: 'contrato_id,concepto', ignoreDuplicates: true },
  );
  if (!error) return;
  if (faltaTabla(error)) {
    logger.error({ contratoId: p.contratoId }, 'Prima Trasladada: falta la migración 20261003000401 (cuenta por cobrar sin registrar)');
    return;
  }
  throw new Error(`Prima Trasladada: no se pudo registrar la cuenta por cobrar: ${error.message}`);
}

const COLS =
  'id, inmobiliaria_id, contrato_id, concepto, monto_cop, vence_en, estado, remitida_en, remitida_por, notas, reporte_enviado_en, created_at, ' +
  'inmobiliarias(nombre), contratos(numero, expediente_id, direccion:datos_variables->documento->entrada->inmueble->>direccion)';

interface Fila {
  id: string;
  inmobiliaria_id: string;
  contrato_id: string;
  monto_cop: number;
  vence_en: string;
  estado: string;
  inmobiliarias: { nombre: string } | null;
  contratos: { numero: string; expediente_id: string; direccion: string | null } | null;
}

/** Panel de Cofianza: pendientes primero (la que vence antes arriba), luego el resto. */
export async function listarPrimasPorRemitir(estado?: 'pendiente' | 'remitida' | 'anulada') {
  let q = db(TABLA).select(COLS).order('vence_en', { ascending: true }).limit(500); // ponytail: sin paginar; paginar si pasa de cientos
  if (estado) q = q.eq('estado', estado);
  const { data, error } = await q;
  if (error) throw fromSupabaseError(error);
  const filas = (data as unknown as Fila[] | null) ?? [];
  return filas.sort((x, y) => Number(x.estado !== 'pendiente') - Number(y.estado !== 'pendiente'));
}

/** Un operador deja constancia de que la inmobiliaria remitió la prima. */
export async function marcarRemitida(id: string, userId: string, notas: string | null, ip?: string) {
  const { data, error } = await db(TABLA)
    .update({ estado: 'remitida', remitida_en: new Date().toISOString(), remitida_por: userId, notas, updated_at: new Date().toISOString() } as never)
    .eq('id', id)
    .eq('estado', 'pendiente')
    .select('id, contrato_id, monto_cop, vence_en')
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) {
    const { data: fila } = await db(TABLA).select('estado').eq('id', id).maybeSingle();
    if (!fila) throw AppError.notFound('Cuenta por cobrar no encontrada');
    throw AppError.conflict(`La cuenta ya está ${(fila as { estado: string }).estado}`, 'CUENTA_NO_PENDIENTE');
  }
  const f = data as { contrato_id: string; monto_cop: number; vence_en: string };
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PRIMA_REMITIDA,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: f.contrato_id,
    detalle: { cuenta_id: id, monto_cop: f.monto_cop, vence_en: f.vence_en, notas },
    ip,
  });
  return data;
}

/**
 * §5.3: el último día de cada mes, a los titulares de cada inmobiliaria con
 * primas pendientes que vencen el día 10 siguiente, un correo y un aviso
 * in-app con el detalle. reporte_enviado_en evita repetirlo (el barrido corre
 * varias veces al día). Una org sin titulares activos se reintenta en la
 * siguiente pasada.
 */
export async function barrerReporteRemision(ahora = new Date()): Promise<{ inmobiliarias: number }> {
  const vence = venceReportadoHoy(fechaBogota(ahora));
  if (!vence) return { inmobiliarias: 0 };
  const { data, error } = await db(TABLA)
    .select(COLS)
    .eq('estado', 'pendiente')
    .eq('vence_en', vence)
    .is('reporte_enviado_en', null);
  if (error) {
    if (faltaTabla(error)) return { inmobiliarias: 0 };
    throw new Error(`Reporte de primas: ${error.message}`);
  }
  const porOrg = new Map<string, Fila[]>();
  for (const f of (data as unknown as Fila[] | null) ?? []) porOrg.set(f.inmobiliaria_id, [...(porOrg.get(f.inmobiliaria_id) ?? []), f]);

  let enviadas = 0;
  for (const [orgId, filas] of porOrg) {
    const { data: m, error: mErr } = await db('inmobiliaria_miembros')
      .select('perfil_id')
      .eq('inmobiliaria_id', orgId)
      .eq('rol_miembro', 'owner')
      .eq('estado', 'activo')
      .not('perfil_id', 'is', null);
    const titulares = ((m as { perfil_id: string }[] | null) ?? []).map((x) => x.perfil_id);
    if (mErr || !titulares.length) {
      logger.warn({ orgId, error: mErr?.message }, 'Reporte de primas: inmobiliaria sin titulares a quien avisar');
      continue;
    }
    const fecha = ddmmaaaa(vence);
    const total = filas.reduce((s, f) => s + f.monto_cop, 0);
    const detalle = filas
      .map((f) => `contrato ${f.contratos?.numero ?? f.contrato_id}${f.contratos?.direccion ? `, inmueble ${f.contratos.direccion}` : ''}: $${formatearPesos(f.monto_cop)} (IVA incluido)`)
      .join('; ');
    const aviso = {
      tipo: 'contrato.prima_reporte_remision',
      titulo: `Primas de vinculación por remitir a Cofianza — fecha límite ${fecha}`,
      mensaje:
        `Le informamos las primas de vinculación de la modalidad Trasladada que su inmobiliaria recauda por cuenta de COFIANZA S.A.S. ` +
        `y que corresponde remitir a más tardar el ${fecha}: ${detalle}. Total: $${formatearPesos(total)} (IVA incluido). ` +
        'Si ya realizó la remisión, puede omitir este mensaje.',
      link: '/contratos',
      payload: { vence_en: vence, cuentas: filas.map((f) => f.id), total_cop: total },
    };
    for (const userId of titulares) {
      await notificarUsuario({ userId, ...aviso });
      await enviarCorreoNotificacion({ userId, ...aviso });
    }
    // ponytail: si el proceso cae antes de este UPDATE, la siguiente pasada del día repite el reporte (duplicado inocuo).
    const { error: uErr } = await db(TABLA)
      .update({ reporte_enviado_en: new Date().toISOString() } as never)
      .in('id', filas.map((f) => f.id))
      .is('reporte_enviado_en', null);
    if (uErr) logger.error({ orgId, error: uErr.message }, 'Reporte de primas: enviado pero sin constancia');
    enviadas++;
  }
  return { inmobiliarias: enviadas };
}

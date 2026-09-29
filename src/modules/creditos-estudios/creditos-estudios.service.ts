/**
 * Creditos de Estudios Service
 *
 * Permite a las inmobiliarias:
 * - Comprar paquetes de estudios via Stripe Checkout
 * - Consultar saldo y movimientos
 * - Liberar manualmente un estudio para un solicitante consumiendo 1 credito
 *
 * Webhook Stripe: cuando llega checkout.session.completed con
 * metadata.concepto = 'creditos_estudios', se acredita el lote.
 */

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { getPaymentGateway } from '@/modules/pagos/gateway';
import {
  perfilEsDuenoDeInmueble,
  resolveInmobiliariaIdForPerfil,
  resolveOrgCanonicalPerfilId,
  resolveOrgOwnerPerfilIds,
} from '@/lib/tenantScope';
import { assertCanonDentroDelTope } from '@/modules/estudios/tope-canon.guard';
import { faltaColumna } from '@/modules/expedientes/cierre-sin-acta';
import { getCalibracion } from '@/lib/calibracion';
import { esGerenciaGeneral } from '@/lib/gerenciaGeneral';
import type { ListMovimientosQuery } from './creditos-estudios.schema';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;

// ============================================================
// Types
// ============================================================

interface PaqueteRow {
  id: string;
  nombre: string;
  descripcion: string | null;
  cantidad_estudios: number;
  precio_cop: number;
  vence_en_dias: number | null;
  activo: boolean;
  orden: number;
  created_at: string;
  updated_at: string;
}

interface CompraRow {
  id: string;
  perfil_id: string;
  paquete_id: string;
  cantidad_estudios: number;
  precio_cop: number;
  vence_en_dias: number | null;
  estado: 'pendiente' | 'completado' | 'fallido' | 'cancelado';
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  payment_link_url: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LoteRow {
  id: string;
  perfil_id: string;
  compra_id: string | null;
  cantidad_inicial: number;
  cantidad_disponible: number;
  vence_en: string | null;
  origen: 'compra' | 'ajuste_admin';
  notas: string | null;
  created_at: string;
}

// ============================================================
// Public: list active paquetes
// ============================================================

export async function listPaquetesActivos(): Promise<Array<PaqueteRow & { vigencia_meses: number }>> {
  const [{ data, error }, { VIGENCIA_PAQUETE_MESES }] = await Promise.all([
    (supabase
      .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .select('*')
      .eq('activo', true)
      .order('orden', { ascending: true }),
    getCalibracion(),
  ]);

  if (error) throw fromSupabaseError(error);
  // La vigencia que tendrá el paquete al comprarlo (Adenda de precios §3.1 / §9.6).
  return ((data || []) as PaqueteRow[]).map((p) => ({ ...p, vigencia_meses: VIGENCIA_PAQUETE_MESES }));
}

// ============================================================
// Saldo + lotes activos
//
// Los créditos son de la ORGANIZACIÓN, no de quien los compró: viven a nombre
// del titular principal (perfil canónico). Las funciones de abajo reciben el
// perfil de quien llama y lo resuelven al canónico; sin eso un miembro veía
// saldo 0 con el paquete del titular sin usar y volvía a pagar.
// ============================================================

export interface SaldoCreditos {
  saldo_total: number;
  saldo_perpetuo: number;
  saldo_con_vencimiento: number;
  proximo_vencimiento: string | null;
  /** P22: créditos usados de una compra contracargada; se descuentan de la próxima compra. */
  creditos_en_contra: number;
  /** P22: lo que se puede gastar (saldo_total menos creditos_en_contra). */
  saldo_efectivo: number;
  /**
   * Adenda de precios §2: cupos reservados por estudios liberados que todavía
   * no llegan a resultado. Ya están fuera de saldo_total (salieron del lote);
   * vuelven si la consulta no da resultado.
   */
  saldo_reservado: number;
  lotes: Array<{
    id: string;
    cantidad_disponible: number;
    cantidad_inicial: number;
    vence_en: string | null;
    origen: string;
    created_at: string;
  }>;
}

export async function getSaldoCreditos(perfilId: string): Promise<SaldoCreditos> {
  const nowIso = new Date().toISOString();
  const dueno = await resolveOrgCanonicalPerfilId(perfilId);

  const [{ data, error }, enContra, reservado] = await Promise.all([
    (supabase
      .from('lotes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .select('id, cantidad_disponible, cantidad_inicial, vence_en, origen, created_at')
      .eq('perfil_id', dueno)
      .gt('cantidad_disponible', 0)
      .or(`vence_en.is.null,vence_en.gt.${nowIso}`)
      .order('created_at', { ascending: true }),
    // Solo se muestra: pagar con créditos lo vuelve a leer y ahí sí bloquea.
    creditosEnContra(dueno).catch((err) => {
      logger.warn({ err, dueno }, 'No se pudo leer el saldo en contra de créditos');
      return 0;
    }),
    // Solo se muestra, como el saldo en contra.
    cuposReservados(dueno).catch((err) => {
      logger.warn({ err, dueno }, 'No se pudieron leer los cupos reservados');
      return 0;
    }),
  ]);

  if (error) throw fromSupabaseError(error);

  const lotes = (data || []) as Array<{
    id: string;
    cantidad_disponible: number;
    cantidad_inicial: number;
    vence_en: string | null;
    origen: string;
    created_at: string;
  }>;

  let saldoPerpetuo = 0;
  let saldoConVencimiento = 0;
  let proximoVencimiento: string | null = null;

  for (const l of lotes) {
    if (l.vence_en === null) {
      saldoPerpetuo += l.cantidad_disponible;
    } else {
      saldoConVencimiento += l.cantidad_disponible;
      if (proximoVencimiento === null || l.vence_en < proximoVencimiento) {
        proximoVencimiento = l.vence_en;
      }
    }
  }

  return {
    saldo_total: saldoPerpetuo + saldoConVencimiento,
    saldo_perpetuo: saldoPerpetuo,
    saldo_con_vencimiento: saldoConVencimiento,
    proximo_vencimiento: proximoVencimiento,
    creditos_en_contra: enContra,
    saldo_efectivo: saldoEfectivo(saldoPerpetuo + saldoConVencimiento, enContra),
    saldo_reservado: reservado,
    lotes,
  };
}

/** Pura: cuántos pagos tienen la reserva abierta (su último movimiento es 'reserva'). */
export function contarReservasAbiertas(movs: ReadonlyArray<{ pago_id: string | null; tipo: string }>): number {
  const ultimo = new Map<string, string>();
  for (const m of movs) if (m.pago_id) ultimo.set(m.pago_id, m.tipo); // vienen en orden cronológico
  return [...ultimo.values()].filter((t) => estadoCupo({ tipo: t }) === 'reservado').length;
}

/**
 * Cupos reservados de la organización. ponytail: mira los movimientos de los
 * últimos 180 días (una reserva se consume o se libera en días); ampliar si
 * alguna llega a durar más.
 */
async function cuposReservados(perfilCanonico: string): Promise<number> {
  const desde = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const { data, error } = await db('movimientos_creditos_estudios')
    .select('pago_id, tipo')
    .eq('perfil_id', perfilCanonico)
    .in('tipo', TIPOS_CUPO)
    .gte('created_at', desde)
    .order('created_at', { ascending: true })
    .limit(5000);
  if (error) throw fromSupabaseError(error);
  return contarReservasAbiertas((data ?? []) as Array<{ pago_id: string | null; tipo: string }>);
}

/**
 * P22: créditos usados de compras contracargadas que todavía no cubre una
 * compra nueva (el saldo en contra de la organización). Sin la migración
 * 20261001000005 no hay columna ni, por lo tanto, saldo en contra registrado.
 */
export async function creditosEnContra(perfilCanonico: string): Promise<number> {
  const { data, error } = await db('compras_creditos_estudios')
    .select('creditos_en_contra')
    .eq('perfil_id', perfilCanonico)
    .gt('creditos_en_contra', 0);
  if (error) {
    if (faltaColumna(error)) return 0;
    throw fromSupabaseError(error);
  }
  return ((data ?? []) as Array<{ creditos_en_contra: number }>).reduce((s, c) => s + c.creditos_en_contra, 0);
}

/**
 * P22: el 409 de quien intenta pagar con créditos sin saldo efectivo (lo
 * disponible menos lo que quedó en contra por el contracargo de una compra).
 */
export function errorCreditosEnContra(enContra: number): AppError {
  const uno = enContra === 1;
  return AppError.conflict(
    `Tu organización tiene ${enContra} ${uno ? 'crédito' : 'créditos'} en contra por el contracargo de una compra y no le queda saldo para pagar con créditos: ` +
      `se ${uno ? 'descuenta' : 'descuentan'} de tu próxima compra. Mientras tanto paga la evaluación de inmediato o envía el enlace al prospecto.`,
    'CREDITOS_EN_CONTRA',
  );
}

/** P22: lo que de verdad se puede gastar: lo disponible menos lo que quedó en contra. */
export function saldoEfectivo(disponible: number, enContra: number): number {
  return Math.max(0, disponible - enContra);
}

/** Saldo vigente del perfil (lotes sin vencer), el que queda en cada movimiento. */
async function saldoVigente(perfilId: string): Promise<number> {
  const { data } = await db('lotes_creditos_estudios')
    .select('cantidad_disponible')
    .eq('perfil_id', perfilId)
    .or(`vence_en.is.null,vence_en.gt.${new Date().toISOString()}`);
  return ((data || []) as Array<{ cantidad_disponible: number }>).reduce((sum, l) => sum + l.cantidad_disponible, 0);
}

/**
 * Suma `delta` al disponible de un lote con compare-and-set (un consumo puede
 * cruzarse). Devuelve false si tras unos reintentos no pudo, o si el resultado
 * saldría del rango del lote.
 */
async function moverDisponible(loteId: string, delta: number): Promise<boolean> {
  for (let intento = 0; intento < 5; intento++) {
    const { data: lote } = await db('lotes_creditos_estudios')
      .select('cantidad_disponible, cantidad_inicial')
      .eq('id', loteId)
      .maybeSingle();
    const l = lote as { cantidad_disponible: number; cantidad_inicial: number } | null;
    if (!l) return false;
    const nuevo = l.cantidad_disponible + delta;
    if (nuevo < 0 || nuevo > l.cantidad_inicial) return false;
    const { data: ok } = await db('lotes_creditos_estudios')
      .update({ cantidad_disponible: nuevo } as never)
      .eq('id', loteId)
      .eq('cantidad_disponible', l.cantidad_disponible)
      .select('id');
    if ((ok as unknown[] | null)?.length) return true;
  }
  return false;
}

// ============================================================
// Alerta de saldo bajo (Adenda de precios §3.7 / §9.8)
// ============================================================

/** Pura: ¿el saldo disponible cruzó el umbral hacia abajo (de ≥N a <N)? */
export function cruzaUmbralSaldo(antes: number, despues: number, umbral: number): boolean {
  return antes >= umbral && despues < umbral;
}

/**
 * Aviso (in-app + correo) a los titulares activos de la organización cuando su
 * saldo disponible baja de ALERTA_SALDO_MINIMO_CUPOS: solo al cruzar el umbral,
 * así cada reserva por debajo no repite el aviso. Distinto del aviso «Cofianza
 * usó un crédito» (H99), que sale por cada uso de Cofianza. Nunca lanza.
 */
export async function avisarSiSaldoBajo(perfilCanonico: string, antes: number, despues: number): Promise<void> {
  try {
    const { ALERTA_SALDO_MINIMO_CUPOS: umbral } = await getCalibracion();
    if (!cruzaUmbralSaldo(antes, despues, umbral)) return;

    const orgId = await resolveInmobiliariaIdForPerfil(perfilCanonico);
    // Siempre incluye al perfil que guarda el saldo (legado: org sin filas de titular).
    const titulares = [...new Set([perfilCanonico, ...(orgId ? await resolveOrgOwnerPerfilIds(orgId) : [])])];
    const mensaje =
      despues === 0
        ? 'Su organización ya no tiene cupos disponibles en sus paquetes prepagados de estudios.'
        : `A su organización le ${despues === 1 ? 'queda 1 cupo disponible' : `quedan ${despues} cupos disponibles`} en sus paquetes prepagados de estudios.`;
    // Import dinámico, como el orchestrator: notificaciones arrastra config y correos.
    const { notificarYCorreo } = await import('@/modules/notificaciones/notificaciones.service');
    await Promise.all(
      titulares.map((userId) =>
        notificarYCorreo({
          userId,
          tipo: 'creditos.saldo_bajo',
          titulo: 'Saldo bajo de cupos de estudio',
          mensaje: `${mensaje} Cuando se agoten, cada evaluación se paga al precio individual o con un paquete nuevo.`,
          link: '/configuracion/creditos-estudios',
          payload: { saldo_disponible: despues, umbral },
        }),
      ),
    );
  } catch (err) {
    logger.warn({ err, perfilCanonico }, 'No se pudo avisar el saldo bajo de cupos');
  }
}

// ============================================================
// Extinción de cupos vencidos (Adenda de precios §3.1)
// ============================================================

/**
 * Barrido diario (CUPOS_VENCIMIENTO_ENABLED): los lotes vencidos que aún
 * tienen saldo quedan en 0 con un movimiento 'expiracion' por lo que tenían
 * (RPC extinguir_lote_vencido, idempotente con el lote bloqueado). Las
 * reservas abiertas no se tocan: ya salieron del lote, y si se liberan después
 * la RPC de liberación las extingue en el acto. Luego avisa el saldo bajo por
 * organización. Devuelve los cupos extinguidos.
 */
export async function extinguirCuposVencidos(): Promise<number> {
  // ponytail: 500 lotes por ciclo; el que sobre lo toma el ciclo siguiente.
  const { data, error } = await db('lotes_creditos_estudios')
    .select('id')
    .gt('cantidad_disponible', 0)
    .lte('vence_en', new Date().toISOString())
    .order('vence_en', { ascending: true })
    .limit(500);
  if (error) throw fromSupabaseError(error);

  const porPerfil = new Map<string, { extinguidos: number; saldo: number }>();
  let total = 0;
  for (const { id } of (data ?? []) as Array<{ id: string }>) {
    const { data: r, error: rErr } = await rpc('extinguir_lote_vencido', { p_lote_id: id });
    if (rErr) {
      logger.warn({ loteId: id, error: rErr.message }, 'No se pudo extinguir el lote vencido');
      continue;
    }
    const fila = ((r ?? []) as Array<{ lote_perfil_id: string; extinguidos: number; saldo_restante: number }>)[0];
    if (!fila?.extinguidos) continue; // otro ciclo ya lo extinguió
    total += fila.extinguidos;
    const acc = porPerfil.get(fila.lote_perfil_id) ?? { extinguidos: 0, saldo: 0 };
    porPerfil.set(fila.lote_perfil_id, { extinguidos: acc.extinguidos + fila.extinguidos, saldo: fila.saldo_restante });
  }

  // ponytail: el saldo ya había dejado de contar el lote al vencer; se toma
  // «antes» como si siguiera vigente, así que una reserva hecha entre el
  // vencimiento y el barrido puede dar un segundo aviso.
  for (const [perfil, { extinguidos, saldo }] of porPerfil) await avisarSiSaldoBajo(perfil, saldo + extinguidos, saldo);
  if (total > 0) logger.info({ total, organizaciones: porPerfil.size }, 'Cupos vencidos extinguidos (Adenda de precios §3.1)');
  return total;
}

// ============================================================
// Movimientos (historial)
// ============================================================

export async function listMovimientos(perfilId: string, query: ListMovimientosQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;
  const dueno = await resolveOrgCanonicalPerfilId(perfilId);

  let q = (supabase
    .from('movimientos_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, tipo, cantidad, saldo_resultante, expediente_id, solicitante_id, lote_id, notas, created_at, literal, estudio_id, referencia_proveedor',
      { count: 'exact' },
    )
    .eq('perfil_id', dueno);

  if (query.tipo) q = q.eq('tipo', query.tipo);

  q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw fromSupabaseError(error);

  const movimientos = (data || []) as Array<Record<string, unknown>>;

  // Enriquecer con compra_id + factura_id para los movimientos tipo 'compra'.
  // Se hace en 2 queries planos (sin embed de PostgREST que a veces rompe
  // por schema cache):
  //   movimiento.lote_id -> lote.compra_id -> factura.compra_creditos_id
  const loteIds = movimientos
    .filter((m) => m.tipo === 'compra' && m.lote_id)
    .map((m) => m.lote_id as string);

  const compraByLote = new Map<string, string>();
  if (loteIds.length > 0) {
    const { data: lotes } = await (supabase
      .from('lotes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .select('id, compra_id')
      .in('id', loteIds);
    for (const l of (lotes || []) as Array<{ id: string; compra_id: string | null }>) {
      if (l.compra_id) compraByLote.set(l.id, l.compra_id);
    }
  }

  const compraIds = Array.from(new Set(compraByLote.values()));
  const facturaByCompra = new Map<string, { id: string; factus_number: string | null; estado: string }>();
  if (compraIds.length > 0) {
    const { data: facturas } = await (supabase
      .from('facturas' as string) as ReturnType<typeof supabase.from>)
      .select('id, compra_creditos_id, factus_number, estado')
      .in('compra_creditos_id', compraIds)
      .eq('estado', 'emitida');
    for (const f of (facturas || []) as Array<{ id: string; compra_creditos_id: string; factus_number: string | null; estado: string }>) {
      facturaByCompra.set(f.compra_creditos_id, {
        id: f.id,
        factus_number: f.factus_number,
        estado: f.estado,
      });
    }
  }

  for (const m of movimientos) {
    if (m.tipo === 'compra' && m.lote_id) {
      const compraId = compraByLote.get(m.lote_id as string);
      if (compraId) {
        m.compra_id = compraId;
        const factura = facturaByCompra.get(compraId);
        m.factura = factura || null;
      }
    }
  }

  return {
    movimientos,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.max(1, Math.ceil((count || 0) / limit)),
    },
  };
}

// ============================================================
// Compras (historial de compras)
// ============================================================

export async function listCompras(perfilId: string) {
  const dueno = await resolveOrgCanonicalPerfilId(perfilId);
  const { data, error } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, paquete_id, cantidad_estudios, precio_cop, vence_en_dias,
      estado, stripe_session_id, payment_link_url, completed_at, created_at
    `)
    .eq('perfil_id', dueno)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw fromSupabaseError(error);
  return data || [];
}

// ============================================================
// Detalle por paquete — Adenda de precios §3.8
//
// «Vista de saldo en la Oficina Virtual. Detalle por paquete: cupos
// comprados, consumidos, disponibles y fecha de vencimiento.» Un paquete es
// un lote de la organización. Van los vigentes con saldo y, para que la
// inmobiliaria vea qué pasó con lo que compró, los agotados y vencidos de los
// últimos DIAS_RECIENTES días.
// ============================================================

export const DIAS_RECIENTES_PAQUETES = 90;

export type EstadoPaquete = 'vigente' | 'agotado' | 'vencido';

export interface DetallePaquete {
  lote_id: string;
  compra_id: string | null;
  origen: string;
  /** Fecha de la compra (aprobación del pago; si no hay compra, la del lote). */
  fecha_compra: string;
  comprados: number;
  /** Cupos consumidos con resultado de la consulta (§2.1). */
  consumidos: number;
  /** Cupos reservados por estudios que todavía no llegan a resultado (§2). */
  reservados: number;
  disponibles: number;
  vence_en: string | null;
  estado: EstadoPaquete;
}

interface LoteDetalle {
  id: string;
  compra_id: string | null;
  cantidad_inicial: number;
  cantidad_disponible: number;
  vence_en: string | null;
  origen: string;
  created_at: string;
  updated_at: string;
}

interface MovimientoDetalle {
  lote_id: string | null;
  tipo: string;
  cantidad: number;
  pago_id: string | null;
}

/**
 * Pura: el orden en que se gastan los lotes (Adenda §3.4 / §9.7), el mismo
 * ORDER BY de la RPC consume_credito_estudio (migración 20261002000101): vence
 * antes primero, sin vencimiento al final; si empatan, la compra más antigua.
 */
export function compararOrdenConsumo(
  a: { id: string; vence_en: string | null; fecha_compra: string },
  b: { id: string; vence_en: string | null; fecha_compra: string },
): number {
  if (a.vence_en !== b.vence_en) {
    if (a.vence_en === null) return 1;
    if (b.vence_en === null) return -1;
    return Date.parse(a.vence_en) - Date.parse(b.vence_en);
  }
  return Date.parse(a.fecha_compra) - Date.parse(b.fecha_compra) || a.id.localeCompare(b.id);
}

/**
 * Pura: arma el detalle. Salidas del lote = reservas y consumos de antes de la
 * Adenda (-1) menos lo que volvió (liberaciones y devoluciones con pago); de
 * esas, las reservas todavía abiertas son «reservados» y el resto,
 * «consumidos». Una liberación que se extinguió (lote vencido) también cuenta
 * como vuelta: ese cupo no se consumió. Un lote vencido no tiene disponibles:
 * sus cupos se extinguieron (§3.1). Los movimientos llegan en orden cronológico.
 */
export function armarDetallePaquetes(
  lotes: readonly LoteDetalle[],
  fechaCompra: ReadonlyMap<string, string>,
  movimientos: readonly MovimientoDetalle[],
  ahora: Date,
): DetallePaquete[] {
  const limite = ahora.getTime() - DIAS_RECIENTES_PAQUETES * 86_400_000;
  const salidas = new Map<string, number>();
  const sumar = (lote: string, n: number) => salidas.set(lote, (salidas.get(lote) ?? 0) + n);
  const ultimo = new Map<string, MovimientoDetalle>();
  const extinguidos = new Set<string>();
  for (const m of movimientos) {
    if (!m.lote_id) continue;
    if ((m.tipo === 'reserva' || m.tipo === 'consumo') && m.cantidad < 0) sumar(m.lote_id, -m.cantidad);
    else if (m.tipo === 'liberacion') sumar(m.lote_id, -1);
    else if (m.tipo === 'ajuste' && m.cantidad > 0 && !!m.pago_id) sumar(m.lote_id, -m.cantidad);
    else if (m.tipo === 'expiracion') extinguidos.add(m.lote_id);
    if (m.pago_id && m.tipo !== 'compra' && m.tipo !== 'expiracion') ultimo.set(m.pago_id, m);
  }
  const reservados = new Map<string, number>();
  for (const m of ultimo.values())
    if (m.tipo === 'reserva' && m.lote_id) reservados.set(m.lote_id, (reservados.get(m.lote_id) ?? 0) + 1);

  const filas: DetallePaquete[] = [];
  for (const l of lotes) {
    const vencido = !!l.vence_en && Date.parse(l.vence_en) <= ahora.getTime();
    // Agotado antes de vencer cuenta como agotado: no se extinguió nada. Con
    // cupos extinguidos (§3.1: el barrido lo dejó en 0) es vencido.
    const estado: EstadoPaquete =
      vencido && (l.cantidad_disponible > 0 || extinguidos.has(l.id)) ? 'vencido' : l.cantidad_disponible === 0 ? 'agotado' : 'vigente';
    if (estado === 'vencido' && Date.parse(l.vence_en!) < limite) continue;
    if (estado === 'agotado' && Date.parse(l.updated_at) < limite) continue;
    filas.push({
      lote_id: l.id,
      compra_id: l.compra_id,
      origen: l.origen,
      fecha_compra: (l.compra_id && fechaCompra.get(l.compra_id)) || l.created_at,
      comprados: l.cantidad_inicial,
      consumidos: Math.max(0, (salidas.get(l.id) ?? 0) - (reservados.get(l.id) ?? 0)),
      reservados: reservados.get(l.id) ?? 0,
      disponibles: estado === 'vencido' ? 0 : l.cantidad_disponible,
      vence_en: l.vence_en,
      estado,
    });
  }
  // Vigentes en el orden en que se gastan; después agotados y vencidos, el más reciente primero.
  const rango = { vigente: 0, agotado: 1, vencido: 1 } as const;
  return filas.sort((a, b) =>
    rango[a.estado] - rango[b.estado] ||
    (a.estado === 'vigente' ? compararOrdenConsumo({ ...a, id: a.lote_id }, { ...b, id: b.lote_id }) : Date.parse(b.fecha_compra) - Date.parse(a.fecha_compra)),
  );
}

export async function listDetallePaquetes(perfilId: string): Promise<DetallePaquete[]> {
  const dueno = await resolveOrgCanonicalPerfilId(perfilId);
  // ponytail: 200 lotes alcanzan para años de compras de una organización; paginar si alguna se acerca.
  const { data, error } = await db('lotes_creditos_estudios')
    .select('id, compra_id, cantidad_inicial, cantidad_disponible, vence_en, origen, created_at, updated_at')
    .eq('perfil_id', dueno)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw fromSupabaseError(error);
  const lotes = (data ?? []) as LoteDetalle[];
  if (lotes.length === 0) return [];

  const compraIds = [...new Set(lotes.map((l) => l.compra_id).filter((id): id is string => !!id))];
  const fechaCompra = new Map<string, string>();
  if (compraIds.length > 0) {
    const { data: compras, error: cErr } = await db('compras_creditos_estudios')
      .select('id, completed_at, created_at')
      .in('id', compraIds);
    if (cErr) throw fromSupabaseError(cErr);
    for (const c of (compras ?? []) as Array<{ id: string; completed_at: string | null; created_at: string }>)
      fechaCompra.set(c.id, c.completed_at ?? c.created_at);
  }

  // PostgREST corta en 1000 filas por respuesta: se pagina.
  const movimientos: MovimientoDetalle[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: movs, error: mErr } = await db('movimientos_creditos_estudios')
      .select('lote_id, tipo, cantidad, pago_id')
      .in('lote_id', lotes.map((l) => l.id))
      .in('tipo', [...TIPOS_CUPO, 'expiracion'])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + 999);
    if (mErr) throw fromSupabaseError(mErr);
    const pagina = (movs ?? []) as MovimientoDetalle[];
    movimientos.push(...pagina);
    if (pagina.length < 1000) break;
  }

  return armarDetallePaquetes(lotes, fechaCompra, movimientos, new Date());
}

// ============================================================
// Comprar paquete (crea Stripe Checkout)
// ============================================================

export async function comprarPaquete(
  perfilId: string,
  paqueteId: string,
  userId: string,
  ip?: string,
): Promise<{ checkout_url: string; compra_id: string }> {
  // 1. Validar paquete activo
  const { data: pkgData, error: pkgErr } = await (supabase
    .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('id', paqueteId)
    .eq('activo', true)
    .single();

  if (pkgErr || !pkgData) {
    throw AppError.notFound('Paquete no encontrado o inactivo');
  }

  const paquete = pkgData as PaqueteRow;
  // La compra (y el lote que acredita el webhook) queda a nombre de la
  // organización; creado_por guarda quién la hizo.
  const dueno = await resolveOrgCanonicalPerfilId(perfilId);

  // 2. Crear registro de compra (estado pendiente)
  const { data: compraData, error: compraErr } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      perfil_id: dueno,
      paquete_id: paquete.id,
      cantidad_estudios: paquete.cantidad_estudios,
      precio_cop: paquete.precio_cop,
      // La vigencia ya no es del paquete (Adenda de precios §9.6): se fija al
      // acreditar con VIGENCIA_PAQUETE_MESES.
      estado: 'pendiente',
      creado_por: userId,
    } as never)
    .select('*')
    .single();

  if (compraErr || !compraData) {
    logger.error({ error: compraErr }, 'Error creando compra de creditos');
    throw fromSupabaseError(compraErr!);
  }

  const compra = compraData as CompraRow;

  // 3. Crear Stripe Checkout
  const successUrl = `${env.FRONTEND_URL}/configuracion/creditos-estudios?compra=${compra.id}&status=success`;
  const cancelUrl = `${env.FRONTEND_URL}/configuracion/creditos-estudios?compra=${compra.id}&status=cancelled`;
  // Un rechazo del banco NO es una cancelacion voluntaria: sin esta URL aparte
  // aterrizaba con status=cancelled y la web decia "Has cancelado el proceso de
  // pago" a quien le rechazaron la tarjeta.
  const failureUrl = `${env.FRONTEND_URL}/configuracion/creditos-estudios?compra=${compra.id}&status=failed`;

  try {
    const gateway = getPaymentGateway();
    const linkResult = await gateway.createPaymentLink({
      amount: paquete.precio_cop,
      concept: paquete.nombre,
      description: paquete.descripcion || `Compra de ${paquete.cantidad_estudios} estudios de arrendamiento`,
      metadata: {
        concepto: 'creditos_estudios',
        compra_id: compra.id,
        perfil_id: dueno,
        paquete_id: paquete.id,
      },
      successUrl,
      cancelUrl,
      failureUrl,
    });

    // 4. Guardar Stripe session ID en la compra
    const { error: updErr } = await (supabase
      .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .update({
        stripe_session_id: linkResult.externalId,
        payment_link_url: linkResult.url,
      } as never)
      .eq('id', compra.id);

    if (updErr) {
      // Sin el session_id el webhook jamás podrá acreditar la compra: si
      // dejáramos pagar, sería dinero por créditos que nunca llegan. Marcar
      // fallida y abortar — el comprador reintenta y se crea una compra nueva.
      logger.error({ updErr, compraId: compra.id }, 'No se pudo guardar el session de pasarela — compra abortada');
      throw fromSupabaseError(updErr);
    }

    logAudit({
      usuarioId: userId,
      accion: AUDIT_ACTIONS.PAGO_CREATED,
      entidad: AUDIT_ENTITIES.PAGO,
      entidadId: compra.id,
      detalle: {
        tipo: 'creditos_estudios',
        paquete_id: paquete.id,
        cantidad: paquete.cantidad_estudios,
        precio_cop: paquete.precio_cop,
      },
      ip,
    });

    return {
      checkout_url: linkResult.url,
      compra_id: compra.id,
    };
  } catch (err) {
    // Si falló Stripe, marcar compra como fallida
    await (supabase
      .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'fallido' } as never)
      .eq('id', compra.id);
    throw err;
  }
}

/**
 * Pura: suma meses de calendario. Si el día no existe en el mes destino, cae
 * en el último día de ese mes (31 de agosto + 6 meses = 28 o 29 de febrero).
 */
export function sumarMesesCalendario(desde: Date, meses: number): Date {
  const d = new Date(desde.getTime());
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + meses);
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d;
}

// ============================================================
// Webhook handler — acreditar lote cuando Stripe confirma pago
// ============================================================

/**
 * Marca una compra como completada (idempotente: solo toca filas no completadas).
 * Si `throwOnError`, propaga el fallo para que el retry del webhook lo repare.
 * Sin payment no se toca el registrado (P22: es el que acreditó la compra).
 */
async function marcarCompraCompletada(
  compraId: string,
  paymentIntentId: string | null,
  rawResponse: Record<string, unknown>,
  throwOnError = false,
): Promise<void> {
  const { error } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'completado',
      ...(paymentIntentId ? { stripe_payment_intent_id: paymentIntentId } : {}),
      gateway_response: rawResponse,
      completed_at: new Date().toISOString(),
    } as never)
    .eq('id', compraId)
    .neq('estado', 'completado');

  if (error) {
    logger.error({ error: error.message, compraId }, 'Error marcando compra de créditos como completada');
    if (throwOnError) throw fromSupabaseError(error);
  }
}

export async function acreditarCompraDesdeWebhook(
  stripeSessionId: string,
  paymentIntentId: string | null,
  rawResponse: Record<string, unknown>,
): Promise<{ ok: boolean; ya_acreditado?: boolean; lote_id?: string; duplicado?: boolean }> {
  // 1. Buscar compra por session ID
  const { data: compraData, error: findErr } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('stripe_session_id', stripeSessionId)
    .single();

  if (findErr || !compraData) {
    logger.warn({ stripeSessionId, error: findErr }, 'Compra de creditos no encontrada para session');
    return { ok: false };
  }

  const compra = compraData as CompraRow;

  // 2. Idempotencia: si ya esta completada, no hacer nada. Si la completó OTRO
  //    payment (terminó entre la lectura del webhook y esta), este es un pago
  //    duplicado: queda para devolver, no se absorbe como «ya acreditado».
  if (compra.estado === 'completado') {
    if (paymentIntentId && compra.stripe_payment_intent_id !== paymentIntentId) {
      logger.warn(
        { compraId: compra.id, paymentIntentId, acredito: compra.stripe_payment_intent_id },
        'Compra de créditos completada por otro payment — pago duplicado',
      );
      return { ok: false, duplicado: true };
    }
    logger.info({ compraId: compra.id }, 'Compra ya estaba completada — idempotent skip');
    return { ok: true, ya_acreditado: true };
  }

  // 2.5. P22: la compra se reclama para ESTE payment antes de crear el lote. Con
  //      dos payments aprobados a la vez (dos pestañas; webhook y conciliación)
  //      el segundo chocaba con el lote y salía como «ya acreditado», sin
  //      quedar para devolver. El reintento del mismo payment pasa; el de otro,
  //      es un pago duplicado.
  if (paymentIntentId) {
    const { data: reclamada } = await db('compras_creditos_estudios')
      .update({ stripe_payment_intent_id: paymentIntentId } as never)
      .eq('id', compra.id)
      .is('stripe_payment_intent_id', null)
      .select('id');
    if (!(reclamada as unknown[] | null)?.length) {
      const { data: fresca, error: frescaErr } = await db('compras_creditos_estudios')
        .select('stripe_payment_intent_id')
        .eq('id', compra.id)
        .maybeSingle();
      if (frescaErr) throw fromSupabaseError(frescaErr);
      const acredito = (fresca as { stripe_payment_intent_id: string | null } | null)?.stripe_payment_intent_id;
      if (acredito !== paymentIntentId) {
        logger.warn({ compraId: compra.id, paymentIntentId, acredito }, 'Compra de créditos reclamada por otro payment — pago duplicado');
        return { ok: false, duplicado: true };
      }
    }
  }

  // 3. Vencimiento del lote — Adenda de precios §3.1 / §9.6: VIGENCIA_PAQUETE_MESES
  //    meses de calendario desde la aprobación del pago (ahora, cuando se acredita).
  const { VIGENCIA_PAQUETE_MESES } = await getCalibracion();
  const venceEn = sumarMesesCalendario(new Date(), VIGENCIA_PAQUETE_MESES).toISOString();

  // 3.5. P22: el saldo en contra (créditos usados de una compra contracargada)
  //      se descuenta de esta compra. El lote nace ya descontado y la deuda se
  //      cubre después: si el lote ya existía (reintento), no se descuenta dos veces.
  const descuento = Math.min(await creditosEnContra(compra.perfil_id), compra.cantidad_estudios);

  // 4. Crear lote
  const { data: loteData, error: loteErr } = await (supabase
    .from('lotes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      perfil_id: compra.perfil_id,
      compra_id: compra.id,
      cantidad_inicial: compra.cantidad_estudios,
      cantidad_disponible: compra.cantidad_estudios - descuento,
      vence_en: venceEn,
      origen: 'compra',
    } as never)
    .select('*')
    .single();

  if (loteErr || !loteData) {
    // 23505 = uq_lotes_creditos_compra: otro retry/concurrente ya creó el lote.
    // Reparar la compra si quedó sin marcar y salir idempotente (sin duplicar créditos).
    if (loteErr?.code === '23505') {
      logger.info({ compraId: compra.id }, 'Lote ya existía (retry concurrente) — idempotent skip');
      // Sin pisar el payment registrado: es el que creó el lote.
      await marcarCompraCompletada(compra.id, null, rawResponse);
      return { ok: true, ya_acreditado: true };
    }
    logger.error({ loteErr, compraId: compra.id }, 'Error creando lote tras pago confirmado');
    throw fromSupabaseError(loteErr!);
  }

  const lote = loteData as LoteRow;

  // 4.5. P22: se cubre la deuda con lo descontado. Si otra compra de la misma
  //      organización cubrió una parte a la vez, lo que sobra vuelve al lote.
  const descontados = descuento > 0 ? await cubrirSaldoEnContra(compra.perfil_id, descuento) : 0;
  if (descontados < descuento && !(await moverDisponible(lote.id, descuento - descontados))) {
    logger.error(
      { compraId: compra.id, loteId: lote.id, faltan: descuento - descontados },
      'CRITICO: se descontaron créditos del saldo en contra que no se cubrieron — devolverlos al lote a mano',
    );
  }

  // 5. Actualizar compra a completado. Si falla, lanzamos para que el retry del
  // webhook lo repare (el lote ya existe: el retry cae en el skip idempotente
  // de arriba, que vuelve a intentar marcar la compra).
  await marcarCompraCompletada(compra.id, paymentIntentId, rawResponse, true);

  // 6. Registrar movimiento
  const saldoTotal = await saldoVigente(compra.perfil_id);

  await (supabase
    .from('movimientos_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      perfil_id: compra.perfil_id,
      lote_id: lote.id,
      tipo: 'compra',
      cantidad: compra.cantidad_estudios,
      saldo_resultante: saldoTotal + descontados,
      notas: `Compra de ${compra.cantidad_estudios} estudios — sesion ${stripeSessionId}`,
    } as never);
  if (descontados > 0) {
    await db('movimientos_creditos_estudios').insert({
      perfil_id: compra.perfil_id,
      lote_id: lote.id,
      tipo: 'ajuste',
      cantidad: -descontados,
      saldo_resultante: saldoTotal,
      notas: `Se descontaron ${descontados} créditos del saldo en contra (compra contracargada)`,
    } as never);
  }

  logger.info(
    { compraId: compra.id, perfilId: compra.perfil_id, cantidad: compra.cantidad_estudios },
    'Compra de creditos acreditada',
  );

  // Factura electrónica del paquete, fire-and-forget como la del pago del
  // estudio (orchestrator.onPagoConfirmado). Antes solo salía si el comprador
  // pulsaba "Facturar": ingreso cobrado sin factura DIAN. Si falla (Factus o
  // datos fiscales incompletos) la compra sigue en Pendientes de facturación.
  import('@/modules/facturacion/facturacion.service')
    .then(({ crearFacturaDesdeCompraCreditos }) =>
      crearFacturaDesdeCompraCreditos(compra.id, null, undefined, null),
    )
    .catch((err) =>
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), compraId: compra.id },
        'Facturación automática de la compra de créditos falló — pendiente de facturar a mano',
      ),
    );

  return { ok: true, lote_id: lote.id };
}

// ============================================================
// Liberar estudio (consumir 1 credito)
//
// Usado por la inmobiliaria para asumir el costo de un estudio
// con sus creditos pre-comprados. Crea un registro de pago
// 'completado' con metodo 'transferencia' para que el flow
// de estudio pueda continuar normal.
// ============================================================

export async function liberarEstudioConCredito(
  expedienteId: string,
  perfilId: string,
  userId: string,
  ip?: string,
  notas?: string,
): Promise<{ pago_id: string; saldo_restante: number; lote_id: string }> {
  // 1. Obtener expediente y verificar inmueble
  const { data: expData, error: expErr } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, inmueble_id, solicitante_id')
    .eq('id', expedienteId)
    .single();

  if (expErr || !expData) throw AppError.notFound('Estudio no encontrado');
  const exp = expData as { id: string; numero: string; estado: string; inmueble_id: string | null; solicitante_id: string | null };
  // P1: un estudio cerrado o rechazado no se cobra (el crédito no se podría usar ni devolver).
  if (exp.estado === 'cerrado' || exp.estado === 'rechazado') {
    throw AppError.conflict(`El estudio está ${exp.estado}: no se cobra la evaluación.`, 'EXPEDIENTE_CERRADO');
  }

  // 2. Validar que el inmueble pertenece al perfil que libera (la inmobiliaria figura como propietario_id)
  if (!exp.inmueble_id) {
    throw AppError.badRequest('Estudio sin inmueble asociado', 'EXPEDIENTE_SIN_INMUEBLE');
  }
  const { data: inmData } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('propietario_id, inmobiliaria_id, direccion, ciudad')
    .eq('id', exp.inmueble_id)
    .single();
  const inm = inmData as { propietario_id: string; inmobiliaria_id: string | null; direccion: string; ciudad: string } | null;
  if (!inm) throw AppError.notFound('Inmueble no encontrado');
  // Org-aware: dueño directo o miembro de la organización dueña (los créditos
  // son de la inmobiliaria; cualquier miembro activo puede liberarlos).
  const esDueno = await perfilEsDuenoDeInmueble({
    userId: perfilId,
    userRol: 'inmobiliaria',
    inmueblePropietarioId: inm.propietario_id,
    inmuebleInmobiliariaId: inm.inmobiliaria_id,
  });
  if (!esDueno) {
    throw AppError.forbidden('Este inmueble no le pertenece', 'INMUEBLE_NO_PROPIO');
  }
  // El crédito sale del saldo de la organización (perfil canónico); el
  // movimiento guarda en usuario_id quién lo liberó.
  const dueno = await resolveOrgCanonicalPerfilId(perfilId);

  // 2.5. TOPE DE CANON — flujo §4.4: "no se cobra el estudio". Descontar un
  //      credito ES el cobro (es un estudio ya pagado que se consume), asi que
  //      el tope se verifica ANTES del INSERT en `pagos` y ANTES del RPC
  //      consume_credito_estudio. Si se bloquea aqui, el saldo de la
  //      inmobiliaria queda intacto.
  await assertCanonDentroDelTope({ expedienteId, origen: 'liberarEstudioConCredito' });

  // P22: el saldo en contra se descuenta de lo disponible; sin saldo efectivo no
  // se paga con créditos hasta que una compra nueva lo cubra (pagar de
  // inmediato y el enlace al prospecto siguen abiertos).
  const enContra = await creditosEnContra(dueno);
  if (enContra > 0 && saldoEfectivo(await saldoVigente(dueno), enContra) < 1) throw errorCreditosEnContra(enContra);

  // 3. Validar que no exista ya un pago de estudio vivo. 'fallido' tambien
  //    cuenta: no es terminal (fallido→completado, Mercado Pago deja reintentar
  //    en el mismo checkout), asi que el prospecto aun podia pagar el enlace
  //    viejo despues de consumido el credito = cobro doble. Se cierra con la
  //    misma funcion que usa la pasarela antes de abrir otro cobro.
  const { data: existingPago, error: existingErr } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, external_id, metodo')
    .eq('expediente_id', expedienteId)
    .eq('concepto', 'estudio')
    .in('estado', ['completado', 'pendiente', 'procesando', 'fallido'])
    .order('created_at', { ascending: false });
  // Fail closed: sin saber si hay un cobro vivo no se consume el credito.
  if (existingErr) throw fromSupabaseError(existingErr);

  const vivos = (existingPago as Array<{ id: string; estado: string }> | null) ?? [];
  if (vivos.some((p) => p.estado === 'completado')) {
    throw AppError.conflict('Ya existe un pago de estudio completado', 'PAGO_ESTUDIO_YA_COMPLETADO');
  }
  if (vivos.some((p) => p.estado !== 'fallido')) {
    throw AppError.conflict('Ya existe un pago de estudio pendiente — cancelelo primero', 'PAGO_ESTUDIO_PENDIENTE');
  }
  if (vivos.length > 0) {
    const { cerrarCobroEstudioFallido } = await import('@/modules/pago-estudio/pago-estudio.service');
    for (const fallido of vivos) await cerrarCobroEstudioFallido(fallido, userId);
  }

  // 4. Obtener monto del estudio
  const { data: cfgData } = await (supabase
    .from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>)
    .select('valor')
    .eq('clave', 'monto_estudio')
    .single();
  const monto = parseInt(((cfgData as { valor: string } | null)?.valor) || '80000', 10);

  const direccion = `${inm.direccion}${inm.ciudad ? `, ${inm.ciudad}` : ''}`;

  // 5. Crear pago en estado completado (asumido con credito)
  const { data: pagoData, error: pagoErr } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      concepto: 'estudio',
      descripcion: `Estudio de arrendamiento - ${direccion} (liberado con credito de inmobiliaria)`,
      monto,
      metodo: 'transferencia',
      estado: 'completado',
      fecha_pago: new Date().toISOString(),
      creado_por: userId,
      notas: notas || 'Liberado con un cupo reservado del paquete',
    } as never)
    .select('id')
    .single();

  if (pagoErr || !pagoData) {
    // 23505 = uq_pagos_estudio_activo: otro click/flujo concurrente ya creó el
    // pago del estudio — sin esto se consumían DOS créditos por un estudio.
    if (pagoErr?.code === '23505') {
      throw AppError.conflict('Ya existe un pago de evaluación activo para este estudio', 'PAGO_ESTUDIO_PENDIENTE');
    }
    logger.error({ pagoErr }, 'Error creando pago al liberar credito');
    throw fromSupabaseError(pagoErr!);
  }
  const pago = pagoData as { id: string };

  // 6. Reservar el cupo via RPC (atomico, vence antes primero, con lock).
  //    Adenda de precios §2: se consume solo con resultado de la consulta.
  const { data: rpcData, error: rpcErr } = await (supabase as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{
      data: Array<{ lote_id: string; saldo_restante: number }> | null;
      error: { code?: string; message?: string } | null;
    }>;
  }).rpc('consume_credito_estudio', {
    p_perfil_id: dueno,
    p_expediente_id: expedienteId,
    p_solicitante_id: exp.solicitante_id,
    p_pago_id: pago.id,
    p_usuario_id: userId,
    p_notas: notas || null,
  });

  if (rpcErr || !rpcData || rpcData.length === 0) {
    // Rollback: borrar el pago creado. Si el delete falla, queda un pago
    // completado SIN crédito consumido — hay que verlo en los logs.
    const { error: rollbackErr } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', pago.id);
    if (rollbackErr) {
      logger.error(
        { error: rollbackErr.message, pagoId: pago.id, expedienteId },
        'CRITICO: no se pudo revertir el pago tras fallar el consumo de crédito — revisar manualmente',
      );
    }

    if (rpcErr?.message?.includes('SIN_SALDO_CREDITOS')) {
      throw AppError.badRequest('No tienes créditos disponibles. Compra un paquete primero.', 'SIN_SALDO_CREDITOS');
    }

    logger.error({ rpcErr }, 'Error consumiendo credito');
    throw new AppError(500, 'CREDITO_CONSUME_ERROR', 'Error consumiendo credito');
  }

  const { lote_id, saldo_restante } = rpcData[0];
  await avisarSiSaldoBajo(dueno, saldo_restante + 1, saldo_restante);

  // 7. Evento + timeline
  await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .insert({
      pago_id: pago.id,
      tipo: 'completed',
      origen: 'manual',
      detalles: {
        metodo: 'credito_inmobiliaria',
        lote_id,
        saldo_restante,
        liberado_por: userId,
      },
    } as never);

  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'pago',
      descripcion: 'Estudio liberado con un cupo reservado del paquete: se consume cuando la consulta a centrales dé resultado',
      usuario_id: userId,
      metadata: {
        pago_id: pago.id,
        concepto: 'estudio',
        metodo: 'credito_inmobiliaria',
        lote_id,
        saldo_restante,
      },
    } as never);

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_MANUAL_REGISTERED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: {
      expediente_id: expedienteId,
      concepto: 'estudio',
      metodo: 'credito_inmobiliaria',
      lote_id,
      saldo_restante,
      monto,
    },
    ip,
  });

  // El pago quedó completado (el crédito consumido SÍ deja fila en `pagos`): el
  // dueño único de ese evento es onEstudioPagado.
  //
  // Antes aquí se llamaba directo a `enviarEnlaceAutorizacion`, "igual que el
  // flujo de pago por Stripe (que lo hace vía onPagoConfirmado)". Con el §6.3
  // esa analogía dejó de ser cierta: al entrar por cancelar-y-liberar-crédito
  // sobre una opción C el prospecto YA firmó, esa función lanza
  // AUTORIZACION_YA_FIRMADA y el .catch la degradaba a un warn — la agencia
  // pagaba y nadie ejecutaba el estudio. La OPCIÓN A no cambia de orden: su
  // pago nace 'completado' antes de pedir la autorización, así que cuando el
  // prospecto firme el gate de pago lo deja pasar sin tocar nada de arriba.
  // Fire-and-forget, como antes.
  import('@/modules/orchestrator/orchestrator.service')
    .then(({ onEstudioPagado }) => onEstudioPagado(expedienteId, userId))
    .catch((err) =>
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), expedienteId },
        'No se pudo continuar el flujo tras liberar con crédito (reenviable manualmente)',
      ),
    );

  return { pago_id: pago.id, saldo_restante, lote_id };
}

// ============================================================
// Devolución y contracargo (P1, P22)
// ============================================================

/**
 * P22: cubre hasta `cantidad` del saldo en contra de la organización, las
 * compras contracargadas más viejas primero (compare-and-set: otra compra puede
 * cubrir la misma deuda a la vez). Devuelve cuánto cubrió. Nunca lanza.
 */
async function cubrirSaldoEnContra(perfilId: string, cantidad: number): Promise<number> {
  let cubiertos = 0;
  try {
    const { data, error } = await db('compras_creditos_estudios')
      .select('id, creditos_en_contra')
      .eq('perfil_id', perfilId)
      .gt('creditos_en_contra', 0)
      .order('created_at', { ascending: true });
    if (error) throw error;
    for (const d of (data ?? []) as Array<{ id: string; creditos_en_contra: number }>) {
      const t = Math.min(d.creditos_en_contra, cantidad - cubiertos);
      if (t <= 0) break;
      const { data: ok, error: updErr } = await db('compras_creditos_estudios')
        .update({ creditos_en_contra: d.creditos_en_contra - t } as never)
        .eq('id', d.id)
        .eq('creditos_en_contra', d.creditos_en_contra)
        .select('id');
      if (updErr) throw updErr;
      if ((ok as unknown[] | null)?.length) cubiertos += t;
    }
  } catch (err) {
    logger.error({ err, perfilId, cubiertos, cantidad }, 'No se pudo cubrir todo el saldo en contra con la compra');
  }
  return cubiertos;
}

export type DevolucionCredito = 'no_es_credito' | 'devuelto' | 'ya_devuelto';

// ============================================================
// Adenda de precios §2: reserva → consumo
//
// Al liberar el estudio con crédito el cupo se RESERVA (sale del lote). Con
// resultado de la consulta (c) la reserva se confirma como consumo; en (a), (b)
// o si el estudio nunca llega a la consulta (§2.5) se libera y vuelve al mismo
// lote. Las tres operaciones son RPC atómicas por pago (migración
// 20261003000001): el último movimiento del pago decide su estado.
// ============================================================

/** Literal por el que una reserva no se consumió (§2.6). */
export type LiteralNoConsumo = 'a' | 'b' | '2.5';
export type DesenlaceConsulta = 'a_no_existe' | 'b_falla' | 'c_resultado';

/**
 * Pura: el desenlace de una consulta que falló (§2.2, decisiones 3 y 4 del
 * PR): sin autorización no se llegó a consultar (null = §2.5); el apellido que
 * no coincide es una respuesta no utilizable (b); el documento inexistente o
 * mal formado (DC 05/09, TU 23/37) es (a); lo demás (caída, error, config) es (b).
 */
export function desenlaceDeFalla(f: {
  bloqueadoPorAutorizacion: boolean;
  apellidoNoCoincide: boolean;
  documentoNoEncontrado: boolean;
}): DesenlaceConsulta | null {
  if (f.bloqueadoPorAutorizacion) return null;
  if (f.apellidoNoCoincide) return 'b_falla';
  return f.documentoNoEncontrado ? 'a_no_existe' : 'b_falla';
}

export type EstadoCupo = 'reservado' | 'consumido' | 'liberado';

interface UltimoMovimiento {
  tipo: string;
  cantidad: number;
  literal: string | null;
  expediente_id: string | null;
}

/**
 * Pura: el estado del cupo de un pago según su último movimiento. Un 'consumo'
 * de antes de la Adenda (cantidad -1, sin literal) cuenta como consumido para
 * mostrarlo; las RPC lo tratan como una reserva que todavía se puede liberar.
 */
export function estadoCupo(ult: Pick<UltimoMovimiento, 'tipo'> | null): EstadoCupo | null {
  if (!ult) return null;
  if (ult.tipo === 'reserva') return 'reservado';
  if (ult.tipo === 'consumo') return 'consumido';
  if (ult.tipo === 'liberacion' || ult.tipo === 'ajuste') return 'liberado';
  return null;
}

const TIPOS_CUPO = ['reserva', 'consumo', 'liberacion', 'ajuste'];

async function ultimoMovimientoCupo(pagoId: string): Promise<UltimoMovimiento | null> {
  const { data, error } = await db('movimientos_creditos_estudios')
    .select('tipo, cantidad, literal, expediente_id')
    .eq('pago_id', pagoId)
    .in('tipo', TIPOS_CUPO)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  return data as UltimoMovimiento | null;
}

/** ¿El pago de la evaluación salió de un crédito prepagado? (su reserva o consumo guarda el pago_id). */
export async function esPagoConCredito(pagoId: string): Promise<boolean> {
  const { data, error } = await db('movimientos_creditos_estudios')
    .select('id')
    .eq('pago_id', pagoId)
    .in('tipo', ['reserva', 'consumo'])
    .limit(1);
  if (error) throw fromSupabaseError(error);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/** ¿La reserva del pago ya se liberó en (a), (b) o §2.5? */
export async function cupoLiberado(pagoId: string): Promise<boolean> {
  return estadoCupo(await ultimoMovimientoCupo(pagoId)) === 'liberado';
}

type RpcResult = { data: unknown; error: { message?: string } | null };
const rpc = (fn: string, args: Record<string, unknown>): Promise<RpcResult> =>
  (supabase as unknown as { rpc: (f: string, a: Record<string, unknown>) => Promise<RpcResult> }).rpc(fn, args);

async function rpcTexto(fn: string, args: Record<string, unknown>): Promise<string> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new AppError(500, 'CUPO_RPC_ERROR', `${fn}: ${error.message ?? 'error desconocido'}`);
  return String(data);
}

/** Libera la reserva del pago (§2.2 a/b, §2.5). Ver liberar_reserva_credito. */
export function liberarReservaCupo(
  pagoId: string,
  literal: LiteralNoConsumo,
  opts: { estudioId?: string | null; usuarioId?: string | null; notas?: string } = {},
): Promise<string> {
  return rpcTexto('liberar_reserva_credito', {
    p_pago_id: pagoId,
    p_literal: literal,
    p_estudio_id: opts.estudioId ?? null,
    p_usuario_id: opts.usuarioId ?? null,
    p_notas: opts.notas ?? null,
  });
}

/** Pago de la evaluación del expediente (completado), o null. */
async function pagoEstudioCompletado(expedienteId: string): Promise<string | null> {
  const { data, error } = await db('pagos')
    .select('id')
    .eq('expediente_id', expedienteId)
    .eq('concepto', 'estudio')
    .eq('estado', 'completado')
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  return (data as { id: string } | null)?.id ?? null;
}

const MENSAJE_LIBERACION: Record<LiteralNoConsumo, string> = {
  a: 'La persona no existe en la central consultada (Adenda de precios §2.2 a): el cupo no se consume.',
  b: 'La central no respondió o su respuesta no fue utilizable (Adenda de precios §2.2 b): el cupo no se consume.',
  '2.5': 'El estudio no llegó a la consulta a centrales (Adenda de precios §2.5): el cupo no se consume.',
};

/**
 * Registra el desenlace de la consulta de un estudio y mueve el cupo del pago
 * del expediente: (c) confirma el consumo con el estudio y la referencia; (a),
 * (b) o §2.5 liberan la reserva, salvo que otro estudio del expediente ya haya
 * dado resultado con ese mismo pago (un cupo ampara el estudio completo). Los
 * pagos de pasarela no tienen cupo: no cambian. Nunca lanza.
 */
export async function registrarDesenlaceConsulta(a: {
  estudioId: string;
  expedienteId: string;
  /** null = no llegó a la consulta (§2.5). */
  desenlace: DesenlaceConsulta | null;
  referencia?: string | null;
  usuarioId?: string | null;
}): Promise<void> {
  try {
    if (a.desenlace) {
      const { error } = await db('estudios').update({ desenlace_consulta: a.desenlace } as never).eq('id', a.estudioId);
      if (error) logger.warn({ estudioId: a.estudioId, error: error.message }, 'No se pudo guardar el desenlace de la consulta');
    }
    const pagoId = await pagoEstudioCompletado(a.expedienteId);
    if (!pagoId) return;

    if (a.desenlace === 'c_resultado') {
      const r = await rpcTexto('confirmar_consumo_credito', {
        p_pago_id: pagoId,
        p_estudio_id: a.estudioId,
        p_referencia: a.referencia ?? null,
        p_usuario_id: a.usuarioId ?? null,
      });
      if (r === 'sin_saldo') {
        logger.error(
          { pagoId, estudioId: a.estudioId },
          'Adenda §2: la consulta dio resultado con la reserva liberada y sin cupo para volver a tomarla: revisar el cobro a mano',
        );
      }
      return;
    }

    const { data: otros, error } = await db('estudios')
      .select('id, estado, referencia_proveedor, desenlace_consulta')
      .eq('expediente_id', a.expedienteId);
    if (error) throw fromSupabaseError(error);
    const conResultado = ((otros ?? []) as Array<{ id: string; estado: string; referencia_proveedor: string | null; desenlace_consulta: string | null }>)
      .some((e) => e.id !== a.estudioId && (e.desenlace_consulta === 'c_resultado' || e.estado === 'completado' || !!e.referencia_proveedor));
    if (conResultado) return;

    const literal: LiteralNoConsumo = a.desenlace === 'a_no_existe' ? 'a' : a.desenlace === 'b_falla' ? 'b' : '2.5';
    const r = await liberarReservaCupo(pagoId, literal, { estudioId: a.estudioId, usuarioId: a.usuarioId, notas: MENSAJE_LIBERACION[literal] });
    if (r === 'liberado' || r === 'extinguido' || r === 'a_deuda') {
      const { error: tlErr } = await db('eventos_timeline').insert({
        expediente_id: a.expedienteId,
        tipo: 'pago',
        descripcion:
          r === 'extinguido'
            ? `${MENSAJE_LIBERACION[literal]} El paquete del que salió ya venció, así que el cupo se extingue.`
            : `${MENSAJE_LIBERACION[literal]} El cupo reservado volvió al saldo de la inmobiliaria.`,
        metadata: { pago_id: pagoId, estudio_id: a.estudioId, evento: 'cupo_liberado', literal, resultado: r, origen: 'system' },
      } as never);
      if (tlErr) logger.warn({ pagoId, error: tlErr.message }, 'No se pudo dejar la liberación del cupo en el timeline');
    }
  } catch (err) {
    logger.error({ err, estudioId: a.estudioId, expedienteId: a.expedienteId }, 'Adenda §2: no se pudo mover el cupo del estudio');
  }
}

/**
 * Antes de volver a consultar (reintento de un 'fallido', re-consulta): si la
 * reserva del pago se liberó, se vuelve a tomar un cupo. Falla y reintento con
 * resultado = un solo cupo. Sin saldo, no se consulta.
 */
export async function asegurarReservaParaConsulta(expedienteId: string, usuarioId: string | null): Promise<void> {
  const pagoId = await pagoEstudioCompletado(expedienteId);
  if (!pagoId) return;
  const r = await rpcTexto('reactivar_reserva_credito', { p_pago_id: pagoId, p_usuario_id: usuarioId });
  if (r === 'reservado') {
    // La reserva nueva guarda el saldo que dejó (§3.7).
    const { data } = await db('movimientos_creditos_estudios')
      .select('perfil_id, saldo_resultante')
      .eq('pago_id', pagoId)
      .eq('tipo', 'reserva')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const res = data as { perfil_id: string; saldo_resultante: number } | null;
    if (res) await avisarSiSaldoBajo(res.perfil_id, res.saldo_resultante + 1, res.saldo_resultante);
  }
  if (r === 'sin_saldo') {
    throw AppError.conflict(
      'El cupo de este estudio volvió al saldo de su organización porque la consulta anterior no produjo resultado, y ya no quedan cupos disponibles. Compre un paquete para volver a consultar.',
      'SIN_SALDO_CREDITOS',
    );
  }
}

/**
 * P1 / §2.5: el estudio se cerró o se rechazó sin consulta al buró. Se libera
 * la reserva (literal 2.5) al mismo lote —si el lote venció, el cupo se
 * extingue; si su compra se contracargó, baja la deuda— y el pago pasa a
 * 'reembolsado' con compare-and-set: solo una llamada devuelve. §2.4: un pago
 * cuyo cupo se consumió con resultado (c) no se devuelve por ningún motivo.
 */
export async function devolverCreditoDePago(
  pagoId: string,
  motivo: string,
  usuarioId: string | null,
): Promise<DevolucionCredito> {
  const ult = await ultimoMovimientoCupo(pagoId);
  if (!ult) return 'no_es_credito';
  let consumido = ult.tipo === 'consumo' && ult.literal === 'c';
  if (!consumido && ult.expediente_id) {
    const { data, error } = await db('estudios')
      .select('id')
      .eq('expediente_id', ult.expediente_id)
      .eq('desenlace_consulta', 'c_resultado')
      .limit(1);
    if (error && !faltaColumna(error)) throw fromSupabaseError(error);
    consumido = ((data as unknown[] | null) ?? []).length > 0;
  }
  if (consumido) {
    throw AppError.conflict(
      'El cupo se consumió con el resultado de la consulta a centrales: no se devuelve (Adenda de precios §2.4).',
      'CUPO_CONSUMIDO',
    );
  }

  const r = await liberarReservaCupo(pagoId, '2.5', { usuarioId, notas: `Devolución: ${motivo}.` });
  if (r === 'consumido') {
    throw AppError.conflict('El cupo se consumió con el resultado de la consulta a centrales: no se devuelve (Adenda de precios §2.4).', 'CUPO_CONSUMIDO');
  }

  // Import dinámico: la máquina de estados arrastra las notificaciones.
  const { transitionPagoStateChecked } = await import('@/modules/pagos/pago-state-machine');
  const { transitioned } = await transitionPagoStateChecked({
    pagoId,
    targetEstado: 'reembolsado',
    origen: 'system',
    detalles: { motivo, devolucion: 'credito', cupo: r },
    userId: usuarioId,
  });
  return transitioned ? 'devuelto' : 'ya_devuelto';
}

export interface CompraRevertida {
  compra_id: string;
  perfil_id: string;
  /** Créditos sin usar que se retiraron. */
  retirados: number;
  /** Créditos ya usados: quedan como saldo en contra. */
  en_contra: number;
  /** null si quedaron registrados como saldo en contra; si no, por qué no (hay que descontarlos a mano). */
  en_contra_error: string | null;
  /** Números de los estudios donde se usaron: el registro para disputar el contracargo. */
  consumos: string[];
}

/**
 * P22 (Adenda 2 §7: Cofianza no le da crédito a las inmobiliarias): si Mercado
 * Pago reembolsa o contracarga una compra de créditos, se retiran los que no se
 * usaron y los usados quedan como saldo en contra, que bloquea solo pagar con
 * créditos y se descuenta de la próxima compra. La cuenta no se bloquea. Solo
 * la primera llamada revierte (compare-and-set sobre el estado de la compra).
 */
export async function revertirCompraCreditos(compraId: string): Promise<CompraRevertida | null> {
  const { data, error } = await db('compras_creditos_estudios')
    .select('id, perfil_id, estado')
    .eq('id', compraId)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  const compra = data as { id: string; perfil_id: string; estado: string } | null;
  if (!compra || (compra.estado !== 'completado' && compra.estado !== 'pendiente')) return null;
  // El lote se lee ANTES de cancelar: si la lectura falla, la compra no cambia y
  // el reintento del webhook vuelve a empezar.
  const { data: loteRow, error: loteErr } = await db('lotes_creditos_estudios')
    .select('id, cantidad_inicial, cantidad_disponible')
    .eq('compra_id', compraId)
    .maybeSingle();
  if (loteErr) throw fromSupabaseError(loteErr);
  const lote = loteRow as { id: string; cantidad_inicial: number; cantidad_disponible: number } | null;
  // §3.1: los cupos que se extinguieron por vencimiento (barrido o reserva que
  // volvió a un lote vencido) no se usaron: no son saldo en contra. También se
  // lee antes de cancelar.
  let extinguidos = 0;
  if (lote) {
    const { data: expiraciones, error: eErr } = await db('movimientos_creditos_estudios')
      .select('cantidad')
      .eq('lote_id', lote.id)
      .eq('tipo', 'expiracion');
    if (eErr) throw fromSupabaseError(eErr);
    extinguidos = ((expiraciones ?? []) as Array<{ cantidad: number }>).reduce((acc, m) => acc - m.cantidad, 0);
  }
  const { data: cancelada, error: cErr } = await db('compras_creditos_estudios')
    .update({ estado: 'cancelado' } as never)
    .eq('id', compraId)
    .eq('estado', compra.estado)
    .select('id');
  if (cErr) throw fromSupabaseError(cErr);
  if (!(cancelada as unknown[] | null)?.length) return null;
  // ponytail: sin transacción. Si la API se reinicia entre cancelar la compra y
  // retirar el lote (o dejar el saldo en contra), el reintento ve la compra ya
  // cancelada y no hace nada: los créditos quedan sin retirar y se ajustan a
  // mano. Pasarlo a una RPC transaccional si ocurre.

  const resultado: CompraRevertida = {
    compra_id: compraId,
    perfil_id: compra.perfil_id,
    retirados: 0,
    en_contra: 0,
    en_contra_error: null,
    consumos: [],
  };
  if (!lote) return resultado; // no se alcanzó a acreditar: no hay nada que retirar

  // Lo no usado se retira (compare-and-set: un consumo puede cruzarse).
  let retirados = lote.cantidad_disponible;
  for (let intento = 0; ; intento++) {
    const { data: ok } = await db('lotes_creditos_estudios')
      .update({ cantidad_disponible: 0 } as never)
      .eq('id', lote.id)
      .eq('cantidad_disponible', retirados)
      .select('id');
    if ((ok as unknown[] | null)?.length) break;
    if (intento >= 4) throw new AppError(409, 'LOTE_CAMBIANDO', 'No se pudieron retirar los créditos: el lote cambió mientras tanto.');
    const { data: fresco } = await db('lotes_creditos_estudios').select('cantidad_disponible').eq('id', lote.id).maybeSingle();
    retirados = (fresco as { cantidad_disponible: number } | null)?.cantidad_disponible ?? 0;
  }
  resultado.retirados = retirados;
  resultado.en_contra = Math.max(0, lote.cantidad_inicial - retirados - extinguidos);

  if (resultado.en_contra > 0) {
    const { error: dErr } = await db('compras_creditos_estudios')
      .update({ creditos_en_contra: resultado.en_contra } as never)
      .eq('id', compraId);
    if (dErr) {
      logger.error({ compraId, error: dErr.message }, 'Contracargo: los créditos usados no quedaron como saldo en contra');
      resultado.en_contra_error = faltaColumna(dErr) ? 'falta la migración 20261001000005' : dErr.message;
    }
  }
  if (retirados > 0) {
    await db('movimientos_creditos_estudios').insert({
      perfil_id: compra.perfil_id,
      lote_id: lote.id,
      tipo: 'ajuste',
      cantidad: -retirados,
      saldo_resultante: await saldoVigente(compra.perfil_id),
      notas: `Compra contracargada o reembolsada: se retiraron ${retirados} créditos sin usar`,
    } as never);
  }

  const { data: movs } = await db('movimientos_creditos_estudios')
    .select('expediente_id')
    .eq('lote_id', lote.id)
    .in('tipo', ['reserva', 'consumo']);
  const ids = [...new Set(((movs ?? []) as Array<{ expediente_id: string | null }>).map((m) => m.expediente_id))].filter(
    (id): id is string => !!id,
  );
  if (ids.length > 0) {
    const { data: exps } = await db('expedientes').select('numero').in('id', ids.slice(0, 100));
    resultado.consumos = ((exps ?? []) as Array<{ numero: string }>).map((e) => e.numero);
  }
  return resultado;
}

// ============================================================
// Super admin — CRUD paquetes
// ============================================================

export async function listAllPaquetes(): Promise<PaqueteRow[]> {
  const { data, error } = await (supabase
    .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .order('orden', { ascending: true });

  if (error) throw fromSupabaseError(error);
  return (data || []) as PaqueteRow[];
}

/** Quien cambia el catálogo: el API lo exige aquí, no solo en la ruta. */
export interface UsuarioCatalogo {
  id: string;
  email: string;
  rol: string;
}

/**
 * Adenda de precios §9.14: los precios (y cantidades) del catálogo solo los
 * cambia la Gerencia General, como los parámetros de riesgo de calibración.
 */
function assertGerenciaCatalogo(usuario: UsuarioCatalogo): void {
  if (!esGerenciaGeneral(usuario))
    throw AppError.forbidden(
      'Los paquetes de estudios (precio y cantidad) solo los cambia la Gerencia General.',
      'SOLO_GERENCIA_GENERAL',
    );
}

async function leerPaquete(paqueteId: string): Promise<PaqueteRow> {
  const { data, error } = await db('paquetes_creditos_estudios').select('*').eq('id', paqueteId).maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.notFound('Paquete no encontrado');
  return data as PaqueteRow;
}

export async function createPaquete(input: Record<string, unknown>, usuario: UsuarioCatalogo): Promise<PaqueteRow> {
  assertGerenciaCatalogo(usuario);
  const { data, error } = await (supabase
    .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .insert(input as never)
    .select('*')
    .single();

  if (error) throw fromSupabaseError(error);

  logAudit({
    usuarioId: usuario.id,
    accion: AUDIT_ACTIONS.CONFIG_CHANGED,
    entidad: AUDIT_ENTITIES.CONFIG,
    entidadId: (data as PaqueteRow).id,
    detalle: { tipo: 'paquete_creditos_creado', ...input },
  });

  return data as PaqueteRow;
}

export async function updatePaquete(
  paqueteId: string,
  input: Record<string, unknown>,
  usuario: UsuarioCatalogo,
): Promise<PaqueteRow> {
  assertGerenciaCatalogo(usuario);
  const anterior = await leerPaquete(paqueteId);
  const { data, error } = await (supabase
    .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .update(input as never)
    .eq('id', paqueteId)
    .select('*')
    .single();

  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.notFound('Paquete no encontrado');

  logAudit({
    usuarioId: usuario.id,
    accion: AUDIT_ACTIONS.CONFIG_CHANGED,
    entidad: AUDIT_ENTITIES.CONFIG,
    entidadId: paqueteId,
    // §9.14: el valor anterior queda en la traza, al lado del nuevo.
    detalle: {
      tipo: 'paquete_creditos_actualizado',
      ...input,
      anterior: Object.fromEntries(Object.keys(input).map((k) => [k, (anterior as unknown as Record<string, unknown>)[k] ?? null])),
    },
  });

  return data as PaqueteRow;
}

export async function deletePaquete(paqueteId: string, usuario: UsuarioCatalogo): Promise<void> {
  assertGerenciaCatalogo(usuario);
  const anterior = await leerPaquete(paqueteId);
  // Soft delete: marcar inactivo (no borrar — hay FKs en compras)
  const { error } = await (supabase
    .from('paquetes_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .update({ activo: false } as never)
    .eq('id', paqueteId);

  if (error) throw fromSupabaseError(error);

  logAudit({
    usuarioId: usuario.id,
    accion: AUDIT_ACTIONS.CONFIG_CHANGED,
    entidad: AUDIT_ENTITIES.CONFIG,
    entidadId: paqueteId,
    detalle: {
      tipo: 'paquete_creditos_desactivado',
      anterior: {
        nombre: anterior.nombre,
        cantidad_estudios: anterior.cantidad_estudios,
        precio_cop: anterior.precio_cop,
        activo: anterior.activo,
      },
    },
  });
}

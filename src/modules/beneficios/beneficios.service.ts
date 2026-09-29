/**
 * Adenda de precios v1.0 §4 — beneficio del 50 % en modalidad Tradicional.
 *
 * - §4.1/§9.9: la base es lo EFECTIVAMENTE PAGADO por el estudio, sin IVA.
 *   Con crédito, el precio unitario de la compra del lote consumido (nunca
 *   pagos.monto, que guarda el precio de lista); directo, la base del pago.
 * - §4.2: se causa cuando el contrato V3 queda vigente (firmaron todas las
 *   partes), solo en Tradicional y con inmobiliaria. Un estudio, un beneficio.
 * - §4.3: solo se acumula (liquidado_en NULL); lo leen administrador y
 *   gerencia_consulta. La inmobiliaria no lo ve mientras no haya forma de pago.
 * - §4.4: alerta de mezcla a la Gerencia General, solo al cruzar el umbral.
 */

import { getCalibracion } from '@/lib/calibracion';
import { fromSupabaseError } from '@/lib/errors';
import { esGerenciaGeneral } from '@/lib/gerenciaGeneral';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { notificarYCorreo } from '@/modules/notificaciones/notificaciones.service';
import { getUserById, listOperators } from '@/modules/users/users.service';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;

export const TIPO_TRADICIONAL = 'tradicional_50';
/** §4.4: contratos mínimos en la ventana para que el % signifique algo. */
export const MIN_CONTRATOS_MEZCLA = 5;
export const VENTANA_MEZCLA_MESES = 6;

export interface OrigenPagoEstudio {
  /** El pago 'estudio' completado del expediente (a lo sumo uno: uq_pagos_estudio_activo). */
  pago: { id: string; monto: number | string; base_cop: number | string | null } | null;
  /** Consumo de crédito que pagó ese pago, con su lote y la compra del lote. */
  consumo: { lote_id: string | null; compra: { id: string; precio_cop: number; cantidad_estudios: number } | null } | null;
}

export interface BaseBeneficio {
  base: number;
  pago_id: string | null;
  lote_id: string | null;
  compra_id: string | null;
}

/**
 * §4.1/§9.9, pura. Sin pago propio (estudio reutilizado por portabilidad) o
 * con un lote sin compra (ajuste administrativo): base 0 = no se causa.
 * compras.precio_cop es la base sin IVA del paquete (el IVA va en iva_cop);
 * pagos.base_cop es la instantánea sin IVA; sin ella el cobro es anterior a la
 * adenda y fue exento: monto es la base.
 */
export function baseBeneficioEstudio(o: OrigenPagoEstudio): BaseBeneficio {
  const pago_id = o.pago?.id ?? null;
  if (!o.pago) return { base: 0, pago_id, lote_id: null, compra_id: null };
  if (o.consumo) {
    const c = o.consumo.compra;
    const base = c && c.cantidad_estudios > 0 ? Math.round((c.precio_cop / c.cantidad_estudios) * 100) / 100 : 0;
    return { base, pago_id, lote_id: o.consumo.lote_id, compra_id: c?.id ?? null };
  }
  const base = Number(o.pago.base_cop ?? o.pago.monto) || 0;
  return { base: Math.max(base, 0), pago_id, lote_id: null, compra_id: null };
}

/** Lee el origen del pago del estudio del titular. Lecturas estrictas: sin datos no se causa. */
export async function cargarOrigenPago(expedienteId: string): Promise<OrigenPagoEstudio> {
  const { data: pagos, error } = await db('pagos')
    .select('id, monto, base_cop')
    .eq('expediente_id', expedienteId)
    .eq('concepto', 'estudio')
    .eq('estado', 'completado')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw fromSupabaseError(error);
  const pago = ((pagos as OrigenPagoEstudio['pago'][] | null) ?? [])[0] ?? null;
  if (!pago) return { pago: null, consumo: null };

  const { data: movs, error: mErr } = await db('movimientos_creditos_estudios')
    .select('lote_id')
    .eq('pago_id', pago.id)
    .eq('tipo', 'consumo')
    .limit(1);
  if (mErr) throw fromSupabaseError(mErr);
  const mov = ((movs as Array<{ lote_id: string | null }> | null) ?? [])[0];
  if (!mov) return { pago, consumo: null };
  if (!mov.lote_id) return { pago, consumo: { lote_id: null, compra: null } };

  const { data: lote, error: lErr } = await db('lotes_creditos_estudios').select('compra_id').eq('id', mov.lote_id).maybeSingle();
  if (lErr) throw fromSupabaseError(lErr);
  const compraId = (lote as { compra_id: string | null } | null)?.compra_id ?? null;
  if (!compraId) return { pago, consumo: { lote_id: mov.lote_id, compra: null } };

  const { data: compra, error: cErr } = await db('compras_creditos_estudios')
    .select('id, precio_cop, cantidad_estudios')
    .eq('id', compraId)
    .maybeSingle();
  if (cErr) throw fromSupabaseError(cErr);
  return {
    pago,
    consumo: { lote_id: mov.lote_id, compra: (compra as { id: string; precio_cop: number; cantidad_estudios: number } | null) ?? null },
  };
}

/**
 * §4.2: causa el beneficio al quedar vigente el contrato. Idempotente por
 * UNIQUE(expediente_id, tipo). true = lo causó esta llamada.
 */
export async function causarBeneficioTradicional(c: {
  contratoId: string;
  expedienteId: string;
  orgId: string | null;
  modalidad: string | undefined;
}): Promise<boolean> {
  if (c.modalidad !== 'tradicional' || !c.orgId) return false;
  const b = baseBeneficioEstudio(await cargarOrigenPago(c.expedienteId));
  if (b.base <= 0) {
    logger.info({ ...c, ...b }, 'Beneficio Tradicional: sin valor pagado propio, no se causa');
    return false;
  }
  const pct = (await getCalibracion()).PORCENTAJE_BENEFICIO_TRADICIONAL;
  const { data, error } = await db('beneficios_intermediacion')
    .upsert(
      {
        inmobiliaria_id: c.orgId,
        expediente_id: c.expedienteId,
        contrato_id: c.contratoId,
        tipo: TIPO_TRADICIONAL,
        base_cop: b.base,
        pct,
        valor_cop: Math.round(b.base * pct) / 100,
        lote_id: b.lote_id,
        compra_id: b.compra_id,
        pago_id: b.pago_id,
      } as never,
      { onConflict: 'expediente_id,tipo', ignoreDuplicates: true },
    )
    .select('id');
  if (error) throw fromSupabaseError(error);
  return !!(data as unknown[] | null)?.length;
}

// ── §4.4 Alerta de mezcla ──

export type AccionMezcla = 'alertar' | 'rearmar' | 'nada';

/** Pura: avisa solo al cruzar (de no alertada a por encima) y se rearma al bajar. */
export function decidirAlertaMezcla(i: {
  tienePaquete25: boolean;
  tradicionales: number;
  total: number;
  umbralPct: number;
  yaAlertada: boolean;
}): AccionMezcla {
  const supera =
    i.tienePaquete25 && i.total >= MIN_CONTRATOS_MEZCLA && (i.tradicionales / i.total) * 100 > i.umbralPct;
  if (supera && !i.yaAlertada) return 'alertar';
  if (!supera && i.yaAlertada) return 'rearmar';
  return 'nada';
}

async function tienePaquete25Vigente(perfilCanonico: string): Promise<boolean> {
  const { data: lotes, error } = await db('lotes_creditos_estudios')
    .select('compra_id')
    .eq('perfil_id', perfilCanonico)
    .not('compra_id', 'is', null)
    .or(`vence_en.is.null,vence_en.gt.${new Date().toISOString()}`);
  if (error) throw fromSupabaseError(error);
  const ids = ((lotes as Array<{ compra_id: string }> | null) ?? []).map((l) => l.compra_id);
  if (!ids.length) return false;
  const { data: compras, error: cErr } = await db('compras_creditos_estudios')
    .select('id')
    .in('id', ids)
    .eq('cantidad_estudios', 25)
    .eq('estado', 'completado')
    .limit(1);
  if (cErr) throw fromSupabaseError(cErr);
  return ((compras as unknown[] | null) ?? []).length > 0;
}

/** La Gerencia General: administradores activos con el correo en GERENCIA_GENERAL_EMAILS. */
async function gerenciaGeneralIds(): Promise<string[]> {
  const admins = (await listOperators()).filter((o) => o.rol === 'administrador');
  const ids: string[] = [];
  for (const a of admins) {
    const u = (await getUserById(a.id).catch(() => null)) as { email?: string | null } | null;
    if (u?.email && esGerenciaGeneral({ rol: a.rol, email: u.email })) ids.push(a.id);
  }
  return ids;
}

/** §4.4, tras cada activación de un contrato V3 de la org. No bloquea nada. */
export async function evaluarAlertaMezcla(orgId: string): Promise<AccionMezcla> {
  const { data: orgRow, error } = await db('inmobiliarias')
    .select('nombre, owner_perfil_id, alerta_mezcla_tradicional_en')
    .eq('id', orgId)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  const org = orgRow as { nombre: string; owner_perfil_id: string | null; alerta_mezcla_tradicional_en: string | null } | null;
  if (!org) return 'nada';

  const desde = new Date();
  desde.setMonth(desde.getMonth() - VENTANA_MEZCLA_MESES);
  const [paquete, contratosR, cal] = await Promise.all([
    org.owner_perfil_id ? tienePaquete25Vigente(org.owner_perfil_id) : Promise.resolve(false),
    // V3 (destinacion) activados (fecha_firma) en la ventana, de esta org.
    db('contratos')
      .select('modalidad:datos_variables->documento->entrada->>modalidad, expedientes!inner(inmobiliaria_id)')
      .eq('expedientes.inmobiliaria_id', orgId)
      .not('destinacion', 'is', null)
      .gte('fecha_firma', desde.toISOString()),
    getCalibracion(),
  ]);
  if (contratosR.error) throw fromSupabaseError(contratosR.error);
  const contratos = (contratosR.data as Array<{ modalidad: string | null }> | null) ?? [];
  const tradicionales = contratos.filter((c) => c.modalidad === 'tradicional').length;
  const umbralPct = cal.ALERTA_MEZCLA_TRADICIONAL_PAQUETE_25;

  const accion = decidirAlertaMezcla({
    tienePaquete25: paquete,
    tradicionales,
    total: contratos.length,
    umbralPct,
    yaAlertada: !!org.alerta_mezcla_tradicional_en,
  });
  if (accion === 'rearmar') {
    await db('inmobiliarias').update({ alerta_mezcla_tradicional_en: null } as never).eq('id', orgId);
    return accion;
  }
  if (accion !== 'alertar') return accion;

  // CAS: dos activaciones simultáneas no avisan dos veces.
  const { data: marcada, error: uErr } = await db('inmobiliarias')
    .update({ alerta_mezcla_tradicional_en: new Date().toISOString() } as never)
    .eq('id', orgId)
    .is('alerta_mezcla_tradicional_en', null)
    .select('id');
  if (uErr) throw fromSupabaseError(uErr);
  if (!(marcada as unknown[] | null)?.length) return 'nada';

  const pct = Math.round((tradicionales / contratos.length) * 100);
  const aviso = {
    tipo: 'inmobiliaria.mezcla_tradicional',
    titulo: `Revisión de modalidades — ${org.nombre}`,
    mensaje:
      `La inmobiliaria ${org.nombre}, con paquete de 25 estudios vigente, tiene ${tradicionales} de ${contratos.length} ` +
      `contratos en modalidad Tradicional (${pct} %) en los últimos ${VENTANA_MEZCLA_MESES} meses, por encima del ${umbralPct} % ` +
      'definido en la Adenda de precios §4.4. Es una señal de revisión: no se bloqueó nada.',
    link: '/admin/inmobiliarias',
    payload: { inmobiliaria_id: orgId, tradicionales, total: contratos.length, umbral_pct: umbralPct },
  };
  for (const userId of await gerenciaGeneralIds()) await notificarYCorreo({ userId, ...aviso });
  return accion;
}

// ── §4.3 Consulta (solo lectura) ──

export interface BeneficioFila {
  id: string;
  inmobiliaria_id: string;
  inmobiliaria_nombre: string | null;
  expediente_id: string;
  expediente_numero: string | null;
  contrato_id: string;
  contrato_numero: string | null;
  tipo: string;
  base_cop: number;
  pct: number;
  valor_cop: number;
  origen: 'credito' | 'directo';
  /** Decisión (6): la compra del lote se contracargó; el beneficio se mantiene. */
  compra_contracargada: boolean;
  causado_en: string;
  liquidado_en: string | null;
}

export interface TotalBeneficios {
  inmobiliaria_id: string;
  inmobiliaria_nombre: string | null;
  cantidad: number;
  total_cop: number;
}

// ponytail: sin paginar; el volumen es un beneficio por contrato Tradicional. Paginar si pasa de miles.
export async function listarBeneficios(inmobiliariaId?: string): Promise<{ totales: TotalBeneficios[]; detalle: BeneficioFila[] }> {
  let q = db('beneficios_intermediacion')
    .select(
      'id, inmobiliaria_id, expediente_id, contrato_id, tipo, base_cop, pct, valor_cop, lote_id, causado_en, liquidado_en, ' +
        'inmobiliarias(nombre), expedientes(numero), contratos(numero), compras_creditos_estudios(estado)',
    )
    .order('causado_en', { ascending: false });
  if (inmobiliariaId) q = q.eq('inmobiliaria_id', inmobiliariaId);
  const { data, error } = await q;
  if (error) throw fromSupabaseError(error);

  type Row = Omit<BeneficioFila, 'inmobiliaria_nombre' | 'expediente_numero' | 'contrato_numero' | 'origen' | 'compra_contracargada'> & {
    lote_id: string | null;
    inmobiliarias: { nombre: string } | null;
    expedientes: { numero: string } | null;
    contratos: { numero: string } | null;
    compras_creditos_estudios: { estado: string } | null;
  };
  const detalle: BeneficioFila[] = ((data as unknown as Row[] | null) ?? []).map((r) => ({
    id: r.id,
    inmobiliaria_id: r.inmobiliaria_id,
    inmobiliaria_nombre: r.inmobiliarias?.nombre ?? null,
    expediente_id: r.expediente_id,
    expediente_numero: r.expedientes?.numero ?? null,
    contrato_id: r.contrato_id,
    contrato_numero: r.contratos?.numero ?? null,
    tipo: r.tipo,
    base_cop: Number(r.base_cop),
    pct: Number(r.pct),
    valor_cop: Number(r.valor_cop),
    origen: r.lote_id ? 'credito' : 'directo',
    compra_contracargada: r.compras_creditos_estudios?.estado === 'cancelado',
    causado_en: r.causado_en,
    liquidado_en: r.liquidado_en,
  }));

  const porOrg = new Map<string, TotalBeneficios>();
  for (const b of detalle) {
    if (b.liquidado_en) continue;
    const t = porOrg.get(b.inmobiliaria_id) ?? {
      inmobiliaria_id: b.inmobiliaria_id,
      inmobiliaria_nombre: b.inmobiliaria_nombre,
      cantidad: 0,
      total_cop: 0,
    };
    t.cantidad += 1;
    t.total_cop = Math.round((t.total_cop + b.valor_cop) * 100) / 100;
    porOrg.set(b.inmobiliaria_id, t);
  }
  return { totales: [...porOrg.values()].sort((a, b) => b.total_cop - a.total_cop), detalle };
}

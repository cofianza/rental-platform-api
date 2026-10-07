/**
 * Cobro de la tarifa mensual: lo que se opera sobre las cuentas ya liquidadas
 * (plan cobro-tarifa-mensual, B5, B6 y B9).
 *
 * B5: pagos por línea y por cuenta (actualización condicionada, patrón de
 * marcarRemitida), «no recaudada» en Trasladada (D11), anulación por línea
 * (solo Gerencia General) con aviso de nota crédito y anulación automática de
 * las líneas posteriores a la terminación efectiva o a la exclusión.
 * B6: recordatorios de atraso a los titulares; solo alertas (D10).
 * B9: canon reajustado (lo confirma la inmobiliaria) y otrosí de % (solo
 * Gerencia) en contrato_condiciones_cobro, y el aviso de aniversario.
 *
 * Alcance: Cofianza (administrador u operador) ve todo; de una inmobiliaria,
 * solo sus titulares (owner) y solo lo de su organización.
 */

import { AUDIT_ACTIONS, AUDIT_ENTITIES, logAudit } from '@/lib/auditLog';
import { getCalibracion, mesCobroDesde } from '@/lib/calibracion';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { esGerenciaGeneral } from '@/lib/gerenciaGeneral';
import { logger } from '@/lib/logger';
import { formatearPesos } from '@/lib/numerosEnLetras';
import { supabase } from '@/lib/supabase';
import { assertExpedienteAccess, getActiveMembership } from '@/lib/tenantScope';
import { fechaBogota } from '@/modules/contratos/v3/formato';
import { siguienteMomentoPermitido } from '@/modules/moras/horario-cobranza';
import { notificarYCorreo } from '@/modules/notificaciones/notificaciones.service';
import { avisarAdministradores } from '@/modules/pagos/pagos.service';
import {
  DIAS_RECORDATORIO,
  canonPropuesto,
  entraAlCobro,
  esMigrado,
  filaDeContrato,
  mesCortado,
  mesDe,
  periodoDesde,
  proximoAniversario,
  recordatorioQueToca,
  situacionDe,
  terminacionDe,
  type CondicionCobro,
  type ContratoCobro,
} from './tarifa-cobro.reglas';
import { avisarGerencia, avisarTitulares, leerContratos } from './tarifa-cobro.service';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
const CUENTAS = 'cuentas_cobro_tarifa';
const LINEAS = 'cuentas_cobro_tarifa_lineas';
const INTERNOS = ['administrador', 'operador_analista'];

export interface Usuario {
  id: string;
  rol: string;
  email: string;
}

const mesTexto = (periodo: string) => periodo.slice(0, 7);
const pesos = (n: number) => `$${formatearPesos(Math.round(n))}`;
/** Lo que la inmobiliaria debe hoy de la cuenta: las líneas pendientes (no_recaudada no se le cobra todavía). */
const saldoDe = (lineas: Array<{ estado: string; total_cop: number | string }>) =>
  Math.round(lineas.filter((l) => l.estado === 'pendiente').reduce((s, l) => s + Number(l.total_cop), 0));

/** null = Cofianza (ve todo); si no, la organización de la que el usuario es titular. */
async function orgVisible(u: Usuario): Promise<string | null> {
  if (INTERNOS.includes(u.rol)) return null;
  const m = u.rol === 'inmobiliaria' ? await getActiveMembership(u.id) : null;
  if (!m || m.rolMiembro !== 'owner')
    throw AppError.forbidden('Solo los titulares de la inmobiliaria pueden ver las cuentas de cobro de Cofianza.', 'SOLO_TITULARES');
  return m.orgId;
}

// ── Consulta ──

const COLS_LISTA =
  'id, inmobiliaria_id, periodo, vence_en, estado, base_cop, iva_cop, cash_rounding_cop, total_cop, factura_id, emitida_en, recordatorio_n, ' +
  'inmobiliarias(nombre), lineas:cuentas_cobro_tarifa_lineas(estado, total_cop, requiere_nota_credito)';

interface FilaCuenta {
  id: string;
  inmobiliaria_id: string;
  periodo: string;
  vence_en: string;
  estado: string;
  lineas: Array<{ estado: string; total_cop: number | string; requiere_nota_credito: boolean }>;
}

export async function listarCuentas(u: Usuario, filtro: { situacion?: string; periodo?: string } = {}) {
  const org = await orgVisible(u);
  let q = db(CUENTAS).select(COLS_LISTA).order('periodo', { ascending: false }).limit(500); // ponytail: sin paginar; paginar si pasa de cientos
  if (org) q = q.eq('inmobiliaria_id', org);
  if (filtro.periodo) q = q.eq('periodo', filtro.periodo);
  const { data, error } = await q;
  if (error) throw fromSupabaseError(error);
  const hoy = fechaBogota(new Date());
  return ((data as unknown as FilaCuenta[] | null) ?? [])
    .map(({ lineas, ...c }) => ({
      ...c,
      situacion: situacionDe(c.estado, c.vence_en, lineas, hoy),
      saldo_cop: c.estado === 'emitida' ? saldoDe(lineas) : null,
      lineas_n: lineas.filter((l) => l.estado !== 'anulada').length,
      nota_credito_pendiente: lineas.some((l) => l.requiere_nota_credito),
    }))
    .filter((c) => !filtro.situacion || c.situacion === filtro.situacion);
}

export async function obtenerCuenta(id: string, u: Usuario) {
  const org = await orgVisible(u);
  const { data, error } = await db(CUENTAS)
    .select(
      '*, inmobiliarias(nombre), lineas:cuentas_cobro_tarifa_lineas(id, contrato_id, periodo, modalidad, origen, facturable, pct, canon_base, dias, dias_mes, ' +
        'base_cop, iva_pct, iva_cop, total_cop, estado, pagada_en, referencia_pago, anulada_motivo, requiere_nota_credito, contrato:contratos(numero))',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  const c = data as unknown as (FilaCuenta & Record<string, unknown>) | null;
  // Otra organización: 404, sin decir que existe.
  if (!c || (org && c.inmobiliaria_id !== org)) throw AppError.notFound('Cuenta de cobro no encontrada', 'CUENTA_COBRO_NOT_FOUND');
  return { ...c, situacion: situacionDe(c.estado, c.vence_en, c.lineas, fechaBogota(new Date())), saldo_cop: saldoDe(c.lineas) };
}

// ── B5: pagos ──

export interface DatosPago {
  referencia: string;
  /** AAAA-MM-DD: el día en que la inmobiliaria pagó (D12, para el cashback). */
  fecha: string;
}

interface LineaConCuenta {
  id: string;
  estado: string;
  periodo: string;
  modalidad: string;
  facturable: boolean;
  contrato_id: string;
  total_cop: number | string;
  cuenta: { id: string; estado: string; inmobiliaria_id: string; periodo: string; factura_id: string | null } | null;
  contrato: { numero: string | null } | null;
}

async function leerLinea(id: string): Promise<LineaConCuenta> {
  const { data, error } = await db(LINEAS)
    .select(
      'id, estado, periodo, modalidad, facturable, contrato_id, total_cop, ' +
        'cuenta:cuentas_cobro_tarifa(id, estado, inmobiliaria_id, periodo, factura_id), contrato:contratos(numero)',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.notFound('Línea de cobro no encontrada', 'LINEA_COBRO_NOT_FOUND');
  return data as unknown as LineaConCuenta;
}

const soloEmitida = (estado: string | undefined) => {
  if (estado !== 'emitida') throw AppError.conflict('Solo se registran pagos de cuentas de cobro emitidas.', 'CUENTA_COBRO_NO_EMITIDA');
};

/**
 * Una línea pagada (pago parcial de la cuenta, o el arrendatario de una
 * Trasladada que pagó tarde: no_recaudada → pagada, D11). De dos
 * confirmaciones a la vez, la segunda recibe 409.
 */
export async function pagarLinea(id: string, p: DatosPago, userId: string, ip?: string) {
  const l = await leerLinea(id);
  soloEmitida(l.cuenta?.estado);
  const { data, error } = await db(LINEAS)
    .update({ estado: 'pagada', pagada_en: p.fecha, referencia_pago: p.referencia, marcada_por: userId } as never)
    .eq('id', id)
    .in('estado', ['pendiente', 'no_recaudada'])
    .select('id, estado, pagada_en, referencia_pago')
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.conflict('La línea ya no está pendiente de pago.', 'LINEA_NO_PENDIENTE');
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.TARIFA_LINEA_PAGADA,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: l.contrato_id,
    detalle: { linea_id: id, cuenta_id: l.cuenta?.id, periodo: l.periodo, estado_anterior: l.estado, ...p },
    ip,
  });
  return data;
}

/**
 * La transferencia normal: todas las líneas pendientes de la cuenta, con una
 * sola referencia, en una única actualización condicionada. Las no recaudadas
 * de Trasladada quedan como están.
 * ponytail: sin comprobante adjunto (la inmobiliaria lo manda por correo, como hoy); agregar la carga cuando se pida.
 */
export async function pagarCuenta(cuentaId: string, p: DatosPago, userId: string, ip?: string) {
  const { data: cuenta, error: cErr } = await db(CUENTAS).select('id, estado, inmobiliaria_id, periodo').eq('id', cuentaId).maybeSingle();
  if (cErr) throw fromSupabaseError(cErr);
  if (!cuenta) throw AppError.notFound('Cuenta de cobro no encontrada', 'CUENTA_COBRO_NOT_FOUND');
  soloEmitida((cuenta as { estado: string }).estado);
  const { data, error } = await db(LINEAS)
    .update({ estado: 'pagada', pagada_en: p.fecha, referencia_pago: p.referencia, marcada_por: userId } as never)
    .eq('cuenta_id', cuentaId)
    .eq('estado', 'pendiente')
    .select('id');
  if (error) throw fromSupabaseError(error);
  const pagadas = ((data as { id: string }[] | null) ?? []).length;
  if (!pagadas) throw AppError.conflict('La cuenta de cobro no tiene líneas pendientes de pago.', 'CUENTA_SIN_PENDIENTES');
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.TARIFA_CUENTA_PAGADA,
    entidad: AUDIT_ENTITIES.INMOBILIARIA,
    entidadId: (cuenta as { inmobiliaria_id: string }).inmobiliaria_id,
    detalle: { cuenta_id: cuentaId, periodo: (cuenta as { periodo: string }).periodo, lineas: pagadas, ...p },
    ip,
  });
  return { cuenta_id: cuentaId, lineas_pagadas: pagadas };
}

/**
 * D11: el titular informa que el arrendatario no le pagó una línea Trasladada;
 * la inmobiliaria solo remite lo que recaudó. Se avisa a Cofianza y se le
 * recuerda reportar la mora (Anexo, Décima Quinta).
 */
export async function marcarNoRecaudada(id: string, u: Usuario, ip?: string) {
  const org = await orgVisible(u);
  const l = await leerLinea(id);
  if (!l.cuenta || (org && l.cuenta.inmobiliaria_id !== org)) throw AppError.notFound('Línea de cobro no encontrada', 'LINEA_COBRO_NOT_FOUND');
  if (l.modalidad !== 'trasladada')
    throw AppError.conflict('Solo las líneas de la modalidad Trasladada pueden quedar como no recaudadas.', 'LINEA_NO_TRASLADADA');
  if (l.cuenta.estado !== 'emitida') throw AppError.conflict('La cuenta de cobro todavía no está emitida.', 'CUENTA_COBRO_NO_EMITIDA');
  const { data, error } = await db(LINEAS)
    .update({ estado: 'no_recaudada', marcada_por: u.id } as never)
    .eq('id', id)
    .eq('estado', 'pendiente')
    .select('id, estado')
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.conflict('La línea ya no está pendiente.', 'LINEA_NO_PENDIENTE');

  const numero = l.contrato?.numero ?? l.contrato_id;
  const mes = mesTexto(l.periodo);
  logAudit({
    usuarioId: u.id,
    accion: AUDIT_ACTIONS.TARIFA_LINEA_NO_RECAUDADA,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: l.contrato_id,
    detalle: { linea_id: id, cuenta_id: l.cuenta.id, periodo: l.periodo },
    ip,
  });
  await avisarAdministradores({
    tipo: 'tarifa.no_recaudada',
    titulo: `Tarifa mensual no recaudada — contrato ${numero}`,
    mensaje: `La inmobiliaria informó que no recaudó del arrendatario la tarifa de ${mes} del contrato ${numero} (modalidad Trasladada).`,
    link: '/facturacion',
    payload: { linea_id: id, cuenta_id: l.cuenta.id, contrato_id: l.contrato_id },
  }).catch((e) => logger.warn({ lineaId: id, error: e instanceof Error ? e.message : String(e) }, 'Tarifa mensual: aviso de no recaudada no enviado'));
  await notificarYCorreo({
    userId: u.id,
    tipo: 'tarifa.recordar_mora',
    titulo: `Recuerde reportar la mora del contrato ${numero}`,
    mensaje:
      `Registramos que la tarifa de ${mes} del contrato ${numero} no fue recaudada. Le recordamos reportar la mora del arrendatario ` +
      'en «Reportar mora». Cuando el arrendatario pague, remita el valor y Cofianza lo registrará como pagado.',
    link: '/moras',
    payload: { linea_id: id, contrato_id: l.contrato_id },
  }).catch((e) => logger.warn({ lineaId: id, error: e instanceof Error ? e.message : String(e) }, 'Tarifa mensual: recordatorio de mora no enviado'));
  return data;
}

// ── B5: anulaciones ──

/** factus.ts no emite notas crédito: se avisa a los administradores para hacerla a mano (como avisarNotaCredito). */
async function avisarNotaCredito(facturaId: string, motivo: string, payload: Record<string, unknown>) {
  const { data } = await db('facturas').select('factus_number').eq('id', facturaId).maybeSingle();
  const numero = (data as { factus_number: string | null } | null)?.factus_number ?? facturaId;
  await avisarAdministradores({
    tipo: 'factura.nota_credito',
    titulo: 'Emitir nota crédito en Factus',
    mensaje: `Emitir nota crédito en Factus para la factura ${numero}: ${motivo}`,
    link: `/facturacion/${facturaId}`,
    payload: { factura_id: facturaId, ...payload },
  }).catch((e) => logger.warn({ facturaId, error: e instanceof Error ? e.message : String(e) }, 'Tarifa mensual: aviso de nota crédito no enviado'));
}

/**
 * Gerencia General anula una línea con motivo. Si ya estaba facturada, queda
 * marcada para nota crédito. Una pagada no se anula: el barrido la volvería a
 * liquidar y lo pagado no se acreditaría (primero se devuelve el pago o se
 * hace la nota crédito). En una cuenta en borrador, la siguiente pasada la
 * vuelve a liquidar con los datos actuales si el contrato sigue causando
 * tarifa ese mes; en una emitida, va como línea tardía a la siguiente cuenta.
 */
export async function anularLinea(id: string, motivo: string, u: Usuario, ip?: string) {
  if (!esGerenciaGeneral(u)) throw AppError.forbidden('Solo la Gerencia General puede anular líneas de cobro.', 'SOLO_GERENCIA_GENERAL');
  const l = await leerLinea(id);
  if (l.cuenta?.estado === 'emitiendo')
    throw AppError.conflict('La cuenta de cobro se está emitiendo. Intente de nuevo en unos minutos.', 'CUENTA_COBRO_EMITIENDO');
  if (l.estado === 'pagada')
    throw AppError.conflict('La línea ya está pagada: primero registre la devolución del pago o la nota crédito.', 'LINEA_PAGADA');
  const notaCredito = !!l.cuenta?.factura_id && l.facturable;
  const { data, error } = await db(LINEAS)
    .update({ estado: 'anulada', anulada_motivo: motivo, requiere_nota_credito: notaCredito, marcada_por: u.id } as never)
    .eq('id', id)
    .in('estado', ['pendiente', 'no_recaudada'])
    .select('id, estado, requiere_nota_credito')
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.conflict('La línea ya no se puede anular: está anulada o pagada.', 'LINEA_YA_ANULADA');
  logAudit({
    usuarioId: u.id,
    accion: AUDIT_ACTIONS.TARIFA_LINEA_ANULADA,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: l.contrato_id,
    detalle: { linea_id: id, cuenta_id: l.cuenta?.id, periodo: l.periodo, estado_anterior: l.estado, motivo, nota_credito: notaCredito },
    ip,
  });
  if (notaCredito)
    await avisarNotaCredito(
      l.cuenta!.factura_id!,
      `se anuló la tarifa de ${mesTexto(l.periodo)} del contrato ${l.contrato?.numero ?? l.contrato_id} (${motivo}).`,
      { linea_id: id, cuenta_id: l.cuenta!.id },
    );
  return data;
}

/**
 * Anula sola las líneas de los meses posteriores a la terminación efectiva
 * (D5: el mes de la terminación se cobra completo) o a la exclusión del
 * migrado. Las facturadas quedan para nota crédito; las ya pagadas no se tocan
 * y se le avisan a Gerencia como saldo a favor. Las de una cuenta que se está
 * emitiendo no se pueden tocar (trigger): se le avisan a Gerencia para
 * anularlas cuando quede emitida. La llaman la terminación del contrato, la
 * fecha efectiva y la exclusión del migrado.
 */
export async function revisarLineasPorTerminacion(contratoId: string, usuarioId: string | null): Promise<number> {
  const { data: c, error } = await db('contratos')
    .select('id, numero, estado, fecha_terminacion, fecha_terminacion_efectiva, migracion_filas(excluido_en)')
    .eq('id', contratoId)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!c) return 0;
  const k = c as unknown as ContratoCobro & { migracion_filas: Array<{ excluido_en: string | null }> | null };
  const term = terminacionDe(k);
  const excl = k.migracion_filas?.[0]?.excluido_en ?? null;
  const corte = [term, excl].filter((x): x is string => !!x).map(mesDe).sort()[0];
  if (!corte) return 0;

  const { data: lineas, error: lErr } = await db(LINEAS)
    .select('id, estado, periodo, facturable, total_cop, cuenta:cuentas_cobro_tarifa(id, estado, factura_id)')
    .eq('contrato_id', contratoId)
    .in('estado', ['pendiente', 'no_recaudada', 'pagada'])
    .gt('periodo', corte);
  if (lErr) throw fromSupabaseError(lErr);
  const filas = (lineas as unknown as Array<LineaConCuenta> | null) ?? [];
  const numero = k.numero ?? contratoId;
  const motivo = `El contrato ${numero} terminó (o salió de la cobertura) en ${mesTexto(corte)}: no causa tarifa después.`;

  let anuladas = 0;
  const porFactura = new Map<string, string[]>();
  const emitiendo: string[] = [];
  for (const l of filas.filter((x) => x.estado !== 'pagada')) {
    if (l.cuenta?.estado === 'emitiendo') {
      emitiendo.push(mesTexto(l.periodo));
      continue;
    }
    const facturaId = l.facturable ? l.cuenta?.factura_id ?? null : null;
    const { data, error: uErr } = await db(LINEAS)
      .update({ estado: 'anulada', anulada_motivo: motivo, requiere_nota_credito: !!facturaId } as never)
      .eq('id', l.id)
      .in('estado', ['pendiente', 'no_recaudada'])
      .select('id');
    if (uErr?.code === 'P0T01') {
      emitiendo.push(mesTexto(l.periodo)); // la cuenta pasó a emitiendo después de leerla
      continue;
    }
    if (uErr) throw fromSupabaseError(uErr);
    if (!(data as unknown[] | null)?.length) continue;
    anuladas++;
    if (facturaId) porFactura.set(facturaId, [...(porFactura.get(facturaId) ?? []), mesTexto(l.periodo)]);
  }
  if (anuladas)
    logAudit({
      usuarioId,
      accion: AUDIT_ACTIONS.TARIFA_LINEA_ANULADA,
      entidad: AUDIT_ENTITIES.CONTRATO,
      entidadId: contratoId,
      detalle: { automatica: true, corte, anuladas, motivo },
    });
  for (const [facturaId, meses] of porFactura)
    await avisarNotaCredito(facturaId, `se anuló la tarifa de ${meses.join(', ')} del contrato ${numero}. ${motivo}`, { contrato_id: contratoId });
  if (emitiendo.length)
    await avisarGerencia({
      tipo: 'tarifa.terminacion_durante_emision',
      titulo: `Tarifa mensual: anular a mano la tarifa del contrato ${numero}`,
      mensaje:
        `El contrato ${numero} terminó (o salió de la cobertura) en ${mesTexto(corte)}, pero la tarifa de ${emitiendo.join(', ')} ` +
        'está en una cuenta de cobro que se estaba emitiendo y no se pudo anular. Cuando la cuenta quede emitida, anule esa línea ' +
        '(si salió en la factura, se marcará para nota crédito).',
      link: `/contratos/${contratoId}`,
      payload: { contrato_id: contratoId, periodos: emitiendo },
    });

  const pagadas = filas.filter((x) => x.estado === 'pagada');
  if (pagadas.length)
    await avisarGerencia({
      tipo: 'tarifa.saldo_a_favor',
      titulo: `Tarifa mensual pagada después de la terminación — contrato ${numero}`,
      mensaje:
        `La inmobiliaria ya pagó la tarifa de ${pagadas.map((x) => mesTexto(x.periodo)).join(', ')} del contrato ${numero} ` +
        `(${pesos(pagadas.reduce((s, x) => s + Number(x.total_cop), 0))}), pero el contrato terminó en ${mesTexto(corte)}. ` +
        'Revise la devolución o el saldo a favor.',
      link: `/contratos/${contratoId}`,
      payload: { contrato_id: contratoId, lineas: pagadas.map((x) => x.id) },
    });
  return anuladas;
}

/** Cofianza registra la fecha real de terminación (A5): prevalece sobre fecha_terminacion. */
export async function registrarTerminacionEfectiva(contratoId: string, fecha: string, userId: string, ip?: string) {
  const { data, error } = await db('contratos')
    .update({ fecha_terminacion_efectiva: fecha } as never)
    .eq('id', contratoId)
    .select('id, fecha_terminacion_efectiva')
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.TARIFA_TERMINACION_EFECTIVA,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: { fecha },
    ip,
  });
  const lineas_anuladas = await revisarLineasPorTerminacion(contratoId, userId);
  return { ...(data as object), lineas_anuladas };
}

// ── B6: recordatorios de atraso ──

/**
 * D10: solo alertas. A los titulares a +1, +7 y +15 días del vencimiento
 * (recordatorio_n evita repetirlos; la transición es condicionada); el de +15
 * también a los administradores. Dentro de la franja de cobranza.
 */
export async function recordarAtrasos(now = new Date()): Promise<{ enviados: number }> {
  if (siguienteMomentoPermitido(now).getTime() !== now.getTime()) return { enviados: 0 };
  const hoy = fechaBogota(now);
  const { data, error } = await db(CUENTAS)
    .select('id, inmobiliaria_id, periodo, vence_en, recordatorio_n, inmobiliarias(nombre), lineas:cuentas_cobro_tarifa_lineas(estado, total_cop)')
    .eq('estado', 'emitida')
    .lt('vence_en', hoy)
    .lt('recordatorio_n', DIAS_RECORDATORIO.length);
  if (error) throw fromSupabaseError(error);
  let enviados = 0;
  type Fila = FilaCuenta & { recordatorio_n: number; inmobiliarias: { nombre: string } | null };
  for (const c of (data as unknown as Fila[] | null) ?? []) {
    const saldo = saldoDe(c.lineas);
    const n = saldo > 0 ? recordatorioQueToca(c.vence_en, hoy, c.recordatorio_n) : null;
    if (!n) continue;
    const { data: tomada, error: uErr } = await db(CUENTAS)
      .update({ recordatorio_n: n, ultimo_recordatorio_en: now.toISOString() } as never)
      .eq('id', c.id)
      .eq('recordatorio_n', c.recordatorio_n)
      .select('id');
    if (uErr) throw fromSupabaseError(uErr);
    if (!(tomada as unknown[] | null)?.length) continue;
    const mes = mesTexto(c.periodo);
    await avisarTitulares(c.inmobiliaria_id, {
      tipo: 'tarifa.recordatorio_pago',
      titulo: `Recordatorio: cuenta de cobro de la tarifa mensual de ${mes}`,
      mensaje:
        `Le recordamos que la cuenta de cobro de la tarifa mensual de ${mes} venció el ${c.vence_en} y registra un saldo pendiente de ${pesos(saldo)}. ` +
        'Puede pagarla por transferencia. Si ya realizó el pago, por favor omita este mensaje.',
      link: '/facturacion',
      payload: { cuenta_id: c.id, periodo: c.periodo, saldo_cop: saldo, recordatorio: n },
    });
    if (n === DIAS_RECORDATORIO.length)
      await avisarAdministradores({
        tipo: 'tarifa.atraso',
        titulo: `Cuenta de cobro de ${mes} con ${DIAS_RECORDATORIO[n - 1]} días de atraso`,
        mensaje: `La cuenta de cobro de la tarifa mensual de ${mes} de ${c.inmobiliarias?.nombre ?? 'una inmobiliaria'} sigue con un saldo de ${pesos(saldo)}.`,
        link: '/facturacion',
        payload: { cuenta_id: c.id, inmobiliaria_id: c.inmobiliaria_id, saldo_cop: saldo },
      }).catch((e) => logger.warn({ cuentaId: c.id, error: e instanceof Error ? e.message : String(e) }, 'Tarifa mensual: aviso de atraso no enviado'));
    enviados++;
  }
  return { enviados };
}

// ── B9: condiciones de cobro ──

export interface DatosCondicion {
  /** AAAA-MM-DD desde la que rige; a mitad de mes, rige desde el día 1 del siguiente (D9). */
  fecha: string;
  canon_cop?: number;
  tarifa_pct?: number;
}

/**
 * Canon reajustado: un miembro de la inmobiliaria con acceso al contrato (no
 * solo_lectura: lo frena el middleware) o el administrador. El % (otrosí):
 * solo Gerencia General. D9: la inmobiliaria solo registra hacia adelante,
 * desde el primer mes sin cortar; corregir meses ya cortados es de Cofianza
 * (y si ya estaban emitidos, el barrido avisa la nota crédito, A6).
 * ponytail: sin soporte adjunto todavía; agregarlo con la carga de archivos de la ficha del contrato.
 */
export async function registrarCondicion(contratoId: string, d: DatosCondicion, u: Usuario, ip?: string) {
  if (d.tarifa_pct != null && !esGerenciaGeneral(u))
    throw AppError.forbidden('Solo la Gerencia General puede cambiar el % de la tarifa.', 'SOLO_GERENCIA_GENERAL');
  const { data: c, error } = await db('contratos').select('id, expediente_id').eq('id', contratoId).maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!c) throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  await assertExpedienteAccess((c as { expediente_id: string }).expediente_id, u.id, u.rol);

  const desde = periodoDesde(d.fecha);
  if (u.rol !== 'administrador' && desde <= mesCortado(fechaBogota(new Date())))
    throw AppError.badRequest(
      'El canon reajustado rige desde el próximo mes sin liquidar; para corregir meses anteriores, comuníquese con Cofianza.',
      'CONDICION_RETROACTIVA',
    );
  // Solo las columnas que vienen: si ya hay fila ese mes (p. ej. el % congelado), se conserva lo demás.
  const fila = {
    contrato_id: contratoId,
    desde,
    registrado_por: u.id,
    ...(d.canon_cop != null && { canon_cop: d.canon_cop }),
    ...(d.tarifa_pct != null && { tarifa_pct: d.tarifa_pct }),
  };
  const { data, error: uErr } = await db('contrato_condiciones_cobro')
    .upsert(fila as never, { onConflict: 'contrato_id,desde' })
    .select('id, contrato_id, desde, canon_cop, tarifa_pct')
    .single();
  if (uErr) throw fromSupabaseError(uErr);
  logAudit({
    usuarioId: u.id,
    accion: AUDIT_ACTIONS.TARIFA_CONDICION_REGISTRADA,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: { desde, canon_cop: d.canon_cop ?? null, tarifa_pct: d.tarifa_pct ?? null },
    ip,
  });
  return data;
}

/** Días de anticipación del aviso de aniversario (B9). */
const DIAS_AVISO_ANIVERSARIO = 30;
const TIPO_ANIVERSARIO = 'tarifa.aniversario_canon';

/**
 * B9: hasta 30 días antes del aniversario de fecha_inicio, a los titulares:
 * en V3 se propone el canon con IPC_ANUAL; en migrados solo se pide. Sin
 * confirmación se sigue cobrando sobre el canon anterior (nunca de más). Una
 * vez por contrato y aniversario (se busca el aviso ya enviado).
 */
export async function avisarAniversarios(now = new Date()): Promise<{ avisados: number }> {
  const cal = await getCalibracion();
  const hoy = fechaBogota(now);
  const desde = mesCobroDesde(cal.TARIFA_COBRO_DESDE);
  const candidatos = (await leerContratos())
    .map(({ c }) => c)
    .filter((c) => c.estado === 'vigente' && c.fecha_inicio && entraAlCobro(c, terminacionDe(c), desde))
    .map((c) => ({ c, aniversario: proximoAniversario(c.fecha_inicio!, hoy) }))
    .filter(({ aniversario }) => (Date.parse(aniversario) - Date.parse(hoy)) / 86_400_000 <= DIAS_AVISO_ANIVERSARIO);
  if (!candidatos.length) return { avisados: 0 };

  const { data: conds, error } = await db('contrato_condiciones_cobro')
    .select('contrato_id, desde, canon_cop, tarifa_pct')
    .in('contrato_id', candidatos.map((x) => x.c.id));
  if (error) throw fromSupabaseError(error);
  const condsDe = (id: string) => ((conds as Array<CondicionCobro & { contrato_id: string }> | null) ?? []).filter((x) => x.contrato_id === id);

  let avisados = 0;
  for (const { c, aniversario } of candidatos) {
    const periodo = periodoDesde(aniversario);
    const propias = condsDe(c.id);
    if (propias.some((x) => x.desde >= periodo && x.canon_cop != null)) continue; // ya confirmado
    const { data: previo } = await db('notificaciones')
      .select('id')
      .eq('tipo', TIPO_ANIVERSARIO)
      .eq('payload->>contrato_id', c.id)
      .eq('payload->>aniversario', aniversario)
      .limit(1);
    if ((previo as unknown[] | null)?.length) continue;

    const canon = filaDeContrato(c, propias, periodo, null)?.canon ?? Number(c.valor_arriendo ?? 0);
    const numero = c.numero ?? c.id;
    const propuesta = esMigrado(c) ? null : canonPropuesto(canon, cal.IPC_ANUAL);
    await avisarTitulares(c.inmobiliaria_id!, {
      tipo: TIPO_ANIVERSARIO,
      titulo: `Confirme el canon reajustado del contrato ${numero}`,
      mensaje:
        `El ${aniversario} el contrato ${numero} cumple un año más y el canon se reajusta. ` +
        (propuesta
          ? `Con la variación del IPC de ${cal.IPC_ANUAL} %, el canon reajustado sería de hasta ${pesos(propuesta)} (hoy ${pesos(canon)}). `
          : `Hoy liquidamos la tarifa sobre un canon de ${pesos(canon)}. `) +
        `Registre en la ficha del contrato el canon que cobrará desde ${mesTexto(periodo)}; mientras no lo confirme, la tarifa se sigue liquidando sobre el canon actual.`,
      link: `/contratos/${c.id}`,
      payload: { contrato_id: c.id, aniversario, canon_actual: canon, canon_propuesto: propuesta },
    });
    avisados++;
  }
  return { avisados };
}

// ── Reporte ──

/** Detalle de las líneas de las cuentas de un mes, para comparar con la liquidación manual (mes 1). */
export async function liquidacionXlsx(periodo: string) {
  const { data, error } = await db(LINEAS)
    .select(
      'periodo, modalidad, origen, facturable, pct, canon_base, dias, dias_mes, base_cop, iva_cop, total_cop, estado, pagada_en, referencia_pago, ' +
        'contrato:contratos(numero), cuenta:cuentas_cobro_tarifa!inner(periodo, estado, inmobiliarias(nombre))',
    )
    .eq('cuenta.periodo', periodo)
    .order('periodo');
  if (error) throw fromSupabaseError(error);
  type Fila = Record<string, unknown> & { contrato: { numero: string | null } | null; cuenta: { estado: string; inmobiliarias: { nombre: string } | null } };
  const filas = ((data as unknown as Fila[] | null) ?? []).map((l) => ({
    ...l,
    inmobiliaria: l.cuenta.inmobiliarias?.nombre ?? '',
    cuenta_estado: l.cuenta.estado,
    contrato_numero: l.contrato?.numero ?? '',
    facturable_txt: l.facturable ? 'Sí' : 'No',
  }));
  const { libro } = await import('@/modules/migracion/cartera.service');
  return libro([
    {
      nombre: 'Detalle',
      columnas: [
        { header: 'Inmobiliaria', key: 'inmobiliaria', width: 30 },
        { header: 'Cuenta', key: 'cuenta_estado', width: 14 },
        { header: 'Contrato', key: 'contrato_numero', width: 18 },
        { header: 'Mes cobrado', key: 'periodo', width: 12 },
        { header: 'Modalidad', key: 'modalidad', width: 12 },
        { header: 'Origen', key: 'origen', width: 12 },
        { header: 'Factura', key: 'facturable_txt', width: 9 },
        { header: 'Canon sin IVA', key: 'canon_base', width: 14 },
        { header: 'Tarifa (%)', key: 'pct', width: 10 },
        { header: 'Días cobrados', key: 'dias', width: 10 },
        { header: 'Días del mes', key: 'dias_mes', width: 10 },
        { header: 'Tarifa sin IVA (COP)', key: 'base_cop', width: 16 },
        { header: 'IVA (COP)', key: 'iva_cop', width: 14 },
        { header: 'Total (COP)', key: 'total_cop', width: 16 },
        { header: 'Estado', key: 'estado', width: 13 },
        { header: 'Pagada el', key: 'pagada_en', width: 12 },
        { header: 'Referencia', key: 'referencia_pago', width: 20 },
      ],
      filas,
    },
  ]);
}

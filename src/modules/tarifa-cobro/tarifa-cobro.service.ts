/**
 * Cobro de la tarifa mensual de la fianza (plan cobro-tarifa-mensual, B3).
 *
 * liquidarPendientes: el barrido que arma, por inmobiliaria, la cuenta de cobro
 * del mes M en borrador (corte el último día de M-1 en Bogotá, vence el 10 de M)
 * con una línea por contrato y mes. Idempotente: el índice parcial
 * (contrato_id, periodo) WHERE estado <> 'anulada' impide la línea repetida.
 * Mientras la cuenta está en borrador se recalcula; emitida, solo avisa.
 * TARIFA_COBRO_DESDE (D16) impide liquidar lo ya facturado a mano.
 *
 * emitirCuenta (B4): borrador → emitiendo → emitida, con la factura de Factus
 * (solo líneas facturables) tras TARIFA_FACTURA_ENABLED; emitirPendientes la
 * corre sola tras TARIFA_EMISION_ENABLED.
 */

import { env } from '@/config/env';
import { getCalibracion, mesCobroDesde } from '@/lib/calibracion';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { fetchAll } from '@/lib/fetchAll';
import { logger } from '@/lib/logger';
import { formatearPesos } from '@/lib/numerosEnLetras';
import { supabase } from '@/lib/supabase';
import { gerenciaGeneralIds } from '@/modules/beneficios/beneficios.service';
import { fechaBogota } from '@/modules/contratos/v3/formato';
import { pctDeEstudio } from '@/modules/dashboard/dashboard.service';
import { clienteDesdePerfil, faltantesFiscales, type ClienteFiscal, type PerfilFiscal } from '@/modules/facturacion/cliente-fiscal';
import { crearFacturaDesdeCuentaCobro } from '@/modules/facturacion/facturacion.service';
import { primerDiaMesSiguiente } from '@/modules/migracion/cartera.reglas';
import { notificarYCorreo, type NotificarUsuarioInput } from '@/modules/notificaciones/notificaciones.service';
import {
  ESTADOS_COBRABLES,
  activacionDe,
  calcularLinea,
  entraAlCobro,
  esMigrado,
  mesCortado,
  mesesACobrar,
  modalidadDe,
  terminacionDe,
  totalesDe,
  venceCuenta,
  type CalculoLinea,
  type CondicionCobro,
  type ContratoCobro,
} from './tarifa-cobro.reglas';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
const CUENTAS = 'cuentas_cobro_tarifa';
const LINEAS = 'cuentas_cobro_tarifa_lineas';
/** Cuentas que todavía se recalculan y reciben líneas. */
const MUTABLES = ['borrador', 'bloqueada_fiscal'];
/** El trigger cuentas_cobro_tarifa_lineas_congeladas: la cuenta salió de borrador entre la lectura y la escritura. */
const CONGELADA = 'P0T01';

export type Aviso = Omit<NotificarUsuarioInput, 'userId'>;

async function avisar(ids: string[], aviso: Aviso): Promise<void> {
  for (const userId of ids)
    await notificarYCorreo({ userId, ...aviso }).catch((e) =>
      logger.warn({ userId, tipo: aviso.tipo, error: e instanceof Error ? e.message : String(e) }, 'Tarifa mensual: aviso no enviado'),
    );
}

export const avisarGerencia = (aviso: Aviso) =>
  gerenciaGeneralIds()
    .then((ids) => avisar(ids, aviso))
    .catch((e) => logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Tarifa mensual: sin Gerencia General a quien avisar'));

/** Devuelve a cuántos titulares avisó. */
export async function avisarTitulares(inmobiliariaId: string, aviso: Aviso): Promise<number> {
  const { data, error } = await db('inmobiliaria_miembros')
    .select('perfil_id')
    .eq('inmobiliaria_id', inmobiliariaId)
    .eq('estado', 'activo')
    .eq('rol_miembro', 'owner')
    .not('perfil_id', 'is', null);
  const ids = ((data as { perfil_id: string }[] | null) ?? []).map((m) => m.perfil_id);
  if (error || !ids.length) logger.warn({ inmobiliariaId, error: error?.message }, 'Tarifa mensual: inmobiliaria sin titulares a quien avisar');
  await avisar(ids, aviso);
  return ids.length;
}

const COLS_FISCALES =
  'nombre, apellido, tipo_documento, numero_documento, razon_social, nit, domicilio_direccion, ' +
  'direccion_comercial, direccion, telefono, whatsapp_recaudo, email_recaudo, municipio_codigo, municipio_nombre';

/**
 * D14: la factura sale a nombre de la inmobiliaria (su titular principal) como
 * persona jurídica: sin NIT es un faltante más. La reutiliza la emisión (B4).
 */
export async function clienteDeInmobiliaria(
  inmobiliariaId: string,
): Promise<{ cliente: ClienteFiscal | null; faltantes: string[]; cerrada: boolean }> {
  const { data: org, error } = await db('inmobiliarias').select('owner_perfil_id, estado').eq('id', inmobiliariaId).maybeSingle();
  if (error) throw fromSupabaseError(error);
  const perfilId = (org as { owner_perfil_id: string | null } | null)?.owner_perfil_id;
  const cerrada = (org as { estado?: string } | null)?.estado === 'cerrada';
  if (!perfilId) return { cliente: null, faltantes: ['nit'], cerrada };
  const { data: perfil, error: pErr } = await db('perfiles').select(COLS_FISCALES).eq('id', perfilId).maybeSingle();
  if (pErr) throw fromSupabaseError(pErr);
  if (!perfil) return { cliente: null, faltantes: ['nit'], cerrada };
  const email = (await supabase.auth.admin.getUserById(perfilId)).data?.user?.email ?? null;
  const cliente = clienteDesdePerfil(perfil as unknown as PerfilFiscal, email);
  const faltantes = faltantesFiscales(cliente);
  if (cliente.tipo_persona !== 'juridica') faltantes.unshift('nit');
  return { cliente, faltantes, cerrada };
}

const ETIQUETA_FALTANTE: Record<string, string> = {
  nit: 'NIT',
  tipo_documento: 'NIT',
  numero_documento: 'NIT',
  digito_verificacion: 'dígito de verificación del NIT',
  razon_social: 'razón social',
  email: 'correo de facturación',
  direccion: 'dirección',
  telefono: 'teléfono',
  municipio_codigo: 'municipio',
};
const describirFaltantes = (f: string[]) => [...new Set(f.map((x) => ETIQUETA_FALTANTE[x] ?? x))].join(', ');

const SELECT_CONTRATO =
  'id, numero, origen, estado, destinacion, fecha_firma, fecha_inicio, fecha_terminacion, fecha_terminacion_efectiva, ' +
  'valor_arriendo, expediente_id, tarifa_congelada:datos_variables->documento->entrada->tarifaPct, ' +
  'modalidad:datos_variables->documento->entrada->>modalidad, ' +
  'expedientes(inmuebles!expedientes_inmueble_id_fkey(inmobiliaria_id)), ' +
  'migracion_filas(tarifa_pct, tarifa_acta_pct, tarifa_desde, excluido_en)';

type FilaContrato = Omit<ContratoCobro, 'inmobiliaria_id' | 'migracion'> & {
  expediente_id: string;
  expedientes: { inmuebles: { inmobiliaria_id: string | null } | null } | null;
  migracion_filas: ContratoCobro['migracion'][] | null;
};

interface LineaViva {
  id: string;
  cuenta_id: string;
  contrato_id: string;
  periodo: string;
  estado: string;
  pct: number | string;
  canon_base: number | string;
  dias: number;
  base_cop: number;
  iva_pct: number | string;
  requiere_nota_credito: boolean;
  cuenta: { estado: string } | null;
}

interface Cuenta {
  id: string;
  inmobiliaria_id: string;
  periodo: string;
  estado: string;
}

const igual = (l: LineaViva, x: CalculoLinea) =>
  Number(l.pct) === x.pct && Number(l.canon_base) === x.canon_base && l.dias === x.dias && l.base_cop === x.base_cop && Number(l.iva_pct) === x.iva_pct;

const mesTexto = (periodo: string) => periodo.slice(0, 7);

export async function leerContratos(): Promise<Array<{ c: ContratoCobro; expedienteId: string }>> {
  const r = await fetchAll<FilaContrato>((d, h) =>
    db('contratos')
      .select(SELECT_CONTRATO)
      .in('estado', ESTADOS_COBRABLES)
      .not('fecha_firma', 'is', null)
      .order('id')
      .range(d, h) as never,
  );
  if (r.error) throw fromSupabaseError(r.error);
  return r.data.map(({ expedientes, migracion_filas, expediente_id, ...c }) => ({
    c: { ...c, inmobiliaria_id: expedientes?.inmuebles?.inmobiliaria_id ?? null, migracion: migracion_filas?.[0] ?? null },
    expedienteId: expediente_id,
  }));
}

/** TF-3: terminados sin fecha; la del cambio de estado en el historial. */
async function terminacionesDelHistorial(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { data, error } = await db('contrato_historial_estados')
    .select('contrato_id, created_at')
    .in('contrato_id', ids)
    .in('estado_nuevo', ['finalizado', 'cancelado'])
    .order('created_at', { ascending: false });
  if (error) throw fromSupabaseError(error);
  for (const h of (data as { contrato_id: string; created_at: string }[] | null) ?? []) if (!out.has(h.contrato_id)) out.set(h.contrato_id, h.created_at);
  return out;
}

/**
 * D2: un V3 sin tarifa congelada congela el % de su estudio en el primer
 * período cobrado. Si ese mes ya tenía fila (p. ej. solo el canon), se le
 * completa el %; devuelve la fila como quedó en la base.
 */
async function congelarPct(c: ContratoCobro, expedienteId: string, desde: string, ivaPct: number): Promise<CondicionCobro | null> {
  const { viaDelEstudio } = await import('@/modules/estudios/certificado.service');
  const pct = await pctDeEstudio(expedienteId, ivaPct, viaDelEstudio);
  if (pct === null) return null;
  const tabla = () => db('contrato_condiciones_cobro');
  const { error } = await tabla().upsert({ contrato_id: c.id, desde, canon_cop: null, tarifa_pct: pct } as never, {
    onConflict: 'contrato_id,desde',
    ignoreDuplicates: true,
  });
  if (error) throw fromSupabaseError(error);
  const { error: uErr } = await tabla().update({ tarifa_pct: pct } as never).eq('contrato_id', c.id).eq('desde', desde).is('tarifa_pct', null);
  if (uErr) throw fromSupabaseError(uErr);
  const { data, error: rErr } = await tabla().select('desde, canon_cop, tarifa_pct').eq('contrato_id', c.id).eq('desde', desde).maybeSingle();
  if (rErr) throw fromSupabaseError(rErr);
  return data as CondicionCobro | null;
}

/**
 * D16: si TARIFA_COBRO_DESDE se movió hacia adelante (o se «apagó»), las
 * líneas pendientes de meses anteriores que siguen en borrador salen: esos
 * meses se facturan a mano. Las emitidas no se tocan (emitirCuenta, además,
 * se niega a emitir una cuenta con líneas anteriores al tope).
 */
async function anularAnterioresAlDesde(desde: string): Promise<number> {
  const { data: abiertas, error } = await db(CUENTAS).select('id').in('estado', MUTABLES);
  if (error) throw fromSupabaseError(error);
  const ids = ((abiertas as { id: string }[] | null) ?? []).map((x) => x.id);
  if (!ids.length) return 0;
  const { data, error: uErr } = await db(LINEAS)
    .update({ estado: 'anulada', anulada_motivo: 'Anterior a TARIFA_COBRO_DESDE: ese mes se factura por fuera de la plataforma.' } as never)
    .in('cuenta_id', ids)
    .lt('periodo', desde)
    .eq('estado', 'pendiente')
    .select('id');
  if (uErr?.code === CONGELADA) return 0; // una cuenta pasó a emitiendo: la siguiente pasada; emitirCuenta la frena
  if (uErr) throw fromSupabaseError(uErr);
  return ((data as unknown[] | null) ?? []).length;
}

export async function liquidarPendientes(now = new Date()): Promise<{ lineas: number; recalculadas: number; bloqueadas: number }> {
  const cal = await getCalibracion();
  const desde = mesCobroDesde(cal.TARIFA_COBRO_DESDE);
  const M = mesCortado(fechaBogota(now));
  const res = { lineas: 0, recalculadas: 0, bloqueadas: 0 };
  // Desde el tope en adelante, el recálculo de abajo ya anula lo anterior a él.
  if (M < desde) return { ...res, recalculadas: await anularAnterioresAlDesde(desde) };
  const ivaPct = cal.TARIFA_IVA;

  const contratos = await leerContratos();
  const historial = await terminacionesDelHistorial(
    contratos.filter(({ c }) => c.estado !== 'vigente' && !c.fecha_terminacion && !c.fecha_terminacion_efectiva).map(({ c }) => c.id),
  );

  const [condR, lineasR, cuentasR] = await Promise.all([
    fetchAll<CondicionCobro & { contrato_id: string }>((d, h) =>
      db('contrato_condiciones_cobro').select('contrato_id, desde, canon_cop, tarifa_pct').order('id').range(d, h) as never,
    ),
    // ponytail: trae todas las líneas vivas en cada pasada; acotar por período cuando pasen de decenas de miles.
    fetchAll<LineaViva>((d, h) =>
      db(LINEAS)
        .select('id, cuenta_id, contrato_id, periodo, estado, pct, canon_base, dias, base_cop, iva_pct, requiere_nota_credito, cuenta:cuentas_cobro_tarifa(estado)')
        .neq('estado', 'anulada')
        .order('id')
        .range(d, h) as never,
    ),
    db(CUENTAS).select('id, inmobiliaria_id, periodo, estado').in('periodo', [M, primerDiaMesSiguiente(M)]),
  ]);
  if (condR.error) throw fromSupabaseError(condR.error);
  if (lineasR.error) throw fromSupabaseError(lineasR.error);
  if (cuentasR.error) throw fromSupabaseError(cuentasR.error);

  const condiciones = new Map<string, CondicionCobro[]>();
  for (const x of condR.data) condiciones.set(x.contrato_id, [...(condiciones.get(x.contrato_id) ?? []), x]);
  const lineasDe = new Map<string, LineaViva[]>();
  for (const l of lineasR.data) lineasDe.set(l.contrato_id, [...(lineasDe.get(l.contrato_id) ?? []), l]);
  const cuentas = (cuentasR.data as Cuenta[] | null) ?? [];

  /** D7: la línea va a la borrador más reciente (M+1 si la de M ya salió); si no hay, se crea. */
  const cuentaDestino = async (orgId: string): Promise<string | null> => {
    const deOrg = cuentas.filter((x) => x.inmobiliaria_id === orgId).sort((a, b) => b.periodo.localeCompare(a.periodo));
    const abierta = deOrg.find((x) => MUTABLES.includes(x.estado));
    if (abierta) return abierta.id;
    const periodo = deOrg.some((x) => x.periodo === M) ? primerDiaMesSiguiente(M) : M;
    if (deOrg.some((x) => x.periodo === periodo)) return null;
    const { error } = await db(CUENTAS).upsert({ inmobiliaria_id: orgId, periodo, vence_en: venceCuenta(periodo) } as never, {
      onConflict: 'inmobiliaria_id,periodo',
      ignoreDuplicates: true,
    });
    if (error) throw fromSupabaseError(error);
    const { data, error: rErr } = await db(CUENTAS).select('id, inmobiliaria_id, periodo, estado').eq('inmobiliaria_id', orgId).eq('periodo', periodo).maybeSingle();
    if (rErr) throw fromSupabaseError(rErr);
    if (!data) return null;
    cuentas.push(data as Cuenta);
    return MUTABLES.includes((data as Cuenta).estado) ? (data as Cuenta).id : null;
  };

  const anular = async (l: LineaViva, motivo: string) => {
    const { error } = await db(LINEAS).update({ estado: 'anulada', anulada_motivo: motivo } as never).eq('id', l.id).eq('estado', 'pendiente');
    if (error?.code === CONGELADA) return;
    if (error) throw fromSupabaseError(error);
    res.recalculadas++;
  };

  const cobrables = new Set<string>();
  for (const { c, expedienteId } of contratos) {
    const terminacion = terminacionDe(c, historial.get(c.id) ?? null);
    if (!entraAlCobro(c, terminacion, desde)) continue;
    const modalidad = modalidadDe(c);
    if (!modalidad) {
      logger.warn({ contratoId: c.id }, 'Tarifa mensual: contrato V3 sin modalidad, sin regla de cobro');
      continue;
    }
    cobrables.add(c.id);
    const propias = lineasDe.get(c.id) ?? [];
    const meses = mesesACobrar(activacionDe(c)!, terminacion, desde, M);

    let conds = condiciones.get(c.id) ?? [];

    if (!esMigrado(c) && !(Number(c.tarifa_congelada) > 0) && !conds.some((x) => x.tarifa_pct != null) && meses.length) {
      const congelada = await congelarPct(c, expedienteId, meses[0], ivaPct);
      if (!congelada) {
        logger.warn({ contratoId: c.id }, 'Tarifa mensual: V3 sin tarifa congelada ni estudio completado, sin regla de cobro');
        continue;
      }
      conds = [...conds.filter((x) => x.desde !== congelada.desde), congelada];
    }

    for (const periodo of [...new Set([...meses, ...propias.map((l) => l.periodo)])].sort()) {
      const viva = propias.find((l) => l.periodo === periodo);
      const calc = calcularLinea(c, conds, periodo, terminacion, ivaPct);

      if (viva && viva.cuenta?.estado === 'emitida') {
        // A6: cambió el % (p. ej. el migrado pasó a no reportable) o el canon (lo corrigió Cofianza) de un período ya emitido.
        if (calc && (calc.pct !== Number(viva.pct) || calc.canon_base !== Number(viva.canon_base)) && !viva.requiere_nota_credito) {
          const { data, error } = await db(LINEAS)
            .update({ requiere_nota_credito: true } as never)
            .eq('id', viva.id)
            .eq('requiere_nota_credito', false)
            .select('id');
          if (error) throw fromSupabaseError(error);
          if ((data as unknown[] | null)?.length)
            await avisarGerencia({
              tipo: 'tarifa.cambio_en_cuenta_emitida',
              titulo: `Tarifa mensual: cambió la tarifa de un período ya emitido — contrato ${c.numero ?? c.id}`,
              mensaje:
                `La tarifa del contrato ${c.numero ?? c.id} para ${mesTexto(periodo)} pasó de ${Number(viva.pct)} % sobre un canon de ` +
                `$${formatearPesos(Number(viva.canon_base))} a ${calc.pct} % sobre $${formatearPesos(calc.canon_base)} ` +
                'después de emitida la cuenta de cobro. Revise si corresponde una nota crédito.',
              link: '/facturacion',
              payload: {
                contrato_id: c.id,
                linea_id: viva.id,
                periodo,
                pct_anterior: Number(viva.pct),
                pct_nuevo: calc.pct,
                canon_anterior: Number(viva.canon_base),
                canon_nuevo: calc.canon_base,
              },
            });
        }
        continue;
      }
      if (viva) {
        if (!viva.cuenta || !MUTABLES.includes(viva.cuenta.estado) || viva.estado !== 'pendiente') continue;
        if (!calc || !meses.includes(periodo)) await anular(viva, 'Recalculada en borrador: el contrato ya no causa tarifa en este período.');
        else if (!igual(viva, calc)) {
          const { error } = await db(LINEAS).update(calc as never).eq('id', viva.id).eq('estado', 'pendiente');
          if (error?.code === CONGELADA) continue;
          if (error) throw fromSupabaseError(error);
          res.recalculadas++;
        }
        continue;
      }
      if (!calc || !meses.includes(periodo)) continue;

      const cuentaId = await cuentaDestino(c.inmobiliaria_id!);
      if (!cuentaId) {
        logger.warn({ contratoId: c.id, periodo }, 'Tarifa mensual: la inmobiliaria no tiene cuenta abierta para la línea');
        continue;
      }
      const { error } = await db(LINEAS).insert({
        cuenta_id: cuentaId,
        contrato_id: c.id,
        periodo,
        modalidad,
        origen: esMigrado(c) ? 'migracion' : 'plataforma',
        facturable: modalidad === 'tradicional', // D13
        ...calc,
      } as never);
      if (error?.code === '23505' || error?.code === CONGELADA) continue; // otra pasada ya la creó, o la cuenta salió de borrador: la siguiente pasada
      if (error) throw fromSupabaseError(error);
      res.lineas++;
      if (!c.fecha_terminacion_efectiva && !c.fecha_terminacion && historial.has(c.id))
        await avisarGerencia({
          tipo: 'tarifa.terminacion_sin_fecha',
          titulo: `Tarifa mensual: contrato ${c.numero ?? c.id} terminado sin fecha de terminación`,
          mensaje:
            `El contrato ${c.numero ?? c.id} está ${c.estado} sin fecha de terminación; para liquidar ${mesTexto(periodo)} se tomó la del historial ` +
            `(${fechaBogota(historial.get(c.id)!)}). Registre la fecha efectiva de terminación si es otra.`,
          link: `/contratos/${c.id}`,
          payload: { contrato_id: c.id, periodo },
        });
    }
  }

  // Lo que dejó de entrar al cobro (excluido, terminado antes de TARIFA_COBRO_DESDE…) sale del borrador.
  for (const l of lineasR.data)
    if (!cobrables.has(l.contrato_id) && l.estado === 'pendiente' && l.cuenta && MUTABLES.includes(l.cuenta.estado))
      await anular(l, 'Recalculada en borrador: el contrato ya no entra al cobro de la tarifa mensual.');

  res.bloqueadas = await cerrarBorradores();
  return res;
}

/**
 * Totales desde las líneas y bloqueo fiscal (D14) de cada cuenta en borrador.
 * Nunca toca una cuenta que ya no está en borrador. Pasa a bloqueada_fiscal
 * avisando a los titulares una sola vez (la transición es condicionada) y
 * vuelve sola a borrador cuando completan los datos.
 */
async function cerrarBorradores(): Promise<number> {
  const { data, error } = await db(CUENTAS).select('id, inmobiliaria_id, periodo, estado').in('estado', MUTABLES);
  if (error) throw fromSupabaseError(error);
  let bloqueadas = 0;
  for (const cuenta of (data as Cuenta[] | null) ?? []) {
    const { data: lineas, error: lErr } = await db(LINEAS).select('base_cop, iva_cop').eq('cuenta_id', cuenta.id).neq('estado', 'anulada');
    if (lErr) throw fromSupabaseError(lErr);
    const { error: tErr } = await db(CUENTAS)
      .update(totalesDe((lineas as { base_cop: number; iva_cop: number }[] | null) ?? []) as never)
      .eq('id', cuenta.id)
      .in('estado', MUTABLES);
    if (tErr) throw fromSupabaseError(tErr);

    const { faltantes } = await clienteDeInmobiliaria(cuenta.inmobiliaria_id);
    const nuevo = faltantes.length ? 'bloqueada_fiscal' : 'borrador';
    if (nuevo === 'bloqueada_fiscal') bloqueadas++;
    if (nuevo === cuenta.estado) continue;
    const { data: cambio, error: cErr } = await db(CUENTAS).update({ estado: nuevo } as never).eq('id', cuenta.id).eq('estado', cuenta.estado).select('id');
    if (cErr) throw fromSupabaseError(cErr);
    if (nuevo === 'bloqueada_fiscal' && (cambio as unknown[] | null)?.length)
      await avisarTitulares(cuenta.inmobiliaria_id, {
        tipo: 'tarifa.datos_fiscales_faltantes',
        titulo: 'Faltan datos para facturar la tarifa mensual de Cofianza',
        mensaje:
          `Para emitir la cuenta de cobro de la tarifa mensual de ${mesTexto(cuenta.periodo)} necesitamos los datos de facturación ` +
          `de su inmobiliaria como persona jurídica. Falta: ${describirFaltantes(faltantes)}. ` +
          'Complételos en «Datos para contrato»; mientras tanto, la cuenta queda en espera.',
        link: '/configuracion/datos-contrato',
        payload: { cuenta_id: cuenta.id, periodo: cuenta.periodo, faltantes },
      });
  }
  return bloqueadas;
}

// ── B4: emisión ──

const COLS_CUENTA = 'id, inmobiliaria_id, periodo, vence_en, estado';
/** Una emisión que quedó colgada (el proceso murió a mitad) se puede retomar pasado este tiempo. */
const EMISION_COLGADA_MS = 10 * 60_000;

const NO_EMITIBLE: Record<string, string> = {
  emitiendo: 'La cuenta de cobro ya se está emitiendo. Espere unos minutos.',
  emitida: 'La cuenta de cobro ya fue emitida.',
  bloqueada_fiscal: 'Faltan datos fiscales de la inmobiliaria para emitir la cuenta de cobro.',
  anulada: 'La cuenta de cobro está anulada.',
};

interface LineaAEmitir {
  contrato_id: string;
  periodo: string;
  dias: number;
  dias_mes: number;
  base_cop: number;
  iva_pct: number | string;
  iva_cop: number | string;
  facturable: boolean;
  contrato: { numero: string | null } | null;
}

/**
 * Emite la cuenta: congela totales y copia fiscal, y factura en Factus solo
 * las líneas facturables (Tradicional y migración, D13) si
 * TARIFA_FACTURA_ENABLED; apagado, queda emitida sin factura (mes de sombra).
 * El bloqueo es la transición condicionada borrador → emitiendo: de dos
 * emisiones a la vez, la segunda recibe 409. Si falla antes de llamar a
 * Factus, vuelve a borrador. Si falla después, queda en «emitiendo» con las
 * líneas congeladas (trigger) hasta el reintento, pasado EMISION_COLGADA_MS:
 * la factura se recupera por la referencia y sigue cuadrando con las líneas.
 */
export async function emitirCuenta(cuentaId: string, userId: string | null = null) {
  const colgada = new Date(Date.now() - EMISION_COLGADA_MS).toISOString();
  const { data: tomadas, error } = await db(CUENTAS)
    .update({ estado: 'emitiendo' } as never)
    .eq('id', cuentaId)
    .or(`estado.eq.borrador,and(estado.eq.emitiendo,updated_at.lt."${colgada}")`)
    .select(COLS_CUENTA);
  if (error) throw fromSupabaseError(error);
  const cuenta = (tomadas as Array<Cuenta & { vence_en: string }> | null)?.[0];
  if (!cuenta) {
    const { data: actual, error: aErr } = await db(CUENTAS).select('estado').eq('id', cuentaId).maybeSingle();
    if (aErr) throw fromSupabaseError(aErr);
    const estado = (actual as { estado: string } | null)?.estado;
    if (!estado) throw AppError.notFound('Cuenta de cobro no encontrada', 'CUENTA_COBRO_NOT_FOUND');
    throw AppError.conflict(NO_EMITIBLE[estado] ?? 'La cuenta de cobro no se puede emitir.', 'CUENTA_COBRO_NO_EMITIBLE');
  }

  /** Errores de antes de llamar a Factus: la cuenta puede volver a borrador. */
  let antesDeFactus = true;
  try {
    const { data, error: lErr } = await db(LINEAS)
      .select('contrato_id, periodo, dias, dias_mes, base_cop, iva_pct, iva_cop, facturable, contrato:contratos(numero)')
      .eq('cuenta_id', cuenta.id)
      .neq('estado', 'anulada')
      .order('periodo');
    if (lErr) throw fromSupabaseError(lErr);
    const lineas = (data as LineaAEmitir[] | null) ?? [];
    if (!lineas.length) throw AppError.conflict('La cuenta de cobro no tiene líneas por cobrar.', 'CUENTA_COBRO_VACIA');
    // D16: un mes anterior al tope ya se facturó a mano (el barrido anula esas líneas).
    const desde = mesCobroDesde((await getCalibracion()).TARIFA_COBRO_DESDE);
    if (lineas.some((l) => l.periodo < desde))
      throw AppError.conflict(
        'La cuenta de cobro tiene meses anteriores a TARIFA_COBRO_DESDE, que se facturan por fuera de la plataforma. Espere la siguiente liquidación.',
        'CUENTA_COBRO_ANTERIOR_AL_DESDE',
      );

    const { cliente, faltantes, cerrada } = await clienteDeInmobiliaria(cuenta.inmobiliaria_id);
    if (!cliente || faltantes.length)
      // Vuelve a borrador; el barrido la bloquea y avisa a los titulares.
      throw new AppError(400, 'CLIENTE_DATOS_INCOMPLETOS', `Faltan datos fiscales de la inmobiliaria: ${describirFaltantes(faltantes)}.`, { faltantes });

    const facturables = lineas.filter((l) => l.facturable);
    antesDeFactus = !(env.TARIFA_FACTURA_ENABLED && facturables.length);
    const factura =
      env.TARIFA_FACTURA_ENABLED && facturables.length
        ? await crearFacturaDesdeCuentaCobro(
            {
              cuentaId: cuenta.id,
              venceEn: cuenta.vence_en,
              cliente,
              lineas: facturables.map((l) => ({
                contrato_numero: l.contrato?.numero ?? l.contrato_id,
                periodo: l.periodo,
                dias: l.dias,
                dias_mes: l.dias_mes,
                base_cop: Number(l.base_cop),
                iva_pct: Number(l.iva_pct),
                iva_cop: Number(l.iva_cop),
              })),
            },
            userId,
          )
        : null;

    const totales = totalesDe(lineas);
    const { data: emitida, error: eErr } = await db(CUENTAS)
      .update({
        estado: 'emitida',
        emitida_en: new Date().toISOString(),
        ...totales,
        cliente_nit: cliente.digito_verificacion ? `${cliente.numero_documento}-${cliente.digito_verificacion}` : cliente.numero_documento,
        cliente_razon_social: cliente.razon_social,
        cliente_email: cliente.email,
        cliente_direccion: cliente.direccion,
        factura_id: factura?.id ?? null,
      } as never)
      .eq('id', cuenta.id)
      .eq('estado', 'emitiendo')
      .select('id, estado, factura_id, total_cop, emitida_en')
      .maybeSingle();
    if (eErr) throw fromSupabaseError(eErr);
    if (!emitida) throw AppError.conflict(NO_EMITIBLE.emitiendo, 'CUENTA_COBRO_NO_EMITIBLE');

    const mes = mesTexto(cuenta.periodo);
    if (!env.TARIFA_FACTURA_ENABLED) {
      // Mes de sombra (D6): ese mes todavía se cobra a mano; un aviso a la inmobiliaria parecería un doble cobro.
      await avisarGerencia({
        tipo: 'tarifa.cuenta_emitida_sombra',
        titulo: `Tarifa mensual: cuenta de ${mes} emitida en sombra`,
        mensaje: `La cuenta de cobro de ${mes} quedó emitida por $${formatearPesos(totales.total_cop)} sin factura y sin aviso a la inmobiliaria (TARIFA_FACTURA_ENABLED apagado).`,
        link: '/facturacion',
        payload: { cuenta_id: cuenta.id, periodo: cuenta.periodo, inmobiliaria_id: cuenta.inmobiliaria_id },
      });
      return emitida as { id: string; estado: string; factura_id: string | null; total_cop: number; emitida_en: string };
    }
    const avisados = await avisarTitulares(cuenta.inmobiliaria_id, {
      tipo: 'tarifa.cuenta_emitida',
      titulo: `Cuenta de cobro de la tarifa mensual de Cofianza — ${mes}`,
      mensaje:
        `Su cuenta de cobro de la tarifa mensual de ${mes} quedó emitida por $${formatearPesos(totales.total_cop)} y vence el ${cuenta.vence_en}. ` +
        'Puede pagarla por transferencia' +
        (factura ? '; la factura electrónica le llega al correo de facturación.' : '.'),
      link: '/facturacion',
      payload: { cuenta_id: cuenta.id, periodo: cuenta.periodo, factura_id: factura?.id ?? null },
    });
    if (cerrada || !avisados)
      await avisarGerencia({
        tipo: 'tarifa.cuenta_sin_titulares',
        titulo: `Tarifa mensual: cuenta de ${mes} emitida a una inmobiliaria ${cerrada ? 'cerrada' : 'sin titulares'}`,
        mensaje: `La cuenta de cobro de ${mes} se emitió, pero la inmobiliaria ${cerrada ? 'está cerrada' : 'no tiene titulares activos'} y nadie recibió el aviso. Gestione el cobro directamente.`,
        link: '/facturacion',
        payload: { cuenta_id: cuenta.id, inmobiliaria_id: cuenta.inmobiliaria_id },
      });
    return emitida as { id: string; estado: string; factura_id: string | null; total_cop: number; emitida_en: string };
  } catch (e) {
    const sinFactus = antesDeFactus || (e instanceof AppError && e.errorCode === 'IVA_CONCEPTO_GRAVADO_EN_CERO');
    if (sinFactus) {
      const { error: rErr } = await db(CUENTAS).update({ estado: 'borrador' } as never).eq('id', cuenta.id).eq('estado', 'emitiendo');
      if (rErr) logger.error({ cuentaId, error: rErr.message }, 'Tarifa mensual: la cuenta quedó en emitiendo tras un error');
    } else logger.warn({ cuentaId }, 'Tarifa mensual: emisión fallida después de llamar a Factus; la cuenta queda en emitiendo para el reintento');
    if (e instanceof AppError && e.errorCode === 'FACTURA_RECUPERADA_NO_CUADRA')
      await avisarGerencia({
        tipo: 'tarifa.factura_no_cuadra',
        titulo: `Tarifa mensual: la factura de la cuenta de ${mesTexto(cuenta.periodo)} no cuadra`,
        mensaje: `${e.message} La cuenta queda en emisión hasta que se resuelva.`,
        link: '/facturacion',
        payload: { cuenta_id: cuenta.id, ...(e.details as object) },
      });
    throw e;
  }
}

/**
 * TARIFA_EMISION_ENABLED: emite las cuentas en borrador cuyo corte ya pasó
 * (la de M+1 que recibe líneas tardías espera su corte) y retoma las que
 * quedaron colgadas en «emitiendo». Una que falla queda para la siguiente
 * pasada o el botón.
 */
export async function emitirPendientes(now = new Date()): Promise<{ emitidas: number; fallidas: number }> {
  const colgada = new Date(now.getTime() - EMISION_COLGADA_MS).toISOString();
  const { data, error } = await db(CUENTAS)
    .select('id')
    .or(`estado.eq.borrador,and(estado.eq.emitiendo,updated_at.lt."${colgada}")`)
    .lte('periodo', mesCortado(fechaBogota(now)))
    .gt('total_cop', 0);
  if (error) throw fromSupabaseError(error);
  const res = { emitidas: 0, fallidas: 0 };
  for (const { id } of (data as { id: string }[] | null) ?? []) {
    try {
      await emitirCuenta(id);
      res.emitidas++;
    } catch (e) {
      res.fallidas++;
      logger.warn({ cuentaId: id, error: e instanceof Error ? e.message : String(e) }, 'Tarifa mensual: emisión automática fallida');
    }
  }
  return res;
}

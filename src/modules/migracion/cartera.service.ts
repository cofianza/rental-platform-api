// ============================================================
// Cartera migrada después de la activación (spec migración §5-§8):
// - en revisión (§6), exclusión de cobertura (§7.2.1) con suspensión de la
//   inmobiliaria por declaración falsa (§7.2.2), auditorías (§7.3);
// - verificación individual (§5.1.3) y paso a REPORTABLE (§5.2.5);
// - tablero por lote (§8.1-§8.3), alerta de exposición (§8.4), reporte de
//   contratos sobre formato anterior (§8.5) y liquidación mensual (§4.7).
// Todo es backoffice de Cofianza (rutas para administrador y analista).
// ============================================================

import { randomUUID } from 'crypto';
import ExcelJS from 'exceljs';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { fetchAll } from '@/lib/fetchAll';
import { getCalibracion } from '@/lib/calibracion';
import { sumarDiasHabiles } from '@/lib/diasHabiles';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, logAudit } from '@/lib/auditLog';
import { fechaBogota } from '@/modules/contratos/v3/formato';
import { cancelarContratoMigradoPorSistema } from '@/modules/contratos/contrato-workflow.service';
import { cancelarMorasSinCobertura } from '@/modules/moras/moras.service';
import { pctDe, masIva } from '@/modules/estudios/tarifas';
import { gerenciaGeneralIds } from '@/modules/beneficios/beneficios.service';
import { notificarYCorreo, type NotificarUsuarioInput } from '@/modules/notificaciones/notificaciones.service';
import { BUCKET, suspenderMigraciones } from './habilitacion.service';
import { CONTENT_TYPE_XLSX } from './plantilla';
import { tarifaVigenteMigracion, type DatosFila } from './validacion';
import {
  ETIQUETA_ESTADO_MIGRACION,
  MESES_EXPOSICION,
  contarEstados,
  cubre,
  estadoMigracion,
  etiquetaEstado,
  liquidarMes,
  primerDiaMesSiguiente,
  type EstadoMigracion,
} from './cartera.reglas';

const db = (tabla: string) => supabase.from(tabla as string) as ReturnType<typeof supabase.from>;

const hoyBogota = () => fechaBogota(new Date());

type Aviso = Omit<NotificarUsuarioInput, 'userId'>;

// ── Lectura ──

interface ContratoFila {
  id: string;
  numero: string | null;
  estado: string;
  valor_arriendo: number | string | null;
  fecha_firma: string | null;
  fecha_terminacion: string | null;
}

interface FilaCartera {
  id: string;
  lote_id: string;
  inmobiliaria_id: string;
  n_fila: number;
  datos: DatosFila;
  resultado: string;
  motivos: string[];
  advertencias: string[];
  reportable: boolean | null;
  reportable_motivo: string | null;
  tarifa_acta_pct: number | string | null;
  tarifa_pct: number | string | null;
  tarifa_desde: string | null;
  verificacion_individual_en: string | null;
  en_revision: boolean;
  en_revision_motivo: string | null;
  excluido_en: string | null;
  excluido_motivo: string | null;
  contrato: ContratoFila | null;
  lote: { id: string; numero: string; estado: string } | null;
}

const FILA_SELECT =
  'id, lote_id, inmobiliaria_id, n_fila, datos, resultado, motivos, advertencias, reportable, reportable_motivo, ' +
  'tarifa_acta_pct, tarifa_pct, tarifa_desde, verificacion_individual_en, en_revision, en_revision_motivo, excluido_en, excluido_motivo, ' +
  'contrato:contratos(id, numero, estado, valor_arriendo, fecha_firma, fecha_terminacion), lote:migracion_lotes(id, numero, estado)';

async function leerFila(filaId: string): Promise<FilaCartera> {
  const { data, error } = await db('migracion_filas').select(FILA_SELECT).eq('id', filaId).maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.notFound('Contrato migrado no encontrado', 'MIGRACION_FILA_NO_ENCONTRADA');
  return data as unknown as FilaCartera;
}

const estadoDe = (f: FilaCartera): EstadoMigracion =>
  estadoMigracion({ ...f, contrato_estado: f.contrato?.estado ?? null });

/** Las acciones sobre la cartera solo aplican a una fianza activa por migración. */
function exigirActiva(f: FilaCartera): ContratoFila {
  if (f.excluido_en) throw AppError.conflict('Este contrato ya fue excluido de la cobertura.', 'MIGRACION_YA_EXCLUIDA');
  if (f.contrato?.estado !== 'vigente')
    throw AppError.conflict(
      'Este contrato no tiene la fianza activa por migración (aún no se firmó el acta o ya terminó).',
      'MIGRACION_SIN_FIANZA_ACTIVA',
    );
  return f.contrato;
}

/**
 * Auditoría y exclusión (§7.3.1: «en cualquier momento y sobre cualquier
 * contrato migrado»): basta que el contrato exista (vigente o ya finalizado) y
 * no esté excluido.
 */
function exigirMigrado(f: FilaCartera): ContratoFila {
  if (f.excluido_en) throw AppError.conflict('Este contrato ya fue excluido de la cobertura.', 'MIGRACION_YA_EXCLUIDA');
  if (f.contrato?.estado !== 'vigente' && f.contrato?.estado !== 'finalizado')
    throw AppError.conflict(
      'Este contrato no tiene fianza por migración (aún no se firmó el acta o el contrato se canceló).',
      'MIGRACION_SIN_FIANZA_ACTIVA',
    );
  return f.contrato;
}

const arrendatarioDe = (d: DatosFila) =>
  [d.arrendatario.nombre, d.arrendatario.apellido].filter(Boolean).join(' ') || d.arrendatario.razon_social || '';

const canonDe = (f: FilaCartera) => Number(f.contrato?.valor_arriendo ?? f.datos.canon ?? 0);

const describir = (f: FilaCartera) =>
  `el contrato ${f.contrato?.numero ?? `de la fila ${f.n_fila}`} (${f.datos.direccion ?? 'sin dirección'}), migrado en el lote ${f.lote?.numero ?? ''}`;

// ── Avisos (best-effort: nunca tumban la operación) ──

async function avisar(ids: string[], aviso: Aviso): Promise<void> {
  for (const userId of ids)
    await notificarYCorreo({ userId, ...aviso }).catch((e) =>
      logger.warn({ userId, tipo: aviso.tipo, error: e instanceof Error ? e.message : String(e) }, 'Migración: aviso no enviado'),
    );
}

async function titularesDe(inmobiliariaId: string): Promise<string[]> {
  const { data, error } = await db('inmobiliaria_miembros')
    .select('perfil_id')
    .eq('inmobiliaria_id', inmobiliariaId)
    .eq('estado', 'activo')
    .eq('rol_miembro', 'owner')
    .not('perfil_id', 'is', null);
  if (error) {
    logger.warn({ inmobiliariaId, error: error.message }, 'Migración: no se pudieron leer los titulares');
    return [];
  }
  return ((data as { perfil_id: string }[] | null) ?? []).map((m) => m.perfil_id);
}

const avisarTitulares = (inmobiliariaId: string, aviso: Aviso) =>
  titularesDe(inmobiliariaId).then((ids) => avisar(ids, aviso));

const avisarGerencia = (aviso: Aviso) =>
  gerenciaGeneralIds()
    .then((ids) => avisar(ids, aviso))
    .catch((e) => logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Migración: sin Gerencia General a quien avisar'));

/** §8.4: el lote supera el umbral de exposición. Informa, no bloquea. */
export async function avisarExposicionLote(l: {
  id: string;
  numero: string;
  inmobiliaria: string;
  exposicion: number;
  umbral: number;
}): Promise<void> {
  const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
  await avisarGerencia({
    tipo: 'migracion.alerta_exposicion',
    titulo: `Exposición alta en el lote de migración ${l.numero}`,
    mensaje:
      `El lote ${l.numero} de ${l.inmobiliaria} suma una exposición de ${cop(l.exposicion)} (${MESES_EXPOSICION} cánones por contrato aceptado), ` +
      `por encima del umbral de ${cop(l.umbral)}. Es informativo: la carga no se bloqueó.`,
    link: `/admin/migracion/lotes/${l.id}`,
    payload: { lote_id: l.id, exposicion_cop: l.exposicion, umbral_cop: l.umbral },
  });
}

// ── En revisión (§6) ──

export async function marcarRevision(filaId: string, enRevision: boolean, motivo: string | null, usuarioId: string) {
  const f = await leerFila(filaId);
  exigirActiva(f);
  const { error } = await db('migracion_filas')
    .update({ en_revision: enRevision, en_revision_motivo: enRevision ? motivo : null } as never)
    .eq('id', f.id);
  if (error) throw fromSupabaseError(error);
  logAudit({
    usuarioId,
    accion: AUDIT_ACTIONS.MIGRACION_CONTRATO_REVISION,
    entidad: AUDIT_ENTITIES.MIGRACION_FILA,
    entidadId: f.id,
    detalle: { contrato_id: f.contrato!.id, en_revision: enRevision, motivo },
  });
  return detalleFila(f.id);
}

// ── Exclusión de cobertura (§7.2.1-§7.2.2, §7.3.3) ──

export type MotivoExclusion = 'declaracion_falsa' | 'auditoria_no_entregada';

const CAUSA: Record<MotivoExclusion, { corta: string; aviso: string }> = {
  declaracion_falsa: {
    corta: 'Declaración falsa de comportamiento de pago',
    aviso: 'se verificó que la declaración de comportamiento de pago de ese contrato no correspondía a la realidad',
  },
  auditoria_no_entregada: {
    corta: 'Soportes de auditoría no entregados en el plazo',
    aviso: 'no se recibieron dentro del plazo los soportes de recaudo solicitados en la auditoría',
  },
};

/**
 * Exclusión de pleno derecho: el contrato nunca estuvo cubierto. CAS sobre la
 * fila (dos clics = uno excluye) y después vigente → cancelado, que libera el
 * inmueble y la fila. Si la cancelación falla, la fila vuelve a como estaba.
 * Por declaración falsa (no por auditoría no entregada, que no la verifica)
 * suspende además las nuevas migraciones de la inmobiliaria (§7.2.2).
 */
export async function excluirContrato(filaId: string, motivo: MotivoExclusion, nota: string | null, usuarioId: string) {
  const f = await leerFila(filaId);
  const contrato = exigirMigrado(f);
  const { data, error } = await db('migracion_filas')
    .update({ excluido_en: new Date().toISOString(), excluido_motivo: motivo } as never)
    .eq('id', f.id)
    .is('excluido_en', null)
    .select('id');
  if (error) throw fromSupabaseError(error);
  if (!(data as unknown[] | null)?.length)
    throw AppError.conflict('Este contrato ya fue excluido de la cobertura.', 'MIGRACION_YA_EXCLUIDA');

  const revertir = () =>
    db('migracion_filas').update({ excluido_en: null, excluido_motivo: null } as never).eq('id', f.id);
  // Un contrato ya finalizado no se cancela: basta la marca de exclusión.
  if (contrato.estado === 'vigente') {
    let cancelado: boolean;
    try {
      cancelado = await cancelarContratoMigradoPorSistema(contrato.id, nota ? `${CAUSA[motivo].corta}. ${nota}` : CAUSA[motivo].corta, usuarioId);
    } catch (e) {
      await revertir();
      throw e;
    }
    if (!cancelado) {
      await revertir();
      throw AppError.conflict('El contrato cambió de estado mientras tanto. Recargue la página.', 'CONTRATO_ESTADO_CAMBIADO');
    }
  }

  // Tarifa mensual (B5): los meses posteriores a la exclusión no se cobran; lo ya cobrado no se devuelve.
  // Al vigente ya lo revisa la cancelación (aplicarEfectosTerminacion): dos revisiones a la vez repetirían los avisos.
  if (contrato.estado !== 'vigente')
    import('@/modules/tarifa-cobro/tarifa-cobro.gestion.service')
      .then((t) => t.revisarLineasPorTerminacion(contrato.id, usuarioId))
      .catch((e) => logger.warn({ contratoId: contrato.id, error: e instanceof Error ? e.message : String(e) }, 'Migración: tarifa mensual del excluido sin revisar'));

  // §7.2.1: nunca estuvo cubierto, así que sus moras activas no siguen escalando.
  const moras = await cancelarMorasSinCobertura(
    contrato.id,
    'Sin cobertura: contrato excluido de la migración de cartera (§7.2.1).',
    usuarioId,
  ).catch((e) => {
    logger.error({ contratoId: contrato.id, error: e instanceof Error ? e.message : String(e) }, 'Migración: moras del contrato excluido sin cancelar');
    return null;
  });

  logAudit({
    usuarioId,
    accion: AUDIT_ACTIONS.MIGRACION_CONTRATO_EXCLUIDO,
    entidad: AUDIT_ENTITIES.MIGRACION_FILA,
    entidadId: f.id,
    detalle: { contrato_id: contrato.id, contrato_numero: contrato.numero, lote: f.lote?.numero, motivo, nota, moras_canceladas: moras?.canceladas ?? null },
  });

  // §7.2.3: lo que Cofianza ya desembolsó por ese contrato se puede compensar.
  if (moras?.pagadasPorCofianza.length) {
    const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
    const detalle = moras.pagadasPorCofianza.map((p) => `${p.ticket_numero}${p.monto != null ? ` (${cop(p.monto)})` : ''}`).join(', ');
    await avisarGerencia({
      tipo: 'migracion.compensacion',
      titulo: `Desembolsos por un contrato excluido — ${contrato.numero ?? ''}`,
      mensaje:
        `Se excluyó de la cobertura ${describir(f)}. Cofianza ya había pagado moras de ese contrato: ${detalle}. ` +
        'Conforme al convenio de migración, esos valores se pueden compensar contra saldos a favor de la inmobiliaria.',
      link: `/contratos/${contrato.id}`,
      payload: { contrato_id: contrato.id, fila_id: f.id, moras: moras.pagadasPorCofianza },
    });
  }

  let suspendida = false;
  if (motivo === 'declaracion_falsa') {
    const motivoSuspension = `Declaración falsa verificada en el contrato ${contrato.numero ?? f.n_fila} del lote ${f.lote?.numero ?? ''}.`;
    suspendida = await suspenderMigraciones(f.inmobiliaria_id, motivoSuspension);
    if (suspendida) {
      logAudit({
        usuarioId,
        accion: AUDIT_ACTIONS.MIGRACION_SUSPENDIDA,
        entidad: AUDIT_ENTITIES.INMOBILIARIA,
        entidadId: f.inmobiliaria_id,
        detalle: { motivo: motivoSuspension, automatica: true, fila_id: f.id },
      });
      await avisarGerencia({
        tipo: 'migracion.suspendida',
        titulo: 'Migraciones suspendidas por declaración falsa',
        mensaje: `${motivoSuspension} Las nuevas cargas de esa inmobiliaria quedan bloqueadas hasta su decisión.`,
        link: '/admin/migracion',
        payload: { inmobiliaria_id: f.inmobiliaria_id, fila_id: f.id },
      });
    }
  }

  await avisarTitulares(f.inmobiliaria_id, {
    tipo: 'migracion.contrato_excluido',
    titulo: `Contrato ${contrato.numero ?? ''} excluido de la cobertura`,
    mensaje:
      `COFIANZA S.A.S. excluyó de la cobertura de la fianza ${describir(f)}, porque ${CAUSA[motivo].aviso}. ` +
      'Conforme al convenio de migración, ese contrato no estuvo cubierto desde su origen.' +
      (suspendida ? ' Las nuevas migraciones de cartera de su inmobiliaria quedan suspendidas hasta decisión de la Gerencia General.' : ''),
    link: `/contratos/${contrato.id}`,
    payload: { contrato_id: contrato.id, fila_id: f.id, motivo },
  });

  return { ...(await detalleFila(f.id)), inmobiliaria_suspendida: suspendida };
}

// ── Auditorías (§7.3) ──

interface Auditoria {
  id: string;
  fila_id: string;
  vence_en: string;
  respuesta_en: string | null;
  soportes: { storage_key: string; cargado_en: string }[];
  resultado: string | null;
  notas: string | null;
}

async function leerAuditoria(auditoriaId: string): Promise<Auditoria> {
  const { data, error } = await db('migracion_auditorias')
    .select('id, fila_id, vence_en, respuesta_en, soportes, resultado, notas')
    .eq('id', auditoriaId)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.notFound('Auditoría no encontrada', 'AUDITORIA_NO_ENCONTRADA');
  return data as Auditoria;
}

const fechaLarga = (iso: string) =>
  new Date(iso).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'long' });

/** §7.3.1-§7.3.2: requerimiento de soportes con plazo de DIAS_RESPUESTA_AUDITORIA días hábiles. */
export async function requerirAuditoria(filaId: string, notas: string | null, usuarioId: string) {
  const f = await leerFila(filaId);
  const contrato = exigirMigrado(f);
  const cal = await getCalibracion();
  // Hasta el final del último día hábil del plazo, en Bogotá.
  const venceEn = new Date(`${sumarDiasHabiles(hoyBogota(), cal.DIAS_RESPUESTA_AUDITORIA)}T23:59:59-05:00`).toISOString();
  const { data, error } = await db('migracion_auditorias')
    .insert({ fila_id: f.id, requerido_por: usuarioId, vence_en: venceEn, notas } as never)
    .select('id, vence_en')
    .single();
  if (error) {
    if (error.code === '23505')
      throw AppError.conflict('Este contrato ya tiene una auditoría abierta.', 'AUDITORIA_ABIERTA');
    throw fromSupabaseError(error);
  }
  const a = data as { id: string; vence_en: string };
  logAudit({
    usuarioId,
    accion: AUDIT_ACTIONS.MIGRACION_AUDITORIA_REQUERIDA,
    entidad: AUDIT_ENTITIES.MIGRACION_FILA,
    entidadId: f.id,
    detalle: { auditoria_id: a.id, contrato_id: contrato.id, vence_en: a.vence_en },
  });
  await avisarTitulares(f.inmobiliaria_id, {
    tipo: 'migracion.auditoria_requerida',
    titulo: `Solicitud de soportes — contrato ${contrato.numero ?? ''}`,
    mensaje:
      `Conforme al convenio de migración, COFIANZA S.A.S. le solicita los extractos o soportes de recaudo de los ` +
      `${cal.MESES_SIN_MORA_REQUERIDOS} meses anteriores a la migración para ${describir(f)}. ` +
      `El plazo de entrega es de ${cal.DIAS_RESPUESTA_AUDITORIA} días hábiles, hasta el ${fechaLarga(a.vence_en)}. ` +
      'Si no se reciben dentro de ese plazo, el contrato puede quedar excluido de la cobertura.',
    link: `/contratos/${contrato.id}`,
    payload: { auditoria_id: a.id, contrato_id: contrato.id },
  });
  return detalleFila(f.id);
}

/** §7.3.4: la respuesta de la inmobiliaria (soporte en PDF opcional; se pueden cargar varios). */
export async function registrarRespuestaAuditoria(auditoriaId: string, archivo: Buffer | null, notas: string | null, usuarioId: string) {
  const a = await leerAuditoria(auditoriaId);
  if (a.resultado) throw AppError.conflict('Esta auditoría ya tiene resultado.', 'AUDITORIA_YA_DECIDIDA');
  const f = await leerFila(a.fila_id);
  const soportes = [...(a.soportes ?? [])];
  if (archivo) {
    const key = `migracion/${f.inmobiliaria_id}/auditorias/${a.id}/${randomUUID()}.pdf`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(key, archivo, { contentType: 'application/pdf', upsert: false });
    if (upErr) throw new AppError(500, 'STORAGE_ERROR', 'No se pudo guardar el soporte. Intente de nuevo.');
    soportes.push({ storage_key: key, cargado_en: new Date().toISOString() });
  }
  const { error } = await db('migracion_auditorias')
    .update({ respuesta_en: a.respuesta_en ?? new Date().toISOString(), soportes, notas: notas ?? a.notas } as never)
    .eq('id', a.id)
    .is('resultado', null);
  if (error) throw fromSupabaseError(error);
  logAudit({
    usuarioId,
    accion: AUDIT_ACTIONS.MIGRACION_AUDITORIA_RESPUESTA,
    entidad: AUDIT_ENTITIES.MIGRACION_FILA,
    entidadId: f.id,
    detalle: { auditoria_id: a.id, soportes: soportes.length },
  });
  return detalleFila(f.id);
}

export type ResultadoAuditoria = 'conforme' | 'declaracion_falsa' | 'no_entregado';

/**
 * §7.3.3-§7.3.4: resultado de la auditoría. declaracion_falsa y no_entregado
 * excluyen el contrato; no_entregado solo vencido el plazo y sin respuesta.
 * Si la exclusión falla, la auditoría vuelve a quedar abierta.
 */
export async function decidirAuditoria(auditoriaId: string, resultado: ResultadoAuditoria, notas: string | null, usuarioId: string) {
  const a = await leerAuditoria(auditoriaId);
  if (a.resultado) throw AppError.conflict('Esta auditoría ya tiene resultado.', 'AUDITORIA_YA_DECIDIDA');
  if (resultado === 'no_entregado') {
    if (a.respuesta_en)
      throw AppError.conflict('La inmobiliaria ya respondió: califique los soportes como conformes o como declaración falsa.', 'AUDITORIA_CON_RESPUESTA');
    if (Date.now() <= Date.parse(a.vence_en))
      throw AppError.conflict(`El plazo de entrega vence el ${fechaLarga(a.vence_en)}; aún no se puede declarar no entregada.`, 'AUDITORIA_EN_PLAZO');
  }
  if (resultado !== 'conforme') exigirMigrado(await leerFila(a.fila_id));

  const { data, error } = await db('migracion_auditorias')
    .update({ resultado, notas: notas ?? a.notas, decidido_por: usuarioId, decidido_en: new Date().toISOString() } as never)
    .eq('id', a.id)
    .is('resultado', null)
    .select('id');
  if (error) throw fromSupabaseError(error);
  if (!(data as unknown[] | null)?.length) throw AppError.conflict('Esta auditoría ya tiene resultado.', 'AUDITORIA_YA_DECIDIDA');

  logAudit({
    usuarioId,
    accion: AUDIT_ACTIONS.MIGRACION_AUDITORIA_DECIDIDA,
    entidad: AUDIT_ENTITIES.MIGRACION_FILA,
    entidadId: a.fila_id,
    detalle: { auditoria_id: a.id, resultado, notas },
  });

  if (resultado === 'conforme') return detalleFila(a.fila_id);
  try {
    return await excluirContrato(a.fila_id, resultado === 'declaracion_falsa' ? 'declaracion_falsa' : 'auditoria_no_entregada', notas, usuarioId);
  } catch (e) {
    await db('migracion_auditorias')
      .update({ resultado: null, decidido_por: null, decidido_en: null } as never)
      .eq('id', a.id);
    throw e;
  }
}

// ── REPORTABLE (§5.1.3, §5.2.5) ──

export type MotivoReportable = 'autorizacion_arrendatario' | 'verificacion_individual';

/**
 * NO REPORTABLE → REPORTABLE: por autorización voluntaria del arrendatario
 * (§5.2.5) o por verificación individual del contrato firmado sobre un formato
 * anterior (§5.1.3). La tarifa baja a la base desde el primer día del mes
 * siguiente; la del acta (tarifa_acta_pct) no se toca. Va después de la
 * activación: antes, el acta ya generada quedaría distinta de lo activado (§3.8).
 */
export async function pasarAReportable(
  filaId: string,
  input: { motivo: MotivoReportable; fecha?: string | null; notas?: string | null },
  usuarioId: string,
) {
  const f = await leerFila(filaId);
  exigirActiva(f);
  if (f.reportable) throw AppError.conflict('Este contrato ya es REPORTABLE.', 'MIGRACION_YA_REPORTABLE');
  if (input.motivo === 'verificacion_individual' && f.reportable_motivo !== 'formato_anterior')
    throw AppError.conflict(
      'La verificación individual solo aplica a contratos firmados sobre un formato anterior al revisado. Para este contrato registre la autorización del arrendatario.',
      'VERIFICACION_NO_APLICA',
    );
  const hoy = hoyBogota();
  const fecha = input.fecha ?? hoy;
  if (fecha > hoy) throw AppError.badRequest('La fecha de la autorización no puede ser futura.', 'FECHA_FUTURA');

  const cal = await getCalibracion();
  // «La tarifa baja a la base» (§5.2.5): la base congelada con la fila al validar;
  // las filas anteriores a ese campo usan la vigente, sin subir nunca la tarifa.
  const tarifa = Number(f.datos.tarifa_base_pct ?? Math.min(Number(f.tarifa_pct), cal.TARIFA_MIGRACION_REPORTABLE));
  const desde = primerDiaMesSiguiente(fecha);
  const ahora = new Date().toISOString();
  const { data, error } = await db('migracion_filas')
    .update({
      reportable: true,
      reportable_motivo: input.motivo,
      tarifa_pct: tarifa,
      tarifa_desde: desde,
      ...(input.motivo === 'verificacion_individual'
        ? { verificacion_individual_por: usuarioId, verificacion_individual_en: ahora }
        : {}),
    } as never)
    .eq('id', f.id)
    .eq('reportable', false)
    .select('id');
  if (error) throw fromSupabaseError(error);
  if (!(data as unknown[] | null)?.length) throw AppError.conflict('Este contrato ya es REPORTABLE.', 'MIGRACION_YA_REPORTABLE');

  logAudit({
    usuarioId,
    accion: AUDIT_ACTIONS.MIGRACION_CONTRATO_REPORTABLE,
    entidad: AUDIT_ENTITIES.MIGRACION_FILA,
    entidadId: f.id,
    detalle: {
      contrato_id: f.contrato!.id,
      motivo: input.motivo,
      fecha_autorizacion: fecha,
      motivo_anterior: f.reportable_motivo,
      tarifa_anterior_pct: Number(f.tarifa_pct),
      tarifa_pct: tarifa,
      tarifa_desde: desde,
      notas: input.notas ?? null,
    },
  });
  return detalleFila(f.id);
}

// ── Consulta de un contrato migrado ──

export async function detalleFila(filaId: string) {
  const f = await leerFila(filaId);
  const { data, error } = await db('migracion_auditorias')
    .select('id, requerido_en, vence_en, respuesta_en, soportes, resultado, notas, decidido_en')
    .eq('fila_id', f.id)
    .order('requerido_en', { ascending: false });
  if (error) throw fromSupabaseError(error);
  const estado = estadoDe(f);
  return {
    ...f,
    estado,
    estado_etiqueta: etiquetaEstado(estado, f.excluido_motivo),
    tarifa_vigente_pct: f.contrato ? tarifaVigenteMigracion(f, hoyBogota()) : null,
    auditorias: data ?? [],
  };
}

// ── Lotes y tablero (§8) ──

export async function listarLotes(inmobiliariaId?: string) {
  let q = db('migracion_lotes')
    .select(
      'id, numero, estado, inmobiliaria_id, inmobiliaria:inmobiliarias(nombre), total_aceptadas, total_rechazadas, total_advertencias, ' +
        'exposicion_cop, alerta_exposicion_en, vence_en, activado_en, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(200);
  if (inmobiliariaId) q = q.eq('inmobiliaria_id', inmobiliariaId);
  const { data, error } = await q;
  if (error) throw fromSupabaseError(error);
  return data ?? [];
}

interface LoteTablero {
  id: string;
  numero: string;
  estado: string;
  inmobiliaria_id: string;
  inmobiliaria: { nombre: string } | null;
  vence_en: string;
  activado_en: string | null;
  created_at: string;
  total_aceptadas: number;
  total_rechazadas: number;
  total_advertencias: number;
  exposicion_cop: number | string;
  alerta_exposicion_en: string | null;
}

/**
 * §8.1-§8.3: conteo por estado derivado (A4) y detalle. `resumen` es lo que
 * puede ver la inmobiliaria; `cofianza` solo Cofianza (exposición de 18 cánones
 * por contrato activo, tarifa mensual que genera y la relación entre las dos).
 */
export async function tableroLote(loteId: string) {
  const { data: loteRow, error } = await db('migracion_lotes')
    .select(
      'id, numero, estado, inmobiliaria_id, inmobiliaria:inmobiliarias(nombre), vence_en, activado_en, created_at, ' +
        'total_aceptadas, total_rechazadas, total_advertencias, exposicion_cop, alerta_exposicion_en',
    )
    .eq('id', loteId)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!loteRow) throw AppError.notFound('Lote no encontrado', 'LOTE_NO_ENCONTRADO');
  const lote = loteRow as unknown as LoteTablero;

  const filasR = await fetchAll<FilaCartera>((d, h) =>
    db('migracion_filas').select(FILA_SELECT).eq('lote_id', loteId).order('n_fila').range(d, h) as never,
  );
  if (filasR.error) throw fromSupabaseError(filasR.error);
  const [cal, hoy] = [await getCalibracion(), hoyBogota()];

  const filas = filasR.data.map((f) => {
    const estado = estadoDe(f);
    const canon = canonDe(f);
    const pct = cubre(estado) ? tarifaVigenteMigracion(f, hoy) : null;
    return {
      fila_id: f.id,
      n_fila: f.n_fila,
      estado,
      estado_etiqueta: etiquetaEstado(estado, f.excluido_motivo),
      direccion: f.datos.direccion,
      municipio: f.datos.municipio,
      arrendatario: arrendatarioDe(f.datos),
      documento: [f.datos.arrendatario.tipo_documento, f.datos.arrendatario.numero_documento].filter(Boolean).join(' '),
      canon,
      reportable: f.reportable,
      tarifa_pct: pct ?? (f.tarifa_pct != null ? Number(f.tarifa_pct) : null),
      motivos: f.motivos,
      advertencias: f.advertencias,
      en_revision_motivo: f.en_revision_motivo,
      excluido_motivo: f.excluido_motivo,
      contrato_id: f.contrato?.id ?? null,
      contrato_numero: f.contrato?.numero ?? null,
      // Solo Cofianza:
      exposicion_cop: cubre(estado) ? MESES_EXPOSICION * canon : 0,
      tarifa_mensual_cop: pct ? pctDe(canon, pct) ?? 0 : 0,
    };
  });
  const conteos = contarEstados(filas.map((f) => f.estado));
  const exposicion = filas.reduce((s, f) => s + f.exposicion_cop, 0);
  const tarifa = filas.reduce((s, f) => s + f.tarifa_mensual_cop, 0);

  return {
    lote: {
      id: lote.id,
      numero: lote.numero,
      estado: lote.estado,
      inmobiliaria_id: lote.inmobiliaria_id,
      inmobiliaria: lote.inmobiliaria?.nombre ?? null,
      created_at: lote.created_at,
      vence_en: lote.vence_en,
      activado_en: lote.activado_en,
    },
    conteos,
    resumen: {
      total_cargado: filas.length,
      aceptados: lote.total_aceptadas,
      rechazados: lote.total_rechazadas,
      activos: conteos.activa + conteos.en_revision,
    },
    cofianza: {
      exposicion_cop: exposicion,
      // Lo calculado al procesar (todas las aceptadas), antes de la activación.
      exposicion_al_procesar_cop: Number(lote.exposicion_cop),
      tarifa_mensual_cop: tarifa,
      tarifa_mensual_con_iva_cop: masIva(tarifa, cal.TARIFA_IVA),
      // Tarifa mensual sobre exposición, en %.
      relacion_pct: exposicion > 0 ? Math.round((tarifa / exposicion) * 100_000) / 1000 : null,
      umbral_alerta_cop: cal.UMBRAL_ALERTA_EXPOSICION_LOTE,
      alerta_exposicion_en: lote.alerta_exposicion_en,
    },
    filas,
  };
}

// ── Excel ──

interface Hoja {
  nombre: string;
  columnas: { header: string; key: string; width: number }[];
  filas: Record<string, unknown>[];
}

export async function libro(hojas: Hoja[]): Promise<{ buffer: Buffer; contentType: string }> {
  const wb = new ExcelJS.Workbook();
  for (const h of hojas) {
    const ws = wb.addWorksheet(h.nombre, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = h.columnas;
    ws.getRow(1).font = { bold: true };
    for (const f of h.filas) ws.addRow(f);
  }
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), contentType: CONTENT_TYPE_XLSX };
}

const siNo = (b: boolean | null) => (b == null ? '' : b ? 'Sí' : 'No');

/** §8.1: detalle descargable. vista 'inmobiliaria' omite las columnas de Cofianza (§8.3). */
export async function tableroLoteXlsx(loteId: string, vista: 'cofianza' | 'inmobiliaria') {
  const t = await tableroLote(loteId);
  const interno = vista === 'cofianza';
  const resumen: Record<string, unknown>[] = [
    { k: 'Lote', v: t.lote.numero },
    { k: 'Inmobiliaria', v: t.lote.inmobiliaria },
    { k: 'Total cargado', v: t.resumen.total_cargado },
    { k: 'Aceptados', v: t.resumen.aceptados },
    { k: 'Rechazados', v: t.resumen.rechazados },
    { k: 'Activos', v: t.resumen.activos },
    ...(Object.keys(t.conteos) as EstadoMigracion[]).map((e) => ({ k: ETIQUETA_ESTADO_MIGRACION[e], v: t.conteos[e] })),
    ...(interno
      ? [
          { k: 'Exposición acumulada (COP)', v: t.cofianza.exposicion_cop },
          { k: 'Tarifa mensual total sin IVA (COP)', v: t.cofianza.tarifa_mensual_cop },
          { k: 'Tarifa mensual total con IVA (COP)', v: t.cofianza.tarifa_mensual_con_iva_cop },
          { k: 'Relación tarifa / exposición (%)', v: t.cofianza.relacion_pct },
        ]
      : []),
  ];
  return libro([
    { nombre: 'Resumen', columnas: [{ header: 'Concepto', key: 'k', width: 40 }, { header: 'Valor', key: 'v', width: 24 }], filas: resumen },
    {
      nombre: 'Contratos',
      columnas: [
        { header: 'Fila', key: 'n_fila', width: 6 },
        { header: 'Estado', key: 'estado_etiqueta', width: 28 },
        { header: 'Contrato', key: 'contrato_numero', width: 18 },
        { header: 'Dirección', key: 'direccion', width: 40 },
        { header: 'Municipio', key: 'municipio', width: 18 },
        { header: 'Arrendatario', key: 'arrendatario', width: 30 },
        { header: 'Documento', key: 'documento', width: 18 },
        { header: 'Canon sin IVA', key: 'canon', width: 14 },
        { header: 'Reportable', key: 'reportable_txt', width: 11 },
        { header: 'Tarifa mensual (%)', key: 'tarifa_pct', width: 12 },
        { header: 'Motivos de rechazo', key: 'motivos_txt', width: 50 },
        { header: 'Advertencias', key: 'advertencias_txt', width: 50 },
        ...(interno
          ? [
              { header: 'Tarifa mensual sin IVA (COP)', key: 'tarifa_mensual_cop', width: 16 },
              { header: 'Exposición (COP)', key: 'exposicion_cop', width: 16 },
            ]
          : []),
      ],
      filas: t.filas.map((f) => ({
        ...f,
        reportable_txt: siNo(f.reportable),
        motivos_txt: f.motivos.join('\n'),
        advertencias_txt: f.advertencias.join('\n'),
      })),
    },
  ]);
}

// ── §8.5 Contratos sobre formato anterior al revisado ──

export async function reporteSinPlantilla(inmobiliariaId?: string) {
  const r = await fetchAll<FilaCartera & { inmobiliaria: { nombre: string } | null }>((d, h) => {
    let q = db('migracion_filas')
      .select(`${FILA_SELECT}, inmobiliaria:inmobiliarias(nombre)`)
      .neq('resultado', 'rechazada')
      .eq('datos->declaraciones->>plantilla_entregada', 'false')
      .not('contrato_id', 'is', null);
    if (inmobiliariaId) q = q.eq('inmobiliaria_id', inmobiliariaId);
    return q.order('created_at').range(d, h) as never;
  });
  if (r.error) throw fromSupabaseError(r.error);
  return r.data.map((f) => {
    const estado = estadoDe(f);
    return {
      fila_id: f.id,
      inmobiliaria_id: f.inmobiliaria_id,
      inmobiliaria: f.inmobiliaria?.nombre ?? null,
      lote: f.lote?.numero ?? null,
      contrato_id: f.contrato?.id ?? null,
      contrato_numero: f.contrato?.numero ?? null,
      estado,
      estado_etiqueta: etiquetaEstado(estado, f.excluido_motivo),
      direccion: f.datos.direccion,
      arrendatario: arrendatarioDe(f.datos),
      canon: canonDe(f),
      reportable: f.reportable,
      verificacion_individual_en: f.verificacion_individual_en,
      tarifa_vigente_pct: tarifaVigenteMigracion(f, hoyBogota()),
    };
  });
}

export async function reporteSinPlantillaXlsx(inmobiliariaId?: string) {
  const filas = await reporteSinPlantilla(inmobiliariaId);
  return libro([
    {
      nombre: 'Formato anterior',
      columnas: [
        { header: 'Inmobiliaria', key: 'inmobiliaria', width: 30 },
        { header: 'Lote', key: 'lote', width: 14 },
        { header: 'Contrato', key: 'contrato_numero', width: 18 },
        { header: 'Estado', key: 'estado_etiqueta', width: 28 },
        { header: 'Dirección', key: 'direccion', width: 40 },
        { header: 'Arrendatario', key: 'arrendatario', width: 30 },
        { header: 'Canon sin IVA', key: 'canon', width: 14 },
        { header: 'Reportable', key: 'reportable_txt', width: 11 },
        { header: 'Verificación individual', key: 'verificado', width: 20 },
        { header: 'Tarifa vigente (%)', key: 'tarifa_vigente_pct', width: 12 },
      ],
      filas: filas.map((f) => ({
        ...f,
        reportable_txt: siNo(f.reportable),
        verificado: f.verificacion_individual_en ? fechaBogota(f.verificacion_individual_en) : '',
      })),
    },
  ]);
}

// ── Liquidación mensual de la tarifa (§4.2, §4.7, §9.2) ──

/**
 * Tarifa que causa cada contrato migrado en el mes, por inmobiliaria
 * (modalidad Tradicional: la paga la inmobiliaria). Primer mes proporcional a
 * los días (propuesta pendiente de confirmar por la Gerencia, §4.7). Los
 * excluidos no causan tarifa: nunca estuvieron cubiertos (§7.2.1).
 */
export async function liquidacion(mes: string, inmobiliariaId?: string) {
  const { TARIFA_IVA: ivaPct } = await getCalibracion();
  const r = await fetchAll<FilaCartera & { inmobiliaria: { nombre: string } | null }>((d, h) => {
    let q = db('migracion_filas')
      .select(`${FILA_SELECT}, inmobiliaria:inmobiliarias(nombre)`)
      .not('contrato_id', 'is', null)
      .is('excluido_en', null);
    if (inmobiliariaId) q = q.eq('inmobiliaria_id', inmobiliariaId);
    return q.order('id').range(d, h) as never;
  });
  if (r.error) throw fromSupabaseError(r.error);

  const lineas = r.data.flatMap((f) => {
    if (!f.contrato?.fecha_firma) return [];
    const l = liquidarMes(
      {
        canon: canonDe(f),
        tarifa_pct: f.tarifa_pct,
        tarifa_acta_pct: f.tarifa_acta_pct,
        tarifa_desde: f.tarifa_desde,
        activado_en: f.contrato.fecha_firma,
        terminado_en: f.contrato.estado === 'vigente' ? null : f.contrato.fecha_terminacion,
      },
      mes,
      ivaPct,
    );
    if (!l) return [];
    return [
      {
        inmobiliaria_id: f.inmobiliaria_id,
        inmobiliaria: f.inmobiliaria?.nombre ?? '',
        lote: f.lote?.numero ?? '',
        contrato_id: f.contrato.id,
        contrato_numero: f.contrato.numero,
        direccion: f.datos.direccion,
        arrendatario: arrendatarioDe(f.datos),
        canon: canonDe(f),
        activado_en: fechaBogota(f.contrato.fecha_firma),
        reportable: f.reportable,
        ...l,
      },
    ];
  });
  lineas.sort((a, b) => a.inmobiliaria.localeCompare(b.inmobiliaria, 'es') || (a.contrato_numero ?? '').localeCompare(b.contrato_numero ?? ''));

  const porOrg = new Map<string, { inmobiliaria_id: string; inmobiliaria: string; contratos: number; tarifa: number; iva: number; total: number }>();
  for (const l of lineas) {
    const o = porOrg.get(l.inmobiliaria_id) ?? { inmobiliaria_id: l.inmobiliaria_id, inmobiliaria: l.inmobiliaria, contratos: 0, tarifa: 0, iva: 0, total: 0 };
    o.contratos++;
    o.tarifa += l.tarifa;
    o.iva += l.iva;
    o.total += l.total;
    porOrg.set(l.inmobiliaria_id, o);
  }
  return { mes, iva_pct: ivaPct, inmobiliarias: [...porOrg.values()], lineas };
}

export async function liquidacionXlsx(mes: string, inmobiliariaId?: string) {
  const l = await liquidacion(mes, inmobiliariaId);
  return libro([
    {
      nombre: 'Resumen',
      columnas: [
        { header: 'Inmobiliaria', key: 'inmobiliaria', width: 34 },
        { header: 'Contratos', key: 'contratos', width: 10 },
        { header: 'Tarifa sin IVA (COP)', key: 'tarifa', width: 18 },
        { header: `IVA ${l.iva_pct} % (COP)`, key: 'iva', width: 16 },
        { header: 'Total (COP)', key: 'total', width: 18 },
      ],
      filas: l.inmobiliarias,
    },
    {
      nombre: 'Detalle',
      columnas: [
        { header: 'Inmobiliaria', key: 'inmobiliaria', width: 30 },
        { header: 'Lote', key: 'lote', width: 14 },
        { header: 'Contrato', key: 'contrato_numero', width: 18 },
        { header: 'Dirección', key: 'direccion', width: 40 },
        { header: 'Arrendatario', key: 'arrendatario', width: 30 },
        { header: 'Activación', key: 'activado_en', width: 12 },
        { header: 'Reportable', key: 'reportable_txt', width: 11 },
        { header: 'Canon sin IVA', key: 'canon', width: 14 },
        { header: 'Tarifa (%)', key: 'pct', width: 10 },
        { header: 'Días cobrados', key: 'dias', width: 10 },
        { header: 'Días del mes', key: 'dias_mes', width: 10 },
        { header: 'Tarifa sin IVA (COP)', key: 'tarifa', width: 16 },
        { header: 'IVA (COP)', key: 'iva', width: 14 },
        { header: 'Total (COP)', key: 'total', width: 16 },
      ],
      filas: l.lineas.map((x) => ({ ...x, reportable_txt: siNo(x.reportable) })),
    },
  ]);
}

/**
 * Contratos V3 — firma: reconciliación con Auco (Entrega 5, diseño §5-§7).
 *
 * Modelo "pull": el webhook de Auco solo dice QUÉ sobre mirar; la verdad se
 * lee con GET /document (estado) y GET /document/roadmap (fecha de cada
 * firma). Así un webhook falso, repetido, tardío o sin `code` no puede mover
 * un contrato por su cuenta. `reconciliarSobre` es la ÚNICA función que cambia
 * el estado de un sobre; la llaman el webhook, el barrido de respaldo y el
 * botón "Actualizar". Cada paso es idempotente y la escritura que decide va
 * con CAS sobre `updated_at`: si dos procesos reconcilian a la vez, uno gana y
 * el otro no hace nada.
 *
 * Ni el webhook ni el barrido dependen de CONTRATOS_V3_ENABLED: solo leen
 * `contrato_v3_sobres`, que está vacía mientras nadie envíe un V3, y los
 * sobres de QA (enviados con el flag encendido en local) mandan sus webhooks a
 * la API de producción, que igual tiene que reconciliarlos.
 */

import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '@/config';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, logAudit } from '@/lib/auditLog';
import { cancelDocument, getDocumentRoadmap, getDocumentStatus, type AucoRoadmap } from '@/lib/auco';
import { getCalibracion } from '@/lib/calibracion';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { archivarPdfFirmadoEnStorage } from '@/modules/firma/firma.service';
import { bloquearInmuebleOcupado } from '@/modules/inmuebles/inmuebles.service';
import { enviarCorreoNotificacion } from '@/modules/notificaciones/notificaciones.service';
import { listOperators } from '@/modules/users/users.service';
import type { EstadoSobreV3 } from '../asistente.types';
import { fechaBogota } from '../formato';
import {
  AVISO_FIRMA_INCOMPLETA_VERSION,
  actualizarFirmantes,
  decidir,
  fechaHora,
  fechasDeFirma,
  finDelCrc,
  fueraDePlazo,
  plazoDeFirma,
  sobreIdDeCustom,
  textoAvisoFirmaIncompleta,
  ultimaFirma,
  type FirmanteSobre,
  type ParteFirmante,
} from './reglas';

// Estados del contrato como los lee un operador (no el valor interno).
const ETIQUETA_ESTADO: Record<string, string> = {
  borrador: 'en borrador',
  pendiente_firma: 'en firma',
  firma_incompleta: 'con firma incompleta',
  vigente: 'con fianza activa',
  cancelado: 'cancelado',
  finalizado: 'terminado',
};

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;

// ── Lectura ──

export interface Sobre {
  id: string;
  contrato_id: string;
  intento: number;
  estado: EstadoSobreV3;
  auco_code: string | null;
  expira_en: string;
  firmantes: FirmanteSobre[];
  motivo: string | null;
  motivo_detalle: string | null;
  cerrado_en: string | null;
  auco_cancelado_en: string | null;
  aviso_entregado_en: string | null;
  aviso_detalle: Record<string, unknown> | null;
  enviado_por: string | null;
  created_at: string;
  updated_at: string;
}

const COLS_SOBRE =
  'id, contrato_id, intento, estado, auco_code, expira_en, firmantes, motivo, motivo_detalle, cerrado_en, ' +
  'auco_cancelado_en, aviso_entregado_en, aviso_detalle, enviado_por, created_at, updated_at';

function falla(que: string, error: { message: string }): never {
  logger.error({ error: error.message }, `Firma V3: ${que}`);
  throw new Error(`Firma V3: ${que}: ${error.message}`);
}

export async function leerSobre(id: string): Promise<Sobre | null> {
  const { data, error } = await db('contrato_v3_sobres').select(COLS_SOBRE).eq('id', id).maybeSingle();
  if (error) falla('no se pudo leer el sobre', error);
  return (data as unknown as Sobre | null) ?? null;
}

/** El sobre más reciente del contrato (vivo o no). */
export async function ultimoSobre(contratoId: string): Promise<Sobre | null> {
  const { data, error } = await db('contrato_v3_sobres')
    .select(COLS_SOBRE)
    .eq('contrato_id', contratoId)
    .order('intento', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) falla('no se pudo leer el último sobre', error);
  return (data as unknown as Sobre | null) ?? null;
}

const COLS_PARTE =
  'id, rol, orden, nombre, tipo_documento, numero_documento, email, telefono, ' +
  'representante_legal_nombre, representante_legal_tipo_documento, representante_legal_documento';

/** Las partes congeladas del contrato, en orden de firma (V3 §6.5). */
export async function leerPartes(contratoId: string): Promise<ParteFirmante[]> {
  const { data, error } = await db('contrato_partes')
    .select(COLS_PARTE)
    .eq('contrato_id', contratoId)
    .order('orden', { ascending: true });
  if (error) falla('no se pudieron leer las partes', error);
  return (data as unknown as ParteFirmante[] | null) ?? [];
}

interface ContratoCtx {
  id: string;
  estado: string;
  numero: string;
  expediente_id: string;
  fecha_firma: string | null;
  fecha_terminacion: string | null;
  fecha_inicio: string | null;
  duracion_meses: number | null;
  datos_variables: {
    asistente?: { paso2?: { amoblado?: boolean }; paso3?: { fechaEntrega?: string } };
    documento?: {
      entrada?: { inmueble?: { direccion?: string; municipio?: string } };
      snapshot?: { estudio?: { fechaCompletado?: string | null }; crc?: { fechaVencimiento?: string | null } | null };
      final?: { ruta?: 'A' | 'B' };
    };
  } | null;
  inmuebleId: string | null;
  orgId: string | null;
  responsableId: string | null;
  expedienteEstado: string | null;
}

export async function leerContrato(id: string): Promise<ContratoCtx | null> {
  const { data, error } = await db('contratos')
    .select('id, estado, numero, expediente_id, fecha_firma, fecha_terminacion, fecha_inicio, duracion_meses, datos_variables')
    .eq('id', id)
    .maybeSingle();
  if (error) falla('no se pudo leer el contrato', error);
  if (!data) return null;
  const c = data as unknown as Omit<ContratoCtx, 'inmuebleId' | 'orgId' | 'responsableId' | 'expedienteEstado'>;
  // Estricta: sin el expediente no se sabe a quién avisar ni qué inmueble ocupar.
  const { data: exp, error: expError } = await db('expedientes')
    .select('inmueble_id, inmobiliaria_id, miembro_responsable_id, estado')
    .eq('id', c.expediente_id)
    .maybeSingle();
  if (expError) falla('no se pudo leer el estudio del contrato', expError);
  const e = exp as {
    inmueble_id: string | null;
    inmobiliaria_id: string | null;
    miembro_responsable_id: string | null;
    estado?: string | null;
  } | null;
  return {
    ...c,
    inmuebleId: e?.inmueble_id ?? null,
    orgId: e?.inmobiliaria_id ?? null,
    responsableId: e?.miembro_responsable_id ?? null,
    expedienteEstado: e?.estado ?? null,
  };
}

/**
 * La vigencia del CRC que se envió a firma (snapshot congelado): `fin` es su
 * hora exacta de vencimiento, tope del proceso de firma y del reenvío (§11.7.5
 * y Adenda 1, respuesta 10). null = sin fechas.
 */
export async function vigenciaEstudio(c: ContratoCtx): Promise<{ fin: number } | null> {
  const snap = c.datos_variables?.documento?.snapshot;
  const fin = finDelCrc(snap?.crc?.fechaVencimiento, snap?.estudio?.fechaCompletado, (await getCalibracion()).VIGENCIA_CRC_DIAS);
  return fin === null ? null : { fin };
}

const ddmmaaaa = (iso: string) => iso.split('-').reverse().join('/');

// ── Escritura ──

/** CAS: solo escribe si el sobre sigue como se leyó. true = este proceso ganó. */
async function casSobre(s: Sobre, cambios: Partial<Sobre>, estadoEsperado: EstadoSobreV3 = s.estado): Promise<boolean> {
  const { data, error } = await db('contrato_v3_sobres')
    .update(cambios as never)
    .eq('id', s.id)
    .eq('estado', estadoEsperado)
    .eq('updated_at', s.updated_at)
    .select('id');
  if (error) falla('no se pudo actualizar el sobre', error);
  return !!(data as unknown[] | null)?.length;
}

/** transicionar_contrato (matriz V3 en la BD). Si otro proceso ya hizo el cambio, no es error. */
export async function transicionar(
  contratoId: string,
  estado: 'vigente' | 'firma_incompleta' | 'pendiente_firma' | 'cancelado',
  descripcion: string,
  usuarioId: string | null = null,
): Promise<void> {
  const { error } = await (supabase as unknown as {
    rpc: (f: string, a: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  }).rpc('transicionar_contrato', {
    p_contrato_id: contratoId,
    p_nuevo_estado: estado,
    p_descripcion: descripcion,
    p_usuario_id: usuarioId,
    p_comentario: null,
    p_motivo: null,
  });
  if (!error) return;
  const { data } = await db('contratos').select('estado').eq('id', contratoId).maybeSingle();
  if ((data as { estado: string } | null)?.estado === estado) return;
  falla(`no se pudo pasar el contrato a ${estado}`, error);
}

async function timeline(expedienteId: string, descripcion: string, metadata: Record<string, unknown>) {
  const { error } = await db('eventos_timeline').insert({
    expediente_id: expedienteId,
    tipo: 'contrato',
    descripcion,
    usuario_id: null,
    metadata,
  } as never);
  if (error) logger.warn({ error: error.message, expedienteId }, 'Firma V3: no se pudo registrar el evento en el timeline');
}

/**
 * Notificación in-app a varios usuarios en UN solo insert y con el error
 * verificado: la constancia de entrega (§11.7.4) no puede afirmar una entrega
 * que falló (notificarUsuario se traga el error).
 */
async function notificar(
  destinatarios: string[],
  n: { tipo: string; titulo: string; mensaje: string; link: string; payload: Record<string, unknown> },
): Promise<void> {
  if (!destinatarios.length) return;
  const { error } = await db('notificaciones').insert(
    destinatarios.map((userId) => ({ user_id: userId, ...n })) as never,
  );
  if (error) falla('no se pudieron crear las notificaciones', error);
}

/**
 * A quién va el aviso: quien ve el estudio en la inmobiliaria. Los titulares
 * siempre; el resto de miembros solo si la org tiene `miembros_ven_todo`; y el
 * responsable del estudio y quien lo envió, si siguen activos. Lecturas
 * estrictas y lista nunca vacía: la constancia de entrega (§11.7.4) no puede
 * afirmar un aviso que no le llegó a nadie.
 */
async function destinatariosDe(c: ContratoCtx, s: Sobre): Promise<string[]> {
  if (!c.orgId) {
    if (s.enviado_por) return [s.enviado_por];
    throw new Error('Firma V3: el contrato no tiene inmobiliaria ni remitente a quien avisar');
  }
  const [orgR, miembrosR] = await Promise.all([
    db('inmobiliarias').select('miembros_ven_todo').eq('id', c.orgId).maybeSingle(),
    db('inmobiliaria_miembros')
      .select('perfil_id, rol_miembro')
      .eq('inmobiliaria_id', c.orgId)
      .eq('estado', 'activo')
      .not('perfil_id', 'is', null),
  ]);
  if (orgR.error) falla('no se pudo leer la inmobiliaria', orgR.error);
  if (miembrosR.error) falla('no se pudieron leer los miembros de la inmobiliaria', miembrosR.error);
  const venTodo = !!(orgR.data as { miembros_ven_todo?: boolean } | null)?.miembros_ven_todo;
  const miembros = (miembrosR.data as { perfil_id: string; rol_miembro: string }[] | null) ?? [];
  const activos = new Set(miembros.map((m) => m.perfil_id));
  const ids = new Set(miembros.filter((m) => venTodo || m.rol_miembro === 'owner').map((m) => m.perfil_id));
  for (const id of [c.responsableId, s.enviado_por]) if (id && activos.has(id)) ids.add(id);
  if (!ids.size) throw new Error('Firma V3: la inmobiliaria no tiene miembros activos a quien avisar');
  return [...ids];
}

const linkAsistente = (c: ContratoCtx) => `/expedientes/${c.expediente_id}/contrato`;

/** Para avisos de otros módulos (TERMINADO): los destinatarios V3 del contrato, o null si no es V3. */
export async function destinatariosV3(contratoId: string): Promise<string[] | null> {
  try {
    const { data } = await db('contratos').select('destinacion').eq('id', contratoId).maybeSingle();
    if (!(data as { destinacion: string | null } | null)?.destinacion) return null;
    const c = await leerContrato(contratoId);
    if (!c) return null;
    const s = await ultimoSobre(contratoId);
    return await destinatariosDe(c, s ?? ({ enviado_por: null } as Sobre));
  } catch (e) {
    logger.warn({ contratoId, error: e instanceof Error ? e.message : String(e) }, 'Firma V3: sin destinatarios para el aviso');
    return null;
  }
}

// ── Activación (FIANZA ACTIVA) ──

/**
 * Todas las partes firmaron (§11.7.1-11.7.2). Idempotente: sirve también de
 * curación en el barrido (sobre `completo` con el aviso sin entregar).
 * NO cierra el expediente (§12.2: no se cierra sin acta de entrega, E6).
 */
export async function activarContrato(s: Sobre): Promise<void> {
  const c = await leerContrato(s.contrato_id);
  if (!c) return;
  // La fecha de activación (§11.7.2) se escribe solo si el contrato se activa con
  // ESTE sobre: antes de la transición, o al curar una activación a medias.
  const registrarFecha = async (estado: 'pendiente_firma' | 'vigente') => {
    if (!s.cerrado_en || c.fecha_firma) return;
    const { error } = await db('contratos')
      .update({ fecha_firma: s.cerrado_en } as never)
      .eq('id', c.id)
      .eq('estado', estado)
      .is('fecha_firma', null);
    if (error) falla('no se pudo registrar la fecha de activación', error);
  };
  if (c.estado === 'vigente') await registrarFecha('vigente');
  if (c.estado === 'finalizado') {
    // Curación tardía de un contrato que ya se activó y se terminó: no hay nada que avisar.
    await db('contrato_v3_sobres')
      .update({ aviso_entregado_en: new Date().toISOString(), aviso_detalle: { omitido: 'finalizado' } } as never)
      .eq('id', s.id)
      .is('aviso_entregado_en', null);
    return;
  }
  if (c.estado === 'pendiente_firma') {
    await registrarFecha('pendiente_firma');
    await transicionar(
      c.id,
      'vigente',
      `Fianza activa: firmaron todas las partes (Auco ${s.auco_code}; última firma ${s.cerrado_en} UTC)`,
    );
  } else if (c.estado !== 'vigente') {
    // Defensivo: la cancelación marca el sobre antes de ir a Auco, así que
    // esto solo pasa si alguien movió el contrato por fuera del flujo.
    logger.error({ contratoId: c.id, estado: c.estado, sobreId: s.id }, 'Firma V3: Auco completó la firma de un contrato que no está en firma');
    const admins = (await listOperators()).filter((o) => o.rol === 'administrador').map((o) => o.id);
    await notificar(admins, {
      tipo: 'firma.conflicto',
      titulo: `Firma completa en un contrato ${ETIQUETA_ESTADO[c.estado] ?? c.estado}`,
      mensaje: `Auco reporta firmado el contrato ${c.numero}, que en la plataforma está «${ETIQUETA_ESTADO[c.estado] ?? c.estado}». Revísalo.`,
      link: linkAsistente(c),
      payload: { contrato_id: c.id, sobre_id: s.id },
    }).catch((e) => logger.warn({ e }, 'Firma V3: no se pudo avisar el conflicto'));
    await db('contrato_v3_sobres')
      .update({ aviso_entregado_en: new Date().toISOString(), aviso_detalle: { conflicto: c.estado } } as never)
      .eq('id', s.id)
      .is('aviso_entregado_en', null);
    return;
  }

  if (c.inmuebleId) await bloquearInmuebleOcupado(c.inmuebleId);
  // Best-effort: si falla, lo reintentan el barrido y la descarga perezosa.
  await archivarPdfFirmadoEnStorage(c.id).catch((e) =>
    logger.warn({ contratoId: c.id, error: e instanceof Error ? e.message : String(e) }, 'Firma V3: PDF firmado sin archivar todavía'),
  );

  const fecha = s.cerrado_en ? ddmmaaaa(fechaBogota(s.cerrado_en)) : null;
  const destinatarios = await destinatariosDe(c, s);
  const titulo = `Fianza activa — contrato ${c.numero}`;
  const mensaje =
    `Firmaron todas las partes${fecha ? ` (última firma el ${fecha})` : ''}. La fianza de COFIANZA S.A.S. está activa. ` +
    'Falta cargar el acta de entrega e inventario: sin ella no se puede cerrar el estudio.';
  await notificar(destinatarios, {
    tipo: 'contrato.fianza_activa',
    titulo,
    mensaje,
    link: linkAsistente(c),
    payload: { contrato_id: c.id, sobre_id: s.id },
  });
  await timeline(c.expediente_id, `${titulo}. ${mensaje}`, { contrato_id: c.id, sobre_id: s.id, estado: 'vigente' });
  // §12.1: queda registrado que el acta está pendiente (la alerta y "Requieren mi acción" lo derivan del archivo).
  await timeline(c.expediente_id, `Acta de entrega e inventario pendiente — contrato ${c.numero}`, { contrato_id: c.id, acta: 'pendiente' });
  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.FIRMA_COMPLETADA,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: c.id,
    detalle: { v3: true, auco_code: s.auco_code, fecha_activacion: s.cerrado_en, intento: s.intento },
  });
  await db('contrato_v3_sobres')
    .update({ aviso_entregado_en: new Date().toISOString(), aviso_detalle: { destinatarios } } as never)
    .eq('id', s.id)
    .is('aviso_entregado_en', null);
}

// ── FIRMA INCOMPLETA ──

/**
 * El proceso venció o lo rechazaron (§11.3). Pasa el contrato a FIRMA
 * INCOMPLETA y entrega el aviso explícito de §11.7.4 con constancia: el texto
 * exacto, su versión y a quién se entregó quedan en el sobre. Idempotente.
 */
export async function cerrarIncompleto(s: Sobre): Promise<void> {
  // Un sobre viejo (curación tardía) no toca un contrato que ya se reenvió: el
  // sobre vigente es el que manda. Se deja constancia para que el barrido no insista.
  const ultimo = await ultimoSobre(s.contrato_id);
  if (ultimo && ultimo.id !== s.id) {
    await db('contrato_v3_sobres')
      .update({ aviso_entregado_en: new Date().toISOString(), aviso_detalle: { omitido: 'superado', por: ultimo.id } } as never)
      .eq('id', s.id)
      .is('aviso_entregado_en', null);
    return;
  }
  const c = await leerContrato(s.contrato_id);
  if (!c) return;
  const motivo = s.motivo === 'EXPIRED' || s.motivo === 'FUERA_PLAZO' ? s.motivo : 'REJECTED';
  if (c.estado === 'pendiente_firma')
    await transicionar(c.id, 'firma_incompleta', `Firma incompleta: ${motivo}${s.motivo_detalle ? ` — ${s.motivo_detalle}` : ''}`);
  const { data } = await db('contratos').select('estado').eq('id', c.id).maybeSingle();
  const estado = (data as { estado: string } | null)?.estado ?? c.estado;
  if (estado !== 'firma_incompleta') {
    // Cancelado u otro: no hay fianza que avisar. Se deja constancia para que el barrido no insista.
    await db('contrato_v3_sobres')
      .update({ aviso_entregado_en: new Date().toISOString(), aviso_detalle: { omitido: estado } } as never)
      .eq('id', s.id)
      .is('aviso_entregado_en', null);
    return;
  }

  // §11.7.3: sin fianza operando no se cobra garantía ni primer canon. Un link
  // creado EN FIRMA (ahí sí se permite) seguiría pagable desde el correo y
  // facturaría ante la DIAN: se anula aquí, también en los reintentos del
  // barrido. Nunca lanza. Si se reenvía y se firma, se genera de nuevo.
  await (await import('@/modules/pagos/pagos.service')).cancelarPagosPendientesDeExpediente(
    c.expediente_id,
    'Firma incompleta: la fianza no está operando',
    ['garantia', 'primer_canon'],
  );

  const [vig, cal] = await Promise.all([vigenciaEstudio(c), getCalibracion()]);
  // Solo se ofrece reenviar si al CRC le alcanza para un proceso nuevo (Adenda 1, respuesta 10).
  const reabrible = !!vig && !('motivo' in plazoDeFirma(Date.now(), cal.DIAS_EXPIRACION_FIRMA, vig.fin));
  const texto = textoAvisoFirmaIncompleta({
    numero: c.numero,
    direccion: c.datos_variables?.documento?.entrada?.inmueble?.direccion ?? 'inmueble del estudio',
    motivo,
    detalle: s.motivo_detalle,
    crcVigenteHasta: reabrible ? fechaHora(vig.fin) : null,
  });
  const destinatarios = await destinatariosDe(c, s);
  const aviso = {
    tipo: 'contrato.firma_incompleta',
    titulo: `Firma incompleta — la fianza NO está operando (${c.numero})`,
    mensaje: texto,
    link: linkAsistente(c),
    payload: { contrato_id: c.id, sobre_id: s.id, texto_version: AVISO_FIRMA_INCOMPLETA_VERSION },
  };
  await notificar(destinatarios, aviso); // si falla, lanza: aviso_entregado_en queda NULL y el barrido reintenta
  for (const userId of destinatarios) await enviarCorreoNotificacion({ userId, ...aviso });
  await timeline(c.expediente_id, `${aviso.titulo}. ${texto}`, { contrato_id: c.id, sobre_id: s.id, estado: 'firma_incompleta' });
  // ponytail: si el proceso cae entre el insert y este UPDATE, el barrido repite el aviso (duplicado inocuo).
  await db('contrato_v3_sobres')
    .update({
      aviso_entregado_en: new Date().toISOString(),
      aviso_detalle: { texto_version: AVISO_FIRMA_INCOMPLETA_VERSION, texto, destinatarios },
    } as never)
    .eq('id', s.id)
    .is('aviso_entregado_en', null);
}

// ── Reconciliación ──

const hace = (iso: string, minutos: number) => Date.now() - Date.parse(iso) > minutos * 60_000;

/**
 * Anula el proceso en Auco y deja la marca. Si Auco no lo cancela porque ya está
 * cerrado (vencido o rechazado) también se marca, para que el barrido no lo
 * intente para siempre; si ya lo firmaron todos, avisa a los administradores,
 * salvo `siFirmado: 'decidir'` (al vencer el plazo): ahí la última firma le ganó
 * a la anulación, no es un conflicto, y la hora de esa firma decide (fueraDePlazo).
 * Cualquier otro error se propaga: el barrido reintenta.
 */
export async function cancelarEnAuco(
  s: Sobre,
  code: string,
  motivo: string,
  o: { siFirmado?: 'alertar' | 'decidir' } = {},
): Promise<'anulado' | 'firmado'> {
  if (!s.auco_code) {
    const { error } = await db('contrato_v3_sobres').update({ auco_code: code } as never).eq('id', s.id).is('auco_code', null);
    if (error) falla('no se pudo registrar el código de Auco del sobre', error);
  }
  const marcar = (detalle?: string) =>
    db('contrato_v3_sobres')
      .update({ auco_cancelado_en: new Date().toISOString(), ...(detalle ? { motivo_detalle: detalle } : {}) } as never)
      .eq('id', s.id);
  try {
    const r = await cancelDocument(code, { message: motivo, email: env.AUCO_SENDER_EMAIL });
    if (r?.success === false || (r?.errors?.cant ?? 0) > 0) throw new Error('Auco respondió que no canceló el proceso');
  } catch (e) {
    const info = await getDocumentStatus(code).catch(() => null);
    if (info?.status === 'FINISH' && o.siFirmado === 'decidir') {
      logger.info({ sobreId: s.id, code }, 'Firma V3: la última firma llegó mientras se anulaba por vencimiento; decide su hora');
      return 'firmado';
    }
    if (info?.status === 'FINISH') {
      logger.error({ sobreId: s.id, code }, 'Firma V3: un proceso que se debía anular quedó firmado en Auco');
      const admins = (await listOperators()).filter((o) => o.rol === 'administrador').map((o) => o.id);
      await notificar(admins, {
        tipo: 'firma.conflicto',
        titulo: 'Proceso de firma completo que se debía anular',
        mensaje: `Auco reporta firmado por todas las partes el proceso ${code}, que Cofianza había anulado. Revísalo.`,
        link: `/contratos/${s.contrato_id}`,
        payload: { contrato_id: s.contrato_id, sobre_id: s.id },
      }).catch((err) => logger.warn({ err }, 'Firma V3: no se pudo avisar el conflicto'));
      await marcar('Auco lo reporta firmado: no se pudo anular.');
      return 'firmado';
    }
    if (info?.status !== 'REJECTED' && info?.status !== 'EXPIRED') throw e;
  }
  await marcar();
  return 'anulado';
}

/** Bloqueos nuevos (3 OTP fallidos): Cofianza desbloquea en el panel de Auco. */
async function avisarBloqueados(antes: FirmanteSobre[], despues: FirmanteSobre[], s: Sobre) {
  const nuevos = despues.filter((f, i) => f.estado === 'bloqueado' && antes[i]?.estado !== 'bloqueado');
  if (!nuevos.length) return;
  const operadores = (await listOperators()).map((o) => o.id);
  await notificar(operadores, {
    tipo: 'firma.bloqueada',
    titulo: 'Firmante bloqueado en Auco',
    mensaje: `Un firmante del proceso ${s.auco_code} quedó bloqueado tras varios intentos fallidos. Desbloquéalo en el panel de Auco para que la firma siga.`,
    link: `/contratos/${s.contrato_id}`,
    payload: { contrato_id: s.contrato_id, sobre_id: s.id },
  }).catch((e) => logger.warn({ e }, 'Firma V3: no se pudo avisar el bloqueo'));
}

/**
 * La única función que cambia el estado de un sobre. `evento` es lo que trajo
 * el webhook (si vino de ahí): solo se usa para adoptar un proceso que Auco
 * creó y nosotros no alcanzamos a registrar, y como detalle del rechazo.
 */
export async function reconciliarSobre(sobreId: string, evento?: { code?: string; message?: string }): Promise<void> {
  let s = await leerSobre(sobreId);
  if (!s) return;

  // 1. Proceso que Auco sí creó y no quedó registrado (timeout o caída tras el
  // upload). El `code` del webhook no se cree: se adopta (o anula) solo si Auco
  // confirma que ese proceso lleva en `custom` el id de ESTE sobre.
  if (!s.auco_code && evento?.code) {
    const info = await getDocumentStatus(evento.code).catch(() => null);
    if (info && sobreIdDeCustom(info.custom) === s.id) {
      if (s.estado === 'creando') await casSobre(s, { auco_code: evento.code, estado: 'en_firma' });
      else if (s.estado === 'fallido' || s.estado === 'cancelado')
        await cancelarEnAuco(s, evento.code, 'Proceso anulado: el envío no quedó registrado en Cofianza');
    } else {
      logger.warn({ sobreId, code: evento.code }, 'Firma V3: el proceso del webhook no es de este sobre (o Auco no lo confirmó); no se adopta');
    }
    s = await leerSobre(sobreId);
    if (!s) return;
  }

  // 2. Curación de lo que quedó a medias. ponytail: sin exclusión entre procesos;
  // si el webhook y el barrido curan el mismo sobre a la vez, el aviso puede salir
  // dos veces (la transición no: la RPC es la exclusión). Un marcador con
  // vencimiento lo evitaría si llega a pasar.
  if (s.estado === 'completo' && !s.aviso_entregado_en) return activarContrato(s);
  if (s.estado === 'incompleto' && !s.aviso_entregado_en) return cerrarIncompleto(s);
  // También 'fallido': un proceso huérfano que Auco sí creó y cuya primera
  // anulación falló (el sobre ya tiene su code, así que el paso 1 no vuelve).
  if ((s.estado === 'cancelado' || s.estado === 'fallido') && s.auco_code && !s.auco_cancelado_en) {
    if (hace(s.updated_at, 10))
      await cancelarEnAuco(
        s,
        s.auco_code,
        s.estado === 'fallido' ? 'Proceso anulado: el envío no quedó registrado en Cofianza' : 'Contrato cancelado por la inmobiliaria',
      );
    return;
  }
  if (s.estado === 'creando' && hace(s.created_at, 30)) {
    // Nadie lo creó en Auco (o se perdió el aviso): queda fallido y el contrato se puede reintentar.
    if (await casSobre(s, { estado: 'fallido', motivo: 'HUERFANO', motivo_detalle: 'El envío a Auco no se confirmó en 30 minutos.' }))
      logger.warn({ sobreId }, 'Firma V3: sobre huérfano marcado como fallido');
    return;
  }
  if (s.estado !== 'en_firma' || !s.auco_code) return;

  // 3. La verdad la tiene Auco.
  const info = await getDocumentStatus(s.auco_code);
  const partes = await leerPartes(s.contrato_id);
  let firmantes = actualizarFirmantes(s.firmantes, partes, info.signProfile);
  const d = decidir(info, firmantes);
  if (d === 'nada' && Date.parse(s.expira_en) < Date.now()) return cerrarPorVencimiento(s, firmantes);
  let roadmap: AucoRoadmap | null = null;
  if (d === 'activar' || firmantes.some((f) => f.estado === 'firmado' && !f.firmadoEn)) {
    roadmap = await getDocumentRoadmap(s.auco_code).catch((e) => {
      logger.warn({ sobreId, error: e instanceof Error ? e.message : String(e) }, 'Firma V3: roadmap no disponible');
      return null;
    });
    if (roadmap) firmantes = fechasDeFirma(firmantes, partes, roadmap);
  }
  const fecha = d === 'activar' && roadmap ? ultimaFirma(roadmap, firmantes.length) : null;
  if (d === 'activar' && !fecha) logger.warn({ sobreId }, 'Firma V3: FINISH sin todas las firmas en el roadmap; se reintenta');
  // Adenda 1, respuesta 10: una firma después del plazo (o del CRC) no activa la fianza.
  const tarde = !!fecha && fueraDePlazo(fecha, s.expira_en, await finDelCrcDelContrato(s.contrato_id));
  if (tarde) logger.warn({ sobreId, fecha, expira: s.expira_en }, 'Firma V3: la última firma llegó fuera del plazo; no se activa');

  const rechazo = firmantes.find((f) => f.estado === 'rechazado');
  const quien = rechazo ? partes.find((p) => p.id === rechazo.parteId)?.rol : null;
  const cambio: Partial<Sobre> =
    d === 'activar' && fecha
      ? tarde
        ? {
            estado: 'incompleto',
            cerrado_en: new Date().toISOString(),
            motivo: 'FUERA_PLAZO',
            motivo_detalle: `la última firma fue el ${fechaHora(Date.parse(fecha))} y el plazo vencía el ${fechaHora(Date.parse(s.expira_en))}`,
          }
        : { estado: 'completo', cerrado_en: fecha }
      : d === 'incompleta'
        ? {
            estado: 'incompleto',
            cerrado_en: new Date().toISOString(),
            motivo: info.status === 'EXPIRED' ? 'EXPIRED' : 'REJECTED',
            motivo_detalle: (evento?.message || (quien ? `el ${quien}` : null))?.slice(0, 500) ?? null,
          }
        : {};
  if (!Object.keys(cambio).length && JSON.stringify(firmantes) === JSON.stringify(s.firmantes)) return;

  if (!(await casSobre(s, { firmantes, ...cambio }, 'en_firma'))) return; // otro proceso ganó: él hace los efectos
  await avisarBloqueados(s.firmantes, firmantes, s);
  const nuevo = { ...s, firmantes, ...cambio };
  if (cambio.estado === 'completo') return activarContrato(nuevo);
  if (cambio.estado === 'incompleto') return cerrarIncompleto(nuevo);
}

/** El fin del CRC del contrato del sobre (null = sin fechas). */
async function finDelCrcDelContrato(contratoId: string): Promise<number | null> {
  const c = await leerContrato(contratoId);
  return c ? ((await vigenciaEstudio(c))?.fin ?? null) : null;
}

/**
 * El plazo de firma lo cierra Cofianza (§11.3 y Adenda 1, respuesta 10): Auco
 * no deja mover el vencimiento de un proceso vivo, así que allá vence lo máximo
 * con la prórroga y aquí manda expira_en. Vencido, se anula primero en Auco y
 * después queda FIRMA INCOMPLETA, con su aviso. Si la última firma le ganó a la
 * anulación, el próximo reconciliar decide por su hora: dentro de la
 * tolerancia activa; después, FIRMA INCOMPLETA por firma fuera de plazo.
 */
async function cerrarPorVencimiento(s: Sobre, firmantes: FirmanteSobre[]): Promise<void> {
  const code = s.auco_code!;
  // Si Auco no responde, lanza: reintenta el barrido.
  if ((await cancelarEnAuco(s, code, 'Venció el plazo para firmar', { siFirmado: 'decidir' })) === 'firmado') return;
  if ((await getDocumentStatus(code).catch(() => null))?.status === 'FINISH') return;
  // cancelarEnAuco deja constancia en el sobre (cambia updated_at): el CAS va sobre lo recién leído.
  const actual = await leerSobre(s.id);
  if (actual?.estado !== 'en_firma') return;
  const cambio: Partial<Sobre> = { estado: 'incompleto', cerrado_en: new Date().toISOString(), motivo: 'EXPIRED', motivo_detalle: null };
  if (!(await casSobre(actual, { firmantes, ...cambio }, 'en_firma'))) return;
  logger.warn({ sobreId: s.id }, 'Firma V3: plazo vencido sin aviso de Auco; se cerró como firma incompleta');
  return cerrarIncompleto({ ...actual, firmantes, ...cambio });
}

// ── Webhook ──

/** El sobre al que se refiere un evento de Auco: por `code` o, si no viene, por `custom`. */
export async function sobreDelEvento(body: { code?: unknown; custom?: unknown } | undefined): Promise<{ id: string } | null> {
  const code = typeof body?.code === 'string' ? body.code : null;
  if (code) {
    const { data, error } = await db('contrato_v3_sobres').select('id').eq('auco_code', code).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data as { id: string };
  }
  const id = sobreIdDeCustom(body?.custom);
  if (!id) return null;
  const { data, error } = await db('contrato_v3_sobres').select('id').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { id: string } | null) ?? null;
}

function secretoValido(req: Request): boolean {
  const secreto = env.AUCO_WEBHOOK_SECRET;
  if (!secreto) return true; // misma semántica que el webhook anterior (firma.controller)
  const recibido = Buffer.from(String(req.headers.authorization ?? req.headers['x-webhook-secret'] ?? ''));
  const esperado = Buffer.from(secreto);
  return recibido.length === esperado.length && timingSafeEqual(recibido, esperado);
}

/**
 * Se monta ANTES del router del webhook anterior (app.ts): si el evento no es
 * de un sobre V3, `next()` y el flujo anterior sigue exactamente igual. Si lo
 * es, responde 200 enseguida (Auco corta a los 10 s y reintenta solo 3 veces)
 * y reconcilia después.
 */
export async function webhookAucoV3(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method !== 'POST') return next();
  // Sin secreto válido ni se consulta la base: el flujo anterior responde su 401.
  if (!secretoValido(req)) return next();
  let sobre: { id: string } | null = null;
  try {
    sobre = await sobreDelEvento(req.body);
  } catch {
    return next(); // BD caída o tabla sin migrar: decide el flujo anterior
  }
  if (!sobre) return next();
  res.status(200).json({ received: true });
  const body = (req.body ?? {}) as { code?: unknown; status?: unknown; message?: unknown; custom?: unknown };
  logger.info(
    { sobreId: sobre.id, status: body.status, conCode: typeof body.code === 'string', customTipo: Array.isArray(body.custom) ? 'array' : typeof body.custom },
    'Auco webhook V3',
  );
  const evento = {
    code: typeof body.code === 'string' ? body.code : undefined,
    // El motivo del rechazo termina en avisos y correos de Cofianza: solo se toma
    // de un webhook autenticado; sin secreto configurado, sale de Auco ("rechazó …").
    message: env.AUCO_WEBHOOK_SECRET && typeof body.message === 'string' ? body.message : undefined,
  };
  programarReconciliacion(sobre.id, evento);
}

/**
 * Un solo reconciliar por sobre cada RETARDO_MS, con el último evento: una
 * ráfaga de webhooks (reales o no) no multiplica las llamadas a Auco, y el
 * último evento nunca se pierde.
 */
const RETARDO_MS = 3000;
const programados = new Map<string, { code?: string; message?: string }>();
function programarReconciliacion(id: string, evento: { code?: string; message?: string }) {
  const yaProgramado = programados.has(id);
  programados.set(id, evento);
  if (yaProgramado) return;
  setTimeout(() => {
    const ultimo = programados.get(id);
    programados.delete(id);
    reconciliarSobre(id, ultimo).catch((e) =>
      logger.error({ sobreId: id, error: e instanceof Error ? e.message : String(e) }, 'Auco webhook V3: reconciliación fallida (la retoma el barrido)'),
    );
  }, RETARDO_MS).unref();
}

// ── Barrido de respaldo ──

/**
 * Cada 15 min (server.ts): recupera webhooks perdidos (vencimientos, rechazos,
 * firmas), procesos que un redeploy cortó a medias, avisos sin entregar,
 * cancelaciones sin confirmar en Auco y PDFs firmados sin archivar.
 */
export async function barrerFirmasV3(): Promise<void> {
  const { data, error } = await db('contrato_v3_sobres')
    .select('id')
    .or(
      'estado.in.(creando,en_firma),' +
        'and(estado.in.(completo,incompleto),aviso_entregado_en.is.null),' +
        'and(estado.in.(cancelado,fallido),auco_code.not.is.null,auco_cancelado_en.is.null)',
    )
    .order('updated_at', { ascending: true })
    .limit(50);
  if (error) {
    logger.warn({ error: error.message }, 'barrerFirmasV3: no se pudieron leer los sobres');
    return;
  }
  for (const { id } of (data as { id: string }[] | null) ?? []) {
    await reconciliarSobre(id).catch((e) =>
      logger.warn({ sobreId: id, error: e instanceof Error ? e.message : String(e) }, 'barrerFirmasV3: sobre sin reconciliar'),
    );
  }

  const { data: sinPdf } = await db('contratos')
    .select('id')
    .not('destinacion', 'is', null)
    .in('estado', ['vigente', 'finalizado'])
    .is('storage_key_firmado', null)
    .limit(20);
  for (const { id } of (sinPdf as { id: string }[] | null) ?? []) {
    await archivarPdfFirmadoEnStorage(id).catch(() => undefined);
  }
}

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
import { resolveOrgMemberPerfilIds } from '@/lib/tenantScope';
import { archivarPdfFirmadoEnStorage } from '@/modules/firma/firma.service';
import { bloquearInmuebleOcupado } from '@/modules/inmuebles/inmuebles.service';
import { enviarCorreoNotificacion } from '@/modules/notificaciones/notificaciones.service';
import { listOperators } from '@/modules/users/users.service';
import { diasCalendario, masDias } from '../asistente.reglas';
import type { EstadoSobreV3 } from '../asistente.types';
import { fechaBogota } from '../formato';
import {
  AVISO_FIRMA_INCOMPLETA_VERSION,
  actualizarFirmantes,
  decidir,
  fechasDeFirma,
  sobreIdDeCustom,
  textoAvisoFirmaIncompleta,
  ultimaFirma,
  type FirmanteSobre,
  type ParteFirmante,
} from './reglas';

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
  datos_variables: {
    documento?: {
      entrada?: { inmueble?: { direccion?: string } };
      snapshot?: { estudio?: { fechaCompletado?: string | null } };
      final?: { ruta?: 'A' | 'B' };
    };
  } | null;
  inmuebleId: string | null;
  orgId: string | null;
}

export async function leerContrato(id: string): Promise<ContratoCtx | null> {
  const { data, error } = await db('contratos')
    .select('id, estado, numero, expediente_id, fecha_firma, datos_variables')
    .eq('id', id)
    .maybeSingle();
  if (error) falla('no se pudo leer el contrato', error);
  if (!data) return null;
  const c = data as unknown as Omit<ContratoCtx, 'inmuebleId' | 'orgId'>;
  const { data: exp } = await db('expedientes')
    .select('inmueble_id, inmobiliaria_id')
    .eq('id', c.expediente_id)
    .maybeSingle();
  const e = exp as { inmueble_id: string | null; inmobiliaria_id: string | null } | null;
  return { ...c, inmuebleId: e?.inmueble_id ?? null, orgId: e?.inmobiliaria_id ?? null };
}

/**
 * Hasta cuándo se puede reenviar a firma (§11.7.5): la vigencia del estudio,
 * con la misma regla que bloquea el asistente (ESTUDIO_VENCIDO, asistente.reglas).
 * Se toma del snapshot congelado al enviar. null = sin fecha: no se puede.
 */
export async function vigenciaEstudio(c: ContratoCtx): Promise<{ hasta: string; vigente: boolean } | null> {
  const completado = c.datos_variables?.documento?.snapshot?.estudio?.fechaCompletado;
  if (!completado) return null;
  const cal = await getCalibracion();
  const desde = fechaBogota(completado);
  const hoy = fechaBogota(new Date());
  return { hasta: masDias(desde, cal.VIGENCIA_CRC_DIAS), vigente: diasCalendario(desde, hoy) <= cal.VIGENCIA_CRC_DIAS };
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

async function destinatariosDe(c: ContratoCtx, s: Sobre): Promise<string[]> {
  const miembros = c.orgId ? await resolveOrgMemberPerfilIds(c.orgId) : [];
  const todos = new Set([...miembros, ...(s.enviado_por ? [s.enviado_por] : [])]);
  return [...todos];
}

const linkAsistente = (c: ContratoCtx) => `/expedientes/${c.expediente_id}/contrato`;

// ── Activación (FIANZA ACTIVA) ──

/**
 * Todas las partes firmaron (§11.7.1-11.7.2). Idempotente: sirve también de
 * curación en el barrido (sobre `completo` con el aviso sin entregar).
 * NO cierra el expediente (§12.2: no se cierra sin acta de entrega, E6).
 */
export async function activarContrato(s: Sobre): Promise<void> {
  const c = await leerContrato(s.contrato_id);
  if (!c) return;
  if (s.cerrado_en && !c.fecha_firma) {
    const { error } = await db('contratos').update({ fecha_firma: s.cerrado_en } as never).eq('id', c.id).is('fecha_firma', null);
    if (error) falla('no se pudo registrar la fecha de activación', error);
  }
  if (c.estado === 'pendiente_firma') {
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
      titulo: `Firma completa en un contrato ${c.estado}`,
      mensaje: `Auco reporta firmado el contrato ${c.numero}, que en la plataforma está en «${c.estado}». Revísalo.`,
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
  const mensaje = `Firmaron todas las partes${fecha ? ` (última firma el ${fecha})` : ''}. La fianza de COFIANZA S.A.S. está activa.`;
  await notificar(destinatarios, {
    tipo: 'contrato.fianza_activa',
    titulo,
    mensaje,
    link: linkAsistente(c),
    payload: { contrato_id: c.id, sobre_id: s.id },
  });
  await timeline(c.expediente_id, `${titulo}. ${mensaje}`, { contrato_id: c.id, sobre_id: s.id, estado: 'vigente' });
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
  const c = await leerContrato(s.contrato_id);
  if (!c) return;
  const motivo = s.motivo === 'EXPIRED' ? 'EXPIRED' : 'REJECTED';
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

  const vig = await vigenciaEstudio(c);
  const texto = textoAvisoFirmaIncompleta({
    numero: c.numero,
    direccion: c.datos_variables?.documento?.entrada?.inmueble?.direccion ?? 'inmueble del estudio',
    motivo,
    detalle: s.motivo_detalle,
    crcVigenteHasta: vig?.vigente ? ddmmaaaa(vig.hasta) : null,
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

async function cancelarEnAuco(s: Sobre, code: string, motivo: string): Promise<void> {
  if (!s.auco_code) await db('contrato_v3_sobres').update({ auco_code: code } as never).eq('id', s.id).is('auco_code', null);
  await cancelDocument(code, { message: motivo, email: env.AUCO_SENDER_EMAIL });
  await db('contrato_v3_sobres').update({ auco_cancelado_en: new Date().toISOString() } as never).eq('id', s.id);
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
    link: '/contratos',
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

  // 1. Proceso que Auco sí creó y no quedó registrado (timeout o caída tras el upload).
  if (!s.auco_code && evento?.code) {
    if (s.estado === 'creando') await casSobre(s, { auco_code: evento.code, estado: 'en_firma' });
    else if (s.estado === 'fallido' || s.estado === 'cancelado')
      await cancelarEnAuco(s, evento.code, 'Proceso anulado: el envío no quedó registrado en Cofianza');
    s = await leerSobre(sobreId);
    if (!s) return;
  }

  // 2. Curación de lo que quedó a medias.
  if (s.estado === 'completo' && !s.aviso_entregado_en) return activarContrato(s);
  if (s.estado === 'incompleto' && !s.aviso_entregado_en) return cerrarIncompleto(s);
  if (s.estado === 'cancelado' && s.auco_code && !s.auco_cancelado_en) {
    if (hace(s.updated_at, 10)) await cancelarEnAuco(s, s.auco_code, 'Contrato cancelado por la inmobiliaria');
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

  const rechazo = firmantes.find((f) => f.estado === 'rechazado');
  const quien = rechazo ? partes.find((p) => p.id === rechazo.parteId)?.rol : null;
  const cambio: Partial<Sobre> =
    d === 'activar' && fecha
      ? { estado: 'completo', cerrado_en: fecha }
      : d === 'incompleta'
        ? {
            estado: 'incompleto',
            cerrado_en: new Date().toISOString(),
            motivo: info.status === 'EXPIRED' ? 'EXPIRED' : 'REJECTED',
            motivo_detalle: (evento?.message || (quien ? `rechazó ${quien}` : null))?.slice(0, 500) ?? null,
          }
        : {};
  if (!Object.keys(cambio).length && JSON.stringify(firmantes) === JSON.stringify(s.firmantes)) return;

  if (!(await casSobre(s, { firmantes, ...cambio }, 'en_firma'))) return; // otro proceso ganó: él hace los efectos
  await avisarBloqueados(s.firmantes, firmantes, s);
  const nuevo = { ...s, firmantes, ...cambio };
  if (cambio.estado === 'completo') return activarContrato(nuevo);
  if (cambio.estado === 'incompleto') return cerrarIncompleto(nuevo);
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
  let sobre: { id: string } | null = null;
  try {
    sobre = await sobreDelEvento(req.body);
  } catch {
    return next(); // BD caída o tabla sin migrar: decide el flujo anterior
  }
  if (!sobre) return next();
  if (!secretoValido(req)) {
    logger.warn({ ip: req.ip }, 'Auco webhook V3: secreto inválido');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.status(200).json({ received: true });
  const body = (req.body ?? {}) as { code?: unknown; status?: unknown; message?: unknown; custom?: unknown };
  logger.info(
    { sobreId: sobre.id, status: body.status, conCode: typeof body.code === 'string', customTipo: Array.isArray(body.custom) ? 'array' : typeof body.custom },
    'Auco webhook V3',
  );
  const evento = {
    code: typeof body.code === 'string' ? body.code : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
  };
  const id = sobre.id;
  setImmediate(() => {
    reconciliarSobre(id, evento).catch((e) =>
      logger.error({ sobreId: id, error: e instanceof Error ? e.message : String(e) }, 'Auco webhook V3: reconciliación fallida (la retoma el barrido)'),
    );
  });
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
        'and(estado.eq.cancelado,auco_code.not.is.null,auco_cancelado_en.is.null)',
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
    .eq('estado', 'vigente')
    .is('storage_key_firmado', null)
    .limit(20);
  for (const { id } of (sinPdf as { id: string }[] | null) ?? []) {
    await archivarPdfFirmadoEnStorage(id).catch(() => undefined);
  }
}

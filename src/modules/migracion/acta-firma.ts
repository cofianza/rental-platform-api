// ============================================================
// Migración de cartera — firma del Acta de Migración por Auco (spec §3.3-§4.1, A7).
//
// Mismo modelo "pull" que la firma V3 (contratos/v3/firma/reconciliar.ts): el
// webhook solo dice QUÉ acta mirar; la verdad la dan GET /document y GET
// /document/roadmap. `reconciliarActa` es la única función que cambia el estado
// de un acta y su escritura que decide va con CAS sobre `updated_at`.
//
// Firman, en este orden: el representante legal de la inmobiliaria (ancla
// {{signature:0}}) y Cofianza (ancla {{signature:1}}). La última firma es la
// FECHA DE ACTIVACIÓN de todos los contratos del lote (§3.4), que crea
// fn_activar_lote_migracion en una sola transacción (§4.1).
// ============================================================

import type { NextFunction, Request, Response } from 'express';
import { env } from '@/config';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, logAudit } from '@/lib/auditLog';
import { cancelDocument, getDocumentRoadmap, getDocumentStatus, uploadDocumentForSignature } from '@/lib/auco';
import { getCompany } from '@/lib/companyConfig';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { secretoValido } from '@/modules/contratos/v3/firma/reconciliar';
import {
  actualizarFirmantes,
  construirSignProfile,
  decidir,
  fueraDePlazo,
  ultimaFirma,
  validarFirmantes,
  type FirmanteSobre,
  type ParteFirmante,
} from '@/modules/contratos/v3/firma/reglas';
import { bloquearInmuebleOcupado } from '@/modules/inmuebles/inmuebles.service';
import { enviarCorreoNotificacion, notificarUsuario } from '@/modules/notificaciones/notificaciones.service';
import { listOperators } from '@/modules/users/users.service';
import { BUCKET } from './habilitacion.service';

const db = (tabla: string) => supabase.from(tabla as string) as ReturnType<typeof supabase.from>;

const TIMEOUT_UPLOAD_MS = 60_000;

export type EstadoActa = 'creando' | 'en_firma' | 'completo' | 'incompleto' | 'cancelado' | 'fallido';

export interface Acta {
  id: string;
  lote_id: string;
  intento: number;
  estado: EstadoActa;
  auco_code: string | null;
  expira_en: string;
  /** parteId = 'representante_legal' | 'cofianza', en orden de firma. */
  firmantes: FirmanteSobre[];
  storage_key: string | null;
  storage_key_firmado: string | null;
  motivo: string | null;
  motivo_detalle: string | null;
  cerrado_en: string | null;
  auco_cancelado_en: string | null;
  enviado_por: string | null;
  created_at: string;
  updated_at: string;
}

interface Lote {
  id: string;
  numero: string;
  estado: 'procesado' | 'en_firma' | 'activo' | 'expirado' | 'cancelado';
  inmobiliaria_id: string;
  vence_en: string;
  acta_storage_key: string | null;
  rep_legal_nombre: string | null;
  rep_legal_documento: string | null;
  rep_legal_email: string | null;
  rep_legal_celular: string | null;
}

const COLS_ACTA =
  'id, lote_id, intento, estado, auco_code, expira_en, firmantes, storage_key, storage_key_firmado, motivo, ' +
  'motivo_detalle, cerrado_en, auco_cancelado_en, enviado_por, created_at, updated_at';
const COLS_LOTE =
  'id, numero, estado, inmobiliaria_id, vence_en, acta_storage_key, rep_legal_nombre, rep_legal_documento, rep_legal_email, rep_legal_celular';

async function leerActa(id: string): Promise<Acta | null> {
  const { data, error } = await db('migracion_actas').select(COLS_ACTA).eq('id', id).maybeSingle();
  if (error) throw fromSupabaseError(error);
  return (data as unknown as Acta | null) ?? null;
}

async function ultimaActa(loteId: string): Promise<Acta | null> {
  const { data, error } = await db('migracion_actas')
    .select(COLS_ACTA)
    .eq('lote_id', loteId)
    .order('intento', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  return (data as unknown as Acta | null) ?? null;
}

async function leerLote(id: string): Promise<Lote> {
  const { data, error } = await db('migracion_lotes').select(COLS_LOTE).eq('id', id).maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.notFound('Lote de migración no encontrado.', 'MIGRACION_LOTE_NO_ENCONTRADO');
  return data as unknown as Lote;
}

/** CAS: solo escribe si el acta sigue como se leyó. true = este proceso ganó. */
async function casActa(a: Acta, cambios: Partial<Acta>, estadoEsperado: EstadoActa = a.estado): Promise<boolean> {
  const { data, error } = await db('migracion_actas')
    .update(cambios as never)
    .eq('id', a.id)
    .eq('estado', estadoEsperado)
    .eq('updated_at', a.updated_at)
    .select('id');
  if (error) throw fromSupabaseError(error);
  return !!(data as unknown[] | null)?.length;
}

/**
 * Las dos partes como las entienden las reglas V3 (datosDeFirma solo trata
 * distinto al 'arrendador', así que ambas firman por sí; el rol solo sirve
 * para nombrarlas en los errores, ver QUIEN).
 * Cofianza firma sin documento: el NIT no sirve para firmar en Auco.
 */
async function partesDelActa(l: Lote): Promise<ParteFirmante[]> {
  const empresa = await getCompany();
  return [
    {
      id: 'representante_legal',
      rol: 'arrendatario',
      orden: 1,
      nombre: l.rep_legal_nombre ?? '',
      tipo_documento: null,
      numero_documento: l.rep_legal_documento,
      email: l.rep_legal_email,
      telefono: l.rep_legal_celular,
    },
    {
      id: 'cofianza',
      rol: 'coarrendatario',
      orden: 2,
      nombre: empresa.name,
      tipo_documento: null,
      numero_documento: null,
      email: empresa.email,
      telefono: empresa.phone,
    },
  ];
}

const QUIEN: Record<string, string> = { arrendatario: 'el representante legal', coarrendatario: 'Cofianza' };

/** Id del acta en `custom` (objeto en el upload, arreglo en el webhook). */
export function actaIdDeCustom(custom: unknown): string | null {
  const texto = typeof custom === 'string' ? custom : JSON.stringify(custom ?? '');
  const m = /cofianza_acta['"]?\s*[:=]\s*['"]?([0-9a-f-]{36})/i.exec(texto);
  return m ? m[1] : null;
}

// ── Envío ──

/**
 * Sube el acta sin firmar del lote (C4: lote.acta_storage_key) a Auco. El
 * proceso vence con el lote (§3.6): pasado vence_en el barrido lo anula y el
 * lote expira. Se puede reenviar mientras el lote no esté activo ni vencido y
 * no haya otra acta viva (índice migracion_actas_viva_uq).
 */
export async function enviarActa(loteId: string, userId: string): Promise<Acta> {
  const l = await leerLote(loteId);
  if (l.estado !== 'procesado' && l.estado !== 'en_firma')
    throw AppError.conflict(`El lote ${l.numero} no se puede enviar a firma: está ${l.estado}.`, 'MIGRACION_LOTE_ESTADO');
  if (Date.parse(l.vence_en) <= Date.now())
    throw AppError.conflict(`El lote ${l.numero} venció sin firma. Cargue de nuevo el archivo.`, 'MIGRACION_LOTE_VENCIDO');
  if (!l.acta_storage_key) throw new AppError(500, 'MIGRACION_SIN_ACTA', 'El lote no tiene Acta de Migración generada.');

  const partes = await partesDelActa(l);
  const fallas = validarFirmantes(partes);
  if (fallas.length)
    throw new AppError(422, 'FIRMANTES_INVALIDOS', 'Hay datos de los firmantes que Auco no acepta.', {
      fallas: fallas.map((f) => ({
        firmante: QUIEN[f.rol] ?? f.rol,
        motivo: f.motivo.replace(/ya lo usa (\w+)/, (_, r: string) => `ya lo usa ${QUIEN[r] ?? r}`),
      })),
    });

  const ultimo = await ultimaActa(loteId);
  const { data: creado, error: errIns } = await db('migracion_actas')
    .insert({
      lote_id: loteId,
      intento: (ultimo?.intento ?? 0) + 1,
      estado: 'creando',
      expira_en: l.vence_en,
      firmantes: partes.map((p) => ({ parteId: p.id, estado: 'pendiente' })),
      storage_key: l.acta_storage_key,
      enviado_por: userId,
    } as never)
    .select(COLS_ACTA)
    .single();
  if (errIns) {
    if ((errIns as { code?: string }).code === '23505')
      throw AppError.conflict('El acta de este lote ya está en firma.', 'ACTA_YA_EN_FIRMA');
    throw fromSupabaseError(errIns);
  }
  const acta = creado as unknown as Acta;

  let code: string;
  try {
    const { data: pdf, error } = await supabase.storage.from(BUCKET).download(l.acta_storage_key);
    if (error || !pdf) throw new Error(`no se pudo leer el acta: ${error?.message ?? 'sin datos'}`);
    code = await uploadDocumentForSignature(
      {
        email: env.AUCO_SENDER_EMAIL,
        name: `Acta de Migración ${l.numero}`,
        subject: `Firma del Acta de Migración de cartera ${l.numero}`,
        message: `Lo invitamos a firmar electrónicamente el Acta de Migración de cartera ${l.numero}. Recibirá un código por WhatsApp.`,
        file: Buffer.from(await pdf.arrayBuffer()).toString('base64'),
        signProfile: construirSignProfile(partes),
        expiredDate: l.vence_en,
        custom: { cofianza_acta: acta.id },
      },
      TIMEOUT_UPLOAD_MS,
    );
  } catch (e) {
    const detalle = e instanceof Error ? e.message : String(e);
    const marcado = await casActa(acta, { estado: 'fallido', motivo: 'AUCO_UPLOAD', motivo_detalle: detalle.slice(0, 500) });
    if (!marcado) {
      // El webhook adoptó el proceso (Auco sí lo creó y el upload solo se demoró).
      const ahora = await leerActa(acta.id);
      if (ahora?.estado === 'en_firma' && ahora.auco_code) return marcarEnviado(l, ahora, userId);
    }
    logger.error({ loteId, actaId: acta.id, error: detalle }, 'Migración: Auco no creó el proceso del acta');
    throw new AppError(502, 'AUCO_UPLOAD_FAILED', `Auco no aceptó el envío: ${detalle.slice(0, 300)}`);
  }

  if (!(await casActa(acta, { estado: 'en_firma', auco_code: code }, 'creando'))) {
    const ahora = await leerActa(acta.id);
    if (ahora?.estado === 'en_firma' && ahora.auco_code === code) return marcarEnviado(l, ahora, userId);
    // Cambió mientras subía: se anula también en Auco (si falla, lo retoma el barrido).
    await db('migracion_actas').update({ auco_code: code } as never).eq('id', acta.id).is('auco_code', null);
    await cancelDocument(code, { message: 'Acta anulada durante el envío', email: env.AUCO_SENDER_EMAIL })
      .then(() => db('migracion_actas').update({ auco_cancelado_en: new Date().toISOString() } as never).eq('id', acta.id))
      .catch((e) => logger.warn({ code, e }, 'Migración: anulación del acta pendiente (la retoma el barrido)'));
    throw AppError.conflict('El acta cambió mientras se enviaba a firma.', 'ACTA_ESTADO_CAMBIADO');
  }
  return marcarEnviado(l, { ...acta, estado: 'en_firma', auco_code: code }, userId);
}

/** El proceso ya salió: lote en_firma y bitácora. No lanza (una reversión lo dejaría vivo en Auco). */
async function marcarEnviado(l: Lote, a: Acta, userId: string): Promise<Acta> {
  const { error } = await db('migracion_lotes').update({ estado: 'en_firma' } as never).eq('id', l.id).eq('estado', 'procesado');
  // Si falla, activarLote lo cura antes de la RPC.
  if (error) logger.warn({ loteId: l.id, error: error.message }, 'Migración: lote sin pasar a en_firma');
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.MIGRACION_ACTA_ENVIADA,
    entidad: AUDIT_ENTITIES.MIGRACION_LOTE,
    entidadId: l.id,
    detalle: { acta_id: a.id, intento: a.intento, auco_code: a.auco_code, expira: a.expira_en },
  });
  return a;
}

// ── Activación ──

/** PDF firmado de Auco → bucket; guarda storage_key_firmado (idempotente). */
async function archivarActaFirmada(a: Acta, l: Lote): Promise<string> {
  if (a.storage_key_firmado) return a.storage_key_firmado;
  const info = await getDocumentStatus(a.auco_code!);
  if (info.status !== 'FINISH' || !info.url) throw new Error('Auco no entrega todavía el acta firmada');
  const resp = await fetch(info.url);
  if (!resp.ok) throw new Error(`descarga del acta firmada: HTTP ${resp.status}`);
  const key = `migracion/${l.inmobiliaria_id}/lotes/${l.id}/acta-firmada.pdf`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(key, Buffer.from(await resp.arrayBuffer()), { contentType: 'application/pdf', upsert: true });
  if (upErr) throw new Error(`no se pudo guardar el acta firmada: ${upErr.message}`);
  const { error } = await db('migracion_actas').update({ storage_key_firmado: key } as never).eq('id', a.id).is('storage_key_firmado', null);
  if (error) throw fromSupabaseError(error);
  return key;
}

interface ResultadoActivacion {
  ya_activo: boolean;
  activados?: number;
  en_revision?: number;
  contratos: { fila_id: string; contrato_id: string; inmueble_id?: string; en_revision: boolean }[];
}

/**
 * Acta completa → contratos (§4.1). Idempotente: sirve de curación en el
 * barrido (acta 'completo' con el lote sin activar). Si algo falla, lanza y el
 * barrido reintenta; la RPC no duplica nada.
 */
export async function activarLote(a: Acta): Promise<void> {
  const l = await leerLote(a.lote_id);
  if (l.estado === 'activo') return;
  const firmado = await archivarActaFirmada(a, l);
  // La RPC exige 'en_firma': cura un envío cuyo cambio de estado del lote falló.
  await db('migracion_lotes').update({ estado: 'en_firma' } as never).eq('id', l.id).eq('estado', 'procesado');

  const { data, error } = await (supabase as unknown as {
    rpc: (f: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('fn_activar_lote_migracion', { p_lote: l.id, p_activado_en: a.cerrado_en });
  if (error) throw new Error(`Migración: no se pudo activar el lote ${l.numero}: ${error.message}`);
  const r = data as ResultadoActivacion;
  // ponytail: si el proceso cae entre la RPC y los avisos, la curación ve ya_activo y no avisa; se ve en el tablero.
  if (r.ya_activo) return;

  // La RPC ya deja los inmuebles ocupados; esto repite lo mismo por si un
  // trigger o una versión vieja de la función no lo hizo.
  for (const c of r.contratos) if (c.inmueble_id) await bloquearInmuebleOcupado(c.inmueble_id);

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.MIGRACION_LOTE_ACTIVADO,
    entidad: AUDIT_ENTITIES.MIGRACION_LOTE,
    entidadId: l.id,
    detalle: { acta_id: a.id, auco_code: a.auco_code, activado_en: a.cerrado_en, activados: r.activados, en_revision: r.en_revision, acta_firmada: firmado },
  });
  await avisarActivacion(l, a, r).catch((e) =>
    logger.warn({ loteId: l.id, error: e instanceof Error ? e.message : String(e) }, 'Migración: avisos de activación fallidos'),
  );
}

const fechaHoraBogota = (iso: string) =>
  new Date(iso).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' });

async function avisarActivacion(l: Lote, a: Acta, r: ResultadoActivacion): Promise<void> {
  const cuando = a.cerrado_en ? fechaHoraBogota(a.cerrado_en) : '';
  const revision = r.en_revision ? ` ${r.en_revision} quedaron en revisión por un conflicto con el inmueble.` : '';
  const { data, error } = await db('inmobiliaria_miembros')
    .select('perfil_id')
    .eq('inmobiliaria_id', l.inmobiliaria_id)
    .eq('estado', 'activo')
    .eq('rol_miembro', 'owner')
    .not('perfil_id', 'is', null);
  if (error) logger.warn({ loteId: l.id, error: error.message }, 'Migración: sin titulares a quien avisar');
  const aviso = {
    tipo: 'migracion.lote_activado',
    titulo: `Fianza activa por migración — lote ${l.numero}`,
    mensaje:
      `Se firmó el Acta de Migración ${l.numero} el ${cuando}. La fianza de COFIANZA S.A.S. quedó activa para ${r.activados ?? r.contratos.length} contratos desde esa fecha; ` +
      `no cubre obligaciones causadas antes.${revision}`,
    link: '/contratos',
    payload: { lote_id: l.id, acta_id: a.id },
  };
  for (const { perfil_id } of (data as { perfil_id: string }[] | null) ?? []) {
    await notificarUsuario({ userId: perfil_id, ...aviso });
    await enviarCorreoNotificacion({ userId: perfil_id, ...aviso });
  }
  for (const op of await listOperators())
    await notificarUsuario({ userId: op.id, ...aviso, link: `/admin/migracion/lotes/${l.id}` });
}

// ── Reconciliación ──

const hace = (iso: string, minutos: number) => Date.now() - Date.parse(iso) > minutos * 60_000;

/** Anula en Auco y deja la marca. Si ya está cerrado allá (vencido/rechazado) también marca. */
async function anularEnAuco(a: Acta, motivo: string): Promise<'anulado' | 'firmado'> {
  try {
    const r = await cancelDocument(a.auco_code!, { message: motivo, email: env.AUCO_SENDER_EMAIL });
    if (r?.success === false || (r?.errors?.cant ?? 0) > 0) throw new Error('Auco respondió que no anuló el proceso');
  } catch (e) {
    const info = await getDocumentStatus(a.auco_code!).catch(() => null);
    if (info?.status === 'FINISH') return 'firmado';
    if (info?.status !== 'REJECTED' && info?.status !== 'EXPIRED') throw e;
  }
  await db('migracion_actas').update({ auco_cancelado_en: new Date().toISOString() } as never).eq('id', a.id);
  return 'anulado';
}

/** La única función que cambia el estado de un acta. */
export async function reconciliarActa(actaId: string, evento?: { code?: string }): Promise<void> {
  let a = await leerActa(actaId);
  if (!a) return;

  // Proceso que Auco creó y no quedó registrado: se adopta solo si Auco confirma que es de ESTA acta.
  if (!a.auco_code && evento?.code && a.estado === 'creando') {
    const info = await getDocumentStatus(evento.code).catch(() => null);
    if (info && actaIdDeCustom(info.custom) === a.id) await casActa(a, { auco_code: evento.code, estado: 'en_firma' });
    a = await leerActa(actaId);
    if (!a) return;
  }

  if (a.estado === 'completo') return activarLote(a);
  if ((a.estado === 'cancelado' || a.estado === 'fallido') && a.auco_code && !a.auco_cancelado_en) {
    if (hace(a.updated_at, 10)) await anularEnAuco(a, 'Acta de migración anulada');
    return;
  }
  if (a.estado === 'creando' && hace(a.created_at, 30)) {
    await casActa(a, { estado: 'fallido', motivo: 'HUERFANO', motivo_detalle: 'El envío a Auco no se confirmó en 30 minutos.' });
    return;
  }
  if (a.estado !== 'en_firma' || !a.auco_code) return;

  const l = await leerLote(a.lote_id);
  const partes = await partesDelActa(l);
  const info = await getDocumentStatus(a.auco_code);
  const firmantes = actualizarFirmantes(a.firmantes, partes, info.signProfile);
  const d = decidir(info, firmantes);
  const fecha = d === 'activar' ? ultimaFirma(await getDocumentRoadmap(a.auco_code).catch(() => null), partes.length) : null;
  if (d === 'activar' && !fecha) logger.warn({ actaId }, 'Migración: FINISH sin todas las firmas en el roadmap; se reintenta');
  // Una firma después del vencimiento del lote no activa (§3.6).
  const tarde = !!fecha && fueraDePlazo(fecha, a.expira_en, null);

  const cambio: Partial<Acta> =
    d === 'activar' && fecha
      ? tarde
        ? { estado: 'incompleto', cerrado_en: new Date().toISOString(), motivo: 'FUERA_PLAZO', motivo_detalle: `última firma ${fecha}` }
        : { estado: 'completo', cerrado_en: fecha }
      : d === 'incompleta'
        ? { estado: 'incompleto', cerrado_en: new Date().toISOString(), motivo: info.status === 'EXPIRED' ? 'EXPIRED' : 'REJECTED' }
        : {};
  if (!Object.keys(cambio).length && JSON.stringify(firmantes) === JSON.stringify(a.firmantes)) return;

  if (!(await casActa(a, { firmantes, ...cambio }, 'en_firma'))) return; // otro proceso ganó: él hace los efectos
  if (cambio.estado === 'completo') return activarLote({ ...a, firmantes, ...cambio });
  if (cambio.estado === 'incompleto') {
    const ops = await listOperators().catch(() => []);
    for (const op of ops)
      await notificarUsuario({
        userId: op.id,
        tipo: 'migracion.acta_incompleta',
        titulo: `Acta de Migración sin firmar — lote ${l.numero}`,
        mensaje: `El proceso de firma del acta terminó sin todas las firmas (${cambio.motivo}). Ningún contrato se activó. Puede reenviarla mientras el lote no venza.`,
        link: `/admin/migracion/lotes/${l.id}`,
        payload: { lote_id: l.id, acta_id: a.id },
      });
  }
}

// ── Webhook ──

async function actaDelEvento(body: { code?: unknown; custom?: unknown } | undefined): Promise<{ id: string } | null> {
  const code = typeof body?.code === 'string' ? body.code : null;
  if (code) {
    const { data, error } = await db('migracion_actas').select('id').eq('auco_code', code).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data as { id: string };
  }
  const id = actaIdDeCustom(body?.custom);
  if (!id) return null;
  const { data, error } = await db('migracion_actas').select('id').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { id: string } | null) ?? null;
}

const programadas = new Map<string, { code?: string }>();

/**
 * Se monta ANTES de webhookAucoV3 (app.ts): si el evento no es de un acta de
 * migración, `next()` y lo demás sigue igual. Si lo es, responde 200 enseguida
 * y reconcilia después (una sola vez por ráfaga de eventos).
 */
export async function webhookAucoMigracion(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method !== 'POST' || !secretoValido(req)) return next();
  let acta: { id: string } | null = null;
  try {
    acta = await actaDelEvento(req.body);
  } catch {
    return next(); // BD caída o tabla sin migrar: deciden los siguientes
  }
  if (!acta) return next();
  res.status(200).json({ received: true });
  const id = acta.id;
  const code = typeof req.body?.code === 'string' ? (req.body.code as string) : undefined;
  const yaProgramada = programadas.has(id);
  programadas.set(id, { code });
  if (yaProgramada) return;
  setTimeout(() => {
    const evento = programadas.get(id);
    programadas.delete(id);
    reconciliarActa(id, evento).catch((e) =>
      logger.error({ actaId: id, error: e instanceof Error ? e.message : String(e) }, 'Auco webhook migración: reconciliación fallida (la retoma el barrido)'),
    );
  }, 3000).unref();
}

// ── Barrido ──

/**
 * Cada 15 min (server.ts, MIGRACION_BARRIDO_ENABLED): reconcilia actas vivas,
 * activaciones a medias y anulaciones sin confirmar; vence los lotes pasado
 * vence_en (§3.6), anula su proceso en Auco y libera sus filas.
 */
export async function barrerActasMigracion(): Promise<void> {
  const { data, error } = await db('migracion_actas')
    .select('id, estado, migracion_lotes(estado)')
    .or('estado.in.(creando,en_firma,completo),and(estado.in.(cancelado,fallido),auco_code.not.is.null,auco_cancelado_en.is.null)')
    .order('updated_at', { ascending: true })
    .limit(50);
  if (error) logger.warn({ error: error.message }, 'barrerActasMigracion: no se pudieron leer las actas');
  const actas = (data as { id: string; estado: string; migracion_lotes: { estado: string } | null }[] | null) ?? [];
  for (const a of actas) {
    if (a.estado === 'completo' && a.migracion_lotes?.estado === 'activo') continue;
    await reconciliarActa(a.id).catch((e) =>
      logger.warn({ actaId: a.id, error: e instanceof Error ? e.message : String(e) }, 'barrerActasMigracion: acta sin reconciliar'),
    );
  }

  const { data: vencidos, error: vErr } = await db('migracion_lotes')
    .select('id')
    .in('estado', ['procesado', 'en_firma'])
    .lt('vence_en', new Date().toISOString())
    .limit(50);
  if (vErr) logger.warn({ error: vErr.message }, 'barrerActasMigracion: no se pudieron leer los lotes vencidos');
  for (const { id } of (vencidos as { id: string }[] | null) ?? []) {
    await vencerLote(id).catch((e) =>
      logger.warn({ loteId: id, error: e instanceof Error ? e.message : String(e) }, 'barrerActasMigracion: lote sin vencer'),
    );
  }
}

/**
 * Cierra un lote sin firmar: 'expirado' pasado vence_en (§3.6) o 'cancelado'
 * por el analista antes de la firma. Anula el proceso en Auco y libera las filas.
 * false = no se cerró (acta ya firmada, o el lote cambió de estado).
 */
async function cerrarLote(loteId: string, final: 'expirado' | 'cancelado', usuarioId: string | null): Promise<boolean> {
  const viva = await ultimaActa(loteId);
  // Firmada a tiempo: el lote no vence; el barrido reintenta activarLote con la hora de la firma.
  if (viva?.estado === 'completo') return false;
  if (viva && (viva.estado === 'en_firma' || viva.estado === 'creando')) {
    if (viva.auco_code) {
      const motivo = final === 'expirado' ? 'Venció el plazo para firmar el Acta de Migración' : 'Lote de migración cancelado por Cofianza';
      // Si alguien firmó a última hora, la reconciliación decide por la hora de la firma.
      if ((await anularEnAuco(viva, motivo)) === 'firmado') {
        await reconciliarActa(viva.id);
        return false;
      }
    }
    const actual = await leerActa(viva.id);
    if (actual && (actual.estado === 'en_firma' || actual.estado === 'creando'))
      await casActa(
        actual,
        final === 'expirado'
          ? { estado: 'incompleto', cerrado_en: new Date().toISOString(), motivo: 'EXPIRED' }
          : { estado: 'cancelado', cerrado_en: new Date().toISOString(), motivo: 'CANCELADO' },
      );
  }
  const { data, error } = await db('migracion_lotes')
    .update({ estado: final } as never)
    .eq('id', loteId)
    .in('estado', ['procesado', 'en_firma'])
    .select('id, numero');
  if (error) throw fromSupabaseError(error);
  if (!(data as unknown[] | null)?.length) return false;
  const { error: fErr } = await db('migracion_filas')
    .update({ liberada_en: new Date().toISOString() } as never)
    .eq('lote_id', loteId)
    .is('liberada_en', null);
  if (fErr) throw fromSupabaseError(fErr);
  logAudit({
    usuarioId,
    accion: final === 'expirado' ? AUDIT_ACTIONS.MIGRACION_LOTE_EXPIRADO : AUDIT_ACTIONS.MIGRACION_LOTE_CANCELADO,
    entidad: AUDIT_ENTITIES.MIGRACION_LOTE,
    entidadId: loteId,
    detalle: { numero: (data as { numero: string }[])[0].numero },
  });
  return true;
}

/** Lote sin firma pasado vence_en → expirado (§3.6). Nada se activa. */
export async function vencerLote(loteId: string): Promise<void> {
  await cerrarLote(loteId, 'expirado', null);
}

/** El analista cancela un lote antes de la firma (p. ej. error de digitación en el acta, §3.5). */
export async function cancelarLote(loteId: string, userId: string) {
  const l = await leerLote(loteId);
  if (l.estado !== 'procesado' && l.estado !== 'en_firma')
    throw AppError.conflict(`El lote ${l.numero} no se puede cancelar: está ${l.estado}.`, 'MIGRACION_LOTE_ESTADO');
  if (!(await cerrarLote(loteId, 'cancelado', userId)))
    throw AppError.conflict(
      `El Acta de Migración del lote ${l.numero} ya fue firmada o el lote cambió de estado: no se puede cancelar.`,
      'MIGRACION_LOTE_ESTADO',
    );
  return estadoActa(loteId);
}

// ── Consulta ──

/** Estado del lote y de su última acta para el backoffice. */
export async function estadoActa(loteId: string) {
  const [l, a] = await Promise.all([leerLote(loteId), ultimaActa(loteId)]);
  return {
    lote: { id: l.id, numero: l.numero, estado: l.estado, vence_en: l.vence_en },
    acta: a
      ? {
          id: a.id,
          intento: a.intento,
          estado: a.estado,
          auco_code: a.auco_code,
          expira_en: a.expira_en,
          firmantes: a.firmantes,
          motivo: a.motivo,
          cerrado_en: a.cerrado_en,
          firmada: !!a.storage_key_firmado,
        }
      : null,
  };
}

/** Enlace temporal (10 min) al PDF del acta: la firmada si ya existe, si no la generada sin firmar. */
export async function urlActaPdf(loteId: string) {
  const [l, a] = await Promise.all([leerLote(loteId), ultimaActa(loteId)]);
  const key = a?.storage_key_firmado ?? l.acta_storage_key;
  if (!key) throw AppError.notFound('El lote no tiene Acta de Migración generada.', 'MIGRACION_SIN_ACTA');
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(key, 600);
  if (error || !data?.signedUrl) throw new AppError(500, 'STORAGE_ERROR', 'No se pudo obtener el acta. Intente de nuevo.');
  return { url: data.signedUrl, firmada: !!a?.storage_key_firmado };
}

/** Botón «Actualizar»: reconcilia la última acta del lote y devuelve el estado. */
export async function actualizarActa(loteId: string) {
  const a = await ultimaActa(loteId);
  if (a) await reconciliarActa(a.id);
  return estadoActa(loteId);
}

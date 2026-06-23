/**
 * Firma multi-parte (M1) — un solo sobre Auco con varios firmantes.
 *
 * El contrato de afianzamiento lo firman TODAS las partes:
 *   1. arrendatario (solicitante)
 *   2. arrendador   (inmobiliaria → representante legal, o propietario individual)
 *   3. cofianza      (afianzadora)
 *
 * Modelo: un único documento Auco (signProfile[] — firma en PARALELO; ver nota
 * en buildSignProfileMultiparte sobre por qué NO usamos `order`) → un
 * `auco_document_code` → un sobre `solicitudes_firma` + N filas
 * `contrato_firmantes`. La reconciliación del estado por parte se hace por POLL
 * (`getDocumentStatus().signProfile[].status`), así no dependemos de que Auco
 * emita un webhook por firmante. El contrato pasa a `firmado` cuando TODAS las
 * filas `contrato_firmantes` están `firmado`.
 *
 * Gated por env.FIRMA_MULTIPARTE_ENABLED (OFF por defecto). Mientras esté OFF se
 * usa el flujo de un solo firmante de firma.service.ts.
 */

import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { getCompany } from '@/lib/companyConfig';
import * as aucoClient from '@/lib/auco';
import type { AucoSignerStatus } from '@/lib/auco';

const TOKEN_EXPIRY_HOURS = 72;
const MAX_ENVIOS_DEFAULT = 5;
const BUCKET_NAME = 'documentos-expedientes';

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

// ============================================================
// Tipos
// ============================================================

export type RolFirmante = 'arrendatario' | 'arrendador' | 'cofianza';

export interface FirmanteDerivado {
  rol_firmante: RolFirmante;
  nombre: string;
  email: string;
  telefono: string | null;
  tipo_documento: string | null;
  numero_documento: string | null;
  country: string;
  /** Orden de firma (1 = primero). */
  orden: number;
}

interface FirmanteRow {
  id: string;
  rol_firmante: RolFirmante;
  email: string;
  estado: string;
  orden: number;
}

// ============================================================
// Helpers puros (testeables sin BD)
// ============================================================

/**
 * Mapea el estado de un firmante en Auco (signProfile[].status del documento)
 * al estado interno de `contrato_firmantes`. Devuelve null si no hay cambio
 * accionable (mantener el estado actual).
 */
export function mapAucoSignerStatusToEstado(status: AucoSignerStatus | string): string | null {
  switch (status) {
    case 'FINISH':
      return 'firmado';
    case 'REJECT':
    case 'BLOCK':
      return 'cancelado';
    case 'NOTIFICATION':
      return 'abierto';
    case 'PENDING':
      return 'enviado';
    default:
      return null;
  }
}

/** ¿Todas las partes firmaron? (lista no vacía y todas en 'firmado'). */
export function todasFirmaron(firmantes: Array<{ estado: string }>): boolean {
  return firmantes.length > 0 && firmantes.every((f) => f.estado === 'firmado');
}

// ============================================================
// Listado de firmantes de un contrato (para el panel del detalle)
// ============================================================

export async function listarFirmantes(contratoId: string): Promise<{ firmantes: Array<Record<string, unknown>> }> {
  const { data } = await db('contrato_firmantes')
    .select('id, rol_firmante, nombre, email, telefono, orden, estado, firmado_en, created_at')
    .eq('contrato_id', contratoId)
    .order('orden', { ascending: true });
  return { firmantes: (data as Array<Record<string, unknown>> | null) ?? [] };
}

// ============================================================
// Fase 2 — Derivar los firmantes de un contrato
// ============================================================

export async function derivarFirmantes(contratoId: string): Promise<FirmanteDerivado[]> {
  // 1. Contrato → expediente
  const { data: contrato } = await db('contratos')
    .select('id, expediente_id')
    .eq('id', contratoId)
    .single();
  const c = contrato as { id: string; expediente_id: string } | null;
  if (!c) throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');

  // 2. Expediente → solicitante (arrendatario) + inmueble (propietario)
  const { data: expediente } = await db('expedientes')
    .select(`
      id,
      solicitantes(nombre, apellido, email, telefono, tipo_documento, numero_documento),
      inmuebles(propietario_id, inmobiliaria_id)
    `)
    .eq('id', c.expediente_id)
    .single();
  const exp = expediente as unknown as {
    id: string;
    solicitantes: {
      nombre: string; apellido: string; email: string | null; telefono: string | null;
      tipo_documento: string | null; numero_documento: string | null;
    } | null;
    inmuebles: { propietario_id: string; inmobiliaria_id: string | null } | null;
  } | null;

  if (!exp?.solicitantes) throw AppError.badRequest('El expediente no tiene solicitante', 'NO_SOLICITANTE');
  if (!exp.inmuebles?.propietario_id) throw AppError.badRequest('El inmueble no tiene propietario', 'NO_PROPIETARIO');

  const sol = exp.solicitantes;
  const firmantes: FirmanteDerivado[] = [];

  // ── Arrendatario (orden 1) ──
  firmantes.push({
    rol_firmante: 'arrendatario',
    nombre: `${sol.nombre} ${sol.apellido}`.trim(),
    email: sol.email ?? '',
    telefono: sol.telefono ?? null,
    tipo_documento: sol.tipo_documento ?? null,
    numero_documento: sol.numero_documento ?? null,
    country: 'CO',
    orden: 1,
  });

  // ── Arrendador (orden 2): inmobiliaria (representante legal) o propietario ──
  const { data: arrendadorRow } = await db('perfiles')
    .select('id, nombre, apellido, rol, tipo_documento, numero_documento, razon_social, representante_legal, telefono, whatsapp_recaudo, email_recaudo')
    .eq('id', exp.inmuebles.propietario_id)
    .single();
  const arr = arrendadorRow as unknown as {
    id: string; nombre: string; apellido: string; rol: string;
    tipo_documento: string | null; numero_documento: string | null;
    razon_social: string | null; representante_legal: string | null;
    telefono: string | null; whatsapp_recaudo: string | null; email_recaudo: string | null;
  } | null;
  if (!arr) throw AppError.badRequest('No se encontró el arrendador del inmueble', 'NO_ARRENDADOR');

  const esInmobiliaria = arr.rol === 'inmobiliaria';
  const nombreArrendador = esInmobiliaria
    ? (arr.representante_legal || arr.razon_social || `${arr.nombre} ${arr.apellido}`.trim())
    : `${arr.nombre} ${arr.apellido}`.trim();

  // perfiles NO guarda email (vive en auth.users): preferimos email_recaudo y,
  // si falta, lo resolvemos por RPC.
  let emailArrendador = arr.email_recaudo ?? '';
  if (!emailArrendador) {
    emailArrendador = (await resolveAuthEmail(arr.id)) ?? '';
  }

  firmantes.push({
    rol_firmante: 'arrendador',
    nombre: nombreArrendador,
    email: emailArrendador,
    telefono: arr.whatsapp_recaudo || arr.telefono || null,
    tipo_documento: arr.tipo_documento ?? null,
    numero_documento: arr.numero_documento ?? null,
    country: 'CO',
    orden: 2,
  });

  // ── Cofianza (orden 3): afianzadora ──
  // Datos editables por el admin (configuracion_sistema). Si el NIT sigue
  // siendo placeholder (contiene X), no lo mandamos a Auco: un identification
  // inválido puede romper el flujo. El OTP por WhatsApp no requiere documento.
  const company = await getCompany();
  const nitEsPlaceholder = /x/i.test(company.nit);
  firmantes.push({
    rol_firmante: 'cofianza',
    nombre: company.name,
    email: company.email,
    telefono: company.phone,
    tipo_documento: nitEsPlaceholder ? null : 'NIT',
    numero_documento: nitEsPlaceholder ? null : company.nit,
    country: 'CO',
    orden: 3,
  });

  return firmantes;
}

async function resolveAuthEmail(perfilId: string): Promise<string | null> {
  try {
    const { data } = await supabase.rpc('get_user_with_email' as never, { user_id: perfilId } as never);
    return (data as unknown as Array<{ email: string }> | null)?.[0]?.email ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// Fase 3 — Crear el sobre multi-parte en Auco
// ============================================================

/**
 * Perfil de firma WhatsApp para Auco (OTP por phone), firma en PARALELO.
 *
 * NO mandamos el campo `order`: con `order` (firma secuencial) Auco no entrega
 * la notificación de WhatsApp en nuestra cuenta (el flujo de un firmante, que es
 * idéntico salvo ese campo, sí entrega). Sin `order`, las 3 partes se notifican
 * a la vez y firman en cualquier orden. El `orden` (1/2/3) se conserva en
 * `contrato_firmantes` solo para mostrarlo en el panel del detalle.
 */
function buildSignProfileMultiparte(f: FirmanteDerivado, phoneInternational: string) {
  const tipoAuco = mapTipoDocumentoToAuco(f.tipo_documento);
  const country = aucoDeriveCountry(phoneInternational) || f.country;
  const profile: Record<string, unknown> = {
    name: f.nombre,
    email: f.email,
    phone: phoneInternational,
    // `label: true` activa el posicionamiento por ancla de texto: cada firma
    // cae donde está su `{{signature:N}}` en el PDF (N = índice en signProfile:
    // arrendatario=0, arrendador=1, cofianza=2), inyectado por
    // inyectarAnclasFirmaMultiparte en la generación del contrato. Antes era
    // `position` fija → las 3 firmas se apilaban en el mismo punto.
    label: true,
    otpCode: true,
    options: { whatsapp: true, otpCode: 'phone' },
  };
  // Solo mandamos identificación si el tipo es válido para Auco. Una inmobiliaria
  // (NIT) o tipos no soportados (TI) → omitimos AMBOS campos: Auco rechaza el
  // sobre (400) si identificationType no está en su lista. El OTP por WhatsApp no
  // requiere documento, así que el firmante igual puede firmar.
  if (tipoAuco && f.numero_documento) {
    profile.identification = f.numero_documento;
    profile.identificationType = tipoAuco;
  }
  if (country) profile.country = country;
  return profile;
}

// Tipos de documento que Auco acepta para un FIRMANTE (persona natural). NIT
// (empresa) y TI NO están en la lista, así que mapean a null y no se envían.
const AUCO_DOC_TYPES = new Set([
  'CC', 'CE', 'PPT', 'PEP', 'CI', 'RUT', 'RUN', 'CCCR', 'DUI', 'DNI', 'CURP', 'PASSPORT',
]);

function mapTipoDocumentoToAuco(tipo: string | null | undefined): string | null {
  if (!tipo) return null;
  const t = tipo.trim().toLowerCase();
  const alias: Record<string, string> = {
    cc: 'CC', ce: 'CE', pep: 'PEP', ppt: 'PPT', ci: 'CI',
    dni: 'DNI', curp: 'CURP', rut: 'RUT',
    pasaporte: 'PASSPORT', passport: 'PASSPORT',
  };
  const mapped = alias[t] ?? t.toUpperCase();
  return AUCO_DOC_TYPES.has(mapped) ? mapped : null;
}

function aucoDeriveCountry(phone: string | null): string | null {
  if (!phone) return null;
  if (phone.startsWith('+57')) return 'CO';
  if (phone.startsWith('+52')) return 'MX';
  if (phone.startsWith('+593')) return 'EC';
  if (phone.startsWith('+51')) return 'PE';
  return null;
}

export async function crearSolicitudFirmaMultiparte(
  contratoId: string,
  userId: string,
  ip?: string,
) {
  // 1. Validar contrato + PDF
  const { data: contrato } = await db('contratos')
    .select('id, estado, expediente_id, storage_key')
    .eq('id', contratoId)
    .single();
  const c = contrato as { id: string; estado: string; expediente_id: string; storage_key: string | null } | null;
  if (!c) throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  if (c.estado !== 'pendiente_firma') {
    throw AppError.badRequest(
      `El contrato debe estar en "Pendiente de firma". Estado actual: ${c.estado}`,
      'INVALID_CONTRACT_STATE',
    );
  }
  if (!c.storage_key) {
    throw AppError.badRequest('El contrato no tiene PDF generado para enviar a firma', 'NO_PDF');
  }

  // 2. Derivar firmantes y validar datos mínimos (flujo WhatsApp: teléfono real)
  const firmantes = await derivarFirmantes(contratoId);
  const conTelefono = firmantes.map((f) => ({
    f,
    phone: aucoClient.normalizePhoneToInternational(f.telefono),
  }));
  const sinDatos = conTelefono.filter((x) => !x.phone || !x.f.email);
  if (sinDatos.length > 0) {
    const faltan = sinDatos.map((x) => x.f.rol_firmante).join(', ');
    throw AppError.badRequest(
      `Faltan teléfono válido o email para firmar por WhatsApp: ${faltan}. Completa esos datos antes de enviar a firma.`,
      'FIRMANTE_DATOS_INCOMPLETOS',
    );
  }

  // Cada firmante WhatsApp necesita un teléfono ÚNICO: Auco enruta el OTP por
  // número, así que dos partes con el mismo phone rompen el sobre. Caso típico
  // en pruebas: Cofianza configurada con el mismo número que el arrendatario.
  const porTelefono = new Map<string, string[]>();
  for (const x of conTelefono) {
    const key = x.phone as string;
    porTelefono.set(key, [...(porTelefono.get(key) ?? []), x.f.rol_firmante]);
  }
  const duplicados = [...porTelefono.values()].filter((roles) => roles.length > 1);
  if (duplicados.length > 0) {
    const partes = duplicados.map((roles) => roles.join(' y ')).join('; ');
    throw AppError.badRequest(
      `Hay firmantes con el mismo teléfono (${partes}). Cada parte necesita un número distinto para recibir su OTP por WhatsApp. Revisa el teléfono de Cofianza en Configuración o el del arrendador.`,
      'FIRMANTES_TELEFONO_DUPLICADO',
    );
  }

  // 3. Descargar PDF y subir UN documento con N firmantes
  const { data: pdfData, error: downloadError } = await supabase.storage
    .from(BUCKET_NAME)
    .download(c.storage_key);
  if (downloadError || !pdfData) {
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo descargar el PDF del contrato');
  }
  const pdfBase64 = aucoClient.bufferToBase64(Buffer.from(await pdfData.arrayBuffer()));

  const token = crypto.randomBytes(32).toString('hex');
  const tokenExpiracion = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  const signProfile = conTelefono.map((x) => buildSignProfileMultiparte(x.f, x.phone as string));

  let aucoDocumentCode: string;
  try {
    aucoDocumentCode = await aucoClient.uploadDocumentForSignature({
      email: env.AUCO_SENDER_EMAIL,
      name: `Contrato multi-parte - ${contratoId}`,
      subject: 'Firma de contrato de arrendamiento',
      message: 'Se le invita a revisar y firmar el contrato de arrendamiento.',
      file: pdfBase64,
      signProfile: signProfile as never,
      expiredDate: tokenExpiracion,
    });
  } catch (aucoError) {
    const detalle = aucoError instanceof Error ? aucoError.message : String(aucoError);
    logger.error({ error: detalle, contratoId }, 'Firma multi-parte: error al subir documento a Auco');
    throw AppError.badRequest(
      `No fue posible enviar el contrato a firma. Detalle: ${detalle}`,
      'AUCO_UPLOAD_FAILED',
    );
  }

  // 4. Insertar el SOBRE (solicitudes_firma) — un solo registro por contrato.
  //    Los campos nombre/email/telefono del sobre toman al primer firmante
  //    (arrendatario) por compatibilidad con las columnas NOT NULL.
  const primer = firmantes[0];
  const { data: sobre, error: sobreError } = await db('solicitudes_firma')
    .insert({
      contrato_id: contratoId,
      nombre_firmante: primer.nombre,
      email_firmante: primer.email,
      telefono_firmante: conTelefono[0]?.phone ?? primer.telefono,
      token,
      token_expiracion: tokenExpiracion,
      estado: 'enviado',
      envios_realizados: 1,
      max_envios: MAX_ENVIOS_DEFAULT,
      enviado_por: userId,
      auco_document_code: aucoDocumentCode,
    } as never)
    .select('id')
    .single();
  if (sobreError || !sobre) {
    logger.error({ error: sobreError?.message, contratoId }, 'Firma multi-parte: error al crear el sobre');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear la solicitud de firma');
  }
  const sobreId = (sobre as { id: string }).id;

  // 5. (Re)insertar las N filas de contrato_firmantes. Un reenvío crea un sobre
  //    nuevo y supersede los firmantes previos; el índice único
  //    (contrato_id, rol_firmante) impide duplicar, así que borramos los
  //    anteriores primero (cancelar la solicitud no los borra).
  await db('contrato_firmantes').delete().eq('contrato_id', contratoId);
  // Guardamos el teléfono NORMALIZADO (el que de verdad recibe el WhatsApp por
  // Auco, +57.../+52...), no el crudo del perfil — así el panel muestra a qué
  // número llega el link de cada parte.
  const filas = conTelefono.map(({ f, phone }) => ({
    contrato_id: contratoId,
    solicitud_firma_id: sobreId,
    rol_firmante: f.rol_firmante,
    nombre: f.nombre,
    email: f.email,
    telefono: phone,
    tipo_documento: f.tipo_documento,
    numero_documento: f.numero_documento,
    country: f.country,
    orden: f.orden,
    estado: 'enviado',
  }));
  const { error: firmantesError } = await db('contrato_firmantes').insert(filas as never);
  if (firmantesError) {
    logger.error({ error: firmantesError.message, contratoId }, 'Firma multi-parte: error al crear firmantes');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al registrar los firmantes del contrato');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.FIRMA_SOLICITUD_CREATED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: {
      solicitud_id: sobreId,
      auco_document_code: aucoDocumentCode,
      multiparte: true,
      firmantes: firmantes.map((f) => ({ rol: f.rol_firmante, orden: f.orden })),
    },
    ip,
  });

  logger.info(
    { contratoId, sobreId, aucoDocumentCode, firmantes: firmantes.length },
    'Firma multi-parte: sobre Auco creado con N firmantes',
  );

  return { solicitud_id: sobreId, auco_document_code: aucoDocumentCode, firmantes: firmantes.length };
}

// ============================================================
// Fase 4 — Reconciliar el estado por firmante desde Auco (poll)
// ============================================================

/**
 * Consulta Auco (getDocumentStatus) y actualiza cada fila contrato_firmantes
 * según signProfile[].status, casando por email. Cuando todas las filas quedan
 * 'firmado', dispara el cierre del contrato (executePostFirma). Idempotente.
 */
export async function reconciliarFirmantesConAuco(contratoId: string): Promise<void> {
  // 1. Sobre activo del contrato
  const { data: sobreRow } = await db('solicitudes_firma')
    .select('id, estado, auco_document_code')
    .eq('contrato_id', contratoId)
    .not('auco_document_code', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const sobre = sobreRow as { id: string; estado: string; auco_document_code: string } | null;
  if (!sobre?.auco_document_code) return;

  // 2. Estado por firmante desde Auco
  let info: Awaited<ReturnType<typeof aucoClient.getDocumentStatus>>;
  try {
    info = await aucoClient.getDocumentStatus(sobre.auco_document_code);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), contratoId },
      'Firma multi-parte: error consultando Auco — se reintenta luego',
    );
    return;
  }
  const aucoSigners = info.signProfile ?? [];

  // 3. Filas locales
  const { data: filasRow } = await db('contrato_firmantes')
    .select('id, rol_firmante, email, estado, orden')
    .eq('contrato_id', contratoId);
  const filas = (filasRow as FirmanteRow[] | null) ?? [];
  if (filas.length === 0) return;

  const now = new Date().toISOString();
  for (const fila of filas) {
    const match = aucoSigners.find((s) => s.email?.toLowerCase() === fila.email.toLowerCase());
    if (!match) continue;
    const nuevoEstado = mapAucoSignerStatusToEstado(match.status);
    if (!nuevoEstado || nuevoEstado === fila.estado) continue;
    if (['firmado', 'cancelado'].includes(fila.estado)) continue; // terminal local

    const update: Record<string, unknown> = { estado: nuevoEstado, auco_signer_id: match.id, updated_at: now };
    if (nuevoEstado === 'firmado') update.firmado_en = now;
    await db('contrato_firmantes').update(update as never).eq('id', fila.id);
    logger.info({ contratoId, rol: fila.rol_firmante, nuevoEstado }, 'Firma multi-parte: firmante reconciliado');
  }

  // 4. ¿Todas firmaron? → cerrar sobre + post-firma
  await cerrarSobreSiTodasFirmaron(contratoId, { id: sobre.id, estado: sobre.estado }, info.url ?? null);
}

/**
 * Si TODAS las filas de contrato_firmantes están 'firmado', marca el sobre como
 * firmado y dispara executePostFirma (contrato → firmado, timeline, acuses).
 * Idempotente. Compartido por la reconciliación por poll y por webhook.
 */
async function cerrarSobreSiTodasFirmaron(
  contratoId: string,
  sobre: { id: string; estado: string },
  signedUrl: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const { data: refrescadas } = await db('contrato_firmantes')
    .select('estado')
    .eq('contrato_id', contratoId);
  const todas = (refrescadas as Array<{ estado: string }> | null) ?? [];
  if (!todasFirmaron(todas)) return;

  if (sobre.estado !== 'firmado') {
    await db('solicitudes_firma')
      .update({ estado: 'firmado', firmado_en: now, auco_signed_url: signedUrl, updated_at: now } as never)
      .eq('id', sobre.id);
  }

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.FIRMA_AUCO_SIGNED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: { solicitud_id: sobre.id, multiparte: true },
  });

  const { executePostFirma } = await import('./post-firma.service');
  await executePostFirma({
    solicitudId: sobre.id,
    contratoId,
    nombreFirmante: 'todas las partes',
    emailFirmante: '',
    firmadoEn: now,
  }).catch((err) => logger.error({ error: err, contratoId }, 'Firma multi-parte: error en executePostFirma'));

  // Cierre SÍNCRONO del pipeline tras firma: contrato firmado → vigente,
  // expediente → cerrado, inmueble → ocupado (fuera de vitrina). Antes esto solo
  // ocurría de forma DIFERIDA (auto-heal al listar contratos), lo que dejaba el
  // stepper "trabado" en Firma y el inmueble sin marcar como ocupado hasta un
  // refresco posterior. Idempotente (maybeAutoActivarVigente guarda por estado).
  try {
    const { data: cRow } = await db('contratos')
      .select('expediente_id')
      .eq('id', contratoId)
      .single() as { data: { expediente_id: string } | null };
    if (cRow?.expediente_id) {
      const { maybeAutoActivarVigente } = await import('@/modules/contratos/contratos.service');
      await maybeAutoActivarVigente(contratoId, cRow.expediente_id);
    }
  } catch (err) {
    logger.error({ error: err, contratoId }, 'Firma multi-parte: error activando contrato a vigente tras firma');
  }
}

/**
 * Reconcilia los firmantes multi-parte desde el PAYLOAD del webhook de Auco, SIN
 * llamar a getDocumentStatus (que en stage devuelve 401 y rompía la sync).
 * Eventos Auco (docs/api/webhooks/document):
 *   - NOTIFICATION (+ signer): ese participante COMPLETÓ su firma → 'firmado'
 *   - REJECTED / BLOCKED (+ signer): ese firmante rechazó/bloqueó → 'cancelado'
 *   - FINISH (sin signer): TODAS las partes firmaron → marca pendientes 'firmado'
 * Cuando todas quedan 'firmado', cierra el sobre + executePostFirma.
 */
export async function reconciliarFirmantesPorWebhook(
  contratoId: string,
  sobre: { id: string; estado: string },
  payload: { status: string; url?: string; signer?: { id?: string; email?: string | null } | null },
): Promise<void> {
  const now = new Date().toISOString();
  const status = payload.status;
  const signerEmail = payload.signer?.email ?? null;

  if (signerEmail && status === 'NOTIFICATION') {
    await db('contrato_firmantes')
      .update({ estado: 'firmado', firmado_en: now, auco_signer_id: payload.signer?.id ?? null, updated_at: now } as never)
      .eq('contrato_id', contratoId)
      .eq('email', signerEmail)
      .neq('estado', 'firmado');
    logger.info({ contratoId, email: signerEmail }, 'Firma multi-parte: firmante firmado (webhook)');
  } else if (signerEmail && (status === 'REJECTED' || status === 'BLOCKED')) {
    await db('contrato_firmantes')
      .update({ estado: 'cancelado', updated_at: now } as never)
      .eq('contrato_id', contratoId)
      .eq('email', signerEmail);
    logger.info({ contratoId, email: signerEmail, status }, 'Firma multi-parte: firmante cancelado (webhook)');
  } else if (status === 'FINISH') {
    await db('contrato_firmantes')
      .update({ estado: 'firmado', firmado_en: now, updated_at: now } as never)
      .eq('contrato_id', contratoId)
      .neq('estado', 'firmado')
      .neq('estado', 'cancelado');
    logger.info({ contratoId }, 'Firma multi-parte: todas firmadas (webhook FINISH)');
  } else {
    return;
  }

  await cerrarSobreSiTodasFirmaron(contratoId, sobre, payload.url ?? null);
}

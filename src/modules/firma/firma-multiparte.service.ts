/**
 * Firma multi-parte (M1) — un solo sobre Auco con varios firmantes.
 *
 * El contrato de afianzamiento lo firman TODAS las partes:
 *   1. arrendatario (solicitante)
 *   2. arrendador   (inmobiliaria → representante legal, o propietario individual)
 *   3. cofianza      (afianzadora)
 *
 * Modelo: un único documento Auco (signProfile[] con `order` para firma
 * secuencial) → un `auco_document_code` → un sobre `solicitudes_firma` + N filas
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
import { COMPANY } from '@/config/company';
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
  // Si el NIT sigue siendo placeholder (contiene X), no lo mandamos a Auco:
  // un identification inválido puede romper el flujo. El OTP por WhatsApp no
  // requiere el documento.
  const nitEsPlaceholder = /x/i.test(COMPANY.nit);
  firmantes.push({
    rol_firmante: 'cofianza',
    nombre: COMPANY.name,
    email: COMPANY.email,
    telefono: COMPANY.phone,
    tipo_documento: nitEsPlaceholder ? null : 'NIT',
    numero_documento: nitEsPlaceholder ? null : COMPANY.nit,
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

/** Perfil de firma WhatsApp para Auco (OTP por phone) con orden secuencial. */
function buildSignProfileMultiparte(f: FirmanteDerivado, phoneInternational: string) {
  const tipoAuco = mapTipoDocumentoToAuco(f.tipo_documento);
  const country = aucoDeriveCountry(phoneInternational) || f.country;
  const profile: Record<string, unknown> = {
    name: f.nombre,
    email: f.email,
    phone: phoneInternational,
    // Auco exige al menos uno de [type, label, position]; usamos position
    // (mismo default que el flujo de un firmante que ya funciona).
    position: [{ page: 1, x: 0.6, y: 0.85, w: 150, h: 50 }],
    // `order` controla la firma secuencial (1 = primero).
    order: String(f.orden),
    otpCode: true,
    options: { whatsapp: true, otpCode: 'phone' },
  };
  if (f.numero_documento) profile.identification = f.numero_documento;
  if (tipoAuco) profile.identificationType = tipoAuco;
  if (country) profile.country = country;
  return profile;
}

function mapTipoDocumentoToAuco(tipo: string | null | undefined): string | null {
  if (!tipo) return null;
  const t = tipo.trim().toLowerCase();
  const map: Record<string, string> = { cc: 'CC', ce: 'CE', ti: 'TI', nit: 'NIT', pasaporte: 'PASAPORTE' };
  return map[t] ?? t.toUpperCase();
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
      telefono_firmante: primer.telefono,
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

  // 5. Insertar las N filas de contrato_firmantes
  const filas = firmantes.map((f) => ({
    contrato_id: contratoId,
    solicitud_firma_id: sobreId,
    rol_firmante: f.rol_firmante,
    nombre: f.nombre,
    email: f.email,
    telefono: f.telefono,
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
  const { data: refrescadas } = await db('contrato_firmantes')
    .select('estado')
    .eq('contrato_id', contratoId);
  const todas = (refrescadas as Array<{ estado: string }> | null) ?? [];
  if (!todasFirmaron(todas)) return;

  if (sobre.estado !== 'firmado') {
    await db('solicitudes_firma')
      .update({ estado: 'firmado', firmado_en: now, auco_signed_url: info.url ?? null, updated_at: now } as never)
      .eq('id', sobre.id);
  }

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.FIRMA_AUCO_SIGNED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: { solicitud_id: sobre.id, auco_code: sobre.auco_document_code, multiparte: true },
  });

  const { executePostFirma } = await import('./post-firma.service');
  await executePostFirma({
    solicitudId: sobre.id,
    contratoId,
    nombreFirmante: 'todas las partes',
    emailFirmante: '',
    firmadoEn: now,
  }).catch((err) => logger.error({ error: err, contratoId }, 'Firma multi-parte: error en executePostFirma'));
}

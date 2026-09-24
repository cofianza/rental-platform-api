// ============================================================
// Expediente — Soportes adicionales para flujo condicionado
//
// Cuando el buró devuelve resultado='condicionado', el propietario pide
// documentación adicional al solicitante (codeudor, póliza, certificación
// laboral, etc.). Estos endpoints permiten:
//
//   - Solicitante: subir SUS soportes (presigned URL + confirmar).
//   - Propietario / inmobiliaria / admin / operador: listar y descargar
//     los soportes para tomar la decisión manual de aprobar.
//
// Reusa la tabla `estudios_documentos_soporte` (compartida con el flujo
// de re-evaluación) y el bucket 'documentos-expedientes'. La diferencia
// con el flujo de re-evaluación es el ownership: aquí el solicitante
// también puede escribir, restringido al estudio activo de SU expediente.
// ============================================================

import crypto from 'crypto';
import { assertStorageKeyPropia } from '@/lib/storageKey';
import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config';
import { notificarUsuario, notificarResponsableExpediente } from '../notificaciones/notificaciones.service';
import { assertExpedienteAccess } from '@/lib/tenantScope';
import { firmarUrlsVista } from '../documentos/documentos.service';

const BUCKET_NAME = 'documentos-expedientes';
const MAX_SOPORTE_BYTES = 10 * 1024 * 1024; // 10MB

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const PROPOSITOS_VALIDOS = [
  'certificacion_laboral',
  'extractos_bancarios',
  'declaracion_renta',
  'carta_referencia',
  'codeudor',
  'poliza',
  'otros_soportes',
] as const;
type Proposito = (typeof PROPOSITOS_VALIDOS)[number];

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MIME_VALIDOS = ['application/pdf', 'image/jpeg', 'image/png'] as const;
type MimeValido = (typeof MIME_VALIDOS)[number];

function getExtensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
  };
  return map[mime] || 'bin';
}

type EstudioEmbed = { id: string; created_at: string; tipo: string | null };

/**
 * Estudio activo = el más reciente DEL TITULAR. El 'con_coarrendatario' se crea
 * después, cuando el invitado acepta: si contara, los soportes del titular
 * dejaban de listarse y las cargas nuevas quedaban colgadas del estudio del
 * co-arrendatario.
 */
export function estudioActivoDelTitular(estudios: EstudioEmbed[] | null): EstudioEmbed | null {
  const delTitular = (estudios ?? []).filter((e) => e.tipo !== 'con_coarrendatario');
  return (
    delTitular.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ?? null
  );
}

interface SoporteAccessCtx {
  expedienteId: string;
  estudioActivoId: string;
  estado: string;
  esSolicitante: boolean;
  esPropietario: boolean;
  esAdmin: boolean;
  solicitanteUserId: string | null;
  propietarioId: string | null;
}

/**
 * Permission guard común. Devuelve el contexto del expediente más quién es
 * el caller — el caller decide si la operación específica (subir vs listar)
 * está permitida según su rol.
 *
 * Reglas:
 *   - admin / operador → pasa siempre.
 *   - propietario / inmobiliaria → el estudio debe estar en su cartera.
 *   - solicitante → debe ser el creador del expediente o el solicitante asociado.
 *   - otros roles (gerencia_consulta) → 403.
 *
 * Asume que el expediente existe y tiene un estudio asociado (al menos
 * habilitado). Si no, lanza notFound o badRequest.
 */
async function assertSoporteAccess(
  expedienteId: string,
  userId: string,
  userRol: string,
): Promise<SoporteAccessCtx> {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, estado, creado_por, ' +
        'inmuebles!expedientes_inmueble_id_fkey(propietario_id, inmobiliaria_id), ' +
        'solicitantes(creado_por), ' +
        'estudios(id, created_at, tipo)',
    )
    .eq('id', expedienteId)
    .single();

  if (error || !data) {
    if (error?.code === 'PGRST116') {
      throw AppError.notFound('Estudio no encontrado');
    }
    logger.error({ error: error?.message, expedienteId }, 'Error al cargar estudio para soportes');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al cargar el estudio');
  }

  const row = data as unknown as {
    id: string;
    estado: string;
    creado_por: string | null;
    inmuebles: { propietario_id: string; inmobiliaria_id: string | null } | null;
    solicitantes: { creado_por: string | null } | null;
    estudios: EstudioEmbed[] | null;
  };

  // Si no hay estudio del titular todavía, no tiene sentido subir soportes.
  const estudioActivo = estudioActivoDelTitular(row.estudios);
  if (!estudioActivo) {
    throw AppError.badRequest(
      'Este estudio aún no tiene una evaluación crediticia habilitada.',
      'SIN_ESTUDIO',
    );
  }

  const esAdmin = userRol === 'administrador' || userRol === 'operador_analista';
  const esPropietarioRol = userRol === 'propietario' || userRol === 'inmobiliaria';
  const esSolicitanteRol = userRol === 'solicitante';

  const propietarioId = row.inmuebles?.propietario_id ?? null;
  const solicitanteUserId = row.solicitantes?.creado_por ?? row.creado_por ?? null;

  // El propietario/inmobiliaria accede si el estudio está en su cartera (un
  // miembro restringido solo ve lo suyo o lo que le asignaron).
  const esDuenoOrg = esPropietarioRol
    ? await assertExpedienteAccess(expedienteId, userId, userRol).then(
        () => true,
        () => false,
      )
    : false;

  let allowed = false;
  if (esAdmin) allowed = true;
  else if (esPropietarioRol) allowed = esDuenoOrg;
  else if (esSolicitanteRol) allowed = solicitanteUserId === userId;

  if (!allowed) {
    throw AppError.forbidden(
      'No tienes permisos para acceder a los soportes de este estudio',
      'EXPEDIENTE_FORBIDDEN',
    );
  }

  return {
    expedienteId: row.id,
    estudioActivoId: estudioActivo.id,
    estado: row.estado,
    esSolicitante: esSolicitanteRol && solicitanteUserId === userId,
    esPropietario: esDuenoOrg,
    esAdmin,
    solicitanteUserId,
    propietarioId,
  };
}

// ============================================================
// 1. Generar presigned URL para subir un soporte
// ============================================================

interface PresignedSoporteInput {
  nombre_original: string;
  tipo_mime: MimeValido;
  tamano_bytes: number;
  proposito: Proposito;
}

export async function generarPresignedUrlSoporte(
  expedienteId: string,
  userId: string,
  userRol: string,
  input: PresignedSoporteInput,
): Promise<{
  signed_url: string;
  storage_key: string;
  nombre_archivo: string;
  expires_in: number;
}> {
  const ctx = await assertSoporteAccess(expedienteId, userId, userRol);

  // Reglas de negocio: solo se aceptan subidas mientras el expediente está
  // 'condicionado'. Para 'aprobado' / 'rechazado' / 'cerrado' bloqueamos.
  if (ctx.estado !== 'condicionado') {
    throw AppError.badRequest(
      `Solo se pueden subir soportes cuando el estudio está "condicionado". Estado actual: ${ctx.estado}.`,
      'EXPEDIENTE_NO_CONDICIONADO',
    );
  }

  if (input.tamano_bytes > MAX_SOPORTE_BYTES) {
    throw AppError.badRequest('Archivo demasiado grande (máximo 10MB)', 'FILE_TOO_LARGE');
  }

  const ext = getExtensionFromMime(input.tipo_mime);
  const nombreArchivo = `${crypto.randomUUID()}.${ext}`;
  const storageKey = `expedientes/${expedienteId}/soportes/${nombreArchivo}`;

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUploadUrl(storageKey);

  if (error || !data) {
    logger.error({ error: error?.message, expedienteId }, 'Error al crear signed URL para soporte');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de subida');
  }

  return {
    signed_url: data.signedUrl,
    storage_key: storageKey,
    nombre_archivo: nombreArchivo,
    expires_in: 900,
  };
}

// ============================================================
// 2. Confirmar subida (registrar en DB)
// ============================================================

interface ConfirmarSoporteInput {
  storage_key: string;
  nombre_original: string;
  tipo_mime: MimeValido;
  tamano_bytes: number;
  proposito: Proposito;
}

export async function confirmarSoporte(
  expedienteId: string,
  userId: string,
  userRol: string,
  input: ConfirmarSoporteInput,
): Promise<{
  id: string;
  proposito: Proposito;
  nombre_original: string;
  archivo_url: string | null;
}> {
  const ctx = await assertSoporteAccess(expedienteId, userId, userRol);

  if (ctx.estado !== 'condicionado') {
    throw AppError.badRequest(
      `Solo se pueden registrar soportes cuando el estudio está "condicionado". Estado actual: ${ctx.estado}.`,
      'EXPEDIENTE_NO_CONDICIONADO',
    );
  }

  // Verificar que el archivo realmente existe en storage (anti-spoof: el
  // cliente podría confirmar sin haber subido nada) y que sea de este estudio.
  assertStorageKeyPropia(input.storage_key, `expedientes/${expedienteId}/soportes/`);
  const { error: existsErr } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(input.storage_key, 60);

  if (existsErr) {
    throw AppError.badRequest(
      'El archivo no se encontró en storage. Súbelo primero antes de confirmar.',
      'ARCHIVO_NOT_FOUND',
    );
  }

  const { data: doc, error: insertErr } = await (supabase
    .from('estudios_documentos_soporte' as string) as ReturnType<typeof supabase.from>)
    .insert({
      estudio_id: ctx.estudioActivoId,
      storage_key: input.storage_key,
      nombre_original: input.nombre_original,
      tipo_mime: input.tipo_mime,
      tamano_bytes: input.tamano_bytes,
      proposito: input.proposito,
      subido_por: userId,
    } as never)
    .select('id, proposito, nombre_original, storage_key')
    .single();

  if (insertErr || !doc) {
    logger.error({ error: insertErr?.message, expedienteId }, 'Error al registrar soporte');
    throw AppError.badRequest('Error al registrar el documento', 'SOPORTE_INSERT_ERROR');
  }

  const docTyped = doc as unknown as {
    id: string;
    proposito: Proposito;
    nombre_original: string;
    storage_key: string;
  };

  // Avisar que el solicitante subió un documento — fire and forget.
  if (ctx.esSolicitante) {
    avisarSoporteNuevo(expedienteId, ctx.propietarioId, docTyped.id, input.proposito, '');
  }

  // Generar URL view para devolverla al cliente (1h).
  const { data: urlData } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(docTyped.storage_key, 3600);

  return {
    id: docTyped.id,
    proposito: docTyped.proposito,
    nombre_original: docTyped.nombre_original,
    archivo_url: urlData?.signedUrl || null,
  };
}

/**
 * Aviso de un soporte nuevo del solicitante. En el condicionado decide un
 * analista de Cofianza (Adenda 2 §5): sin su aviso el caso quedaba quieto
 * hasta que alguien lo reabriera. El dueño y el miembro responsable se
 * enteran, pero no aprueban.
 */
function avisarSoporteNuevo(
  expedienteId: string,
  propietarioId: string | null,
  soporteId: string,
  proposito: Proposito,
  dondeInmueble: string,
): void {
  const doc = proposito.replace(/_/g, ' ');
  const link = `/expedientes/${expedienteId}`;
  const payload = { expediente_id: expedienteId, soporte_id: soporteId, proposito };
  const alGestor = {
    tipo: 'soporte.subido',
    titulo: 'Nuevo documento del solicitante',
    mensaje: `El solicitante subió un documento (${doc})${dondeInmueble}. Cofianza lo tendrá en cuenta al decidir.`,
    link,
    payload,
  };

  void (async () => {
    const { listOperators } = await import('@/modules/users/users.service');
    const analistas = await listOperators().catch(() => []);
    await Promise.all([
      ...analistas.map((a) =>
        notificarUsuario({
          userId: a.id,
          tipo: 'estudio.revision_manual',
          titulo: 'Nuevo soporte en un estudio condicionado',
          mensaje: `El solicitante subió un documento (${doc}). Tenlo en cuenta al decidir la revisión manual.`,
          link,
          payload,
        }),
      ),
      propietarioId ? notificarUsuario({ userId: propietarioId, ...alGestor }) : undefined,
      notificarResponsableExpediente({ expedienteId, excluirPerfilId: propietarioId, ...alGestor }),
    ]);
  })().catch((e) => logger.warn({ error: e, expedienteId }, 'Error notificando soporte subido'));
}

// ============================================================
// 3. Listar soportes de un expediente
// ============================================================

export interface SoporteListItem {
  id: string;
  proposito: Proposito;
  nombre_original: string;
  tipo_mime: string;
  tamano_bytes: number;
  subido_por: string | null;
  subido_por_nombre: string | null;
  created_at: string;
  archivo_url: string | null; // signed URL view (1h)
}

export async function listarSoportes(
  expedienteId: string,
  userId: string,
  userRol: string,
): Promise<SoporteListItem[]> {
  const ctx = await assertSoporteAccess(expedienteId, userId, userRol);

  const { data: docs, error } = await (supabase
    .from('estudios_documentos_soporte' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, proposito, nombre_original, tipo_mime, tamano_bytes, subido_por, storage_key, created_at, ' +
        'subido_por_perfil:perfiles!estudios_documentos_soporte_subido_por_fkey(nombre, apellido)',
    )
    .eq('estudio_id', ctx.estudioActivoId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al listar soportes');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al listar los documentos');
  }

  if (!docs || docs.length === 0) return [];

  const docsTyped = docs as unknown as Array<{
    id: string;
    proposito: Proposito;
    nombre_original: string;
    tipo_mime: string;
    tamano_bytes: number;
    subido_por: string | null;
    storage_key: string;
    created_at: string;
    subido_por_perfil: { nombre: string | null; apellido: string | null } | null;
  }>;

  // Nombre de quien subió por embed y todas las URLs en una sola firma.
  const urls = await firmarUrlsVista(docsTyped.map((d) => d.storage_key));
  const result = docsTyped.map((d) => ({
    id: d.id,
    proposito: d.proposito,
    nombre_original: d.nombre_original,
    tipo_mime: d.tipo_mime,
    tamano_bytes: d.tamano_bytes,
    subido_por: d.subido_por,
    subido_por_nombre: d.subido_por_perfil
      ? `${d.subido_por_perfil.nombre ?? ''} ${d.subido_por_perfil.apellido ?? ''}`.trim() || null
      : null,
    created_at: d.created_at,
    archivo_url: urls.get(d.storage_key) ?? null,
  }));

  // Hush unused warning: supabaseAuth es importable aunque no lo usemos aquí.
  void supabaseAuth;

  return result;
}

// ============================================================
// Flujo PÚBLICO por token — el solicitante carga sus soportes sin cuenta.
// La inmobiliaria genera y envía el enlace; el token autoriza la carga.
// ============================================================

const TOKEN_DOCS_EXPIRY_DAYS = 14;

interface TokenDocsCtx {
  expedienteId: string;
  estudioActivoId: string;
  estado: string;
  propietarioId: string | null;
  solicitanteNombre: string;
  inmuebleDireccion: string;
  inmuebleCiudad: string;
}

/**
 * Resuelve el expediente a partir del token público de carga (valida vigencia).
 * También lo usa la invitación del co-arrendatario desde el enlace (P18).
 */
export async function resolveExpedientePorTokenDocumentos(token: string): Promise<TokenDocsCtx> {
  const { data } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, token_documentos_expiracion, inmuebles!expedientes_inmueble_id_fkey(propietario_id, direccion, ciudad), solicitantes(nombre, apellido), estudios(id, created_at, tipo)')
    .eq('token_documentos', token)
    .maybeSingle();

  const row = data as unknown as {
    id: string;
    estado: string;
    token_documentos_expiracion: string | null;
    inmuebles: { propietario_id: string | null; direccion: string | null; ciudad: string | null } | null;
    solicitantes: { nombre: string | null; apellido: string | null } | null;
    estudios: EstudioEmbed[] | null;
  } | null;

  if (!row) throw AppError.notFound('Enlace de carga no válido', 'TOKEN_INVALIDO');
  if (row.token_documentos_expiracion && new Date(row.token_documentos_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de carga ha expirado. Pide uno nuevo a la inmobiliaria.', 'TOKEN_EXPIRADO');
  }
  const estudioActivo = estudioActivoDelTitular(row.estudios);
  if (!estudioActivo) throw AppError.badRequest('El estudio aún no tiene evaluación.', 'SIN_ESTUDIO');

  return {
    expedienteId: row.id,
    estudioActivoId: estudioActivo.id,
    estado: row.estado,
    propietarioId: row.inmuebles?.propietario_id ?? null,
    solicitanteNombre: `${row.solicitantes?.nombre ?? ''} ${row.solicitantes?.apellido ?? ''}`.trim() || 'Solicitante',
    inmuebleDireccion: row.inmuebles?.direccion ?? '',
    inmuebleCiudad: row.inmuebles?.ciudad ?? '',
  };
}

/**
 * Token del enlace público del prospecto: sus soportes y, desde P18, su
 * co-arrendatario. El vigente se conserva (con el plazo renovado), así el
 * enlace del correo del condicionado y el que envía la inmobiliaria son el
 * mismo y ninguno deja muerto al otro.
 */
export async function emitirTokenDocumentos(expedienteId: string): Promise<string> {
  const { data } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('token_documentos, token_documentos_expiracion')
    .eq('id', expedienteId)
    .maybeSingle();
  const actual = data as { token_documentos: string | null; token_documentos_expiracion: string | null } | null;
  const vigente =
    !!actual?.token_documentos &&
    (!actual.token_documentos_expiracion || new Date(actual.token_documentos_expiracion) > new Date());
  const token = vigente ? actual!.token_documentos! : crypto.randomBytes(32).toString('hex');
  const expiracion = new Date(Date.now() + TOKEN_DOCS_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .update({ token_documentos: token, token_documentos_expiracion: expiracion } as never)
    .eq('id', expedienteId);
  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al guardar token de documentos');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo generar el enlace');
  }
  return token;
}

/** Genera+persiste el token y envía el enlace público de carga al solicitante. */
export async function enviarEnlaceDocumentos(
  expedienteId: string,
  userId: string,
  userRol: string,
): Promise<{ ok: true; email_destino: string }> {
  const ctx = await assertSoporteAccess(expedienteId, userId, userRol);
  if (ctx.estado !== 'condicionado') {
    throw AppError.badRequest(
      `Solo se puede enviar el enlace de documentos cuando el estudio está "condicionado". Estado actual: ${ctx.estado}.`,
      'EXPEDIENTE_NO_CONDICIONADO',
    );
  }

  const { data: exp } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('solicitantes(nombre, apellido, email), inmuebles!expedientes_inmueble_id_fkey(direccion, ciudad)')
    .eq('id', expedienteId)
    .single();
  const e = exp as unknown as {
    solicitantes: { nombre: string | null; apellido: string | null; email: string | null } | null;
    inmuebles: { direccion: string | null; ciudad: string | null } | null;
  } | null;

  const email = e?.solicitantes?.email;
  if (!email) {
    throw AppError.badRequest('El solicitante no tiene email registrado para enviarle el enlace.', 'SIN_EMAIL_SOLICITANTE');
  }
  const nombre = `${e?.solicitantes?.nombre ?? ''} ${e?.solicitantes?.apellido ?? ''}`.trim() || 'Solicitante';
  const direccion = e?.inmuebles?.direccion ?? 'tu inmueble';

  const link = `/cargar-documentos/${await emitirTokenDocumentos(expedienteId)}`;
  try {
    const { sendResponsableAsignadoEmail } = await import('../orchestrator/orchestrator.emails');
    await sendResponsableAsignadoEmail({
      email,
      nombre,
      titulo: 'Carga tus documentos',
      mensaje: `Para continuar con tu solicitud de arriendo del inmueble en ${direccion}, sube los documentos solicitados desde el siguiente enlace personal. Desde ahí también puedes invitar a tu co-arrendatario.`,
      link,
      frontend_url: env.FRONTEND_URL,
    });
  } catch (err) {
    logger.warn({ error: (err as Error).message, expedienteId }, 'No se pudo enviar email de enlace de documentos (token ya guardado)');
  }

  logger.info({ expedienteId, email }, 'Enlace de carga de documentos enviado al solicitante');
  return { ok: true, email_destino: email };
}

/**
 * P18: lo que el prospecto ve de su co-arrendatario en su enlace. De la persona
 * invitada, solo el nombre y en qué va (Ley 1266: su resultado no es suyo); lo
 * sugerido es lo que él mismo declaró al autorizar (§8.3), para no repetirlo.
 */
interface CoarrendatarioDelProspecto {
  puede_invitar: boolean;
  invitado: { nombre: string; estado: string } | null;
  sugerido: { nombre: string; apellido: string; email?: string; telefono?: string } | null;
}

/** Contexto público (sin auth): qué inmueble/solicitante, qué ya subió y su co-arrendatario. */
export async function getContextoDocumentosPublico(token: string): Promise<{
  solicitante: string;
  inmueble: { direccion: string; ciudad: string };
  estado: string;
  puede_subir: boolean;
  soportes: Array<{ id: string; proposito: Proposito; nombre_original: string; created_at: string }>;
  coarrendatario: CoarrendatarioDelProspecto;
}> {
  const ctx = await resolveExpedientePorTokenDocumentos(token);
  const condicionado = ctx.estado === 'condicionado';

  const [{ data: docs }, { data: coa }, { data: perfil }] = await Promise.all([
    (supabase.from('estudios_documentos_soporte' as string) as ReturnType<typeof supabase.from>)
      .select('id, proposito, nombre_original, created_at')
      .eq('estudio_id', ctx.estudioActivoId)
      .order('created_at', { ascending: false }),
    // Una sola activa por estudio (índice único): no hace falta limit.
    (supabase.from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
      .select('nombre, estado')
      .eq('expediente_id', ctx.expedienteId)
      .in('estado', ['pendiente_aceptacion', 'aceptado', 'estudio_completado'])
      .maybeSingle(),
    condicionado
      ? (supabase.from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
          .select('coarrendatario_intencion')
          .eq('expediente_id', ctx.expedienteId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const invitado = (coa as { nombre: string; estado: string } | null) ?? null;
  const puedeInvitar = condicionado && !invitado;

  return {
    solicitante: ctx.solicitanteNombre,
    inmueble: { direccion: ctx.inmuebleDireccion, ciudad: ctx.inmuebleCiudad },
    estado: ctx.estado,
    puede_subir: condicionado,
    soportes: (docs as Array<{ id: string; proposito: Proposito; nombre_original: string; created_at: string }> | null) ?? [],
    coarrendatario: {
      puede_invitar: puedeInvitar,
      invitado,
      sugerido: puedeInvitar
        ? ((perfil as { coarrendatario_intencion?: CoarrendatarioDelProspecto['sugerido'] } | null)?.coarrendatario_intencion ?? null)
        : null,
    },
  };
}

/** Presigned URL para subir un soporte vía token público. */
export async function presignedUrlSoportePublico(
  token: string,
  input: PresignedSoporteInput,
): Promise<{ signed_url: string; storage_key: string; nombre_archivo: string; expires_in: number }> {
  const ctx = await resolveExpedientePorTokenDocumentos(token);
  if (ctx.estado !== 'condicionado') {
    throw AppError.badRequest('Este estudio ya no admite cargar documentos.', 'EXPEDIENTE_NO_CONDICIONADO');
  }
  if (input.tamano_bytes > MAX_SOPORTE_BYTES) {
    throw AppError.badRequest('Archivo demasiado grande (máximo 10MB)', 'FILE_TOO_LARGE');
  }

  const ext = getExtensionFromMime(input.tipo_mime);
  const nombreArchivo = `${crypto.randomUUID()}.${ext}`;
  const storageKey = `expedientes/${ctx.expedienteId}/soportes/${nombreArchivo}`;

  const { data, error } = await supabase.storage.from(BUCKET_NAME).createSignedUploadUrl(storageKey);
  if (error || !data) {
    logger.error({ error: error?.message, expedienteId: ctx.expedienteId }, 'Error signed URL soporte público');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al generar URL de subida');
  }
  return { signed_url: data.signedUrl, storage_key: storageKey, nombre_archivo: nombreArchivo, expires_in: 900 };
}

/** Confirma (registra) un soporte subido vía token público. subido_por = null. */
export async function confirmarSoportePublico(
  token: string,
  input: ConfirmarSoporteInput,
): Promise<{ id: string; proposito: Proposito; nombre_original: string }> {
  const ctx = await resolveExpedientePorTokenDocumentos(token);
  if (ctx.estado !== 'condicionado') {
    throw AppError.badRequest('Este estudio ya no admite cargar documentos.', 'EXPEDIENTE_NO_CONDICIONADO');
  }

  assertStorageKeyPropia(input.storage_key, `expedientes/${ctx.expedienteId}/soportes/`);
  const { error: existsErr } = await supabase.storage.from(BUCKET_NAME).createSignedUrl(input.storage_key, 60);
  if (existsErr) {
    throw AppError.badRequest('El archivo no se encontró en storage. Súbelo primero antes de confirmar.', 'ARCHIVO_NOT_FOUND');
  }

  const { data: doc, error: insertErr } = await (supabase
    .from('estudios_documentos_soporte' as string) as ReturnType<typeof supabase.from>)
    .insert({
      estudio_id: ctx.estudioActivoId,
      storage_key: input.storage_key,
      nombre_original: input.nombre_original,
      tipo_mime: input.tipo_mime,
      tamano_bytes: input.tamano_bytes,
      proposito: input.proposito,
      subido_por: null,
    } as never)
    .select('id, proposito, nombre_original')
    .single();

  if (insertErr || !doc) {
    logger.error({ error: insertErr?.message, expedienteId: ctx.expedienteId }, 'Error al registrar soporte público');
    throw AppError.badRequest('Error al registrar el documento', 'SOPORTE_INSERT_ERROR');
  }
  const docTyped = doc as unknown as { id: string; proposito: Proposito; nombre_original: string };

  // Avisar que el solicitante subió un documento — fire and forget.
  avisarSoporteNuevo(
    ctx.expedienteId,
    ctx.propietarioId,
    docTyped.id,
    input.proposito,
    ` para ${ctx.inmuebleDireccion || 'el inmueble'}`,
  );

  return { id: docTyped.id, proposito: docTyped.proposito, nombre_original: docTyped.nombre_original };
}

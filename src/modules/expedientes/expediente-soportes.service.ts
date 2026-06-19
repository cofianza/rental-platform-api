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
import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { notificarUsuario } from '../notificaciones/notificaciones.service';
import { perfilEsDuenoDeInmueble } from '@/lib/tenantScope';

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
 *   - propietario / inmobiliaria → debe ser dueño del inmueble.
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
        'inmuebles(propietario_id, inmobiliaria_id), ' +
        'solicitantes(creado_por), ' +
        'estudios(id, created_at)',
    )
    .eq('id', expedienteId)
    .single();

  if (error || !data) {
    if (error?.code === 'PGRST116') {
      throw AppError.notFound('Expediente no encontrado');
    }
    logger.error({ error: error?.message, expedienteId }, 'Error al cargar expediente para soportes');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al cargar el expediente');
  }

  const row = data as unknown as {
    id: string;
    estado: string;
    creado_por: string | null;
    inmuebles: { propietario_id: string; inmobiliaria_id: string | null } | null;
    solicitantes: { creado_por: string | null } | null;
    estudios: Array<{ id: string; created_at: string }> | null;
  };

  // Estudio activo = el más reciente. Si no hay estudios todavía, no
  // tiene sentido subir soportes — se aborta.
  const estudios = row.estudios ?? [];
  if (estudios.length === 0) {
    throw AppError.badRequest(
      'Este expediente aún no tiene un estudio crediticio habilitado.',
      'SIN_ESTUDIO',
    );
  }
  const estudioActivo = [...estudios].sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )[0];

  const esAdmin = userRol === 'administrador' || userRol === 'operador_analista';
  const esPropietarioRol = userRol === 'propietario' || userRol === 'inmobiliaria';
  const esSolicitanteRol = userRol === 'solicitante';

  const propietarioId = row.inmuebles?.propietario_id ?? null;
  const inmobiliariaId = row.inmuebles?.inmobiliaria_id ?? null;
  const solicitanteUserId = row.solicitantes?.creado_por ?? row.creado_por ?? null;

  // Org-aware: el propietario/inmobiliaria accede si es dueño directo o
  // miembro de la organización dueña del inmueble.
  const esDuenoOrg = esPropietarioRol
    ? await perfilEsDuenoDeInmueble({
        userId,
        userRol,
        inmueblePropietarioId: propietarioId,
        inmuebleInmobiliariaId: inmobiliariaId,
      })
    : false;

  let allowed = false;
  if (esAdmin) allowed = true;
  else if (esPropietarioRol) allowed = esDuenoOrg;
  else if (esSolicitanteRol) allowed = solicitanteUserId === userId;

  if (!allowed) {
    throw AppError.forbidden(
      'No tienes permisos para acceder a los soportes de este expediente',
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
      `Solo se pueden subir soportes cuando el expediente está "condicionado". Estado actual: ${ctx.estado}.`,
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
      `Solo se pueden registrar soportes cuando el expediente está "condicionado". Estado actual: ${ctx.estado}.`,
      'EXPEDIENTE_NO_CONDICIONADO',
    );
  }

  // Verificar que el archivo realmente existe en storage (anti-spoof: el
  // cliente podría confirmar sin haber subido nada).
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

  // Notificar al propietario que el solicitante subió un documento — fire and forget.
  if (ctx.esSolicitante && ctx.propietarioId) {
    notificarUsuario({
      userId: ctx.propietarioId,
      tipo: 'soporte.subido',
      titulo: 'Nuevo documento subido por el solicitante',
      mensaje: `El solicitante subió un documento (${input.proposito.replace(/_/g, ' ')}). Revísalo antes de aprobar.`,
      link: `/expedientes/${expedienteId}`,
      payload: { expediente_id: expedienteId, soporte_id: docTyped.id, proposito: input.proposito },
    }).catch((e) => logger.warn({ error: e, expedienteId }, 'Error notificando soporte subido'));
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
    .select('id, proposito, nombre_original, tipo_mime, tamano_bytes, subido_por, storage_key, created_at')
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
  }>;

  // Resolver nombres de quienes subieron — query única.
  const userIds = [...new Set(docsTyped.map((d) => d.subido_por).filter(Boolean) as string[])];
  const nombresMap = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: perfiles } = await (supabase
      .from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('id, nombre, apellido')
      .in('id', userIds);
    if (perfiles) {
      for (const p of perfiles as unknown as Array<{ id: string; nombre: string; apellido: string }>) {
        nombresMap.set(p.id, `${p.nombre} ${p.apellido}`.trim());
      }
    }
  }

  // Generar signed URLs para todos en paralelo.
  const result = await Promise.all(
    docsTyped.map(async (d) => {
      const { data: urlData } = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(d.storage_key, 3600);
      return {
        id: d.id,
        proposito: d.proposito,
        nombre_original: d.nombre_original,
        tipo_mime: d.tipo_mime,
        tamano_bytes: d.tamano_bytes,
        subido_por: d.subido_por,
        subido_por_nombre: d.subido_por ? nombresMap.get(d.subido_por) || null : null,
        created_at: d.created_at,
        archivo_url: urlData?.signedUrl || null,
      };
    }),
  );

  // Hush unused warning: supabaseAuth es importable aunque no lo usemos aquí.
  void supabaseAuth;

  return result;
}

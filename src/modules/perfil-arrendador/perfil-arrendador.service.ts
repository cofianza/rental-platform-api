import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type { UpdatePerfilArrendadorInput } from './perfil-arrendador.schema';

const LOGO_BUCKET = 'documentos-expedientes';
const LOGO_PATH_PREFIX = 'logos-arrendador';
const LOGO_URL_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días

const PERFIL_ARRENDADOR_FIELDS = `
  id, nombre, apellido, rol, tipo_documento, numero_documento,
  razon_social, representante_legal,
  domicilio_direccion, domicilio_ciudad, ciudad,
  matricula_arrendador, logo_storage_key, logo_url,
  whatsapp_recaudo, email_recaudo,
  cuenta_recaudo_banco, cuenta_recaudo_tipo, cuenta_recaudo_numero,
  cuenta_recaudo_titular_nombre, cuenta_recaudo_titular_nit
`;

function normalizeEmpty(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Campos obligatorios para que el perfil del arrendador sea "completo"
 * y se puedan publicar inmuebles. Si falta cualquiera, el contrato que
 * se genere despues va a tener datos vacios.
 *
 * Comunes a propietario e inmobiliaria:
 *   domicilio (dir+ciudad), cuenta de recaudo completa, contacto recaudo.
 *
 * Solo inmobiliaria: matricula_arrendador (las inmobiliarias estan obligadas
 * por ley colombiana a tener matricula. El logo NO es obligatorio.)
 */
const REQUIRED_FIELDS_COMUNES = [
  'domicilio_direccion',
  'domicilio_ciudad',
  'cuenta_recaudo_banco',
  'cuenta_recaudo_tipo',
  'cuenta_recaudo_numero',
  'cuenta_recaudo_titular_nombre',
  'cuenta_recaudo_titular_nit',
  'whatsapp_recaudo',
  'email_recaudo',
] as const;

const REQUIRED_FIELDS_INMOBILIARIA = ['matricula_arrendador'] as const;

const FIELD_LABELS: Record<string, string> = {
  domicilio_direccion: 'Domicilio (direccion)',
  domicilio_ciudad: 'Domicilio (ciudad)',
  cuenta_recaudo_banco: 'Banco de la cuenta de recaudo',
  cuenta_recaudo_tipo: 'Tipo de cuenta (ahorros/corriente)',
  cuenta_recaudo_numero: 'Numero de cuenta',
  cuenta_recaudo_titular_nombre: 'Titular de la cuenta',
  cuenta_recaudo_titular_nit: 'NIT/CC del titular',
  whatsapp_recaudo: 'WhatsApp de recaudo',
  email_recaudo: 'Email de recaudo',
  matricula_arrendador: 'Matricula de arrendador',
};

interface CompletitudResultado {
  completo: boolean;
  faltantes: { campo: string; etiqueta: string }[];
  rol: string;
}

/**
 * Verifica si el perfil del usuario tiene todos los datos necesarios para
 * publicar inmuebles y emitir contratos. Devuelve la lista de faltantes
 * para que el frontend muestre un mensaje claro.
 */
export async function checkPerfilCompletitud(userId: string): Promise<CompletitudResultado> {
  const { data } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('rol, ' + REQUIRED_FIELDS_COMUNES.join(', ') + ', matricula_arrendador')
    .eq('id', userId)
    .single();

  if (!data) {
    return { completo: false, faltantes: [], rol: 'desconocido' };
  }

  const row = data as unknown as Record<string, string | null>;
  const rol = String(row.rol || 'desconocido');

  const required: string[] = [...REQUIRED_FIELDS_COMUNES];
  if (rol === 'inmobiliaria') {
    required.push(...REQUIRED_FIELDS_INMOBILIARIA);
  }

  const faltantes = required
    .filter((f) => !row[f] || String(row[f]).trim().length === 0)
    .map((campo) => ({ campo, etiqueta: FIELD_LABELS[campo] || campo }));

  return { completo: faltantes.length === 0, faltantes, rol };
}

export async function getMiPerfilArrendador(userId: string) {
  const { data, error } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select(PERFIL_ARRENDADOR_FIELDS)
    .eq('id', userId)
    .single();

  if (error || !data) throw AppError.notFound('Perfil no encontrado');
  return data;
}

export async function updateMiPerfilArrendador(
  userId: string,
  rol: string,
  input: UpdatePerfilArrendadorInput,
  ip?: string,
) {
  // matricula_arrendador es exclusivo de inmobiliaria — silenciosamente
  // ignoramos el campo si lo manda un propietario directo.
  const update: Record<string, string | null> = {
    representante_legal: normalizeEmpty(input.representante_legal),
    domicilio_direccion: normalizeEmpty(input.domicilio_direccion),
    domicilio_ciudad: normalizeEmpty(input.domicilio_ciudad),
    whatsapp_recaudo: normalizeEmpty(input.whatsapp_recaudo),
    email_recaudo: normalizeEmpty(input.email_recaudo),
    cuenta_recaudo_banco: normalizeEmpty(input.cuenta_recaudo_banco),
    cuenta_recaudo_tipo: input.cuenta_recaudo_tipo || null,
    cuenta_recaudo_numero: normalizeEmpty(input.cuenta_recaudo_numero),
    cuenta_recaudo_titular_nombre: normalizeEmpty(input.cuenta_recaudo_titular_nombre),
    cuenta_recaudo_titular_nit: normalizeEmpty(input.cuenta_recaudo_titular_nit),
  };
  if (rol === 'inmobiliaria') {
    update.matricula_arrendador = normalizeEmpty(input.matricula_arrendador);
  }

  // Solo escribimos las claves explicitamente provistas — Supabase no
  // sobreescribe con null si no está la key. Eso permite "guardado parcial".
  const filtered: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(update)) {
    // No filtramos null intencionales: si el caller manda explicit null,
    // queremos limpiar el campo.
    if (k in input || (rol === 'inmobiliaria' && k === 'matricula_arrendador' && 'matricula_arrendador' in input)) {
      filtered[k] = v;
    }
  }

  const { data, error } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update(filtered as never)
    .eq('id', userId)
    .select(PERFIL_ARRENDADOR_FIELDS)
    .single();

  if (error || !data) {
    logger.error({ error: error?.message, userId }, 'Error al actualizar perfil arrendador');
    throw AppError.badRequest('No se pudo actualizar el perfil', 'PERFIL_UPDATE_ERROR');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.USER_UPDATED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    detalle: { tipo: 'perfil_arrendador_actualizado', campos: Object.keys(filtered) },
    ip,
  });

  return data;
}

export async function uploadLogo(
  userId: string,
  rol: string,
  file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  ip?: string,
) {
  if (rol !== 'inmobiliaria') {
    throw AppError.forbidden(
      'Solo las inmobiliarias pueden subir logo. Los propietarios directos no llevan logo en el contrato.',
      'LOGO_NOT_ALLOWED',
    );
  }

  const allowedMimes = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowedMimes.includes(file.mimetype)) {
    throw AppError.badRequest(
      'Formato de imagen invalido. Usa PNG, JPG o WebP.',
      'LOGO_FORMAT_INVALID',
    );
  }
  if (file.size > 2 * 1024 * 1024) {
    throw AppError.badRequest('El logo no puede superar 2 MB.', 'LOGO_TOO_LARGE');
  }

  // Reemplazamos siempre el logo anterior — un solo logo activo por perfil.
  // Storage key estable por usuario para que la URL firmada sea predecible.
  const ext = file.mimetype === 'image/png' ? 'png'
    : file.mimetype === 'image/webp' ? 'webp'
    : 'jpg';
  const storageKey = `${LOGO_PATH_PREFIX}/${userId}/logo.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(LOGO_BUCKET)
    .upload(storageKey, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });

  if (uploadError) {
    logger.error({ error: uploadError.message, userId }, 'Error al subir logo');
    throw new AppError(500, 'STORAGE_ERROR', 'No se pudo subir el logo');
  }

  // Cacheamos URL firmada larga; si expira, la regeneramos al generar
  // el contrato (contratos.service tiene fallback a createSignedUrl).
  const { data: signed } = await supabase.storage
    .from(LOGO_BUCKET)
    .createSignedUrl(storageKey, LOGO_URL_TTL_SECONDS);
  const logoUrl = signed?.signedUrl ?? null;

  const { data: updated, error: updateError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({ logo_storage_key: storageKey, logo_url: logoUrl } as never)
    .eq('id', userId)
    .select(PERFIL_ARRENDADOR_FIELDS)
    .single();

  if (updateError || !updated) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Logo subido pero no se pudo actualizar el perfil');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.USER_UPDATED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    detalle: { tipo: 'logo_actualizado', size: file.size, mime: file.mimetype },
    ip,
  });

  return updated;
}

export async function deleteLogo(userId: string, ip?: string) {
  const { data: current } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('logo_storage_key')
    .eq('id', userId)
    .single();

  const key = (current as { logo_storage_key?: string } | null)?.logo_storage_key;
  if (key) {
    await supabase.storage.from(LOGO_BUCKET).remove([key]);
  }

  const { data: updated, error } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({ logo_storage_key: null, logo_url: null } as never)
    .eq('id', userId)
    .select(PERFIL_ARRENDADOR_FIELDS)
    .single();

  if (error || !updated) {
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo eliminar el logo');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.USER_UPDATED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: userId,
    detalle: { tipo: 'logo_eliminado' },
    ip,
  });

  return updated;
}

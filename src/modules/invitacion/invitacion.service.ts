import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { vincularExpedienteExterno } from '../expedientes/expediente-externo.service';
import type { AuthUser } from '@/types/auth';

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

// ============================================================
// Shapes públicas
// ============================================================

export interface InvitacionPublicInfo {
  email_invitacion: string;
  expediente: {
    numero: string;
    source: 'invitacion';
  };
  inmueble: {
    codigo: string;
    direccion: string;
    ciudad: string;
    valor_arriendo: number;
  };
  propietario_invitante: {
    nombre_publico: string;
    razon_social: string | null;
  };
}

export interface CanjearResult {
  expediente: {
    id: string;
    numero: string;
    estado: string;
    estudio_habilitado: boolean;
    source: 'invitacion';
  };
  siguiente_paso: 'pagar_estudio';
  redirect: string;
}

function truncateToken(token: string): string {
  return `${token.slice(0, 8)}***`;
}

// ============================================================
// GET /public/invitacion/:token
// ============================================================

/**
 * Devuelve info pública del expediente invitado. Oculta campos sensibles
 * (expediente.id, solicitante_id, notas, teléfono, creado_por). Diferencia
 * entre token inexistente (404) y ya canjeado (409) para que el frontend
 * muestre mensajes útiles.
 */
export async function getInvitacionPublic(token: string): Promise<InvitacionPublicInfo> {
  const { data, error } = await db('expedientes')
    .select(
      'numero, source, solicitante_id, email_invitacion, ' +
        'inmuebles(codigo, direccion, ciudad, valor_arriendo, propietario_id)',
    )
    .eq('token_invitacion', token)
    .maybeSingle();

  if (error) {
    logger.error(
      { tokenPrefix: truncateToken(token), error: error.message },
      'Error al buscar invitación por token',
    );
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al procesar la invitación');
  }

  if (!data) {
    logger.warn({ tokenPrefix: truncateToken(token) }, 'Token de invitación inválido');
    throw AppError.notFound('Invitación no encontrada', 'INVITACION_NOT_FOUND');
  }

  const row = data as unknown as {
    numero: string;
    source: string;
    solicitante_id: string | null;
    email_invitacion: string;
    inmuebles: {
      codigo: string;
      direccion: string;
      ciudad: string;
      valor_arriendo: number;
      propietario_id: string;
    } | null;
  };

  if (row.solicitante_id) {
    throw AppError.conflict('Esta invitación ya fue canjeada', 'INVITACION_YA_CANJEADA');
  }

  if (!row.inmuebles) {
    logger.error({ tokenPrefix: truncateToken(token) }, 'Invitación sin inmueble asociado');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al cargar los datos del inmueble');
  }

  // Fetch datos del propietario invitante (dueño del inmueble)
  const { data: perfilData } = await db('perfiles')
    .select('nombre, apellido, razon_social')
    .eq('id', row.inmuebles.propietario_id)
    .maybeSingle();

  const perfil = perfilData as
    | { nombre: string | null; apellido: string | null; razon_social: string | null }
    | null;

  const nombrePublico =
    perfil?.razon_social ||
    `${perfil?.nombre ?? ''} ${perfil?.apellido ?? ''}`.trim() ||
    'Propietario';

  logger.info(
    { tokenPrefix: truncateToken(token), numero: row.numero },
    'Invitación consultada',
  );

  return {
    email_invitacion: row.email_invitacion,
    expediente: {
      numero: row.numero,
      source: 'invitacion',
    },
    inmueble: {
      codigo: row.inmuebles.codigo,
      direccion: row.inmuebles.direccion,
      ciudad: row.inmuebles.ciudad,
      valor_arriendo: row.inmuebles.valor_arriendo,
    },
    propietario_invitante: {
      nombre_publico: nombrePublico,
      razon_social: perfil?.razon_social ?? null,
    },
  };
}

// ============================================================
// POST /public/invitacion/:token/canjear
// ============================================================

/**
 * Localiza o crea on-the-fly la fila de solicitantes asociada al usuario
 * autenticado. El on-the-fly cubre el edge donde registerSolicitante falló
 * silenciosamente el INSERT inicial a `solicitantes` (log-only).
 */
async function ensureSolicitanteForUser(user: AuthUser): Promise<string> {
  const { data: existing, error: findError } = await db('solicitantes')
    .select('id')
    .eq('creado_por', user.id)
    .maybeSingle();

  if (findError) {
    logger.error(
      { userId: user.id, error: findError.message },
      'Error al buscar solicitante del usuario',
    );
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo completar el canje');
  }

  if (existing) {
    return (existing as { id: string }).id;
  }

  logger.warn(
    { userId: user.id, email: user.email },
    'Solicitante creado on-the-fly durante canje de invitación — indica posible fallo silencioso en registerSolicitante',
  );

  const { data: perfilRow, error: perfilError } = await db('perfiles')
    .select('nombre, apellido, tipo_documento, numero_documento, telefono')
    .eq('id', user.id)
    .single();

  if (perfilError || !perfilRow) {
    logger.error(
      { userId: user.id, error: perfilError?.message },
      'Perfil no encontrado al crear solicitante on-the-fly',
    );
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo completar el canje');
  }

  const perfil = perfilRow as unknown as {
    nombre: string;
    apellido: string;
    tipo_documento: string | null;
    numero_documento: string | null;
    telefono: string | null;
  };

  const { data: newSolicitante, error: insertError } = await db('solicitantes')
    .insert({
      nombre: perfil.nombre,
      apellido: perfil.apellido,
      email: user.email,
      telefono: perfil.telefono,
      tipo_documento: perfil.tipo_documento,
      numero_documento: perfil.numero_documento,
      creado_por: user.id,
    } as never)
    .select('id')
    .single();

  if (insertError || !newSolicitante) {
    logger.error(
      { userId: user.id, error: insertError?.message },
      'Error al crear solicitante on-the-fly',
    );
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo completar el canje');
  }

  return (newSolicitante as { id: string }).id;
}

export async function canjearInvitacion(token: string, user: AuthUser): Promise<CanjearResult> {
  // 1. Lookup expediente por token — misma validación de existencia/canje que GET.
  //    Se re-consulta para obtener email_invitacion antes de llamar a vincular.
  const { data, error } = await db('expedientes')
    .select('id, solicitante_id, email_invitacion')
    .eq('token_invitacion', token)
    .maybeSingle();

  if (error) {
    logger.error(
      { tokenPrefix: truncateToken(token), error: error.message },
      'Error al buscar invitación al canjear',
    );
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al procesar la invitación');
  }

  if (!data) {
    throw AppError.notFound('Invitación no encontrada', 'INVITACION_NOT_FOUND');
  }

  const row = data as unknown as {
    id: string;
    solicitante_id: string | null;
    email_invitacion: string;
  };

  if (row.solicitante_id) {
    throw AppError.conflict('Esta invitación ya fue canjeada', 'INVITACION_YA_CANJEADA');
  }

  // 2. Email match (case-insensitive). Mismatch: log WARN para detectar
  //    intentos de ingeniería social.
  if (row.email_invitacion.toLowerCase() !== user.email.toLowerCase()) {
    logger.warn(
      { email_invitacion: row.email_invitacion, email_autenticado: user.email, userId: user.id },
      'Intento de canje con email mismatch',
    );
    throw AppError.forbidden(
      'El email de tu cuenta no coincide con el de la invitación. ' +
        'Debes iniciar sesión con el email al que se envió la invitación.',
      'INVITACION_EMAIL_MISMATCH',
    );
  }

  // 3. Obtener (o crear) solicitante.
  const solicitanteId = await ensureSolicitanteForUser(user);

  // 4. Vincular (reutiliza la función existente). Maneja su propia timeline
  //    event con metadata { via, email_invitacion }.
  const updated = await vincularExpedienteExterno(token, solicitanteId);

  const updatedExp = updated as unknown as {
    id: string;
    numero: string;
    estado: string;
    estudio_habilitado: boolean;
  };

  logger.info(
    { expedienteId: updatedExp.id, solicitanteId, email: user.email },
    'Invitación canjeada',
  );

  return {
    expediente: {
      id: updatedExp.id,
      numero: updatedExp.numero,
      estado: updatedExp.estado,
      estudio_habilitado: updatedExp.estudio_habilitado,
      source: 'invitacion',
    },
    siguiente_paso: 'pagar_estudio',
    redirect: `/expedientes/${updatedExp.id}`,
  };
}

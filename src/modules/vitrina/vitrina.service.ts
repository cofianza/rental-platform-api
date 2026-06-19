// ============================================================
// Vitrina Publica — Service (HP-368)
// Registration for solicitante & interest (expediente) creation
// ============================================================

import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { recordTermsAcceptance } from '../registration/registration.service';
import { notificarUsuario } from '../notificaciones/notificaciones.service';
import { enviarTemplate } from '../whatsapp';
import type { RegisterSolicitanteInput } from './vitrina.schema';

// ------------------------------------------------------------------
// registerSolicitante
// ------------------------------------------------------------------

interface RegisterSolicitanteResult {
  user: { id: string; email: string; rol: string };
  session: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
}

export async function registerSolicitante(
  input: RegisterSolicitanteInput,
  ipAddress: string,
  userAgent: string,
): Promise<RegisterSolicitanteResult> {
  const {
    email, password, nombre, apellido, telefono,
    tipo_documento, numero_documento, from_invitation,
    municipio_id, municipio_nombre,
  } = input;

  const registrationSource = from_invitation ? 'invitacion_externa' : 'vitrina_publica';

  // 0. Pre-flight: validar duplicados ANTES de crear el auth.user. Sin esto,
  //    si el INSERT en `solicitantes` falla por unique violation (documento
  //    ya registrado por otro solicitante), nos queda un auth.user huérfano
  //    que bloquea reintentos con "EMAIL_ALREADY_EXISTS".
  //    UNIQUE (tipo_documento, numero_documento) — definido en la migración
  //    20260224000001_solicitantes_crud_columns.
  const { data: solicitantesByDoc } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('id, email')
    .eq('tipo_documento', tipo_documento)
    .eq('numero_documento', numero_documento)
    .limit(1);

  if (solicitantesByDoc && solicitantesByDoc.length > 0) {
    throw AppError.conflict(
      'Ya existe un solicitante registrado con este documento. Si es tu cuenta, inicia sesión.',
      'DOCUMENT_ALREADY_EXISTS',
    );
  }

  const { data: solicitantesByEmail } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('email', email)
    .limit(1);

  if (solicitantesByEmail && solicitantesByEmail.length > 0) {
    throw AppError.conflict(
      'Ya existe una cuenta de solicitante con este email. Inicia sesión.',
      'EMAIL_ALREADY_EXISTS',
    );
  }

  // 1. Create Supabase Auth user (auto-confirmed, no email verification for solicitante)
  const { data: authData, error: authError } = await supabaseAuth.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: 'solicitante' },
    user_metadata: { nombre, apellido, rol: 'solicitante' },
  });

  if (authError) {
    logger.error({ error: authError.message, email }, 'Error al crear usuario solicitante');
    if (authError.message.includes('already') || authError.message.includes('duplicate')) {
      throw AppError.conflict('Ya existe un usuario con este email', 'EMAIL_ALREADY_EXISTS');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el usuario');
  }

  const userId = authData.user.id;

  // 2. Update perfiles record (created by handle_new_user trigger) — auto-activate
  const { error: updateError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({
      rol: 'solicitante',
      estado: 'activo',
      telefono,
      tipo_documento,
      numero_documento,
      registration_source: registrationSource,
    } as never)
    .eq('id', userId);

  if (updateError) {
    logger.error({ error: updateError.message, userId }, 'Error al actualizar perfil de solicitante');
  }

  // 3. Insert into solicitantes table
  const { error: solicitanteError } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .insert({
      nombre,
      apellido,
      email,
      telefono,
      tipo_documento,
      numero_documento,
      municipio_id,
      municipio_nombre,
      creado_por: userId,
    } as never);

  if (solicitanteError) {
    // Si llegamos aquí (la pre-flight no detectó duplicado pero el INSERT
    // sí — race condition o columna NOT NULL faltante en una migración
    // reciente), borramos el auth.user para no dejar un usuario huérfano
    // que bloquee el siguiente intento con EMAIL_ALREADY_EXISTS.
    logger.error(
      { error: solicitanteError.message, code: (solicitanteError as { code?: string }).code, userId },
      'Error al crear registro de solicitante — rolling back auth.user',
    );
    const { error: deleteAuthError } = await supabaseAuth.auth.admin.deleteUser(userId);
    if (deleteAuthError) {
      logger.error(
        { userId, error: deleteAuthError.message },
        'Rollback fallido: auth.user huérfano — requiere limpieza manual',
      );
    }

    const code = (solicitanteError as { code?: string }).code;
    if (code === '23505') {
      throw AppError.conflict(
        'Ya existe un solicitante registrado con este documento o email.',
        'SOLICITANTE_DUPLICATE',
      );
    }
    if (code === '23502') {
      throw AppError.badRequest(
        'Faltan datos obligatorios para completar el registro.',
        'SOLICITANTE_MISSING_FIELDS',
      );
    }
    throw new AppError(
      500,
      'SOLICITANTE_INSERT_FAILED',
      'No se pudo completar el registro del solicitante. Contacta a soporte.',
    );
  }

  // 3.5. Persistir aceptación de términos + tratamiento de datos.
  //      Evidencia legal: user_id + timestamps + IP + user-agent. Reutiliza
  //      la misma función que propietario/inmobiliaria. Log-only en error.
  await recordTermsAcceptance(userId, ipAddress, userAgent);

  // 4. Sign in to get session tokens for auto-login
  const { data: signInData, error: signInError } = await supabaseAuth.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData.session) {
    logger.error({ error: signInError?.message, userId }, 'Error al iniciar sesion de solicitante');
    throw new AppError(500, 'INTERNAL_ERROR', 'Usuario creado pero error al iniciar sesion');
  }

  logger.info({ userId, email, rol: 'solicitante' }, 'Solicitante registrado exitosamente via vitrina');

  return {
    user: { id: userId, email, rol: 'solicitante' },
    session: {
      access_token: signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
      expires_at: signInData.session.expires_at ?? 0,
    },
  };
}

// ------------------------------------------------------------------
// createInterest
// ------------------------------------------------------------------

// Estados en los que un expediente todavía está activo (no terminal).
// Usado para detectar duplicados por (inmueble_id, solicitante_id).
const ESTADOS_EXPEDIENTE_ACTIVOS = [
  'borrador',
  'en_revision',
  'informacion_incompleta',
  'aprobado',
  'condicionado',
] as const;

interface CreateInterestResult {
  expediente: {
    id: string;
    numero: string;
    estado: 'borrador';
    estudio_habilitado: boolean;
    source: 'vitrina_publica';
  };
  siguiente_paso: 'agendar_cita';
}

export async function createInterest(
  userId: string,
  propertyId: string,
): Promise<CreateInterestResult> {
  // 1. Validate property exists, is public, and is available
  const { data: inmueble, error: inmuebleError } = await supabase
    .from('inmuebles')
    .select('id, visible_vitrina, estado, inmobiliaria_id')
    .eq('id', propertyId)
    .single();

  if (inmuebleError || !inmueble) {
    throw AppError.notFound('Inmueble no encontrado');
  }

  const inmuebleData = inmueble as { id: string; visible_vitrina: boolean; estado: string; inmobiliaria_id: string | null };

  if (!inmuebleData.visible_vitrina) {
    throw AppError.badRequest('Este inmueble no esta disponible en la vitrina publica', 'PROPERTY_NOT_PUBLIC');
  }

  if (inmuebleData.estado !== 'disponible') {
    throw AppError.badRequest('Este inmueble no esta disponible para arriendo', 'PROPERTY_NOT_AVAILABLE');
  }

  // 2. Find solicitante record by user ID. Si no existe (usuarios legacy
  //    creados cuando el INSERT era log-only), auto-heal construyendo el
  //    registro a partir de auth.users + perfiles para no bloquear el flujo.
  let solicitanteData: { id: string } | null = null;
  {
    const { data: solicitante } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('creado_por', userId)
      .single();
    if (solicitante) {
      solicitanteData = solicitante as { id: string };
    }
  }

  if (!solicitanteData) {
    solicitanteData = await selfHealSolicitante(userId);
  }

  // 3. Bloquear duplicados por (inmueble_id, solicitante_id) en estados activos.
  //    Un solicitante puede explorar varios inmuebles distintos en paralelo,
  //    pero no puede abrir dos expedientes simultáneos sobre el mismo.
  const { data: existingExpedientes } = await supabase
    .from('expedientes')
    .select('id')
    .eq('inmueble_id', propertyId)
    .eq('solicitante_id', solicitanteData.id)
    .in('estado', ESTADOS_EXPEDIENTE_ACTIVOS as unknown as string[])
    .limit(1);

  if (existingExpedientes && existingExpedientes.length > 0) {
    throw AppError.conflict(
      'Ya tienes un expediente activo sobre este inmueble',
      'EXPEDIENTE_ALREADY_EXISTS',
    );
  }

  // 4. Create expediente con estado='borrador'. El estudio NO se crea aquí:
  //    se habilita posteriormente vía PATCH /expedientes/:id/habilitar-estudio
  //    tras la cita (paso 3 del flujo definido en la minuta del 8-abr-2026).
  const { data: expediente, error: expedienteError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .insert({
      inmueble_id: propertyId,
      solicitante_id: solicitanteData.id,
      estado: 'borrador',
      source: 'vitrina_publica',
      creado_por: userId,
      // Multi-tenant: heredar la organización del inmueble (consistente con
      // createExpediente). NULL si es de un propietario individual.
      inmobiliaria_id: inmuebleData.inmobiliaria_id ?? null,
    } as never)
    .select('id, numero, estado, estudio_habilitado, source')
    .single();

  if (expedienteError || !expediente) {
    logger.error({ error: expedienteError?.message, userId, propertyId }, 'Error al crear expediente desde vitrina');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el expediente');
  }

  const expedienteData = expediente as {
    id: string;
    numero: string;
    estado: 'borrador';
    estudio_habilitado: boolean;
    source: 'vitrina_publica';
  };

  // 5. Evento en timeline. Errores log-only para no abortar el flujo principal.
  const { error: timelineError } = await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteData.id,
      tipo: 'creacion',
      descripcion: 'Expediente creado desde vitrina pública',
      usuario_id: userId,
      metadata: { source: 'vitrina_publica', inmueble_id: propertyId },
    } as never);

  if (timelineError) {
    logger.warn(
      { error: timelineError.message, expedienteId: expedienteData.id },
      'Error al registrar timeline de creación desde vitrina',
    );
  }

  logger.info(
    { userId, propertyId, expedienteId: expedienteData.id, numero: expedienteData.numero },
    'Expediente creado desde vitrina pública (sin estudio — pendiente de cita)',
  );

  // Avisar al dueño del inmueble (propietario o inmobiliaria) que hay un nuevo
  // lead — antes este momento no notificaba a nadie y el dueño solo se enteraba
  // entrando al panel. Fire-and-forget: no bloquea ni rompe la creación.
  notificarPropietarioNuevaSolicitud(expedienteData.id, propertyId, solicitanteData.id).catch((err) =>
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), expedienteId: expedienteData.id },
      'No se pudo notificar al propietario de la nueva solicitud de vitrina',
    ),
  );

  return {
    expediente: expedienteData,
    siguiente_paso: 'agendar_cita',
  };
}

/**
 * Notifica al dueño del inmueble (propietario/inmobiliaria — ambos viven en
 * inmuebles.propietario_id) que entró una nueva solicitud desde la vitrina:
 * notificación in-app siempre + WhatsApp si tiene teléfono. Best-effort.
 */
async function notificarPropietarioNuevaSolicitud(
  expedienteId: string,
  propertyId: string,
  solicitanteId: string,
): Promise<void> {
  const { data: inm } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('propietario_id, direccion')
    .eq('id', propertyId)
    .maybeSingle();
  const propietarioId = (inm as { propietario_id?: string | null } | null)?.propietario_id;
  const direccion = (inm as { direccion?: string | null } | null)?.direccion || 'tu inmueble';
  if (!propietarioId) return;

  const { data: prop } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('telefono')
    .eq('id', propietarioId)
    .maybeSingle();
  const telefonoPropietario = (prop as { telefono?: string | null } | null)?.telefono ?? null;

  const { data: sol } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('nombre, apellido')
    .eq('id', solicitanteId)
    .maybeSingle();
  const solRow = sol as { nombre?: string | null; apellido?: string | null } | null;
  const nombreInteresado = `${solRow?.nombre ?? ''} ${solRow?.apellido ?? ''}`.trim() || 'Un interesado';

  await notificarUsuario({
    userId: propietarioId,
    tipo: 'solicitud.vitrina',
    titulo: 'Nueva solicitud de arriendo',
    mensaje: `${nombreInteresado} está interesado en ${direccion}.`,
    link: `/expedientes/${expedienteId}`,
    payload: { expediente_id: expedienteId, inmueble_id: propertyId },
  });

  await enviarTemplate({
    to: telefonoPropietario,
    template: 'NUEVA_SOLICITUD_VITRINA',
    variables: [nombreInteresado, direccion],
    context: { expediente_id: expedienteId },
  });
}

// ------------------------------------------------------------------
// selfHealSolicitante — crea el registro faltante en `solicitantes`
// ------------------------------------------------------------------

/**
 * Construye el registro de `solicitantes` para un usuario que se autenticó
 * como solicitante pero cuyo INSERT original falló silenciosamente (legacy
 * antes del fix). Lee metadata de auth.users + perfiles y crea la fila.
 *
 * Si falta información esencial (email, nombre), no se puede sanar y
 * lanzamos el error original para que el frontend lo muestre.
 */
async function selfHealSolicitante(userId: string): Promise<{ id: string }> {
  // Auth user → email + user_metadata.{nombre,apellido}
  const { data: authResult, error: authError } = await supabaseAuth.auth.admin.getUserById(userId);
  if (authError || !authResult?.user) {
    logger.warn({ userId, error: authError?.message }, 'Self-heal: no se pudo leer auth.user');
    throw AppError.badRequest(
      'No se encontro registro de solicitante para este usuario',
      'SOLICITANTE_NOT_FOUND',
    );
  }

  const authUser = authResult.user;
  const meta = (authUser.user_metadata || {}) as { nombre?: string; apellido?: string };
  const nombre = meta.nombre?.trim();
  const apellido = meta.apellido?.trim() || '';
  const email = authUser.email;

  if (!nombre || !email) {
    logger.warn({ userId }, 'Self-heal: user_metadata incompleto');
    throw AppError.badRequest(
      'No se encontro registro de solicitante para este usuario',
      'SOLICITANTE_NOT_FOUND',
    );
  }

  // Perfiles → telefono, tipo_documento, numero_documento
  const { data: perfil } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('telefono, tipo_documento, numero_documento')
    .eq('id', userId)
    .single();

  const perfilData = (perfil || {}) as {
    telefono?: string | null;
    tipo_documento?: string | null;
    numero_documento?: string | null;
  };

  const { data: inserted, error: insertError } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .insert({
      nombre,
      apellido,
      email,
      telefono: perfilData.telefono || null,
      tipo_documento: perfilData.tipo_documento || 'CC',
      numero_documento: perfilData.numero_documento || '',
      creado_por: userId,
    } as never)
    .select('id')
    .single();

  if (insertError || !inserted) {
    logger.error(
      { userId, error: insertError?.message },
      'Self-heal: falló el INSERT en solicitantes',
    );
    throw AppError.badRequest(
      'No se encontro registro de solicitante para este usuario',
      'SOLICITANTE_NOT_FOUND',
    );
  }

  logger.info({ userId, solicitanteId: (inserted as { id: string }).id }, 'Self-heal: solicitante creado on-the-fly');
  return inserted as { id: string };
}

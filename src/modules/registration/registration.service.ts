import crypto from 'node:crypto';
import { supabase, supabaseAuth } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config';
import { sendVerificationEmail } from '@/lib/email';
import { ensureOrgConOwner } from '@/lib/tenantScope';
import { getCompany } from '@/lib/companyConfig';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type {
  RegisterPropietarioInput,
  RegisterInmobiliariaInput,
  ResendVerificationInput,
} from './registration.schema';

// Vigencia del enlace de verificación. La misma cifra sale en el mensaje del
// registro que encuentra su NIT retenido por un alta sin verificar.
const HORAS_ENLACE_VERIFICACION = 24;

const MENSAJE_NIT_REGISTRADO =
  'Ya hay una inmobiliaria registrada con este NIT. Pídale al titular de la cuenta que lo invite a su equipo.';

const MENSAJE_ENLACE_INVALIDO = 'El enlace de verificación no es válido o ya venció. Solicite uno nuevo.';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

type EstadoVerificacion = { registration_source: string | null; email_verified_at: string | null };

/**
 * Autorregistro por correo que aún no verificó. Es la única cuenta que un
 * enlace puede activar, y la única que se borra para liberar su NIT: las ya
 * verificadas y las creadas por otro medio (administrador, vitrina, invitación)
 * no entran aquí.
 */
function esAutorregistroSinVerificar(perfil: EstadoVerificacion): boolean {
  return perfil.registration_source === 'email' && !perfil.email_verified_at;
}

/**
 * ¿El error de supabaseAuth.admin.createUser corresponde a un email ya
 * registrado? El texto del mensaje varía según la versión de GoTrue
 * ("already registered", "email_exists", …); nos apoyamos también en el
 * `code`/`status` para no clasificar un duplicado como 500 genérico.
 */
function esEmailDuplicado(err: { message?: string; code?: string; status?: number }): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return (
    msg.includes('already') ||
    msg.includes('duplicate') ||
    msg.includes('exists') ||
    err.code === 'email_exists' ||
    err.status === 422
  );
}

/**
 * UPDATE de perfil que no puede tumbar el alta: si falla (p. ej. la migración
 * 20261003001001 aún no corrió y la columna no existe) solo queda en el log.
 */
async function actualizarPerfilSinAbortar(userId: string, datos: Record<string, unknown>, que: string): Promise<void> {
  if (Object.keys(datos).length === 0) return;
  const { error } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update(datos as never)
    .eq('id', userId);
  if (error) logger.error({ error: error.message, userId }, `Registro: no se pudo guardar ${que}`);
}

/**
 * El NIT ya lo tiene otro perfil. Solo deja seguir con el alta cuando ese perfil
 * es un autorregistro que nunca verificó el correo y ya no tiene un enlace de
 * verificación vigente: entonces se borra esa cuenta (la cascada de auth.users
 * se lleva perfil, organización, membresía, aceptación de términos y tokens).
 * Antes el NIT quedaba retenido para siempre: quien tecleó mal su correo no
 * podía volver a registrarse y leía «pídale al titular que lo invite» — el
 * titular era él mismo. En cualquier otro caso responde 409.
 */
async function liberarNitDeRegistroVencido(
  dueno: { id: string } & EstadoVerificacion,
  nit: string,
  ipAddress: string,
): Promise<void> {
  if (!esAutorregistroSinVerificar(dueno)) {
    throw AppError.conflict(MENSAJE_NIT_REGISTRADO, 'NIT_ALREADY_EXISTS');
  }
  const contacto = (await getCompany()).email;

  // «Vencido» lo dice el propio token (un reenvío lo renueva), no la fecha del
  // alta. Si la consulta falla se trata como vigente: ante la duda no se borra.
  const { data: enlaceVigente, error: tokenError } = await (supabase
    .from('email_verification_tokens' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('user_id', dueno.id)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
    .maybeSingle();
  if (tokenError || enlaceVigente) {
    throw AppError.conflict(
      'Ya hay un registro con este NIT pendiente de verificar el correo. Revise su bandeja de entrada (y el spam). ' +
        `Si escribió mal el correo, podrá registrarse de nuevo en ${HORAS_ENLACE_VERIFICACION} horas o escribirnos a ${contacto}.`,
      'NIT_ALREADY_EXISTS',
    );
  }

  const { error: deleteError } = await supabaseAuth.auth.admin.deleteUser(dueno.id);
  if (deleteError) {
    // La cascada no cubre todo: p. ej. la bitácora referencia a quien pidió
    // recuperar la contraseña. No se fuerza; lo resuelve una persona.
    logger.error({ error: deleteError.message, userId: dueno.id }, 'No se pudo borrar el registro sin verificar que retiene el NIT');
    throw AppError.conflict(
      `Ya hay un registro con este NIT que quedó sin verificar y no pudimos liberarlo. Escríbanos a ${contacto} y lo resolvemos.`,
      'NIT_ALREADY_EXISTS',
    );
  }

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.USER_DELETED,
    entidad: AUDIT_ENTITIES.USER,
    entidadId: dueno.id,
    detalle: { motivo: 'registro_sin_verificar_vencido', nit },
    ip: ipAddress,
  });
  logger.info({ userId: dueno.id }, 'Registro sin verificar con el enlace vencido: se borró para liberar su NIT');
}

// «¿Cómo nos conoció?», como lo lee la persona en el formulario.
const ORIGEN_LEGIBLE: Record<string, string> = {
  inmobiliaria: 'una inmobiliaria',
  redes: 'redes sociales',
  recomendacion: 'recomendación',
  google: 'Google o internet',
  evento: 'evento o feria',
  otro: 'otro',
};

/**
 * Aviso interno (en la plataforma y por correo) a los administradores activos:
 * el formulario le promete a la inmobiliaria contacto en menos de 24 horas y
 * nadie en Cofianza se enteraba del alta. Nunca lanza: para entonces el
 * registro ya terminó bien.
 * El mensaje va en texto plano y sin escapar: el correo lo escapa al armar el
 * HTML (sendResponsableAsignadoEmail) y el panel lo pinta como texto.
 */
async function avisarInmobiliariaRegistrada(userId: string, input: RegisterInmobiliariaInput): Promise<void> {
  try {
    const dato = (valor?: string) => valor?.trim() || 'no indicó';
    const tipoRespaldo = input.afianzadora_tipo === 'ninguna' ? 'ninguno' : input.afianzadora_tipo;
    const respaldo =
      tipoRespaldo && input.afianzadora_actual ? `${tipoRespaldo} (${input.afianzadora_actual})` : tipoRespaldo || input.afianzadora_actual;
    const representante = [
      `${input.nombre_representante_nombre} ${input.nombre_representante_apellido}`.trim(),
      input.cargo_representante,
    ].filter(Boolean).join(', ');

    // Import dinámico: el aviso a los administradores vive en pagos.service, que
    // arrastra la pasarela; no hace falta cargarlo para registrar.
    const { avisarAdministradores } = await import('@/modules/pagos/pagos.service');
    await avisarAdministradores({
      tipo: 'inmobiliaria.registrada',
      titulo: 'Nueva inmobiliaria registrada',
      mensaje:
        `${input.razon_social} (NIT ${input.nit}), de ${input.ciudad}, se registró en Cofianza y espera que la contactemos ` +
        'en menos de 24 horas para firmar el contrato marco. ' +
        [
          `Inmuebles gestionados: ${dato(input.inmuebles_gestionados)}`,
          `Cómo nos conoció: ${dato(input.origen && ORIGEN_LEGIBLE[input.origen])}`,
          `Página web: ${dato(input.sitio_web)}`,
          `Respaldo actual: ${dato(respaldo)}`,
          `Representante: ${representante}`,
          `Contacto: ${input.email}, ${input.telefono}`,
        ].join(' · '),
      link: '/admin/inmobiliarias',
      payload: { perfil_id: userId, nit: input.nit },
    });
  } catch (err) {
    logger.error({ error: (err as Error)?.message, userId }, 'No se pudo avisar a los administradores del registro de la inmobiliaria');
  }
}

export async function registerPropietario(
  input: RegisterPropietarioInput,
  ipAddress: string,
  userAgent: string,
): Promise<{ message: string }> {
  const { email, password, nombre, apellido, telefono, tipo_documento,
          numero_documento, direccion, origen } = input;

  const { data: authData, error: authError } = await supabaseAuth.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
    user_metadata: { nombre, apellido, rol: 'propietario' },
  });

  if (authError) {
    logger.error({ error: authError.message, code: authError.code, status: authError.status, email }, 'Error al crear usuario propietario');
    if (esEmailDuplicado(authError)) {
      throw AppError.conflict('Ya existe un usuario con este email', 'EMAIL_ALREADY_EXISTS');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el usuario');
  }

  const userId = authData.user.id;

  // El trigger handle_new_user() ya creo la fila en perfiles con estado='activo'
  // Actualizamos inmediatamente a estado='inactivo' y agregamos campos extra
  const { error: updateError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({
      rol: 'propietario',
      estado: 'inactivo',
      telefono,
      tipo_documento,
      numero_documento,
      ...(direccion ? { direccion } : {}),
      registration_source: 'email',
    } as never)
    .eq('id', userId);

  if (updateError) {
    // Antes solo se logueaba: la cuenta quedaba como solicitante activo, sin
    // registration_source, y ni siquiera podía pedir el reenvío de verificación.
    // Se borra el usuario de auth para que pueda reintentar con el mismo correo.
    logger.error({ error: updateError.message, userId }, 'Error al actualizar perfil de propietario');
    await supabaseAuth.auth.admin.deleteUser(userId).catch((e) =>
      logger.error({ err: e, userId }, 'No se pudo limpiar el usuario tras fallar el perfil'),
    );
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo completar el registro. Inténtelo de nuevo.');
  }

  await actualizarPerfilSinAbortar(userId, origen ? { origen_registro: origen } : {}, 'el origen del registro');

  await recordTermsAcceptance(userId, ipAddress, userAgent);
  await generateAndSendVerificationEmail(userId, email, nombre);

  logger.info({ userId, email, rol: 'propietario' }, 'Propietario registrado exitosamente');

  return { message: 'Registro exitoso. Revise su correo para verificar su cuenta.' };
}

export async function registerInmobiliaria(
  input: RegisterInmobiliariaInput,
  ipAddress: string,
  userAgent: string,
): Promise<{ message: string }> {
  const { email, password, razon_social, nit, direccion_comercial, ciudad,
          nombre_representante_nombre, nombre_representante_apellido, telefono,
          cargo_representante, afianzadora_actual, afianzadora_tipo,
          inmuebles_gestionados, sitio_web, representante_tipo_documento,
          representante_documento, origen } = input;

  // NIT duplicado. La web ya tenia una rama para `NIT_ALREADY_EXISTS` y ese
  // codigo no existia en todo el API: el registro escribia el NIT sin consultar
  // y acto seguido ensureOrgConOwner creaba una SEGUNDA organizacion con la
  // misma razon social — cartera partida, equipo invisible, y dos clientes DIAN
  // donde hay uno. Va antes de createUser para no dejar un usuario huerfano.
  // El cierre duradero es el indice unico (migracion 20260916000001); esto
  // ademas da un mensaje que dice que hacer.
  const { data: nitExistente } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('id, registration_source, email_verified_at')
    .eq('nit', nit)
    .limit(1)
    .maybeSingle();
  if (nitExistente) {
    await liberarNitDeRegistroVencido(nitExistente as { id: string } & EstadoVerificacion, nit, ipAddress);
  }

  const { data: authData, error: authError } = await supabaseAuth.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
    user_metadata: {
      nombre: nombre_representante_nombre,
      apellido: nombre_representante_apellido,
      rol: 'inmobiliaria',
    },
  });

  if (authError) {
    logger.error({ error: authError.message, code: authError.code, status: authError.status, email }, 'Error al crear usuario inmobiliaria');
    if (esEmailDuplicado(authError)) {
      throw AppError.conflict('Ya existe un usuario con este email', 'EMAIL_ALREADY_EXISTS');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el usuario');
  }

  const userId = authData.user.id;
  const nombre_representante = `${nombre_representante_nombre} ${nombre_representante_apellido}`.trim();

  const { error: updateError } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .update({
      rol: 'inmobiliaria',
      estado: 'inactivo',
      telefono,
      tipo_documento: 'nit',
      numero_documento: nit,
      razon_social,
      nit,
      direccion_comercial,
      ciudad,
      nombre_representante,
      // El campo es opcional y la migracion 20260512000003 lo agrega; si la
      // BD aun no tiene la columna, ignorar el undefined sin romper el insert.
      ...(cargo_representante ? { cargo_representante } : {}),
      // Afianzadora/aseguradora actual (tarea 1.6, migración 20260706000002).
      ...(afianzadora_actual ? { afianzadora_actual } : {}),
      ...(afianzadora_tipo ? { afianzadora_tipo } : {}),
      registration_source: 'email',
    } as never)
    .eq('id', userId);

  if (updateError) {
    // 23505 = el indice unico uq_perfiles_nit (migracion 20260916000001) gano la
    // carrera que el pre-chequeo de arriba no puede cerrar.
    if ((updateError as { code?: string }).code === '23505') {
      await supabaseAuth.auth.admin.deleteUser(userId).catch(() => undefined);
      throw AppError.conflict(MENSAJE_NIT_REGISTRADO, 'NIT_ALREADY_EXISTS');
    }
    // Antes solo se logueaba y el usuario leia "Registro exitoso" sobre un
    // perfil sin razon social, sin NIT y sin rol de inmobiliaria — una cuenta
    // inservible que nadie sabia que estaba rota. Se borra el usuario de auth
    // para que pueda reintentar con el mismo correo.
    logger.error({ error: updateError.message, userId }, 'Error al actualizar perfil de inmobiliaria');
    await supabaseAuth.auth.admin.deleteUser(userId).catch((e) =>
      logger.error({ err: e, userId }, 'No se pudo limpiar el usuario tras fallar el perfil'),
    );
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo completar el registro. Inténtelo de nuevo.');
  }

  // Precarga de «Datos para contrato» con lo que el registro ya capturó, para
  // que el titular no lo vuelva a teclear (queda editable). Aparte del UPDATE
  // principal: un fallo aquí no puede borrar la cuenta.
  await actualizarPerfilSinAbortar(userId, {
    domicilio_direccion: direccion_comercial,
    domicilio_ciudad: ciudad,
    representante_legal: nombre_representante,
    ...(representante_tipo_documento && representante_documento
      ? {
          representante_legal_tipo_documento: representante_tipo_documento,
          representante_legal_documento: representante_documento,
        }
      : {}),
  }, 'la precarga de datos para contrato');

  // Columnas de la migración 20261003001001, en su propio UPDATE: si aún no
  // corrió, PostgREST rechaza el UPDATE entero y no debe llevarse la precarga.
  await actualizarPerfilSinAbortar(userId, {
    ...(origen ? { origen_registro: origen } : {}),
    ...(inmuebles_gestionados ? { inmuebles_gestionados } : {}),
    ...(sitio_web ? { sitio_web } : {}),
  }, 'los datos comerciales del registro');

  // Multi-tenant: crear la organización con esta inmobiliaria como owner, para
  // que pueda invitar miembros. Idempotente. Log-only: si falla, el registro
  // no se aborta (el scoping cae al fallback por propietario_id).
  try {
    await ensureOrgConOwner(userId, razon_social);
  } catch (orgError) {
    logger.error({ error: (orgError as Error).message, userId }, 'Error al crear organización de inmobiliaria');
  }

  await recordTermsAcceptance(userId, ipAddress, userAgent);
  await generateAndSendVerificationEmail(userId, email, nombre_representante_nombre);

  // Al final y sin esperarlo: primero sale el correo de verificación (el que la
  // persona necesita) y el aviso interno no demora ni tumba la respuesta.
  void avisarInmobiliariaRegistrada(userId, input);

  logger.info({ userId, email, rol: 'inmobiliaria' }, 'Inmobiliaria registrada exitosamente');

  return { message: 'Registro exitoso. Revise su correo para verificar su cuenta.' };
}

export async function verifyEmail(token: string): Promise<{ message: string }> {
  const tokenHash = hashToken(token);

  const { data: tokenData } = await supabase
    .from('email_verification_tokens' as string)
    .select('id, user_id, expires_at, used_at')
    .eq('token_hash', tokenHash)
    .maybeSingle<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();

  if (!tokenData) {
    throw AppError.badRequest(MENSAJE_ENLACE_INVALIDO, 'INVALID_VERIFICATION_TOKEN');
  }

  // Idempotencia: si el enlace ya se usó (doble click en el correo, o el
  // usuario lo reabre) y la cuenta ya quedó verificada, respondemos éxito en
  // vez de un "enlace inválido" alarmante — la cuenta ya está activa.
  if (tokenData.used_at) {
    const { data: perfilRow } = await (supabase
      .from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('email_verified_at')
      .eq('id', tokenData.user_id)
      .maybeSingle();
    const perfilVerificado = perfilRow as { email_verified_at: string | null } | null;
    if (perfilVerificado?.email_verified_at) {
      return { message: 'Su correo ya estaba verificado. Ya puede iniciar sesión.' };
    }
    throw AppError.badRequest(MENSAJE_ENLACE_INVALIDO, 'INVALID_VERIFICATION_TOKEN');
  }

  if (new Date(tokenData.expires_at) < new Date()) {
    throw AppError.badRequest(MENSAJE_ENLACE_INVALIDO, 'INVALID_VERIFICATION_TOKEN');
  }

  // Primero se activa la cuenta y solo después se gasta el enlace. Antes se
  // marcaba usado de entrada y no se revisaba ninguna escritura: un fallo a
  // medias respondía «verificado» y dejaba a la persona sin cuenta activa y sin
  // enlace. Si algo falla responde 500 y el mismo enlace sirve para reintentar
  // (las tres escrituras se pueden repetir sin daño).
  const activada = await activarAutorregistroPendiente(tokenData.user_id);

  const { error: tokenError } = await (supabase
    .from('email_verification_tokens' as string) as ReturnType<typeof supabase.from>)
    .update({ used_at: new Date().toISOString() } as never)
    .eq('id', tokenData.id);
  if (tokenError) {
    logger.error({ error: tokenError.message, userId: tokenData.user_id }, 'Verificación de correo: no se pudo marcar el enlace como usado');
    throw new AppError(500, 'INTERNAL_ERROR', 'No pudimos completar la verificación. Inténtelo de nuevo.');
  }

  // La cuenta ya no estaba pendiente (se verificó por otro enlace): no se tocó.
  if (!activada) {
    return { message: 'Su correo ya estaba verificado. Ya puede iniciar sesión.' };
  }

  logger.info({ userId: tokenData.user_id }, 'Email verificado y cuenta activada');

  return { message: 'Correo verificado. Su cuenta está activa y ya puede iniciar sesión.' };
}

/**
 * Da por verificado el correo de un autorregistro pendiente y activa su cuenta.
 * El registro arranca en estado='inactivo' como medida anti-bot/anti-spam; abrir
 * un enlace que llegó a ese correo prueba el control de la casilla.
 *
 * Devuelve false, sin tocar nada, si la cuenta no es un autorregistro pendiente:
 * una ya verificada pudo desactivarla un administrador y un enlace que siga
 * vigente no la reactiva.
 *
 * Revisa cada escritura y lanza si alguna falla: quien llama no gasta su enlace
 * hasta que esto termine bien. Primero Auth y después el perfil: si falla el
 * segundo, el reenvío de verificación todavía sirve (mira el perfil); al revés,
 * la cuenta quedaba verificada en el perfil, sin poder entrar y sin reenvío.
 */
export async function activarAutorregistroPendiente(userId: string): Promise<boolean> {
  function fallo(paso: string, error: { message: string }): never {
    logger.error({ error: error.message, userId }, `Activación de la cuenta: falló ${paso}`);
    throw new AppError(500, 'INTERNAL_ERROR', 'No pudimos activar su cuenta. Inténtelo de nuevo.');
  }
  const perfiles = () => supabase.from('perfiles' as string) as ReturnType<typeof supabase.from>;

  const { data: perfil, error: lecturaError } = await perfiles()
    .select('registration_source, email_verified_at')
    .eq('id', userId)
    .maybeSingle();
  if (lecturaError) fallo('la lectura del perfil', lecturaError);
  if (!perfil || !esAutorregistroSinVerificar(perfil as EstadoVerificacion)) return false;

  const { error: authError } = await supabaseAuth.auth.admin.updateUserById(userId, { email_confirm: true });
  if (authError) fallo('la confirmación del correo en Auth', authError);

  const { error: perfilError } = await perfiles()
    .update({ email_verified_at: new Date().toISOString(), estado: 'activo' } as never)
    .eq('id', userId);
  if (perfilError) fallo('la activación del perfil', perfilError);

  return true;
}

export async function resendVerification({ email }: ResendVerificationInput): Promise<{ message: string }> {
  const genericMessage = 'Si el email existe en nuestro sistema, recibirá un nuevo enlace de verificación.';

  const { data: userResult, error: rpcError } = await supabase
    .rpc('find_user_by_email' as never, { user_email: email } as never)
    .single<{ id: string; email: string }>();

  if (rpcError || !userResult) {
    return { message: genericMessage };
  }

  // Solo cuentas autoregistradas por correo y aun sin verificar. Las creadas
  // por el administrador, la vitrina, Google o una invitacion nunca llenan
  // email_verified_at: si recibieran un token, verifyEmail reactivaria una
  // cuenta que el administrador desactivo.
  const { data: perfil } = await supabase
    .from('perfiles' as string)
    .select('email_verified_at, nombre, registration_source')
    .eq('id', userResult.id)
    .single<{ email_verified_at: string | null; nombre: string; registration_source: string | null }>();

  if (!perfil || !esAutorregistroSinVerificar(perfil)) {
    return { message: genericMessage };
  }

  await generateAndSendVerificationEmail(userResult.id, email, perfil.nombre || '');

  return { message: genericMessage };
}

// --- Helpers ---

/**
 * Persiste la aceptación de términos + tratamiento de datos del usuario.
 * Exportado para reuso desde vitrina.service.registerSolicitante (el flujo
 * público del solicitante requiere la misma evidencia legal que propietario
 * e inmobiliaria: user_id + timestamps + IP + user-agent).
 *
 * Error policy: log-only. No se revierte el registro del usuario si este
 * INSERT falla — decisión heredada del flujo propietario/inmobiliaria.
 */
export async function recordTermsAcceptance(
  userId: string,
  ipAddress: string,
  userAgent: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await (supabase
    .from('terminos_aceptaciones' as string) as ReturnType<typeof supabase.from>)
    .insert({
      user_id: userId,
      acepta_terminos: true,
      acepta_tratamiento_datos: true,
      terminos_aceptados_at: now,
      datos_aceptados_at: now,
      ip_address: ipAddress,
      user_agent: userAgent,
    } as never);

  if (error) {
    logger.error({ error: error.message, userId }, 'Error al registrar aceptacion de terminos');
  }
}

async function generateAndSendVerificationEmail(
  userId: string,
  email: string,
  nombre: string,
): Promise<void> {
  // Invalidar tokens previos de este usuario
  await (supabase
    .from('email_verification_tokens' as string) as ReturnType<typeof supabase.from>)
    .update({ used_at: new Date().toISOString() } as never)
    .eq('user_id', userId)
    .is('used_at', null);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + HORAS_ENLACE_VERIFICACION * 60 * 60 * 1000).toISOString();

  const { error: insertError } = await (supabase
    .from('email_verification_tokens' as string) as ReturnType<typeof supabase.from>)
    .insert({
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    } as never);

  if (insertError) {
    logger.error({ error: insertError.message }, 'Error al guardar token de verificacion');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error interno del servidor');
  }

  const verifyUrl = `${env.FRONTEND_URL}/verificar-email?token=${rawToken}`;

  try {
    await sendVerificationEmail(email, nombre, verifyUrl);
    // Dentro del try: antes quedaba «enviado» aunque el correo no hubiera salido.
    logger.info({ email, userId }, 'Email de verificacion enviado');
  } catch (emailError) {
    // No fallar el registro por error de email: la cuenta ya existe y la
    // persona puede pedir el reenvío.
    logger.error({ error: (emailError as Error)?.message, email, userId }, 'Error al enviar email de verificacion');
  }
}

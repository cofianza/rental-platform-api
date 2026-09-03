import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendAutorizacionEmail, sendOtpEmail } from '@/lib/email';
import { enviarMensaje } from '@/modules/whatsapp/whatsapp.service';
import { WHATSAPP_TEMPLATES } from '@/modules/whatsapp/templates';
import { perfilEsDuenoDeInmueble, assertExpedienteAccess } from '@/lib/tenantScope';
import { env } from '@/config';
import type { FirmarInput, RevocarInput } from './autorizaciones.schema';
import { TEXTO_LEGAL, VERSION_TERMINOS } from './autorizaciones.texto';

// ============================================================
// Constants
// ============================================================

const TOKEN_EXPIRY_HOURS = 48;
const OTP_EXPIRY_MINUTES = 5;
const OTP_COOLDOWN_SECONDS = 60;

// ============================================================
// Helper types
// ============================================================

interface AutorizacionRow {
  id: string;
  solicitante_id: string;
  expediente_id: string | null;
  canal: string;
  estado: string;
  token: string;
  token_expiracion: string;
  generado_por: string;
  autorizado_en: string | null;
  ip_autorizacion: string | null;
  user_agent: string | null;
  texto_autorizado: string | null;
  version_terminos: string | null;
  metodo_firma: string | null;
  datos_firma: string | null;
  hash_documento: string | null;
  fecha_revocacion: string | null;
  motivo_revocacion: string | null;
  created_at: string;
}

interface ExpedienteInfo {
  id: string;
  numero: string;
  estado: string;
  solicitante_id: string;
  solicitantes: {
    id: string;
    nombre: string;
    apellido: string;
    email: string;
    telefono: string | null;
    tipo_documento: string;
    numero_documento: string;
  };
  inmuebles: {
    id: string;
    direccion: string;
    ciudad: string;
    barrio: string | null;
    propietario_id: string | null;
    inmobiliaria_id: string | null;
  };
}

interface OtpRow {
  id: string;
  autorizacion_id: string;
  codigo: string;
  expira_en: string;
  verificado: boolean;
  created_at: string;
}

// ============================================================
// 1. Get autorizacion status for expediente
// ============================================================

export async function getAutorizacionForExpediente(
  expedienteId: string,
  userId?: string,
  userRol?: string,
) {
  // Tenant guard: no-op para roles internos / llamadas sin identidad; lanza 404
  // para un propietario/inmobiliaria/solicitante fuera de su cartera. Esta fila
  // es evidencia legal de la firma habeas data (IP, dispositivo, texto literal),
  // así que no debe exponerse cross-tenant conociendo solo el expedienteId.
  await assertExpedienteAccess(expedienteId, userId, userRol);

  // Verify expediente exists. Para roles internos el guard es no-op, así que
  // conservamos este 404 explícito de "no existe".
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  // Get latest autorizacion DEL TITULAR para este expediente. Incluye los
  // consentimientos opcionales que el solicitante eligió y la evidencia
  // completa de la firma (IP, dispositivo, versión y texto literal firmado) —
  // el panel admin los muestra como soporte legal de la autorización.
  //
  // `coarrendatario_id IS NULL` NO es opcional: desde 2026-09-03 el
  // co-arrendatario invitado tiene su PROPIA fila con el MISMO expediente_id, y
  // como se inserta después, era la que devolvía el `order by created_at desc`.
  // El panel habría mostrado la IP, el dispositivo y el texto de OTRO titular
  // de datos como si fueran los del solicitante: exactamente la evidencia que
  // el 8.4 exige poder demostrar si alguna vez se cuestiona.
  const { data: autorizacion } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, canal, metodo_firma, autorizado_en, hash_documento, fecha_revocacion, motivo_revocacion, token_expiracion, created_at, consent_analitica, consent_comercial, consent_historial_referencia, ip_autorizacion, user_agent, version_terminos, texto_autorizado, numero_documento_aceptante, tipo_documento_aceptante, vigente_hasta')
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return autorizacion as (Record<string, unknown>) | null;
}

// ============================================================
// 2. Enviar enlace de autorizacion
// ============================================================

export async function enviarEnlaceAutorizacion(
  expedienteId: string,
  userId: string,
  ip?: string,
  // Corrección del contacto del solicitante: si viene y difiere, se persiste
  // en `solicitantes` y el enlace (email + WhatsApp) va al corregido.
  contacto?: { email?: string; telefono?: string },
  userRol?: string,
) {
  // 1. Get expediente with solicitante + inmueble
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, solicitante_id, solicitantes(id, nombre, apellido, email, telefono, tipo_documento, numero_documento), inmuebles(id, direccion, ciudad, barrio, propietario_id, inmobiliaria_id)')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  const exp = expediente as unknown as ExpedienteInfo;

  // 0b. Tenant guard: propietario/inmobiliaria solo pueden operar sobre
  // expedientes de un inmueble que administran. Sin esto, cualquier usuario
  // con ese rol podía redirigir el enlace (y ahora reescribir el contacto)
  // de solicitantes ajenos conociendo el expedienteId. Admin/operador pasan.
  if (userRol === 'propietario' || userRol === 'inmobiliaria') {
    const esDueno = await perfilEsDuenoDeInmueble({
      userId,
      userRol,
      inmueblePropietarioId: exp.inmuebles?.propietario_id ?? null,
      inmuebleInmobiliariaId: exp.inmuebles?.inmobiliaria_id ?? null,
    });
    if (!esDueno) {
      throw AppError.forbidden(
        'No tienes permisos para enviar la autorización de este expediente',
        'AUTORIZACION_FORBIDDEN',
      );
    }
  }

  // 1a. Aplicar la corrección de contacto si vino en el body. El teléfono
  // solo cuenta si trae dígitos reales (el PhoneInput de la web deja '+57 '
  // cuando se borra el número).
  const emailNuevo = contacto?.email?.trim().toLowerCase();
  const telNuevo =
    contacto?.telefono && contacto.telefono.replace(/\D/g, '').replace(/^57/, '').length >= 7
      ? contacto.telefono.trim()
      : undefined;
  const cambiaEmail = !!emailNuevo && emailNuevo !== (exp.solicitantes?.email ?? '').toLowerCase();
  const cambiaTel = !!telNuevo && telNuevo !== (exp.solicitantes?.telefono ?? '');
  if ((cambiaEmail || cambiaTel) && exp.solicitante_id) {
    const { error: contactoError } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .update({
        ...(cambiaEmail ? { email: emailNuevo } : {}),
        ...(cambiaTel ? { telefono: telNuevo } : {}),
      } as never)
      .eq('id', exp.solicitante_id);
    if (contactoError) {
      logger.warn(
        { error: contactoError.message, expedienteId },
        'No se pudo actualizar el contacto del solicitante (el enlace se envía igual al corregido)',
      );
    }
    if (cambiaEmail && exp.solicitantes) exp.solicitantes.email = emailNuevo!;
    if (cambiaTel && exp.solicitantes) exp.solicitantes.telefono = telNuevo!;
  }

  if (!exp.solicitantes?.email) {
    throw AppError.badRequest('El solicitante no tiene email registrado', 'SOLICITANTE_SIN_EMAIL');
  }

  // 1b. No re-crear un enlace si el inquilino YA firmó (estado autorizado, no
  // revocado Y VIGENTE). Un nuevo enlace pendiente podría re-firmarse y
  // re-disparar el estudio de crédito. Esto hace idempotente el auto-envío del
  // orquestador (doble webhook de pago) y evita pisar una firma existente desde
  // el botón manual.
  //
  // El predicado tiene que ser el MISMO que el del gate (fn_autorizacion_es_vigente
  // / evaluarAutorizacionPrevia), o las dos capas se contradicen:
  //   - sin `vigente_hasta`: una autorización caducada — que el gate rechaza con
  //     "envíe una nueva solicitud" — bloqueaba justo esa nueva solicitud, y la
  //     única salida era revocar, es decir fabricar en la evidencia legal una
  //     revocación del titular que nunca ocurrió.
  //   - sin `coarrendatario_id IS NULL`: la fila del co-arrendatario (mismo
  //     expediente_id) bloqueaba el enlace del titular de inmediato.
  const { data: yaAutorizada } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .eq('estado', 'autorizado')
    .is('fecha_revocacion', null)
    .or(`vigente_hasta.is.null,vigente_hasta.gt.${new Date().toISOString()}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (yaAutorizada) {
    throw AppError.badRequest(
      'Este expediente ya tiene una autorizacion firmada vigente.',
      'AUTORIZACION_YA_FIRMADA',
    );
  }

  // 2. Invalidate any existing pending autorizacion DEL TITULAR for this
  //    expediente (mismo filtro de sujeto que el resto del módulo).
  await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'expirado' } as never)
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .eq('estado', 'pendiente');

  // 3. Generate secure token
  const token = crypto.randomBytes(32).toString('hex');
  const tokenExpiracion = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  // 4. Insert new autorizacion
  const { data: autorizacion, error: insertError } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .insert({
      solicitante_id: exp.solicitante_id,
      expediente_id: expedienteId,
      canal: 'enlace',
      estado: 'pendiente',
      token,
      token_expiracion: tokenExpiracion,
      generado_por: userId,
      texto_autorizado: TEXTO_LEGAL,
      version_terminos: VERSION_TERMINOS,
    } as never)
    .select('id')
    .single();

  if (insertError || !autorizacion) {
    logger.error({ error: insertError, expedienteId }, 'Error al crear autorizacion');
    throw AppError.badRequest('Error al crear la autorizacion', 'AUTORIZACION_CREATE_ERROR');
  }

  const autorizacionId = (autorizacion as unknown as { id: string }).id;

  // 5. Send email
  const autorizacionUrl = `${env.FRONTEND_URL}/autorizar/${token}`;
  const nombreCompleto = `${exp.solicitantes.nombre} ${exp.solicitantes.apellido}`;

  // Email best-effort: si Resend falla (p.ej. dirección no verificada en dev),
  // NO debe bloquear el envío del link por WhatsApp que viene abajo.
  try {
    await sendAutorizacionEmail(exp.solicitantes.email, nombreCompleto, autorizacionUrl, TOKEN_EXPIRY_HOURS);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), expedienteId },
      'No se pudo enviar el email de autorización (se continúa con WhatsApp)',
    );
  }

  // 5b. Enviar también el link por WhatsApp si hay celular (best-effort; el
  // email queda como respaldo). WhatsApp directo vía Meta (no Auco).
  if (exp.solicitantes.telefono) {
    const res = await enviarMensaje({
      to: exp.solicitantes.telefono,
      template_id: WHATSAPP_TEMPLATES.AUTORIZACION_LINK.id,
      language: WHATSAPP_TEMPLATES.AUTORIZACION_LINK.language,
      variables: [exp.solicitantes.nombre, autorizacionUrl],
      context: { expediente_id: expedienteId },
    });
    if (res.estado === 'fallido') {
      logger.warn({ error: res.error, expedienteId }, 'No se pudo enviar el link de autorización por WhatsApp');
    }
  }

  // 6. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.AUTORIZACION_ENLACE_SENT,
    entidad: AUDIT_ENTITIES.AUTORIZACION,
    entidadId: autorizacionId,
    detalle: {
      expediente_id: expedienteId,
      solicitante_id: exp.solicitante_id,
      email: exp.solicitantes.email,
    },
    ip,
  });

  return {
    id: autorizacionId,
    estado: 'pendiente',
    token_expiracion: tokenExpiracion,
  };
}

// ============================================================
// 3. Get autorizacion by token (public)
// ============================================================

/** Enmascara un teléfono dejando visibles solo los 2 últimos dígitos. */
function maskTelefono(tel: string | null): string | null {
  if (!tel) return null;
  const digits = tel.replace(/\D/g, '');
  if (digits.length < 2) return null;
  return `••• ••${digits.slice(-2)}`;
}

export async function getAutorizacionByToken(token: string) {
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, estado, token_expiracion, texto_autorizado, version_terminos, metodo_firma,
      solicitantes(nombre, apellido, telefono),
      expedientes(numero, inmuebles(direccion, ciudad, barrio))
    `)
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion por token');
    throw fromSupabaseError(error);
  }
  if (!autorizacion) {
    throw AppError.notFound('Autorizacion no encontrada o enlace invalido', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as {
    id: string;
    estado: string;
    token_expiracion: string;
    texto_autorizado: string;
    version_terminos: string;
    metodo_firma: string | null;
    solicitantes: { nombre: string; apellido: string; telefono: string | null };
    expedientes: { numero: string; inmuebles: { direccion: string; ciudad: string; barrio: string | null } };
  };

  // Check if expired
  if (new Date(auth.token_expiracion) < new Date()) {
    // Mark as expired if still pending
    if (auth.estado === 'pendiente') {
      await (supabase
        .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'expirado' } as never)
        .eq('id', auth.id);
    }
    throw AppError.badRequest('El enlace de autorizacion ha expirado', 'AUTORIZACION_EXPIRADA');
  }

  if (auth.estado !== 'pendiente') {
    throw AppError.badRequest(
      auth.estado === 'autorizado'
        ? 'Esta autorizacion ya fue firmada'
        : `Esta autorizacion tiene estado: ${auth.estado}`,
      'AUTORIZACION_ESTADO_INVALIDO',
    );
  }

  return {
    id: auth.id,
    estado: auth.estado,
    texto_legal: auth.texto_autorizado,
    version_terminos: auth.version_terminos,
    solicitante: {
      nombre: auth.solicitantes.nombre,
      apellido: auth.solicitantes.apellido,
      // PII minimizada para el portador del token: NO se devuelve el email completo
      // (la pantalla no lo usa) y el teléfono va enmascarado.
      telefono_masked: maskTelefono(auth.solicitantes.telefono),
    },
    expediente: {
      numero_expediente: auth.expedientes.numero,
      inmueble: {
        direccion: auth.expedientes.inmuebles.direccion,
        ciudad: auth.expedientes.inmuebles.ciudad,
        barrio: auth.expedientes.inmuebles.barrio,
      },
    },
  };
}

// ============================================================
// 4. Firmar autorizacion (public)
// ============================================================

export async function firmarAutorizacion(
  token: string,
  input: FirmarInput,
  ip?: string,
  userAgent?: string,
) {
  // 1. Get autorizacion and validate
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, token_expiracion, texto_autorizado, solicitante_id, expediente_id, solicitantes(tipo_documento, numero_documento)')
    .eq('token', token)
    .maybeSingle();

  // Distinguir error real de BD (→ 500, reintentable) de "no existe" (→ 404).
  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion para firmar');
    throw fromSupabaseError(error);
  }
  if (!autorizacion) {
    throw AppError.notFound('Autorizacion no encontrada', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as AutorizacionRow & {
    expediente_id?: string;
    solicitantes?: { tipo_documento: string | null; numero_documento: string | null } | null;
  };

  if (auth.estado !== 'pendiente') {
    // Diferenciar: 'autorizado' = ya firmada (el front puede mostrar éxito
    // idempotente); expirado/revocado = el enlace ya NO sirve — mostrar éxito
    // aquí haría creer al solicitante que terminó cuando nada va a correr.
    if (auth.estado === 'autorizado') {
      throw AppError.badRequest('Esta autorizacion ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorizacion ya no esta vigente', 'AUTORIZACION_NO_VIGENTE');
  }

  if (new Date(auth.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de autorizacion ha expirado', 'AUTORIZACION_EXPIRADA');
  }

  // 2. If OTP method, verify the OTP code
  if (input.metodo_firma === 'otp') {
    const { data: otp } = await (supabase
      .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
      .select('id, codigo, expira_en, verificado')
      .eq('autorizacion_id', auth.id)
      .eq('verificado', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!otp) {
      throw AppError.badRequest(
        'Debe verificar el codigo OTP antes de firmar',
        'OTP_NO_VERIFICADO',
      );
    }

    // El OTP verificado no debe estar caducado al momento de firmar: una firma
    // electrónica (Ley 527/1999) con un OTP viejo no es válida como prueba de
    // posesión reciente. El frontend verifica y firma seguido, así que la
    // ventana de 5 min basta; si expiró, hay que solicitar y verificar uno nuevo.
    if (new Date((otp as unknown as OtpRow).expira_en) < new Date()) {
      throw AppError.badRequest(
        'El codigo OTP expiro. Solicite uno nuevo y verifiquelo antes de firmar.',
        'OTP_EXPIRADO',
      );
    }
  }

  // 3. Compute SHA-256 hash of legal text + signature data
  const hashContent = [
    auth.texto_autorizado,
    input.metodo_firma,
    input.datos_firma || '',
    ip || '',
    userAgent || '',
    new Date().toISOString(),
  ].join('|');

  const hashDocumento = crypto.createHash('sha256').update(hashContent).digest('hex');

  // 3b. Congelar el documento del aceptante (flujo 8.4: "el numero de
  // documento de quien acepto"). Se toma un SNAPSHOT de `solicitantes` en el
  // instante de la aceptacion y se guarda en la propia fila: el campo de
  // `solicitantes` es editable por el gestor y el backend lo reescribe tras
  // cada ejecucion (sincronizarDocumentoSolicitante), asi que leerlo por FK
  // mas tarde no prueba a quien se le pidio la autorizacion.
  const numeroDocumentoAceptante = auth.solicitantes?.numero_documento?.trim() || null;
  const tipoDocumentoAceptante = auth.solicitantes?.tipo_documento?.trim().toLowerCase() || null;
  if (!numeroDocumentoAceptante) {
    logger.warn(
      { autorizacionId: auth.id, solicitanteId: auth.solicitante_id },
      'firmarAutorizacion: el solicitante no tiene numero_documento — la evidencia queda sin documento del aceptante',
    );
  }

  // 3c. Vigencia congelada. Se calcula una sola vez, aqui, para que un cambio
  // de politica no reescriba evidencia pasada.
  const autorizadoEn = new Date();
  const vigenteHasta = new Date(autorizadoEn);
  vigenteHasta.setMonth(vigenteHasta.getMonth() + env.AUTORIZACION_VIGENCIA_MESES);

  // 4. Update autorizacion to autorizado.
  // Idempotencia / anti doble-firma: el UPDATE incluye `.eq('estado','pendiente')`,
  // así la transición es atómica. Si dos POST /firmar entran concurrentes, solo uno
  // afecta filas; el otro recibe 0 filas y se trata como "ya procesada" SIN volver a
  // disparar el orquestador (evita estudio de crédito duplicado).
  const { data: updatedRows, error: updateError } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'autorizado',
      metodo_firma: input.metodo_firma,
      datos_firma: input.datos_firma || null,
      hash_documento: hashDocumento,
      autorizado_en: autorizadoEn.toISOString(),
      ip_autorizacion: ip || null,
      user_agent: userAgent || null,
      // Evidencia del 8.4 que faltaba: documento del aceptante congelado.
      numero_documento_aceptante: numeroDocumentoAceptante,
      tipo_documento_aceptante: tipoDocumentoAceptante,
      vigencia_meses: env.AUTORIZACION_VIGENCIA_MESES,
      vigente_hasta: vigenteHasta.toISOString(),
      // Consentimientos opcionales (Paso 2). No condicionan el servicio.
      consent_analitica: input.consentimientos_opcionales?.analitica ?? false,
      consent_comercial: input.consentimientos_opcionales?.comercial ?? false,
      consent_historial_referencia: input.consentimientos_opcionales?.historial_referencia ?? false,
    } as never)
    .eq('id', auth.id)
    .eq('estado', 'pendiente')
    .select('id');

  if (updateError) {
    logger.error({ error: updateError, autorizacionId: auth.id }, 'Error al firmar autorizacion');
    throw AppError.badRequest('Error al firmar la autorizacion', 'AUTORIZACION_FIRMA_ERROR');
  }

  if (!updatedRows || (updatedRows as unknown[]).length === 0) {
    // Otra request la procesó entre la lectura y el UPDATE. Releer para
    // diferenciar: 'autorizado' = doble submit (éxito idempotente en el front);
    // expirado/revocado (reenvío que invalidó este enlace) = NO mostrar éxito.
    const { data: actual } = await (supabase
      .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
      .select('estado')
      .eq('id', auth.id)
      .maybeSingle();
    const estadoActual = (actual as { estado?: string } | null)?.estado;
    if (estadoActual === 'autorizado') {
      throw AppError.badRequest('Esta autorizacion ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorizacion ya no esta vigente', 'AUTORIZACION_NO_VIGENTE');
  }

  // 5. Audit
  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.AUTORIZACION_FIRMADA,
    entidad: AUDIT_ENTITIES.AUTORIZACION,
    entidadId: auth.id,
    detalle: {
      solicitante_id: auth.solicitante_id,
      metodo_firma: input.metodo_firma,
      hash_documento: hashDocumento,
      ip,
    },
    ip,
  });

  // 6. Orchestrator: disparar estudio automatico si hay expediente asociado
  if (auth.expediente_id) {
    import('@/modules/orchestrator/orchestrator.service')
      .then(({ onHabeasDataAutorizado }) =>
        onHabeasDataAutorizado({
          expedienteId: auth.expediente_id!,
          solicitanteId: auth.solicitante_id,
          autorizacionId: auth.id,
        }),
      )
      .catch((err) => logger.warn({ error: err }, 'Orchestrator: error en hook post-autorizacion'));
  }

  return {
    estado: 'autorizado',
    hash_documento: hashDocumento,
    autorizado_en: autorizadoEn.toISOString(),
  };
}

// ============================================================
// 5. Enviar codigo OTP (public)
// ============================================================

export async function enviarOtpCode(token: string) {
  // 1. Get autorizacion
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, token_expiracion, solicitantes(nombre, apellido, email, telefono)')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion para enviar OTP');
    throw fromSupabaseError(error);
  }
  if (!autorizacion) {
    throw AppError.notFound('Autorizacion no encontrada', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as {
    id: string;
    estado: string;
    token_expiracion: string;
    solicitantes: { nombre: string; apellido: string; email: string; telefono: string | null };
  };

  if (auth.estado !== 'pendiente') {
    // Diferenciar: 'autorizado' = ya firmada (el front puede mostrar éxito
    // idempotente); expirado/revocado = el enlace ya NO sirve — mostrar éxito
    // aquí haría creer al solicitante que terminó cuando nada va a correr.
    if (auth.estado === 'autorizado') {
      throw AppError.badRequest('Esta autorizacion ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorizacion ya no esta vigente', 'AUTORIZACION_NO_VIGENTE');
  }

  if (new Date(auth.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de autorizacion ha expirado', 'AUTORIZACION_EXPIRADA');
  }

  // 2. Check cooldown — last OTP must be older than 60 seconds
  const { data: lastOtp } = await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .select('created_at')
    .eq('autorizacion_id', auth.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastOtp) {
    const lastCreated = new Date((lastOtp as unknown as OtpRow).created_at).getTime();
    const elapsed = (Date.now() - lastCreated) / 1000;
    if (elapsed < OTP_COOLDOWN_SECONDS) {
      const remaining = Math.ceil(OTP_COOLDOWN_SECONDS - elapsed);
      throw AppError.tooMany(
        `Debe esperar ${remaining} segundos antes de solicitar otro codigo`,
        'OTP_COOLDOWN',
      );
    }
  }

  // 3. Generate 6-digit code. randomInt es [min, max) (max exclusivo), por eso 1000000.
  const codigo = String(crypto.randomInt(100000, 1000000));
  const expiraEn = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  // 3b. Invalidar OTPs previos no verificados (un solo código activo a la vez):
  // reduce la superficie de adivinación y evita códigos antiguos que confunden.
  await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .update({ expira_en: new Date().toISOString() } as never)
    .eq('autorizacion_id', auth.id)
    .eq('verificado', false);

  // 4. Insert OTP record (devolvemos el id para poder limpiarlo si no se entrega).
  const { data: nuevoOtp, error: insertError } = await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .insert({
      autorizacion_id: auth.id,
      codigo,
      expira_en: expiraEn,
    } as never)
    .select('id')
    .maybeSingle();

  if (insertError || !nuevoOtp) {
    logger.error({ error: insertError, autorizacionId: auth.id }, 'Error al crear OTP');
    throw AppError.badRequest('Error al generar el codigo OTP', 'OTP_CREATE_ERROR');
  }

  const otpId = (nuevoOtp as unknown as { id: string }).id;

  // 5. Entregar el OTP. Email y WhatsApp son best-effort, pero rastreamos si AL
  // MENOS UN canal lo aceptó: si ninguno entrega, no podemos reportar éxito (el
  // usuario quedaría esperando un código que nunca llega).
  const nombreCompleto = `${auth.solicitantes.nombre} ${auth.solicitantes.apellido}`;
  let entregado = false;

  try {
    await sendOtpEmail(auth.solicitantes.email, nombreCompleto, codigo);
    entregado = true;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), autorizacionId: auth.id },
      'No se pudo enviar el OTP por email (se intenta WhatsApp)',
    );
  }

  // 5b. Enviar el OTP por WhatsApp si hay celular (best-effort; email de respaldo).
  if (auth.solicitantes.telefono) {
    const res = await enviarMensaje({
      to: auth.solicitantes.telefono,
      template_id: WHATSAPP_TEMPLATES.AUTORIZACION_OTP.id,
      language: WHATSAPP_TEMPLATES.AUTORIZACION_OTP.language,
      variables: [codigo],
      is_authentication: true,
    });
    if (res.estado === 'fallido') {
      logger.warn({ error: res.error, autorizacionId: auth.id }, 'No se pudo enviar el OTP por WhatsApp');
    } else {
      entregado = true;
    }
  }

  // 5c. Si ningún canal entregó, eliminamos el OTP recién creado (para no bloquear
  // el reintento por cooldown) y devolvemos error claro para que el usuario reintente.
  if (!entregado) {
    await (supabase
      .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', otpId);
    logger.error({ autorizacionId: auth.id }, 'OTP no entregado por ningún canal (email y WhatsApp fallaron)');
    throw AppError.badRequest(
      'No pudimos enviarte el codigo en este momento. Intenta de nuevo en unos segundos.',
      'OTP_DELIVERY_FAILED',
    );
  }

  return {
    mensaje: auth.solicitantes.telefono
      ? 'Codigo OTP enviado por WhatsApp y correo'
      : 'Codigo OTP enviado al correo del solicitante',
    expira_en: expiraEn,
  };
}

// ============================================================
// 6. Verificar codigo OTP (public)
// ============================================================

export async function verificarOtpCode(token: string, codigo: string) {
  // 1. Get autorizacion
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, token_expiracion')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion para verificar OTP');
    throw fromSupabaseError(error);
  }
  if (!autorizacion) {
    throw AppError.notFound('Autorizacion no encontrada', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as { id: string; estado: string; token_expiracion: string };

  if (auth.estado !== 'pendiente') {
    // Diferenciar: 'autorizado' = ya firmada (el front puede mostrar éxito
    // idempotente); expirado/revocado = el enlace ya NO sirve — mostrar éxito
    // aquí haría creer al solicitante que terminó cuando nada va a correr.
    if (auth.estado === 'autorizado') {
      throw AppError.badRequest('Esta autorizacion ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorizacion ya no esta vigente', 'AUTORIZACION_NO_VIGENTE');
  }

  // 2. Find matching OTP (not expired, not verified)
  const { data: otp } = await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .select('id, codigo, expira_en, verificado')
    .eq('autorizacion_id', auth.id)
    .eq('verificado', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!otp) {
    throw AppError.badRequest('No hay codigo OTP pendiente. Solicite uno nuevo.', 'OTP_NOT_FOUND');
  }

  const otpRow = otp as unknown as OtpRow;

  if (new Date(otpRow.expira_en) < new Date()) {
    throw AppError.badRequest(
      'El codigo OTP ha expirado. Solicite uno nuevo.',
      'OTP_EXPIRADO',
    );
  }

  if (otpRow.codigo !== codigo) {
    throw AppError.badRequest('Codigo OTP incorrecto', 'OTP_INCORRECTO');
  }

  // 3. Mark OTP as verified
  await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .update({ verificado: true } as never)
    .eq('id', otpRow.id);

  return {
    verificado: true,
    mensaje: 'Codigo OTP verificado correctamente',
  };
}

// ============================================================
// 7. Revocar autorizacion (auth)
// ============================================================

export async function revocarAutorizacion(
  expedienteId: string,
  input: RevocarInput,
  userId: string,
  userRol?: string,
  ip?: string,
) {
  // Tenant guard: no-op para roles internos / llamadas sin identidad; 404 para
  // propietario/inmobiliaria/solicitante fuera de su cartera. Revocar es mutar
  // la evidencia legal de la firma, así que gateamos ANTES de buscar/mutar.
  await assertExpedienteAccess(expedienteId, userId, userRol);

  // 1. Find active autorizacion DEL TITULAR for this expediente.
  //
  //    `coarrendatario_id IS NULL` + ORDER BY determinista: desde 2026-09-03 un
  //    expediente puede tener DOS filas 'autorizado' (titular y co-arrendatario
  //    invitado). Sin filtrar por sujeto, Postgres podía devolver la del
  //    co-arrendatario: la API respondía 200 'revocado' al titular, revocaba a
  //    quien no lo pidió y dejaba viva la firma del titular — que el gate seguía
  //    aceptando, así que el buró se podía volver a consultar sobre alguien que
  //    acababa de revocar. Y el trigger de la migración hace la revocación
  //    irreversible. El gate (autorizacion.guard.ts) ya resuelve el sujeto antes
  //    de consultar; aquí se hace igual.
  //
  //    `input.coarrendatario_id` selecciona el otro sujeto: es la única vía por
  //    la que se puede revocar la autorización del co-arrendatario invitado
  //    (Ley 1581 de 2012, art. 8) sin tocar la del titular.
  const base = (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .eq('estado', 'autorizado')
    .is('fecha_revocacion', null)
    .order('created_at', { ascending: false })
    .limit(1);

  const { data: autorizacion, error } = await (input.coarrendatario_id
    ? base.eq('coarrendatario_id', input.coarrendatario_id)
    : base.is('coarrendatario_id', null)
  ).maybeSingle();

  if (error || !autorizacion) {
    throw AppError.notFound(
      input.coarrendatario_id
        ? 'No se encontro autorizacion activa de ese co-arrendatario en este expediente'
        : 'No se encontro autorizacion activa para este expediente',
      'AUTORIZACION_NOT_FOUND',
    );
  }

  const auth = autorizacion as unknown as { id: string; estado: string };

  // 2. Update to revocado
  const { error: updateError } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'revocado',
      fecha_revocacion: new Date().toISOString(),
      motivo_revocacion: input.motivo,
    } as never)
    .eq('id', auth.id);

  if (updateError) {
    logger.error({ error: updateError, autorizacionId: auth.id }, 'Error al revocar autorizacion');
    throw AppError.badRequest('Error al revocar la autorizacion', 'AUTORIZACION_REVOKE_ERROR');
  }

  // 3. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.AUTORIZACION_REVOCADA,
    entidad: AUDIT_ENTITIES.AUTORIZACION,
    entidadId: auth.id,
    detalle: {
      expediente_id: expedienteId,
      motivo: input.motivo,
      sujeto: input.coarrendatario_id ? 'coarrendatario' : 'solicitante',
      ...(input.coarrendatario_id ? { coarrendatario_id: input.coarrendatario_id } : {}),
    },
    ip,
  });

  return {
    estado: 'revocado',
    fecha_revocacion: new Date().toISOString(),
  };
}

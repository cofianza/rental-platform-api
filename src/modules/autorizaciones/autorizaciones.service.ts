import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendAutorizacionEmail, sendOtpEmail } from '@/lib/email';
import { env } from '@/config';
import type { FirmarInput, RevocarInput } from './autorizaciones.schema';

// ============================================================
// Constants
// ============================================================

const TOKEN_EXPIRY_HOURS = 48;
const OTP_EXPIRY_MINUTES = 5;
const OTP_COOLDOWN_SECONDS = 60;
const VERSION_TERMINOS = '1.0';

const TEXTO_LEGAL = `AUTORIZACION PARA CONSULTA Y REPORTE EN CENTRALES DE RIESGO

En cumplimiento de la Ley 1581 de 2012 (Proteccion de Datos Personales) y la Ley 1266 de 2008 (Habeas Data), autorizo de manera libre, expresa, voluntaria e informada a HABITAR PROPIEDADES y/o a quien esta designe, para que:

1. Consulte, solicite, recopile, almacene, use, circule y trate mi informacion personal, financiera y crediticia ante cualquier central de riesgo o base de datos, incluyendo pero no limitado a TransUnion (CIFIN), Datacredito (Experian) y SIFIN.

2. Dicha informacion sera utilizada exclusivamente para evaluar mi capacidad de pago y solvencia financiera en el marco de un proceso de arrendamiento de inmueble.

3. La presente autorizacion permanecera vigente mientras exista una relacion contractual o comercial, y por el tiempo adicional que permita la ley para el ejercicio de acciones legales.

4. Declaro que conozco mis derechos como titular de datos personales, incluyendo el derecho a conocer, actualizar, rectificar y solicitar la supresion de mis datos.

5. Esta autorizacion es revocable en cualquier momento, mediante solicitud escrita dirigida a HABITAR PROPIEDADES.

Al firmar este documento, confirmo que he leido, entendido y aceptado los terminos aqui descritos.`;

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
    tipo_documento: string;
    numero_documento: string;
  };
  inmuebles: {
    id: string;
    direccion: string;
    ciudad: string;
    barrio: string | null;
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

export async function getAutorizacionForExpediente(expedienteId: string) {
  // Verify expediente exists
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  // Get latest autorizacion for this expediente
  const { data: autorizacion } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, canal, metodo_firma, autorizado_en, hash_documento, fecha_revocacion, motivo_revocacion, token_expiracion, created_at')
    .eq('expediente_id', expedienteId)
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
) {
  // 1. Get expediente with solicitante + inmueble
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, solicitante_id, solicitantes(id, nombre, apellido, email, tipo_documento, numero_documento), inmuebles(id, direccion, ciudad, barrio)')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  const exp = expediente as unknown as ExpedienteInfo;

  if (!exp.solicitantes?.email) {
    throw AppError.badRequest('El solicitante no tiene email registrado', 'SOLICITANTE_SIN_EMAIL');
  }

  // 2. Invalidate any existing pending autorizacion for this expediente
  await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'expirado' } as never)
    .eq('expediente_id', expedienteId)
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

  await sendAutorizacionEmail(exp.solicitantes.email, nombreCompleto, autorizacionUrl, TOKEN_EXPIRY_HOURS);

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

export async function getAutorizacionByToken(token: string) {
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, estado, token_expiracion, texto_autorizado, version_terminos, metodo_firma,
      solicitantes(nombre, apellido, email),
      expedientes(numero, inmuebles(direccion, ciudad, barrio))
    `)
    .eq('token', token)
    .single();

  if (error || !autorizacion) {
    throw AppError.notFound('Autorizacion no encontrada o enlace invalido', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as {
    id: string;
    estado: string;
    token_expiracion: string;
    texto_autorizado: string;
    version_terminos: string;
    metodo_firma: string | null;
    solicitantes: { nombre: string; apellido: string; email: string };
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
      email: auth.solicitantes.email,
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
    .select('id, estado, token_expiracion, texto_autorizado, solicitante_id')
    .eq('token', token)
    .single();

  if (error || !autorizacion) {
    throw AppError.notFound('Autorizacion no encontrada', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as AutorizacionRow;

  if (auth.estado !== 'pendiente') {
    throw AppError.badRequest('Esta autorizacion ya fue procesada', 'AUTORIZACION_ESTADO_INVALIDO');
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

  // 4. Update autorizacion to autorizado
  const { error: updateError } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'autorizado',
      metodo_firma: input.metodo_firma,
      datos_firma: input.datos_firma || null,
      hash_documento: hashDocumento,
      autorizado_en: new Date().toISOString(),
      ip_autorizacion: ip || null,
      user_agent: userAgent || null,
    } as never)
    .eq('id', auth.id);

  if (updateError) {
    logger.error({ error: updateError, autorizacionId: auth.id }, 'Error al firmar autorizacion');
    throw AppError.badRequest('Error al firmar la autorizacion', 'AUTORIZACION_FIRMA_ERROR');
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

  return {
    estado: 'autorizado',
    hash_documento: hashDocumento,
    autorizado_en: new Date().toISOString(),
  };
}

// ============================================================
// 5. Enviar codigo OTP (public)
// ============================================================

export async function enviarOtpCode(token: string) {
  // 1. Get autorizacion
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, token_expiracion, solicitantes(nombre, apellido, email)')
    .eq('token', token)
    .single();

  if (error || !autorizacion) {
    throw AppError.notFound('Autorizacion no encontrada', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as {
    id: string;
    estado: string;
    token_expiracion: string;
    solicitantes: { nombre: string; apellido: string; email: string };
  };

  if (auth.estado !== 'pendiente') {
    throw AppError.badRequest('Esta autorizacion ya fue procesada', 'AUTORIZACION_ESTADO_INVALIDO');
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

  // 3. Generate 6-digit code
  const codigo = String(crypto.randomInt(100000, 999999));
  const expiraEn = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  // 4. Insert OTP record
  const { error: insertError } = await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .insert({
      autorizacion_id: auth.id,
      codigo,
      expira_en: expiraEn,
    } as never);

  if (insertError) {
    logger.error({ error: insertError, autorizacionId: auth.id }, 'Error al crear OTP');
    throw AppError.badRequest('Error al generar el codigo OTP', 'OTP_CREATE_ERROR');
  }

  // 5. Send OTP email
  const nombreCompleto = `${auth.solicitantes.nombre} ${auth.solicitantes.apellido}`;
  await sendOtpEmail(auth.solicitantes.email, nombreCompleto, codigo);

  return {
    mensaje: 'Codigo OTP enviado al correo del solicitante',
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
    .single();

  if (error || !autorizacion) {
    throw AppError.notFound('Autorizacion no encontrada', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as { id: string; estado: string; token_expiracion: string };

  if (auth.estado !== 'pendiente') {
    throw AppError.badRequest('Esta autorizacion ya fue procesada', 'AUTORIZACION_ESTADO_INVALIDO');
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
  ip?: string,
) {
  // 1. Find active autorizacion for this expediente
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .eq('estado', 'autorizado')
    .is('fecha_revocacion', null)
    .limit(1)
    .maybeSingle();

  if (error || !autorizacion) {
    throw AppError.notFound(
      'No se encontro autorizacion activa para este expediente',
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
    },
    ip,
  });

  return {
    estado: 'revocado',
    fecha_revocacion: new Date().toISOString(),
  };
}

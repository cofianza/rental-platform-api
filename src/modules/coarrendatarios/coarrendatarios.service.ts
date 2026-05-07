// ============================================================
// Co-arrendatario — Service
//
// Mario (5-may-2026): cuando un estudio queda condicionado, el solicitante
// puede invitar a un co-arrendatario (la persona con quien va a vivir) en
// lugar de subir documentación adicional. El co-arrendatario acepta T&C
// desde un link público y se le hace su propio estudio TransUnion. Los
// dos estudios se ponderan para decidir el expediente.
// ============================================================

import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import { Resend } from 'resend';
import { notificarUsuario, findPerfilIdByEmail } from '../notificaciones/notificaciones.service';
import type { InvitarCoarrendatarioInput, AceptarCoarrendatarioInput } from './coarrendatarios.schema';

const resend = new Resend(env.RESEND_API_KEY);
const FROM = `Cofianza <${env.RESEND_FROM_EMAIL}>`;
const TOKEN_EXPIRY_DAYS = 7;

// ============================================================
// Tipos
// ============================================================

export interface Coarrendatario {
  id: string;
  expediente_id: string;
  nombre: string;
  apellido: string;
  tipo_documento: string;
  numero_documento: string;
  email: string;
  telefono: string | null;
  estado: 'pendiente_aceptacion' | 'aceptado' | 'rechazado_invitacion' | 'estudio_completado';
  estudio_id: string | null;
  aceptado_at: string | null;
  rechazado_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Datos del estudio TransUnion del coarrendatario, embebidos para que la UI
   * del propietario pueda mostrar resultado + score sin un fetch extra.
   * Se llena tras el dispatch (estado 'aceptado' o 'estudio_completado'); null
   * si todavía no hay estudio.
   */
  estudio?: {
    id: string;
    estado: string;
    resultado: string | null;
    score: number | null;
    observaciones: string | null;
    fecha_completado: string | null;
  } | null;
}

interface ExpedienteCtx {
  id: string;
  numero: string;
  estado: string;
  solicitante_creado_por: string | null;
  inmueble_propietario_id: string | null;
  inmueble_direccion: string;
  inmueble_ciudad: string;
  solicitante_email: string | null;
  solicitante_nombre: string | null;
}

// ============================================================
// Helpers privados
// ============================================================

async function fetchExpedienteCtx(expedienteId: string): Promise<ExpedienteCtx> {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, numero, estado, ' +
        'solicitantes(creado_por, email, nombre, apellido), ' +
        'inmuebles(propietario_id, direccion, ciudad)',
    )
    .eq('id', expedienteId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Expediente no encontrado');
  }

  const row = data as unknown as {
    id: string;
    numero: string;
    estado: string;
    solicitantes: { creado_por: string | null; email: string; nombre: string; apellido: string } | null;
    inmuebles: { propietario_id: string; direccion: string; ciudad: string } | null;
  };

  return {
    id: row.id,
    numero: row.numero,
    estado: row.estado,
    solicitante_creado_por: row.solicitantes?.creado_por ?? null,
    inmueble_propietario_id: row.inmuebles?.propietario_id ?? null,
    inmueble_direccion: row.inmuebles?.direccion ?? '',
    inmueble_ciudad: row.inmuebles?.ciudad ?? '',
    solicitante_email: row.solicitantes?.email ?? null,
    solicitante_nombre: row.solicitantes
      ? `${row.solicitantes.nombre} ${row.solicitantes.apellido}`.trim()
      : null,
  };
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function tokenExpiracion(): string {
  return new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Mensaje legible que persistimos en `expedientes.motivo_rechazo` cuando la
 * ponderación titular+coarrendatario rechaza el expediente. Lo lee el banner
 * de cierre del expediente en la web.
 */
function buildMotivoRechazoCoarrendatario(
  titularResultado: string,
  coarrendatarioResultado: string,
): string {
  if (titularResultado === 'condicionado' && coarrendatarioResultado === 'condicionado') {
    return 'Tanto el estudio del titular como el del co-arrendatario quedaron en perfil marginal. La solicitud no procede.';
  }
  if (coarrendatarioResultado === 'rechazado') {
    return 'El estudio crediticio del co-arrendatario invitado fue rechazado. La solicitud no procede.';
  }
  if (titularResultado === 'rechazado') {
    return 'El estudio crediticio del titular fue rechazado. La solicitud no procede.';
  }
  return 'La ponderación de los estudios crediticios del titular y el co-arrendatario no permite respaldar este arrendamiento.';
}

// ============================================================
// 1. Invitar a un co-arrendatario
// ============================================================

export async function invitarCoarrendatario(
  expedienteId: string,
  userId: string,
  userRol: string,
  input: InvitarCoarrendatarioInput,
): Promise<Coarrendatario> {
  // 1. Cargar contexto del expediente y validar ownership.
  const ctx = await fetchExpedienteCtx(expedienteId);

  const esAdmin = userRol === 'administrador' || userRol === 'operador_analista';
  const esSolicitante = userRol === 'solicitante' && ctx.solicitante_creado_por === userId;
  const esPropietario =
    (userRol === 'propietario' || userRol === 'inmobiliaria') &&
    ctx.inmueble_propietario_id === userId;

  if (!esAdmin && !esSolicitante && !esPropietario) {
    throw AppError.forbidden(
      'No tienes permisos para invitar a un co-arrendatario en este expediente',
      'COARRENDATARIO_FORBIDDEN',
    );
  }

  // 2. Estado del expediente debe ser 'condicionado' — única ventana donde
  //    tiene sentido invitar. En otros estados o ya está aprobado o el
  //    estudio aún no se ejecutó.
  if (ctx.estado !== 'condicionado') {
    throw AppError.badRequest(
      `Solo se puede invitar co-arrendatario cuando el expediente está condicionado. Estado actual: ${ctx.estado}.`,
      'EXPEDIENTE_NO_CONDICIONADO',
    );
  }

  // 3. No reinvitar el mismo email del titular (no tiene sentido).
  if (ctx.solicitante_email && input.email.toLowerCase() === ctx.solicitante_email.toLowerCase()) {
    throw AppError.badRequest(
      'El co-arrendatario no puede ser la misma persona que el solicitante',
      'COARRENDATARIO_MISMO_EMAIL',
    );
  }

  // 4. Insert. El unique index parcial bloquea duplicados activos — error
  //    23505 lo mapeamos a un mensaje claro.
  const token = generateToken();
  const { data, error } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      nombre: input.nombre,
      apellido: input.apellido,
      tipo_documento: input.tipo_documento,
      numero_documento: input.numero_documento,
      email: input.email.toLowerCase(),
      telefono: input.telefono ?? null,
      token,
      token_expiracion: tokenExpiracion(),
      estado: 'pendiente_aceptacion',
      invitado_por: userId,
    } as never)
    .select('*')
    .single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      throw AppError.conflict(
        'Ya hay un co-arrendatario activo invitado para este expediente. Si quieres invitar a otra persona, primero rechaza la invitación actual.',
        'COARRENDATARIO_DUPLICADO',
      );
    }
    logger.error({ error: error.message, expedienteId }, 'Error al insertar co-arrendatario');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear la invitación');
  }

  const coa = data as unknown as Coarrendatario;

  // 5. Email de invitación — link público con el token.
  const link = `${env.FRONTEND_URL}/coarrendatario/${token}`;
  const titularNombre = ctx.solicitante_nombre || 'el solicitante';
  const inmuebleStr = `${ctx.inmueble_direccion}${ctx.inmueble_ciudad ? `, ${ctx.inmueble_ciudad}` : ''}`;

  resend.emails
    .send({
      from: FROM,
      to: input.email,
      subject: `${titularNombre} te invita a ser su co-arrendatario en Cofianza`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px;">Invitación a co-arrendar</h1>
          </div>
          <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
            <p style="color: #374151; font-size: 16px;">Hola <strong>${input.nombre}</strong>,</p>
            <p style="color: #6b7280;"><strong>${titularNombre}</strong> te invita a ser su co-arrendatario para el inmueble en <strong>${inmuebleStr}</strong>.</p>
            <p style="color: #6b7280;">En Cofianza renta sin fiador. Si aceptas la invitación, evaluaremos tu perfil junto con el de ${titularNombre} y respaldamos a los dos como un solo arrendatario.</p>
            <div style="text-align: center; margin: 24px 0;">
              <a href="${link}" style="display: inline-block; background: #0d9488; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Revisar invitación</a>
            </div>
            <p style="color: #9ca3af; font-size: 12px;">Si no esperabas esta invitación, puedes ignorar este correo. El enlace expira en ${TOKEN_EXPIRY_DAYS} días.</p>
          </div>
        </div>
      `,
    })
    .catch((e) => logger.warn({ error: e, expedienteId, email: input.email }, 'Error enviando email invitacion coarrendatario'));

  // 6. Notificar al titular para que vea que la invitación se envió.
  if (ctx.solicitante_creado_por) {
    notificarUsuario({
      userId: ctx.solicitante_creado_por,
      tipo: 'coarrendatario.invitado',
      titulo: 'Invitación enviada',
      mensaje: `Le enviamos a ${input.nombre} la invitación para ser tu co-arrendatario. Te avisaremos cuando responda.`,
      link: `/expedientes/${expedienteId}`,
      payload: { expediente_id: expedienteId, coarrendatario_id: coa.id },
    }).catch((e) => logger.warn({ error: e }, 'Error notif coarrendatario invitado'));
  }

  logger.info(
    { expedienteId, coarrendatarioId: coa.id, email: input.email },
    'Coarrendatario invitado',
  );

  return coa;
}

// ============================================================
// 2. Listar / obtener el co-arrendatario actual del expediente
// ============================================================

export async function getCoarrendatarioPorExpediente(
  expedienteId: string,
  userId: string,
  userRol: string,
): Promise<Coarrendatario | null> {
  const ctx = await fetchExpedienteCtx(expedienteId);

  const esAdmin = userRol === 'administrador' || userRol === 'operador_analista';
  const esSolicitante = userRol === 'solicitante' && ctx.solicitante_creado_por === userId;
  const esPropietario =
    (userRol === 'propietario' || userRol === 'inmobiliaria') &&
    ctx.inmueble_propietario_id === userId;

  if (!esAdmin && !esSolicitante && !esPropietario) {
    throw AppError.forbidden('No tienes permisos para ver este expediente', 'EXPEDIENTE_FORBIDDEN');
  }

  const { data } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('expediente_id', expedienteId)
    .neq('estado', 'rechazado_invitacion')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const coa = (data as unknown as Coarrendatario) ?? null;
  if (!coa) return null;

  // Embebemos el estudio asociado (si ya existe) para que el card del
  // propietario muestre resultado/score sin un round-trip adicional.
  if (coa.estudio_id) {
    const { data: estudioRow } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, resultado, score, observaciones, fecha_completado')
      .eq('id', coa.estudio_id)
      .maybeSingle();
    coa.estudio = (estudioRow as Coarrendatario['estudio']) ?? null;
  } else {
    coa.estudio = null;
  }

  return coa;
}

// ============================================================
// 3. Vista pública — el invitado abre /coarrendatario/[token]
// ============================================================

export interface CoarrendatarioPublicView {
  nombre: string;
  apellido: string;
  email: string;
  estado: Coarrendatario['estado'];
  expediente: {
    numero: string;
    inmueble_direccion: string;
    inmueble_ciudad: string;
    titular_nombre: string;
  };
  expira_en: string;
}

export async function getPublicByToken(token: string): Promise<CoarrendatarioPublicView> {
  const { data: coaRow, error } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, nombre, apellido, email, estado, token_expiracion')
    .eq('token', token)
    .maybeSingle();

  if (error || !coaRow) {
    throw AppError.notFound('Invitación no encontrada o expirada', 'COARRENDATARIO_NOT_FOUND');
  }

  const coa = coaRow as unknown as {
    id: string;
    expediente_id: string;
    nombre: string;
    apellido: string;
    email: string;
    estado: Coarrendatario['estado'];
    token_expiracion: string;
  };

  if (new Date(coa.token_expiracion) < new Date()) {
    throw AppError.badRequest('Esta invitación ya expiró', 'TOKEN_EXPIRED');
  }

  // Cargar contexto del expediente para mostrar al invitado de qué se trata.
  const ctx = await fetchExpedienteCtx(coa.expediente_id);

  return {
    nombre: coa.nombre,
    apellido: coa.apellido,
    email: coa.email,
    estado: coa.estado,
    expediente: {
      numero: ctx.numero,
      inmueble_direccion: ctx.inmueble_direccion,
      inmueble_ciudad: ctx.inmueble_ciudad,
      titular_nombre: ctx.solicitante_nombre || 'El solicitante',
    },
    expira_en: coa.token_expiracion,
  };
}

// ============================================================
// 4. Aceptar invitación — el invitado acepta T&C y se dispara estudio
// ============================================================

export interface AceptarResult {
  ok: true;
  estudio_id: string | null;
  mensaje: string;
}

export async function aceptarInvitacion(
  token: string,
  ip: string,
  userAgent: string,
  _input: AceptarCoarrendatarioInput,
): Promise<AceptarResult> {
  // 1. Cargar.
  const { data: coaRow, error } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (error || !coaRow) {
    throw AppError.notFound('Invitación no encontrada', 'COARRENDATARIO_NOT_FOUND');
  }

  const coa = coaRow as unknown as Coarrendatario & { token_expiracion: string };

  if (new Date(coa.token_expiracion) < new Date()) {
    throw AppError.badRequest('Esta invitación ya expiró', 'TOKEN_EXPIRED');
  }

  if (coa.estado !== 'pendiente_aceptacion') {
    throw AppError.badRequest(
      `Esta invitación ya fue procesada (estado: ${coa.estado})`,
      'COARRENDATARIO_YA_PROCESADA',
    );
  }

  // 2. Crear estudio TransUnion para el co-arrendatario. Reusamos la tabla
  //    `estudios` con tipo='con_coarrendatario' como marca semántica. Los
  //    datos_formulario llevan los datos del COARRENDATARIO (no del titular)
  //    para que TransUnion lo consulte a él.
  const { data: estudioRow, error: estErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: coa.expediente_id,
      tipo: 'con_coarrendatario',
      proveedor: 'transunion',
      estado: 'formulario_completado',
      resultado: 'pendiente',
      datos_formulario: {
        nombre_completo: `${coa.nombre} ${coa.apellido}`.trim(),
        tipo_documento: coa.tipo_documento,
        numero_documento: coa.numero_documento,
        email: coa.email,
        telefono: coa.telefono ?? '',
        acepta_terminos: true,
      },
      autorizacion_habeas_data_id: null,
    } as never)
    .select('id')
    .single();

  if (estErr || !estudioRow) {
    logger.error(
      { error: estErr?.message, coarrendatarioId: coa.id },
      'Error al crear estudio para coarrendatario',
    );
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al iniciar el estudio crediticio');
  }

  const estudioId = (estudioRow as { id: string }).id;

  // 3. Marcar coarrendatario aceptado + audit legal.
  const { error: updErr } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'aceptado',
      aceptado_at: new Date().toISOString(),
      aceptado_ip: ip.slice(0, 45),
      aceptado_user_agent: userAgent?.slice(0, 1000) ?? null,
      estudio_id: estudioId,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', coa.id);

  if (updErr) {
    logger.error({ error: updErr.message, coarrendatarioId: coa.id }, 'Error al marcar coarrendatario aceptado');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al registrar la aceptación');
  }

  // 3.5 Persistir los datos del coarrendatario en expedientes.coarrendatario_*
  //     para que la plantilla del contrato los pueda leer sin necesidad de
  //     joinear con la tabla de invitaciones. Las columnas se renombraron
  //     de codeudor_* a coarrendatario_* en la migración 20260505000005.
  await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .update({
      coarrendatario_nombre: `${coa.nombre} ${coa.apellido}`.trim(),
      coarrendatario_tipo_documento: coa.tipo_documento,
      coarrendatario_documento: coa.numero_documento,
      // Sin parentesco — en el flujo nuevo es "co-arrendatario", no codeudor.
      // Lo dejamos null explícitamente para no arrastrar valores legacy.
      coarrendatario_parentesco: null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', coa.expediente_id);

  // 4. Disparar el estudio TransUnion async — el co-arrendatario no espera.
  //    El hook post-estudio (registrarResultadoInline) detectará tipo='con_coarrendatario'
  //    y disparará la ponderación cuando termine.
  import('@/modules/estudios/estudios.service')
    .then(({ ejecutarEstudio }) => ejecutarEstudio(estudioId, '', ip, undefined))
    .catch((e) =>
      logger.error(
        { error: e, estudioId, coarrendatarioId: coa.id },
        'Error al ejecutar estudio del coarrendatario — admin debe lanzarlo manual',
      ),
    );

  // 5. Notificar al titular.
  const ctx = await fetchExpedienteCtx(coa.expediente_id);
  if (ctx.solicitante_creado_por) {
    notificarUsuario({
      userId: ctx.solicitante_creado_por,
      tipo: 'coarrendatario.acepto',
      titulo: '¡Tu co-arrendatario aceptó!',
      mensaje: `${coa.nombre} aceptó la invitación. Estamos procesando su estudio crediticio — te avisaremos cuando esté listo.`,
      link: `/expedientes/${coa.expediente_id}`,
      payload: { expediente_id: coa.expediente_id, coarrendatario_id: coa.id, estudio_id: estudioId },
    }).catch((e) => logger.warn({ error: e }, 'Error notif coarrendatario acepto'));
  }

  logger.info(
    { coarrendatarioId: coa.id, estudioId, expedienteId: coa.expediente_id },
    'Coarrendatario aceptó — estudio en proceso',
  );

  return {
    ok: true,
    estudio_id: estudioId,
    mensaje:
      'Aceptación registrada. Estamos procesando tu estudio crediticio — te avisaremos por correo cuando termine.',
  };
}

// ============================================================
// 6. Ponderación: cuando termina el estudio del coarrendatario, combinar
//    su resultado con el del titular y decidir el expediente.
//
// Regla del producto (Mario, 5-may-2026): "se ponderan uno con otro. Si el
// otro salió muy bueno, entonces se fueron juntos." Implementación:
//   - Si AL MENOS UNO está 'aprobado' → expediente.estado = 'aprobado'
//   - Si AMBOS 'condicionado' o cualquiera 'rechazado' → 'rechazado'
//   - Solo se rechaza/aprueba aquí — la generación del contrato sigue
//     siendo manual del propietario (decisión Mario, 5-may en otra
//     conversación).
// ============================================================

export async function onCoarrendatarioEstudioCompletado(estudioId: string): Promise<void> {
  // 1. Cargar el estudio del coarrendatario.
  const { data: estudioRow } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, tipo, resultado, score')
    .eq('id', estudioId)
    .maybeSingle();

  if (!estudioRow) {
    logger.warn({ estudioId }, 'onCoarrendatarioEstudioCompletado: estudio no encontrado');
    return;
  }

  const est = estudioRow as unknown as {
    id: string;
    expediente_id: string;
    tipo: string;
    resultado: 'aprobado' | 'rechazado' | 'condicionado' | 'pendiente';
    score: number | null;
  };

  if (est.tipo !== 'con_coarrendatario') return; // No aplica.

  // 2. Cargar el coarrendatario asociado y marcar estudio_completado.
  const { data: coaRow } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, nombre, apellido')
    .eq('estudio_id', estudioId)
    .maybeSingle();

  const coa = coaRow as unknown as {
    id: string;
    expediente_id: string;
    nombre: string;
    apellido: string;
  } | null;

  if (coa) {
    await (supabase
      .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'estudio_completado', updated_at: new Date().toISOString() } as never)
      .eq('id', coa.id);
  }

  // 3. Cargar el estudio del titular (tipo='individual', mismo expediente,
  //    el más reciente que esté completado).
  const { data: titularRows } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, resultado, score')
    .eq('expediente_id', est.expediente_id)
    .eq('tipo', 'individual')
    .eq('estado', 'completado')
    .order('created_at', { ascending: false })
    .limit(1);

  const titular = (titularRows as unknown as Array<{
    id: string;
    resultado: 'aprobado' | 'rechazado' | 'condicionado' | 'pendiente';
    score: number | null;
  }> | null)?.[0];

  if (!titular) {
    logger.warn(
      { estudioId, expedienteId: est.expediente_id },
      'onCoarrendatarioEstudioCompletado: no hay estudio del titular completado para ponderar',
    );
    return;
  }

  // 4. Decidir resultado combinado.
  const resultados = [titular.resultado, est.resultado];
  let resultadoCombinado: 'aprobado' | 'rechazado';
  if (resultados.includes('aprobado')) {
    resultadoCombinado = 'aprobado';
  } else {
    // Ambos condicionados o cualquiera rechazado → rechazo definitivo.
    resultadoCombinado = 'rechazado';
  }

  // 5. Transicionar el expediente. Reusamos la transición directa (no la
  //    RPC con validaciones de comentario obligatorio) porque esto es
  //    automático del sistema, no acción manual del usuario.
  const nowIso = new Date().toISOString();
  const nuevoEstadoExpediente = resultadoCombinado === 'aprobado' ? 'aprobado' : 'rechazado';

  // Si rechazamos, dejamos un motivo legible que el banner del expediente lee
  // para explicar al solicitante y al propietario por qué cerró así. Si
  // aprobamos, no tocamos ese campo.
  const motivoRechazo = resultadoCombinado === 'rechazado'
    ? buildMotivoRechazoCoarrendatario(titular.resultado, est.resultado)
    : null;

  const expedienteUpdate: Record<string, unknown> = {
    estado: nuevoEstadoExpediente,
    updated_at: nowIso,
  };
  if (motivoRechazo) expedienteUpdate.motivo_rechazo = motivoRechazo;

  await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .update(expedienteUpdate as never)
    .eq('id', est.expediente_id)
    .eq('estado', 'condicionado'); // race-safe: solo si sigue condicionado

  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: est.expediente_id,
      tipo: 'estado',
      descripcion: `Resultado combinado del estudio del coarrendatario: ${resultadoCombinado}. Titular ${titular.resultado} + coarrendatario ${est.resultado}.`,
      estado_anterior: 'condicionado',
      estado_nuevo: nuevoEstadoExpediente,
      metadata: {
        automatico: true,
        origen: 'ponderacion_coarrendatario',
        titular_resultado: titular.resultado,
        coarrendatario_resultado: est.resultado,
      },
    } as never);

  // 6. Si se rechazó: liberar el inmueble (mismo patrón que orchestrator).
  if (nuevoEstadoExpediente === 'rechazado') {
    const { data: expRow } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('inmueble_id')
      .eq('id', est.expediente_id)
      .maybeSingle();
    const inmuebleId = (expRow as { inmueble_id?: string } | null)?.inmueble_id;
    if (inmuebleId) {
      await (supabase
        .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'disponible', updated_at: nowIso } as never)
        .eq('id', inmuebleId);
    }
  }

  // 7. Notificar al titular y al propietario.
  const ctx = await fetchExpedienteCtx(est.expediente_id);
  const tituloAprobado = '¡Tu solicitud fue aprobada!';
  const tituloRechazado = 'Tu solicitud no procedió';
  const titulo = nuevoEstadoExpediente === 'aprobado' ? tituloAprobado : tituloRechazado;
  const mensajeAprobado = `Buenas noticias: el estudio combinado tuyo y de tu co-arrendatario fue aprobado. Te avisaremos cuando el contrato esté listo para firmar.`;
  const mensajeRechazado = `Tras evaluar el perfil combinado tuyo y de tu co-arrendatario, no podemos respaldar este arrendamiento. Si tienes dudas, escríbenos.`;
  const mensaje = nuevoEstadoExpediente === 'aprobado' ? mensajeAprobado : mensajeRechazado;

  if (ctx.solicitante_creado_por) {
    notificarUsuario({
      userId: ctx.solicitante_creado_por,
      tipo: nuevoEstadoExpediente === 'aprobado' ? 'estudio.aprobado' : 'estudio.rechazado',
      titulo,
      mensaje,
      link: `/expedientes/${est.expediente_id}`,
      payload: {
        expediente_id: est.expediente_id,
        via: 'coarrendatario_ponderado',
        coarrendatario_id: coa?.id,
      },
    }).catch((e) => logger.warn({ error: e }, 'Error notif ponderacion coarrendatario'));
  }

  if (ctx.inmueble_propietario_id) {
    const titProp =
      nuevoEstadoExpediente === 'aprobado'
        ? 'Solicitante aprobado con co-arrendatario'
        : 'Solicitante no aprobado';
    const msgProp =
      nuevoEstadoExpediente === 'aprobado'
        ? `${ctx.solicitante_nombre || 'El solicitante'} y su co-arrendatario ${coa?.nombre ?? ''} pasaron el estudio combinado. Genera el contrato cuando estés listo.`
        : `${ctx.solicitante_nombre || 'El solicitante'} y su co-arrendatario no pasaron el estudio combinado. El inmueble vuelve a estar disponible.`;
    notificarUsuario({
      userId: ctx.inmueble_propietario_id,
      tipo: nuevoEstadoExpediente === 'aprobado' ? 'estudio.aprobado' : 'estudio.rechazado',
      titulo: titProp,
      mensaje: msgProp,
      link: `/expedientes/${est.expediente_id}`,
      payload: {
        expediente_id: est.expediente_id,
        via: 'coarrendatario_ponderado',
        coarrendatario_id: coa?.id,
      },
    }).catch((e) => logger.warn({ error: e }, 'Error notif ponderacion propietario'));
  }

  logger.info(
    {
      expedienteId: est.expediente_id,
      titularResultado: titular.resultado,
      coarrendatarioResultado: est.resultado,
      nuevoEstadoExpediente,
    },
    'Ponderación coarrendatario completada',
  );
}

// ============================================================
// 5. Rechazar invitación
// ============================================================

export async function rechazarInvitacion(token: string): Promise<{ ok: true }> {
  const { data: coaRow, error } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, nombre, estado')
    .eq('token', token)
    .maybeSingle();

  if (error || !coaRow) {
    throw AppError.notFound('Invitación no encontrada', 'COARRENDATARIO_NOT_FOUND');
  }

  const coa = coaRow as unknown as { id: string; expediente_id: string; nombre: string; estado: Coarrendatario['estado'] };

  if (coa.estado !== 'pendiente_aceptacion') {
    throw AppError.badRequest(
      `Esta invitación ya fue procesada (estado: ${coa.estado})`,
      'COARRENDATARIO_YA_PROCESADA',
    );
  }

  await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'rechazado_invitacion',
      rechazado_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', coa.id);

  // Notificar al titular vía email del solicitante (suficiente — no
  // queremos saturar la campana del titular con un rechazo que ya esperaba).
  const ctx = await fetchExpedienteCtx(coa.expediente_id);
  if (ctx.solicitante_email) {
    findPerfilIdByEmail(ctx.solicitante_email)
      .then((solicitanteUserId) => {
        if (!solicitanteUserId) return;
        return notificarUsuario({
          userId: solicitanteUserId,
          tipo: 'coarrendatario.rechazo',
          titulo: 'Tu invitado declinó',
          mensaje: `${coa.nombre} no aceptó la invitación de co-arrendatario. Puedes invitar a otra persona.`,
          link: `/expedientes/${coa.expediente_id}`,
          payload: { expediente_id: coa.expediente_id, coarrendatario_id: coa.id },
        });
      })
      .catch((e) => logger.warn({ error: e }, 'Error notif coarrendatario rechazo'));
  }

  return { ok: true };
}

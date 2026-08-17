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
import {
  notificarUsuario,
  findPerfilIdByEmail,
  notificarResponsableExpediente,
} from '../notificaciones/notificaciones.service';
import { perfilEsDuenoDeInmueble } from '@/lib/tenantScope';
import { enviarTemplate } from '../whatsapp';
import type {
  InvitarCoarrendatarioInput,
  AceptarCoarrendatarioInput,
  ReenviarCoarrendatarioInput,
} from './coarrendatarios.schema';

const resend = new Resend(env.RESEND_API_KEY);
const FROM = `Cofianza <${env.RESEND_FROM_EMAIL}>`;
const TOKEN_EXPIRY_DAYS = 7;

/** Enlace público de la invitación. Compartido por el correo y el WhatsApp. */
function urlInvitacionCoarrendatario(token: string): string {
  return `${env.FRONTEND_URL}/coarrendatario/${token}`;
}

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
  inmueble_inmobiliaria_id: string | null;
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
        'inmuebles(propietario_id, inmobiliaria_id, direccion, ciudad)',
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
    inmuebles: { propietario_id: string; inmobiliaria_id: string | null; direccion: string; ciudad: string } | null;
  };

  return {
    id: row.id,
    numero: row.numero,
    estado: row.estado,
    solicitante_creado_por: row.solicitantes?.creado_por ?? null,
    inmueble_propietario_id: row.inmuebles?.propietario_id ?? null,
    inmueble_inmobiliaria_id: row.inmuebles?.inmobiliaria_id ?? null,
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
 * Acceso al coarrendatario de un expediente: admin/operador siempre; el
 * solicitante dueño del expediente; propietario/inmobiliaria dueños del
 * inmueble. Compartido por invitar / get / reenviar.
 */
async function tieneAccesoExpediente(
  ctx: ExpedienteCtx,
  userId: string,
  userRol: string,
): Promise<boolean> {
  if (userRol === 'administrador' || userRol === 'operador_analista') return true;
  if (userRol === 'solicitante') return ctx.solicitante_creado_por === userId;
  if (userRol === 'propietario' || userRol === 'inmobiliaria') {
    return perfilEsDuenoDeInmueble({
      userId,
      userRol,
      inmueblePropietarioId: ctx.inmueble_propietario_id,
      inmuebleInmobiliariaId: ctx.inmueble_inmobiliaria_id,
    });
  }
  return false;
}

/** Correo de invitación al co-arrendatario (usado al invitar y al reenviar). */
function enviarEmailInvitacionCoarrendatario(opts: {
  to: string;
  nombre: string;
  titularNombre: string;
  inmuebleStr: string;
  token: string;
  expedienteId: string;
}): void {
  const link = urlInvitacionCoarrendatario(opts.token);
  resend.emails
    .send({
      from: FROM,
      to: opts.to,
      subject: `${opts.titularNombre} te invita a ser su co-arrendatario en Cofianza`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px;">Invitación a co-arrendar</h1>
          </div>
          <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
            <p style="color: #374151; font-size: 16px;">Hola <strong>${opts.nombre}</strong>,</p>
            <p style="color: #6b7280;"><strong>${opts.titularNombre}</strong> te invita a ser su co-arrendatario para el inmueble en <strong>${opts.inmuebleStr}</strong>.</p>
            <p style="color: #6b7280;">En Cofianza renta sin fiador. Si aceptas la invitación, evaluaremos tu perfil junto con el de ${opts.titularNombre} y respaldamos a los dos como un solo arrendatario.</p>
            <div style="text-align: center; margin: 24px 0;">
              <a href="${link}" style="display: inline-block; background: #0d9488; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Revisar invitación</a>
            </div>
            <p style="color: #9ca3af; font-size: 12px;">Si no esperabas esta invitación, puedes ignorar este correo. El enlace expira en ${TOKEN_EXPIRY_DAYS} días.</p>
          </div>
        </div>
      `,
    })
    .catch((e) =>
      logger.warn(
        { error: e, expedienteId: opts.expedienteId, email: opts.to },
        'Error enviando email invitacion coarrendatario',
      ),
    );
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

  if (!(await tieneAccesoExpediente(ctx, userId, userRol))) {
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

  // 5. Invitación por los DOS canales: correo y WhatsApp.
  //    El invitado no tiene cuenta en Cofianza, así que el enlace con token es
  //    su único acceso — y un correo de una marca que no conoce se pierde en
  //    spam con facilidad. El WhatsApp es fire-and-forget: si no hay teléfono o
  //    el envío falla, la invitación por correo ya quedó hecha y el flujo sigue.
  enviarEmailInvitacionCoarrendatario({
    to: input.email,
    nombre: input.nombre,
    titularNombre: ctx.solicitante_nombre || 'el solicitante',
    inmuebleStr: `${ctx.inmueble_direccion}${ctx.inmueble_ciudad ? `, ${ctx.inmueble_ciudad}` : ''}`,
    token,
    expedienteId,
  });

  enviarTemplate({
    to: input.telefono,
    template: 'COARRENDATARIO_INVITACION',
    variables: [
      input.nombre,
      ctx.solicitante_nombre || 'El solicitante',
      urlInvitacionCoarrendatario(token),
    ],
    context: { expediente_id: expedienteId },
  });

  // 6. Notificar al titular para que vea que la invitación se envió.
  if (ctx.solicitante_creado_por) {
    notificarUsuario({
      userId: ctx.solicitante_creado_por,
      tipo: 'coarrendatario.invitado',
      titulo: 'Invitación enviada',
      mensaje: `Enviamos a ${input.nombre} la invitación como co-arrendatario. Te avisaremos cuando responda.`,
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

  if (!(await tieneAccesoExpediente(ctx, userId, userRol))) {
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
// 2b. Reenviar la invitación (corrigiendo email/teléfono si venían mal)
// ============================================================
//
// Sin esto, una invitación con el email mal escrito era un callejón sin
// salida: el enlace nunca llegaba, el unique index bloqueaba re-invitar y
// solo el invitado (que nunca recibió el correo) podía declinar.

export async function reenviarInvitacionCoarrendatario(
  expedienteId: string,
  userId: string,
  userRol: string,
  input: ReenviarCoarrendatarioInput,
): Promise<Coarrendatario> {
  const ctx = await fetchExpedienteCtx(expedienteId);

  if (!(await tieneAccesoExpediente(ctx, userId, userRol))) {
    throw AppError.forbidden(
      'No tienes permisos para reenviar esta invitación',
      'COARRENDATARIO_FORBIDDEN',
    );
  }

  // La invitación debe existir y seguir pendiente de aceptación.
  const { data: coaRow } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('expediente_id', expedienteId)
    .neq('estado', 'rechazado_invitacion')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const coa = (coaRow as unknown as Coarrendatario) ?? null;

  if (!coa || coa.estado !== 'pendiente_aceptacion') {
    throw AppError.badRequest(
      'Solo se puede reenviar una invitación pendiente de aceptación',
      'COARRENDATARIO_NO_PENDIENTE',
    );
  }

  // Mismo guard que al invitar: el coarrendatario no puede ser el titular.
  const nuevoEmail = input.email?.trim().toLowerCase();
  if (nuevoEmail && ctx.solicitante_email && nuevoEmail === ctx.solicitante_email.toLowerCase()) {
    throw AppError.badRequest(
      'El co-arrendatario no puede ser la misma persona que el solicitante',
      'COARRENDATARIO_MISMO_EMAIL',
    );
  }

  // UPDATE in-place (no insert: el unique index parcial sigue intacto).
  // Regenerar el token invalida el enlace anterior — si el correo viejo era
  // de otra persona, esa persona ya no puede aceptar.
  const token = generateToken();
  const { data: updRow, error: updError } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .update({
      ...(nuevoEmail ? { email: nuevoEmail } : {}),
      ...(input.telefono ? { telefono: input.telefono } : {}),
      token,
      token_expiracion: tokenExpiracion(),
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', coa.id)
    .eq('estado', 'pendiente_aceptacion')
    .select('*')
    .single();

  if (updError || !updRow) {
    logger.error(
      { error: updError?.message, expedienteId, coarrendatarioId: coa.id },
      'Error al reenviar invitación de coarrendatario',
    );
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al reenviar la invitación');
  }

  const actualizado = updRow as unknown as Coarrendatario;

  // Reenvío por los dos canales, igual que la invitación original. El token se
  // regeneró arriba, así que el enlace viejo (correo o WhatsApp) queda muerto y
  // ambos mensajes deben llevar el nuevo.
  enviarEmailInvitacionCoarrendatario({
    to: actualizado.email,
    nombre: actualizado.nombre,
    titularNombre: ctx.solicitante_nombre || 'el solicitante',
    inmuebleStr: `${ctx.inmueble_direccion}${ctx.inmueble_ciudad ? `, ${ctx.inmueble_ciudad}` : ''}`,
    token,
    expedienteId,
  });

  enviarTemplate({
    to: actualizado.telefono,
    template: 'COARRENDATARIO_INVITACION',
    variables: [
      actualizado.nombre,
      ctx.solicitante_nombre || 'El solicitante',
      urlInvitacionCoarrendatario(token),
    ],
    context: { expediente_id: expedienteId },
  });

  logger.info(
    { expedienteId, coarrendatarioId: actualizado.id, email: actualizado.email },
    'Invitación de coarrendatario reenviada',
  );

  return actualizado;
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

  // 2. CLAIM atómico: marcar aceptado SOLO si sigue 'pendiente_aceptacion'.
  //    Evita que dos POST /aceptar concurrentes (doble click / retry de red)
  //    pasen ambos el check en memoria y creen DOS estudios TransUnion (coste
  //    real) para el mismo co-arrendatario. El estudio se crea DESPUÉS del
  //    claim, así que el perdedor de la carrera aborta sin crear nada.
  const aceptadoAt = new Date().toISOString();
  const { data: claimRows, error: claimErr } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'aceptado',
      aceptado_at: aceptadoAt,
      aceptado_ip: ip.slice(0, 45),
      aceptado_user_agent: userAgent?.slice(0, 1000) ?? null,
      updated_at: aceptadoAt,
    } as never)
    .eq('id', coa.id)
    .eq('estado', 'pendiente_aceptacion')
    .select('id');

  if (claimErr) {
    logger.error({ error: claimErr.message, coarrendatarioId: coa.id }, 'Error al marcar coarrendatario aceptado');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al registrar la aceptación');
  }
  if (!claimRows || (claimRows as unknown[]).length === 0) {
    // Otra request ya ganó la carrera y procesó la invitación.
    throw AppError.badRequest('Esta invitación ya fue procesada', 'COARRENDATARIO_YA_PROCESADA');
  }

  // 3. Crear el estudio del co-arrendatario. Reusamos la tabla `estudios` con
  //    tipo='con_coarrendatario' como marca semántica. Los datos_formulario
  //    llevan los datos del COARRENDATARIO (no del titular) para que el buró
  //    lo consulte a él.
  //
  //    El buró se HEREDA del estudio del titular: si el gestor eligió
  //    DataCrédito para el expediente, consultar al coarrendatario en otro
  //    buró daría resultados no comparables (y otra factura distinta).
  //    Fallback a TransUnion si aún no hay estudio del titular.
  const { data: estudioTitularRow } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('proveedor')
    .eq('expediente_id', coa.expediente_id)
    .eq('tipo', 'individual')
    .in('proveedor', ['transunion', 'datacredito'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const proveedorHeredado =
    (estudioTitularRow as { proveedor?: string } | null)?.proveedor ?? 'transunion';

  const { data: estudioRow, error: estErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: coa.expediente_id,
      tipo: 'con_coarrendatario',
      proveedor: proveedorHeredado,
      estado: 'formulario_completado',
      resultado: 'pendiente',
      datos_formulario: {
        nombre_completo: `${coa.nombre} ${coa.apellido}`.trim(),
        // El apellido se guarda TAMBIEN por separado: la invitación lo captura
        // en su propio campo, y DataCrédito lo contrasta contra Registraduría.
        // Sin esto el provider tendría que derivarlo del nombre completo, que
        // falla con apellidos compuestos o dos nombres (código 10).
        apellido: coa.apellido,
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

  // 4. Vincular el estudio recién creado a la invitación ya reclamada.
  await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .update({ estudio_id: estudioId, updated_at: new Date().toISOString() } as never)
    .eq('id', coa.id);

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
      titulo: 'Co-arrendatario confirmado',
      mensaje: `${coa.nombre} aceptó la invitación. Estamos procesando su estudio crediticio; te avisaremos cuando esté listo.`,
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
    .select('id, expediente_id, nombre, apellido, email')
    .eq('estudio_id', estudioId)
    .maybeSingle();

  const coa = coaRow as unknown as {
    id: string;
    expediente_id: string;
    nombre: string;
    apellido: string;
    email: string;
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

  const { data: expUpdated } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .update(expedienteUpdate as never)
    .eq('id', est.expediente_id)
    .eq('estado', 'condicionado') // race-safe: solo si sigue condicionado
    .select('id');

  // Si otra ruta ya movió el expediente fuera de 'condicionado' (cierre/
  // cancelación o una ponderación concurrente), el UPDATE afecta 0 filas. No
  // seguimos: evitamos un evento de timeline, una liberación de inmueble y unas
  // notificaciones inconsistentes con el estado real.
  if (!expUpdated || (expUpdated as unknown[]).length === 0) {
    logger.info(
      { expedienteId: est.expediente_id, estudioId },
      'Ponderación coarrendatario: el expediente ya no estaba condicionado — se omiten los efectos',
    );
    return;
  }

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
  //    SOLO el bloqueo temporal (en_estudio → disponible): un UPDATE
  //    incondicional podía pisar un 'ocupado' legítimo si este resultado
  //    llegaba con otro contrato ya vigente sobre el inmueble.
  if (nuevoEstadoExpediente === 'rechazado') {
    const { data: expRow } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('inmueble_id')
      .eq('id', est.expediente_id)
      .maybeSingle();
    const inmuebleId = (expRow as { inmueble_id?: string } | null)?.inmueble_id;
    if (inmuebleId) {
      const { liberarInmuebleEnEstudio } = await import('@/modules/inmuebles/inmuebles.service');
      await liberarInmuebleEnEstudio(inmuebleId);
    }
  }

  // 7. Notificar al titular y al propietario.
  const ctx = await fetchExpedienteCtx(est.expediente_id);
  const tituloAprobado = 'Solicitud aprobada';
  const tituloRechazado = 'Solicitud no aprobada';
  const titulo = nuevoEstadoExpediente === 'aprobado' ? tituloAprobado : tituloRechazado;
  const mensajeAprobado = `El estudio combinado tuyo y de tu co-arrendatario fue aprobado. Te avisaremos cuando el contrato esté listo para firmar.`;
  const mensajeRechazado = `El estudio combinado tuyo y de tu co-arrendatario no fue aprobado. Si tienes dudas, escríbenos.`;
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
        ? 'Aprobado con co-arrendatario'
        : 'Solicitante no aprobado';
    const msgProp =
      nuevoEstadoExpediente === 'aprobado'
        ? `${ctx.solicitante_nombre || 'El solicitante'} y su co-arrendatario ${coa?.nombre ?? ''} aprobaron el estudio combinado. Genera el contrato para continuar.`
        : `${ctx.solicitante_nombre || 'El solicitante'} y su co-arrendatario no aprobaron el estudio combinado. El inmueble vuelve a estar disponible.`;
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

    // Espejo para el miembro responsable del expediente (no-op si no hay
    // responsable o si el responsable es el mismo dueño). Solo in-app — este
    // punto no manda WhatsApp _DUENO.
    notificarResponsableExpediente({
      expedienteId: est.expediente_id,
      excluirPerfilId: ctx.inmueble_propietario_id,
      tipo: nuevoEstadoExpediente === 'aprobado' ? 'estudio.aprobado' : 'estudio.rechazado',
      titulo: titProp,
      mensaje: msgProp,
      link: `/expedientes/${est.expediente_id}`,
      payload: {
        expediente_id: est.expediente_id,
        via: 'coarrendatario_ponderado',
        coarrendatario_id: coa?.id,
      },
    }).catch((e) => logger.warn({ error: e }, 'Error notif ponderacion responsable'));
  }

  // Email al coarrendatario con el resultado de SU estudio + qué pasó con la
  // ponderación. El coa no tiene cuenta en Cofianza, así que la notificación
  // en-app no aplica — solo email a la dirección que registró al aceptar.
  if (coa?.email) {
    sendCoarrendatarioResultadoEmail({
      email: coa.email,
      nombre: coa.nombre,
      coarrendatarioResultado: est.resultado,
      coarrendatarioScore: est.score,
      titularNombre: ctx.solicitante_nombre,
      inmuebleDireccion: ctx.inmueble_direccion,
      inmuebleCiudad: ctx.inmueble_ciudad,
      decisionExpediente: nuevoEstadoExpediente,
    }).catch((e) =>
      logger.warn({ error: e, coarrendatarioId: coa.id }, 'Error email resultado coarrendatario'),
    );
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
// Email — resultado del estudio del coarrendatario
// ============================================================

interface SendResultadoEmailInput {
  email: string;
  nombre: string;
  coarrendatarioResultado: 'aprobado' | 'rechazado' | 'condicionado' | 'pendiente';
  coarrendatarioScore: number | null;
  titularNombre: string | null;
  inmuebleDireccion: string;
  inmuebleCiudad: string;
  decisionExpediente: 'aprobado' | 'rechazado';
}

async function sendCoarrendatarioResultadoEmail(input: SendResultadoEmailInput): Promise<void> {
  const inmuebleStr = `${input.inmuebleDireccion}${input.inmuebleCiudad ? `, ${input.inmuebleCiudad}` : ''}`;
  const titular = input.titularNombre || 'el titular';

  // El subject y el cuerpo dependen de la decisión final del expediente.
  // No le mostramos el detalle de la ponderación al coa (es info entre el
  // titular y Cofianza); le contamos qué pasó con su parte y cuál es la
  // resolución final.
  let subject: string;
  let cuerpoPrincipal: string;
  let badgeColor = '#0d9488'; // teal Cofianza por defecto

  if (input.decisionExpediente === 'aprobado') {
    subject = `Tu estudio se aprobó — arrendamiento con ${titular} (Cofianza)`;
    cuerpoPrincipal = `
      <p style="color: #374151; font-size: 16px;">¡Buenas noticias, <strong>${input.nombre}</strong>!</p>
      <p style="color: #6b7280;">Tu estudio crediticio quedó <strong style="color: #047857;">aprobado</strong> y junto con ${titular}
      pasaron la evaluación combinada para el inmueble en <strong>${inmuebleStr}</strong>.</p>
      <p style="color: #6b7280;">El siguiente paso lo coordinamos con ${titular} (firma del contrato y entrega del inmueble).
      No tienes que hacer nada más por ahora — si necesitamos un dato adicional, te escribimos a este mismo correo.</p>
    `;
    badgeColor = '#047857'; // green
  } else {
    // Rechazo definitivo del expediente. Distinguimos la causa para que el
    // coa entienda si fue su parte o la del titular.
    subject = `Resultado de tu estudio — ${titular} (Cofianza)`;
    if (input.coarrendatarioResultado === 'aprobado') {
      cuerpoPrincipal = `
        <p style="color: #374151; font-size: 16px;">Hola <strong>${input.nombre}</strong>,</p>
        <p style="color: #6b7280;">Tu estudio crediticio quedó <strong style="color: #047857;">aprobado</strong>. Sin embargo,
        la evaluación combinada con ${titular} no permite que respaldemos este arrendamiento en este momento.</p>
        <p style="color: #6b7280;">El proceso queda cerrado. Si en el futuro hay otra oportunidad con Cofianza, con gusto te
        evaluamos de nuevo.</p>
      `;
      badgeColor = '#b45309'; // amber
    } else if (input.coarrendatarioResultado === 'rechazado') {
      cuerpoPrincipal = `
        <p style="color: #374151; font-size: 16px;">Hola <strong>${input.nombre}</strong>,</p>
        <p style="color: #6b7280;">Tu estudio crediticio quedó <strong style="color: #b91c1c;">no aprobado</strong>.
        Por esta razón no podemos respaldar el arrendamiento del inmueble en <strong>${inmuebleStr}</strong>.</p>
        <p style="color: #6b7280;">Si tienes dudas sobre tu reporte, puedes consultarlo directamente con la central de riesgo.</p>
      `;
      badgeColor = '#b91c1c'; // red
    } else {
      // condicionado o cualquier otro estado: rechazo combinado.
      cuerpoPrincipal = `
        <p style="color: #374151; font-size: 16px;">Hola <strong>${input.nombre}</strong>,</p>
        <p style="color: #6b7280;">Tu estudio crediticio quedó <strong style="color: #b45309;">condicionado</strong>.
        Combinado con el de ${titular}, no alcanza el perfil que necesitamos para respaldar el arrendamiento del
        inmueble en <strong>${inmuebleStr}</strong>.</p>
        <p style="color: #6b7280;">El proceso queda cerrado.</p>
      `;
      badgeColor = '#b45309'; // amber
    }
  }

  const scoreLine = typeof input.coarrendatarioScore === 'number' && input.coarrendatarioScore > 0
    ? `<p style="color: #6b7280; font-size: 13px; margin: 4px 0;">Score crediticio: <strong>${input.coarrendatarioScore}</strong></p>`
    : '';

  await resend.emails.send({
    from: FROM,
    to: input.email,
    subject,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: ${badgeColor}; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 22px;">Resultado de tu estudio</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          ${cuerpoPrincipal}
          ${scoreLine}
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            Recibiste este correo porque ${titular} te invitó a ser su co-arrendatario en Cofianza y aceptaste el estudio crediticio.
            Cofianza no almacena tu reporte de centrales de riesgo — solo usamos el resultado para esta evaluación puntual.
          </p>
        </div>
      </div>
    `,
  });

  logger.info(
    { email: input.email, decisionExpediente: input.decisionExpediente, coaResultado: input.coarrendatarioResultado },
    'Email de resultado enviado al coarrendatario',
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
          titulo: 'Invitación declinada',
          mensaje: `${coa.nombre} no aceptó la invitación de co-arrendatario. Puedes invitar a otra persona.`,
          link: `/expedientes/${coa.expediente_id}`,
          payload: { expediente_id: coa.expediente_id, coarrendatario_id: coa.id },
        });
      })
      .catch((e) => logger.warn({ error: e }, 'Error notif coarrendatario rechazo'));
  }

  return { ok: true };
}

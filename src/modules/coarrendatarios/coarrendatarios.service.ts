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
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import { getCalibracion } from '@/lib/calibracion';
import { Resend } from 'resend';
import {
  notificarUsuario,
  notificarYCorreo,
  findPerfilIdByEmail,
  notificarResponsableExpediente,
} from '../notificaciones/notificaciones.service';
import { assertExpedienteAccess } from '@/lib/tenantScope';
import { escapeHtml } from '@/lib/escapeHtml';
import { getCompany } from '@/lib/companyConfig';
import { apelacionHtml } from '@/modules/orchestrator/orchestrator.emails';
// Tope de canon (flujo del modulo de estudios §4.4). El estudio del
// co-arrendatario es una consulta al buro mas, y esa consulta no puede
// depender del fire-and-forget del final: ver los dos call sites de abajo.
import { assertCanonDentroDelTope } from '@/modules/estudios/tope-canon.guard';
import { estudioYaCobrado, ESTADO_ESPERANDO_PAGO } from '@/modules/estudios/pago.guard';
// Flujo §10/§11: el CRC se produce con el resultado — tambien cuando el
// resultado lo pone la ponderacion con coarrendatario.
import { emitirCertificadoAutomatico } from '@/modules/estudios/certificado.service';
// Reglas duras V4.1 (§4.2 DTI, §4.3 canon/ingreso). El co-arrendatario SI es
// evaluable por las dos: la Politica §5 lo evalua "sobre ingresos propios", asi
// que su canon/ingreso individual dispara §4.3 con frecuencia.
import {
  motivoProspectoReglasDuras,
  inferirReglasDurasDesdeMotivo,
  etiquetaReglaDura,
} from '@/modules/estudios/reglas-duras';
import type { ReglaDuraActiva } from '@/modules/estudios/reglas-duras';
import {
  TEXTO_LEGAL_COARRENDATARIO,
  VERSION_TERMINOS_COARRENDATARIO,
} from '../autorizaciones/autorizaciones.texto';
import { enviarTemplate } from '../whatsapp';
import { ponderarConCoarrendatario } from './ponderacion';
import { evaluacionCuenta, contratoFijoSinCoarrendatario } from '@/modules/estudios/coarrendatario-vinculado';
import type {
  InvitarCoarrendatarioInput,
  AceptarCoarrendatarioInput,
  ReenviarCoarrendatarioInput,
} from './coarrendatarios.schema';

const resend = new Resend(env.RESEND_API_KEY);
const FROM = `Cofianza <${env.RESEND_FROM_EMAIL}>`;
const TOKEN_EXPIRY_DAYS = 7;
/**
 * Tope de invitaciones por estudio (todas, también canceladas o declinadas):
 * cada una manda correo y WhatsApp de Cofianza a quien se escriba.
 */
const MAX_INVITACIONES_POR_ESTUDIO = 5;

/** Correo al titular cuando la ponderación rechaza el conjunto (Flujo §10, sin cifras). */
const MOTIVO_TITULAR_RECHAZO_CONJUNTO =
  'No aprobable por ahora. La evaluación conjunta con tu co-arrendatario no cumplió los requisitos que exige nuestra política para respaldar este contrato. ' +
  'No es una decisión definitiva sobre ti: puedes volver a solicitarlo más adelante o escribirnos para revisar tu caso.';

// Columnas que SÍ pueden llegar al cliente (las de `Coarrendatario`). Nunca
// '*': el token de la invitación en la respuesta dejaba al titular o al gestor
// aceptar la autorización de habeas data en nombre del invitado. Tampoco
// salen aceptado_ip, aceptado_user_agent ni invitado_por. token_expiracion sí:
// con ella la tarjeta dice que la invitación venció.
const COLUMNAS_COA_PUBLICAS =
  'id, expediente_id, nombre, apellido, tipo_documento, numero_documento, email, telefono, estado, estudio_id, token_expiracion, aceptado_at, rechazado_at, created_at, updated_at';

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
  token_expiracion: string;
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
  /** Perfil del gestor que creo el expediente: firma la emision automatica del CRC. */
  creado_por: string | null;
  solicitante_creado_por: string | null;
  inmueble_propietario_id: string | null;
  inmueble_inmobiliaria_id: string | null;
  inmueble_direccion: string;
  inmueble_ciudad: string;
  solicitante_email: string | null;
  solicitante_nombre: string | null;
  /** Documento del titular: Politica §5, el coarrendatario no puede ser el mismo afianzado. */
  solicitante_numero_documento: string | null;
}

// ============================================================
// Helpers privados
// ============================================================

async function fetchExpedienteCtx(expedienteId: string): Promise<ExpedienteCtx> {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, numero, estado, creado_por, ' +
        'solicitantes(creado_por, email, nombre, apellido, numero_documento), ' +
        'inmuebles!expedientes_inmueble_id_fkey(propietario_id, inmobiliaria_id, direccion, ciudad)',
    )
    .eq('id', expedienteId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Estudio no encontrado');
  }

  const row = data as unknown as {
    id: string;
    numero: string;
    estado: string;
    creado_por: string | null;
    solicitantes: {
      creado_por: string | null;
      email: string;
      nombre: string;
      apellido: string;
      numero_documento: string | null;
    } | null;
    inmuebles: { propietario_id: string; inmobiliaria_id: string | null; direccion: string; ciudad: string } | null;
  };

  return {
    id: row.id,
    numero: row.numero,
    estado: row.estado,
    creado_por: row.creado_por ?? null,
    solicitante_creado_por: row.solicitantes?.creado_por ?? null,
    inmueble_propietario_id: row.inmuebles?.propietario_id ?? null,
    inmueble_inmobiliaria_id: row.inmuebles?.inmobiliaria_id ?? null,
    inmueble_direccion: row.inmuebles?.direccion ?? '',
    inmueble_ciudad: row.inmuebles?.ciudad ?? '',
    solicitante_email: row.solicitantes?.email ?? null,
    solicitante_nombre: row.solicitantes
      ? `${row.solicitantes.nombre} ${row.solicitantes.apellido}`.trim()
      : null,
    solicitante_numero_documento: row.solicitantes?.numero_documento ?? null,
  };
}

/**
 * Documento comparable: sin puntos, espacios ni guiones, en mayusculas, para
 * que "1.234.567" y "1234567" sean la misma persona (Politica §5, NOTA).
 */
function normalizarDocumento(numero: string | null | undefined): string {
  return (numero ?? '').replace(/[.\s-]/g, '').trim().toUpperCase();
}

/**
 * Politica V4.1 §5, NOTA: "El coarrendatario no puede ser el mismo afianzado
 * bajo otro nombre". El correo se cambia en un minuto; el documento no: se
 * compara normalizado. Lo usan invitar y reenviar (que desde P4 corrige el
 * documento).
 */
function assertNoEsElTitular(ctx: ExpedienteCtx, datos: { email?: string; numero_documento?: string }): void {
  if (datos.email && ctx.solicitante_email && datos.email.trim().toLowerCase() === ctx.solicitante_email.toLowerCase()) {
    throw AppError.badRequest(
      'El co-arrendatario no puede ser la misma persona que el solicitante',
      'COARRENDATARIO_MISMO_EMAIL',
    );
  }
  const docTitular = normalizarDocumento(ctx.solicitante_numero_documento);
  if (datos.numero_documento && docTitular && normalizarDocumento(datos.numero_documento) === docTitular) {
    throw AppError.badRequest(
      'El co-arrendatario no puede ser la misma persona que el solicitante: el número de documento coincide con el del titular del estudio.',
      'COARRENDATARIO_MISMO_DOCUMENTO',
    );
  }
}

const TIPO_DOC_CORTO: Record<string, string> = { cc: 'CC', ce: 'CE', ti: 'TI', pasaporte: 'Pasaporte', nit: 'NIT' };

/** P4: el invitado reconoce su documento sin verlo completo («CC ••••5678»). */
function documentoEnmascarado(tipo: string, numero: string): string {
  return `${TIPO_DOC_CORTO[tipo] ?? tipo.toUpperCase()} ••••${normalizarDocumento(numero).slice(-4)}`;
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function tokenExpiracion(): string {
  return new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * P3 (2026-09-24): fuera de 'condicionado' la invitación pendiente queda sin
 * efecto. Sin esto se aceptaba y se consultaba el buró de un tercero sobre un
 * estudio ya decidido (cobro y datos sin finalidad, Ley 1581).
 */
function assertInvitacionVigente(estadoExpediente: string): void {
  if (estadoExpediente !== 'condicionado') {
    throw AppError.badRequest(
      'Esta invitación ya no está vigente: el estudio ya se resolvió.',
      'COARRENDATARIO_INVITACION_NO_VIGENTE',
    );
  }
}

/**
 * Acceso al coarrendatario de un expediente: admin/operador siempre; el
 * solicitante dueño del expediente; propietario/inmobiliaria con el estudio en
 * su cartera (assertExpedienteAccess: un miembro restringido solo ve lo suyo).
 * Compartido por invitar / get / reenviar.
 */
async function tieneAccesoExpediente(
  ctx: ExpedienteCtx,
  userId: string,
  userRol: string,
): Promise<boolean> {
  if (userRol === 'administrador' || userRol === 'operador_analista') return true;
  if (userRol === 'solicitante') return ctx.solicitante_creado_por === userId;
  if (userRol === 'propietario' || userRol === 'inmobiliaria') {
    return assertExpedienteAccess(ctx.id, userId, userRol).then(
      () => true,
      () => false,
    );
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
  // Texto de personas escapado en el cuerpo; el asunto va en texto plano.
  const nombre = escapeHtml(opts.nombre);
  const titular = escapeHtml(opts.titularNombre);
  const inmueble = escapeHtml(opts.inmuebleStr);
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
            <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
            <p style="color: #6b7280;"><strong>${titular}</strong> te invita a ser su co-arrendatario para el inmueble en <strong>${inmueble}</strong>.</p>
            <p style="color: #6b7280;">En Cofianza renta sin fiador. Si aceptas la invitación, evaluaremos tu perfil junto con el de ${titular} y respaldamos a los dos como un solo arrendatario.</p>
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
/**
 * ¿El buró llegó a evaluar a esta persona?
 *
 * Un 'condicionado' SIN score no es un perfil marginal: es un perfil que el
 * buró no pudo calificar por falta de información (código 14 de DataCrédito,
 * exclusiones -4..-7 de CreditVision). 'pendiente' tampoco es concluyente —
 * el resultado nunca bajó. En ambos casos la ponderación no debe auto-decidir.
 */
function fueEvaluadoPorElBuro(estudio: {
  resultado: 'aprobado' | 'rechazado' | 'condicionado' | 'pendiente';
  score: number | null;
}): boolean {
  if (estudio.resultado === 'aprobado' || estudio.resultado === 'rechazado') return true;
  if (estudio.resultado === 'condicionado') return estudio.score !== null;
  return false; // 'pendiente'
}

function buildMotivoRechazoCoarrendatario(
  titularResultado: string,
  coarrendatarioResultado: string,
  reglasDurasCoarrendatario: readonly ReglaDuraActiva[] = [],
): string {
  if (reglasDurasCoarrendatario.length > 0) {
    // Politica §5: la regla dura del coarrendatario contamina el conjunto,
    // gane lo que gane el titular. Este banner es gestor-only.
    return (
      `La evaluación del co-arrendatario activó una regla dura de la Política V4.1 ` +
      `(${reglasDurasCoarrendatario.map(etiquetaReglaDura).join(', ')}). ` +
      'La regla dura del co-arrendatario contamina el conjunto (Política §5): la solicitud no procede.'
    );
  }
  if (titularResultado === 'condicionado' && coarrendatarioResultado === 'condicionado') {
    // Solo se llega aquí con AMBOS scores presentes: el caso sin información
    // se desvía antes a decisión manual (ver fueEvaluadoPorElBuro).
    return 'Las evaluaciones del titular y del co-arrendatario quedaron en perfil marginal en el buró. La solicitud no procede.';
  }
  if (coarrendatarioResultado === 'rechazado') {
    return 'La evaluación crediticia del co-arrendatario invitado fue rechazada. La solicitud no procede.';
  }
  if (titularResultado === 'rechazado') {
    return 'La evaluación crediticia del titular fue rechazada. La solicitud no procede.';
  }
  return 'La ponderación de las evaluaciones crediticias del titular y el co-arrendatario no permite respaldar este arrendamiento.';
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
      'No tienes permisos para invitar a un co-arrendatario en este estudio',
      'COARRENDATARIO_FORBIDDEN',
    );
  }

  return crearInvitacion(ctx, input, userId);
}

/** Errores que, desde un enlace público, confirmarían datos del titular o de otra invitación. */
const CODIGOS_NO_REVELAR = ['COARRENDATARIO_MISMO_DOCUMENTO', 'COARRENDATARIO_MISMO_EMAIL', 'COARRENDATARIO_DUPLICADO'];

/**
 * P18 (2026-09-24, Flujo §2 y §8.3-8.4): el prospecto invita él mismo a su
 * co-arrendatario desde su enlace personal (el de soportes), sin cuenta. El
 * token es la credencial; los guards son los mismos de invitarCoarrendatario.
 * Al prospecto le vuelve lo mismo que muestra su página: nombre y estado.
 */
export async function invitarCoarrendatarioPorToken(
  token: string,
  input: InvitarCoarrendatarioInput,
): Promise<{ nombre: string; estado: Coarrendatario['estado'] }> {
  const { resolveExpedientePorTokenDocumentos } = await import('@/modules/expedientes/expediente-soportes.service');
  const { expedienteId } = await resolveExpedientePorTokenDocumentos(token);
  try {
    const coa = await crearInvitacion(await fetchExpedienteCtx(expedienteId), input, null);
    return { nombre: coa.nombre, estado: coa.estado };
  } catch (e) {
    // El enlace pudo reenviarse a un tercero: no se confirma a tanteo el
    // documento o el correo del titular, ni que ya hay otra invitación.
    if (e instanceof AppError && CODIGOS_NO_REVELAR.includes(e.errorCode)) {
      throw AppError.badRequest(
        'No pudimos enviar la invitación con esos datos. Revisa que sean los de la persona con quien vas a vivir.',
        'COARRENDATARIO_NO_INVITABLE',
      );
    }
    throw e;
  }
}


/** La invitación y sus guards. `invitadoPor` null = la envió el prospecto desde su enlace (P18). */
async function crearInvitacion(
  ctx: ExpedienteCtx,
  input: InvitarCoarrendatarioInput,
  invitadoPor: string | null,
): Promise<Coarrendatario> {
  const expedienteId = ctx.id;

  // 2. Estado del expediente debe ser 'condicionado' — única ventana donde
  //    tiene sentido invitar. En otros estados o ya está aprobado o el
  //    estudio aún no se ejecutó.
  if (ctx.estado !== 'condicionado') {
    throw AppError.badRequest(
      `Solo se puede invitar co-arrendatario cuando el estudio está condicionado. Estado actual: ${ctx.estado}.`,
      'EXPEDIENTE_NO_CONDICIONADO',
    );
  }

  // 2b. TOPE DE CANON — flujo §4.4. Se valida al EMITIR la invitación, que es
  //     el único momento en que el gestor todavía puede actuar. Si el inmueble
  //     está fuera de tope, el estudio del co-arrendatario no va a poder correr
  //     nunca (el expediente tampoco se puede aprobar), y sin este chequeo la
  //     invitación salía igual: la persona entregaba nombre, documento y su
  //     autorización de habeas data para una consulta imposible. Es el mismo
  //     argumento de finalidad (Ley 1581) con el que el guard justifica ir
  //     antes del gate 8.4.
  //     P36 (2026-09-24): si el estudio ya se cobró, un tope que bajó después
  //     solo advierte: el estudio pagado se termina (Flujo §4.4, Adenda 1
  //     contratos §2.4); el contrato aplica el tope vigente.
  await assertCanonDentroDelTope({
    expedienteId,
    origen: 'invitarCoarrendatario',
    soloAdvertir: await estudioYaCobrado(expedienteId),
  });

  // 3. Tope anti-abuso. Cancelar o declinar libera el cupo del índice único,
  //    no este. Va antes de mirar al titular: desde el enlace público, el orden
  //    de los errores no debe revelar si el documento o el correo son los suyos.
  const { count, error: countError } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .select('id', { count: 'exact', head: true })
    .eq('expediente_id', expedienteId);
  if (countError) throw fromSupabaseError(countError);
  if ((count ?? 0) >= MAX_INVITACIONES_POR_ESTUDIO) {
    throw AppError.conflict(
      `Este estudio ya tuvo ${MAX_INVITACIONES_POR_ESTUDIO} invitaciones de co-arrendatario. Escríbenos a ${(await getCompany()).email} si necesitas invitar a alguien más.`,
      'COARRENDATARIO_TOPE_INVITACIONES',
    );
  }

  // 3b. Ni el correo ni el documento del titular (Politica §5, NOTA).
  assertNoEsElTitular(ctx, input);

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
      invitado_por: invitadoPor,
    } as never)
    .select(COLUMNAS_COA_PUBLICAS)
    .single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      // P4: antes de aceptar se cancela y se invita a otra; después, uno por estudio.
      throw AppError.conflict(
        'Ya hay un co-arrendatario invitado para este estudio. Si su invitación sigue pendiente, cancélala para invitar a otra persona; si ya la aceptó, no se puede reemplazar: se admite uno por estudio.',
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
      String(TOKEN_EXPIRY_DAYS),
    ],
    // El enlace va en el boton URL, no en el cuerpo: el sufijo dinamico es el
    // token (mismo patron que las plantillas de cita).
    urlButtons: [token],
    context: { expediente_id: expedienteId },
  });

  // 6. Aviso a quien creó la ficha del solicitante (casi siempre el gestor).
  //    Si invitó el prospecto desde su enlace (P18), también al responsable.
  const porElProspecto = invitadoPor === null;
  const aviso = {
    tipo: 'coarrendatario.invitado',
    titulo: porElProspecto ? 'El solicitante invitó a su co-arrendatario' : 'Invitación enviada',
    mensaje: porElProspecto
      ? `${ctx.solicitante_nombre || 'El solicitante'} invitó a ${input.nombre} como co-arrendatario desde su enlace.`
      : `Enviamos a ${input.nombre} la invitación como co-arrendatario. Te avisaremos cuando responda.`,
    link: `/expedientes/${expedienteId}`,
    payload: { expediente_id: expedienteId, coarrendatario_id: coa.id },
  };
  if (ctx.solicitante_creado_por) {
    notificarUsuario({ userId: ctx.solicitante_creado_por, ...aviso }).catch((e) =>
      logger.warn({ error: e }, 'Error notif coarrendatario invitado'),
    );
  }
  if (porElProspecto) {
    notificarResponsableExpediente({ expedienteId, excluirPerfilId: ctx.solicitante_creado_por, ...aviso }).catch((e) =>
      logger.warn({ error: e }, 'Error notif responsable coarrendatario invitado'),
    );
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
    throw AppError.forbidden('No tienes permisos para ver este estudio', 'EXPEDIENTE_FORBIDDEN');
  }

  const { data } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .select(COLUMNAS_COA_PUBLICAS)
    .eq('expediente_id', expedienteId)
    .neq('estado', 'rechazado_invitacion')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const coa = (data as unknown as Coarrendatario) ?? null;
  if (!coa) return null;

  // Embebemos el estudio asociado (si ya existe) para que el card del
  // propietario muestre resultado/score sin un round-trip adicional. Al
  // titular no: resultado, score y observaciones (datos del buro) son de otra
  // persona (Ley 1266), y su tarjeta solo usa `estado`.
  if (coa.estudio_id && userRol !== 'solicitante') {
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
  assertInvitacionVigente(ctx.estado);

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
  assertNoEsElTitular(ctx, { email: nuevoEmail, numero_documento: input.numero_documento });

  // UPDATE in-place (no insert: el unique index parcial sigue intacto).
  // Regenerar el token invalida el enlace anterior — si el correo viejo era
  // de otra persona, esa persona ya no puede aceptar.
  const token = generateToken();
  const { data: updRow, error: updError } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .update({
      ...(nuevoEmail ? { email: nuevoEmail } : {}),
      ...(input.telefono ? { telefono: input.telefono } : {}),
      // P4: corregir a la persona antes de que acepte (nombre o documento mal escritos).
      ...(input.nombre ? { nombre: input.nombre } : {}),
      ...(input.apellido ? { apellido: input.apellido } : {}),
      ...(input.tipo_documento ? { tipo_documento: input.tipo_documento } : {}),
      ...(input.numero_documento ? { numero_documento: input.numero_documento } : {}),
      token,
      token_expiracion: tokenExpiracion(),
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', coa.id)
    .eq('estado', 'pendiente_aceptacion')
    .select(COLUMNAS_COA_PUBLICAS)
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
      String(TOKEN_EXPIRY_DAYS),
    ],
    urlButtons: [token],
    context: { expediente_id: expedienteId },
  });

  logger.info(
    { expedienteId, coarrendatarioId: actualizado.id, email: actualizado.email },
    'Invitación de coarrendatario reenviada',
  );

  return actualizado;
}

// ============================================================
// 2c. Cancelar la invitación antes de que la acepte (P4)
// ============================================================
//
// Flujo §12 (decisión 2026-09-24): antes de aceptar se puede cancelar,
// corregir y reenviar o invitar a otra persona, sin costo. Después de
// consultado el buró ya no: un co-arrendatario por estudio.

export async function cancelarInvitacionCoarrendatario(
  expedienteId: string,
  userId: string,
  userRol: string,
): Promise<{ ok: true }> {
  const ctx = await fetchExpedienteCtx(expedienteId);

  if (!(await tieneAccesoExpediente(ctx, userId, userRol))) {
    throw AppError.forbidden('No tienes permisos para cancelar esta invitación', 'COARRENDATARIO_FORBIDDEN');
  }

  // Solo la pendiente. Rotar el token deja muerto el enlace que ya recibió, y
  // el estado libera el cupo del índice único para invitar a otra persona.
  const ahora = new Date().toISOString();
  const { data, error } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'rechazado_invitacion', rechazado_at: ahora, token: generateToken(), updated_at: ahora } as never)
    .eq('expediente_id', expedienteId)
    .eq('estado', 'pendiente_aceptacion')
    .select('id, nombre');

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al cancelar la invitación de coarrendatario');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al cancelar la invitación');
  }
  const cancelada = (data as Array<{ id: string; nombre: string }> | null)?.[0];
  if (!cancelada) {
    throw AppError.badRequest(
      'Solo se puede cancelar una invitación que todavía no se ha aceptado. Después de la evaluación no se puede reemplazar al co-arrendatario: se admite uno por estudio.',
      'COARRENDATARIO_NO_PENDIENTE',
    );
  }

  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'estudio',
      descripcion: `Se canceló la invitación a ${cancelada.nombre} como co-arrendatario antes de que la aceptara.`,
      usuario_id: userId,
      metadata: { origen: 'coarrendatario_cancelado', coarrendatario_id: cancelada.id },
    } as never)
    .then(() => undefined, () => undefined);

  logger.info({ expedienteId, coarrendatarioId: cancelada.id }, 'Invitación de coarrendatario cancelada');
  return { ok: true };
}

// ============================================================
// 3. Vista pública — el invitado abre /coarrendatario/[token]
// ============================================================

export interface CoarrendatarioPublicView {
  nombre: string;
  apellido: string;
  /** Enmascarado («CC ••••5678»): si no es el suyo, puede declinar (P4). */
  documento: string;
  email: string;
  estado: Coarrendatario['estado'];
  expediente: {
    numero: string;
    inmueble_direccion: string;
    inmueble_ciudad: string;
    titular_nombre: string;
  };
  expira_en: string;
  /**
   * Texto integro de la autorizacion que el invitado va a aceptar, con su
   * version. Flujo 8.4: "el texto de la autorizacion debe estar visible en la
   * pantalla, no oculto tras un enlace". Es exactamente el mismo texto que se
   * congela en autorizaciones_habeas_data.texto_autorizado al aceptar.
   */
  texto_legal: string;
  version_terminos: string;
}

export async function getPublicByToken(token: string): Promise<CoarrendatarioPublicView> {
  const { data: coaRow, error } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, nombre, apellido, tipo_documento, numero_documento, email, estado, token_expiracion')
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
    tipo_documento: string;
    numero_documento: string;
    email: string;
    estado: Coarrendatario['estado'];
    token_expiracion: string;
  };

  // Solo vence la invitación SIN responder: reabrirla ya aceptada o declinada
  // (el enlace vive en el correo) muestra en qué quedó, no "ya expiró".
  if (coa.estado === 'pendiente_aceptacion' && new Date(coa.token_expiracion) < new Date()) {
    throw AppError.badRequest('Esta invitación ya expiró', 'TOKEN_EXPIRED');
  }

  // Cargar contexto del expediente para mostrar al invitado de qué se trata.
  const ctx = await fetchExpedienteCtx(coa.expediente_id);
  // P3: una invitación pendiente de un estudio ya resuelto no se muestra para aceptar.
  if (coa.estado === 'pendiente_aceptacion') assertInvitacionVigente(ctx.estado);

  return {
    nombre: coa.nombre,
    apellido: coa.apellido,
    documento: documentoEnmascarado(coa.tipo_documento, coa.numero_documento),
    email: coa.email,
    estado: coa.estado,
    expediente: {
      numero: ctx.numero,
      inmueble_direccion: ctx.inmueble_direccion,
      inmueble_ciudad: ctx.inmueble_ciudad,
      titular_nombre: ctx.solicitante_nombre || 'El solicitante',
    },
    expira_en: coa.token_expiracion,
    texto_legal: TEXTO_LEGAL_COARRENDATARIO,
    version_terminos: VERSION_TERMINOS_COARRENDATARIO,
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

/**
 * Devuelve la invitación a 'pendiente_aceptacion' cuando la aceptación falla
 * después del claim. Sin esto la invitación queda consumida sin estudio y no
 * hay salida: el invitado reintenta y ve COARRENDATARIO_YA_PROCESADA, el
 * gestor no puede reenviar (exige 'pendiente_aceptacion') ni invitar a otro
 * (índice único por expediente).
 */
async function revertirClaim(coaId: string): Promise<void> {
  const { error } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'pendiente_aceptacion',
      aceptado_at: null,
      aceptado_ip: null,
      aceptado_user_agent: null,
      // Los escribió el claim fallido (§8.7.2): no quedan a medias.
      direccion: null,
      municipio: null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', coaId)
    .eq('estado', 'aceptado');
  if (error) {
    logger.error(
      { error: error.message, coarrendatarioId: coaId },
      'No se pudo revertir la aceptación del co-arrendatario — la invitación queda consumida (requiere intervención manual)',
    );
  }
}

export async function aceptarInvitacion(
  token: string,
  ip: string,
  userAgent: string,
  input: AceptarCoarrendatarioInput,
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

  const coa = coaRow as unknown as Coarrendatario & {
    token_expiracion: string;
    invitado_por: string | null;
  };

  if (new Date(coa.token_expiracion) < new Date()) {
    throw AppError.badRequest('Esta invitación ya expiró', 'TOKEN_EXPIRED');
  }

  if (coa.estado !== 'pendiente_aceptacion') {
    throw AppError.badRequest(
      'Esta invitación ya fue procesada',
      'COARRENDATARIO_YA_PROCESADA',
      // El estado va en `details`, no en el mensaje: el mensaje se pinta tal
      // cual en la pantalla pública del invitado y uno de los valores del enum
      // es 'rechazado_invitacion' — la palabra que el §13 del flujo prohíbe
      // mostrarle al prospecto, además del enum interno a la vista.
      { estado: coa.estado },
    );
  }

  // P3: antes del tope, del claim y de la consulta al buró.
  const ctx = await fetchExpedienteCtx(coa.expediente_id);
  assertInvitacionVigente(ctx.estado);

  // 1b. TOPE DE CANON — flujo §4.4. Va ANTES del claim y ANTES del INSERT del
  //     estudio. Sin esto, el único control era el ejecutarEstudio
  //     fire-and-forget del final, cuyo rechazo se lo traga el .catch: la API
  //     respondía 200, el co-arrendatario veía éxito, el titular recibía
  //     "estamos procesando su estudio" y quedaba una fila de estudio en
  //     'formulario_completado' que nunca iba a correr — y que además, por no
  //     ser un estado finalizado, bloqueaba para siempre cualquier estudio
  //     futuro del expediente (ESTUDIO_ACTIVO_EXISTENTE).
  //
  //     Cubre las invitaciones emitidas antes de que existiera el guard de
  //     invitarCoarrendatario. Aquí sí lanza (el invitado ve el mensaje del
  //     tope, que no es un portazo y no habla de rechazo, §13), en vez de
  //     dejar el expediente en un estado del que no se sale.
  //
  //     Desde el §6.3 hay un segundo caso con la misma forma: el titular pudo
  //     autorizar y todavía no haber pagado. Ese NO se resuelve lanzando (el
  //     invitado no tiene nada que ver con el cobro del titular): el estudio se
  //     crea EN ESPERA DE PAGO y arranca solo cuando el pago entre. Ver el
  //     bloque 4.
  //
  //     P36: con el estudio ya cobrado, el tope que bajó después solo advierte.
  await assertCanonDentroDelTope({
    expedienteId: coa.expediente_id,
    origen: 'aceptarInvitacionCoarrendatario',
    soloAdvertir: await estudioYaCobrado(coa.expediente_id),
  });

  // 2. CLAIM atómico: marcar aceptado SOLO si sigue 'pendiente_aceptacion'.
  //    Evita que dos POST /aceptar concurrentes (doble click / retry de red)
  //    pasen ambos el check en memoria y creen DOS estudios TransUnion (coste
  //    real) para el mismo co-arrendatario. El estudio se crea DESPUÉS del
  //    claim, así que el perdedor de la carrera aborta sin crear nada.
  //    También exige el MISMO token: si el gestor la reenvió corrigiendo el
  //    documento entre la lectura y el claim, este enlace ya no vale (P4).
  const aceptadoAt = new Date().toISOString();
  const { data: claimRows, error: claimErr } = await (supabase
    .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'aceptado',
      aceptado_at: aceptadoAt,
      aceptado_ip: ip.slice(0, 45),
      aceptado_user_agent: userAgent?.slice(0, 1000) ?? null,
      // §8.7.2 (Contratos V3): el paso 5 del asistente los precarga.
      ...(input.direccion ? { direccion: input.direccion } : {}),
      ...(input.municipio ? { municipio: input.municipio } : {}),
      updated_at: aceptadoAt,
    } as never)
    .eq('id', coa.id)
    .eq('estado', 'pendiente_aceptacion')
    .eq('token', token)
    .select('id');

  if (claimErr) {
    logger.error({ error: claimErr.message, coarrendatarioId: coa.id }, 'Error al marcar coarrendatario aceptado');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al registrar la aceptación');
  }
  if (!claimRows || (claimRows as unknown[]).length === 0) {
    // Otra request ya ganó la carrera y procesó la invitación.
    throw AppError.badRequest('Esta invitación ya fue procesada', 'COARRENDATARIO_YA_PROCESADA');
  }

  // P3: el estudio pudo resolverse entre la lectura y el claim. Se devuelve la
  // invitación y no se consulta el buró.
  let estadoTrasClaim: string;
  try {
    estadoTrasClaim = (await fetchExpedienteCtx(coa.expediente_id)).estado;
  } catch (e) {
    await revertirClaim(coa.id);
    throw e;
  }
  if (estadoTrasClaim !== 'condicionado') {
    await revertirClaim(coa.id);
    assertInvitacionVigente(estadoTrasClaim);
  }

  // 2b. Autorización habeas data PROPIA del co-arrendatario.
  //
  //     El flujo 8.4 exige autorización previa, expresa e informada de la
  //     persona que se va a consultar, y demostrable: fecha/hora, IP,
  //     dispositivo, texto íntegro con su versión y documento de quien aceptó.
  //     El invitado es otro titular de datos: la firma del titular del
  //     expediente NO lo cubre. Hasta 2026-09-03 aquí solo se guardaban
  //     aceptado_ip / aceptado_user_agent en expediente_coarrendatarios y el
  //     buró se consultaba 40 líneas más abajo sin ninguna evidencia.
  //
  //     canal='web': el invitado acepta el texto en la propia pantalla, no a
  //     través de un enlace de autorización firmado con OTP.
  //     El documento se congela NORMALIZADO (sin espacios en los extremos):
  //     es lo que la columna admite y lo que el gate compara, y un documento
  //     con espacios haría fallar el INSERT dejando la invitación consumida.
  const documentoAceptante = (coa.numero_documento ?? '').trim() || null;

  const hashAutorizacion = crypto
    .createHash('sha256')
    .update(
      [
        TEXTO_LEGAL_COARRENDATARIO,
        'invitacion_coarrendatario',
        coa.numero_documento,
        ip,
        userAgent ?? '',
        aceptadoAt,
      ].join('|'),
    )
    .digest('hex');

  const vigenteHasta = new Date(aceptadoAt);
  vigenteHasta.setMonth(vigenteHasta.getMonth() + env.AUTORIZACION_VIGENCIA_MESES);

  const { data: autorizacionRow, error: autErr } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .insert({
      solicitante_id: null,
      coarrendatario_id: coa.id,
      expediente_id: coa.expediente_id,
      canal: 'web',
      estado: 'autorizado',
      generado_por: coa.invitado_por ?? null,
      texto_autorizado: TEXTO_LEGAL_COARRENDATARIO,
      version_terminos: VERSION_TERMINOS_COARRENDATARIO,
      autorizado_en: aceptadoAt,
      ip_autorizacion: ip.slice(0, 45),
      user_agent: userAgent?.slice(0, 1000) ?? null,
      numero_documento_aceptante: documentoAceptante,
      tipo_documento_aceptante: coa.tipo_documento,
      hash_documento: hashAutorizacion,
      vigencia_meses: env.AUTORIZACION_VIGENCIA_MESES,
      vigente_hasta: vigenteHasta.toISOString(),
    } as never)
    .select('id')
    .single();

  if (autErr || !autorizacionRow) {
    logger.error(
      { error: autErr?.message, coarrendatarioId: coa.id },
      'No se pudo registrar la autorización habeas data del co-arrendatario',
    );
    await revertirClaim(coa.id);
    throw new AppError(
      500,
      'AUTORIZACION_CREATE_ERROR',
      'No se pudo registrar tu autorización de tratamiento de datos. Intenta de nuevo.',
    );
  }

  const autorizacionId = (autorizacionRow as { id: string }).id;

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

  // El co-arrendatario NUNCA tiene pago propio (uq_pagos_estudio_activo solo
  // admite un pago de estudio por expediente): se ampara en el del titular.
  const titularYaPago = await estudioYaCobrado(coa.expediente_id);

  const { data: estudioRow, error: estErr } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: coa.expediente_id,
      tipo: 'con_coarrendatario',
      proveedor: proveedorHeredado,
      // §6.3: si el titular todavía no pagó, el estudio del co-arrendatario
      // nace EN ESPERA DE PAGO y NO se dispara (ver el bloque 4). Sin esto, el
      // gate de pago lo rechazaría dentro del fire-and-forget de abajo, el
      // .catch se comería el error, el invitado vería un 200 y quedaría un
      // estudio muerto en 'formulario_completado' bloqueando cualquier estudio
      // futuro del expediente (ESTUDIO_ACTIVO_EXISTENTE) — exactamente el
      // fallo que el comentario 1b dice haber arreglado ya una vez.
      estado: titularYaPago ? 'formulario_completado' : ESTADO_ESPERANDO_PAGO,
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
      // Evidencia 8.4: el estudio queda atado a la autorizacion del propio
      // co-arrendatario (antes se escribia null explicito).
      autorizacion_habeas_data_id: autorizacionId,
    } as never)
    .select('id')
    .single();

  if (estErr || !estudioRow) {
    logger.error(
      { error: estErr?.message, coarrendatarioId: coa.id },
      'Error al crear estudio para coarrendatario',
    );
    // La autorización se queda: es evidencia (la persona sí aceptó) y el
    // reintento crea otra fila sin chocar con nada.
    await revertirClaim(coa.id);
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al iniciar la evaluación crediticia');
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
  //    §6.3: solo si el titular ya pagó. Si no, el estudio queda aparcado y lo
  //    despierta onEstudioPagado junto con el del titular (su CAS es multi-fila
  //    justamente por esto). Se deja rastro VISIBLE en el timeline: el .catch de
  //    abajo solo loguea, y un bloqueo invisible aquí es el modo de fallo que ya
  //    costó caro una vez.
  if (!titularYaPago) {
    await (supabase
      .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
      .insert({
        expediente_id: coa.expediente_id,
        tipo: 'estudio',
        descripcion:
          'El co-arrendatario aceptó la invitación. Su evaluación queda EN ESPERA del pago del titular y se ejecutará sola al confirmarse.',
        metadata: { automatico: true, estudio_id: estudioId, coarrendatario_id: coa.id },
      } as never)
      .then(() => undefined, () => undefined);
  } else {
    import('@/modules/estudios/estudios.service')
      .then(({ ejecutarEstudio }) => ejecutarEstudio(estudioId, '', ip, undefined))
      .catch((e) =>
        logger.error(
          { error: e, estudioId, coarrendatarioId: coa.id },
          'Error al ejecutar estudio del coarrendatario — admin debe lanzarlo manual',
        ),
      );
  }

  // 5. Notificar al titular.
  if (ctx.solicitante_creado_por) {
    notificarUsuario({
      userId: ctx.solicitante_creado_por,
      tipo: 'coarrendatario.acepto',
      titulo: 'Co-arrendatario confirmado',
      mensaje: `${coa.nombre} aceptó la invitación. Estamos procesando su evaluación crediticia; te avisaremos cuando esté listo.`,
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
      'Aceptación registrada. Estamos procesando tu evaluación crediticia — te avisaremos por correo cuando termine.',
  };
}

// ============================================================
// 6. Ponderación: cuando termina el estudio del coarrendatario, combinar
//    su resultado con el del titular y decidir el expediente.
//
// La regla vive en ponderacion.ts (Adenda 2 §2 y §5; reemplaza la regla verbal
// de mayo "si uno aprueba, se van juntos"). Solo se rechaza/aprueba aquí — la
// generación del contrato sigue siendo manual del propietario.
// ============================================================

/**
 * Adenda 1 §3 sobre el par titular/coarrendatario, leyendo los puntajes del
 * scorecard de cada estudio. Devuelve null si falta cualquiera de los dos
 * puntajes (y entonces manda la ponderacion por resultado del buro).
 */
async function ponderarConScorecard(
  titularEstudioId: string,
  coaEstudioId: string,
  coaConReglaDura: boolean,
): Promise<{ resultado: 'aprobado' | 'sin_evaluar'; puntajeTitular: number; puntajeCoa: number; umbral: number } | null> {
  const [cal, filas] = await Promise.all([
    getCalibracion(),
    (supabase.from('estudios_scorecard_sombra' as string) as ReturnType<typeof supabase.from>)
      .select('estudio_id, puntaje_normalizado, fecha_calculo')
      .in('estudio_id', [titularEstudioId, coaEstudioId])
      .order('fecha_calculo', { ascending: false }),
  ]);
  const puntaje = (id: string): number | null => {
    const row = ((filas.data ?? []) as Array<{ estudio_id: string; puntaje_normalizado: number | string | null }>).find((r) => r.estudio_id === id);
    const n = row?.puntaje_normalizado == null ? null : Number(row.puntaje_normalizado);
    return n !== null && Number.isFinite(n) ? n : null;
  };
  const pT = puntaje(titularEstudioId);
  const pC = puntaje(coaEstudioId);
  if (pT === null || pC === null) return null;

  const enZonaGris = pT >= cal.UMBRAL_ZONA_GRIS && pT < cal.UMBRAL_APROBACION_AUTOMATICA;
  const coaAprueba = !coaConReglaDura && pC >= cal.UMBRAL_COARRENDATARIO;
  return {
    resultado: enZonaGris && coaAprueba ? 'aprobado' : 'sin_evaluar',
    puntajeTitular: pT,
    puntajeCoa: pC,
    umbral: cal.UMBRAL_COARRENDATARIO,
  };
}

export async function onCoarrendatarioEstudioCompletado(
  estudioId: string,
  opts?: {
    /**
     * Reglas duras que forzaron el rechazo de ESTE estudio, tal como las
     * devolvio el punto de decision. Llega en memoria desde
     * dispararHookPostResultado; si no llega se infieren del motivo persistido.
     * Sin esto el correo al co-arrendatario le atribuiria al buro un rechazo
     * que puede convivir con un score altisimo.
     */
    reglasDuras?: readonly ReglaDuraActiva[];
  },
): Promise<void> {
  // 1. Cargar el estudio del coarrendatario.
  const { data: estudioRow } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, tipo, estado, resultado, score, motivo_rechazo')
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
    estado: string;
    resultado: 'aprobado' | 'rechazado' | 'condicionado' | 'pendiente';
    score: number | null;
    motivo_rechazo: string | null;
  };

  // Regla dura del co-arrendatario: preferimos el veredicto en memoria y solo
  // caemos al marcador del motivo persistido si no vino (llamador antiguo).
  const reglasDurasCoa: ReglaDuraActiva[] =
    opts?.reglasDuras && opts.reglasDuras.length > 0
      ? [...opts.reglasDuras]
      : inferirReglasDurasDesdeMotivo(est.motivo_rechazo);

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

  // 4. Decidir el expediente (ver ponderacion.ts). Adenda 2 §2 y §5: un
  //    titular condicionado esta en revision manual y lo decide un analista
  //    de Cofianza — ya no se aprueba solo porque el coarrendatario salio
  //    aprobado (regla verbal de mayo). Solo se decide sin analista por la
  //    regla dura del coarrendatario (Politica §5) o, con el motor, por la
  //    aprobacion automatica condicionada (70-84 + coarrendatario >= 80).
  const coaConReglaDura = reglasDurasCoa.length > 0;
  if (coaConReglaDura) {
    logger.info(
      { expedienteId: est.expediente_id, estudioId, reglasDuras: reglasDurasCoa, titularResultado: titular.resultado },
      'Politica §5: regla dura del coarrendatario — rechazo automatico del conjunto',
    );
  }
  let scorecard: 'aprobado' | 'sin_evaluar' | null = null;
  if (!coaConReglaDura && env.MOTOR_DECIDE_ENABLED && titular.resultado === 'condicionado') {
    const ponderado = await ponderarConScorecard(titular.id, est.id, false);
    if (ponderado) {
      logger.info({ expedienteId: est.expediente_id, ...ponderado }, 'Adenda §3: ponderacion titular/coarrendatario con el scorecard');
      scorecard = ponderado.resultado;
    }
  }
  const resultadoCombinado = ponderarConCoarrendatario({ titular: titular.resultado, coaConReglaDura, scorecard });

  // 4.5. Revision manual: el expediente SE QUEDA en 'condicionado' y lo decide
  //      un analista de Cofianza con los dos resultados. Se registra en el
  //      timeline y se avisa (dueño, responsable, titular y analistas), pero
  //      no se toca el estado ni se libera el inmueble.
  if (resultadoCombinado === 'revision_manual') {
    // P3: si el estudio ya se decidió mientras se evaluaba al co-arrendatario,
    // no hay revisión que avisar (ni timeline ni «sigue en revisión»).
    const ctxSin = await fetchExpedienteCtx(est.expediente_id);
    if (ctxSin.estado !== 'condicionado') {
      decisionYaTomada(ctxSin, titular.id, est, coa, reglasDurasCoa);
      return;
    }

    // Ninguno de los dos pudo ser evaluado por el buro (sin historial): se
    // explica distinto que "el coarrendatario ya tiene resultado".
    const sinInfo = !fueEvaluadoPorElBuro(titular) || !fueEvaluadoPorElBuro(est);
    logger.info(
      {
        expedienteId: est.expediente_id,
        estudioId,
        titularResultado: titular.resultado,
        titularScore: titular.score,
        coaResultado: est.resultado,
        coaScore: est.score,
      },
      'Ponderación coarrendatario: queda en revisión manual para un analista de Cofianza (Adenda 2 §5)',
    );

    await (supabase
      .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
      .insert({
        expediente_id: est.expediente_id,
        tipo: 'estudio',
        descripcion: sinInfo
          ? 'La evaluación del co-arrendatario se completó, pero el buró no tiene información crediticia suficiente para ponderar. El estudio sigue en revisión manual de Cofianza.'
          : `La evaluación del co-arrendatario se completó (resultado: ${est.resultado}). El estudio sigue en revisión manual: lo decide un analista de Cofianza con los dos resultados (Adenda 2 §5).`,
        metadata: {
          automatico: true,
          origen: 'ponderacion_coarrendatario',
          resultado: 'revision_manual',
          titular_resultado: titular.resultado,
          titular_score: titular.score,
          coarrendatario_resultado: est.resultado,
          coarrendatario_score: est.score,
        },
      } as never);

    const msgGestor = sinInfo
      ? `El co-arrendatario ${coa?.nombre ?? ''} completó su evaluación, pero ni él ni ${ctxSin.solicitante_nombre || 'el solicitante'} ` +
        'tienen historial crediticio suficiente para que el buró los evalúe. No es un rechazo: un analista de Cofianza revisa el caso con los documentos de soporte.'
      : `El co-arrendatario ${coa?.nombre ?? ''} completó su evaluación (${est.resultado}). Un analista de Cofianza decide el caso con los dos resultados.`;
    const tituloGestor = sinInfo ? 'En revisión de Cofianza: sin historial crediticio' : 'Co-arrendatario evaluado: decide Cofianza';
    const via = sinInfo ? 'coarrendatario_sin_evaluar' : 'coarrendatario_revision_manual';

    // El analista tiene informacion nueva para decidir (SLA de 2 h habiles).
    void (async () => {
      const { listOperators } = await import('@/modules/users/users.service');
      const analistas = await listOperators().catch(() => []);
      await Promise.all(
        analistas.map((a) =>
          notificarUsuario({
            userId: a.id,
            tipo: 'estudio.revision_manual',
            titulo: `Co-arrendatario evaluado — ${ctxSin.numero}`,
            mensaje: `El co-arrendatario completó su evaluación (${est.resultado}). El caso sigue en revisión manual y lo decide un analista de Cofianza.`,
            link: `/expedientes/${est.expediente_id}`,
            payload: { expediente_id: est.expediente_id, via, coarrendatario_id: coa?.id },
          }),
        ),
      );
    })().catch((e) => logger.warn({ error: e }, 'Error notif analistas ponderacion coarrendatario'));

    if (ctxSin.inmueble_propietario_id) {
      notificarUsuario({
        userId: ctxSin.inmueble_propietario_id,
        tipo: 'estudio.condicionado',
        titulo: tituloGestor,
        mensaje: msgGestor,
        link: `/expedientes/${est.expediente_id}`,
        payload: {
          expediente_id: est.expediente_id,
          via,
          coarrendatario_id: coa?.id,
        },
      }).catch((e) => logger.warn({ error: e }, 'Error notif ponderacion revision manual (propietario)'));

      notificarResponsableExpediente({
        expedienteId: est.expediente_id,
        excluirPerfilId: ctxSin.inmueble_propietario_id,
        tipo: 'estudio.condicionado',
        titulo: tituloGestor,
        mensaje: msgGestor,
        link: `/expedientes/${est.expediente_id}`,
        payload: {
          expediente_id: est.expediente_id,
          via,
          coarrendatario_id: coa?.id,
        },
      }).catch((e) => logger.warn({ error: e }, 'Error notif responsable ponderacion revision manual'));
    }

    // El coarrendatario tambien hizo su parte: se le avisa que el caso quedo
    // en manos de un analista (Adenda 2 §5) y volvera a saber de nosotros.
    void avisarCoarrendatarioDecision(est.expediente_id, 'en_revision');

    // Al titular se le avisa con honestidad: hizo la gestión de invitar y
    // quedarse sin respuesta sería peor que un mensaje que no promete nada.
    // Por su correo, no por creado_por (que casi siempre es el gestor).
    void findPerfilIdByEmail(ctxSin.solicitante_email).then((titularId) => {
      if (!titularId) return;
      return notificarUsuario({
        userId: titularId,
        tipo: 'estudio.condicionado',
        titulo: 'Tu co-arrendatario completó su evaluación',
        mensaje: sinInfo
          ? 'Ninguno de los dos tiene historial crediticio en las centrales, así que el buró no pudo evaluarlos. No es un rechazo: un analista de Cofianza revisará tu caso con los documentos de soporte.'
          : 'Un analista de Cofianza revisará tu caso con los resultados de los dos. Te avisamos cuando decida.',
        link: `/expedientes/${est.expediente_id}`,
        payload: {
          expediente_id: est.expediente_id,
          via,
          coarrendatario_id: coa?.id,
        },
      });
    }).catch((e) => logger.warn({ error: e }, 'Error notif ponderacion sin evaluar (titular)'));

    return;
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
    ? buildMotivoRechazoCoarrendatario(titular.resultado, est.resultado, reglasDurasCoa)
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
      'Ponderación coarrendatario: el estudio ya no estaba condicionado — se omiten los efectos',
    );
    decisionYaTomada(await fetchExpedienteCtx(est.expediente_id), titular.id, est, coa, reglasDurasCoa);
    return;
  }

  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: est.expediente_id,
      tipo: 'estado',
      descripcion:
        `Resultado combinado con la evaluación del co-arrendatario: ${resultadoCombinado}. Titular ${titular.resultado} + coarrendatario ${est.resultado}.` +
        (reglasDurasCoa.length > 0
          ? ` Regla dura del co-arrendatario (${reglasDurasCoa.map(etiquetaReglaDura).join(', ')}): contamina el conjunto (Política §5).`
          : ''),
      estado_anterior: 'condicionado',
      estado_nuevo: nuevoEstadoExpediente,
      metadata: {
        automatico: true,
        origen: 'ponderacion_coarrendatario',
        titular_resultado: titular.resultado,
        coarrendatario_resultado: est.resultado,
        coarrendatario_reglas_duras: reglasDurasCoa,
      },
    } as never);

  // 6. Si se rechazó: soltar la RESERVA del inmueble (mismo patrón que
  //    orchestrator). Flujo §4.2: solo se suelta si ESTE expediente era el
  //    titular. Sustituye al viejo "en_estudio → disponible", que con estudios
  //    simultáneos habría liberado una propiedad que otros candidatos siguen
  //    disputando, o peor, una reservada por otro expediente.
  if (nuevoEstadoExpediente === 'rechazado') {
    const { liberarReservaDeExpediente } = await import('@/modules/inmuebles/inmuebles.service');
    await liberarReservaDeExpediente(est.expediente_id);
  }

  // 7. Notificar al titular y al propietario.
  const ctx = await fetchExpedienteCtx(est.expediente_id);

  // 7b. Flujo §10/§11: el CRC se produce con el resultado. El del titular ya
  //     pudo salir al quedar condicionado; aquí se REGENERA (version+1) porque
  //     las condiciones económicas cambiaron con el acompañante (prima 10%,
  //     Adenda §5.2; vía condicionada, §5.1). Fire-and-forget: el helper
  //     nunca lanza y deja rastro en el timeline. Firma quien creó el expediente.
  if (nuevoEstadoExpediente === 'aprobado') {
    emitirCertificadoAutomatico(titular.id, ctx.creado_por, { regenerar: true }).catch((e) =>
      logger.warn({ error: e, expedienteId: est.expediente_id, estudioId: titular.id }, 'Ponderación: no se pudo emitir el CRC automático'),
    );
  }
  // Al prospecto, por correo (con el derecho de apelación §11 si no se aprobó)
  // y en la app si tiene cuenta. Antes iba solo a quien creó la ficha, casi
  // siempre el gestor. El motivo es del conjunto: nunca las reglas duras del
  // co-arrendatario, que son datos del buró de otra persona.
  void import('@/modules/expedientes/expediente-habilitacion.service')
    .then((m) =>
      m.avisarSolicitanteDecision(
        est.expediente_id,
        nuevoEstadoExpediente,
        nuevoEstadoExpediente === 'rechazado' ? MOTIVO_TITULAR_RECHAZO_CONJUNTO : undefined,
      ),
    )
    .catch((e) => logger.warn({ error: e }, 'Error aviso al prospecto de la ponderacion'));

  if (ctx.inmueble_propietario_id) {
    // P2: con la evaluación rechazada el co-arrendatario no entra al contrato.
    const coaCuenta = evaluacionCuenta(est);
    const titProp =
      nuevoEstadoExpediente !== 'aprobado'
        ? 'Solicitante no aprobado'
        : coaCuenta
          ? 'Aprobado con co-arrendatario'
          : 'Solicitante aprobado';
    const msgProp =
      nuevoEstadoExpediente !== 'aprobado'
        ? `${ctx.solicitante_nombre || 'El solicitante'} y su co-arrendatario no aprobaron la evaluación combinada. El inmueble vuelve a estar disponible.`
        : coaCuenta
          ? `${ctx.solicitante_nombre || 'El solicitante'} y su co-arrendatario ${coa?.nombre ?? ''} aprobaron la evaluación combinada. Genera el contrato para continuar.`
          : `${ctx.solicitante_nombre || 'El solicitante'} quedó aprobado. La evaluación de su co-arrendatario no fue favorable, así que el contrato va sin él (prima del 20 %). Genera el contrato para continuar.`;
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
      reglasDurasCoarrendatario: reglasDurasCoa,
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

/**
 * P3 (2026-09-24): el estudio se decidió por otra vía (el analista, un cierre)
 * mientras se evaluaba al co-arrendatario. La decisión se mantiene y el
 * co-arrendatario recibe la real (también el cierre). Sobre un estudio aprobado:
 *  - con regla dura (p. ej. listas) queda fuera (P2: ni CRC ni contrato, prima
 *    20 %) y se avisa a los analistas, que la revierten con «Cambiar estado»
 *    antes de la firma si hace falta;
 *  - si su evaluación cuenta, el CRC se regenera con el acompañante, salvo que
 *    ya haya un contrato generado sin él: ese manda (plata) y se le avisa al
 *    gestor que, si debe entrar, cancele el contrato y genere otro.
 * Fire-and-forget: nunca lanza.
 */
function decisionYaTomada(
  ctx: ExpedienteCtx,
  titularEstudioId: string,
  estudioCoa: { estado: string; resultado: string },
  coa: { id: string; nombre: string } | null,
  reglasDurasCoa: readonly ReglaDuraActiva[],
): void {
  const avisarCoa = (contratoSinEl = false) =>
    ctx.estado === 'aprobado' || ctx.estado === 'rechazado' || ctx.estado === 'cerrado'
      ? avisarCoarrendatarioDecision(ctx.id, ctx.estado, { reglasDuras: reglasDurasCoa, contratoSinEl })
      : Promise.resolve();

  if (ctx.estado === 'aprobado' && reglasDurasCoa.length > 0) {
    void (async () => {
      const { listOperators } = await import('@/modules/users/users.service');
      const analistas = await listOperators().catch(() => []);
      await Promise.all(
        analistas.map((a) =>
          notificarUsuario({
            userId: a.id,
            tipo: 'estudio.revision_manual',
            titulo: `Co-arrendatario con regla dura en un estudio aprobado — ${ctx.numero}`,
            mensaje:
              `El co-arrendatario salió con una regla dura (${reglasDurasCoa.map(etiquetaReglaDura).join(', ')}) después de que se aprobó el estudio. ` +
              'La aprobación se mantiene y el co-arrendatario queda fuera: no va al CRC ni al contrato y la prima es del 20 %. ' +
              'Si hay que revertirla, usa «Cambiar estado» antes de la firma.',
            link: `/expedientes/${ctx.id}`,
            payload: { expediente_id: ctx.id, via: 'coarrendatario_regla_dura_tras_aprobacion', coarrendatario_id: coa?.id },
          }),
        ),
      );
    })().catch((e) => logger.warn({ error: e, expedienteId: ctx.id }, 'Error avisando a analistas: regla dura del co-arrendatario tras aprobar'));
    void avisarCoa();
    return;
  }

  if (ctx.estado === 'aprobado' && evaluacionCuenta(estudioCoa)) {
    void contratoFijoSinCoarrendatario(ctx.id)
      .then(async (sinEl) => {
        if (sinEl) await avisarContratoSinCoarrendatario(ctx, coa);
        else await emitirCertificadoAutomatico(titularEstudioId, ctx.creado_por, { regenerar: true });
        await avisarCoa(sinEl);
      })
      .catch((e) =>
        logger.warn({ error: e, expedienteId: ctx.id }, 'No se pudo resolver el co-arrendatario evaluado tras la aprobación'),
      );
    return;
  }

  void avisarCoa();
}

/**
 * Al gestor (dueño y responsable): el contrato ya salió sin el co-arrendatario
 * evaluado. Rehacerlo con él solo se puede con el asistente de contratos (mismo
 * criterio que generarContrato): el contrato anterior no admite co-arrendatario.
 */
async function avisarContratoSinCoarrendatario(ctx: ExpedienteCtx, coa: { id: string; nombre: string } | null): Promise<void> {
  const conAsistente = env.CONTRATOS_V3_ENABLED && !!ctx.inmueble_inmobiliaria_id;
  const salida = conAsistente
    ? 'Si debe entrar, cancela el contrato y genera uno nuevo desde el asistente de contratos.'
    : `El contrato actual se mantiene sin él. Si debe entrar, escríbenos a ${(await getCompany()).email}.`;
  const aviso = {
    tipo: 'coarrendatario.rechazo',
    titulo: 'Co-arrendatario evaluado después del contrato',
    mensaje:
      `La evaluación de ${coa?.nombre || 'el co-arrendatario'} terminó después de generar el contrato del estudio ${ctx.numero}, que va sin él (prima del 20 %). ` +
      salida,
    link: `/expedientes/${ctx.id}`,
    payload: { expediente_id: ctx.id, via: 'coarrendatario_fuera_del_contrato', coarrendatario_id: coa?.id },
  };
  if (ctx.inmueble_propietario_id) {
    notificarUsuario({ userId: ctx.inmueble_propietario_id, ...aviso }).catch((e) =>
      logger.warn({ error: e, expedienteId: ctx.id }, 'Error avisando al dueño: co-arrendatario fuera del contrato'),
    );
  }
  notificarResponsableExpediente({ expedienteId: ctx.id, excluirPerfilId: ctx.inmueble_propietario_id, ...aviso }).catch((e) =>
    logger.warn({ error: e, expedienteId: ctx.id }, 'Error avisando al responsable: co-arrendatario fuera del contrato'),
  );
}

/**
 * Aviso al coarrendatario de lo que paso con el caso. El coarrendatario no
 * tiene cuenta en Cofianza: su unico canal es el correo que registro al
 * aceptar. Hasta ahora solo se le escribia cuando la ponderacion decidia sola
 * — si el caso quedaba en revision manual (Adenda 2 §5) hacia su estudio y no
 * volvia a saber nada, ni cuando el analista decidia.
 *
 * Best-effort: sin coarrendatario con estudio terminado y correo, no hace
 * nada. Nunca lanza: es un aviso, no puede tumbar una decision ya escrita.
 */
export async function avisarCoarrendatarioDecision(
  expedienteId: string,
  decision: 'aprobado' | 'rechazado' | 'en_revision' | 'cerrado',
  opts: {
    /** Reglas duras de SU estudio; sin ellas se deducen del motivo guardado. */
    reglasDuras?: readonly ReglaDuraActiva[];
    /** Aprobado, pero con un contrato ya generado sin él (decisionYaTomada). */
    contratoSinEl?: boolean;
  } = {},
): Promise<void> {
  try {
    const { data: coaRow } = await (supabase
      .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
      .select('id, nombre, email, estudio_id')
      .eq('expediente_id', expedienteId)
      .eq('estado', 'estudio_completado')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const coa = coaRow as { id: string; nombre: string; email: string | null; estudio_id: string | null } | null;
    if (!coa?.email) return;

    let resultado: 'aprobado' | 'rechazado' | 'condicionado' | 'pendiente' = 'pendiente';
    let score: number | null = null;
    let reglasDuras = opts.reglasDuras;
    if (coa.estudio_id) {
      const { data: estRow } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .select('resultado, score, motivo_rechazo')
        .eq('id', coa.estudio_id)
        .maybeSingle();
      const est = estRow as { resultado?: typeof resultado | null; score?: number | null; motivo_rechazo?: string | null } | null;
      resultado = est?.resultado ?? 'pendiente';
      score = est?.score ?? null;
      // Sin el veredicto en memoria (decisión del analista), del motivo: un rechazo por
      // regla dura no se manda a revisar el reporte a la central de riesgo.
      reglasDuras ??= inferirReglasDurasDesdeMotivo(est?.motivo_rechazo ?? null);
    }

    const ctx = await fetchExpedienteCtx(expedienteId);
    await sendCoarrendatarioResultadoEmail({
      email: coa.email,
      nombre: coa.nombre,
      coarrendatarioResultado: resultado,
      coarrendatarioScore: score,
      titularNombre: ctx.solicitante_nombre,
      inmuebleDireccion: ctx.inmueble_direccion,
      inmuebleCiudad: ctx.inmueble_ciudad,
      decisionExpediente: decision,
      reglasDurasCoarrendatario: reglasDuras,
      contratoSinEl: opts.contratoSinEl,
    });
  } catch (err) {
    logger.warn(
      { expedienteId, decision, err: err instanceof Error ? err.message : String(err) },
      'No se pudo avisar al coarrendatario',
    );
  }
}

/**
 * P3: su evaluación no llegó a terminar y el estudio ya se resolvió
 * (ejecutarEstudio la canceló). Se le avisa que su invitación quedó sin efecto.
 * Best-effort: nunca lanza.
 */
export async function avisarInvitacionSinEfecto(estudioId: string): Promise<void> {
  try {
    const { data } = await (supabase
      .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
      .select('nombre, email, expediente_id')
      .eq('estudio_id', estudioId)
      .maybeSingle();
    const coa = data as { nombre: string; email: string | null; expediente_id: string } | null;
    if (!coa?.email) return;
    const ctx = await fetchExpedienteCtx(coa.expediente_id);
    await sendCoarrendatarioResultadoEmail({
      email: coa.email,
      nombre: coa.nombre,
      coarrendatarioResultado: 'pendiente',
      coarrendatarioScore: null,
      titularNombre: ctx.solicitante_nombre,
      inmuebleDireccion: ctx.inmueble_direccion,
      inmuebleCiudad: ctx.inmueble_ciudad,
      decisionExpediente: 'sin_efecto',
    });
  } catch (err) {
    logger.warn(
      { estudioId, err: err instanceof Error ? err.message : String(err) },
      'No se pudo avisar al coarrendatario que su invitación quedó sin efecto',
    );
  }
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
  /**
   * 'en_revision': su estudio termino y el caso lo decide un analista (Adenda 2 §5).
   * 'cerrado': el estudio se cerro sin decidir.
   * 'sin_efecto': el estudio se resolvio antes de que terminara su evaluacion.
   */
  decisionExpediente: 'aprobado' | 'rechazado' | 'en_revision' | 'cerrado' | 'sin_efecto';
  /** Reglas duras V4.1 que decidieron SU estudio. Vacio = no fue por regla. */
  reglasDurasCoarrendatario?: readonly ReglaDuraActiva[];
  /** Aprobado, pero el contrato ya se habia generado sin el (P2, contrato fijo). */
  contratoSinEl?: boolean;
}

/** Puro: el asunto y el cuerpo segun la decision y el resultado propio del coa. */
export function construirCorreoCoarrendatario(
  input: SendResultadoEmailInput & { /** Canal de apelación (Politica §11). */ emailApelacion: string },
): { subject: string; html: string } {
  // Texto de personas escapado en el cuerpo; el asunto (titular) va en texto plano.
  const inmuebleStr = escapeHtml(`${input.inmuebleDireccion}${input.inmuebleCiudad ? `, ${input.inmuebleCiudad}` : ''}`);
  const titular = input.titularNombre || 'el titular';
  const titularHtml = escapeHtml(titular);
  const nombre = escapeHtml(input.nombre);
  const porReglaDura = (input.reglasDurasCoarrendatario?.length ?? 0) > 0;
  // P38 (Politica §1, §2, §11): aprobado = su evaluación salió aprobada, o el
  // arrendamiento se aprobó con él adentro (su evaluación cuenta, P2). Solo
  // entonces ve su score; si no, sin puntaje y con su derecho de apelación.
  // Nunca los motivos del titular.
  const cuenta = input.coarrendatarioResultado === 'aprobado' || input.coarrendatarioResultado === 'condicionado';
  const aprobado =
    input.coarrendatarioResultado === 'aprobado' ||
    (input.decisionExpediente === 'aprobado' && cuenta && !input.contratoSinEl);
  // Sin decisión adversa sobre él (no hay nada que apelar): el estudio se
  // cerró sin decidir, o el contrato ya iba sin él.
  const neutral =
    input.decisionExpediente === 'sin_efecto' ||
    (input.decisionExpediente === 'cerrado' && input.coarrendatarioResultado !== 'rechazado') ||
    (input.decisionExpediente === 'aprobado' && !!input.contratoSinEl);

  // El subject y el cuerpo dependen de la decisión final del expediente.
  // No le mostramos el detalle de la ponderación al coa (es info entre el
  // titular y Cofianza); le contamos qué pasó con su parte y cuál es la
  // resolución final.
  let subject: string;
  let cuerpoPrincipal: string;
  let badgeColor = '#0d9488'; // teal Cofianza por defecto
  let encabezado = 'Resultado de tu evaluación';

  if (input.decisionExpediente === 'sin_efecto') {
    subject = `Tu invitación como co-arrendatario quedó sin efecto — ${titular} (Cofianza)`;
    encabezado = 'Tu invitación quedó sin efecto';
    cuerpoPrincipal = `
      <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
      <p style="color: #6b7280;">El estudio de arrendamiento del inmueble en <strong>${inmuebleStr}</strong> se resolvió antes de
      terminar tu evaluación, así que tu invitación como co-arrendatario quedó sin efecto y no seguimos con ella.</p>
      <p style="color: #6b7280;">No tienes que hacer nada más.</p>
    `;
    badgeColor = '#6b7280'; // gris
  } else if (input.decisionExpediente === 'en_revision') {
    // Adenda 2 §5: la decision es de un analista de Cofianza y puede tardar.
    // Sin este correo el coarrendatario se quedaba sin respuesta despues de
    // haber hecho su parte.
    subject = `Tu evaluación ya está lista — arrendamiento con ${titular} (Cofianza)`;
    cuerpoPrincipal = `
      <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
      <p style="color: #6b7280;">Ya terminamos tu evaluación crediticia para el inmueble en <strong>${inmuebleStr}</strong>.
      No es un rechazo: un analista de Cofianza está revisando el caso junto con el de ${titularHtml} y es quien toma la decisión.</p>
      <p style="color: #6b7280;">Te escribimos a este mismo correo en cuanto haya respuesta. No tienes que hacer nada más.</p>
    `;
  } else if (input.decisionExpediente === 'aprobado' && input.contratoSinEl) {
    subject = `Tu evaluación ya está lista — arrendamiento con ${titular} (Cofianza)`;
    cuerpoPrincipal = `
      <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
      <p style="color: #6b7280;">Ya terminamos tu evaluación crediticia, pero el contrato del arrendamiento del inmueble en
      <strong>${inmuebleStr}</strong> ya se había generado sin co-arrendatario, así que por ahora no haces parte de él.</p>
      <p style="color: #6b7280;">Si deciden incluirte, te escribimos a este mismo correo. No tienes que hacer nada más.</p>
    `;
  } else if (input.decisionExpediente === 'cerrado' && input.coarrendatarioResultado !== 'rechazado') {
    subject = `Se cerró el estudio de arrendamiento con ${titular} (Cofianza)`;
    cuerpoPrincipal = `
      <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
      <p style="color: #6b7280;">El estudio de arrendamiento del inmueble en <strong>${inmuebleStr}</strong> se cerró sin continuar,
      así que tu evaluación como co-arrendatario no sigue. No es una decisión sobre ti.</p>
      <p style="color: #6b7280;">El proceso queda cerrado. Si en el futuro hay otra oportunidad con Cofianza, con gusto te evaluamos de nuevo.</p>
    `;
    badgeColor = '#6b7280'; // gris
  } else if (input.decisionExpediente === 'aprobado' && cuenta) {
    // Tras revision manual (Adenda 2 §5) su evaluacion pudo quedar condicionada
    // o sin informacion: lo aprobado es el arrendamiento, no su evaluacion.
    subject = input.coarrendatarioResultado === 'aprobado'
      ? `Tu evaluación se aprobó — arrendamiento con ${titular} (Cofianza)`
      : `Se aprobó el arrendamiento con ${titular} (Cofianza)`;
    cuerpoPrincipal = `
      <p style="color: #374151; font-size: 16px;">¡Buenas noticias, <strong>${nombre}</strong>!</p>
      <p style="color: #6b7280;">${input.coarrendatarioResultado === 'aprobado'
        ? `Tu evaluación crediticia quedó <strong style="color: #047857;">aprobada</strong> y junto con ${titularHtml}\n      pasaron la evaluación combinada`
        : `Cofianza <strong style="color: #047857;">aprobó</strong> el arrendamiento tuyo y de ${titularHtml}`} para el inmueble en <strong>${inmuebleStr}</strong>.</p>
      <p style="color: #6b7280;">El siguiente paso lo coordinamos con ${titularHtml} (firma del contrato y entrega del inmueble).
      No tienes que hacer nada más por ahora — si necesitamos un dato adicional, te escribimos a este mismo correo.</p>
    `;
    badgeColor = '#047857'; // green
  } else {
    // No aprobado para él: el estudio se rechazó o, aprobado, él quedó fuera
    // (su evaluación no cuenta, P2). Distinguimos la causa para que entienda
    // si fue su parte o la del titular, sin contarle nada del titular.
    subject = `Resultado de tu evaluación — ${titular} (Cofianza)`;
    if (input.coarrendatarioResultado === 'aprobado') {
      cuerpoPrincipal = `
        <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
        <p style="color: #6b7280;">Tu evaluación crediticia quedó <strong style="color: #047857;">aprobada</strong>. Sin embargo,
        la evaluación combinada con ${titularHtml} no permite que respaldemos este arrendamiento en este momento.</p>
        <p style="color: #6b7280;">El proceso queda cerrado. Si en el futuro hay otra oportunidad con Cofianza, con gusto te
        evaluamos de nuevo.</p>
      `;
      badgeColor = '#b45309'; // amber
    } else if (input.coarrendatarioResultado === 'rechazado') {
      // Un rechazo por REGLA DURA (§4.2 DTI, §4.3 canon/ingreso) no es un
      // problema de reporte: el score puede ser altisimo. Mandarlo a la central
      // de riesgo seria mandarlo a arreglar algo que no esta roto — el mismo
      // defecto que ya se corrigio para el titular en orchestrator.emails.ts.
      cuerpoPrincipal = porReglaDura
        ? `
        <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
        <p style="color: #6b7280;">${motivoProspectoReglasDuras(input.reglasDurasCoarrendatario ?? [])}</p>
        <p style="color: #6b7280;">Por esta razón no podemos respaldarte como co-arrendatario del inmueble en <strong>${inmuebleStr}</strong>.</p>
      `
        : `
        <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
        <p style="color: #6b7280;">Tu evaluación crediticia quedó <strong style="color: #b91c1c;">no aprobada</strong>.
        Por esta razón no podemos respaldarte como co-arrendatario del inmueble en <strong>${inmuebleStr}</strong>.</p>
        <p style="color: #6b7280;">Si tienes dudas sobre tu reporte, puedes consultarlo directamente con la central de riesgo.</p>
      `;
      badgeColor = '#b91c1c'; // red
    } else {
      // condicionado o cualquier otro estado: rechazo combinado.
      cuerpoPrincipal = `
        <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
        <p style="color: #6b7280;">Tu evaluación crediticia quedó <strong style="color: #b45309;">condicionada</strong>.
        Combinada con la de ${titularHtml}, no alcanza el perfil que necesitamos para respaldar el arrendamiento del
        inmueble en <strong>${inmuebleStr}</strong>.</p>
        <p style="color: #6b7280;">El proceso queda cerrado.</p>
      `;
      badgeColor = '#b45309'; // amber
    }
  }

  // El score solo con una decisión final que lo aprueba (P38). Con regla dura
  // nunca: las reglas duras anulan el puntaje (Politica §3).
  const scoreLine =
    input.decisionExpediente !== 'en_revision' &&
    aprobado &&
    !porReglaDura && typeof input.coarrendatarioScore === 'number' && input.coarrendatarioScore > 0
      ? `<p style="color: #6b7280; font-size: 13px; margin: 4px 0;">Score crediticio: <strong>${input.coarrendatarioScore}</strong></p>`
      : '';
  const apelacion =
    input.decisionExpediente !== 'en_revision' && !aprobado && !neutral ? apelacionHtml(input.emailApelacion) : '';

  return {
    subject,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: ${badgeColor}; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 22px;">${encabezado}</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          ${cuerpoPrincipal}
          ${scoreLine}
          ${apelacion}
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            Recibiste este correo porque ${titularHtml} te invitó a ser su co-arrendatario en Cofianza y autorizaste la evaluación crediticia.
            Cofianza no almacena tu reporte de centrales de riesgo — solo usamos el resultado para esta evaluación puntual.
          </p>
        </div>
      </div>
    `,
  };
}

async function sendCoarrendatarioResultadoEmail(input: SendResultadoEmailInput): Promise<void> {
  const { email: emailApelacion } = await getCompany();
  const { subject, html } = construirCorreoCoarrendatario({ ...input, emailApelacion });
  await resend.emails.send({ from: FROM, to: input.email, subject, html });

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
      'Esta invitación ya fue procesada',
      'COARRENDATARIO_YA_PROCESADA',
      // El estado va en `details`, no en el mensaje: el mensaje se pinta tal
      // cual en la pantalla pública del invitado y uno de los valores del enum
      // es 'rechazado_invitacion' — la palabra que el §13 del flujo prohíbe
      // mostrarle al prospecto, además del enum interno a la vista.
      { estado: coa.estado },
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

  // Flujo §12: "Coarrendatario que no autoriza -> se informa al principal y al
  // solicitante, con opcion de reemplazarlo o continuar solo". Hasta
  // 2026-09-08 solo se intentaba avisar al prospecto por su correo (casi nunca
  // tiene perfil): el gestor no se enteraba y el expediente quedaba
  // condicionado esperando a alguien que ya habia dicho que no.
  const ctx = await fetchExpedienteCtx(coa.expediente_id);
  const link = `/expedientes/${coa.expediente_id}`;
  const payload = { expediente_id: coa.expediente_id, coarrendatario_id: coa.id };

  // Rastro en el expediente (best-effort).
  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: coa.expediente_id,
      tipo: 'estudio',
      descripcion: `${coa.nombre} declinó la invitación como co-arrendatario. Se puede invitar a otra persona o continuar solo si la ruta lo permite.`,
      metadata: { automatico: true, origen: 'coarrendatario_declino', coarrendatario_id: coa.id },
    } as never)
    .then(() => undefined, () => undefined);

  // Al gestor (dueño del inmueble) in-app + correo, y al miembro responsable
  // (mismo patron que la invitacion y el resultado de la ponderacion).
  const tituloGestor = 'Co-arrendatario declinó la invitación';
  const mensajeGestor =
    `${coa.nombre} declinó ser coarrendatario del estudio ${ctx.numero}. ` +
    'Puedes invitar a otra persona o continuar solo si la ruta lo permite.';
  if (ctx.inmueble_propietario_id) {
    notificarYCorreo({
      userId: ctx.inmueble_propietario_id,
      tipo: 'coarrendatario.rechazo',
      titulo: tituloGestor,
      mensaje: mensajeGestor,
      link,
      payload,
    }).catch((e) => logger.warn({ error: e }, 'Error notif gestor coarrendatario rechazo'));
  }
  notificarResponsableExpediente({
    expedienteId: coa.expediente_id,
    excluirPerfilId: ctx.inmueble_propietario_id,
    tipo: 'coarrendatario.rechazo',
    titulo: tituloGestor,
    mensaje: mensajeGestor,
    link,
    payload,
  }).catch((e) => logger.warn({ error: e }, 'Error notif responsable coarrendatario rechazo'));

  // Al solicitante (prospecto): su perfil directo si lo tiene; si no, por correo.
  (ctx.solicitante_creado_por
    ? Promise.resolve(ctx.solicitante_creado_por)
    : findPerfilIdByEmail(ctx.solicitante_email)
  )
    .then((solicitanteUserId) => {
      if (!solicitanteUserId) return;
      return notificarUsuario({
        userId: solicitanteUserId,
        tipo: 'coarrendatario.rechazo',
        titulo: 'Invitación declinada',
        mensaje: `${coa.nombre} no aceptó la invitación de co-arrendatario. Puedes invitar a otra persona.`,
        link,
        payload,
      });
    })
    .catch((e) => logger.warn({ error: e }, 'Error notif coarrendatario rechazo'));

  return { ok: true };
}

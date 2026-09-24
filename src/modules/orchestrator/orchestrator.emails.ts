// ============================================================
// Orchestrator — Email Templates
// Notificaciones automaticas del flujo de arrendamiento
// ============================================================

import { Resend } from 'resend';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { escapeHtml } from '@/lib/escapeHtml';
import { getCompany, type CompanyInfo } from '@/lib/companyConfig';
// Flujo §10: al prospecto solo le llegan los textos de las cuatro rutas.
import { resolverRuta } from '@/modules/estudios/rutas-resultado';

const resend = new Resend(env.RESEND_API_KEY);
const FROM = `Cofianza <${env.RESEND_FROM_EMAIL}>`;

// Pie unico para todos los correos. Antes decia solo "No responder a este
// correo": cerraba la puerta sin dejar ninguna abierta. Ahora ofrece WhatsApp
// y correo reales, tomados de la configuracion de la empresa.
const footerHtml = (c: CompanyInfo) =>
  `<p style="color:#9ca3af;font-size:12px;margin-top:24px;">Correo automático de Cofianza. ¿Dudas? Escríbenos por WhatsApp al ${c.phone} o a ${c.email}.</p>`;

// Botón de los correos de visita (mismo estilo que «Ver en Cofianza»).
const botonHtml = (url: string, texto: string, color = '#0d9488') =>
  `<a href="${url}" style="background: ${color}; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block; margin: 4px;">${texto}</a>`;

// Enlaces públicos de la visita (/visita/<accion>/<token>), los mismos de los
// botones del WhatsApp: el prospecto sin WhatsApp ni cuenta también puede actuar.
export type EnlacesVisita = { reprogramar: string; cancelar: string };
const enlacesVisitaHtml = (e: EnlacesVisita) =>
  `<div style="text-align: center; margin: 24px 0;">${botonHtml(e.reprogramar, 'Reprogramar')}${botonHtml(e.cancelar, 'Cancelar la visita', '#6b7280')}</div>`;

// Todos los emails que muestran fechas de citas usan hora Colombia (UTC-5),
// sin importar la timezone del servidor. Antes de fijar `timeZone` aquí,
// los correos enviados desde Railway (UTC) mostraban la hora 5 horas
// adelantada (4 PM Bogotá → 9 PM en el correo).
const formatFechaColombia = (iso: string): string =>
  new Date(iso).toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

// ── Estudio Aprobado ────────────────────────────────────────

export async function sendEstudioAprobadoEmail(params: {
  email: string;
  nombre: string;
  inmueble: string;
  ciudad: string;
  score: number | null;
}) {
  const { email, nombre, inmueble, ciudad, score } = params;

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Tu evaluación crediticia fue aprobada - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Evaluación aprobada</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${escapeHtml(nombre)}</strong>,</p>
          <p style="color: #6b7280;">Tu evaluación crediticia para el inmueble en <strong>${escapeHtml(inmueble)}, ${escapeHtml(ciudad)}</strong> fue <span style="color: #059669; font-weight: bold;">aprobada</span>.</p>
          ${score ? `<p style="color: #6b7280;">Score crediticio: <strong>${score}</strong></p>` : ''}
          <div style="background: #ecfdf5; border: 1px solid #a7f3d0; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #065f46; margin: 0; font-weight: bold;">Siguiente paso: tu contrato</p>
            <p style="color: #065f46; margin: 4px 0 0;">El propietario o la inmobiliaria preparará tu contrato (fecha de inicio y duración). Cuando esté listo para firmar, te llegará el enlace por WhatsApp al número que registraste. No necesitas hacer nada por ahora.</p>
          </div>
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email }, 'Orchestrator email: estudio aprobado enviado');
}

// ── Estudio Rechazado ───────────────────────────────────────

export async function sendEstudioRechazadoEmail(params: {
  email: string;
  nombre: string;
  /**
   * Motivo GENERAL para el prospecto cuando el rechazo vino de una regla dura
   * de la Politica V4.1 (DTI > 65%, canon/ingreso > 40%). Lo redacta
   * motivoProspectoReglasDuras en el lenguaje del Flujo §10, sin porcentajes
   * ni umbrales. Cuando viene, sustituye la frase generica y el llamado a
   * "mejorar el perfil crediticio", que no aplica: la persona puede tener el
   * historial impecable y aun asi no caber en ESTE canon.
   */
  motivoGeneral?: string | null;
}) {
  const { email, nombre, motivoGeneral } = params;

  const company = await getCompany();

  // Politica §11: al prospecto se le comunica SOLO el motivo general — sin
  // score ni parametros del modelo (antes este correo imprimia "Score
  // crediticio: N", que la API ya le redacta en pantalla) — y su derecho de
  // apelacion: 15 dias habiles para presentarla, respuesta de Cofianza en 10
  // dias habiles, y la apelacion no suspende el proceso de arrendamiento.
  // Con motivoGeneral no se sugiere nada mas (P30): el motivo ya trae la salida
  // de su causa, y un co-arrendatario no cambia un rechazo por regla dura (§5).
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Resultado de tu evaluación crediticia - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #111827; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Resultado de la evaluación</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${escapeHtml(nombre)}</strong>,</p>
          <p style="color: #6b7280;">${motivoGeneral || 'Lamentablemente, tu evaluación crediticia no cumplió con los requisitos mínimos para el arrendamiento en esta oportunidad.'}</p>
          <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #991b1b; margin: 0;">${motivoGeneral
              ? 'Si quieres, escríbenos y revisamos juntos tu caso.'
              : 'Puedes mejorar tu perfil crediticio y volver a intentarlo. Te recomendamos revisar tus obligaciones financieras y mantener tus pagos al día.'}</p>
          </div>
          <div style="background: #f3f4f6; border: 1px solid #e5e7eb; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #374151; margin: 0; font-weight: bold;">¿No estás de acuerdo con esta decisión?</p>
            <p style="color: #4b5563; margin: 4px 0 0;">Puedes presentar una apelación escribiendo a <a href="mailto:${company.email}" style="color: #0d9488;">${company.email}</a> dentro de los <strong>15 días hábiles</strong> siguientes a esta notificación. Cofianza te responde en un máximo de <strong>10 días hábiles</strong>. La apelación no suspende el proceso de arrendamiento del inmueble.</p>
          </div>
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email }, 'Orchestrator email: estudio rechazado enviado');
}

// ── Estudio Condicionado — Invitar co-arrendatario ──────────
//
// Mario (5-may-2026): cambio de paradigma. La promesa de Cofianza es
// "rentar sin fiador". Cuando el estudio queda condicionado ya NO le
// pedimos al solicitante que suba documentación — le pedimos que invite
// a un co-arrendatario y respaldamos a los dos como un solo arrendatario.
// Este email reemplaza el viejo "Documentos Requeridos".

export async function sendDocumentosRequeridosEmail(params: {
  email: string;
  nombre: string;
  score: number | null;
}) {
  const { email, nombre } = params;

  const company = await getCompany();

  // Flujo §10/§13: al prospecto solo le llegan los textos de las rutas — nunca
  // "marginal" ni "rechazado". Para resolverRuta un 'condicionado' es el estado
  // EN REVISION (un analista decide, Politica §3.1): el mismo titulo y mensaje
  // que ve en su pantalla, asi correo y web no se contradicen. El coarrendatario
  // sigue siendo la palanca (Mario, 5-may-2026), pero se ofrece como opcion
  // mientras el equipo revisa, no como veredicto.
  const ruta = resolverRuta({
    puntaje: null,
    resultadoVigente: 'condicionado',
    reglaDuraActivada: false,
    coarrendatarioVinculado: false,
    puntajeCoarrendatario: null,
  });

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: `${ruta.titulo} - Cofianza`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #d97706; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">${ruta.titulo}</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${escapeHtml(nombre)}</strong>,</p>
          <p style="color: #6b7280;">${ruta.mensaje}</p>
          <p style="color: #6b7280;">Mientras tanto, puedes sumar un co-arrendatario. En Cofianza <strong>no pedimos fiador</strong>: invita a la persona con quien vas a vivir y evaluamos a los dos como un solo arrendatario.</p>
          <div style="background: #fffbeb; border: 1px solid #fde68a; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #92400e; margin: 0; font-weight: bold;">¿Cómo funciona?</p>
            <ul style="color: #92400e; margin: 8px 0 0; padding-left: 20px;">
              <li>Ingresa a tu panel y captura los datos de tu co-arrendatario.</li>
              <li>Le enviamos una invitación por correo.</li>
              <li>Cuando acepte, evaluamos su perfil y lo combinamos con el tuyo.</li>
              <li>Si juntos cumplen, los respaldamos como un solo arrendatario.</li>
            </ul>
          </div>
          <p style="color: #6b7280;">No es un fiador ni codeudor — es la persona con quien vas a compartir el arriendo.</p>
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email }, 'Orchestrator email: condicionado/co-arrendatario enviado');
}

// ── Contrato Listo para Firma ───────────────────────────────

export async function sendContratoListoEmail(params: {
  email: string;
  nombre: string;
  inmueble: string;
  ciudad: string;
}) {
  const { email, nombre, inmueble, ciudad } = params;

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Tu contrato está listo para firmar - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Contrato Listo</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${escapeHtml(nombre)}</strong>,</p>
          <p style="color: #6b7280;">Tu contrato de arrendamiento para el inmueble en <strong>${escapeHtml(inmueble)}, ${escapeHtml(ciudad)}</strong> está listo para firmar.</p>
          <div style="background: #f0fdfa; border: 1px solid #99f6e4; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #115e59; margin: 0;">Recibirás un enlace de firma electrónica en tu correo. El proceso toma menos de 5 minutos.</p>
          </div>
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email }, 'Orchestrator email: contrato listo enviado');
}

// ── Arrendatario Aprobado — Notificacion al Propietario ────

export async function sendArrendatarioAprobadoNotificacionEmail(params: {
  email: string;
  nombre_propietario: string;
  nombre_arrendatario: string;
  inmueble: string;
  ciudad: string;
  telefono_arrendatario?: string;
  email_arrendatario: string;
}) {
  const { email, nombre_propietario, nombre_arrendatario, inmueble, ciudad, telefono_arrendatario, email_arrendatario } = params;

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Arrendatario aprobado para tu inmueble - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Arrendatario Aprobado</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${escapeHtml(nombre_propietario)}</strong>,</p>
          <p style="color: #6b7280;">El arrendatario <strong>${escapeHtml(nombre_arrendatario)}</strong> ha sido <span style="color: #059669; font-weight: bold;">aprobado</span> para tu inmueble en <strong>${escapeHtml(inmueble)}, ${escapeHtml(ciudad)}</strong>.</p>
          <div style="background: #ecfdf5; border: 1px solid #a7f3d0; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #065f46; margin: 0; font-weight: bold;">Datos de contacto del arrendatario:</p>
            <ul style="color: #065f46; margin: 8px 0 0; padding-left: 20px; list-style: none;">
              <li>Nombre: <strong>${escapeHtml(nombre_arrendatario)}</strong></li>
              <li>Email: <strong>${escapeHtml(email_arrendatario)}</strong></li>
              ${telefono_arrendatario ? `<li>Teléfono: <strong>${escapeHtml(telefono_arrendatario)}</strong></li>` : ''}
            </ul>
          </div>
          <div style="text-align: center; margin: 24px 0;">
            <a href="mailto:${escapeHtml(email_arrendatario)}" style="background: #0d9488; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">Contacta al arrendatario lo antes posible</a>
          </div>
          <p style="color: #6b7280; font-size: 14px;">Te recomendamos comunicarte con el arrendatario a la brevedad para coordinar los siguientes pasos del proceso de arrendamiento.</p>
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email, nombre_arrendatario }, 'Orchestrator email: arrendatario aprobado notificacion enviado');
}

// ── Expediente Externo — Invitacion ────────────────────────

export async function sendExpedienteInvitacionEmail(params: {
  email: string;
  nombre_invitador: string;
  inmueble: string;
  ciudad: string;
  token: string;
  frontend_url: string;
}) {
  const { email, nombre_invitador, inmueble, ciudad, token, frontend_url } = params;
  const registroUrl = `${frontend_url}/registro/solicitante?token=${token}`;

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Te han invitado a un proceso de arrendamiento - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Invitacion de Arrendamiento</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola,</p>
          <p style="color: #6b7280;"><strong>${escapeHtml(nombre_invitador)}</strong> te ha invitado a completar un estudio de arrendamiento para el inmueble en <strong>${escapeHtml(inmueble)}, ${escapeHtml(ciudad)}</strong>.</p>
          <div style="background: #f0fdfa; border: 1px solid #99f6e4; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #115e59; margin: 0;">Para continuar con el proceso, necesitas registrarte en la plataforma Cofianza y completar tu evaluación crediticia.</p>
          </div>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${registroUrl}" style="background: #0d9488; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">Registrarme y continuar</a>
          </div>
          <p style="color: #6b7280; font-size: 14px;">Si no esperabas esta invitacion, puedes ignorar este correo.</p>
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email, nombre_invitador }, 'Orchestrator email: estudio invitacion enviado');
}

// ── Invitacion de Miembro a Inmobiliaria ───────────────────

export async function sendInvitacionMiembroEmail(params: {
  email: string;
  nombre_invitador: string;
  nombre_organizacion: string;
  token: string;
  frontend_url: string;
}) {
  const { email, nombre_invitador, nombre_organizacion, token, frontend_url } = params;
  const aceptarUrl = `${frontend_url}/invitacion-miembro/${token}`;

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: `Te invitaron a unirte a ${nombre_organizacion} en Cofianza`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Invitacion a tu equipo</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola,</p>
          <p style="color: #6b7280;"><strong>${escapeHtml(nombre_invitador)}</strong> te invitó a unirte a <strong>${escapeHtml(nombre_organizacion)}</strong> en la plataforma Cofianza para gestionar inmuebles y estudios en equipo.</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${aceptarUrl}" style="background: #0d9488; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">Aceptar invitacion</a>
          </div>
          <p style="color: #6b7280; font-size: 14px;">Este enlace vence en 7 días. Si no esperabas esta invitación, puedes ignorar este correo.</p>
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email, nombre_organizacion }, 'Orchestrator email: invitacion de miembro enviada');
}

// ── Responsable asignado (inmueble o expediente) ───────────

export async function sendResponsableAsignadoEmail(params: {
  email: string;
  nombre: string | null;
  titulo: string;
  mensaje: string;
  link: string; // ruta relativa, ej. /expedientes/<id>
  frontend_url: string;
}) {
  const { email, nombre, link, frontend_url } = params;
  // Escapado obligatorio (ver lib/escapeHtml). El `subject` va en texto plano.
  const titulo = escapeHtml(params.titulo);
  const mensaje = escapeHtml(params.mensaje);
  const url = `${frontend_url}${link.startsWith('/') ? '' : '/'}${link}`;
  const saludo = nombre ? `Hola ${escapeHtml(nombre)},` : 'Hola,';

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: params.titulo,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 22px;">${titulo}</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">${saludo}</p>
          <p style="color: #6b7280;">${mensaje}</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${url}" style="background: #0d9488; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">Ver en Cofianza</a>
          </div>
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email, titulo: params.titulo }, 'Orchestrator email: responsable asignado enviado');
}

// ── Cita Solicitada — Notificacion al Propietario ──────────

export async function sendCitaSolicitadaPropietarioEmail(params: {
  email: string;
  nombre_propietario: string;
  nombre_solicitante: string;
  inmueble: string;
  ciudad: string;
  fecha_propuesta: string;
  /** /citas#cita-<id>: la lista de visitas se desplaza hasta esta. */
  url_visita?: string;
}) {
  const { email, nombre_propietario, nombre_solicitante, inmueble, ciudad, fecha_propuesta, url_visita } = params;
  const fechaFormateada = formatFechaColombia(fecha_propuesta);

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Nueva solicitud de visita - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Nueva Solicitud de Cita</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${escapeHtml(nombre_propietario)}</strong>,</p>
          <p style="color: #6b7280;"><strong>${escapeHtml(nombre_solicitante)}</strong> ha solicitado una visita a tu inmueble en <strong>${escapeHtml(inmueble)}, ${escapeHtml(ciudad)}</strong>.</p>
          <div style="background: #ecfeff; border: 1px solid #a5f3fc; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #155e75; margin: 0; font-weight: bold;">Fecha propuesta:</p>
            <p style="color: #155e75; margin: 4px 0 0;">${fechaFormateada}</p>
          </div>
          <p style="color: #6b7280;">Ingresa a la plataforma para confirmar o ajustar la fecha de la visita.</p>
          ${url_visita ? `<div style="text-align: center; margin: 24px 0;">${botonHtml(url_visita, 'Ver la visita')}</div>` : ''}
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email, nombre_solicitante }, 'Orchestrator email: cita solicitada notificacion enviado');
}

// ── Cita Confirmada — Notificacion al Solicitante ──────────

export async function sendCitaConfirmadaSolicitanteEmail(params: {
  email: string;
  nombre_solicitante: string;
  inmueble: string;
  ciudad: string;
  fecha_confirmada: string;
  notas_propietario?: string;
  enlaces?: EnlacesVisita;
}) {
  const { email, nombre_solicitante, inmueble, ciudad, fecha_confirmada, notas_propietario, enlaces } = params;
  const fechaFormateada = formatFechaColombia(fecha_confirmada);

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Tu visita ha sido confirmada - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Visita Confirmada</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${escapeHtml(nombre_solicitante)}</strong>,</p>
          <p style="color: #6b7280;">Tu visita al inmueble en <strong>${escapeHtml(inmueble)}, ${escapeHtml(ciudad)}</strong> ha sido <span style="color: #059669; font-weight: bold;">confirmada</span>.</p>
          <div style="background: #ecfdf5; border: 1px solid #a7f3d0; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #065f46; margin: 0; font-weight: bold;">Fecha confirmada:</p>
            <p style="color: #065f46; margin: 4px 0 0;">${fechaFormateada}</p>
            ${notas_propietario ? `<p style="color: #065f46; margin: 8px 0 0;"><strong>Notas:</strong> ${escapeHtml(notas_propietario)}</p>` : ''}
          </div>
          <p style="color: #6b7280;">Después de la visita, se habilitará tu evaluación crediticia.</p>
          ${enlaces ? `<p style="color: #6b7280;">¿No puedes ir? Reprograma o cancela la visita aquí:</p>${enlacesVisitaHtml(enlaces)}` : ''}
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email, nombre_solicitante }, 'Orchestrator email: cita confirmada notificacion enviado');
}

// ── Cita Reprogramada — Propietario ajustó la fecha/hora ──

export async function sendCitaReprogramadaSolicitanteEmail(params: {
  email: string;
  nombre_solicitante: string;
  inmueble: string;
  ciudad: string;
  fecha_propuesta: string;
  fecha_confirmada: string;
  notas_propietario?: string;
  enlaces?: EnlacesVisita;
}) {
  const { email, nombre_solicitante, inmueble, ciudad, fecha_propuesta, fecha_confirmada, notas_propietario, enlaces } = params;
  const fechaOriginal = formatFechaColombia(fecha_propuesta);
  const fechaNueva = formatFechaColombia(fecha_confirmada);

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'El propietario ajustó la fecha de tu visita - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #d97706; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Visita Reprogramada</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${escapeHtml(nombre_solicitante)}</strong>,</p>
          <p style="color: #6b7280;">El propietario confirmó tu visita al inmueble en <strong>${escapeHtml(inmueble)}, ${escapeHtml(ciudad)}</strong>, pero ajustó la fecha y/u hora. Revisa el nuevo horario a continuación.</p>
          <div style="background: #fffbeb; border: 1px solid #fde68a; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #92400e; margin: 0; font-size: 13px;">Fecha que habías propuesto:</p>
            <p style="color: #92400e; margin: 2px 0 12px; text-decoration: line-through;">${fechaOriginal}</p>
            <p style="color: #92400e; margin: 0; font-weight: bold;">Nueva fecha confirmada:</p>
            <p style="color: #92400e; margin: 4px 0 0; font-weight: bold; font-size: 16px;">${fechaNueva}</p>
            ${notas_propietario ? `<p style="color: #92400e; margin: 12px 0 0;"><strong>Notas del propietario:</strong> ${escapeHtml(notas_propietario)}</p>` : ''}
          </div>
          ${enlaces
            ? `<p style="color: #6b7280;">Si el nuevo horario no te sirve, reprograma o cancela la visita aquí:</p>${enlacesVisitaHtml(enlaces)}`
            : '<p style="color: #6b7280;">Si el nuevo horario no te sirve, comunícate con quien publicó el inmueble para reagendar.</p>'}
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email, nombre_solicitante }, 'Orchestrator email: cita reprogramada notificacion enviado');
}

// ── Cita Cancelada — Notificación a la contraparte ─────────

/**
 * Notifica que la cita fue cancelada. Lo dispara cualquiera de los dos
 * lados (propietario o solicitante) — el caller decide a quien le manda.
 * El subject y el saludo se ajustan segun quien recibe.
 */
export async function sendCitaCanceladaEmail(params: {
  email: string;
  nombre_destinatario: string;
  inmueble: string;
  ciudad: string;
  fecha_cita: string;
  motivo: string;
  cancelado_por: 'propietario' | 'solicitante';
  /** /citas, solo para el dueño (el prospecto no tiene panel de visitas). */
  url_citas?: string;
}) {
  const { email, nombre_destinatario, inmueble, ciudad, fecha_cita, motivo, cancelado_por, url_citas } = params;
  const fechaFormateada = formatFechaColombia(fecha_cita);

  // 'propietario' agrupa al dueño, la inmobiliaria y Cofianza: texto neutro.
  const quienCancelo = cancelado_por === 'propietario' ? 'Quien publicó el inmueble' : 'El solicitante';

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Visita cancelada - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #dc2626; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Visita Cancelada</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${escapeHtml(nombre_destinatario)}</strong>,</p>
          <p style="color: #6b7280;">${quienCancelo} canceló la visita al inmueble en <strong>${escapeHtml(inmueble)}, ${escapeHtml(ciudad)}</strong>.</p>
          <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #991b1b; margin: 0; font-size: 13px;">Fecha que estaba agendada:</p>
            <p style="color: #991b1b; margin: 2px 0 12px;">${fechaFormateada}</p>
            <p style="color: #991b1b; margin: 0; font-weight: bold;">Motivo:</p>
            <p style="color: #991b1b; margin: 4px 0 0;">${escapeHtml(motivo)}</p>
          </div>
          ${cancelado_por === 'solicitante'
            ? `<p style="color: #6b7280;">Si agenda una nueva fecha, te llegará el aviso para confirmarla.</p>${url_citas ? `<div style="text-align: center; margin: 24px 0;">${botonHtml(url_citas, 'Ver mis visitas')}</div>` : ''}`
            : '<p style="color: #6b7280;">Si todavía te interesa el inmueble, comunícate con quien lo publicó para coordinar una nueva fecha.</p>'}
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email, cancelado_por }, 'Orchestrator email: cita cancelada notificacion enviado');
}

// ── Estudio Habilitado — Notificación al Solicitante ───────

export async function sendEstudioHabilitadoEmail(params: {
  email: string;
  nombre_solicitante: string;
  expediente_numero: string;
  inmueble: string;
  ciudad: string;
  url_panel: string;
}) {
  const { email, nombre_solicitante, expediente_numero, inmueble, ciudad, url_panel } = params;

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: `Tu solicitud fue autorizada — ${expediente_numero}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Solicitud autorizada</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${escapeHtml(nombre_solicitante)}</strong>,</p>
          <p style="color: #6b7280;">Tu solicitud para el inmueble en <strong>${escapeHtml(inmueble)}, ${escapeHtml(ciudad)}</strong> fue <span style="color: #059669; font-weight: bold;">autorizada</span> por el propietario.</p>
          <div style="background: #ecfdf5; border: 1px solid #a7f3d0; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #065f46; margin: 0; font-weight: bold;">Siguiente paso: firmar la autorización de datos</p>
            <p style="color: #065f46; margin: 8px 0 0;">Estudio: <strong>${expediente_numero}</strong></p>
            <p style="color: #065f46; margin: 4px 0 0;">Te enviamos por correo y WhatsApp el enlace para autorizar la consulta en centrales de riesgo. El cobro del estudio llega después de que autorices.</p>
          </div>
          <p style="text-align: center; margin: 24px 0;">
            <a href="${url_panel}" style="display: inline-block; background: #0d9488; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Ir al panel</a>
          </p>
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email, expediente_numero }, 'Orchestrator email: estudio habilitado enviado');
}

// ── Propietario decidio no habilitar estudio tras la visita ────

export async function sendEstudioNoHabilitadoEmail(params: {
  email: string;
  nombre_solicitante: string;
  expediente_numero: string;
  inmueble: string;
  ciudad: string;
  motivo: string | null;
}) {
  const { email, nombre_solicitante, expediente_numero, inmueble, ciudad, motivo } = params;

  const company = await getCompany();

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: `Actualización sobre tu solicitud — ${expediente_numero}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #6b7280; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Solicitud no continuará</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${escapeHtml(nombre_solicitante)}</strong>,</p>
          <p style="color: #6b7280;">Tras la visita al inmueble en <strong>${escapeHtml(inmueble)}, ${escapeHtml(ciudad)}</strong>, el propietario decidió no continuar con la evaluación crediticia de tu solicitud (<strong>${expediente_numero}</strong>).</p>
          ${motivo ? `
          <div style="background: #f3f4f6; border: 1px solid #e5e7eb; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #374151; margin: 0; font-weight: bold;">Motivo del propietario:</p>
            <p style="color: #4b5563; margin: 8px 0 0;">${escapeHtml(motivo)}</p>
          </div>
          ` : ''}
          <p style="color: #6b7280;">Puedes seguir explorando otros inmuebles en la vitrina de Cofianza y solicitar tu fiador para el que prefieras.</p>
          ${footerHtml(company)}
        </div>
      </div>
    `,
  });

  logger.info({ email, expediente_numero }, 'Orchestrator email: estudio no habilitado enviado');
}

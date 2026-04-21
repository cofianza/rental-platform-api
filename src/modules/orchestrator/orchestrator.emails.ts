// ============================================================
// Orchestrator — Email Templates
// Notificaciones automaticas del flujo de arrendamiento
// ============================================================

import { Resend } from 'resend';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

const resend = new Resend(env.RESEND_API_KEY);
const FROM = `Cofianza <${env.RESEND_FROM_EMAIL}>`;

// ── Estudio Aprobado ────────────────────────────────────────

export async function sendEstudioAprobadoEmail(params: {
  email: string;
  nombre: string;
  inmueble: string;
  ciudad: string;
  score: number | null;
}) {
  const { email, nombre, inmueble, ciudad, score } = params;

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Tu estudio crediticio fue aprobado - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Estudio Aprobado</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
          <p style="color: #6b7280;">Tu estudio crediticio para el inmueble en <strong>${inmueble}, ${ciudad}</strong> ha sido <span style="color: #059669; font-weight: bold;">aprobado</span>.</p>
          ${score ? `<p style="color: #6b7280;">Score crediticio: <strong>${score}</strong></p>` : ''}
          <div style="background: #ecfdf5; border: 1px solid #a7f3d0; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #065f46; margin: 0; font-weight: bold;">Siguiente paso: Firma del contrato</p>
            <p style="color: #065f46; margin: 4px 0 0;">Tu contrato ha sido generado automaticamente. Recibiras un enlace para firmarlo electronicamente en los proximos minutos.</p>
          </div>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">Este es un mensaje automatico de Cofianza. No responder a este correo.</p>
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
  score: number | null;
}) {
  const { email, nombre, score } = params;

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Resultado de tu estudio crediticio - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #111827; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Resultado del Estudio</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
          <p style="color: #6b7280;">Lamentablemente, tu estudio crediticio no cumplio con los requisitos minimos para el arrendamiento en esta oportunidad.</p>
          ${score ? `<p style="color: #6b7280;">Score crediticio: <strong>${score}</strong></p>` : ''}
          <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #991b1b; margin: 0;">Puedes mejorar tu perfil crediticio y volver a intentarlo. Te recomendamos revisar tus obligaciones financieras y mantener tus pagos al dia.</p>
          </div>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">Este es un mensaje automatico de Cofianza.</p>
        </div>
      </div>
    `,
  });

  logger.info({ email }, 'Orchestrator email: estudio rechazado enviado');
}

// ── Documentos Requeridos (Condicionado) ────────────────────

export async function sendDocumentosRequeridosEmail(params: {
  email: string;
  nombre: string;
  score: number | null;
}) {
  const { email, nombre, score } = params;

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Se requieren documentos adicionales - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #d97706; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Documentos Adicionales</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
          <p style="color: #6b7280;">Tu estudio crediticio requiere documentacion adicional para completar la evaluacion.</p>
          ${score ? `<p style="color: #6b7280;">Score crediticio: <strong>${score}</strong></p>` : ''}
          <div style="background: #fffbeb; border: 1px solid #fde68a; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #92400e; margin: 0; font-weight: bold;">Documentos que puedes subir:</p>
            <ul style="color: #92400e; margin: 8px 0 0; padding-left: 20px;">
              <li>Certificacion laboral reciente</li>
              <li>Extractos bancarios (ultimos 3 meses)</li>
              <li>Declaracion de renta</li>
              <li>Carta de referencia</li>
            </ul>
          </div>
          <p style="color: #6b7280;">Ingresa a tu panel en Cofianza para subir los documentos y continuar con el proceso.</p>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">Este es un mensaje automatico de Cofianza.</p>
        </div>
      </div>
    `,
  });

  logger.info({ email }, 'Orchestrator email: documentos requeridos enviado');
}

// ── Contrato Listo para Firma ───────────────────────────────

export async function sendContratoListoEmail(params: {
  email: string;
  nombre: string;
  inmueble: string;
  ciudad: string;
}) {
  const { email, nombre, inmueble, ciudad } = params;

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Tu contrato esta listo para firmar - Cofianza',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: #0d9488; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Contrato Listo</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
          <p style="color: #6b7280;">Tu contrato de arrendamiento para el inmueble en <strong>${inmueble}, ${ciudad}</strong> esta listo para firmar.</p>
          <div style="background: #f0fdfa; border: 1px solid #99f6e4; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #115e59; margin: 0;">Recibiras un enlace de firma electronica en tu correo. El proceso toma menos de 5 minutos.</p>
          </div>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">Este es un mensaje automatico de Cofianza.</p>
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
          <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre_propietario}</strong>,</p>
          <p style="color: #6b7280;">El arrendatario <strong>${nombre_arrendatario}</strong> ha sido <span style="color: #059669; font-weight: bold;">aprobado</span> para tu inmueble en <strong>${inmueble}, ${ciudad}</strong>.</p>
          <div style="background: #ecfdf5; border: 1px solid #a7f3d0; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #065f46; margin: 0; font-weight: bold;">Datos de contacto del arrendatario:</p>
            <ul style="color: #065f46; margin: 8px 0 0; padding-left: 20px; list-style: none;">
              <li>Nombre: <strong>${nombre_arrendatario}</strong></li>
              <li>Email: <strong>${email_arrendatario}</strong></li>
              ${telefono_arrendatario ? `<li>Telefono: <strong>${telefono_arrendatario}</strong></li>` : ''}
            </ul>
          </div>
          <div style="text-align: center; margin: 24px 0;">
            <a href="mailto:${email_arrendatario}" style="background: #0d9488; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">Contacta al arrendatario lo antes posible</a>
          </div>
          <p style="color: #6b7280; font-size: 14px;">Te recomendamos comunicarte con el arrendatario a la brevedad para coordinar los siguientes pasos del proceso de arrendamiento.</p>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">Este es un mensaje automatico de Cofianza. No responder a este correo.</p>
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
          <p style="color: #6b7280;"><strong>${nombre_invitador}</strong> te ha invitado a completar un estudio de arrendamiento para el inmueble en <strong>${inmueble}, ${ciudad}</strong>.</p>
          <div style="background: #f0fdfa; border: 1px solid #99f6e4; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #115e59; margin: 0;">Para continuar con el proceso, necesitas registrarte en la plataforma Cofianza y completar tu estudio crediticio.</p>
          </div>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${registroUrl}" style="background: #0d9488; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">Registrarme y continuar</a>
          </div>
          <p style="color: #6b7280; font-size: 14px;">Si no esperabas esta invitacion, puedes ignorar este correo.</p>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">Este es un mensaje automatico de Cofianza. No responder a este correo.</p>
        </div>
      </div>
    `,
  });

  logger.info({ email, nombre_invitador }, 'Orchestrator email: expediente invitacion enviado');
}

// ── Cita Solicitada — Notificacion al Propietario ──────────

export async function sendCitaSolicitadaPropietarioEmail(params: {
  email: string;
  nombre_propietario: string;
  nombre_solicitante: string;
  inmueble: string;
  ciudad: string;
  fecha_propuesta: string;
}) {
  const { email, nombre_propietario, nombre_solicitante, inmueble, ciudad, fecha_propuesta } = params;
  const fechaFormateada = new Date(fecha_propuesta).toLocaleString('es-CO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

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
          <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre_propietario}</strong>,</p>
          <p style="color: #6b7280;"><strong>${nombre_solicitante}</strong> ha solicitado una visita a tu inmueble en <strong>${inmueble}, ${ciudad}</strong>.</p>
          <div style="background: #ecfeff; border: 1px solid #a5f3fc; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #155e75; margin: 0; font-weight: bold;">Fecha propuesta:</p>
            <p style="color: #155e75; margin: 4px 0 0;">${fechaFormateada}</p>
          </div>
          <p style="color: #6b7280;">Ingresa a la plataforma para confirmar o ajustar la fecha de la visita.</p>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">Este es un mensaje automatico de Cofianza. No responder a este correo.</p>
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
}) {
  const { email, nombre_solicitante, inmueble, ciudad, fecha_confirmada, notas_propietario } = params;
  const fechaFormateada = new Date(fecha_confirmada).toLocaleString('es-CO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

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
          <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre_solicitante}</strong>,</p>
          <p style="color: #6b7280;">Tu visita al inmueble en <strong>${inmueble}, ${ciudad}</strong> ha sido <span style="color: #059669; font-weight: bold;">confirmada</span>.</p>
          <div style="background: #ecfdf5; border: 1px solid #a7f3d0; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #065f46; margin: 0; font-weight: bold;">Fecha confirmada:</p>
            <p style="color: #065f46; margin: 4px 0 0;">${fechaFormateada}</p>
            ${notas_propietario ? `<p style="color: #065f46; margin: 8px 0 0;"><strong>Notas:</strong> ${notas_propietario}</p>` : ''}
          </div>
          <p style="color: #6b7280;">Despues de la visita, el propietario habilitara tu estudio crediticio.</p>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">Este es un mensaje automatico de Cofianza. No responder a este correo.</p>
        </div>
      </div>
    `,
  });

  logger.info({ email, nombre_solicitante }, 'Orchestrator email: cita confirmada notificacion enviado');
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
          <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre_solicitante}</strong>,</p>
          <p style="color: #6b7280;">Tu solicitud para el inmueble en <strong>${inmueble}, ${ciudad}</strong> fue <span style="color: #059669; font-weight: bold;">autorizada</span> por el propietario.</p>
          <div style="background: #ecfdf5; border: 1px solid #a7f3d0; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="color: #065f46; margin: 0; font-weight: bold;">Siguiente paso: pagar el estudio crediticio</p>
            <p style="color: #065f46; margin: 8px 0 0;">Expediente: <strong>${expediente_numero}</strong></p>
            <p style="color: #065f46; margin: 4px 0 0;">Ingresa a tu panel para proceder con el pago. Una vez recibido, se ejecuta el estudio automáticamente.</p>
          </div>
          <p style="text-align: center; margin: 24px 0;">
            <a href="${url_panel}" style="display: inline-block; background: #0d9488; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Ir al panel</a>
          </p>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">Este es un mensaje automatico de Cofianza. No responder a este correo.</p>
        </div>
      </div>
    `,
  });

  logger.info({ email, expediente_numero }, 'Orchestrator email: estudio habilitado enviado');
}

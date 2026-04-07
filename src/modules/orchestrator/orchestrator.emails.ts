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

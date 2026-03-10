/**
 * Post-firma email templates — HP-345
 *
 * Two emails sent after successful firma:
 * 1. Acuse de firma → firmante (confirmation + contract summary)
 * 2. Notification → operador/analista (firma completed + link to expediente)
 */

import { Resend } from 'resend';
import { env } from '@/config';
import { logger } from '@/lib/logger';

const resend = new Resend(env.RESEND_API_KEY);
const FROM_EMAIL = `Habitar Propiedades <${env.RESEND_FROM_EMAIL}>`;

// ============================================================
// 1. Acuse de firma al firmante
// ============================================================

interface AcuseEmailParams {
  to: string;
  nombreFirmante: string;
  firmadoEn: string;
  contratoNombre: string;
  inmuebleDireccion: string;
  inmuebleCiudad: string;
  acusePdf?: Buffer;
}

export async function sendFirmaAcuseEmail(params: AcuseEmailParams): Promise<void> {
  const { to, nombreFirmante, firmadoEn, contratoNombre, inmuebleDireccion, inmuebleCiudad, acusePdf } = params;

  const fechaFormateada = new Date(firmadoEn).toLocaleString('es-CO', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  });

  const inmuebleDisplay = inmuebleCiudad
    ? `${inmuebleDireccion}, ${inmuebleCiudad}`
    : inmuebleDireccion;

  try {
    const emailPayload: Parameters<typeof resend.emails.send>[0] = {
      from: FROM_EMAIL,
      to,
      subject: 'Confirmacion de firma electronica - Habitar Propiedades',
      html: buildAcuseHtml(nombreFirmante, fechaFormateada, contratoNombre, inmuebleDisplay),
    };

    if (acusePdf) {
      emailPayload.attachments = [
        {
          filename: 'acuse-firma.pdf',
          content: acusePdf,
        },
      ];
    }

    await resend.emails.send(emailPayload);

    logger.info({ to, hasAttachment: !!acusePdf }, 'Post-firma: acuse email sent to firmante');
  } catch (error) {
    logger.error({ to, error }, 'Post-firma: error sending acuse email');
    throw error;
  }
}

function buildAcuseHtml(
  nombre: string,
  fecha: string,
  contrato: string,
  inmueble: string,
): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Firma completada</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background-color: #0f766e; border-radius: 12px; width: 48px; height: 48px; text-align: center; vertical-align: middle;">
                    <span style="color: #ffffff; font-weight: bold; font-size: 20px; line-height: 48px;">HP</span>
                  </td>
                  <td style="padding-left: 12px;">
                    <span style="font-size: 20px; font-weight: 600; color: #0f766e;">Habitar Propiedades</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <!-- Success icon -->
              <div style="text-align: center; margin-bottom: 24px;">
                <div style="display: inline-block; background-color: #dcfce7; border-radius: 50%; width: 64px; height: 64px; line-height: 64px; text-align: center;">
                  <span style="font-size: 32px;">&#10003;</span>
                </div>
              </div>

              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #111827; text-align: center;">
                Firma registrada exitosamente
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563; text-align: center;">
                Hola ${nombre}, tu firma electronica ha sido registrada correctamente.
              </p>

              <!-- Contract summary -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px; background-color: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 4px; font-size: 13px; color: #6b7280;">Contrato:</p>
                    <p style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #111827;">${contrato}</p>
                    <p style="margin: 0 0 4px; font-size: 13px; color: #6b7280;">Inmueble:</p>
                    <p style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #111827;">${inmueble || 'N/A'}</p>
                    <p style="margin: 0 0 4px; font-size: 13px; color: #6b7280;">Fecha y hora de firma:</p>
                    <p style="margin: 0; font-size: 16px; font-weight: 600; color: #111827;">${fecha}</p>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #6b7280;">
                Tu firma ha sido almacenada de forma segura junto con toda la evidencia legal correspondiente (IP, geolocalizacion, verificacion OTP y hash del documento).
              </p>

              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #9ca3af;">
                Este proceso cumple con la Ley 527 de 1999 sobre comercio electronico y firmas digitales, y la Ley 1581 de 2012 sobre proteccion de datos personales de Colombia.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 32px;">
              <p style="margin: 0; font-size: 13px; color: #9ca3af;">
                &copy; ${new Date().getFullYear()} Habitar Propiedades. Todos los derechos reservados.
              </p>
              <p style="margin: 8px 0 0; font-size: 12px; color: #d1d5db;">
                Este es un correo automatico, por favor no respondas a este mensaje.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ============================================================
// 2. Notification to operador/analista
// ============================================================

interface OperadorNotificationParams {
  to: string;
  nombreOperador: string;
  nombreFirmante: string;
  firmadoEn: string;
  contratoNombre: string;
  expedienteNumero: string;
  expedienteUrl: string;
  allSigned: boolean;
}

export async function sendFirmaOperadorNotification(params: OperadorNotificationParams): Promise<void> {
  const {
    to, nombreOperador, nombreFirmante, firmadoEn,
    contratoNombre, expedienteNumero, expedienteUrl, allSigned,
  } = params;

  const fechaFormateada = new Date(firmadoEn).toLocaleString('es-CO', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  });

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `Firma completada: ${nombreFirmante} - ${contratoNombre}`,
      html: buildOperadorHtml(nombreOperador, nombreFirmante, fechaFormateada, contratoNombre, expedienteNumero, expedienteUrl, allSigned),
    });

    logger.info({ to }, 'Post-firma: notification email sent to operador');
  } catch (error) {
    logger.error({ to, error }, 'Post-firma: error sending operador notification');
    throw error;
  }
}

function buildOperadorHtml(
  nombreOperador: string,
  nombreFirmante: string,
  fecha: string,
  contrato: string,
  expedienteNumero: string,
  expedienteUrl: string,
  allSigned: boolean,
): string {
  const statusMessage = allSigned
    ? '<p style="margin: 0; font-size: 14px; font-weight: 600; color: #059669;">Todas las firmas han sido completadas. El contrato ha sido marcado como firmado automaticamente.</p>'
    : '<p style="margin: 0; font-size: 14px; font-weight: 500; color: #d97706;">Aun faltan firmas de otros firmantes para completar el contrato.</p>';

  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Firma completada</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background-color: #0f766e; border-radius: 12px; width: 48px; height: 48px; text-align: center; vertical-align: middle;">
                    <span style="color: #ffffff; font-weight: bold; font-size: 20px; line-height: 48px;">HP</span>
                  </td>
                  <td style="padding-left: 12px;">
                    <span style="font-size: 20px; font-weight: 600; color: #0f766e;">Habitar Propiedades</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #111827;">
                Firma completada
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Hola ${nombreOperador}, te informamos que <strong>${nombreFirmante}</strong> ha completado su firma electronica.
              </p>

              <!-- Details -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px; background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 4px; font-size: 13px; color: #6b7280;">Contrato:</p>
                    <p style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #111827;">${contrato}</p>
                    <p style="margin: 0 0 4px; font-size: 13px; color: #6b7280;">Expediente:</p>
                    <p style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #111827;">${expedienteNumero}</p>
                    <p style="margin: 0 0 4px; font-size: 13px; color: #6b7280;">Firmado el:</p>
                    <p style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #111827;">${fecha}</p>
                    ${statusMessage}
                  </td>
                </tr>
              </table>

              <!-- Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <a href="${expedienteUrl}" target="_blank" style="display: inline-block; background-color: #0d9488; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px;">
                      Ver expediente
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 32px;">
              <p style="margin: 0; font-size: 13px; color: #9ca3af;">
                &copy; ${new Date().getFullYear()} Habitar Propiedades. Todos los derechos reservados.
              </p>
              <p style="margin: 8px 0 0; font-size: 12px; color: #d1d5db;">
                Este es un correo automatico, por favor no respondas a este mensaje.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

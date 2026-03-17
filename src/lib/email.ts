import { Resend } from 'resend';
import { env } from '@/config';
import { logger } from '@/lib/logger';

const resend = new Resend(env.RESEND_API_KEY);

const FROM_EMAIL = `Cofianza <${env.RESEND_FROM_EMAIL}>`;

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Recupera tu contraseña - Cofianza',
      html: buildPasswordResetHtml(resetUrl),
    });

    logger.info({ to }, 'Email de recuperacion de contrasena enviado');
  } catch (error) {
    logger.error({ to, error }, 'Error al enviar email de recuperacion');
    throw error;
  }
}

export async function sendWelcomeEmail(to: string, nombre: string, tempPassword: string): Promise<void> {
  const loginUrl = `${env.FRONTEND_URL}/login`;

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Bienvenido a Cofianza',
      html: buildWelcomeHtml(nombre, to, tempPassword, loginUrl),
    });

    logger.info({ to }, 'Email de bienvenida enviado');
  } catch (error) {
    logger.error({ to, error }, 'Error al enviar email de bienvenida');
    throw error;
  }
}

function buildWelcomeHtml(nombre: string, email: string, tempPassword: string, loginUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bienvenido</title>
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
                    <span style="font-size: 20px; font-weight: 600; color: #0f766e;">Cofianza</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #111827;">
                Bienvenido, ${nombre}
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Se ha creado tu cuenta en Cofianza. A continuación encontrarás tus credenciales de acceso:
              </p>

              <!-- Credentials box -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px; background-color: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">Correo electrónico:</p>
                    <p style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #111827;">${email}</p>
                    <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">Contraseña temporal:</p>
                    <p style="margin: 0; font-size: 18px; font-weight: 700; color: #0f766e; letter-spacing: 1px; font-family: monospace;">${tempPassword}</p>
                  </td>
                </tr>
              </table>

              <!-- Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <a href="${loginUrl}" target="_blank" style="display: inline-block; background-color: #0d9488; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px;">
                      Iniciar sesión
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #ef4444; font-weight: 500;">
                Por seguridad, te recomendamos cambiar tu contraseña después de iniciar sesión por primera vez.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 32px;">
              <p style="margin: 0; font-size: 13px; color: #9ca3af;">
                © ${new Date().getFullYear()} Cofianza. Todos los derechos reservados.
              </p>
              <p style="margin: 8px 0 0; font-size: 12px; color: #d1d5db;">
                Este es un correo automático, por favor no respondas a este mensaje.
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

export async function sendVerificationEmail(to: string, nombre: string, verifyUrl: string): Promise<void> {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Verifica tu correo - Cofianza',
      html: buildVerificationHtml(nombre, verifyUrl),
    });

    logger.info({ to }, 'Email de verificacion enviado');
  } catch (error) {
    logger.error({ to, error }, 'Error al enviar email de verificacion');
    throw error;
  }
}

function buildVerificationHtml(nombre: string, verifyUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verifica tu correo</title>
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
                    <span style="font-size: 20px; font-weight: 600; color: #0f766e;">Cofianza</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #111827;">
                Verifica tu correo electronico
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Hola ${nombre}, gracias por registrarte en Cofianza. Para completar tu registro, verifica tu correo electronico haciendo clic en el siguiente boton:
              </p>

              <!-- Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <a href="${verifyUrl}" target="_blank" style="display: inline-block; background-color: #0d9488; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px;">
                      Verificar correo
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #6b7280;">
                Este enlace expirara en <strong>24 horas</strong>. Una vez verificado tu correo, un administrador activara tu cuenta.
              </p>

              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #9ca3af;">
                Si el boton no funciona, copia y pega este enlace en tu navegador:
              </p>
              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: #0d9488; word-break: break-all;">
                ${verifyUrl}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 32px;">
              <p style="margin: 0; font-size: 13px; color: #9ca3af;">
                &copy; ${new Date().getFullYear()} Cofianza. Todos los derechos reservados.
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

export async function sendEstudioFormEmail(
  to: string,
  nombre: string,
  formUrl: string,
  expiryHours: number,
): Promise<void> {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Completa tu estudio de riesgo crediticio - Cofianza',
      html: buildEstudioFormHtml(nombre, formUrl, expiryHours),
    });

    logger.info({ to }, 'Email de formulario de estudio enviado');
  } catch (error) {
    logger.error({ to, error }, 'Error al enviar email de formulario de estudio');
    throw error;
  }
}

function buildEstudioFormHtml(nombre: string, formUrl: string, expiryHours: number): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Estudio de Riesgo Crediticio</title>
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
                    <span style="font-size: 20px; font-weight: 600; color: #0f766e;">Cofianza</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #111827;">
                Estudio de Riesgo Crediticio
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Hola ${nombre}, como parte del proceso de arrendamiento necesitamos que completes un formulario con tu informacion personal para realizar el estudio de riesgo crediticio.
              </p>

              <!-- Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <a href="${formUrl}" target="_blank" style="display: inline-block; background-color: #0d9488; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px;">
                      Completar formulario
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #6b7280;">
                Este enlace expirara en <strong>${expiryHours} horas</strong>. Si necesitas un nuevo enlace, contacta a tu agente inmobiliario.
              </p>

              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #9ca3af;">
                Si el boton no funciona, copia y pega este enlace en tu navegador:
              </p>
              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: #0d9488; word-break: break-all;">
                ${formUrl}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 32px;">
              <p style="margin: 0; font-size: 13px; color: #9ca3af;">
                &copy; ${new Date().getFullYear()} Cofianza. Todos los derechos reservados.
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

export async function sendAutorizacionEmail(
  to: string,
  nombre: string,
  autorizacionUrl: string,
  expiryHours: number,
): Promise<void> {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Autorización consulta centrales de riesgo - Cofianza',
      html: buildAutorizacionHtml(nombre, autorizacionUrl, expiryHours),
    });

    logger.info({ to }, 'Email de autorizacion habeas data enviado');
  } catch (error) {
    logger.error({ to, error }, 'Error al enviar email de autorizacion');
    throw error;
  }
}

export async function sendOtpEmail(to: string, nombre: string, codigo: string): Promise<void> {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Código de verificación - Cofianza',
      html: buildOtpHtml(nombre, codigo),
    });

    logger.info({ to }, 'Email de codigo OTP enviado');
  } catch (error) {
    logger.error({ to, error }, 'Error al enviar email de OTP');
    throw error;
  }
}

function buildAutorizacionHtml(nombre: string, autorizacionUrl: string, expiryHours: number): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autorización Habeas Data</title>
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
                    <span style="font-size: 20px; font-weight: 600; color: #0f766e;">Cofianza</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #111827;">
                Autorización de consulta en centrales de riesgo
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Hola ${nombre}, como parte del proceso de arrendamiento necesitamos tu autorización para consultar tu información en centrales de riesgo crediticio (Ley 1581/2012 y Ley 1266/2008).
              </p>

              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Haz clic en el siguiente botón para revisar y firmar la autorización:
              </p>

              <!-- Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <a href="${autorizacionUrl}" target="_blank" style="display: inline-block; background-color: #0d9488; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px;">
                      Firmar autorización
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #6b7280;">
                Este enlace expirará en <strong>${expiryHours} horas</strong>. Si necesitas un nuevo enlace, contacta a tu agente inmobiliario.
              </p>

              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #9ca3af;">
                Si el botón no funciona, copia y pega este enlace en tu navegador:
              </p>
              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: #0d9488; word-break: break-all;">
                ${autorizacionUrl}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 32px;">
              <p style="margin: 0; font-size: 13px; color: #9ca3af;">
                &copy; ${new Date().getFullYear()} Cofianza. Todos los derechos reservados.
              </p>
              <p style="margin: 8px 0 0; font-size: 12px; color: #d1d5db;">
                Este es un correo automático, por favor no respondas a este mensaje.
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

function buildOtpHtml(nombre: string, codigo: string): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Código de verificación</title>
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
                    <span style="font-size: 20px; font-weight: 600; color: #0f766e;">Cofianza</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #111827;">
                Código de verificación
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Hola ${nombre}, tu código de verificación para el proceso de firma electrónica es:
              </p>

              <!-- Code box -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <div style="display: inline-block; background-color: #f0fdfa; border: 2px solid #99f6e4; border-radius: 12px; padding: 20px 40px;">
                      <span style="font-size: 36px; font-weight: 700; color: #0f766e; letter-spacing: 8px; font-family: monospace;">${codigo}</span>
                    </div>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #ef4444; font-weight: 500;">
                Este código expira en 10 minutos. No compartas este código con nadie.
              </p>

              <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #6b7280;">
                Si no solicitaste este código, puedes ignorar este mensaje.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 32px;">
              <p style="margin: 0; font-size: 13px; color: #9ca3af;">
                &copy; ${new Date().getFullYear()} Cofianza. Todos los derechos reservados.
              </p>
              <p style="margin: 8px 0 0; font-size: 12px; color: #d1d5db;">
                Este es un correo automático, por favor no respondas a este mensaje.
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

export async function sendFirmaEmail(
  to: string,
  nombre: string,
  firmaUrl: string,
  expiryHours: number,
  context: { direccion_inmueble: string; ciudad_inmueble: string; nombre_arrendatario: string },
): Promise<void> {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Firma de contrato de arrendamiento - Cofianza',
      html: buildFirmaHtml(nombre, firmaUrl, expiryHours, context),
    });

    logger.info({ to }, 'Email de firma de contrato enviado');
  } catch (error) {
    logger.error({ to, error }, 'Error al enviar email de firma');
    throw error;
  }
}

function buildFirmaHtml(
  nombre: string,
  firmaUrl: string,
  expiryHours: number,
  context: { direccion_inmueble: string; ciudad_inmueble: string; nombre_arrendatario: string },
): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Firma de contrato</title>
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
                    <span style="font-size: 20px; font-weight: 600; color: #0f766e;">Cofianza</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #111827;">
                Firma de contrato de arrendamiento
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Hola ${nombre}, tienes un contrato de arrendamiento pendiente de firma. Haz clic en el siguiente botón para revisar y firmar el documento.
              </p>

              <!-- Contract info -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px; background-color: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">Inmueble:</p>
                    <p style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #111827;">${context.direccion_inmueble}${context.ciudad_inmueble ? `, ${context.ciudad_inmueble}` : ''}</p>
                    <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">Arrendatario:</p>
                    <p style="margin: 0; font-size: 16px; font-weight: 600; color: #111827;">${context.nombre_arrendatario}</p>
                  </td>
                </tr>
              </table>

              <!-- Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <a href="${firmaUrl}" target="_blank" style="display: inline-block; background-color: #0d9488; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px;">
                      Firmar contrato
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #6b7280;">
                Este enlace expirará en <strong>${expiryHours} horas</strong>. Si necesitas un nuevo enlace, contacta a tu agente inmobiliario.
              </p>

              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #9ca3af;">
                Si el botón no funciona, copia y pega este enlace en tu navegador:
              </p>
              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: #0d9488; word-break: break-all;">
                ${firmaUrl}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 32px;">
              <p style="margin: 0; font-size: 13px; color: #9ca3af;">
                &copy; ${new Date().getFullYear()} Cofianza. Todos los derechos reservados.
              </p>
              <p style="margin: 8px 0 0; font-size: 12px; color: #d1d5db;">
                Este es un correo automático, por favor no respondas a este mensaje.
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

export async function sendPaymentLinkEmail(
  to: string,
  nombre: string,
  paymentUrl: string,
  context: { concepto: string; monto: string; expediente_numero: string },
): Promise<void> {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `Link de pago - ${context.concepto} - Cofianza`,
      html: buildPaymentLinkHtml(nombre, paymentUrl, context),
    });

    logger.info({ to, concepto: context.concepto }, 'Email de link de pago enviado');
  } catch (error) {
    logger.error({ to, error }, 'Error al enviar email de link de pago');
    throw error;
  }
}

function buildPaymentLinkHtml(
  nombre: string,
  paymentUrl: string,
  context: { concepto: string; monto: string; expediente_numero: string },
): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link de pago</title>
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
                    <span style="font-size: 20px; font-weight: 600; color: #0f766e;">Cofianza</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #111827;">
                Link de pago
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Hola ${nombre}, tienes un pago pendiente asociado a tu proceso de arrendamiento. A continuacion encontraras los detalles:
              </p>

              <!-- Payment details box -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px; background-color: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">Concepto:</p>
                    <p style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #111827;">${context.concepto}</p>
                    <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">Monto:</p>
                    <p style="margin: 0 0 16px; font-size: 22px; font-weight: 700; color: #0f766e;">${context.monto}</p>
                    <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">Expediente:</p>
                    <p style="margin: 0; font-size: 16px; font-weight: 600; color: #111827;">${context.expediente_numero}</p>
                  </td>
                </tr>
              </table>

              <!-- Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <a href="${paymentUrl}" target="_blank" style="display: inline-block; background-color: #0d9488; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px;">
                      Realizar pago
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #6b7280;">
                Este link de pago expirara en <strong>48 horas</strong>. Si necesitas un nuevo link, contacta a tu agente inmobiliario.
              </p>

              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #9ca3af;">
                Si el boton no funciona, copia y pega este enlace en tu navegador:
              </p>
              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: #0d9488; word-break: break-all;">
                ${paymentUrl}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 32px;">
              <p style="margin: 0; font-size: 13px; color: #9ca3af;">
                &copy; ${new Date().getFullYear()} Cofianza. Todos los derechos reservados.
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

function buildPasswordResetHtml(resetUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Recuperar contraseña</title>
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
                    <span style="font-size: 20px; font-weight: 600; color: #0f766e;">Cofianza</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #111827;">
                Recupera tu contraseña
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Recibimos una solicitud para restablecer la contraseña de tu cuenta. Haz clic en el siguiente botón para crear una nueva contraseña:
              </p>

              <!-- Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <a href="${resetUrl}" target="_blank" style="display: inline-block; background-color: #0d9488; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px;">
                      Restablecer contraseña
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #6b7280;">
                Este enlace expirará en <strong>1 hora</strong>. Si no solicitaste un cambio de contraseña, puedes ignorar este correo de forma segura.
              </p>

              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #9ca3af;">
                Si el botón no funciona, copia y pega este enlace en tu navegador:
              </p>
              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: #0d9488; word-break: break-all;">
                ${resetUrl}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 32px;">
              <p style="margin: 0; font-size: 13px; color: #9ca3af;">
                © ${new Date().getFullYear()} Cofianza. Todos los derechos reservados.
              </p>
              <p style="margin: 8px 0 0; font-size: 12px; color: #d1d5db;">
                Este es un correo automático, por favor no respondas a este mensaje.
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

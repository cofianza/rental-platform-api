import { Resend } from 'resend';
import { env } from '@/config';
import { logger } from '@/lib/logger';

const resend = new Resend(env.RESEND_API_KEY);

const FROM_EMAIL = `Habitar Propiedades <${env.RESEND_FROM_EMAIL}>`;

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Recupera tu contraseña - Habitar Propiedades',
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
      subject: 'Bienvenido a Habitar Propiedades',
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
                Bienvenido, ${nombre}
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Se ha creado tu cuenta en Habitar Propiedades. A continuación encontrarás tus credenciales de acceso:
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
                © ${new Date().getFullYear()} Habitar Propiedades. Todos los derechos reservados.
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
      subject: 'Verifica tu correo - Habitar Propiedades',
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
                Verifica tu correo electronico
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Hola ${nombre}, gracias por registrarte en Habitar Propiedades. Para completar tu registro, verifica tu correo electronico haciendo clic en el siguiente boton:
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
      subject: 'Completa tu estudio de riesgo crediticio - Habitar Propiedades',
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
                © ${new Date().getFullYear()} Habitar Propiedades. Todos los derechos reservados.
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

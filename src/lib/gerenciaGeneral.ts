/**
 * Gerencia General (Adenda 1 del módulo de contratos, respuesta 17). La
 * plataforma no tiene ese rol: es un administrador con el correo en
 * GERENCIA_GENERAL_EMAILS. Con la lista vacía, cualquier administrador (lo de
 * antes de la Adenda) y ninguna cuenta queda protegida.
 */

import { env } from '@/config';
import { AppError } from '@/lib/errors';

/** El correo está en la lista (la lista ya viene en minúsculas y sin espacios). */
export const esCorreoDeGerencia = (email: string | null | undefined): boolean =>
  !!email && env.GERENCIA_GENERAL_EMAILS.includes(email.trim().toLowerCase());

export const esGerenciaGeneral = (u: { rol: string; email: string }): boolean =>
  u.rol === 'administrador' && (env.GERENCIA_GENERAL_EMAILS.length === 0 || esCorreoDeGerencia(u.email));

/**
 * Una cuenta de la Gerencia General solo la gestiona la Gerencia: si otro
 * administrador pudiera crearla, restablecerle la contraseña, cambiarle el rol,
 * desactivarla o borrarla, se quedaría con ella y se saltaría el 403 de los
 * parámetros de riesgo.
 */
export function assertCuentaDeGerencia(
  emailObjetivo: string | null | undefined,
  solicitante: { rol: string; email: string },
  accion: string,
): void {
  if (esCorreoDeGerencia(emailObjetivo) && !esGerenciaGeneral(solicitante))
    throw AppError.forbidden(
      `Esta cuenta es de la Gerencia General: solo la Gerencia General puede ${accion}.`,
      'CUENTA_GERENCIA_GENERAL',
    );
}

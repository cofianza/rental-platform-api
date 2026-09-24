import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '@/config';

// Direcciones loopback (mismo host). En desarrollo local TODO el tráfico sale
// de 127.0.0.1/::1, compartiendo un único cupo por IP.
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// El límite global por IP es una protección anti-abuso pensada para tráfico
// REAL de producción (muchas IPs distintas). NO debe aplicar a entornos
// no-producción NI a peticiones locales/loopback: en local el dashboard hace
// fan-out de muchas peticiones por página de detalle y, sumado a StrictMode +
// Fast Refresh, agota el cupo y devuelve 429 espurios (peor aún si el
// .env.local quedó con NODE_ENV=production). Un atacante real nunca llega por
// loopback (detrás del proxy de Railway trae su IP real vía X-Forwarded-For con
// trust proxy=1), así que saltarse loopback no debilita la protección.
function skipRateLimit(req: Request): boolean {
  if (env.NODE_ENV !== 'production') return true;
  return LOOPBACK_IPS.has(req.ip ?? '');
}

// Límite global por IP/min. Configurable por RATE_LIMIT_MAX (default 300):
// el dashboard hace fan-out de muchas peticiones por página de detalle, así
// que 100 se agotaba con uso normal. Los límites estrictos de abajo (auth,
// OTP, registro) NO dependen de esto.
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.RATE_LIMIT_MAX,
  skip: skipRateLimit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Demasiadas solicitudes desde tu red. Espera un minuto e inténtalo de nuevo.',
  },
});

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Demasiados intentos de ingreso. Espera un minuto e inténtalo de nuevo.',
  },
});

export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Demasiados registros desde tu red. Inténtalo de nuevo en una hora.',
  },
});

export const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Ya te enviamos varios correos de verificación. Revisa tu bandeja de entrada (y el spam) o inténtalo de nuevo en una hora.',
  },
});

export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = (req.body as { email?: string })?.email;
    return email ? email.toLowerCase() : (req.ip ?? 'unknown');
  },
  validate: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Ya pediste varios enlaces para restablecer la contraseña. Revisa tu correo (y el spam) o inténtalo de nuevo en una hora.',
  },
});

/**
 * «Me interesa» de la vitrina (sin cuenta): cada envío dispara WhatsApp y
 * correos. Por IP y sumando inmuebles (una oficina o un celular comparten IP);
 * solo cuentan los envíos válidos. El freno fino es el de 24 h por correo o
 * WhatsApp e inmueble, en el servicio.
 */
export const interesLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  skipFailedRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Ya registraste varios intereses desde tu red. Inténtalo de nuevo en una hora.',
  },
});

/**
 * Invitar (o reenviar la invitación) al equipo: máx 20 por hora por usuario.
 * Cada una sale como un correo de Cofianza a cualquier dirección, y responde si
 * ese correo ya tiene una cuenta que no es de inmobiliaria.
 */
export const invitarMiembroLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
  validate: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Enviaste muchas invitaciones en poco tiempo. Inténtalo de nuevo en una hora.',
  },
});

export const publicFormLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Demasiadas solicitudes desde tu red. Espera un minuto e inténtalo de nuevo.',
  },
});

// ── Limiters POR TOKEN para el flujo público de autorización (habeas data) ──
// El brute-force del OTP no se frena con límites por IP (un atacante rota IPs),
// así que estos limitan por el token de la URL (clave = req.params.token), que
// identifica una autorización concreta. Defensa principal contra adivinación
// del OTP de 6 dígitos; se combinan con publicFormLimiter (capa por IP).
// validate:false porque usamos keyGenerator propio (mismo patrón que passwordResetLimiter).

/** Solicitud de OTP: máx 5 por 15 min para un mismo enlace de autorización. */
export const otpSendByTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => (req.params as { token?: string })?.token ?? req.ip ?? 'unknown',
  validate: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Demasiadas solicitudes de código para este enlace. Inténtalo más tarde.',
  },
});

/**
 * Invitar al co-arrendatario desde el enlace del prospecto (P18): máx 3 por día
 * para un mismo enlace. Cada intento manda correo y WhatsApp a un tercero, y
 * los fallidos cuentan: así no se tantea el documento del titular.
 */
export const invitacionPorTokenLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => (req.params as { token?: string })?.token ?? req.ip ?? 'unknown',
  validate: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Ya enviaste varias invitaciones desde este enlace. Inténtalo de nuevo mañana.',
  },
});

/** Verificación de OTP: máx 8 por 15 min para un mismo enlace (anti fuerza bruta). */
export const otpVerifyByTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => (req.params as { token?: string })?.token ?? req.ip ?? 'unknown',
  validate: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Demasiados intentos de verificación para este enlace. Solicita un código nuevo.',
  },
});

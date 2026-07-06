import rateLimit from 'express-rate-limit';
import { env } from '@/config';

// Límite global por IP/min. Configurable por RATE_LIMIT_MAX (default 300):
// el dashboard hace fan-out de muchas peticiones por página de detalle, así
// que 100 se agotaba con uso normal. Los límites estrictos de abajo (auth,
// OTP, registro) NO dependen de esto.
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please try again later',
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
    message: 'Too many authentication attempts, please try again later',
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
    message: 'Too many registration attempts, please try again later',
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
    message: 'Too many verification email requests, please try again later',
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
    message: 'Too many password reset requests, please try again later',
  },
});

export const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Demasiadas solicitudes de OTP, por favor intenta mas tarde',
  },
});

export const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    errorCode: 'RATE_LIMIT_EXCEEDED',
    message: 'Demasiados intentos de verificacion, por favor intenta mas tarde',
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
    message: 'Too many requests, please try again later',
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
    message: 'Demasiadas solicitudes de codigo para este enlace, intenta mas tarde',
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
    message: 'Demasiados intentos de verificacion para este enlace, solicita un codigo nuevo',
  },
});

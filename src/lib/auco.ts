/**
 * Auco.ai API Client — Electronic Signature Provider
 *
 * API docs: https://docs.auco.ai/en/api/intro
 * Environments:
 *   Stage: https://dev.auco.ai/v1.5/ext
 *   Prod:  https://api.auco.ai/v1.5/ext
 */

import { env } from '@/config';
import { logger } from '@/lib/logger';

// ============================================================
// Types
// ============================================================

/**
 * Bloque de validaciones de identidad. Puede ir a nivel raiz (globales) o
 * dentro de cada signProfile (individuales — sobreescriben las globales).
 *
 * Reglas (https://docs.auco.ai/api/manager/validations):
 *   - Si declaras `options` debes activar tambien `camera` u `otpCode`
 *     boolean en el mismo nivel — sin eso el proceso es invalido.
 *   - `options.video=true` requiere `options.whatsapp=true`.
 *   - `options.camera='identification'` exige tambien identification +
 *     identificationType + country en el firmante.
 */
export interface AucoValidationOptions {
  /** 'identification' = cotejo biometrico contra ID. 'photo' = solo selfie. */
  camera?: 'identification' | 'photo';
  /** Por donde llega el OTP. */
  otpCode?: 'phone' | 'email';
  /** Flow del firmante por WhatsApp (en lugar de email). */
  whatsapp?: boolean;
  /** Notifica via WhatsApp Y email simultaneamente. Requiere whatsapp=true. */
  both?: boolean;
  /** Validacion por video (solo cuando whatsapp=true). */
  video?: boolean;
  /** Pedir tambien la parte posterior del documento (solo WhatsApp). */
  identificationCardback?: boolean;
  /** Validacion via WhatsApp Flow (solo WhatsApp + camera). */
  flow?: boolean;
}

interface AucoSignProfile {
  name: string;
  email: string;
  phone?: string;
  role?: 'SIGNER' | 'APPROVER';
  order?: string;
  /** Identificacion del firmante (necesaria para camera=identification). */
  identification?: string;
  identificationType?: string;
  country?: string;
  /** Validaciones individuales — tienen prioridad sobre las globales. */
  camera?: boolean;
  otpCode?: boolean;
  options?: AucoValidationOptions;
}

interface AucoUploadDocumentInput {
  /** Creator's email (admin/operator sending the request) */
  email: string;
  /** Process name for tracking */
  name: string;
  /** Email subject line sent to signers */
  subject: string;
  /** Email body message */
  message: string;
  /** PDF file as Base64 string */
  file: string;
  /** Signer details */
  signProfile: AucoSignProfile[];
  /** Require OTP code (boolean global). Si declaras `options` global con
   *  algun campo, este flag debe ir true para activar la validacion. */
  otpCode?: boolean;
  /** Pedir foto del firmante (boolean global). Mismo principio que otpCode. */
  camera?: boolean;
  /** Expiration date ISO string */
  expiredDate?: string;
  /** Reminder interval in hours (multiples of 3) */
  remember?: number;
  /** Webhook IDs to receive notifications */
  webhooks?: string[];
  /** Validaciones globales — aplican a todos los firmantes salvo override. */
  options?: AucoValidationOptions;
}

interface AucoUploadResponse {
  document: string; // Document code for tracking
}

export type AucoDocumentStatus =
  | 'CREATED'
  | 'FINISH'
  | 'REJECTED'
  | 'EXPIRED';

export type AucoSignerStatus =
  | 'NOTIFICATION'
  | 'FINISH'
  | 'REJECT'
  | 'BLOCK'
  | 'PENDING';

interface AucoSignerInfo {
  id: string;
  name: string;
  email: string;
  status: AucoSignerStatus;
}

export interface AucoDocumentInfo {
  url: string;
  name: string;
  code: string;
  status: AucoDocumentStatus;
  signProfile: AucoSignerInfo[];
}

export interface AucoWebhookPayload {
  code: string;
  name: string;
  status: string;
  url?: string;
  signer?: {
    id: string;
    name: string;
    email: string;
    phone: string;
  };
  message?: string;
  tags?: string[];
  custom?: string[];
}

// ============================================================
// Helper
// ============================================================

async function aucoRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  usePrivateKey = false,
): Promise<T> {
  const url = `${env.AUCO_API_URL}${path}`;
  const key = usePrivateKey ? env.AUCO_PRIVATE_KEY : env.AUCO_PUBLIC_KEY;

  const headers: Record<string, string> = {
    Authorization: key,
    'Content-Type': 'application/json',
  };

  const options: RequestInit = { method, headers };
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  logger.debug({ method, path }, 'Auco API request');

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error');
    logger.error(
      { status: response.status, body: errorBody, method, path },
      'Auco API error',
    );
    throw new Error(`Auco API error (${response.status}): ${errorBody}`);
  }

  return response.json() as Promise<T>;
}

// ============================================================
// API Methods
// ============================================================

/**
 * Upload a PDF document for electronic signature.
 * Returns the Auco document code for tracking.
 *
 * El caller construye el payload siguiendo las reglas de Auco:
 * https://docs.auco.ai/api/manager/validations
 *
 * Resumen rapido:
 *   - Para flow por email: otpCode:true + options:{otpCode:'email'}
 *   - Para flow por WhatsApp: pone individuales en signProfile[i] con
 *     {phone, otpCode:true, options:{whatsapp:true, otpCode:'phone'}}
 *   - Si declaras options sin activar tambien camera u otpCode boolean
 *     en el mismo nivel, Auco rechaza con 400.
 */
export async function uploadDocumentForSignature(
  input: AucoUploadDocumentInput,
): Promise<string> {
  const result = await aucoRequest<AucoUploadResponse>(
    'POST',
    '/document/upload',
    input,
    true, // private key for write operations
  );

  logger.info(
    { documentCode: result.document, name: input.name },
    'Document uploaded to Auco for signature',
  );

  return result.document;
}

/**
 * Query the status and details of a document by its code.
 */
export async function getDocumentStatus(
  code: string,
): Promise<AucoDocumentInfo> {
  return aucoRequest<AucoDocumentInfo>(
    'GET',
    `/document?code=${encodeURIComponent(code)}`,
    undefined,
    false, // public key for read operations
  );
}

/**
 * Send a signature reminder for a document.
 */
export async function sendReminder(code: string): Promise<void> {
  await aucoRequest(
    'POST',
    '/document/reminder',
    { code },
    true,
  );
  logger.info({ code }, 'Auco signature reminder sent');
}

/**
 * Cancel a signing process in Auco.
 */
export async function cancelDocument(code: string): Promise<void> {
  await aucoRequest(
    'POST',
    '/document/cancel',
    { documents: [code] },
    true,
  );
  logger.info({ code }, 'Auco document cancelled');
}

/**
 * Register a webhook endpoint in Auco.
 * Must be called once during setup to create the "default" webhook.
 */
export async function registerWebhook(
  webhookUrl: string,
  headerKey?: string,
  headerValue?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    id: 'default',
    description: 'Cofianza webhook for firma notifications',
    url: webhookUrl,
  };

  if (headerKey && headerValue) {
    body.header = { key: headerKey, value: headerValue };
  }

  await aucoRequest('PUT', '/company', body, true);
  logger.info({ url: webhookUrl }, 'Auco webhook registered');
}

/**
 * Helper: Convert a Buffer to Base64 string for Auco upload.
 */
export function bufferToBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

/**
 * Normaliza un teléfono a formato internacional que Auco espera (+57XXXXXXXXXX).
 * Si ya viene con prefijo + o 00, respeta. Si son 10 dígitos colombianos sin
 * prefijo, añade +57. Si el número es demasiado corto o contiene caracteres
 * raros sin poder normalizarse, devuelve null para que el caller decida.
 */
export function normalizePhoneToInternational(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\s+/g, '').replace(/[()\-.]/g, '');
  if (!trimmed) return null;
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
    return null;
  }
  if (trimmed.startsWith('00')) {
    const digits = trimmed.slice(2).replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
    return null;
  }
  const digits = trimmed.replace(/\D/g, '');
  // Colombia: 10 dígitos → +57. 12 dígitos empezando por 57 → asumimos CC incluido.
  if (digits.length === 10) return `+57${digits}`;
  if (digits.length === 12 && digits.startsWith('57')) return `+${digits}`;
  return null;
}

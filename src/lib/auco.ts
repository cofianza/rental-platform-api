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

interface AucoSignProfile {
  name: string;
  email: string;
  phone: string;
  role?: 'SIGNER' | 'APPROVER';
  order?: string;
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
  /** Require OTP code for identity validation */
  otpCode?: boolean;
  /** Expiration date ISO string */
  expiredDate?: string;
  /** Reminder interval in hours (multiples of 3) */
  remember?: number;
  /** Webhook IDs to receive notifications */
  webhooks?: string[];
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
    description: 'Habitar Propiedades webhook for firma notifications',
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

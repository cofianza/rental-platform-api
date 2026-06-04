import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),

  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  FRONTEND_URL: z.url().default('http://localhost:3000'),

  RESEND_API_KEY: z.string().min(1),
  // El dominio del remitente debe estar verificado en Resend antes de enviar.
  // Setear RESEND_FROM_EMAIL en Railway con el dominio cofianza.co cuando este
  // verificado. El default solo aplica en dev local.
  RESEND_FROM_EMAIL: z.string().min(1).default('hola@cofianza.co'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Auco.ai (electronic signature provider)
  AUCO_API_URL: z.string().url().default('https://dev.auco.ai/v1.5/ext'),
  AUCO_PUBLIC_KEY: z.string().default('puk_placeholder'),
  AUCO_PRIVATE_KEY: z.string().default('prk_placeholder'),
  AUCO_WEBHOOK_SECRET: z.string().optional(),
  // Email del Manager registrado en la cuenta Auco. Auco rechaza el upload
  // con USER_NOTFOUND si este email no esta enrolled. Sin default — debe venir
  // del .env real (ver Stage panel: Settings → Team).
  AUCO_SENDER_EMAIL: z.string().email().min(1),

  // Payment gateway (Stripe)
  PAYMENT_GATEWAY_PROVIDER: z.enum(['stripe']).default('stripe'),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),

  // Credit risk providers
  CREDIT_PROVIDER_USE_MOCK: z.string().default('true').transform((v) => v === 'true'),

  // TransUnion Colombia (Basic Auth — Combo CreditVision + Info Comercial 1901)
  TRANSUNION_API_URL: z.string().url().default('https://tucoapplicationserviceuat.transunion.co/ws/v1/rest/consultarCombo'),
  TRANSUNION_USERNAME: z.string().optional(),
  TRANSUNION_PASSWORD: z.string().optional(),
  TRANSUNION_POLICY_ID: z.string().default('3176'),
  TRANSUNION_CONSULTA_MOTIVO: z.string().default('22'),

  // SIFIN
  SIFIN_API_URL: z.string().url().optional(),
  SIFIN_API_KEY: z.string().optional(),

  // DataCredito
  DATACREDITO_API_URL: z.string().url().optional(),
  DATACREDITO_API_KEY: z.string().optional(),

  // Factus — facturación electrónica DIAN (Colombia)
  // OAuth2 password grant. Token expira en 600s, refresh disponible.
  FACTUS_API_URL: z.string().url().default('https://api-sandbox.factus.com.co'),
  FACTUS_CLIENT_ID: z.string().optional(),
  FACTUS_CLIENT_SECRET: z.string().optional(),
  FACTUS_USERNAME: z.string().optional(),
  FACTUS_PASSWORD: z.string().optional(),

  // WhatsApp (Meta Business Cloud) — envío directo de plantillas aprobadas
  // (link de autorización, OTP, notificaciones). Mientras WHATSAPP_PROVIDER no
  // sea 'meta' se usa el provider mock que sólo loguea (no envía nada real).
  WHATSAPP_PROVIDER: z.enum(['meta', 'mock']).default('mock'),
  WHATSAPP_META_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_META_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_META_API_VERSION: z.string().default('v21.0'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

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
  RESEND_FROM_EMAIL: z.string().min(1).default('hola@knowmeapp.com'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Auco.ai (electronic signature provider)
  AUCO_API_URL: z.string().url().default('https://dev.auco.ai/v1.5/ext'),
  AUCO_PUBLIC_KEY: z.string().default('puk_placeholder'),
  AUCO_PRIVATE_KEY: z.string().default('prk_placeholder'),
  AUCO_WEBHOOK_SECRET: z.string().optional(),
  AUCO_SENDER_EMAIL: z.string().default('hola@knowmeapp.com'),

  // Payment gateway (Stripe)
  PAYMENT_GATEWAY_PROVIDER: z.enum(['stripe']).default('stripe'),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),

  // Credit risk providers
  CREDIT_PROVIDER_USE_MOCK: z.string().default('true').transform((v) => v === 'true'),
  TRANSUNION_API_URL: z.string().url().optional(),
  TRANSUNION_API_KEY: z.string().optional(),
  SIFIN_API_URL: z.string().url().optional(),
  SIFIN_API_KEY: z.string().optional(),
  DATACREDITO_API_URL: z.string().url().optional(),
  DATACREDITO_API_KEY: z.string().optional(),
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

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

  // Payment gateway — seleccionable. Stripe NO opera en Colombia (solo vía
  // entidad US), así que producción CO usa Mercado Pago. Las llaves de cada
  // proveedor son opcionales a nivel schema; el adapter activo valida las suyas
  // al construirse (así un deploy con un solo proveedor no truena por el otro).
  PAYMENT_GATEWAY_PROVIDER: z.enum(['stripe', 'mercadopago']).default('stripe'),
  // URL pública del API (para el notification_url de los webhooks salientes,
  // p.ej. el de Mercado Pago). Si no se setea, se configura en el panel de MP.
  API_PUBLIC_URL: z.string().url().optional(),

  // Stripe (solo test/dev en Colombia)
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_PUBLISHABLE_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),

  // Mercado Pago (producción Colombia — Checkout Pro)
  MERCADOPAGO_ACCESS_TOKEN: z.string().default(''),
  MERCADOPAGO_PUBLIC_KEY: z.string().default(''),
  // Secreto de firma del webhook (panel MP → Webhooks → clave secreta).
  MERCADOPAGO_WEBHOOK_SECRET: z.string().default(''),

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

  // Job de vencimiento de contratos: finaliza automáticamente los contratos
  // 'vigente' cuya fecha_fin ya pasó (y libera el inmueble). Activado por
  // defecto; setear a 'false' para desactivarlo (p.ej. si se prefiere manual).
  // Concurrencia: la operación es segura ante múltiples instancias (el RPC usa
  // FOR UPDATE + guard estado='vigente'; no hay doble historial ni doble
  // liberación), pero si se escala horizontalmente conviene dejarlo en 'true'
  // en UNA sola instancia para evitar trabajo redundante.
  CONTRATO_VENCIMIENTO_JOB_ENABLED: z.string().default('true').transform((v) => v === 'true'),

  // Firma multi-parte (arrendatario + arrendador + Cofianza) en un solo sobre Auco.
  // OFF por defecto: mientras siga en false, la firma usa el flujo de un solo
  // firmante (arrendatario). Activar solo cuando estén listos los teléfonos
  // reales de cada parte y los datos de Cofianza (company.ts: nit/phone).
  FIRMA_MULTIPARTE_ENABLED: z.string().default('false').transform((v) => v === 'true'),
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

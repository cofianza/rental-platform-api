# Architecture Decision Records (ADR)

## Habitar Propiedades 2.0

---

## ADR-001: Next.js 16 como framework frontend

**Estado:** Aceptado
**Fecha:** 2026-02-04

**Contexto:** Se necesita un framework React moderno para el frontend que soporte SSR, routing basado en archivos y buen rendimiento.

**Decisión:** Next.js 16 con App Router.

**Justificación:**
- App Router permite Server Components para reducir JavaScript del cliente
- Route groups `(auth)` y `(dashboard)` separan layouts públicos y privados
- Despliegue nativo en Vercel con zero-config
- Soporte de React 19 con Server Actions
- Comunidad grande y ecosistema maduro

**Alternativas consideradas:**
- Remix: Buen framework pero menos ecosistema y soporte en Vercel
- Vite + React Router: Más ligero pero sin SSR out-of-the-box

---

## ADR-002: Express 5 como framework backend

**Estado:** Aceptado
**Fecha:** 2026-02-04

**Contexto:** Se necesita un backend API REST en Node.js con TypeScript.

**Decisión:** Express 5 con TypeScript.

**Justificación:**
- Express 5 es la versión estable actual con soporte nativo de async/await
- Ecosistema de middleware más grande de Node.js
- Patrón MVC bien conocido por el equipo
- Compatible con cualquier proveedor de hosting (Railway, Render, etc.)

**Alternativas consideradas:**
- NestJS: Más estructura pero curva de aprendizaje alta para equipo pequeño
- Fastify: Más rápido en benchmarks pero menos middleware disponible
- Hono: Muy ligero pero ecosistema pequeño

---

## ADR-003: Supabase como plataforma backend-as-a-service

**Estado:** Aceptado
**Fecha:** 2026-02-04

**Contexto:** Se necesita base de datos PostgreSQL, almacenamiento de archivos y autenticación.

**Decisión:** Supabase para DB (PostgreSQL), Storage (archivos) y Auth (autenticación).

**Justificación:**
- Una sola plataforma para tres necesidades (reduce complejidad operativa)
- PostgreSQL gestionado sin necesidad de administrar servidores de DB
- Supabase Storage soporta URLs firmadas para upload/download seguro
- Supabase Auth incluye login/registro, JWT, refresh tokens, recuperación de contraseña
- Tier gratuito generoso para desarrollo y staging
- Dashboard web para administrar datos durante desarrollo

**Alternativas consideradas:**
- Prisma + AWS RDS + S3: Más control pero más complejidad y costo
- PlanetScale + Cloudflare R2: PlanetScale no soporta PostgreSQL (usa MySQL)
- Firebase: No usa PostgreSQL, vendor lock-in con Google

---

## ADR-004: Supabase JS Client en vez de Prisma ORM

**Estado:** Aceptado
**Fecha:** 2026-02-16

**Contexto:** Con Supabase como base de datos, se puede usar Prisma ORM (conectándose al PostgreSQL) o el cliente nativo de Supabase.

**Decisión:** @supabase/supabase-js como cliente principal.

**Justificación:**
- Integración nativa con Supabase Auth (verificación de JWT)
- Integración nativa con Supabase Storage (upload/download con URLs firmadas)
- Una sola dependencia para DB + Auth + Storage
- Queries suficientemente type-safe con TypeScript generados desde la DB
- Menos configuración que Prisma (no necesita schema file ni migraciones CLI)
- Las migraciones se manejan directamente en Supabase Dashboard o con supabase CLI

**Alternativas consideradas:**
- Prisma ORM: Mejor type-safety y migraciones declarativas, pero agrega complejidad con Supabase Auth/Storage
- Drizzle ORM: Buen compromiso pero doble dependencia con Supabase client

**Trade-offs aceptados:**
- Menor type-safety que Prisma (se compensa con Zod para validación)
- Sin migraciones declarativas en código (se usan SQL migrations con supabase CLI)

---

## ADR-005: Stripe como pasarela de pagos

**Estado:** Aceptado
**Fecha:** 2026-02-16

**Contexto:** El sistema necesita procesar pagos por estudios de riesgo y arrendamiento.

**Decisión:** Stripe.

**Justificación:**
- API de alta calidad con excelente documentación
- Soporta Colombia (COP)
- Stripe Checkout y Payment Links simplifican la generación de links de pago
- Webhooks robustos para confirmación automática
- Modo test/sandbox incluido
- Dashboard para el cliente para ver transacciones

**Alternativas consideradas:**
- MercadoPago: Bueno en LATAM pero API menos refinada
- PayU: Muy usado en Colombia pero documentación pobre
- Wompi: De Bancolombia, bueno pero ecosistema limitado

---

## ADR-006: Resend para emails transaccionales

**Estado:** Aceptado
**Fecha:** 2026-02-16

**Contexto:** Se necesita enviar emails para OTP de firma, links de pago, notificaciones de estudios.

**Decisión:** Resend. OTP solo por email (sin SMS en MVP).

**Justificación:**
- API moderna y simple (una llamada HTTP)
- React Email para templates con componentes React
- Buen deliverability
- Modo test incluido
- Más simple que SendGrid para el volumen esperado

**Alternativas consideradas:**
- SendGrid: Más maduro pero más complejo de configurar
- AWS SES: Más barato a volumen pero requiere setup de AWS
- Agregar SMS (Twilio): Incrementa complejidad y costo. Email es suficiente para MVP

---

## ADR-007: TanStack Query + Zustand para estado en frontend

**Estado:** Aceptado
**Fecha:** 2026-02-16

**Contexto:** El frontend necesita manejar datos del servidor (cache, loading, error) y estado de UI (sidebar, modals, filtros).

**Decisión:** TanStack Query para server state, Zustand para client state.

**Justificación:**
- Separación clara entre server state y client state
- TanStack Query resuelve caching, refetch, pagination, optimistic updates
- Zustand es minimalista (~1KB), sin boilerplate, compatible con React 19
- Ambos se integran bien con TypeScript

**Alternativas consideradas:**
- Redux Toolkit + RTK Query: Más completo pero más boilerplate
- SWR: Similar a TanStack Query pero menos features (no mutations, no devtools)
- Context API: Simple pero causa re-renders innecesarios

---

## ADR-008: React Hook Form + Zod para formularios y validación

**Estado:** Aceptado
**Fecha:** 2026-02-16

**Contexto:** El sistema tiene muchos formularios complejos (solicitantes, inmuebles, expedientes).

**Decisión:** React Hook Form para formularios, Zod para validación. Esquemas Zod compartidos entre frontend y backend.

**Justificación:**
- RHF no causa re-renders al escribir (performance en formularios grandes)
- Zod produce tipos TypeScript automáticamente (z.infer)
- Esquemas Zod se pueden compartir: la misma validación en frontend y backend
- @hookform/resolvers conecta Zod con RHF directamente

**Alternativas consideradas:**
- Formik + Yup: Más pesado, más re-renders
- Server Actions con FormData: Menos control sobre UX del formulario

---

## ADR-009: Vercel (frontend) + Railway/Render (backend)

**Estado:** Aceptado
**Fecha:** 2026-02-16

**Contexto:** Se necesitan ambientes de desarrollo, staging y producción para ambos proyectos.

**Decisión:** Vercel para el frontend Next.js, Railway o Render para el backend Express.

**Justificación:**
- Vercel es el hogar nativo de Next.js (optimizaciones automáticas, ISR, Edge)
- Railway/Render ofrecen deploy desde GitHub con auto-scaling
- Ambos soportan preview deployments (staging automático por PR)
- Costo razonable para startup/MVP
- Sin necesidad de administrar servidores

**Alternativas consideradas:**
- AWS (EC2/ECS): Más control pero más DevOps y costo
- DigitalOcean App Platform: Buena opción pero menos integración con GitHub

---

## ADR-010: Repos separados en GitHub con GitFlow simplificado

**Estado:** Aceptado
**Fecha:** 2026-02-16

**Contexto:** Equipo de 2-3 desarrolladores trabajando en frontend y backend.

**Decisión:** Dos repos separados (rental-platform-web, rental-platform-api) con GitFlow simplificado.

**Justificación:**
- Repos separados permiten deploy independiente (frontend puede deployar sin backend y viceversa)
- Cada dev puede trabajar en su repo sin conflictos
- CI/CD más simple por repo
- GitFlow simplificado: `main` (producción) + `develop` (integración) + `feature/*` branches

**Branching strategy:**
```
main ─────────────────────────────────────────── (producción)
  │
  └── develop ────────────────────────────────── (integración)
       │
       ├── feature/HP-xxx-nombre ──────────────── (features)
       ├── feature/HP-yyy-nombre ────────────────
       └── hotfix/HP-zzz-nombre ───────────────── (fixes urgentes)
```

**Reglas:**
- Feature branches se crean desde `develop`
- PRs obligatorios para merge a `develop`
- `main` solo se actualiza desde `develop` (release)
- Naming: `feature/HP-{número}-{descripción-corta}`

---

## ADR-011: Convención mixta de idioma (modelos español, código inglés)

**Estado:** Aceptado
**Fecha:** 2026-02-16

**Contexto:** El dominio del negocio es colombiano con términos específicos (expediente, solicitante, inmueble).

**Decisión:** Nombres de modelos, tablas, rutas API en español. Funciones utilitarias, variables internas y nombres de archivos en inglés.

**Justificación:**
- Los modelos reflejan el dominio del negocio tal como lo entiende el cliente
- Las historias de Jira usan terminología en español
- Evita traducciones ambiguas (expediente ≠ file ≠ case ≠ record)
- El código utilitario mantiene estándar de industria en inglés

**Ejemplos:**
```
// Tabla: inmuebles (español)
// Ruta: /api/v1/inmuebles (español)
// Archivo: inmueble.controller.ts (español)
// Función: function formatCurrency(value) (inglés)
// Variable: const isLoading = true (inglés)
```

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

REST API for **Cofianza 2.0**, a rental guarantee platform in Colombia. Built with Express 5 + TypeScript (strict mode), Supabase for everything (auth, database, storage).

## Commands

- `npm run dev` — start dev server with nodemon + ts-node (port 4000, auto-reload)
- `npm run build` — compile TypeScript and resolve path aliases (`tsc && tsc-alias` → `dist/`)
- `npm start` — run compiled production server (`node dist/server.js`)
- `npm run lint` / `npm run lint:fix` — run ESLint on `src/`
- `npm run format` — run Prettier on all `.ts` files
- `npm run typecheck` — type-check without emitting (`tsc --noEmit`)
- `npm run db:types` — regenerate TypeScript types from Supabase schema into `src/types/database.types.ts`
- `npm run db:migrate` — create a new Supabase migration
- `npm run db:push` — push migrations to Supabase
- `npm run db:reset` — reset local database
- `npm run db:seed` — run seed script (`src/lib/seed.ts`)
- `npm run db:studio` — open Supabase Studio (data explorer)

## Architecture

**Entry flow:** `src/server.ts` → imports `src/app.ts` (Express app) → listens on configured port.

**Middleware stack** (order in `app.ts`): helmet → cors → generalLimiter (100 req/min) → pino-http (with request ID tracing) → express.json → express.urlencoded → routes → errorHandler.

**Modular structure:**
- `src/config/` — Zod-validated env config (`env.ts` schema, `index.ts` loads `.env.local` and re-exports). App crashes on startup if required env vars are missing.
- `src/lib/supabase.ts` — typed Supabase client singleton (uses service role key for server-side access).
- `src/lib/logger.ts` — pino logger instance (pino-pretty in dev, JSON in production).
- `src/middleware/auth.ts` — `authenticate` (JWT verification via `supabase.auth.getUser(token)`, queries `perfiles` table for role and active status, attaches `req.user`) and `authorize(...roles)` (role-based access control, returns 403).
- `src/middleware/validate.ts` — `validate({ body?, params?, query? })` middleware factory using Zod 4 schemas. Returns 400 with `{ field, message, received }` errors.
- `src/middleware/errorHandler.ts` — centralized error handler. Handles `AppError` (dynamic status codes) and generic `Error` (500). Hides stack traces in production.
- `src/middleware/rateLimiter.ts` — `generalLimiter` (100 req/min) and `authLimiter` (10 req/min, for auth routes).
- `src/modules/` — business domain modules following the pattern: `*.routes.ts` → `*.controller.ts` → `*.service.ts`.
- `src/types/auth.ts` — `UserRole` type (`administrador | operador_analista | gerencia_consulta | propietario | inmobiliaria`) and `AuthUser` interface.
- `src/types/database.types.ts` — auto-generated Supabase DB types (regenerate with `npm run db:types`).
- `src/types/express.d.ts` — augments `Express.Request` with `user?: AuthUser`.
- `src/lib/errors.ts` — `AppError` class (statusCode, errorCode, message, details) with factory methods (.badRequest(), .unauthorized(), .forbidden(), .notFound(), .conflict()) and `fromSupabaseError()` mapper (PG 23505→409, 23503→400, PGRST116→404, etc.).
- `src/utils/response.ts` — `sendSuccess(res, data, meta?, statusCode?)` and `sendError(res, statusCode, errorCode, message, details?)`.
- `src/utils/pagination.ts` — `parsePagination(req)` (extracts page, limit, offset, sortBy, sortDir) and `buildPaginationMeta(total, page, limit)`. Defaults: page=1, limit=10, sortBy=created_at, sortDir=desc.

**Routes** are mounted under `/api/v1` prefix. Example: `GET /api/v1/health`.

**Path aliases:** `@/*` maps to `src/*` (tsconfig-paths at runtime, tsc-alias for build).

**Database:** Supabase (PostgreSQL). Client in `src/lib/supabase.ts` uses `@supabase/supabase-js` with typed `Database` generic. Migrations managed via Supabase CLI.

**Authentication:** JWT tokens verified via Supabase Auth (`supabase.auth.getUser(token)`). User role read from `app_metadata.role`. No manual bcrypt/jsonwebtoken — everything through Supabase.

**Roles:** administrador (Administrador), operador_analista (Operador/Analista), gerencia_consulta (Gerencia/Consulta), propietario (Propietario), inmobiliaria (Inmobiliaria).

## Module Pattern

Each business module in `src/modules/<domain>/` follows this structure:
- `<domain>.routes.ts` — Express Router with route definitions, applies `authenticate`, `authorize`, `validate` as needed.
- `<domain>.controller.ts` — thin layer that parses request, calls service, sends response via `sendSuccess`/`sendError`.
- `<domain>.service.ts` — business logic and Supabase queries. Uses `fromSupabaseError()` to map DB errors.

The `health` module serves as the reference implementation of this pattern.

## Multi-tenant data isolation (CRITICAL — read before touching any read/write of inmuebles/expedientes)

The Supabase client uses the **service_role key, which BYPASSES RLS**. There is **no row-level enforcement** — *all* tenant isolation lives in the application layer. Getting this wrong silently leaks one agency's data to another.

**Model.** An `inmobiliaria` is an **organization** (`inmobiliarias`: `owner_perfil_id`, `miembros_ven_todo`, `estado`) with members (`inmobiliaria_miembros`: `perfil_id`, `email`, `rol_miembro`, `estado`, invitation `token`). Only `rol='inmobiliaria'` profiles have an org; a `propietario` is an individual scoped by `inmuebles.propietario_id` (its `inmobiliaria_id` is NULL). `inmuebles.inmobiliaria_id` / `expedientes.inmobiliaria_id` are denormalized for fast scoping; `inmuebles.miembro_responsable_id` / `expedientes.miembro_responsable_id` assign a specific member.

- `rol_miembro`: `owner` (titular — **can be several = co-titulares**), `miembro` (staff, creates/edits org data), `solo_lectura` (viewer — reads only).
- `inmobiliarias.owner_perfil_id` is the "primary titular"; the app re-points it to another active owner when that profile is demoted/leaves (`reapuntarTitularPrincipalSiNecesario`). Ownership checks use `rol_miembro='owner'` and never assume a single owner.

**`src/lib/tenantScope.ts` is the single source of truth for "what can a user see".** Reuse it; do not re-derive scoping inline (three duplicated copies of that logic were the original bug this module fixed). Key exports:
- `resolveVisibilityScope(userId, rol)` → `all` (internal roles) | `org` (owner, or member when `miembros_ven_todo`) | `own` (restricted member / individual propietario) | `none`.
- `resolveAllowedInmuebleIds` / `resolveAllowedExpedienteIds` → `null` = no filter (internal), `[]` = empty, `[...]` = the only IDs this user may read. Most list endpoints filter on these.
- `perfilEsDuenoDeInmueble(...)` → the ownership guard for write/detail endpoints (direct `propietario_id` OR active member of the owning org). Use it instead of `propietario_id === userId`.
- `esOwnerDeOrg`, `esMiembroNoOwnerDeOrg`, `esMiembroSoloLectura`, `resolveOrgMemberPerfilIds`, `ensureOrgConOwner`.

**`solo_lectura` write-block lives in `src/middleware/auth.ts`** (the universal authenticated chokepoint): for a `rol='inmobiliaria'` viewer, mutating methods (POST/PUT/PATCH/DELETE) are **denied by default**, with a small allowlist (`/notificaciones`, `/auth`, `/users`, `/inmobiliaria/miembros/salir`). Consequence: **a new mutating route is automatically blocked for viewers** — if a viewer legitimately needs it, add the path to `viewerPuedeMutar()`. This is the deliberate safe bias; don't replace it with per-route checks.

The **`inmobiliaria-miembros` module** owns the membership lifecycle (invite / accept / register / revoke / change-role / self-leave) plus an admin router (`/api/v1/admin/inmobiliarias`, `rol='administrador'`) to manage any org. Guards that protect the last titular (`contarOwnersActivos`) and free orphaned responsables (`liberarResponsablesDeMiembro`) are shared between the owner-facing and admin-facing paths.

**PostgREST FK ambiguity:** `inmobiliaria_miembros`, `inmuebles`, and `expedientes` each have **two FKs to `perfiles`** — embeds must use an explicit FK hint (e.g. `perfiles!inmobiliaria_miembros_perfil_id_fkey(...)`), or the query 500s with "more than one relationship was found".

## Tests

`npm test` (vitest) — **but CI runs only lint + typecheck + build, not vitest**, so the suite is not a merge gate and several test files are pre-existing failures (expedientes state-machine/workflow, autorizaciones). Run a single file with `npx vitest run path/to/file.test.ts` (note: test files live under `__tests__/`). Tests mock `@/lib/supabase`; mock helper variables referenced inside a `vi.mock` factory must be **inlined or prefixed `mock`** (hoisting), since factories run above the file's top-level consts.

## Conventions

- The project README and docs are in Spanish; code (variables, functions) is in English.
- Config values come from env vars validated by Zod at startup (`src/config/env.ts`).
- Success responses: `{ success: true, data: T, meta?: PaginationMeta }`.
- Error responses: `{ success: false, errorCode: string, message: string, details?: unknown }`. In dev mode, `stack` is also included.
- Use `AppError` for known operational errors (thrown directly, caught by errorHandler).
- Use `fromSupabaseError()` to convert Supabase/PostgreSQL errors to `AppError`.
- Use `sendSuccess()` and `sendError()` helpers — never `res.json()` directly in controllers.
- Use pino `logger` from `@/lib/logger` — never use `console.log`/`console.error` directly.
- Request ID tracing via `x-request-id` header or auto-generated UUID (configured in pino-http).
- Rate limiting: `generalLimiter` is applied globally; `authLimiter` should be applied per-route on auth endpoints.

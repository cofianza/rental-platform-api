# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

REST API for **Habitar Propiedades 2.0**, a rental guarantee platform in Colombia. Built with Express 5 + TypeScript (strict mode), Supabase for everything (auth, database, storage).

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
- `src/middleware/auth.ts` — `authenticate` (JWT verification via `supabase.auth.getUser(token)`, attaches `req.user`) and `authorize(...roles)` (role-based access control, returns 403).
- `src/middleware/validate.ts` — `validate({ body?, params?, query? })` middleware factory using Zod 4 schemas. Returns 400 with `{ field, message, received }` errors.
- `src/middleware/errorHandler.ts` — centralized error handler. Handles `AppError` (dynamic status codes) and generic `Error` (500). Hides stack traces in production.
- `src/middleware/rateLimiter.ts` — `generalLimiter` (100 req/min) and `authLimiter` (10 req/min, for auth routes).
- `src/modules/` — business domain modules following the pattern: `*.routes.ts` → `*.controller.ts` → `*.service.ts`.
- `src/types/auth.ts` — `UserRole` type (`admin | operator | manager | owner | agency`) and `AuthUser` interface.
- `src/types/database.types.ts` — auto-generated Supabase DB types (regenerate with `npm run db:types`).
- `src/types/express.d.ts` — augments `Express.Request` with `user?: AuthUser`.
- `src/utils/errors.ts` — `AppError` class (statusCode, errorCode, message, details) and `fromSupabaseError()` mapper (PG 23505→409, PGRST116→404, etc.).
- `src/utils/response.ts` — `sendSuccess(res, data, meta?, statusCode?)` and `sendError(res, statusCode, errorCode, message, details?)`.
- `src/utils/pagination.ts` — `parsePagination(req)` (extracts page, limit, offset, sortBy, sortDir) and `buildPaginationMeta(total, page, limit)`. Defaults: page=1, limit=10, sortBy=created_at, sortDir=desc.

**Routes** are mounted under `/api/v1` prefix. Example: `GET /api/v1/health`.

**Path aliases:** `@/*` maps to `src/*` (tsconfig-paths at runtime, tsc-alias for build).

**Database:** Supabase (PostgreSQL). Client in `src/lib/supabase.ts` uses `@supabase/supabase-js` with typed `Database` generic. Migrations managed via Supabase CLI.

**Authentication:** JWT tokens verified via Supabase Auth (`supabase.auth.getUser(token)`). User role read from `app_metadata.role`. No manual bcrypt/jsonwebtoken — everything through Supabase.

**Roles:** admin (Administrador), operator (Operador/Analista), manager (Gerencia/Consulta), owner (Propietario), agency (Inmobiliaria).

## Module Pattern

Each business module in `src/modules/<domain>/` follows this structure:
- `<domain>.routes.ts` — Express Router with route definitions, applies `authenticate`, `authorize`, `validate` as needed.
- `<domain>.controller.ts` — thin layer that parses request, calls service, sends response via `sendSuccess`/`sendError`.
- `<domain>.service.ts` — business logic and Supabase queries. Uses `fromSupabaseError()` to map DB errors.

The `health` module serves as the reference implementation of this pattern.

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

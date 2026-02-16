# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

REST API for **Habitar Propiedades 2.0**, a rental guarantee platform in Colombia. Built with Express 5 + TypeScript (strict mode), Supabase as database backend.

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
- `npm run db:studio` — open Supabase Studio (data explorer)

## Architecture

**Entry flow:** `src/server.ts` → imports `src/app.ts` (Express app) → listens on configured port.

**Middleware stack** (order in `app.ts`): helmet → cors → rate-limit → pino-http → express.json → express.urlencoded → routes → errorHandler.

**Modular structure:**
- `src/config/` — Zod-validated env config (`env.ts` schema, `index.ts` re-exports). App crashes on startup if required env vars are missing.
- `src/lib/supabase.ts` — typed Supabase client singleton (uses service role key for server-side access)
- `src/lib/logger.ts` — pino logger instance (pino-pretty in dev, JSON in production)
- `src/middleware/` — shared middleware (errorHandler hides details in production)
- `src/modules/` — business domain modules, each with `*.controller.ts` and `*.routes.ts`
- `src/types/database.types.ts` — auto-generated Supabase DB types (regenerate with `npm run db:types`)

**Routes** are mounted under `/api/v1` prefix. Example: `GET /api/v1/health`.

**Path aliases:** `@/*` maps to `src/*` (tsconfig-paths at runtime, tsc-alias for build).

**Database:** Supabase (PostgreSQL). Client in `src/lib/supabase.ts` uses `@supabase/supabase-js` with typed `Database` generic. Migrations managed via Supabase CLI.

## Conventions

- The project README and docs are in Spanish; code (variables, functions) is in English.
- Config values come from env vars validated by Zod at startup (`src/config/env.ts`).
- Error responses use `{ success: false, message: string }`. In dev mode, `stack` is also included.
- Each business module lives in `src/modules/<domain>/` with its own controller and routes.
- Use pino `logger` from `@/lib/logger` — never use `console.log`/`console.error` directly.

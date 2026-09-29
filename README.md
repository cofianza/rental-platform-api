# rental-platform-api

API REST para **Cofianza 2.0**, una plataforma de garantias de arrendamiento en Colombia. Este servicio maneja toda la logica de negocio: autenticacion, gestion de usuarios y roles, expedientes, inmuebles, documentos, evaluacion de arrendatarios, contratos, firma electronica, pagos, facturacion y reportes.

## Stack

- **Node.js** + **Express 5**
- **TypeScript**
- **Helmet** (seguridad HTTP)
- **CORS** + **Morgan** (logging)

## Inicio rapido

```bash
npm install
cp .env.example .env
npm run dev
```

El servidor corre en [http://localhost:4000](http://localhost:4000).

## Scripts

| Comando | Descripcion |
|---------|-------------|
| `npm run dev` | Servidor de desarrollo con nodemon |
| `npm run build` | Compila TypeScript a JavaScript |
| `npm start` | Servidor de produccion |

## Migraciones de base de datos

**Nunca `supabase db push` contra producción.** (El script `npm run db:push` se quitó el 2026-09-28: nadie lo usaba.)

- En producción, `supabase_migrations.schema_migrations` NO refleja el historial: tiene 4 filas sueltas de mayo de 2026 y el repo tiene ~186 migraciones (revisado el 2026-09-28). Un `db push` intentaría aplicarlas todas otra vez.
- Además, dos archivos comparten la versión `20260219000002`, así que `db push` falla con "duplicate key".
- Cómo se aplica en producción: la persona responsable corre el archivo en el SQL Editor del dashboard, después de sacar un respaldo con `pg_dump`. En el mismo momento, el archivo queda en `supabase/migrations/`.
- Staging se aplica con `supabase/staging/aplicar-migraciones.sh` (psql), no con `db push`. Ver `docs/staging.md`. (Esos dos archivos llegan con la rama `staging-setup`, que todavía no está unida a main.)
- Tampoco hay `db reset` local: por la versión duplicada `20260219000002`, `supabase db reset` / `supabase start` tropezarían al registrar las migraciones. El script `npm run db:reset` se quitó el 2026-09-28.
- El CLI de Supabase de este repo no debe quedar vinculado (`supabase link`) al proyecto de producción (`iijpsfxdkftzgmardvof`, que en el dashboard se llama "cofianza-dev").

**Pendiente (cuando exista staging):** consolidar una migración base (esquema actual de producción) y dejar un historial limpio y coincidente en `schema_migrations` de producción y de staging. Hasta entonces, la regla de arriba se mantiene.

## Estructura

```
src/
├── config/        # Variables de entorno
├── controllers/   # Controladores de rutas
├── middleware/     # Error handler, auth, validaciones
├── models/        # Modelos de datos
├── routes/        # Definicion de rutas
├── services/      # Logica de negocio
├── utils/         # Utilidades
├── app.ts         # Configuracion de Express
└── server.ts      # Entry point
```

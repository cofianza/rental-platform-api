# Convenciones de Código - Habitar Propiedades 2.0

## 1. Estructura de Carpetas

### Backend (rental-platform-api)

```
rental-platform-api/
├── src/
│   ├── server.ts                    # Entry point
│   ├── app.ts                       # Express app setup
│   ├── config/
│   │   ├── index.ts                 # Variables de entorno
│   │   └── supabase.ts              # Cliente Supabase (service role)
│   ├── middleware/
│   │   ├── auth.ts                  # Verificación JWT de Supabase
│   │   ├── roleGuard.ts            # Control de permisos por rol
│   │   ├── validate.ts              # Validación de request con Zod
│   │   └── errorHandler.ts          # Manejo global de errores
│   ├── routes/
│   │   ├── index.ts                 # Router principal (/api/v1/...)
│   │   ├── health.ts               # GET /health
│   │   ├── autorizacion.routes.ts   # /api/v1/autorizaciones
│   │   ├── inmueble.routes.ts       # /api/v1/inmuebles
│   │   ├── expediente.routes.ts     # /api/v1/expedientes
│   │   ├── solicitante.routes.ts    # /api/v1/solicitantes
│   │   ├── documento.routes.ts      # /api/v1/documentos
│   │   ├── estudio.routes.ts        # /api/v1/estudios
│   │   ├── contrato.routes.ts       # /api/v1/contratos
│   │   ├── firma.routes.ts          # /api/v1/firma
│   │   ├── pago.routes.ts           # /api/v1/pagos
│   │   ├── factura.routes.ts        # /api/v1/facturacion
│   │   ├── usuario.routes.ts        # /api/v1/usuarios
│   │   └── reporte.routes.ts        # /api/v1/reportes
│   ├── controllers/
│   │   ├── inmueble.controller.ts
│   │   ├── expediente.controller.ts
│   │   ├── solicitante.controller.ts
│   │   ├── documento.controller.ts
│   │   ├── autorizacion.controller.ts
│   │   ├── estudio.controller.ts
│   │   ├── contrato.controller.ts
│   │   ├── firma.controller.ts
│   │   ├── pago.controller.ts
│   │   ├── factura.controller.ts
│   │   ├── usuario.controller.ts
│   │   └── reporte.controller.ts
│   ├── services/
│   │   ├── inmueble.service.ts
│   │   ├── expediente.service.ts
│   │   ├── solicitante.service.ts
│   │   ├── documento.service.ts
│   │   ├── autorizacion.service.ts
│   │   ├── estudio.service.ts
│   │   ├── contrato.service.ts
│   │   ├── firma.service.ts
│   │   ├── pago.service.ts
│   │   ├── factura.service.ts
│   │   ├── usuario.service.ts
│   │   ├── reporte.service.ts
│   │   ├── email.service.ts          # Resend integration
│   │   └── storage.service.ts        # Supabase Storage wrapper
│   ├── schemas/                       # Zod schemas (compartibles)
│   │   ├── inmueble.schema.ts
│   │   ├── expediente.schema.ts
│   │   ├── solicitante.schema.ts
│   │   ├── documento.schema.ts
│   │   ├── autorizacion.schema.ts
│   │   ├── estudio.schema.ts
│   │   ├── contrato.schema.ts
│   │   ├── pago.schema.ts
│   │   └── common.schema.ts          # Schemas reutilizables
│   ├── types/
│   │   ├── database.types.ts          # Tipos generados de Supabase
│   │   ├── express.d.ts              # Extensiones de Request (user, etc.)
│   │   └── index.ts                   # Re-exports
│   └── utils/
│       ├── errors.ts                  # Clases de error custom
│       ├── pagination.ts             # Helper de paginación
│       └── logger.ts                  # Logger configurado
├── docs/                              # Documentación de arquitectura
├── tests/                             # Tests
│   ├── unit/
│   └── integration/
├── .env                               # Variables locales (NO commitear)
├── .env.example                       # Template de variables
├── .gitignore
├── package.json
└── tsconfig.json
```

### Frontend (rental-platform-web)

```
rental-platform-web/
├── app/                               # Next.js App Router
│   ├── layout.tsx                     # Root layout
│   ├── page.tsx                       # Landing / (vitrina)
│   ├── globals.css                    # Tailwind + theme
│   ├── (auth)/                        # Grupo: páginas de autenticación
│   │   ├── layout.tsx
│   │   ├── login/page.tsx
│   │   ├── registro/page.tsx
│   │   └── recuperar-contrasena/page.tsx
│   ├── (public)/                      # Grupo: páginas públicas
│   │   ├── inmuebles/page.tsx         # Vitrina pública
│   │   ├── inmuebles/[id]/page.tsx    # Detalle público
│   │   ├── firma/[token]/page.tsx     # Página de firma OTP
│   │   ├── pago/[token]/page.tsx      # Página de pago
│   │   ├── estudio/[token]/page.tsx   # Formulario self-service
│   │   └── autorizacion/[token]/page.tsx  # Autorización Habeas Data
│   └── (dashboard)/                   # Grupo: panel privado
│       ├── layout.tsx                 # Layout con sidebar
│       ├── dashboard/page.tsx         # Home del dashboard
│       ├── inmuebles/
│       │   ├── page.tsx               # Listado
│       │   ├── nuevo/page.tsx         # Crear
│       │   └── [id]/page.tsx          # Detalle/editar
│       ├── expedientes/
│       │   ├── page.tsx               # Listado con bandejas
│       │   ├── nuevo/page.tsx         # Crear
│       │   └── [id]/page.tsx          # Detalle con tabs
│       ├── estudios/page.tsx
│       ├── contratos/
│       │   ├── page.tsx
│       │   └── [id]/page.tsx
│       ├── plantillas-contrato/page.tsx
│       ├── pagos/page.tsx
│       ├── facturacion/page.tsx
│       ├── reportes/page.tsx
│       ├── usuarios/page.tsx
│       └── configuracion/page.tsx
├── components/
│   ├── layout/                        # Componentes de layout
│   │   ├── Sidebar.tsx
│   │   ├── Header.tsx
│   │   └── Breadcrumbs.tsx
│   ├── ui/                            # Componentes UI reutilizables
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Select.tsx
│   │   ├── Modal.tsx
│   │   ├── DataTable.tsx
│   │   ├── StatusBadge.tsx
│   │   ├── KPICard.tsx
│   │   ├── PropertyCard.tsx
│   │   ├── EmptyState.tsx
│   │   ├── ConfirmDialog.tsx
│   │   ├── PageHeader.tsx
│   │   ├── SearchInput.tsx
│   │   ├── Avatar.tsx
│   │   ├── Icons.tsx
│   │   └── FileUpload.tsx
│   └── forms/                         # Componentes de formulario específicos
│       ├── InmuebleForm.tsx
│       ├── ExpedienteForm.tsx
│       ├── SolicitanteForm.tsx
│       └── DocumentUpload.tsx
├── lib/
│   ├── api.ts                         # Cliente HTTP (fetch wrapper)
│   ├── supabase/
│   │   ├── client.ts                  # Supabase browser client
│   │   └── server.ts                  # Supabase server client
│   ├── constants.ts                   # Constantes de la app
│   ├── utils.ts                       # Utilidades generales
│   └── mock-data.ts                   # Mock data (temporal)
├── hooks/                             # Custom hooks
│   ├── useAuth.ts                     # Hook de autenticación
│   ├── useInmuebles.ts               # TanStack Query hooks
│   ├── useExpedientes.ts
│   └── ...
├── stores/                            # Zustand stores
│   ├── ui.store.ts                    # Estado UI (sidebar, modals)
│   └── filters.store.ts              # Estado de filtros
├── schemas/                           # Zod schemas (compartidos con backend)
│   └── ...
├── types/
│   └── index.ts
├── docs/                              # Link a documentación
├── public/                            # Assets estáticos
├── .env.local                         # Variables locales
├── .env.example
├── .gitignore
├── next.config.ts
├── package.json
└── tsconfig.json
```

---

## 2. Convenciones de Nombrado

### Archivos y carpetas
| Tipo | Convención | Ejemplo |
|------|-----------|---------|
| Páginas Next.js | `page.tsx` (App Router) | `app/(dashboard)/inmuebles/page.tsx` |
| Componentes React | PascalCase | `PropertyCard.tsx`, `DataTable.tsx` |
| Hooks | camelCase con `use` prefix | `useAuth.ts`, `useInmuebles.ts` |
| Stores Zustand | camelCase con `.store` suffix | `ui.store.ts` |
| Controllers | camelCase con `.controller` suffix | `inmueble.controller.ts` |
| Services | camelCase con `.service` suffix | `inmueble.service.ts` |
| Routes | camelCase con `.routes` suffix | `inmueble.routes.ts` |
| Schemas Zod | camelCase con `.schema` suffix | `inmueble.schema.ts` |
| Types | camelCase | `database.types.ts` |

### Variables y funciones
| Contexto | Convención | Ejemplo |
|---------|-----------|---------|
| Variables | camelCase (inglés) | `const isLoading = true` |
| Funciones | camelCase (inglés) | `function formatCurrency()` |
| Constantes | UPPER_SNAKE_CASE | `const MAX_FILE_SIZE = 10_000_000` |
| Tipos/Interfaces | PascalCase | `interface Inmueble { }` |
| Enums | PascalCase + UPPER values | `enum EstadoExpediente { BORRADOR = 'borrador' }` |

### Base de datos (Supabase)
| Tipo | Convención | Ejemplo |
|------|-----------|---------|
| Tablas | snake_case (español) | `inmuebles`, `expedientes`, `solicitantes` |
| Columnas | snake_case (español) | `valor_comercial`, `fecha_creacion` |
| Foreign keys | `{tabla_singular}_id` | `inmueble_id`, `expediente_id` |
| Primary keys | `id` (UUID) | `id uuid default gen_random_uuid()` |
| Timestamps | `created_at`, `updated_at` | Automáticos |
| Estados | `estado` | `estado varchar check (estado in ('borrador', 'en_revision', ...))` |

### Rutas API
| Método | Convención | Ejemplo |
|--------|-----------|---------|
| Listado | GET /recurso | `GET /api/v1/inmuebles` |
| Detalle | GET /recurso/:id | `GET /api/v1/inmuebles/:id` |
| Crear | POST /recurso | `POST /api/v1/inmuebles` |
| Actualizar | PATCH /recurso/:id | `PATCH /api/v1/inmuebles/:id` |
| Eliminar | DELETE /recurso/:id | `DELETE /api/v1/inmuebles/:id` |
| Acción | POST /recurso/:id/accion | `POST /api/v1/expedientes/:id/cambiar-estado` |

---

## 3. Patrones de Código

### Backend: Patrón MVC (Route → Controller → Service → Supabase)

```
Request → Middleware (auth + validate) → Controller → Service → Supabase
                                              ↓
Response ← Controller ← resultado ← Service
```

**Route:** Define endpoints y aplica middleware
**Controller:** Extrae datos del request, llama al service, devuelve response
**Service:** Contiene lógica de negocio, interactúa con Supabase
**Schema:** Define validación del body/params con Zod

### Frontend: Patrón de hooks con TanStack Query

```
Componente → useInmuebles() hook → TanStack Query → fetch('/api/v1/inmuebles')
                                        ↓
Componente ← data/isLoading/error ← cache
```

---

## 4. Respuestas de la API

### Formato estándar de respuesta exitosa
```json
{
  "data": { ... },
  "message": "Inmueble creado exitosamente"
}
```

### Formato estándar de respuesta con lista
```json
{
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

### Formato estándar de error
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Error de validación",
    "details": [
      { "field": "valor_comercial", "message": "Debe ser un número positivo" }
    ]
  }
}
```

### Códigos HTTP utilizados
| Código | Uso |
|--------|-----|
| 200 | Operación exitosa (GET, PATCH) |
| 201 | Recurso creado (POST) |
| 204 | Sin contenido (DELETE) |
| 400 | Error de validación |
| 401 | No autenticado |
| 403 | Sin permisos |
| 404 | Recurso no encontrado |
| 409 | Conflicto (ej: inmueble ya en estudio) |
| 500 | Error interno del servidor |

---

## 5. Git Conventions

### Commits
Formato: `tipo(alcance): descripción`

Tipos:
- `feat`: nueva funcionalidad
- `fix`: corrección de bug
- `docs`: documentación
- `style`: formateo (no cambia lógica)
- `refactor`: reestructuración sin cambiar comportamiento
- `test`: agregar o corregir tests
- `chore`: tareas de mantenimiento

Ejemplo: `feat(inmuebles): agregar endpoint de búsqueda con filtros`

### Branches
Formato: `feature/HP-{número}-{descripción-corta}`

Ejemplo: `feature/HP-164-crud-inmuebles`

### Pull Requests
- Título: referencia a la story de Jira
- Descripción: qué cambia y por qué
- Al menos 1 review antes de merge a `develop`

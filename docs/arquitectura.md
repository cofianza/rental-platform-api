# Arquitectura del Sistema - Habitar Propiedades 2.0

## 1. Visión General

Habitar Propiedades 2.0 es una plataforma web de operación inmobiliaria colombiana que permite: gestión de inmuebles, administración de expedientes de arrendamiento, carga y validación de documentos, evaluación de arrendatarios, generación y firma de contratos (OTP), pagos y facturación básica.

**Referencia funcional:** Fianly (plataforma colombiana de afianzamiento de arrendamientos).

---

## 2. Diagrama C4 - Nivel 1 (Contexto del Sistema)

```
┌──────────────────────────────────────────────────────────────────────┐
│                        USUARIOS EXTERNOS                             │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │ Administrador│  │  Operador/  │  │  Gerencia/  │  │  Público   │ │
│  │             │  │  Analista   │  │  Consulta   │  │(Arrendata- │ │
│  │             │  │             │  │             │  │ rios/Prop.) │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬──────┘ │
└─────────┼────────────────┼────────────────┼────────────────┼────────┘
          │                │                │                │
          └────────────────┼────────────────┘                │
                           │                                 │
                    ┌──────▼──────┐                   ┌──────▼──────┐
                    │  Dashboard  │                   │   Vitrina   │
                    │  (privado)  │                   │  (pública)  │
                    └──────┬──────┘                   └──────┬──────┘
                           │                                 │
                    ┌──────▼─────────────────────────────────▼──────┐
                    │                                               │
                    │          HABITAR PROPIEDADES 2.0              │
                    │                                               │
                    │  ┌────────────────┐  ┌─────────────────────┐ │
                    │  │   Frontend     │  │     Backend API      │ │
                    │  │   (Next.js)    │──│     (Express)        │ │
                    │  │   Vercel       │  │     Railway/Render   │ │
                    │  └────────────────┘  └──────────┬──────────┘ │
                    │                                  │            │
                    └──────────────────────────────────┼────────────┘
                                                       │
          ┌────────────────────────────────────────────┼──────────────┐
          │                 SERVICIOS EXTERNOS          │              │
          │                                             │              │
          │  ┌──────────┐  ┌──────────┐  ┌─────────┐  │  ┌────────┐ │
          │  │ Supabase │  │  Stripe  │  │ Resend  │  │  │Central.│ │
          │  │ (DB +    │  │ (Pagos)  │  │(Emails) │  │  │Riesgo  │ │
          │  │ Storage +│  │          │  │         │  │  │(futuro)│ │
          │  │ Auth)    │  │          │  │         │  │  │        │ │
          │  └──────────┘  └──────────┘  └─────────┘  │  └────────┘ │
          └────────────────────────────────────────────┴──────────────┘
```

---

## 3. Diagrama C4 - Nivel 2 (Contenedores)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (Vercel)                              │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                    Next.js 16 + React 19                           │  │
│  │                    Tailwind CSS 4 (App Router)                     │  │
│  │                                                                    │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐│  │
│  │  │  Páginas     │  │  Componentes │  │  Libs                    ││  │
│  │  │  Públicas    │  │  UI          │  │                          ││  │
│  │  │  /(landing)  │  │  /components │  │  TanStack Query (server) ││  │
│  │  │  /inmuebles  │  │  /ui         │  │  Zustand (client state)  ││  │
│  │  │  /login      │  │  /layout     │  │  React Hook Form + Zod   ││  │
│  │  │  /registro   │  │              │  │  Supabase Client (auth)  ││  │
│  │  │  /firma/[t]  │  │              │  │                          ││  │
│  │  │  /pago/[t]   │  │              │  │                          ││  │
│  │  ├──────────────┤  │              │  │                          ││  │
│  │  │  Páginas     │  │              │  │                          ││  │
│  │  │  Dashboard   │  │              │  │                          ││  │
│  │  │  /dashboard  │  │              │  │                          ││  │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘│  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                              │ HTTPS (JSON)                              │
└──────────────────────────────┼───────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      BACKEND API (Railway/Render)                        │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                 Node.js + Express 5 + TypeScript                   │  │
│  │                 API REST versionada bajo /api/v1/                  │  │
│  │                                                                    │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐│  │
│  │  │  Middleware   │  │  Controlador │  │  Servicios               ││  │
│  │  │              │  │  es          │  │                          ││  │
│  │  │  Auth        │  │  inmueble    │  │  InmuebleService         ││  │
│  │  │  (Supabase   │  │  expediente  │  │  ExpedienteService       ││  │
│  │  │  JWT verify) │  │  solicitante │  │  SolicitanteService      ││  │
│  │  │              │  │  documento   │  │  DocumentoService        ││  │
│  │  │  Validation  │  │  autorizacion│  │  AutorizacionService     ││  │
│  │  │  (Zod)       │  │  estudio     │  │  EstudioService          ││  │
│  │  │              │  │  contrato    │  │  ContratoService         ││  │
│  │  │              │  │  firma       │  │  FirmaService            ││  │
│  │  │  RoleGuard   │  │  pago        │  │  PagoService             ││  │
│  │  │  (permisos)  │  │  factura     │  │  FacturaService          ││  │
│  │  │              │  │  reporte     │  │  ReporteService          ││  │
│  │  │  ErrorHandler│  │  usuario     │  │  UsuarioService          ││  │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘│  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                              │                                           │
└──────────────────────────────┼───────────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┬──────────────┐
              ▼                ▼                ▼              ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────┐
     │   Supabase   │  │   Supabase   │  │  Stripe  │  │  Resend  │
     │   PostgreSQL │  │   Storage    │  │  (pagos) │  │ (emails) │
     │   (DB)       │  │  (archivos)  │  │          │  │          │
     └──────────────┘  └──────────────┘  └──────────┘  └──────────┘
```

---

## 4. Flujo de Comunicación

```
Usuario (Browser)
    │
    ▼
Frontend (Next.js en Vercel) ── puerto 3000 (local) ──
    │                                                    │
    │ 1. Login → Supabase Auth (directo)                │
    │    Obtiene JWT token de Supabase                   │
    │                                                    │
    │ 2. Todas las demás operaciones:                    │
    │    fetch('/api/v1/...', {                          │
    │      headers: { Authorization: 'Bearer <token>' } │
    │    })                                              │
    │                                                    │
    ▼                                                    │
Backend API (Express en Railway) ── puerto 4000 (local) │
    │                                                    │
    │ 1. Middleware auth: verifica JWT de Supabase       │
    │ 2. Middleware roleGuard: verifica permisos         │
    │ 3. Middleware validation: valida body con Zod      │
    │ 4. Controller: orquesta la operación               │
    │ 5. Service: lógica de negocio                      │
    │ 6. Supabase Client: lee/escribe en DB y Storage   │
    │                                                    │
    ▼                                                    │
Supabase (PostgreSQL + Storage + Auth)                   │
```

**Regla fundamental:** El frontend NUNCA accede directamente a la base de datos ni al storage. Toda operación pasa por el backend Express, excepto la autenticación inicial (login/registro) que va directo a Supabase Auth.

---

## 5. Flujo Principal del Negocio

```
┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────┐
│ INMUEBLE │───▶│  EXPEDIENTE  │───▶│ AUTORIZACIÓN │───▶│   ESTUDIO    │───▶│ CONTRATO │
│          │    │              │    │ HABEAS DATA  │    │  DE RIESGO   │    │          │
│ Crear/   │    │ Crear caso   │    │              │    │              │    │ Generar  │
│ Registrar│    │ + Solicitante│    │ Web o enlace │    │ Solicitar    │    │ desde    │
│ propiedad│    │              │    │ presencial   │    │ evaluación   │    │ plantilla│
└──────────┘    └──────────────┘    └──────────────┘    └──────────────┘    └────┬─────┘
                                                              │
                                                              ▼
                ┌──────────────┐    ┌──────────────┐    ┌──────────┐
                │  FACTURACIÓN │◀───│    PAGOS     │◀───│  FIRMA   │
                │   BÁSICA     │    │              │    │   OTP    │
                │              │    │ Link de pago │    │          │
                │ Registro     │    │ vía Stripe   │    │ Enviar   │
                │ fiscal       │    │              │    │ liga +   │
                │              │    │              │    │ validar  │
                └──────────────┘    └──────────────┘    └──────────┘
```

### Autorización Habeas Data (paso obligatorio)

Antes de iniciar un estudio de riesgo, el sistema requiere la autorización de tratamiento de datos personales (Habeas Data) por parte del solicitante, en cumplimiento de la Ley 1581/2012 (Protección de Datos Personales) y la Ley 1266/2008 (Habeas Data financiero).

Existen dos canales de autorización:
- **Web (autoservicio):** El solicitante acepta durante el registro o al completar el formulario del expediente.
- **Enlace presencial:** El administrador genera un enlace único (`/autorizacion/[token]`) para clientes que realizan el trámite de forma presencial. El solicitante firma desde su dispositivo.

Una vez registrada la autorización, el sistema permite proceder con la solicitud del estudio de riesgo.

### Estados del Expediente (Workflow)

```
                          ┌──────────────────┐
                          │    BORRADOR      │
                          │  (recién creado) │
                          └────────┬─────────┘
                                   │ Enviar a revisión
                                   ▼
                          ┌──────────────────┐
                     ┌───▶│   EN REVISIÓN    │◀──┐
                     │    │                  │   │
                     │    └───────┬──────────┘   │
                     │            │               │
                     │     ┌──────┴──────┐        │
                     │     ▼             ▼        │
            ┌────────────────┐  ┌──────────────┐  │
            │  INFORMACIÓN   │  │  Evaluación  │  │
            │  INCOMPLETA    │  │  completada  │  │
            │                │──┘              │  │
            └────────────────┘       ┌─────────┘  │
              (solicitar docs)       │            │
                                     ▼            │
                          ┌──────────────────┐    │
                          │    APROBADO      │    │
                          └────────┬─────────┘    │
                                   │              │
                          ┌──────────────────┐    │
                          │  CONDICIONADO    │────┘
                          │ (con condiciones)│ (re-evaluación)
                          └──────────────────┘
                          ┌──────────────────┐
                          │   RECHAZADO      │
                          └──────────────────┘
                          ┌──────────────────┐
                          │    CERRADO       │
                          └──────────────────┘
```

---

## 6. Diagrama de Secuencia - Autenticación

```
Usuario          Frontend           Supabase Auth       Backend API
  │                 │                    │                   │
  │  1. Login       │                    │                   │
  │  (email+pass)   │                    │                   │
  │────────────────▶│                    │                   │
  │                 │  2. signInWith     │                   │
  │                 │  Password()        │                   │
  │                 │───────────────────▶│                   │
  │                 │                    │                   │
  │                 │  3. JWT token +    │                   │
  │                 │  refresh token     │                   │
  │                 │◀───────────────────│                   │
  │                 │                    │                   │
  │  4. Redirect    │                    │                   │
  │  a /dashboard   │                    │                   │
  │◀────────────────│                    │                   │
  │                 │                    │                   │
  │  5. Cargar      │                    │                   │
  │  datos          │                    │                   │
  │────────────────▶│                    │                   │
  │                 │  6. GET /api/v1/...│                   │
  │                 │  Authorization:    │                   │
  │                 │  Bearer <token>    │                   │
  │                 │──────────────────────────────────────▶│
  │                 │                    │                   │
  │                 │                    │  7. Verify JWT    │
  │                 │                    │◀──────────────────│
  │                 │                    │  (getUser)        │
  │                 │                    │──────────────────▶│
  │                 │                    │                   │
  │                 │                    │  8. User data +   │
  │                 │                    │  rol              │
  │                 │                    │                   │
  │                 │  9. Response JSON  │                   │
  │                 │◀──────────────────────────────────────│
  │                 │                    │                   │
  │  10. Render     │                    │                   │
  │  dashboard      │                   │                   │
  │◀────────────────│                    │                   │
```

---

## 7. Stack Tecnológico Completo

### Backend (rental-platform-api)
| Componente | Tecnología | Versión | Propósito |
|-----------|-----------|---------|-----------|
| Runtime | Node.js | 20 LTS | Ejecución de JavaScript server-side |
| Framework | Express | 5.x | API REST, routing, middleware |
| Lenguaje | TypeScript | 5.x | Type safety y DX |
| Base de datos | Supabase PostgreSQL | - | Almacenamiento persistente |
| ORM/Cliente | @supabase/supabase-js | 2.x | Queries, auth verification, storage |
| Validación | Zod | 3.x | Validación de requests y tipos |
| Emails | Resend | - | Emails transaccionales (OTP, notificaciones) |
| Pagos | Stripe | - | Procesamiento de pagos, links de pago |
| Seguridad | Helmet | 8.x | Headers HTTP de seguridad |
| CORS | cors | 2.x | Cross-origin requests desde frontend |
| Logging | Morgan | 1.x | HTTP request logging |

### Frontend (rental-platform-web)
| Componente | Tecnología | Versión | Propósito |
|-----------|-----------|---------|-----------|
| Framework | Next.js | 16.x | App Router, SSR, routing |
| UI Library | React | 19.x | Componentes reactivos |
| Estilos | Tailwind CSS | 4.x | Utility-first CSS |
| Server State | TanStack Query | 5.x | Cache, refetch, loading states |
| Client State | Zustand | 5.x | Estado UI (sidebar, modals, filtros) |
| Forms | React Hook Form | 7.x | Formularios performantes |
| Validación | Zod | 3.x | Esquemas compartidos con backend |
| Auth Client | @supabase/supabase-js | 2.x | Login, registro, tokens |
| Auth SSR | @supabase/ssr | - | Manejo de sesiones en server components |

### Infraestructura
| Componente | Servicio | Propósito |
|-----------|---------|-----------|
| Frontend hosting | Vercel | Deploy automático desde GitHub |
| Backend hosting | Railway o Render | API con auto-deploy desde GitHub |
| Base de datos | Supabase | PostgreSQL gestionado |
| Almacenamiento | Supabase Storage | Documentos, fotos, contratos |
| Autenticación | Supabase Auth | Login, registro, JWT, refresh tokens |
| CI/CD | GitHub Actions | Tests, lint, deploy automático |

### Servicios Externos
| Servicio | Proveedor | Estado |
|---------|----------|--------|
| Pagos | Stripe | Por integrar |
| Emails transaccionales | Resend | Por integrar |
| Centrales de riesgo | TransUnion + SIFIN + Datacrédito | Esperando credenciales del cliente (requiere autorización Habeas Data previa) |
| Firma electrónica | Proveedor del cliente (ya contratado) | Esperando coordinación |

---

## 8. Ambientes

| Ambiente | Frontend | Backend | Base de datos | Propósito |
|---------|---------|---------|--------------|-----------|
| **Desarrollo** | localhost:3000 | localhost:4000 | Supabase project (dev) | Desarrollo local |
| **Staging** | Vercel Preview | Railway/Render staging | Supabase project (staging) | Pruebas pre-producción |
| **Producción** | Vercel Production | Railway/Render prod | Supabase project (prod) | Cliente final |

### Variables de entorno por ambiente

**Backend (.env):**
```
NODE_ENV=development|staging|production
PORT=4000
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_ANON_KEY=eyJ...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
RESEND_API_KEY=re_...
FRONTEND_URL=http://localhost:3000
```

**Frontend (.env.local):**
```
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
```

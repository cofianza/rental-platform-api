# Roles y Permisos - Habitar Propiedades 2.0

## 1. Roles del Sistema

### Roles Internos (usuarios de la plataforma)

| Rol | Descripción | Acceso |
|-----|-----------|--------|
| **Administrador** | Configuración general del sistema | Acceso total a todos los módulos |
| **Operador/Analista** | Gestión operativa diaria | CRUD de expedientes, documentos, estudios, contratos |
| **Gerencia/Consulta** | Supervisión y reportes | Solo lectura de tableros, reportes y dashboards |

### Tipos de Registro Público (NO son roles admin)

| Tipo | Descripción | Proceso |
|------|-----------|---------|
| **Propietario** | Persona física que registra inmuebles | Registro con datos personales |
| **Inmobiliaria** | Persona jurídica con representante legal | Registro con datos fiscales de empresa |

Ambos requieren aceptación de términos y condiciones + autorización de tratamiento de datos (Ley 1581/2012).

---

## 2. Matriz de Permisos por Módulo

### Leyenda
- **C** = Crear | **R** = Leer | **U** = Actualizar | **D** = Eliminar (baja lógica)
- **X** = Acción especial (ver detalle abajo)

### Módulos del Dashboard

| Funcionalidad | Administrador | Operador/Analista | Gerencia/Consulta |
|--------------|:-------------:|:-----------------:|:-----------------:|
| **Inmuebles** | CRUD | CRUD | R |
| **Expedientes** | CRUD | CRUD | R |
| **Solicitantes** | CRUD | CRUD | R |
| **Documentos** | CRUD + Validar | CRUD + Validar | R + Descargar |
| **Estudios** | CRUD + Solicitar | CRUD + Solicitar | R |
| **Contratos** | CRUD + Generar | CR + Generar | R + Descargar |
| **Firma OTP** | Enviar + Ver | Enviar + Ver | Ver |
| **Pagos** | CRUD + Link pago | CR + Link pago | R |
| **Facturación** | CRUD | CR | R |
| **Dashboard** | R + Acciones | R + Acciones | R |
| **Reportes** | R + Exportar | R + Exportar | R + Exportar |
| **Usuarios** | CRUD | - | - |
| **Roles/Permisos** | CRU | - | - |
| **Configuración** | CRUD | R | - |
| **Bitácora** | R | - | - |
| **Plantillas contrato** | CRUD | R | - |

### Páginas Públicas (sin autenticación)

| Funcionalidad | Cualquier visitante | Usuario registrado |
|--------------|:------------------:|:-----------------:|
| Ver vitrina de inmuebles | R | R |
| Ver detalle de inmueble | R | R |
| Registrarse (Propietario/Inmobiliaria) | X | - |
| Expresar interés ("Me interesa") | - | X |
| Firmar contrato (OTP) | - | X (con token) |
| Pagar (link de pago) | - | X (con token) |
| Llenar formulario de estudio | - | X (con token) |

---

## 3. Acciones Especiales por Rol

### Administrador
- Crear, editar y desactivar usuarios
- Asignar roles a usuarios
- Configurar tipos de documentos requeridos
- Gestionar plantillas de contrato
- Ver bitácora de acciones críticas
- Cambiar estado de cualquier expediente
- Acceso a configuración del sistema

### Operador/Analista
- Crear y gestionar expedientes (asignarse como responsable)
- Validar documentos (Aprobar/Rechazar con motivo)
- Solicitar estudios de riesgo
- Registrar resultado manual de estudio
- Generar contratos desde plantillas
- Enviar contratos a firma
- Generar links de pago
- Registrar pagos manuales
- Agregar comentarios internos a expedientes
- Cambiar estado de expedientes asignados

### Gerencia/Consulta
- Ver todos los dashboards e indicadores
- Ver listados de expedientes, inmuebles, contratos
- Descargar documentos y contratos firmados
- Exportar reportes (CSV/Excel)
- Ver historial/timeline de expedientes
- NO puede crear, editar ni eliminar nada
- NO puede cambiar estados

---

## 4. Reglas de Negocio por Permisos

| Regla | Detalle |
|-------|---------|
| Solo Admin crea usuarios | Los usuarios no se auto-registran en el panel (solo en vitrina pública) |
| Expediente tiene responsable | Cada expediente se asigna a un Operador/Analista |
| Solo responsable o Admin cambia estado | Un operador solo puede cambiar estado de expedientes que tiene asignados |
| Contrato requiere estudio aprobado | No se puede generar contrato si no hay resultado de estudio positivo |
| Inmueble "En Estudio" bloqueado | No se pueden iniciar nuevos estudios para un inmueble que ya está en estudio |
| Firma requiere contrato generado | No se puede enviar a firma sin contrato con variables completas |
| Pago requiere firma completada | El link de pago de arrendamiento se genera después de la firma |
| Bitácora es inmutable | Las acciones registradas en bitácora no se pueden editar ni eliminar |

---

## 5. Implementación Técnica

### Tabla de roles en Supabase
```
roles: id, nombre, descripcion, permisos (JSONB), created_at
usuarios: id, email, nombre, rol_id (FK), activo, created_at, updated_at
```

### Middleware de autorización en Express
```
Request → authMiddleware (verifica JWT) → roleGuard(['administrador', 'operador']) → Controller
```

1. `authMiddleware`: Verifica el JWT de Supabase, extrae el usuario y su rol
2. `roleGuard(rolesPermitidos)`: Verifica que el rol del usuario está en la lista de roles permitidos
3. Si falla: retorna 401 (no autenticado) o 403 (sin permisos)

### Campo rol en el JWT
El rol del usuario se almacena en los metadatos de Supabase Auth (`user_metadata.rol`) y se verifica en cada request.

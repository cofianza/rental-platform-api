# Modelo de Datos - Cofianza 2.0

## 1. Resumen

El modelo de datos de Cofianza 2.0 consta de **15 tablas** alojadas en **Supabase PostgreSQL**. Todas las claves primarias son **UUID** generados con `gen_random_uuid()`. La nomenclatura sigue la convención **snake_case en español**, y los nombres de tablas están en plural. Se utilizan 20 tipos enumerados (`ENUM`) para garantizar la integridad de los datos.

### Listado de tablas

| # | Tabla | Descripcion |
|---|-------|-------------|
| 1 | `perfiles` | Usuarios internos del sistema (extiende `auth.users` de Supabase Auth) |
| 2 | `inmuebles` | Propiedades registradas para arrendamiento |
| 3 | `solicitantes` | Personas que solicitan arrendar un inmueble |
| 4 | `expedientes` | Casos de arrendamiento que vinculan inmueble + solicitante |
| 5 | `documentos` | Archivos adjuntos asociados a un expediente |
| 6 | `estudios` | Estudios de riesgo crediticio realizados al solicitante |
| 7 | `plantillas_contrato` | Plantillas reutilizables para generar contratos |
| 8 | `contratos` | Contratos de arrendamiento generados a partir de un expediente |
| 9 | `firmas` | Registros de firma electrónica (OTP) de cada parte del contrato |
| 10 | `pagos` | Pagos realizados dentro del proceso de arrendamiento |
| 11 | `facturas` | Solicitudes de facturacion asociadas a un pago |
| 12 | `bitacora` | Registro de auditoria de todas las acciones del sistema |
| 13 | `comentarios` | Notas y comentarios internos sobre un expediente |
| 14 | `eventos_timeline` | Linea de tiempo de eventos relevantes de un expediente |
| 15 | `autorizaciones_habeas_data` | Autorizaciones de consulta crediticia (Habeas Data, Ley 1581/2012 + Ley 1266/2008) |

---

## 2. Diagrama de Entidad-Relacion (ASCII)

```
                                    ┌───────────────────┐
                                    │     bitacora       │
                                    │  (auditoria global)│
                                    └───────────────────┘
                                          ▲ N:1
                                          │ usuario_id
                                          │
┌───────────────────┐   1:N    ┌──────────┴────────┐   1:N    ┌───────────────────┐
│  plantillas_      │          │     perfiles       │─────────▶│    inmuebles       │
│  contrato         │          │  (usuarios int.)   │          │  (propiedades)     │
└────────┬──────────┘          └───────────┬────────┘          └─────────┬──────────┘
         │                          │      │                            │
         │                  analista_id    │ propietario_id              │ 1:N
         │                          │      │                            │
         │                          ▼      │                            ▼
         │                    ┌────────────┴─────┐     N:1    ┌───────────────────┐
         │                    │   expedientes     │◀──────────│   solicitantes     │
         │                    │  (casos arrend.)  │           │  (arrendatarios)   │
         │                    └──┬──┬──┬──┬──┬──┬─┘           └────────┬──────────┘
         │                       │  │  │  │  │  │                      │ 1:N
         │                       │  │  │  │  │  │             ┌────────┴──────────┐
         │                       │  │  │  │  │  │             │ autorizaciones_    │
         │                       │  │  │  │  │  │             │ habeas_data        │
         │                       │  │  │  │  │  │             └───────────────────┘
         │                       │  │  │  │  │  │
         │            ┌──────────┘  │  │  │  │  └──────────┐
         │            │             │  │  │  │             │
         │            ▼             │  │  │  ▼             ▼
         │   ┌────────────────┐     │  │  │  ┌──────────────────┐  ┌───────────────┐
         │   │  documentos    │     │  │  │  │   comentarios    │  │ eventos_      │
         │   │  (archivos)    │     │  │  │  │   (notas int.)   │  │ timeline      │
         │   └────────────────┘     │  │  │  └──────────────────┘  └───────────────┘
         │                          │  │  │
         │                          ▼  │  ▼
         │                ┌────────────┐│ ┌───────────────────┐
         │                │  estudios   ││ │     pagos          │
         │                │  (riesgo)   ││ │  (transacciones)   │
         │                └────────────┘│ └─────────┬──────────┘
         │                              │           │
         │ N:1                          ▼           │ 1:N
         │                    ┌───────────────────┐ │
         └───────────────────▶│    contratos       │ │
                              │  (arrendamiento)   │ │
                              └─────────┬──────────┘ │
                                        │            │
                                        │ 1:N        ▼
                                        ▼   ┌───────────────────┐
                              ┌─────────────┐│    facturas       │
                              │   firmas     ││  (facturacion)    │
                              │  (OTP/elect.)│└───────────────────┘
                              └─────────────┘
```

### Resumen de cardinalidades

| Relacion | Cardinalidad |
|----------|-------------|
| perfiles → inmuebles | 1:N (propietario_id) |
| perfiles → expedientes | 1:N (analista_id) |
| perfiles → bitacora | 1:N (usuario_id) |
| perfiles → comentarios | 1:N (usuario_id) |
| perfiles → documentos | 1:N (validado_por) |
| perfiles → estudios | 1:N (solicitado_por) |
| perfiles → eventos_timeline | 1:N (usuario_id) |
| inmuebles → expedientes | 1:N (inmueble_id) |
| solicitantes → expedientes | 1:N (solicitante_id) |
| expedientes → documentos | 1:N (expediente_id) |
| expedientes → estudios | 1:N (expediente_id) |
| expedientes → contratos | 1:N (expediente_id) |
| expedientes → pagos | 1:N (expediente_id) |
| expedientes → facturas | 1:N (expediente_id) |
| expedientes → comentarios | 1:N (expediente_id) |
| expedientes → eventos_timeline | 1:N (expediente_id) |
| plantillas_contrato → contratos | 1:N (plantilla_id) |
| contratos → firmas | 1:N (contrato_id) |
| pagos → facturas | 1:N (pago_id) |
| solicitantes → autorizaciones_habeas_data | 1:N (solicitante_id) |
| autorizaciones_habeas_data → estudios | 1:N (autorizacion_habeas_data_id) |
| perfiles → autorizaciones_habeas_data | 1:N (generado_por) |

---

## 3. Detalle por Entidad

### 3.1 perfiles

Usuarios internos del sistema. Extiende la tabla `auth.users` de Supabase Auth. Se crea automaticamente al registrarse un usuario mediante el trigger `on_auth_user_created`.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | - | PK, referencia a `auth.users(id)` |
| nombre | VARCHAR(100) | NO | - | Nombre del usuario |
| apellido | VARCHAR(100) | NO | - | Apellido del usuario |
| telefono | VARCHAR(20) | SI | NULL | Telefono de contacto |
| tipo_documento | tipo_documento_id | SI | NULL | Tipo de documento de identidad |
| numero_documento | VARCHAR(20) | SI | NULL | Numero de documento |
| rol | rol_usuario | NO | 'operador_analista' | Rol dentro del sistema |
| estado | estado_usuario | NO | 'activo' | Estado del usuario |
| avatar_url | TEXT | SI | NULL | URL de la foto de perfil |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |
| updated_at | TIMESTAMPTZ | NO | NOW() | Fecha de ultima modificacion |

**Foreign Keys:** `id` → `auth.users(id)` ON DELETE CASCADE

**Triggers:** `perfiles_updated_at` (actualiza `updated_at`), `on_auth_user_created` (crea perfil al registrar usuario en Auth)

**Tablas relacionadas:** inmuebles, expedientes, documentos, estudios, bitacora, comentarios, eventos_timeline

---

### 3.2 inmuebles

Propiedades registradas para arrendamiento. El codigo (`INM-XXX`) se genera automaticamente mediante trigger.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| codigo | VARCHAR(10) | SI | Auto (INM-XXX) | Codigo unico auto-generado |
| direccion | VARCHAR(300) | NO | - | Direccion completa del inmueble |
| ciudad | VARCHAR(100) | NO | - | Ciudad donde se ubica |
| barrio | VARCHAR(100) | SI | NULL | Barrio o zona |
| departamento | VARCHAR(100) | NO | - | Departamento (division administrativa) |
| tipo | tipo_inmueble | NO | - | Tipo de inmueble (apartamento, casa, etc.) |
| uso | uso_inmueble | NO | 'vivienda' | Uso del inmueble (vivienda o comercial) |
| estrato | SMALLINT | NO | - | Estrato socioeconomico (1-6) |
| valor_arriendo | NUMERIC(12,2) | NO | - | Canon mensual de arrendamiento (COP) |
| valor_comercial | NUMERIC(14,2) | SI | NULL | Valor comercial estimado |
| administracion | NUMERIC(10,2) | SI | 0 | Cuota de administracion mensual |
| area_m2 | NUMERIC(8,2) | SI | NULL | Area en metros cuadrados |
| habitaciones | SMALLINT | SI | 0 | Numero de habitaciones |
| banos | SMALLINT | SI | 0 | Numero de banos |
| parqueadero | BOOLEAN | SI | FALSE | Tiene parqueadero |
| descripcion | TEXT | SI | NULL | Descripcion publica del inmueble |
| notas_internas | TEXT | SI | NULL | Notas visibles solo para el equipo |
| estado | estado_inmueble | NO | 'disponible' | Estado actual del inmueble |
| propietario_id | UUID | NO | - | Perfil del propietario |
| visible_vitrina | BOOLEAN | NO | FALSE | Visible en la vitrina publica |
| foto_fachada_url | TEXT | SI | NULL | URL de la foto principal |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |
| updated_at | TIMESTAMPTZ | NO | NOW() | Fecha de ultima modificacion |

**Foreign Keys:** `propietario_id` → `perfiles(id)`

**Constraints:** `estrato` BETWEEN 1 AND 6, `valor_arriendo` > 0, `codigo` UNIQUE

**Indices:** `idx_inmuebles_propietario`, `idx_inmuebles_estado`, `idx_inmuebles_ciudad`, `idx_inmuebles_visible` (parcial, WHERE visible_vitrina = TRUE)

**Triggers:** `inmuebles_updated_at`, `inmuebles_generar_codigo`

**Tablas relacionadas:** perfiles (propietario), expedientes

---

### 3.3 solicitantes

Personas (naturales o juridicas) que solicitan arrendar un inmueble. Un solicitante puede participar en multiples expedientes.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| nombre | VARCHAR(100) | NO | - | Nombre del solicitante |
| apellido | VARCHAR(100) | NO | - | Apellido del solicitante |
| tipo_documento | tipo_documento_id | NO | 'cc' | Tipo de documento de identidad |
| numero_documento | VARCHAR(20) | NO | - | Numero de documento |
| email | VARCHAR(255) | NO | - | Correo electronico |
| telefono | VARCHAR(20) | SI | NULL | Telefono de contacto |
| tipo_persona | tipo_persona | NO | 'natural' | Natural o juridica |
| direccion | VARCHAR(300) | SI | NULL | Direccion de residencia actual |
| departamento | VARCHAR(100) | SI | NULL | Departamento de residencia |
| ciudad | VARCHAR(100) | SI | NULL | Ciudad de residencia |
| ocupacion | VARCHAR(100) | SI | NULL | Ocupacion o profesion |
| actividad_economica | VARCHAR(200) | SI | NULL | Actividad economica principal |
| empresa | VARCHAR(200) | SI | NULL | Empresa donde trabaja |
| ingresos_mensuales | NUMERIC(12,2) | SI | NULL | Ingresos mensuales declarados (COP) |
| parentesco | VARCHAR(50) | SI | NULL | Parentesco con el arrendatario principal |
| nivel_educativo | VARCHAR(100) | SI | NULL | Nivel de estudios |
| habitara_inmueble | BOOLEAN | SI | TRUE | Indica si vivira en el inmueble |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |
| updated_at | TIMESTAMPTZ | NO | NOW() | Fecha de ultima modificacion |

**Indices:** `idx_solicitantes_email`, `idx_solicitantes_documento` (compuesto: tipo_documento + numero_documento)

**Triggers:** `solicitantes_updated_at`

**Tablas relacionadas:** expedientes, autorizaciones_habeas_data

---

### 3.4 expedientes

Caso de arrendamiento que vincula un inmueble con un solicitante. Nucleo del flujo de negocio. El numero (`EXP-YYYY-XXXX`) se genera automaticamente.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| numero | VARCHAR(20) | SI | Auto (EXP-YYYY-XXXX) | Numero unico auto-generado |
| inmueble_id | UUID | NO | - | Inmueble asociado |
| solicitante_id | UUID | NO | - | Solicitante principal |
| codeudor_nombre | VARCHAR(200) | SI | NULL | Nombre del codeudor (si aplica) |
| codeudor_tipo_documento | tipo_documento_id | SI | NULL | Tipo de documento del codeudor |
| codeudor_documento | VARCHAR(20) | SI | NULL | Numero de documento del codeudor |
| codeudor_parentesco | VARCHAR(50) | SI | NULL | Parentesco del codeudor con solicitante |
| estado | estado_expediente | NO | 'borrador' | Estado actual del expediente |
| analista_id | UUID | SI | NULL | Analista asignado al caso |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |
| updated_at | TIMESTAMPTZ | NO | NOW() | Fecha de ultima modificacion |

**Foreign Keys:** `inmueble_id` → `inmuebles(id)`, `solicitante_id` → `solicitantes(id)`, `analista_id` → `perfiles(id)`

**Constraints:** `numero` UNIQUE

**Indices:** `idx_expedientes_inmueble`, `idx_expedientes_solicitante`, `idx_expedientes_analista`, `idx_expedientes_estado`

**Triggers:** `expedientes_updated_at`, `expedientes_generar_numero`

**Tablas relacionadas:** inmuebles, solicitantes, perfiles (analista), documentos, estudios, contratos, pagos, facturas, comentarios, eventos_timeline

---

### 3.5 documentos

Archivos adjuntos subidos al expediente (cedulas, certificados laborales, comprobantes, etc.). Soportan versionado y validacion por un analista.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| expediente_id | UUID | NO | - | Expediente al que pertenece |
| tipo | tipo_documento_archivo | NO | - | Tipo de documento |
| archivo_url | TEXT | NO | - | URL del archivo en Supabase Storage |
| nombre_original | VARCHAR(255) | NO | - | Nombre original del archivo subido |
| tipo_mime | VARCHAR(100) | SI | NULL | Tipo MIME del archivo |
| tamano_bytes | BIGINT | SI | NULL | Tamano del archivo en bytes |
| estado | estado_documento | NO | 'pendiente' | Estado de validacion |
| motivo_rechazo | TEXT | SI | NULL | Razon del rechazo (si aplica) |
| version | SMALLINT | NO | 1 | Numero de version del documento |
| validado_por | UUID | SI | NULL | Perfil que aprobo/rechazo |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de subida |

**Foreign Keys:** `expediente_id` → `expedientes(id)` ON DELETE CASCADE, `validado_por` → `perfiles(id)`

**Indices:** `idx_documentos_expediente`, `idx_documentos_estado`

**Tablas relacionadas:** expedientes, perfiles (validador)

---

### 3.6 estudios

Estudios de riesgo crediticio realizados al solicitante a traves de centrales de riesgo o de forma manual.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| expediente_id | UUID | NO | - | Expediente asociado |
| tipo | tipo_estudio | NO | 'individual' | Individual o con coarrendatario |
| proveedor | proveedor_estudio | NO | 'manual' | Central de riesgo utilizada |
| resultado | resultado_estudio | NO | 'pendiente' | Resultado del estudio |
| score | INTEGER | SI | NULL | Puntaje crediticio obtenido |
| observaciones | TEXT | SI | NULL | Observaciones del analista |
| certificado_url | TEXT | SI | NULL | URL del certificado del estudio |
| codigo_qr | TEXT | SI | NULL | Codigo QR de verificacion |
| duracion_contrato_meses | SMALLINT | SI | NULL | Duracion recomendada del contrato |
| solicitado_por | UUID | SI | NULL | Perfil que solicito el estudio |
| autorizacion_habeas_data_id | UUID | SI | NULL | Autorizacion Habeas Data que habilita este estudio (agregado por migracion 20260216000002) |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |

**Foreign Keys:** `expediente_id` → `expedientes(id)`, `solicitado_por` → `perfiles(id)`, `autorizacion_habeas_data_id` → `autorizaciones_habeas_data(id)`

**Indices:** `idx_estudios_expediente`, `idx_estudios_autorizacion`

**Tablas relacionadas:** expedientes, perfiles (solicitante del estudio), autorizaciones_habeas_data

---

### 3.7 plantillas_contrato

Plantillas reutilizables para generar contratos de arrendamiento. Contienen variables en formato JSONB que se sustituyen al generar un contrato.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| nombre | VARCHAR(200) | NO | - | Nombre de la plantilla |
| descripcion | TEXT | SI | NULL | Descripcion del uso de la plantilla |
| contenido_url | TEXT | SI | NULL | URL del archivo de plantilla |
| variables | JSONB | SI | '[]' | Lista de variables sustituibles |
| activa | BOOLEAN | NO | TRUE | Si la plantilla esta disponible para uso |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |
| updated_at | TIMESTAMPTZ | NO | NOW() | Fecha de ultima modificacion |

**Triggers:** `plantillas_contrato_updated_at`

**Tablas relacionadas:** contratos

---

### 3.8 contratos

Contratos de arrendamiento generados a partir de un expediente aprobado. Pueden crearse desde una plantilla.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| expediente_id | UUID | NO | - | Expediente asociado |
| plantilla_id | UUID | SI | NULL | Plantilla utilizada para generar |
| version | SMALLINT | NO | 1 | Version del contrato |
| estado | estado_contrato | NO | 'borrador' | Estado actual del contrato |
| contenido_url | TEXT | SI | NULL | URL del documento del contrato |
| documento_firmado_url | TEXT | SI | NULL | URL del contrato firmado |
| fecha_inicio | DATE | SI | NULL | Fecha de inicio de vigencia |
| fecha_fin | DATE | SI | NULL | Fecha de fin de vigencia |
| duracion_meses | SMALLINT | SI | NULL | Duracion en meses |
| valor_arriendo | NUMERIC(12,2) | SI | NULL | Canon pactado en el contrato |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |
| updated_at | TIMESTAMPTZ | NO | NOW() | Fecha de ultima modificacion |

**Foreign Keys:** `expediente_id` → `expedientes(id)`, `plantilla_id` → `plantillas_contrato(id)`

**Constraints:** `chk_contratos_fechas` CHECK (fecha_fin IS NULL OR fecha_inicio IS NULL OR fecha_fin > fecha_inicio)

**Indices:** `idx_contratos_expediente`

**Triggers:** `contratos_updated_at`

**Tablas relacionadas:** expedientes, plantillas_contrato, firmas

---

### 3.9 firmas

Registros de firma electronica para cada parte del contrato (arrendatario, propietario, codeudor). Utiliza verificacion por OTP.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| contrato_id | UUID | NO | - | Contrato a firmar |
| tipo_firmante | tipo_firmante | NO | - | Rol del firmante (arrendatario, propietario, codeudor) |
| nombre_firmante | VARCHAR(200) | NO | - | Nombre completo del firmante |
| email_firmante | VARCHAR(255) | SI | NULL | Email para enviar enlace de firma |
| enlace_firma | TEXT | SI | NULL | URL unica de firma |
| codigo_otp | VARCHAR(10) | SI | NULL | Codigo OTP para verificacion |
| otp_expiracion | TIMESTAMPTZ | SI | NULL | Fecha de expiracion del OTP |
| firmado_en | TIMESTAMPTZ | SI | NULL | Fecha y hora de la firma |
| ip_firmante | VARCHAR(45) | SI | NULL | IP desde donde se firmo |
| user_agent | TEXT | SI | NULL | User agent del navegador al firmar |
| evidencia_url | TEXT | SI | NULL | URL de la evidencia de firma |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |

**Foreign Keys:** `contrato_id` → `contratos(id)` ON DELETE CASCADE

**Constraints:** `uq_firmas_contrato_tipo` UNIQUE (contrato_id, tipo_firmante)

**Indices:** `idx_firmas_contrato`

**Tablas relacionadas:** contratos

---

### 3.10 pagos

Pagos realizados dentro del proceso de arrendamiento: estudio de riesgo, deposito o mensualidad.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| expediente_id | UUID | NO | - | Expediente asociado |
| tipo | tipo_pago | NO | - | Tipo de pago (estudio, deposito, mensualidad) |
| monto | NUMERIC(12,2) | NO | - | Monto del pago (COP) |
| estado | estado_pago | NO | 'pendiente' | Estado de la transaccion |
| referencia_pasarela | VARCHAR(255) | SI | NULL | ID de referencia en Stripe |
| metodo_pago | VARCHAR(50) | SI | NULL | Metodo utilizado (tarjeta, PSE, etc.) |
| comprobante_url | TEXT | SI | NULL | URL del comprobante de pago |
| fecha_pago | TIMESTAMPTZ | SI | NULL | Fecha efectiva del pago |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |

**Foreign Keys:** `expediente_id` → `expedientes(id)`

**Constraints:** `monto` > 0

**Indices:** `idx_pagos_expediente`, `idx_pagos_estado`

**Tablas relacionadas:** expedientes, facturas

---

### 3.11 facturas

Solicitudes de facturacion asociadas a un pago. Registran datos fiscales del solicitante.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| pago_id | UUID | SI | NULL | Pago asociado |
| expediente_id | UUID | NO | - | Expediente asociado |
| numero_factura | VARCHAR(50) | SI | NULL | Numero de factura emitida |
| razon_social | VARCHAR(300) | SI | NULL | Razon social del receptor |
| nit | VARCHAR(20) | SI | NULL | NIT del receptor |
| direccion_fiscal | VARCHAR(300) | SI | NULL | Direccion fiscal del receptor |
| estado | estado_factura | NO | 'solicitada' | Estado de la factura |
| archivo_url | TEXT | SI | NULL | URL del PDF de la factura |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |
| updated_at | TIMESTAMPTZ | NO | NOW() | Fecha de ultima modificacion |

**Foreign Keys:** `pago_id` → `pagos(id)`, `expediente_id` → `expedientes(id)`

**Indices:** `idx_facturas_expediente`, `idx_facturas_pago`

**Triggers:** `facturas_updated_at`

**Tablas relacionadas:** pagos, expedientes

---

### 3.12 bitacora

Registro de auditoria de todas las acciones relevantes del sistema. Referencia generica a cualquier entidad mediante `entidad` + `entidad_id`.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| usuario_id | UUID | SI | NULL | Usuario que realizo la accion |
| accion | VARCHAR(100) | NO | - | Accion realizada (crear, actualizar, eliminar, etc.) |
| entidad | VARCHAR(50) | NO | - | Nombre de la tabla afectada |
| entidad_id | UUID | SI | NULL | ID del registro afectado |
| detalle | JSONB | SI | NULL | Detalles adicionales (campos modificados, valores anteriores, etc.) |
| ip | VARCHAR(45) | SI | NULL | IP del usuario |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha y hora de la accion |

**Foreign Keys:** `usuario_id` → `perfiles(id)`

**Indices:** `idx_bitacora_usuario`, `idx_bitacora_entidad` (compuesto: entidad + entidad_id), `idx_bitacora_created` (DESC)

**Tablas relacionadas:** perfiles (usuario), todas las demas tablas (referencia generica)

---

### 3.13 comentarios

Notas y comentarios internos que los analistas y operadores agregan a un expediente.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| expediente_id | UUID | NO | - | Expediente comentado |
| usuario_id | UUID | NO | - | Usuario que escribio el comentario |
| texto | TEXT | NO | - | Contenido del comentario |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |

**Foreign Keys:** `expediente_id` → `expedientes(id)` ON DELETE CASCADE, `usuario_id` → `perfiles(id)`

**Indices:** `idx_comentarios_expediente`

**Tablas relacionadas:** expedientes, perfiles

---

### 3.14 eventos_timeline

Linea de tiempo de eventos relevantes que ocurren durante el ciclo de vida de un expediente. Proporciona trazabilidad visual del proceso.

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Clave primaria |
| expediente_id | UUID | NO | - | Expediente asociado |
| tipo | tipo_evento_timeline | NO | - | Tipo de evento |
| descripcion | TEXT | NO | - | Descripcion del evento |
| usuario_id | UUID | SI | NULL | Usuario que genero el evento (NULL si fue automatico) |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha del evento |

**Foreign Keys:** `expediente_id` → `expedientes(id)` ON DELETE CASCADE, `usuario_id` → `perfiles(id)`

**Indices:** `idx_eventos_timeline_expediente`, `idx_eventos_timeline_created` (DESC)

**Tablas relacionadas:** expedientes, perfiles

---

### 3.15 autorizaciones_habeas_data

Autorizaciones de consulta crediticia otorgadas por los solicitantes conforme a la Ley 1581 de 2012 (Habeas Data) y la Ley 1266 de 2008. Soporta dos canales: registro web (el solicitante acepta al registrarse) y enlace presencial (un administrador genera un enlace unico para firma en oficina).

| Campo | Tipo | Nullable | Default | Descripcion |
|-------|------|----------|---------|-------------|
| id | UUID | NO | gen_random_uuid() | Identificador unico |
| solicitante_id | UUID | NO | - | Solicitante que otorga la autorizacion |
| canal | canal_autorizacion_habeas | NO | - | Canal: 'web' o 'enlace' |
| estado | estado_autorizacion_habeas | NO | 'pendiente' | Estado de la autorizacion |
| token | VARCHAR(255) | SI | NULL | Token unico para flujo presencial (enlace) |
| token_expiracion | TIMESTAMPTZ | SI | NULL | Expiracion del enlace |
| generado_por | UUID | SI | NULL | Usuario que genero el enlace (para canal 'enlace') |
| autorizado_en | TIMESTAMPTZ | SI | NULL | Fecha/hora de aceptacion |
| ip_autorizacion | VARCHAR(45) | SI | NULL | IP del solicitante al autorizar |
| user_agent | TEXT | SI | NULL | Navegador del solicitante al autorizar |
| texto_autorizado | TEXT | SI | NULL | Texto legal exacto que fue aceptado |
| version_terminos | VARCHAR(50) | SI | NULL | Version de los terminos aceptados |
| created_at | TIMESTAMPTZ | NO | NOW() | Fecha de creacion |

**Foreign Keys:** `solicitante_id` → `solicitantes(id)`, `generado_por` → `perfiles(id)`

**Indices:** `idx_autorizaciones_solicitante`, `idx_autorizaciones_token`, `idx_autorizaciones_estado`

**Tablas relacionadas:** solicitantes, perfiles (generador del enlace), estudios (via estudios.autorizacion_habeas_data_id)

---

## 4. Tipos Enumerados

### rol_usuario
Roles de acceso al sistema.

| Valor | Descripcion |
|-------|-------------|
| `administrador` | Acceso total al sistema, gestion de usuarios y configuracion |
| `operador_analista` | Gestion de expedientes, documentos, estudios y contratos |
| `gerencia_consulta` | Acceso de consulta, reportes y aprobaciones de alto nivel |
| `propietario` | Propietario de inmuebles, acceso a sus propiedades y expedientes |
| `inmobiliaria` | Inmobiliaria asociada, gestion de sus inmuebles |

### estado_usuario
Estado de actividad de un usuario.

| Valor | Descripcion |
|-------|-------------|
| `activo` | Usuario habilitado para acceder al sistema |
| `inactivo` | Usuario deshabilitado, no puede iniciar sesion |

### tipo_documento_id
Tipos de documento de identidad validos en Colombia.

| Valor | Descripcion |
|-------|-------------|
| `cc` | Cedula de ciudadania |
| `nit` | NIT - Numero de Identificacion Tributaria (persona juridica) |
| `ce` | Cedula de extranjeria |
| `pasaporte` | Pasaporte |

### tipo_inmueble
Clasificacion de la propiedad.

| Valor | Descripcion |
|-------|-------------|
| `apartamento` | Unidad en edificio residencial o mixto |
| `casa` | Vivienda independiente |
| `oficina` | Espacio para uso de oficina |
| `local` | Local comercial |

### uso_inmueble
Uso destinado del inmueble.

| Valor | Descripcion |
|-------|-------------|
| `vivienda` | Uso residencial |
| `comercial` | Uso comercial o de oficina |

### estado_inmueble
Estado operativo del inmueble dentro de la plataforma.

| Valor | Descripcion |
|-------|-------------|
| `disponible` | Listo para recibir solicitudes de arriendo |
| `en_estudio` | Tiene un expediente en proceso de evaluacion |
| `ocupado` | Actualmente arrendado con contrato vigente |
| `inactivo` | Retirado temporalmente de la plataforma |

### tipo_persona
Naturaleza juridica del solicitante.

| Valor | Descripcion |
|-------|-------------|
| `natural` | Persona natural (individuo) |
| `juridica` | Persona juridica (empresa, sociedad) |

### estado_expediente
Estados del workflow de un expediente de arrendamiento.

| Valor | Descripcion |
|-------|-------------|
| `borrador` | Recien creado, informacion en captura |
| `en_revision` | Enviado para revision y evaluacion por el analista |
| `informacion_incompleta` | Se requiere documentacion o datos adicionales |
| `aprobado` | Evaluacion favorable, puede proceder a contrato |
| `rechazado` | Evaluacion desfavorable, no se aprueba el arriendo |
| `condicionado` | Aprobado con condiciones (codeudor, deposito extra, etc.) |
| `cerrado` | Expediente finalizado y archivado |

### tipo_documento_archivo
Tipos de documentos que se pueden adjuntar a un expediente.

| Valor | Descripcion |
|-------|-------------|
| `cedula_frontal` | Foto frontal de la cedula de identidad |
| `cedula_posterior` | Foto posterior de la cedula de identidad |
| `certificado_laboral` | Certificado laboral vigente |
| `comprobante_ingresos` | Desprendibles de nomina, declaracion de renta, etc. |
| `comprobante_domicilio` | Recibo de servicio publico u otro comprobante de direccion |
| `referencias` | Cartas de referencia personal o comercial |
| `selfie_con_id` | Foto del solicitante sosteniendo su documento de identidad |
| `otro` | Otro tipo de documento no clasificado |

### estado_documento
Estado de validacion de un documento adjunto.

| Valor | Descripcion |
|-------|-------------|
| `pendiente` | Subido, pendiente de revision por el analista |
| `aprobado` | Revisado y aprobado |
| `rechazado` | Rechazado con motivo, se espera nueva version |

### tipo_estudio
Modalidad del estudio de riesgo.

| Valor | Descripcion |
|-------|-------------|
| `individual` | Estudio solo del solicitante principal |
| `con_coarrendatario` | Estudio que incluye al codeudor/coarrendatario |

### proveedor_estudio
Central de riesgo o proveedor del estudio.

| Valor | Descripcion |
|-------|-------------|
| `transunion` | TransUnion Colombia |
| `sifin` | SIFIN (Sistema de Informacion Financiera) |
| `datacredito` | DataCredito (Experian) |
| `manual` | Evaluacion manual interna |

### resultado_estudio
Resultado de la evaluacion de riesgo.

| Valor | Descripcion |
|-------|-------------|
| `pendiente` | Estudio solicitado, sin resultado aun |
| `aprobado` | Puntaje y perfil favorable |
| `rechazado` | Puntaje o perfil desfavorable |
| `condicionado` | Aprobado con condiciones adicionales |

### estado_contrato
Ciclo de vida del contrato de arrendamiento.

| Valor | Descripcion |
|-------|-------------|
| `borrador` | Contrato en elaboracion |
| `pendiente_firma` | Generado y enviado para firma electronica |
| `firmado` | Todas las partes han firmado |
| `vigente` | Contrato en periodo de vigencia activa |
| `finalizado` | Contrato vencido o terminado normalmente |
| `cancelado` | Contrato cancelado antes de su finalizacion |

### tipo_firmante
Rol de la persona que firma el contrato.

| Valor | Descripcion |
|-------|-------------|
| `arrendatario` | Persona que arrienda el inmueble |
| `propietario` | Dueno del inmueble |
| `codeudor` | Persona que respalda al arrendatario |

### tipo_pago
Concepto del pago realizado.

| Valor | Descripcion |
|-------|-------------|
| `estudio` | Pago por el estudio de riesgo crediticio |
| `deposito` | Deposito de garantia |
| `mensualidad` | Pago mensual de canon de arrendamiento |

### estado_pago
Estado de la transaccion de pago.

| Valor | Descripcion |
|-------|-------------|
| `pendiente` | Pago creado, esperando confirmacion |
| `pagado` | Pago confirmado exitosamente |
| `fallido` | Pago rechazado o fallido |
| `reembolsado` | Pago devuelto al pagador |

### estado_factura
Estado del proceso de facturacion.

| Valor | Descripcion |
|-------|-------------|
| `solicitada` | Factura solicitada, pendiente de emision |
| `emitida` | Factura emitida y disponible |
| `cancelada` | Factura anulada |

### canal_autorizacion_habeas
Canal por el cual el solicitante otorga la autorizacion de consulta Habeas Data.

| Valor | Descripcion |
|-------|-------------|
| `web` | Autorizacion aceptada durante el registro por la plataforma web |
| `enlace` | Autorizacion via enlace unico generado por un administrador para firma presencial |

### estado_autorizacion_habeas
Estado del ciclo de vida de una autorizacion de consulta Habeas Data.

| Valor | Descripcion |
|-------|-------------|
| `pendiente` | Enlace generado, aun no firmado por el solicitante |
| `autorizado` | Autorizacion aceptada por el solicitante |
| `expirado` | El enlace presencial vencio sin ser utilizado |
| `revocado` | Autorizacion revocada por el solicitante |

### tipo_evento_timeline
Tipos de eventos que se registran en la linea de tiempo de un expediente.

| Valor | Descripcion |
|-------|-------------|
| `creacion` | Creacion del expediente |
| `asignacion` | Asignacion de analista |
| `documento` | Subida o validacion de documento |
| `estado` | Cambio de estado del expediente |
| `comentario` | Comentario agregado |
| `estudio` | Solicitud o resultado de estudio de riesgo |
| `contrato` | Generacion o cambio de estado del contrato |
| `firma` | Evento de firma electronica |
| `pago` | Registro o confirmacion de pago |
| `autorizacion` | Evento relacionado con autorizacion Habeas Data |

---

## 5. Convenciones del Modelo

### Claves primarias
- Todas las tablas usan **UUID** como clave primaria, generado con `gen_random_uuid()`.
- Excepcion: `perfiles.id` es un UUID que referencia a `auth.users(id)` de Supabase Auth (no se auto-genera).

### Timestamps
- `created_at` (TIMESTAMPTZ, NOT NULL, DEFAULT NOW()): presente en todas las tablas.
- `updated_at` (TIMESTAMPTZ, NOT NULL, DEFAULT NOW()): presente en tablas que permiten edicion (perfiles, inmuebles, solicitantes, expedientes, plantillas_contrato, contratos, facturas). Se actualiza automaticamente mediante trigger.

### Claves foraneas
- Convencion de nomenclatura: `{tabla_en_singular}_id` (por ejemplo: `expediente_id`, `contrato_id`, `usuario_id`).
- Algunas FK usan nombres descriptivos: `propietario_id`, `analista_id`, `validado_por`, `solicitado_por`.
- Comportamiento ON DELETE: CASCADE en tablas hijas dependientes (documentos, firmas, comentarios, eventos_timeline). Sin accion explicita en las demas.

### Codigos auto-generados
- **Inmuebles:** `INM-XXX` (secuencia `inmueble_codigo_seq`, pad 3 digitos). Ejemplo: INM-001, INM-042.
- **Expedientes:** `EXP-YYYY-XXXX` (ano actual + secuencia `expediente_numero_seq`, pad 4 digitos). Ejemplo: EXP-2026-0001.

### Valores monetarios
- Siempre se usa **NUMERIC(12,2)** para montos. Nunca FLOAT ni DOUBLE.
- `valor_comercial` usa NUMERIC(14,2) por manejar montos mayores.
- `administracion` usa NUMERIC(10,2).
- Moneda implicitamente COP (pesos colombianos).

### Row Level Security (RLS)
- **Habilitado** en las 15 tablas.
- **Sin politicas temporales**: con RLS habilitado y sin politicas definidas, solo `service_role` (que omite RLS) puede acceder. Esto evita exponer datos a los roles `anon` y `authenticated`.
- Las politicas granulares por rol se implementaran en la tarea HP-30.

### Triggers
- `update_updated_at()`: funcion reutilizable que actualiza `updated_at` a `NOW()` en cada UPDATE.
- `generar_codigo_inmueble()`: genera `INM-XXX` al insertar inmueble sin codigo.
- `generar_numero_expediente()`: genera `EXP-YYYY-XXXX` al insertar expediente sin numero.
- `handle_new_user()`: crea automaticamente un registro en `perfiles` al crearse un usuario en `auth.users`.

---

## 6. Relaciones Principales

### Cadena central del negocio

```
perfil (propietario) → inmueble → expediente → contrato → firma
                                      ↓
                                  solicitante
```

1. Un **perfil** (propietario) registra uno o mas **inmuebles**.
2. Un **inmueble** puede tener multiples **expedientes** (uno por cada solicitud de arriendo).
3. Cada **expediente** vincula un inmueble con un **solicitante** y opcionalmente un codeudor.
4. Un **analista** (perfil) se asigna al expediente para gestionarlo.

### Expediente como eje central

El expediente es la entidad central del modelo. Desde el se derivan:

- **Documentos:** Archivos adjuntos que soportan la solicitud (1:N).
- **Estudios:** Evaluaciones de riesgo crediticio del solicitante (1:N).
- **Contratos:** Contratos de arrendamiento generados tras la aprobacion (1:N).
- **Pagos:** Transacciones asociadas al proceso (1:N).
- **Facturas:** Solicitudes de facturacion vinculadas al expediente (1:N).
- **Comentarios:** Notas internas del equipo (1:N).
- **Eventos timeline:** Registro cronologico de todo lo que ocurre en el expediente (1:N).

### Relaciones secundarias

- **Contrato → Firmas:** Un contrato tiene multiples firmas (arrendatario, propietario, codeudor).
- **Pago → Facturas:** Un pago puede tener una o mas facturas asociadas.
- **Plantilla → Contratos:** Una plantilla de contrato se usa para generar multiples contratos.
- **Perfil → Bitacora:** Todas las acciones de un usuario se registran en la bitacora de auditoria.
- **Autorizaciones Habeas Data → Solicitantes:** Cada autorizacion pertenece a un solicitante (N:1).
- **Autorizaciones Habeas Data → Estudios:** Un estudio puede referenciar la autorizacion que lo habilita (via `estudios.autorizacion_habeas_data_id`, 1:N).

---

## 7. Indices

### Indices por tabla

| Indice | Tabla | Columna(s) | Proposito |
|--------|-------|-----------|-----------|
| `idx_solicitantes_email` | solicitantes | email | Buscar solicitante por email |
| `idx_solicitantes_documento` | solicitantes | tipo_documento, numero_documento | Buscar solicitante por documento de identidad |
| `idx_inmuebles_propietario` | inmuebles | propietario_id | Buscar inmuebles de un propietario |
| `idx_inmuebles_estado` | inmuebles | estado | Filtrar inmuebles por estado |
| `idx_inmuebles_ciudad` | inmuebles | ciudad | Buscar inmuebles por ciudad |
| `idx_inmuebles_visible` | inmuebles | visible_vitrina | Parcial: solo WHERE visible_vitrina = TRUE. Vitrina publica |
| `idx_expedientes_inmueble` | expedientes | inmueble_id | Buscar expedientes de un inmueble |
| `idx_expedientes_solicitante` | expedientes | solicitante_id | Buscar expedientes de un solicitante |
| `idx_expedientes_analista` | expedientes | analista_id | Buscar expedientes asignados a un analista |
| `idx_expedientes_estado` | expedientes | estado | Filtrar expedientes por estado |
| `idx_documentos_expediente` | documentos | expediente_id | Listar documentos de un expediente |
| `idx_documentos_estado` | documentos | estado | Filtrar documentos por estado de validacion |
| `idx_estudios_expediente` | estudios | expediente_id | Listar estudios de un expediente |
| `idx_contratos_expediente` | contratos | expediente_id | Listar contratos de un expediente |
| `idx_firmas_contrato` | firmas | contrato_id | Listar firmas de un contrato |
| `idx_pagos_expediente` | pagos | expediente_id | Listar pagos de un expediente |
| `idx_pagos_estado` | pagos | estado | Filtrar pagos por estado |
| `idx_facturas_expediente` | facturas | expediente_id | Listar facturas de un expediente |
| `idx_facturas_pago` | facturas | pago_id | Buscar factura de un pago |
| `idx_bitacora_usuario` | bitacora | usuario_id | Buscar acciones de un usuario |
| `idx_bitacora_entidad` | bitacora | entidad, entidad_id | Buscar auditoria de una entidad especifica |
| `idx_bitacora_created` | bitacora | created_at DESC | Ordenar bitacora cronologicamente (mas recientes primero) |
| `idx_comentarios_expediente` | comentarios | expediente_id | Listar comentarios de un expediente |
| `idx_eventos_timeline_expediente` | eventos_timeline | expediente_id | Listar eventos de un expediente |
| `idx_eventos_timeline_created` | eventos_timeline | created_at DESC | Ordenar timeline cronologicamente |
| `idx_autorizaciones_solicitante` | autorizaciones_habeas_data | solicitante_id | Buscar autorizaciones de un solicitante |
| `idx_autorizaciones_token` | autorizaciones_habeas_data | token | Buscar autorizacion por token (flujo enlace) |
| `idx_autorizaciones_estado` | autorizaciones_habeas_data | estado | Filtrar autorizaciones por estado |
| `idx_estudios_autorizacion` | estudios | autorizacion_habeas_data_id | Buscar estudios por autorizacion Habeas Data |

### Indices implicitos (UNIQUE constraints)

| Tabla | Columna | Tipo |
|-------|---------|------|
| inmuebles | codigo | UNIQUE |
| expedientes | numero | UNIQUE |

---

## 8. Notas de Implementacion

### Integracion con Supabase Auth
- La tabla `perfiles` no tiene auto-generacion de UUID. Su `id` es una **referencia directa** a `auth.users(id)` con ON DELETE CASCADE.
- El trigger `handle_new_user()` (SECURITY DEFINER) se ejecuta automaticamente en `auth.users` y crea el perfil con los datos del campo `raw_user_meta_data` (nombre, apellido, rol).
- El email del usuario se gestiona exclusivamente en `auth.users`, no se duplica en `perfiles`.

### Row Level Security (RLS)
- RLS esta **habilitado** en las 15 tablas desde la migracion inicial.
- **Sin politicas temporales**: con RLS habilitado y sin politicas definidas, solo `service_role` (que omite RLS) puede acceder a los datos. Esto evita exponer datos a los roles `anon` y `authenticated` accidentalmente.
- Las politicas granulares por rol de usuario se implementaran en la tarea **HP-30** (Setup backend con permisos).

### Uso de JSONB
- `bitacora.detalle`: Almacena informacion variable de auditoria (campos modificados, valores anteriores/nuevos, metadata adicional). No tiene esquema fijo.
- `plantillas_contrato.variables`: Lista de variables sustituibles en la plantilla (ej: `[{"nombre": "nombre_arrendatario", "tipo": "texto"}]`). Default: array vacio `'[]'`.

### Secuencias
- `inmueble_codigo_seq`: Secuencia para generar codigos de inmueble. Inicia en 1, se formatea como `INM-XXX`.
- `expediente_numero_seq`: Secuencia para numeros de expediente. Inicia en 1, se formatea como `EXP-YYYY-XXXX`.
- Ambas secuencias son globales y monotonicamente crecientes. No se reinician por ano (la secuencia de expedientes solo incluye el ano en el formato, no en el conteo).

### Consideraciones de diseno
- Los datos del codeudor en `expedientes` estan desnormalizados (nombre, tipo_documento, documento, parentesco) en lugar de referenciar a `solicitantes`. Esto simplifica el flujo cuando el codeudor no necesita un perfil completo.
- La `bitacora` usa una referencia generica (entidad + entidad_id) en lugar de FK tipadas, lo que permite auditar cualquier tabla sin modificar el esquema.
- Las tablas `comentarios` y `eventos_timeline` se eliminan en cascada al borrar un expediente, mientras que `estudios`, `contratos` y `pagos` no, para preservar registros financieros y de evaluacion.

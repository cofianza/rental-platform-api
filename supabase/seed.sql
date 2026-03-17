-- ============================================================
-- Cofianza 2.0 - Seed Data
-- Datos de prueba realistas para Colombia
-- Fecha: 2026-02-16
-- ============================================================
-- NOTA: Este seed NO crea auth.users. Los UUIDs de perfiles
-- corresponden a usuarios que deben existir en auth.users
-- (ya sea creados manualmente o con supabase auth admin).
-- Para desarrollo local, Supabase seed se ejecuta con
-- service_role, por lo que RLS no bloquea las inserciones.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. PERFILES
-- Inserción directa con UUIDs hardcoded.
-- En producción estos registros los crea el trigger
-- on_auth_user_created, pero para seed los insertamos
-- directamente asumiendo que los auth.users ya existen.
-- ============================================================

INSERT INTO perfiles (id, nombre, apellido, telefono, tipo_documento, numero_documento, rol, estado) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'Diego',     'Ramírez',    '+573001234567', 'cc', '1020304050', 'administrador',      'activo'),
  ('a2222222-2222-2222-2222-222222222222', 'Camila',    'Moreno',     '+573109876543', 'cc', '1030405060', 'operador_analista',  'activo'),
  ('a3333333-3333-3333-3333-333333333333', 'Andrés',    'Gutiérrez',  '+573201112233', 'cc', '1040506070', 'operador_analista',  'activo'),
  ('a4444444-4444-4444-4444-444444444444', 'María José','Pérez',      '+573152223344', 'cc', '1050607080', 'gerencia_consulta',  'activo'),
  ('a5555555-5555-5555-5555-555555555555', 'Valentina', 'Rodríguez',  '+573183334455', 'cc', '1060708090', 'operador_analista',  'activo');

-- ============================================================
-- 2. INMUEBLES (10)
-- NO incluir 'codigo' - el trigger generar_codigo_inmueble lo asigna.
-- ============================================================

INSERT INTO inmuebles (id, direccion, ciudad, barrio, departamento, tipo, uso, estrato, valor_arriendo, valor_comercial, administracion, area_m2, habitaciones, banos, parqueadero, descripcion, notas_internas, estado, propietario_id, visible_vitrina) VALUES
  -- Bogotá
  ('b1111111-1111-1111-1111-111111111111',
   'Calle 72 # 10-34, Apto 501',
   'Bogotá', 'Chapinero', 'Cundinamarca',
   'apartamento', 'vivienda', 4,
   2500000.00, 350000000.00, 280000.00,
   68.00, 3, 2, TRUE,
   'Apartamento remodelado en Chapinero Alto con vista a los cerros. Cocina integral, piso en porcelanato.',
   'Propietario responde rápido. Inmueble en excelente estado.',
   'disponible', 'a1111111-1111-1111-1111-111111111111', TRUE),

  ('b2222222-2222-2222-2222-222222222222',
   'Carrera 15 # 85-42, Apto 302',
   'Bogotá', 'Chicó Norte', 'Cundinamarca',
   'apartamento', 'vivienda', 5,
   4500000.00, 580000000.00, 450000.00,
   110.00, 3, 3, TRUE,
   'Amplio apartamento en el Chicó con chimenea, estudio y balcón. Zona exclusiva.',
   'Inmueble premium. Solo solicitantes con ingresos superiores a $12M.',
   'disponible', 'a1111111-1111-1111-1111-111111111111', TRUE),

  ('b3333333-3333-3333-3333-333333333333',
   'Avenida Caracas # 36-12, Local 3',
   'Bogotá', 'Teusaquillo', 'Cundinamarca',
   'local', 'comercial', 4,
   3200000.00, 420000000.00, 180000.00,
   85.00, 0, 1, FALSE,
   'Local comercial sobre la Avenida Caracas, alto flujo peatonal. Ideal para restaurante o tienda.',
   NULL,
   'disponible', 'a2222222-2222-2222-2222-222222222222', TRUE),

  -- Medellín
  ('b4444444-4444-4444-4444-444444444444',
   'Calle 10 # 43D-36, Apto 1204',
   'Medellín', 'El Poblado', 'Antioquia',
   'apartamento', 'vivienda', 5,
   3800000.00, 490000000.00, 520000.00,
   95.00, 2, 2, TRUE,
   'Apartamento moderno en El Poblado con piscina y gimnasio en conjunto. Acabados de lujo.',
   'Conjunto con vigilancia 24h.',
   'en_estudio', 'a1111111-1111-1111-1111-111111111111', TRUE),

  ('b5555555-5555-5555-5555-555555555555',
   'Carrera 76 # 33AA-08',
   'Medellín', 'Laureles', 'Antioquia',
   'casa', 'vivienda', 4,
   2200000.00, 380000000.00, 0.00,
   120.00, 4, 3, TRUE,
   'Casa amplia en Laureles con patio trasero, garaje doble. Zona residencial tranquila.',
   'El propietario vive en el exterior, contactar por WhatsApp.',
   'disponible', 'a3333333-3333-3333-3333-333333333333', TRUE),

  ('b6666666-6666-6666-6666-666666666666',
   'Calle 52 # 49-40, Oficina 601',
   'Medellín', 'Centro', 'Antioquia',
   'oficina', 'comercial', 3,
   1800000.00, 240000000.00, 150000.00,
   55.00, 0, 1, FALSE,
   'Oficina en edificio corporativo del centro de Medellín. Incluye aire acondicionado central.',
   NULL,
   'disponible', 'a2222222-2222-2222-2222-222222222222', FALSE),

  -- Cali
  ('b7777777-7777-7777-7777-777777777777',
   'Calle 5 # 38-25, Apto 803',
   'Cali', 'San Fernando', 'Valle del Cauca',
   'apartamento', 'vivienda', 4,
   1800000.00, 260000000.00, 220000.00,
   72.00, 3, 2, TRUE,
   'Apartamento con excelente ubicación cerca al Río Cali. Ventilación cruzada, muy fresco.',
   NULL,
   'ocupado', 'a3333333-3333-3333-3333-333333333333', FALSE),

  ('b8888888-8888-8888-8888-888888888888',
   'Avenida 6N # 28N-45',
   'Cali', 'Granada', 'Valle del Cauca',
   'casa', 'vivienda', 3,
   1200000.00, 180000000.00, 0.00,
   90.00, 3, 2, FALSE,
   'Casa en barrio Granada, cerca a centros comerciales. Zona tranquila y familiar.',
   'Requiere reparación menor en el baño del segundo piso.',
   'disponible', 'a5555555-5555-5555-5555-555555555555', TRUE),

  -- Barranquilla
  ('b9999999-9999-9999-9999-999999999999',
   'Carrera 53 # 75-129, Apto 201',
   'Barranquilla', 'Alto Prado', 'Atlántico',
   'apartamento', 'vivienda', 4,
   1600000.00, 220000000.00, 200000.00,
   65.00, 2, 2, TRUE,
   'Apartamento en Alto Prado, brisa permanente, cerca a centros comerciales y al malecón.',
   NULL,
   'en_estudio', 'a1111111-1111-1111-1111-111111111111', TRUE),

  -- Bucaramanga
  ('ba000000-0000-0000-0000-000000000001',
   'Calle 45 # 28-30, Apto 404',
   'Bucaramanga', 'Cabecera del Llano', 'Santander',
   'apartamento', 'vivienda', 3,
   1100000.00, 160000000.00, 150000.00,
   58.00, 2, 1, FALSE,
   'Apartamento acogedor en Cabecera del Llano, cerca al parque San Pío y universidades.',
   'Edificio antiguo pero bien mantenido.',
   'disponible', 'a5555555-5555-5555-5555-555555555555', FALSE);

-- ============================================================
-- 3. SOLICITANTES (8)
-- ============================================================

INSERT INTO solicitantes (id, nombre, apellido, tipo_documento, numero_documento, email, telefono, tipo_persona, direccion, departamento, ciudad, ocupacion, actividad_economica, empresa, ingresos_mensuales, parentesco, nivel_educativo, habitara_inmueble) VALUES
  ('c1111111-1111-1111-1111-111111111111',
   'Juan Carlos', 'López Martínez',
   'cc', '1000000001', 'juancarlos.lopez@gmail.com', '+573014567890',
   'natural', 'Calle 100 # 15-20, Apto 301', 'Cundinamarca', 'Bogotá',
   'Ingeniero de Sistemas', 'Desarrollo de software', 'Globant Colombia SAS',
   7500000.00, NULL, 'Profesional universitario', TRUE),

  ('c2222222-2222-2222-2222-222222222222',
   'María Fernanda', 'Torres Vargas',
   'cc', '1000000002', 'mafe.torres@outlook.com', '+573128901234',
   'natural', 'Carrera 80 # 34-12', 'Antioquia', 'Medellín',
   'Abogada', 'Asesoría jurídica', 'Baker McKenzie',
   6200000.00, NULL, 'Especialización', TRUE),

  ('c3333333-3333-3333-3333-333333333333',
   'Carlos Andrés', 'Herrera Ospina',
   'cc', '1000000003', 'carlos.herrera@yahoo.com', '+573205678901',
   'natural', 'Avenida 3N # 50-22', 'Valle del Cauca', 'Cali',
   'Contador Público', 'Contabilidad y auditoría', 'Deloitte Colombia',
   5800000.00, NULL, 'Profesional universitario', TRUE),

  ('c4444444-4444-4444-4444-444444444444',
   'Laura', 'Sánchez Restrepo',
   'cc', '1000000004', 'laura.sanchez.r@gmail.com', '+573159012345',
   'natural', 'Calle 72 # 55-30', 'Atlántico', 'Barranquilla',
   'Médica General', 'Salud', 'Clínica del Caribe',
   8000000.00, NULL, 'Especialización', TRUE),

  ('c5555555-5555-5555-5555-555555555555',
   'Restaurantes El Corral', 'SAS',
   'nit', '900123456',  'contacto@elcorral.com', '+576014567890',
   'juridica', 'Calle 85 # 15-30, Piso 5', 'Cundinamarca', 'Bogotá',
   NULL, 'Restaurantes y comidas rápidas', 'Restaurantes El Corral SAS',
   45000000.00, NULL, NULL, FALSE),

  ('c6666666-6666-6666-6666-666666666666',
   'Sebastián', 'Mejía Duque',
   'cc', '1000000006', 'sebastian.mejia@hotmail.com', '+573176789012',
   'natural', 'Carrera 43A # 1Sur-50', 'Antioquia', 'Medellín',
   'Diseñador Gráfico', 'Diseño y publicidad', 'Freelance',
   3500000.00, NULL, 'Profesional universitario', TRUE),

  ('c7777777-7777-7777-7777-777777777777',
   'Ana María', 'Castillo Beltrán',
   'cc', '1000000007', 'anamaria.castillo@gmail.com', '+573198901234',
   'natural', 'Calle 45 # 22-18', 'Santander', 'Bucaramanga',
   'Profesora Universitaria', 'Educación superior', 'Universidad Industrial de Santander',
   4200000.00, NULL, 'Maestría', TRUE),

  ('c8888888-8888-8888-8888-888888888888',
   'Felipe', 'Ríos Castaño',
   'cc', '1000000008', 'felipe.rios@live.com', '+573041234567',
   'natural', 'Calle 93 # 12-55', 'Cundinamarca', 'Bogotá',
   'Analista Financiero', 'Servicios financieros', 'Bancolombia SA',
   6800000.00, NULL, 'Profesional universitario', TRUE);

-- ============================================================
-- 4. EXPEDIENTES (15)
-- NO incluir 'numero' - el trigger generar_numero_expediente lo asigna.
-- ============================================================

-- 3 borradores
INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('d1111111-1111-1111-1111-111111111111',
   'b1111111-1111-1111-1111-111111111111',  -- Apto Chapinero, Bogotá
   'c1111111-1111-1111-1111-111111111111',  -- Juan Carlos López
   'borrador',
   'a2222222-2222-2222-2222-222222222222'); -- Camila

INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('d2222222-2222-2222-2222-222222222222',
   'ba000000-0000-0000-0000-000000000001',  -- Apto Bucaramanga
   'c7777777-7777-7777-7777-777777777777',  -- Ana María Castillo
   'borrador',
   'a5555555-5555-5555-5555-555555555555'); -- Valentina

INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('d3333333-3333-3333-3333-333333333333',
   'b8888888-8888-8888-8888-888888888888',  -- Casa Granada, Cali
   'c3333333-3333-3333-3333-333333333333',  -- Carlos Andrés Herrera
   'borrador',
   NULL);

-- 4 en_revision
INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('d4444444-4444-4444-4444-444444444444',
   'b2222222-2222-2222-2222-222222222222',  -- Apto Chicó, Bogotá
   'c8888888-8888-8888-8888-888888888888',  -- Felipe Ríos
   'en_revision',
   'a2222222-2222-2222-2222-222222222222'); -- Camila

INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('d5555555-5555-5555-5555-555555555555',
   'b4444444-4444-4444-4444-444444444444',  -- Apto El Poblado, Medellín
   'c2222222-2222-2222-2222-222222222222',  -- María Fernanda Torres
   'en_revision',
   'a3333333-3333-3333-3333-333333333333'); -- Andrés

INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('d6666666-6666-6666-6666-666666666666',
   'b5555555-5555-5555-5555-555555555555',  -- Casa Laureles, Medellín
   'c6666666-6666-6666-6666-666666666666',  -- Sebastián Mejía
   'en_revision',
   'a3333333-3333-3333-3333-333333333333'); -- Andrés

INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('d7777777-7777-7777-7777-777777777777',
   'b9999999-9999-9999-9999-999999999999',  -- Apto Alto Prado, Barranquilla
   'c4444444-4444-4444-4444-444444444444',  -- Laura Sánchez
   'en_revision',
   'a5555555-5555-5555-5555-555555555555'); -- Valentina

-- 2 informacion_incompleta
INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('d8888888-8888-8888-8888-888888888888',
   'b1111111-1111-1111-1111-111111111111',  -- Apto Chapinero (otro solicitante)
   'c6666666-6666-6666-6666-666666666666',  -- Sebastián Mejía (también aplica a otro)
   'informacion_incompleta',
   'a2222222-2222-2222-2222-222222222222'); -- Camila

INSERT INTO expedientes (id, inmueble_id, solicitante_id, codeudor_nombre, codeudor_tipo_documento, codeudor_documento, codeudor_parentesco, estado, analista_id) VALUES
  ('d9999999-9999-9999-9999-999999999999',
   'b6666666-6666-6666-6666-666666666666',  -- Oficina Centro, Medellín
   'c5555555-5555-5555-5555-555555555555',  -- El Corral SAS
   'Roberto Mejía Arias', 'cc', '1098765432', 'Representante Legal',
   'informacion_incompleta',
   'a3333333-3333-3333-3333-333333333333'); -- Andrés

-- 3 aprobados
INSERT INTO expedientes (id, inmueble_id, solicitante_id, codeudor_nombre, codeudor_tipo_documento, codeudor_documento, codeudor_parentesco, estado, analista_id) VALUES
  ('da000000-0000-0000-0000-000000000001',
   'b3333333-3333-3333-3333-333333333333',  -- Local Teusaquillo, Bogotá
   'c5555555-5555-5555-5555-555555555555',  -- El Corral SAS
   'Roberto Mejía Arias', 'cc', '1098765432', 'Representante Legal',
   'aprobado',
   'a2222222-2222-2222-2222-222222222222'); -- Camila

INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('da000000-0000-0000-0000-000000000002',
   'b7777777-7777-7777-7777-777777777777',  -- Apto San Fernando, Cali (ocupado)
   'c3333333-3333-3333-3333-333333333333',  -- Carlos Andrés Herrera
   'aprobado',
   'a5555555-5555-5555-5555-555555555555'); -- Valentina

INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('da000000-0000-0000-0000-000000000003',
   'b5555555-5555-5555-5555-555555555555',  -- Casa Laureles, Medellín
   'c2222222-2222-2222-2222-222222222222',  -- María Fernanda Torres
   'aprobado',
   'a3333333-3333-3333-3333-333333333333'); -- Andrés

-- 1 rechazado
INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('da000000-0000-0000-0000-000000000004',
   'b2222222-2222-2222-2222-222222222222',  -- Apto Chicó, Bogotá
   'c6666666-6666-6666-6666-666666666666',  -- Sebastián Mejía (ingresos insuficientes)
   'rechazado',
   'a2222222-2222-2222-2222-222222222222'); -- Camila

-- 1 condicionado
INSERT INTO expedientes (id, inmueble_id, solicitante_id, codeudor_nombre, codeudor_tipo_documento, codeudor_documento, codeudor_parentesco, estado, analista_id) VALUES
  ('da000000-0000-0000-0000-000000000005',
   'b9999999-9999-9999-9999-999999999999',  -- Apto Barranquilla
   'c8888888-8888-8888-8888-888888888888',  -- Felipe Ríos
   'Gloria Castaño de Ríos', 'cc', '41987654', 'Madre',
   'condicionado',
   'a5555555-5555-5555-5555-555555555555'); -- Valentina

-- 1 cerrado
INSERT INTO expedientes (id, inmueble_id, solicitante_id, estado, analista_id) VALUES
  ('da000000-0000-0000-0000-000000000006',
   'b8888888-8888-8888-8888-888888888888',  -- Casa Granada, Cali
   'c4444444-4444-4444-4444-444444444444',  -- Laura Sánchez
   'cerrado',
   'a2222222-2222-2222-2222-222222222222'); -- Camila

-- ============================================================
-- 5. DOCUMENTOS (22)
-- ============================================================

INSERT INTO documentos (id, expediente_id, tipo, archivo_url, nombre_original, tipo_mime, tamano_bytes, estado, motivo_rechazo, version, validado_por) VALUES
  -- Expediente d4444444 (en_revision - Felipe Ríos para Chicó)
  ('e1111111-1111-1111-1111-111111111111',
   'd4444444-4444-4444-4444-444444444444',
   'cedula_frontal',
   'documentos/expediente-d4444444-4444-4444-4444-444444444444/cedula_frontal-v1.pdf',
   'cedula_frontal_felipe_rios.pdf', 'application/pdf', 524288,
   'aprobado', NULL, 1, 'a2222222-2222-2222-2222-222222222222'),

  ('e2222222-2222-2222-2222-222222222222',
   'd4444444-4444-4444-4444-444444444444',
   'cedula_posterior',
   'documentos/expediente-d4444444-4444-4444-4444-444444444444/cedula_posterior-v1.pdf',
   'cedula_posterior_felipe_rios.pdf', 'application/pdf', 498700,
   'aprobado', NULL, 1, 'a2222222-2222-2222-2222-222222222222'),

  ('e3333333-3333-3333-3333-333333333333',
   'd4444444-4444-4444-4444-444444444444',
   'certificado_laboral',
   'documentos/expediente-d4444444-4444-4444-4444-444444444444/certificado_laboral-v1.pdf',
   'certificado_laboral_bancolombia.pdf', 'application/pdf', 1048576,
   'aprobado', NULL, 1, 'a2222222-2222-2222-2222-222222222222'),

  ('e4444444-4444-4444-4444-444444444444',
   'd4444444-4444-4444-4444-444444444444',
   'comprobante_ingresos',
   'documentos/expediente-d4444444-4444-4444-4444-444444444444/comprobante_ingresos-v1.pdf',
   'desprendible_pago_enero_2026.pdf', 'application/pdf', 756800,
   'pendiente', NULL, 1, NULL),

  -- Expediente d5555555 (en_revision - María Fernanda para El Poblado)
  ('e5555555-5555-5555-5555-555555555555',
   'd5555555-5555-5555-5555-555555555555',
   'cedula_frontal',
   'documentos/expediente-d5555555-5555-5555-5555-555555555555/cedula_frontal-v1.pdf',
   'cedula_frontal_maria_torres.pdf', 'application/pdf', 612000,
   'aprobado', NULL, 1, 'a3333333-3333-3333-3333-333333333333'),

  ('e6666666-6666-6666-6666-666666666666',
   'd5555555-5555-5555-5555-555555555555',
   'cedula_posterior',
   'documentos/expediente-d5555555-5555-5555-5555-555555555555/cedula_posterior-v1.pdf',
   'cedula_posterior_maria_torres.pdf', 'application/pdf', 589000,
   'aprobado', NULL, 1, 'a3333333-3333-3333-3333-333333333333'),

  ('e7777777-7777-7777-7777-777777777777',
   'd5555555-5555-5555-5555-555555555555',
   'certificado_laboral',
   'documentos/expediente-d5555555-5555-5555-5555-555555555555/certificado_laboral-v1.pdf',
   'certificado_baker_mckenzie.pdf', 'application/pdf', 1200000,
   'pendiente', NULL, 1, NULL),

  ('e8888888-8888-8888-8888-888888888888',
   'd5555555-5555-5555-5555-555555555555',
   'comprobante_domicilio',
   'documentos/expediente-d5555555-5555-5555-5555-555555555555/comprobante_domicilio-v1.pdf',
   'recibo_epm_enero2026.pdf', 'application/pdf', 890000,
   'pendiente', NULL, 1, NULL),

  -- Expediente d8888888 (informacion_incompleta - Sebastián Mejía)
  ('e9999999-9999-9999-9999-999999999999',
   'd8888888-8888-8888-8888-888888888888',
   'cedula_frontal',
   'documentos/expediente-d8888888-8888-8888-8888-888888888888/cedula_frontal-v1.pdf',
   'cedula_frontal_sebastian.pdf', 'application/pdf', 530000,
   'aprobado', NULL, 1, 'a2222222-2222-2222-2222-222222222222'),

  ('ea000000-0000-0000-0000-000000000001',
   'd8888888-8888-8888-8888-888888888888',
   'certificado_laboral',
   'documentos/expediente-d8888888-8888-8888-8888-888888888888/certificado_laboral-v1.pdf',
   'certificado_freelance.pdf', 'application/pdf', 420000,
   'rechazado', 'El certificado no tiene firma autorizada ni membrete de la empresa.', 1, 'a2222222-2222-2222-2222-222222222222'),

  ('ea000000-0000-0000-0000-000000000002',
   'd8888888-8888-8888-8888-888888888888',
   'comprobante_ingresos',
   'documentos/expediente-d8888888-8888-8888-8888-888888888888/comprobante_ingresos-v1.pdf',
   'extracto_bancario.pdf', 'application/pdf', 2100000,
   'rechazado', 'Extracto bancario muestra ingresos inconsistentes. Se requiere declaración de renta.', 1, 'a2222222-2222-2222-2222-222222222222'),

  -- Expediente da000001 (aprobado - El Corral para Local Teusaquillo)
  ('ea000000-0000-0000-0000-000000000003',
   'da000000-0000-0000-0000-000000000001',
   'cedula_frontal',
   'documentos/expediente-da000000-0000-0000-0000-000000000001/cedula_frontal-v1.pdf',
   'cedula_representante_legal.pdf', 'application/pdf', 615000,
   'aprobado', NULL, 1, 'a2222222-2222-2222-2222-222222222222'),

  ('ea000000-0000-0000-0000-000000000004',
   'da000000-0000-0000-0000-000000000001',
   'certificado_laboral',
   'documentos/expediente-da000000-0000-0000-0000-000000000001/certificado_laboral-v1.pdf',
   'camara_comercio_el_corral.pdf', 'application/pdf', 3200000,
   'aprobado', NULL, 1, 'a2222222-2222-2222-2222-222222222222'),

  ('ea000000-0000-0000-0000-000000000005',
   'da000000-0000-0000-0000-000000000001',
   'comprobante_ingresos',
   'documentos/expediente-da000000-0000-0000-0000-000000000001/comprobante_ingresos-v1.pdf',
   'estados_financieros_2025.pdf', 'application/pdf', 4800000,
   'aprobado', NULL, 1, 'a2222222-2222-2222-2222-222222222222'),

  -- Expediente da000002 (aprobado - Carlos Andrés para San Fernando)
  ('ea000000-0000-0000-0000-000000000006',
   'da000000-0000-0000-0000-000000000002',
   'cedula_frontal',
   'documentos/expediente-da000000-0000-0000-0000-000000000002/cedula_frontal-v1.pdf',
   'cedula_carlos_herrera_frontal.pdf', 'application/pdf', 540000,
   'aprobado', NULL, 1, 'a5555555-5555-5555-5555-555555555555'),

  ('ea000000-0000-0000-0000-000000000007',
   'da000000-0000-0000-0000-000000000002',
   'cedula_posterior',
   'documentos/expediente-da000000-0000-0000-0000-000000000002/cedula_posterior-v1.pdf',
   'cedula_carlos_herrera_posterior.pdf', 'application/pdf', 510000,
   'aprobado', NULL, 1, 'a5555555-5555-5555-5555-555555555555'),

  ('ea000000-0000-0000-0000-000000000008',
   'da000000-0000-0000-0000-000000000002',
   'certificado_laboral',
   'documentos/expediente-da000000-0000-0000-0000-000000000002/certificado_laboral-v1.pdf',
   'certificado_deloitte.pdf', 'application/pdf', 980000,
   'aprobado', NULL, 1, 'a5555555-5555-5555-5555-555555555555'),

  ('ea000000-0000-0000-0000-000000000009',
   'da000000-0000-0000-0000-000000000002',
   'comprobante_ingresos',
   'documentos/expediente-da000000-0000-0000-0000-000000000002/comprobante_ingresos-v1.pdf',
   'desprendible_pago_deloitte.pdf', 'application/pdf', 680000,
   'aprobado', NULL, 1, 'a5555555-5555-5555-5555-555555555555'),

  -- Expediente da000004 (rechazado - Sebastián Mejía para Chicó)
  ('ea000000-0000-0000-0000-000000000010',
   'da000000-0000-0000-0000-000000000004',
   'cedula_frontal',
   'documentos/expediente-da000000-0000-0000-0000-000000000004/cedula_frontal-v1.pdf',
   'cedula_sebastian_frontal.pdf', 'application/pdf', 530000,
   'aprobado', NULL, 1, 'a2222222-2222-2222-2222-222222222222'),

  ('ea000000-0000-0000-0000-000000000011',
   'da000000-0000-0000-0000-000000000004',
   'comprobante_ingresos',
   'documentos/expediente-da000000-0000-0000-0000-000000000004/comprobante_ingresos-v1.pdf',
   'ingresos_freelance_sebastian.pdf', 'application/pdf', 720000,
   'aprobado', NULL, 1, 'a2222222-2222-2222-2222-222222222222'),

  -- Expediente da000005 (condicionado - Felipe Ríos para Barranquilla)
  ('ea000000-0000-0000-0000-000000000012',
   'da000000-0000-0000-0000-000000000005',
   'cedula_frontal',
   'documentos/expediente-da000000-0000-0000-0000-000000000005/cedula_frontal-v1.pdf',
   'cedula_felipe_rios_frontal.pdf', 'application/pdf', 560000,
   'aprobado', NULL, 1, 'a5555555-5555-5555-5555-555555555555'),

  ('ea000000-0000-0000-0000-000000000013',
   'da000000-0000-0000-0000-000000000005',
   'referencias',
   'documentos/expediente-da000000-0000-0000-0000-000000000005/referencias-v1.pdf',
   'carta_referencia_personal.pdf', 'application/pdf', 450000,
   'aprobado', NULL, 1, 'a5555555-5555-5555-5555-555555555555');

-- ============================================================
-- 15. AUTORIZACIONES HABEAS DATA (8)
-- Deben existir ANTES de los estudios que las referencian.
-- ============================================================

INSERT INTO autorizaciones_habeas_data (id, solicitante_id, canal, estado, token, token_expiracion, generado_por, autorizado_en, ip_autorizacion, user_agent, texto_autorizado, version_terminos) VALUES
  -- Solicitantes con autorización vía web (registro)
  ('h1111111-1111-1111-1111-111111111111',
   'c1111111-1111-1111-1111-111111111111',
   'web', 'autorizado', NULL, NULL, NULL,
   '2026-01-15 10:30:00-05', '181.53.12.45', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
   'Autorizo de manera libre, expresa e informada a Cofianza para consultar mi información crediticia en TransUnion, Datacrédito y SIFIN, conforme a la Ley 1581 de 2012 y Ley 1266 de 2008.',
   'v1.0'),

  ('h2222222-2222-2222-2222-222222222222',
   'c2222222-2222-2222-2222-222222222222',
   'web', 'autorizado', NULL, NULL, NULL,
   '2026-01-16 14:15:00-05', '190.25.67.89', 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/17',
   'Autorizo de manera libre, expresa e informada a Cofianza para consultar mi información crediticia en TransUnion, Datacrédito y SIFIN, conforme a la Ley 1581 de 2012 y Ley 1266 de 2008.',
   'v1.0'),

  ('h3333333-3333-3333-3333-333333333333',
   'c3333333-3333-3333-3333-333333333333',
   'web', 'autorizado', NULL, NULL, NULL,
   '2026-01-18 09:00:00-05', '181.128.45.12', 'Mozilla/5.0 (Linux; Android 14) Chrome/120',
   'Autorizo de manera libre, expresa e informada a Cofianza para consultar mi información crediticia en TransUnion, Datacrédito y SIFIN, conforme a la Ley 1581 de 2012 y Ley 1266 de 2008.',
   'v1.0'),

  -- Solicitantes con autorización vía enlace presencial
  ('h4444444-4444-4444-4444-444444444444',
   'c4444444-4444-4444-4444-444444444444',
   'enlace', 'autorizado',
   'aut_tk_a1b2c3d4e5f6', '2026-01-22 17:00:00-05',
   'a2222222-2222-2222-2222-222222222222',
   '2026-01-20 16:45:00-05', '190.85.33.21', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/17',
   'Autorizo de manera libre, expresa e informada a Cofianza para consultar mi información crediticia en TransUnion, Datacrédito y SIFIN, conforme a la Ley 1581 de 2012 y Ley 1266 de 2008.',
   'v1.0'),

  ('h5555555-5555-5555-5555-555555555555',
   'c5555555-5555-5555-5555-555555555555',
   'enlace', 'autorizado',
   'aut_tk_g7h8i9j0k1l2', '2026-01-25 17:00:00-05',
   'a3333333-3333-3333-3333-333333333333',
   '2026-01-23 11:20:00-05', '181.49.78.56', 'Mozilla/5.0 (Windows NT 10.0) Edge/120',
   'Autorizo de manera libre, expresa e informada a Cofianza para consultar mi información crediticia en TransUnion, Datacrédito y SIFIN, conforme a la Ley 1581 de 2012 y Ley 1266 de 2008.',
   'v1.0'),

  ('h6666666-6666-6666-6666-666666666666',
   'c6666666-6666-6666-6666-666666666666',
   'web', 'autorizado', NULL, NULL, NULL,
   '2026-01-25 08:30:00-05', '190.60.12.88', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/121',
   'Autorizo de manera libre, expresa e informada a Cofianza para consultar mi información crediticia en TransUnion, Datacrédito y SIFIN, conforme a la Ley 1581 de 2012 y Ley 1266 de 2008.',
   'v1.0'),

  -- Enlace pendiente (no firmado aún)
  ('h7777777-7777-7777-7777-777777777777',
   'c7777777-7777-7777-7777-777777777777',
   'enlace', 'pendiente',
   'aut_tk_m3n4o5p6q7r8', '2026-02-20 17:00:00-05',
   'a5555555-5555-5555-5555-555555555555',
   NULL, NULL, NULL, NULL, NULL),

  -- Autorización revocada
  ('h8888888-8888-8888-8888-888888888888',
   'c8888888-8888-8888-8888-888888888888',
   'web', 'revocado', NULL, NULL, NULL,
   '2026-01-10 15:00:00-05', '181.33.22.11', 'Mozilla/5.0 (Macintosh) Chrome/120',
   'Autorizo de manera libre, expresa e informada a Cofianza para consultar mi información crediticia en TransUnion, Datacrédito y SIFIN, conforme a la Ley 1581 de 2012 y Ley 1266 de 2008.',
   'v1.0');

-- ============================================================
-- 6. ESTUDIOS DE RIESGO (8)
-- ============================================================

INSERT INTO estudios (id, expediente_id, tipo, proveedor, resultado, score, observaciones, certificado_url, duracion_contrato_meses, solicitado_por, autorizacion_habeas_data_id) VALUES
  -- Expediente d4444444 (en_revision) - solicitante c8888888 (Felipe Ríos)
  ('f1111111-1111-1111-1111-111111111111',
   'd4444444-4444-4444-4444-444444444444',
   'individual', 'transunion', 'pendiente',
   NULL, 'Estudio solicitado. Pendiente respuesta del proveedor.',
   NULL, 12,
   'a2222222-2222-2222-2222-222222222222',
   'h8888888-8888-8888-8888-888888888888'),

  -- Expediente d5555555 (en_revision) - solicitante c2222222 (María Fernanda)
  ('f2222222-2222-2222-2222-222222222222',
   'd5555555-5555-5555-5555-555555555555',
   'individual', 'sifin', 'pendiente',
   NULL, 'Estudio en proceso. Se espera resultado en 24 horas hábiles.',
   NULL, 12,
   'a3333333-3333-3333-3333-333333333333',
   'h2222222-2222-2222-2222-222222222222'),

  -- Expediente da000001 (aprobado - El Corral) - solicitante c5555555
  ('f3333333-3333-3333-3333-333333333333',
   'da000000-0000-0000-0000-000000000001',
   'con_coarrendatario', 'transunion', 'aprobado',
   780, 'Empresa con excelente historial crediticio. Representante legal sin reportes negativos.',
   'estudios/certificado-f3333333.pdf', 24,
   'a2222222-2222-2222-2222-222222222222',
   'h5555555-5555-5555-5555-555555555555'),

  -- Expediente da000002 (aprobado - Carlos Andrés) - solicitante c3333333
  ('f4444444-4444-4444-4444-444444444444',
   'da000000-0000-0000-0000-000000000002',
   'individual', 'datacredito', 'aprobado',
   720, 'Buen historial crediticio. Sin reportes negativos en centrales de riesgo. Capacidad de pago verificada.',
   'estudios/certificado-f4444444.pdf', 12,
   'a5555555-5555-5555-5555-555555555555',
   'h3333333-3333-3333-3333-333333333333'),

  -- Expediente da000003 (aprobado - María Fernanda) - solicitante c2222222
  ('f5555555-5555-5555-5555-555555555555',
   'da000000-0000-0000-0000-000000000003',
   'individual', 'transunion', 'aprobado',
   750, 'Solicitante con perfil crediticio sólido. Ingresos estables verificados.',
   'estudios/certificado-f5555555.pdf', 12,
   'a3333333-3333-3333-3333-333333333333',
   'h2222222-2222-2222-2222-222222222222'),

  -- Expediente da000004 (rechazado - Sebastián Mejía para Chicó) - solicitante c6666666
  ('f6666666-6666-6666-6666-666666666666',
   'da000000-0000-0000-0000-000000000004',
   'individual', 'datacredito', 'rechazado',
   380, 'Ingresos insuficientes para el canon solicitado. Relación ingreso/arriendo inferior al 30% requerido. Reportes en mora con entidad financiera.',
   'estudios/certificado-f6666666.pdf', 12,
   'a2222222-2222-2222-2222-222222222222',
   'h6666666-6666-6666-6666-666666666666'),

  -- Expediente da000005 (condicionado - Felipe Ríos) - solicitante c8888888
  ('f7777777-7777-7777-7777-777777777777',
   'da000000-0000-0000-0000-000000000005',
   'individual', 'sifin', 'condicionado',
   580, 'Capacidad de pago ajustada. Se recomienda codeudor con ingresos mínimos de $4.000.000. Historial crediticio aceptable con un reporte cancelado.',
   'estudios/certificado-f7777777.pdf', 6,
   'a5555555-5555-5555-5555-555555555555',
   'h8888888-8888-8888-8888-888888888888'),

  -- Expediente da000006 (cerrado) - solicitante c4444444 (Laura Sánchez)
  ('f8888888-8888-8888-8888-888888888888',
   'da000000-0000-0000-0000-000000000006',
   'individual', 'manual', 'aprobado',
   700, 'Verificación manual completada. Documentos en orden. Solicitante desistió del proceso.',
   NULL, 12,
   'a2222222-2222-2222-2222-222222222222',
   'h4444444-4444-4444-4444-444444444444');

-- ============================================================
-- 7. PLANTILLAS DE CONTRATO (2)
-- ============================================================

INSERT INTO plantillas_contrato (id, nombre, descripcion, contenido_url, variables, activa) VALUES
  ('f0000001-0000-0000-0000-000000000001',
   'Contrato de arrendamiento vivienda urbana',
   'Contrato estándar para arrendamiento de vivienda urbana según la Ley 820 de 2003. Incluye cláusulas de servicios públicos, mantenimiento y restitución.',
   'plantillas/contrato_vivienda_urbana_v3.docx',
   '["nombre_arrendatario", "nombre_propietario", "direccion_inmueble", "valor_arriendo", "fecha_inicio", "duracion_meses"]'::JSONB,
   TRUE),

  ('f0000001-0000-0000-0000-000000000002',
   'Contrato de arrendamiento local comercial',
   'Contrato para arrendamiento de locales comerciales y oficinas. Incluye cláusulas especiales de uso comercial, adecuaciones y publicidad exterior.',
   'plantillas/contrato_local_comercial_v2.docx',
   '["nombre_arrendatario", "nombre_propietario", "direccion_inmueble", "valor_arriendo", "fecha_inicio", "duracion_meses"]'::JSONB,
   TRUE);

-- ============================================================
-- 8. CONTRATOS (6)
-- Solo para expedientes aprobados o condicionados
-- ============================================================

INSERT INTO contratos (id, expediente_id, plantilla_id, version, estado, contenido_url, documento_firmado_url, fecha_inicio, fecha_fin, duracion_meses, valor_arriendo) VALUES
  -- Contrato vigente: Carlos Andrés - San Fernando (aprobado)
  ('f0000002-0000-0000-0000-000000000001',
   'da000000-0000-0000-0000-000000000002',
   'f0000001-0000-0000-0000-000000000001',
   1, 'vigente',
   'contratos/contrato-f0000002-0001-v1.pdf',
   'contratos/contrato-f0000002-0001-firmado.pdf',
   '2026-01-15', '2027-01-14', 12,
   1800000.00),

  -- Contrato firmado: El Corral - Local Teusaquillo (aprobado)
  ('f0000002-0000-0000-0000-000000000002',
   'da000000-0000-0000-0000-000000000001',
   'f0000001-0000-0000-0000-000000000002',
   1, 'firmado',
   'contratos/contrato-f0000002-0002-v1.pdf',
   'contratos/contrato-f0000002-0002-firmado.pdf',
   '2026-03-01', '2028-02-28', 24,
   3200000.00),

  -- Contrato pendiente_firma: María Fernanda - Laureles (aprobado)
  ('f0000002-0000-0000-0000-000000000003',
   'da000000-0000-0000-0000-000000000003',
   'f0000001-0000-0000-0000-000000000001',
   1, 'pendiente_firma',
   'contratos/contrato-f0000002-0003-v1.pdf',
   NULL,
   '2026-03-01', '2027-02-28', 12,
   2200000.00),

  -- Contrato borrador: Felipe Ríos - Barranquilla (condicionado)
  ('f0000002-0000-0000-0000-000000000004',
   'da000000-0000-0000-0000-000000000005',
   'f0000001-0000-0000-0000-000000000001',
   1, 'borrador',
   NULL, NULL,
   '2026-04-01', '2026-09-30', 6,
   1600000.00),

  -- Contrato pendiente_firma (segundo): versión revisada
  ('f0000002-0000-0000-0000-000000000005',
   'da000000-0000-0000-0000-000000000005',
   'f0000001-0000-0000-0000-000000000001',
   2, 'pendiente_firma',
   'contratos/contrato-f0000002-0005-v2.pdf',
   NULL,
   '2026-04-01', '2026-09-30', 6,
   1600000.00),

  -- Contrato borrador (para el cerrado, solo histórico)
  ('f0000002-0000-0000-0000-000000000006',
   'da000000-0000-0000-0000-000000000006',
   'f0000001-0000-0000-0000-000000000001',
   1, 'borrador',
   'contratos/contrato-f0000002-0006-v1.pdf',
   NULL,
   '2026-02-01', '2027-01-31', 12,
   1200000.00);

-- ============================================================
-- 9. FIRMAS (6)
-- ============================================================

INSERT INTO firmas (id, contrato_id, tipo_firmante, nombre_firmante, email_firmante, enlace_firma, firmado_en, ip_firmante, user_agent, evidencia_url) VALUES
  -- Contrato vigente (San Fernando) - ambas firmas completadas
  ('f0000003-0000-0000-0000-000000000001',
   'f0000002-0000-0000-0000-000000000001',
   'arrendatario', 'Carlos Andrés Herrera Ospina',
   'carlos.herrera@yahoo.com',
   'https://firmas.cofianza.com/firma/f0000003-0001',
   '2026-01-10 14:30:00-05',
   '181.52.134.22', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0',
   'firmas/evidencia-f0000003-0001.pdf'),

  ('f0000003-0000-0000-0000-000000000002',
   'f0000002-0000-0000-0000-000000000001',
   'propietario', 'Andrés Gutiérrez',
   'andres.gutierrez@habitar.com',
   'https://firmas.cofianza.com/firma/f0000003-0002',
   '2026-01-11 09:15:00-05',
   '190.25.88.103', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1',
   'firmas/evidencia-f0000003-0002.pdf'),

  -- Contrato firmado (El Corral) - ambas firmas completadas
  ('f0000003-0000-0000-0000-000000000003',
   'f0000002-0000-0000-0000-000000000002',
   'arrendatario', 'Roberto Mejía Arias (Rep. Legal Restaurantes El Corral SAS)',
   'contacto@elcorral.com',
   'https://firmas.cofianza.com/firma/f0000003-0003',
   '2026-02-12 11:00:00-05',
   '181.143.67.200', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0',
   'firmas/evidencia-f0000003-0003.pdf'),

  ('f0000003-0000-0000-0000-000000000004',
   'f0000002-0000-0000-0000-000000000002',
   'propietario', 'Camila Moreno',
   'camila.moreno@habitar.com',
   'https://firmas.cofianza.com/firma/f0000003-0004',
   '2026-02-13 16:45:00-05',
   '190.85.201.44', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) Safari/604.1',
   'firmas/evidencia-f0000003-0004.pdf'),

  -- Contrato pendiente_firma (Laureles, María Fernanda) - pendientes
  ('f0000003-0000-0000-0000-000000000005',
   'f0000002-0000-0000-0000-000000000003',
   'arrendatario', 'María Fernanda Torres Vargas',
   'mafe.torres@outlook.com',
   'https://firmas.cofianza.com/firma/f0000003-0005',
   NULL, NULL, NULL, NULL),

  ('f0000003-0000-0000-0000-000000000006',
   'f0000002-0000-0000-0000-000000000003',
   'propietario', 'Andrés Gutiérrez',
   'andres.gutierrez@habitar.com',
   'https://firmas.cofianza.com/firma/f0000003-0006',
   NULL, NULL, NULL, NULL);

-- ============================================================
-- 10. PAGOS (12)
-- ============================================================

INSERT INTO pagos (id, expediente_id, tipo, monto, estado, referencia_pasarela, metodo_pago, comprobante_url, fecha_pago) VALUES
  -- Pagos de estudio
  ('f0000004-0000-0000-0000-000000000001',
   'da000000-0000-0000-0000-000000000001',
   'estudio', 150000.00, 'pagado',
   'pi_3RtX8kJ2eZvKYlo2C0', 'tarjeta_credito',
   'pagos/comprobante-f0000004-0001.pdf',
   '2026-01-05 10:30:00-05'),

  ('f0000004-0000-0000-0000-000000000002',
   'da000000-0000-0000-0000-000000000002',
   'estudio', 150000.00, 'pagado',
   'pi_3RtX8kJ2eZvKYlo2C1', 'pse',
   'pagos/comprobante-f0000004-0002.pdf',
   '2025-12-20 15:00:00-05'),

  ('f0000004-0000-0000-0000-000000000003',
   'da000000-0000-0000-0000-000000000004',
   'estudio', 150000.00, 'pagado',
   'pi_3RtX8kJ2eZvKYlo2C2', 'tarjeta_debito',
   'pagos/comprobante-f0000004-0003.pdf',
   '2026-01-15 09:00:00-05'),

  ('f0000004-0000-0000-0000-000000000004',
   'd4444444-4444-4444-4444-444444444444',
   'estudio', 150000.00, 'pendiente',
   'pi_3RtX8kJ2eZvKYlo2C3', 'tarjeta_credito',
   NULL, NULL),

  ('f0000004-0000-0000-0000-000000000005',
   'da000000-0000-0000-0000-000000000005',
   'estudio', 150000.00, 'pagado',
   'pi_3RtX8kJ2eZvKYlo2C4', 'pse',
   'pagos/comprobante-f0000004-0005.pdf',
   '2026-02-01 11:20:00-05'),

  -- Depósitos
  ('f0000004-0000-0000-0000-000000000006',
   'da000000-0000-0000-0000-000000000002',
   'deposito', 1800000.00, 'pagado',
   'pi_3RtX8kJ2eZvKYlo2D0', 'transferencia',
   'pagos/comprobante-f0000004-0006.pdf',
   '2026-01-12 14:00:00-05'),

  ('f0000004-0000-0000-0000-000000000007',
   'da000000-0000-0000-0000-000000000001',
   'deposito', 3200000.00, 'pendiente',
   'pi_3RtX8kJ2eZvKYlo2D1', 'transferencia',
   NULL, NULL),

  -- Mensualidades
  ('f0000004-0000-0000-0000-000000000008',
   'da000000-0000-0000-0000-000000000002',
   'mensualidad', 1800000.00, 'pagado',
   'pi_3RtX8kJ2eZvKYlo2M0', 'pse',
   'pagos/comprobante-f0000004-0008.pdf',
   '2026-02-01 08:00:00-05'),

  ('f0000004-0000-0000-0000-000000000009',
   'da000000-0000-0000-0000-000000000002',
   'mensualidad', 1800000.00, 'pagado',
   'pi_3RtX8kJ2eZvKYlo2M1', 'pse',
   'pagos/comprobante-f0000004-0009.pdf',
   '2026-01-15 08:30:00-05'),

  ('f0000004-0000-0000-0000-000000000010',
   'da000000-0000-0000-0000-000000000002',
   'mensualidad', 1800000.00, 'pendiente',
   'pi_3RtX8kJ2eZvKYlo2M2', 'pse',
   NULL, NULL),

  -- Pago fallido
  ('f0000004-0000-0000-0000-000000000011',
   'da000000-0000-0000-0000-000000000005',
   'deposito', 1600000.00, 'fallido',
   'pi_3RtX8kJ2eZvKYlo2F0', 'tarjeta_credito',
   NULL,
   '2026-02-10 16:00:00-05'),

  -- Otra mensualidad pendiente
  ('f0000004-0000-0000-0000-000000000012',
   'da000000-0000-0000-0000-000000000001',
   'mensualidad', 3200000.00, 'pendiente',
   'pi_3RtX8kJ2eZvKYlo2M3', 'transferencia',
   NULL, NULL);

-- ============================================================
-- 11. FACTURAS (3)
-- Vinculadas a pagos con estado 'pagado'
-- ============================================================

INSERT INTO facturas (id, pago_id, expediente_id, numero_factura, razon_social, nit, direccion_fiscal, estado, archivo_url) VALUES
  ('f0000005-0000-0000-0000-000000000001',
   'f0000004-0000-0000-0000-000000000001',
   'da000000-0000-0000-0000-000000000001',
   'FAC-2026-00001',
   'Cofianza SAS', '901234567-1',
   'Calle 93 # 14-20, Oficina 501, Bogotá D.C.',
   'emitida',
   'facturas/factura-f0000005-0001.pdf'),

  ('f0000005-0000-0000-0000-000000000002',
   'f0000004-0000-0000-0000-000000000002',
   'da000000-0000-0000-0000-000000000002',
   'FAC-2026-00002',
   'Cofianza SAS', '901234567-1',
   'Calle 93 # 14-20, Oficina 501, Bogotá D.C.',
   'emitida',
   'facturas/factura-f0000005-0002.pdf'),

  ('f0000005-0000-0000-0000-000000000003',
   'f0000004-0000-0000-0000-000000000008',
   'da000000-0000-0000-0000-000000000002',
   'FAC-2026-00003',
   'Cofianza SAS', '901234567-1',
   'Calle 93 # 14-20, Oficina 501, Bogotá D.C.',
   'solicitada',
   NULL);

-- ============================================================
-- 12. BITACORA DE AUDITORIA (12 entradas)
-- ============================================================

INSERT INTO bitacora (id, usuario_id, accion, entidad, entidad_id, detalle, ip) VALUES
  ('f0000006-0000-0000-0000-000000000001',
   'a2222222-2222-2222-2222-222222222222',
   'crear_expediente', 'expediente',
   'da000000-0000-0000-0000-000000000001',
   '{"solicitante": "Restaurantes El Corral SAS", "inmueble_ciudad": "Bogotá"}'::JSONB,
   '181.52.134.22'),

  ('f0000006-0000-0000-0000-000000000002',
   'a2222222-2222-2222-2222-222222222222',
   'cambiar_estado', 'expediente',
   'da000000-0000-0000-0000-000000000001',
   '{"estado_anterior": "borrador", "estado_nuevo": "en_revision"}'::JSONB,
   '181.52.134.22'),

  ('f0000006-0000-0000-0000-000000000003',
   'a2222222-2222-2222-2222-222222222222',
   'validar_documento', 'documento',
   'ea000000-0000-0000-0000-000000000003',
   '{"tipo_documento": "cedula_frontal", "resultado": "aprobado"}'::JSONB,
   '181.52.134.22'),

  ('f0000006-0000-0000-0000-000000000004',
   'a2222222-2222-2222-2222-222222222222',
   'cambiar_estado', 'expediente',
   'da000000-0000-0000-0000-000000000001',
   '{"estado_anterior": "en_revision", "estado_nuevo": "aprobado"}'::JSONB,
   '181.52.134.22'),

  ('f0000006-0000-0000-0000-000000000005',
   'a3333333-3333-3333-3333-333333333333',
   'crear_expediente', 'expediente',
   'da000000-0000-0000-0000-000000000003',
   '{"solicitante": "María Fernanda Torres Vargas", "inmueble_ciudad": "Medellín"}'::JSONB,
   '190.25.88.103'),

  ('f0000006-0000-0000-0000-000000000006',
   'a5555555-5555-5555-5555-555555555555',
   'cambiar_estado', 'expediente',
   'da000000-0000-0000-0000-000000000002',
   '{"estado_anterior": "en_revision", "estado_nuevo": "aprobado"}'::JSONB,
   '190.85.201.44'),

  ('f0000006-0000-0000-0000-000000000007',
   'a5555555-5555-5555-5555-555555555555',
   'generar_contrato', 'contrato',
   'f0000002-0000-0000-0000-000000000001',
   '{"plantilla": "Contrato de arrendamiento vivienda urbana", "expediente": "da000000-0000-0000-0000-000000000002"}'::JSONB,
   '190.85.201.44'),

  ('f0000006-0000-0000-0000-000000000008',
   'a5555555-5555-5555-5555-555555555555',
   'enviar_firma', 'contrato',
   'f0000002-0000-0000-0000-000000000001',
   '{"firmante": "Carlos Andrés Herrera Ospina", "tipo": "arrendatario"}'::JSONB,
   '190.85.201.44'),

  ('f0000006-0000-0000-0000-000000000009',
   'a2222222-2222-2222-2222-222222222222',
   'registrar_pago', 'pago',
   'f0000004-0000-0000-0000-000000000001',
   '{"tipo": "estudio", "monto": 150000, "metodo": "tarjeta_credito"}'::JSONB,
   '181.52.134.22'),

  ('f0000006-0000-0000-0000-000000000010',
   'a2222222-2222-2222-2222-222222222222',
   'cambiar_estado', 'expediente',
   'da000000-0000-0000-0000-000000000004',
   '{"estado_anterior": "en_revision", "estado_nuevo": "rechazado", "motivo": "Ingresos insuficientes para el canon solicitado"}'::JSONB,
   '181.52.134.22'),

  ('f0000006-0000-0000-0000-000000000011',
   'a1111111-1111-1111-1111-111111111111',
   'cambiar_estado', 'expediente',
   'da000000-0000-0000-0000-000000000006',
   '{"estado_anterior": "aprobado", "estado_nuevo": "cerrado", "motivo": "Solicitante desistió del proceso"}'::JSONB,
   '181.143.67.200'),

  ('f0000006-0000-0000-0000-000000000012',
   'a3333333-3333-3333-3333-333333333333',
   'validar_documento', 'documento',
   'e5555555-5555-5555-5555-555555555555',
   '{"tipo_documento": "cedula_frontal", "resultado": "aprobado", "expediente": "d5555555"}'::JSONB,
   '190.25.88.103');

-- ============================================================
-- 13. COMENTARIOS (8)
-- ============================================================

INSERT INTO comentarios (id, expediente_id, usuario_id, texto) VALUES
  ('f0000007-0000-0000-0000-000000000001',
   'd4444444-4444-4444-4444-444444444444',
   'a2222222-2222-2222-2222-222222222222',
   'Documentos de identidad verificados. Falta comprobante de ingresos del último mes.'),

  ('f0000007-0000-0000-0000-000000000002',
   'd5555555-5555-5555-5555-555555555555',
   'a3333333-3333-3333-3333-333333333333',
   'Solicitante trabaja en firma reconocida. Pendiente certificación laboral con firma y sello.'),

  ('f0000007-0000-0000-0000-000000000003',
   'd8888888-8888-8888-8888-888888888888',
   'a2222222-2222-2222-2222-222222222222',
   'Certificado laboral rechazado por falta de firma autorizada. Se solicitó nueva versión al solicitante vía correo electrónico.'),

  ('f0000007-0000-0000-0000-000000000004',
   'da000000-0000-0000-0000-000000000001',
   'a2222222-2222-2222-2222-222222222222',
   'Documentos verificados correctamente. Cámara de comercio vigente. Estudio de riesgo aprobado con score alto. Proceder con generación de contrato.'),

  ('f0000007-0000-0000-0000-000000000005',
   'da000000-0000-0000-0000-000000000004',
   'a2222222-2222-2222-2222-222222222222',
   'Expediente rechazado. Los ingresos del solicitante ($3.500.000) son insuficientes para un canon de $4.500.000. No cumple con la relación mínima del 30%.'),

  ('f0000007-0000-0000-0000-000000000006',
   'da000000-0000-0000-0000-000000000005',
   'a5555555-5555-5555-5555-555555555555',
   'Estudio condicionado. Se requiere codeudor con ingresos superiores a $4.000.000 mensuales. Se contactó al solicitante para que presente codeudor.'),

  ('f0000007-0000-0000-0000-000000000007',
   'da000000-0000-0000-0000-000000000002',
   'a5555555-5555-5555-5555-555555555555',
   'Contrato generado y enviado para firma. El arrendatario firmó el 10 de enero. Contrato vigente desde el 15 de enero de 2026.'),

  ('f0000007-0000-0000-0000-000000000008',
   'da000000-0000-0000-0000-000000000006',
   'a1111111-1111-1111-1111-111111111111',
   'Expediente cerrado por desistimiento del solicitante. Indicó que encontró otro inmueble por cuenta propia. Se archiva el caso.');

-- ============================================================
-- 14. EVENTOS DE TIMELINE (18)
-- ============================================================

INSERT INTO eventos_timeline (id, expediente_id, tipo, descripcion, usuario_id) VALUES
  -- Timeline expediente da000001 (aprobado - El Corral)
  ('f0000008-0000-0000-0000-000000000001',
   'da000000-0000-0000-0000-000000000001',
   'creacion', 'Expediente creado para Restaurantes El Corral SAS - Local comercial en Teusaquillo, Bogotá.',
   'a2222222-2222-2222-2222-222222222222'),

  ('f0000008-0000-0000-0000-000000000002',
   'da000000-0000-0000-0000-000000000001',
   'asignacion', 'Expediente asignado a la analista Camila Moreno para revisión.',
   'a1111111-1111-1111-1111-111111111111'),

  ('f0000008-0000-0000-0000-000000000003',
   'da000000-0000-0000-0000-000000000001',
   'documento', 'Cédula del representante legal cargada y verificada exitosamente.',
   'a2222222-2222-2222-2222-222222222222'),

  ('f0000008-0000-0000-0000-000000000004',
   'da000000-0000-0000-0000-000000000001',
   'documento', 'Cámara de comercio y estados financieros cargados y aprobados.',
   'a2222222-2222-2222-2222-222222222222'),

  ('f0000008-0000-0000-0000-000000000005',
   'da000000-0000-0000-0000-000000000001',
   'estudio', 'Estudio de riesgo TransUnion completado con score 780. Resultado: APROBADO.',
   'a2222222-2222-2222-2222-222222222222'),

  ('f0000008-0000-0000-0000-000000000006',
   'da000000-0000-0000-0000-000000000001',
   'estado', 'Estado del expediente cambiado de EN REVISION a APROBADO.',
   'a2222222-2222-2222-2222-222222222222'),

  ('f0000008-0000-0000-0000-000000000007',
   'da000000-0000-0000-0000-000000000001',
   'contrato', 'Contrato de arrendamiento comercial generado usando la plantilla estándar.',
   'a2222222-2222-2222-2222-222222222222'),

  -- Timeline expediente da000002 (aprobado - Carlos Andrés)
  ('f0000008-0000-0000-0000-000000000008',
   'da000000-0000-0000-0000-000000000002',
   'creacion', 'Expediente creado para Carlos Andrés Herrera - Apartamento en San Fernando, Cali.',
   'a5555555-5555-5555-5555-555555555555'),

  ('f0000008-0000-0000-0000-000000000009',
   'da000000-0000-0000-0000-000000000002',
   'documento', 'Todos los documentos requeridos cargados y verificados correctamente.',
   'a5555555-5555-5555-5555-555555555555'),

  ('f0000008-0000-0000-0000-000000000010',
   'da000000-0000-0000-0000-000000000002',
   'pago', 'Pago de estudio recibido exitosamente por PSE. Referencia: pi_3RtX8kJ2eZvKYlo2C1.',
   'a5555555-5555-5555-5555-555555555555'),

  ('f0000008-0000-0000-0000-000000000011',
   'da000000-0000-0000-0000-000000000002',
   'estudio', 'Estudio de riesgo DataCrédito completado con score 720. Resultado: APROBADO.',
   'a5555555-5555-5555-5555-555555555555'),

  ('f0000008-0000-0000-0000-000000000012',
   'da000000-0000-0000-0000-000000000002',
   'estado', 'Estado del expediente cambiado de EN REVISION a APROBADO.',
   'a5555555-5555-5555-5555-555555555555'),

  ('f0000008-0000-0000-0000-000000000013',
   'da000000-0000-0000-0000-000000000002',
   'contrato', 'Contrato de arrendamiento generado y enviado para firma electrónica.',
   'a5555555-5555-5555-5555-555555555555'),

  ('f0000008-0000-0000-0000-000000000014',
   'da000000-0000-0000-0000-000000000002',
   'firma', 'Contrato firmado electrónicamente por el arrendatario Carlos Andrés Herrera.',
   NULL),

  -- Timeline expediente da000004 (rechazado)
  ('f0000008-0000-0000-0000-000000000015',
   'da000000-0000-0000-0000-000000000004',
   'creacion', 'Expediente creado para Sebastián Mejía Duque - Apartamento en Chicó Norte, Bogotá.',
   'a2222222-2222-2222-2222-222222222222'),

  ('f0000008-0000-0000-0000-000000000016',
   'da000000-0000-0000-0000-000000000004',
   'estudio', 'Estudio de riesgo DataCrédito completado con score 380. Resultado: RECHAZADO.',
   'a2222222-2222-2222-2222-222222222222'),

  ('f0000008-0000-0000-0000-000000000017',
   'da000000-0000-0000-0000-000000000004',
   'estado', 'Estado del expediente cambiado de EN REVISION a RECHAZADO. Motivo: ingresos insuficientes.',
   'a2222222-2222-2222-2222-222222222222'),

  -- Timeline expediente d5555555 (en_revision)
  ('f0000008-0000-0000-0000-000000000018',
   'd5555555-5555-5555-5555-555555555555',
   'creacion', 'Expediente creado para María Fernanda Torres - Apartamento en El Poblado, Medellín.',
   'a3333333-3333-3333-3333-333333333333');

COMMIT;

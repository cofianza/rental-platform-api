-- ============================================================
-- Contratos V3 — Entrega 5 (2 de 3): sobres de firma y matriz de estados V3.
-- Idempotente. Correr DESPUES de 20260925000001 (el enum) y ANTES del push.
--
-- (a) contrato_v3_sobres: un registro por proceso de firma en Auco. Los
--     firmantes viven en una columna JSONB porque su identidad ya esta
--     congelada en contrato_partes; aqui solo cambia su estado.
--     Tabla propia = el flujo de firma anterior (solicitudes_firma,
--     contrato_firmantes, auto-heal, post-firma) no ve ni una fila V3.
-- (b) transicionar_contrato: matriz propia para V3 (V3 §11). Es el guard
--     central: aunque falte una comprobacion en TypeScript, un contrato V3 no
--     puede moverse por un camino del flujo anterior.
-- ============================================================

-- ── (a) Sobres de firma V3 ──

CREATE TABLE IF NOT EXISTS public.contrato_v3_sobres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id UUID NOT NULL REFERENCES public.contratos(id) ON DELETE CASCADE,
  intento SMALLINT NOT NULL CHECK (intento >= 1),
  -- creando: se esta subiendo a Auco · en_firma: vivo · completo: firmaron todas
  -- las partes · incompleto: vencio o lo rechazaron · cancelado: lo anulo la
  -- inmobiliaria · fallido: Auco no lo creo (o quedo huerfano).
  estado VARCHAR(12) NOT NULL DEFAULT 'creando'
    CHECK (estado IN ('creando','en_firma','completo','incompleto','cancelado','fallido')),
  auco_code VARCHAR(32) UNIQUE,
  expira_en TIMESTAMPTZ NOT NULL,
  -- [{parteId, estado: pendiente|notificado|firmado|rechazado|bloqueado, aucoId, firmadoEn}]
  -- en orden de firma (V3 §6.5). Nombre, correo y telefono salen de contrato_partes.
  firmantes JSONB NOT NULL CHECK (jsonb_typeof(firmantes) = 'array'),
  motivo VARCHAR(20),               -- EXPIRED | REJECTED | CANCELADO | AUCO_UPLOAD | HUERFANO
  motivo_detalle TEXT,
  cerrado_en TIMESTAMPTZ,           -- completo: ultima firma segun Auco (UTC) = fecha de activacion
  auco_cancelado_en TIMESTAMPTZ,
  aviso_entregado_en TIMESTAMPTZ,   -- constancia del aviso (V3 §11.7.4)
  aviso_detalle JSONB,              -- {texto_version, texto, destinatarios[]} | {omitido|conflicto: ...}
  enviado_por UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contrato_v3_sobres_intento_uq UNIQUE (contrato_id, intento)
);

-- Un solo sobre vivo por contrato: tambien es el mutex del envio (dos clics = 23505).
CREATE UNIQUE INDEX IF NOT EXISTS contrato_v3_sobres_vivo_uq
  ON public.contrato_v3_sobres (contrato_id) WHERE estado IN ('creando','en_firma');
-- El barrido busca sobres vivos, avisos sin entregar y cancelaciones sin confirmar.
CREATE INDEX IF NOT EXISTS contrato_v3_sobres_estado_idx ON public.contrato_v3_sobres (estado);

DROP TRIGGER IF EXISTS contrato_v3_sobres_updated_at ON public.contrato_v3_sobres;
CREATE TRIGGER contrato_v3_sobres_updated_at BEFORE UPDATE ON public.contrato_v3_sobres
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Sin policies: solo el service_role de la API entra (igual que contrato_partes).
ALTER TABLE public.contrato_v3_sobres ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.contrato_v3_sobres IS
  'V3 §10-11: un proceso de firma de Auco por intento. cerrado_en (estado completo) = fecha de activacion de la fianza.';

-- ── (b) transicionar_contrato con matriz V3 ──
-- Copia literal de la funcion en produccion (20260313000001), con el estado del
-- contrato leido junto a destinacion y una matriz aparte para las filas V3.
-- El resto del cuerpo no cambia.

CREATE OR REPLACE FUNCTION public.transicionar_contrato(
  p_contrato_id uuid,
  p_nuevo_estado estado_contrato,
  p_descripcion text,
  p_usuario_id uuid,
  p_comentario text DEFAULT NULL::text,
  p_motivo text DEFAULT NULL::text
)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_estado_anterior estado_contrato;
  v_destinacion TEXT;
  v_contrato RECORD;
  v_historial_id UUID;
  v_transicion_valida BOOLEAN;
BEGIN
  -- Bloquear la fila para prevenir transiciones concurrentes
  SELECT estado, destinacion INTO v_estado_anterior, v_destinacion
  FROM contratos
  WHERE id = p_contrato_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contrato no encontrado: %', p_contrato_id;
  END IF;

  IF v_destinacion IS NOT NULL THEN
    -- Contratos V3 (§11): EN FIRMA = pendiente_firma, FIANZA ACTIVA = vigente.
    -- Nunca pasan por 'firmado'. borrador -> pendiente_firma lo hace el
    -- asistente con un UPDATE con control de concurrencia, no esta funcion.
    -- vigente -> finalizado (TERMINADO) entra en la Entrega 6.
    v_transicion_valida := CASE v_estado_anterior
      WHEN 'borrador'          THEN p_nuevo_estado IN ('cancelado')
      WHEN 'pendiente_firma'   THEN p_nuevo_estado IN ('vigente', 'firma_incompleta', 'cancelado')
      WHEN 'firma_incompleta'  THEN p_nuevo_estado IN ('pendiente_firma', 'cancelado')
      ELSE FALSE
    END;
  ELSE
    -- Validar transicion de estado permitida (flujo anterior, sin cambios)
    v_transicion_valida := CASE v_estado_anterior
      WHEN 'borrador'          THEN p_nuevo_estado IN ('en_revision', 'cancelado')
      WHEN 'en_revision'       THEN p_nuevo_estado IN ('aprobado', 'borrador', 'cancelado')
      WHEN 'aprobado'          THEN p_nuevo_estado IN ('pendiente_firma', 'borrador', 'cancelado')
      WHEN 'pendiente_firma'   THEN p_nuevo_estado IN ('firmado', 'cancelado')
      WHEN 'firmado'           THEN p_nuevo_estado IN ('vigente')
      WHEN 'vigente'           THEN p_nuevo_estado IN ('finalizado', 'cancelado')
      WHEN 'finalizado'        THEN FALSE
      WHEN 'cancelado'         THEN FALSE
      ELSE FALSE
    END;
  END IF;

  IF NOT v_transicion_valida THEN
    RAISE EXCEPTION 'Transicion no permitida: % -> %', v_estado_anterior, p_nuevo_estado;
  END IF;

  -- Actualizar estado del contrato
  UPDATE contratos
  SET estado = p_nuevo_estado,
      updated_at = NOW()
  WHERE id = p_contrato_id
  RETURNING * INTO v_contrato;

  -- Insertar en historial de estados
  INSERT INTO contrato_historial_estados (
    contrato_id, estado_anterior, estado_nuevo,
    comentario, motivo, descripcion, usuario_id
  )
  VALUES (
    p_contrato_id, v_estado_anterior, p_nuevo_estado,
    p_comentario, p_motivo, p_descripcion, p_usuario_id
  )
  RETURNING id INTO v_historial_id;

  RETURN json_build_object(
    'contrato_id', p_contrato_id,
    'estado_anterior', v_estado_anterior,
    'estado_nuevo', p_nuevo_estado,
    'historial_id', v_historial_id,
    'updated_at', v_contrato.updated_at
  );
END;
$function$;

-- ============================================================
-- Verificacion manual (despues de correrla; no deja rastro). Pegar completo en
-- el SQL editor: cada error esperado se atrapa; si algo no cuadra aborta con
-- "FALLA (x)". Al final debe salir el NOTICE "Verificacion E5: todo OK".
--   BEGIN;
--   DO $v$
--   DECLARE
--     e UUID := (SELECT id FROM expedientes LIMIT 1);
--     c UUID; l UUID;
--   BEGIN
--     ASSERT e IS NOT NULL, 'FALLA: no hay expedientes para la prueba';
--     INSERT INTO contratos (expediente_id, estado, destinacion, iva_canon_pct, datos_variables)
--       VALUES (e, 'borrador', 'vivienda', 0, '{"asistente":{}}') RETURNING id INTO c;
--     -- (a) V3: borrador -> pendiente_firma NO pasa por la funcion; el UPDATE directo si
--     BEGIN
--       PERFORM transicionar_contrato(c, 'pendiente_firma', 'v', NULL);
--       RAISE EXCEPTION 'FALLA (a): la funcion permitio borrador->pendiente_firma en V3';
--     EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--     END;
--     UPDATE contratos SET estado = 'pendiente_firma' WHERE id = c;
--     -- (b) V3: ->firmado no; ->firma_incompleta, ->pendiente_firma y ->vigente si
--     BEGIN
--       PERFORM transicionar_contrato(c, 'firmado', 'v', NULL);
--       RAISE EXCEPTION 'FALLA (b1): V3 paso por firmado';
--     EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--     END;
--     PERFORM transicionar_contrato(c, 'firma_incompleta', 'v', NULL);
--     PERFORM transicionar_contrato(c, 'pendiente_firma', 'v', NULL);
--     PERFORM transicionar_contrato(c, 'vigente', 'v', NULL);
--     BEGIN
--       PERFORM transicionar_contrato(c, 'cancelado', 'v', NULL);
--       RAISE EXCEPTION 'FALLA (b2): se cancelo una fianza activa V3';
--     EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--     END;
--     BEGIN
--       PERFORM transicionar_contrato(c, 'finalizado', 'v', NULL);
--       RAISE EXCEPTION 'FALLA (b3): TERMINADO es de la Entrega 6';
--     EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--     END;
--     -- (c) el congelamiento de V3 sigue vivo: una fianza activa no cambia de canon
--     BEGIN
--       UPDATE contratos SET valor_arriendo = 1 WHERE id = c;
--       RAISE EXCEPTION 'FALLA (c): se cambio una columna congelada';
--     EXCEPTION WHEN check_violation THEN NULL;
--     END;
--     -- (d) flujo anterior intacto: pendiente_firma -> vigente no; -> firmado -> vigente si
--     INSERT INTO contratos (expediente_id, estado) VALUES (e, 'pendiente_firma') RETURNING id INTO l;
--     BEGIN
--       PERFORM transicionar_contrato(l, 'vigente', 'v', NULL);
--       RAISE EXCEPTION 'FALLA (d): el flujo anterior salto firmado';
--     EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--     END;
--     PERFORM transicionar_contrato(l, 'firmado', 'v', NULL);
--     PERFORM transicionar_contrato(l, 'vigente', 'v', NULL);
--     -- (e) un solo sobre vivo por contrato
--     INSERT INTO contrato_v3_sobres (contrato_id, intento, estado, expira_en, firmantes)
--       VALUES (c, 1, 'en_firma', now() + interval '15 days', '[]');
--     BEGIN
--       INSERT INTO contrato_v3_sobres (contrato_id, intento, estado, expira_en, firmantes)
--         VALUES (c, 2, 'creando', now() + interval '15 days', '[]');
--       RAISE EXCEPTION 'FALLA (e): dos sobres vivos en el mismo contrato';
--     EXCEPTION WHEN unique_violation THEN NULL;
--     END;
--     RAISE NOTICE 'Verificacion E5: todo OK';
--   END $v$;
--   ROLLBACK;
-- ============================================================
--
-- ROLLBACK (manual; solo si no hay filas V3 fuera de borrador):
--   DROP TABLE IF EXISTS public.contrato_v3_sobres;
--   -- y volver a crear transicionar_contrato con el cuerpo de 20260313000001
--   -- (guardar antes: SELECT pg_get_functiondef('public.transicionar_contrato'::regproc);)

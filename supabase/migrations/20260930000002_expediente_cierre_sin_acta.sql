-- ============================================================
-- Adenda 1 del módulo de contratos, respuesta 21: un administrador de Cofianza
-- NO carga el acta de entrega (Cofianza avalaría un documento que no
-- presenció), pero sí puede CERRAR EL ESTUDIO SIN ACTA, con motivo registrado.
-- La ausencia de acta es evidencia en sí misma y el riesgo es de la inmobiliaria.
-- ------------------------------------------------------------
-- (a) expedientes: quién, cuándo y por qué se cerró sin acta. Sin FK a
--     perfiles: es constancia (no se pierde si se borra el perfil) y una
--     tercera FK expedientes -> perfiles volvería ambiguos más embeds.
-- (b) fn_expediente_cierre_requiere_acta: deja pasar el cierre cuyo MISMO
--     UPDATE pone esas columnas (cierre_sin_acta_en distinto del anterior) a
--     nombre de un administrador; una constancia que ya estaba no sirve para un
--     cierre posterior. Copia exacta de 20260926000001 (igual a la desplegada:
--     pg_get_functiondef, 2026-09-23) con esa condición en el segundo IF. El
--     trigger no cambia.
--
-- Idempotente. El API no la necesita para desplegar: hasta correrla, «Cerrar
-- sin acta» responde 503 y el detalle del estudio y la vista del contrato leen
-- estas columnas aparte y sin fallar (columna inexistente = sin cierre sin acta).
-- Después va 20260930000002b («Requieren mi acción»).
-- ROLLBACK: reaplicar (b) de 20260926000001 y
--   ALTER TABLE public.expedientes DROP CONSTRAINT IF EXISTS expedientes_cierre_sin_acta_chk,
--     DROP COLUMN IF EXISTS cierre_sin_acta_en, DROP COLUMN IF EXISTS cierre_sin_acta_por,
--     DROP COLUMN IF EXISTS cierre_sin_acta_motivo;
-- ============================================================

-- ── (a) constancia del cierre sin acta ──

ALTER TABLE public.expedientes
  ADD COLUMN IF NOT EXISTS cierre_sin_acta_en     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cierre_sin_acta_por    UUID,
  ADD COLUMN IF NOT EXISTS cierre_sin_acta_motivo TEXT;

ALTER TABLE public.expedientes DROP CONSTRAINT IF EXISTS expedientes_cierre_sin_acta_chk;
ALTER TABLE public.expedientes ADD CONSTRAINT expedientes_cierre_sin_acta_chk CHECK (
  (cierre_sin_acta_en IS NULL) = (cierre_sin_acta_por IS NULL)
  AND (cierre_sin_acta_en IS NULL) = (cierre_sin_acta_motivo IS NULL)
  AND (cierre_sin_acta_motivo IS NULL OR char_length(btrim(cierre_sin_acta_motivo)) BETWEEN 10 AND 1000)
);

COMMENT ON COLUMN public.expedientes.cierre_sin_acta_en IS
  'Adenda 1 contratos (respuesta 21): cuándo un administrador de Cofianza cerró el estudio sin acta de entrega. NULL = no se cerró así.';
COMMENT ON COLUMN public.expedientes.cierre_sin_acta_por IS
  'Perfil del administrador que cerró sin acta (sin FK: es constancia).';
COMMENT ON COLUMN public.expedientes.cierre_sin_acta_motivo IS
  'Motivo registrado del cierre sin acta (10 a 1000 caracteres).';

-- ── (b) el trigger de §12.2 deja pasar el cierre sin acta de un administrador ──

CREATE OR REPLACE FUNCTION public.fn_expediente_cierre_requiere_acta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM contratos c
    WHERE c.expediente_id = NEW.id AND c.destinacion IS NOT NULL AND c.estado = 'pendiente_firma'
  ) THEN
    RAISE EXCEPTION 'CONTRATO_EN_FIRMA: el contrato del estudio esta en firma; cancelalo antes de cerrar el estudio';
  END IF;
  -- Adenda 1 contratos (respuesta 21): pasa el cierre sin acta que este mismo UPDATE registra a nombre de un administrador.
  IF NOT (
    NEW.cierre_sin_acta_en IS NOT NULL
    AND NEW.cierre_sin_acta_en IS DISTINCT FROM OLD.cierre_sin_acta_en
    AND EXISTS (SELECT 1 FROM perfiles p WHERE p.id = NEW.cierre_sin_acta_por AND p.rol = 'administrador')
  ) AND EXISTS (
    SELECT 1 FROM contratos c
    WHERE c.expediente_id = NEW.id
      AND c.destinacion IS NOT NULL
      AND c.estado IN ('vigente', 'finalizado')
      AND NOT EXISTS (
        SELECT 1 FROM contrato_archivos a WHERE a.contrato_id = c.id AND a.tipo_archivo = 'acta_entrega'
      )
  ) THEN
    RAISE EXCEPTION 'ACTA_ENTREGA_REQUERIDA: el contrato del estudio tiene la fianza activa o terminada y no tiene acta de entrega e inventario';
  END IF;
  RETURN NEW;
END;
$function$;

-- CREATE OR REPLACE conserva los permisos; se repite la revocación de 20260926000002 por si se corre sola.
REVOKE EXECUTE ON FUNCTION public.fn_expediente_cierre_requiere_acta() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- Verificación manual (no deja rastro). Pegar completo en el SQL editor; si
-- algo no cuadra aborta con "FALLA (x)". Al final debe salir el NOTICE
-- "Verificacion cierre sin acta: todo OK".
--   BEGIN;
--   DO $v$
--   DECLARE
--     e UUID := (SELECT x.id FROM expedientes x WHERE x.estado <> 'cerrado' AND NOT EXISTS (
--       SELECT 1 FROM contratos t WHERE t.expediente_id = x.id AND t.estado <> 'cancelado') LIMIT 1);
--     adm UUID := (SELECT id FROM perfiles WHERE rol = 'administrador' LIMIT 1);
--     otro UUID := (SELECT id FROM perfiles WHERE rol = 'inmobiliaria' LIMIT 1);
--     c UUID;
--   BEGIN
--     ASSERT e IS NOT NULL AND adm IS NOT NULL AND otro IS NOT NULL, 'FALLA: faltan datos para la prueba';
--     INSERT INTO contratos (expediente_id, estado, destinacion, iva_canon_pct, datos_variables)
--       VALUES (e, 'borrador', 'vivienda', 0, '{"asistente":{}}') RETURNING id INTO c;
--     UPDATE contratos SET estado = 'vigente' WHERE id = c;
--     -- (1) sin acta y sin constancia: sigue sin cerrar
--     BEGIN
--       UPDATE expedientes SET estado = 'cerrado' WHERE id = e;
--       RAISE EXCEPTION 'FALLA (1): cerró sin acta';
--     EXCEPTION WHEN raise_exception THEN
--       IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--       ASSERT SQLERRM LIKE 'ACTA_ENTREGA_REQUERIDA%', 'FALLA (1): otro error: ' || SQLERRM;
--     END;
--     -- (2) la constancia a nombre de quien no es administrador no sirve
--     BEGIN
--       UPDATE expedientes SET estado = 'cerrado', cierre_sin_acta_en = now(), cierre_sin_acta_por = otro,
--         cierre_sin_acta_motivo = 'Motivo de prueba suficiente' WHERE id = e;
--       RAISE EXCEPTION 'FALLA (2): cerró sin acta a nombre de un no administrador';
--     EXCEPTION WHEN raise_exception THEN
--       IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--     END;
--     -- (2b) una constancia puesta antes (sin cerrar) no sirve para un cierre posterior
--     UPDATE expedientes SET cierre_sin_acta_en = now() - interval '1 minute', cierre_sin_acta_por = adm,
--       cierre_sin_acta_motivo = 'Constancia puesta sin cerrar' WHERE id = e;
--     BEGIN
--       UPDATE expedientes SET estado = 'cerrado' WHERE id = e;
--       RAISE EXCEPTION 'FALLA (2b): cerró con una constancia vieja';
--     EXCEPTION WHEN raise_exception THEN
--       IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--       ASSERT SQLERRM LIKE 'ACTA_ENTREGA_REQUERIDA%', 'FALLA (2b): otro error: ' || SQLERRM;
--     END;
--     UPDATE expedientes SET cierre_sin_acta_en = NULL, cierre_sin_acta_por = NULL, cierre_sin_acta_motivo = NULL WHERE id = e;
--     -- (3) motivo corto: lo frena el CHECK
--     BEGIN
--       UPDATE expedientes SET estado = 'cerrado', cierre_sin_acta_en = now(), cierre_sin_acta_por = adm,
--         cierre_sin_acta_motivo = 'corto' WHERE id = e;
--       RAISE EXCEPTION 'FALLA (3): aceptó un motivo de menos de 10 caracteres';
--     EXCEPTION WHEN check_violation THEN NULL;
--     END;
--     -- (4) administrador con motivo: cierra
--     UPDATE expedientes SET estado = 'cerrado', cierre_sin_acta_en = now(), cierre_sin_acta_por = adm,
--       cierre_sin_acta_motivo = 'La inmobiliaria no levantó el acta' WHERE id = e;
--     ASSERT (SELECT estado FROM expedientes WHERE id = e) = 'cerrado', 'FALLA (4): no cerró';
--     RAISE NOTICE 'Verificacion cierre sin acta: todo OK';
--   END $v$;
--   ROLLBACK;
--
-- Después de correrla (solo lectura):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'expedientes' AND column_name LIKE 'cierre_sin_acta%';  -- 3 filas
--   SELECT pg_get_functiondef('public.fn_expediente_cierre_requiere_acta()'::regprocedure) LIKE '%cierre_sin_acta_en%';  -- true
-- ============================================================

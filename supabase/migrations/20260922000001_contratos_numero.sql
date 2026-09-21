-- ============================================================
-- Contratos V3 — Entrega 2: consecutivo del contrato (V3 §9.2).
-- contratos.numero = CTO-AAAA-NNNN (año de Bogota), solo filas V3
-- (destinacion NOT NULL, columna de 20260921000001). Lo asigna un trigger al
-- insertar (MAX+1 bajo advisory lock, reinicia cada año) y no se puede cambiar.
-- Legacy V1/V4 queda NULL y el CHECK impide que una fila legacy se vuelva V3.
-- Idempotente; la corre el usuario a mano. Aditiva: ninguna ruta lee numero
-- en Entrega 2. fn_wipe_test_data no cambia: borra los contratos y MAX reinicia.
-- ============================================================

ALTER TABLE public.contratos ADD COLUMN IF NOT EXISTS numero VARCHAR(20);

ALTER TABLE public.contratos DROP CONSTRAINT IF EXISTS contratos_numero_chk;
ALTER TABLE public.contratos ADD CONSTRAINT contratos_numero_chk CHECK (
  (numero IS NULL) = (destinacion IS NULL)
  AND (numero IS NULL OR numero ~ '^CTO-[0-9]{4}-[0-9]{4,}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS contratos_numero_uq
  ON public.contratos (numero) WHERE numero IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_contratos_numero() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_anio TEXT := to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY');
  v_n    INT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.numero IS DISTINCT FROM OLD.numero THEN
      RAISE EXCEPTION 'contratos.numero es inmutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.destinacion IS NULL THEN RETURN NEW; END IF;   -- legacy V1/V4: sin numero (el CHECK rechaza uno enviado)
  -- Un solo consecutivo global: el lock serializa los INSERT V3 concurrentes
  -- hasta el commit; el indice unico es la red si alguien corre en REPEATABLE READ.
  PERFORM pg_advisory_xact_lock(hashtext('contratos.numero'));
  SELECT COALESCE(MAX(split_part(numero, '-', 3)::INT), 0) + 1 INTO v_n
    FROM public.contratos WHERE numero LIKE 'CTO-' || v_anio || '-%';
  NEW.numero := 'CTO-' || v_anio || '-' || LPAD(v_n::TEXT, GREATEST(4, length(v_n::TEXT)), '0');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS contratos_numero ON public.contratos;
CREATE TRIGGER contratos_numero BEFORE INSERT OR UPDATE OF numero ON public.contratos
  FOR EACH ROW EXECUTE FUNCTION public.fn_contratos_numero();

COMMENT ON COLUMN public.contratos.numero IS
  'Consecutivo V3 CTO-AAAA-NNNN (año Bogotá), asignado por trigger al insertar; inmutable. NULL = legacy.';

-- Verificacion manual (despues de correrla; no deja rastro):
--   BEGIN;
--   INSERT INTO contratos (expediente_id, destinacion, iva_canon_pct)
--     SELECT id, 'vivienda', 0 FROM expedientes LIMIT 2 RETURNING numero;       -- → CTO-2026-0001, CTO-2026-0002
--   INSERT INTO contratos (expediente_id) SELECT id FROM expedientes LIMIT 1 RETURNING numero;  -- → NULL
--   UPDATE contratos SET numero = 'CTO-2026-9999' WHERE numero IS NOT NULL;   -- → error: contratos.numero es inmutable
--   ROLLBACK;
-- Si el ADD CONSTRAINT falla, hay filas con destinacion sin numero (hoy ninguna:
-- la API no escribe destinacion); revisar con
--   SELECT id FROM contratos WHERE destinacion IS NOT NULL;

-- ROLLBACK (manual, no se ejecuta aqui):
--   DROP TRIGGER IF EXISTS contratos_numero ON public.contratos;
--   DROP FUNCTION IF EXISTS public.fn_contratos_numero();
--   ALTER TABLE public.contratos DROP COLUMN IF EXISTS numero;   -- arrastra contratos_numero_chk y contratos_numero_uq

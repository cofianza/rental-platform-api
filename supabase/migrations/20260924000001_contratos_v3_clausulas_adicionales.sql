-- ============================================================
-- Contratos V3 — Entrega 4: cláusulas adicionales (V3 §5, §8.6, §14.5). Idempotente.
-- Catálogo (biblioteca de Cofianza con inmobiliaria_id NULL + propias de cada inmobiliaria)
-- y registro pasivo de lo que se imprimió en cada contrato.
-- La corre el usuario ANTES del push de la API. Acceso solo vía API (service_role); RLS sin policies.
-- MAX_CLAUSULAS_ADICIONALES no necesita SQL: su valor por defecto vive en PARAMETROS (calibracion.ts).
-- ============================================================

-- Catálogo. Editar = version+1 con CAS sobre version (capa app). inmobiliaria_id sin ON DELETE
-- a propósito: una inmobiliaria con historial de cláusulas no se borra en duro; se suspende.
CREATE TABLE IF NOT EXISTS public.clausulas_adicionales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inmobiliaria_id UUID REFERENCES public.inmobiliarias(id),      -- NULL = biblioteca de Cofianza
  titulo VARCHAR(120) NOT NULL,
  texto VARCHAR(4000) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  estado VARCHAR(12) NOT NULL DEFAULT 'activa',
  validacion JSONB NOT NULL,                                      -- {reglas, ia: null|{sha256,modelo,en}}
  inhabilitada_motivo VARCHAR(500),
  inhabilitada_en TIMESTAMPTZ,
  creado_por UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT clausulas_adicionales_estado_chk CHECK (estado IN ('activa','inhabilitada','eliminada')),
  CONSTRAINT clausulas_adicionales_biblioteca_chk CHECK (estado <> 'eliminada' OR inmobiliaria_id IS NOT NULL),
  CONSTRAINT clausulas_adicionales_inhab_chk CHECK (estado <> 'inhabilitada'
    OR (inhabilitada_motivo IS NOT NULL AND inhabilitada_en IS NOT NULL)),
  CONSTRAINT clausulas_adicionales_largo_chk CHECK (char_length(titulo) BETWEEN 3 AND 120
    AND char_length(texto) BETWEEN 20 AND 4000 AND version >= 1)
);
CREATE INDEX IF NOT EXISTS clausulas_adicionales_org_idx ON public.clausulas_adicionales (inmobiliaria_id, estado);
DROP TRIGGER IF EXISTS clausulas_adicionales_updated_at ON public.clausulas_adicionales;
CREATE TRIGGER clausulas_adicionales_updated_at BEFORE UPDATE ON public.clausulas_adicionales
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
ALTER TABLE public.clausulas_adicionales ENABLE ROW LEVEL SECURITY;

-- Registro: lo escribe solo generar (delete + insert); guarda la versión y el texto impresos.
CREATE TABLE IF NOT EXISTS public.contrato_clausulas_adicionales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id UUID NOT NULL REFERENCES public.contratos(id) ON DELETE CASCADE,
  clausula_id UUID NOT NULL REFERENCES public.clausulas_adicionales(id),
  orden SMALLINT NOT NULL,
  numero SMALLINT NOT NULL,                                        -- número de cláusula impreso
  version INTEGER NOT NULL,
  origen VARCHAR(10) NOT NULL,
  titulo VARCHAR(120) NOT NULL,
  texto VARCHAR(4000) NOT NULL,                                    -- tal como se imprimió
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contrato_clausulas_adicionales_chk CHECK (origen IN ('biblioteca','propia')
    AND orden BETWEEN 1 AND 25 AND numero BETWEEN 1 AND 59 AND version >= 1),
  CONSTRAINT contrato_clausulas_adicionales_orden_uq UNIQUE (contrato_id, orden)
);
CREATE INDEX IF NOT EXISTS contrato_clausulas_adicionales_clausula_idx
  ON public.contrato_clausulas_adicionales (clausula_id);
-- Congelado fuera de borrador (función de E3, genérica por contrato_id; su mensaje dice "contrato_partes").
-- Padre inexistente = borrado en cascada (fn_wipe_test_data): la función lo deja pasar.
DROP TRIGGER IF EXISTS contrato_clausulas_adicionales_solo_borrador ON public.contrato_clausulas_adicionales;
CREATE TRIGGER contrato_clausulas_adicionales_solo_borrador BEFORE INSERT OR UPDATE OR DELETE
  ON public.contrato_clausulas_adicionales FOR EACH ROW EXECUTE FUNCTION public.fn_contrato_partes_solo_borrador();
ALTER TABLE public.contrato_clausulas_adicionales ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.clausulas_adicionales IS 'V3 §5.2: biblioteca (inmobiliaria_id NULL) y propias. Editar = version+1 con CAS; borrado lógico; inhabilitar solo hacia adelante.';
COMMENT ON TABLE public.contrato_clausulas_adicionales IS 'V3 §5.4: registro pasivo; lo escribe generar; congelado fuera de borrador.';

-- Verificacion manual (despues de correrla; no deja rastro). Pegar completo en el
-- SQL editor: cada error esperado se atrapa; si algo no cuadra aborta con "FALLA (x)".
-- Al final debe salir el NOTICE "Verificacion E4: todo OK".
--   BEGIN;
--   DO $v$
--   DECLARE
--     k UUID; c UUID;
--     e UUID := (SELECT x.id FROM expedientes x WHERE NOT EXISTS (
--       SELECT 1 FROM contratos t WHERE t.expediente_id = x.id AND t.destinacion IS NOT NULL
--       AND t.estado NOT IN ('cancelado','finalizado')) LIMIT 1);
--   BEGIN
--     ASSERT e IS NOT NULL, 'FALLA: no hay un estudio sin contrato V3 vivo para la prueba';
--     INSERT INTO clausulas_adicionales (titulo, texto, validacion)
--       VALUES ('Prueba', 'Texto de prueba de veinte o más', '{}') RETURNING id INTO k;
--     -- (a) la biblioteca no se elimina
--     BEGIN
--       UPDATE clausulas_adicionales SET estado = 'eliminada' WHERE id = k;
--       RAISE EXCEPTION 'FALLA (a): se elimino una clausula de la biblioteca';
--     EXCEPTION WHEN check_violation THEN NULL;
--     END;
--     -- (b) inhabilitar exige motivo y fecha
--     BEGIN
--       UPDATE clausulas_adicionales SET estado = 'inhabilitada' WHERE id = k;
--       RAISE EXCEPTION 'FALLA (b): se inhabilito sin motivo';
--     EXCEPTION WHEN check_violation THEN NULL;
--     END;
--     -- (c) en borrador el registro se escribe; fuera de borrador queda congelado
--     INSERT INTO contratos (expediente_id, estado, destinacion, iva_canon_pct, datos_variables)
--       VALUES (e, 'borrador', 'vivienda', 0, '{"asistente":{}}') RETURNING id INTO c;
--     INSERT INTO contrato_clausulas_adicionales (contrato_id, clausula_id, orden, numero, version, origen, titulo, texto)
--       VALUES (c, k, 1, 34, 1, 'biblioteca', 'Prueba', 'Texto');
--     UPDATE contratos SET estado = 'cancelado', motivo_cancelacion = 'prueba' WHERE id = c;
--     BEGIN
--       DELETE FROM contrato_clausulas_adicionales WHERE contrato_id = c;
--       RAISE EXCEPTION 'FALLA (c): se borro el registro de un contrato cancelado';
--     EXCEPTION WHEN check_violation THEN NULL;
--     END;
--     -- (d) borrar el contrato (wipe) arrastra su registro en cascada
--     DELETE FROM contratos WHERE id = c;
--     ASSERT NOT EXISTS (SELECT 1 FROM contrato_clausulas_adicionales WHERE contrato_id = c),
--       'FALLA (d): el registro no se borro en cascada';
--     RAISE NOTICE 'Verificacion E4: todo OK';
--   END $v$;
--   ROLLBACK;

-- ROLLBACK (manual, no se ejecuta aqui; el registro depende del catálogo, va primero):
--   DROP TABLE IF EXISTS public.contrato_clausulas_adicionales;
--   DROP TABLE IF EXISTS public.clausulas_adicionales;

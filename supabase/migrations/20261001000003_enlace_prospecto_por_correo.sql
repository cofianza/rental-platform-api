-- ============================================================
-- P18 (decisión 2026-09-24): el enlace personal del prospecto
-- (expedientes.token_documentos, /cargar-documentos/<token>) sube soportes y
-- ahora también invita a su co-arrendatario. Si se corrige el correo del
-- solicitante, el enlace que llegó al correo anterior deja de servir en todos
-- sus estudios. El siguiente envío (el del gestor o el correo del
-- condicionado) crea uno nuevo.
--
-- Trigger y no API: el correo se cambia desde cuatro sitios (la ficha del
-- solicitante, sus datos fiscales, la corrección al reenviar la autorización y
-- el enlace del estudio self-service) y todos escriben `solicitantes` directo.
-- Un cambio solo de mayúsculas o espacios no cuenta.
--
-- El API no depende de ella: antes y después funciona igual (sin ella, el
-- enlace viejo sigue vivo hasta que el gestor lo reenvíe). Idempotente.
-- ROLLBACK: DROP TRIGGER IF EXISTS trg_solicitantes_email_invalida_enlace ON public.solicitantes;
--           DROP FUNCTION IF EXISTS public.invalidar_enlace_prospecto_por_correo();
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.invalidar_enlace_prospecto_por_correo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.expedientes
     SET token_documentos = NULL,
         token_documentos_expiracion = NULL
   WHERE solicitante_id = NEW.id
     AND token_documentos IS NOT NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_solicitantes_email_invalida_enlace ON public.solicitantes;
CREATE TRIGGER trg_solicitantes_email_invalida_enlace
  AFTER UPDATE OF email ON public.solicitantes
  FOR EACH ROW
  WHEN (lower(btrim(coalesce(OLD.email, ''))) IS DISTINCT FROM lower(btrim(coalesce(NEW.email, ''))))
  EXECUTE FUNCTION public.invalidar_enlace_prospecto_por_correo();

COMMIT;

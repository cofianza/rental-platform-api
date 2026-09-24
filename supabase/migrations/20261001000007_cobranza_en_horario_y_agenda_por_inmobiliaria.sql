-- ============================================================
-- 20261001000007 — decisiones del 2026-09-24 (paquete Q7).
-- Idempotente; el API funciona antes y después de correrla.
--
-- 1) Moras — horario de cobranza (Ley 2300 de 2023, art. 3).
--    Los WhatsApp de cobro solo salen de lunes a viernes de 7 a. m. a 7 p. m.
--    y los sábados de 8 a. m. a 3 p. m. (sin domingos ni festivos), y una sola
--    gestión por día al mismo deudor. Lo que cae fuera queda programado en
--    whatsapp_programado_para y lo manda el barrido horario de moras
--    (MORAS_AUTOESCALAR_ENABLED). Sin esta columna el API envía en el acto,
--    como antes.
-- ============================================================

ALTER TABLE moras_tickets ADD COLUMN IF NOT EXISTS whatsapp_programado_para TIMESTAMPTZ;

COMMENT ON COLUMN moras_tickets.whatsapp_programado_para IS
  'Cuándo sale el WhatsApp de cobro de la fase actual que la Ley 2300 dejó esperando (fuera de horario o con otra gestión ese día). NULL = nada pendiente.';

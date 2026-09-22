-- ============================================================
-- Contratos V3 — Entrega 5 (1 de 3): estado FIRMA INCOMPLETA (V3 §11.3).
-- El proceso de firma se cerro (rechazo) o vencio sin que firmaran todas las
-- partes: no hay cobertura, no se causa tarifa y ningun modulo posterior avanza.
--
-- VA SOLA: Postgres no deja usar un valor de enum nuevo en la misma transaccion
-- en que se agrega, y el SQL editor corre cada archivo en una transaccion.
-- Correrla ANTES de 20260925000002 y del push de la API.
--
-- AFTER 'pendiente_firma': el orden del enum es el que usa `sortBy=estado`
-- (contratos.schema.ts) para ordenar los listados.
-- ============================================================

ALTER TYPE public.estado_contrato ADD VALUE IF NOT EXISTS 'firma_incompleta' AFTER 'pendiente_firma';

-- Verificacion (correr aparte, despues):
--   SELECT enum_range(NULL::estado_contrato);
--   -- esperado: {borrador,pendiente_firma,firma_incompleta,firmado,vigente,finalizado,cancelado,en_revision,aprobado}
--   SELECT 'firma_incompleta' = ANY(enum_range(NULL::estado_contrato)::text[]);  -- true
--
-- contrato_historial_estados usa el mismo tipo: acepta el valor sin mas cambios.
--
-- ROLLBACK: Postgres no tiene DROP VALUE. El valor queda sin uso (ningun CHECK,
-- vista ni funcion lo exige) y no afecta a ninguna fila existente.

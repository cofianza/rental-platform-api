-- Mario 12-may-2026 — Mockup de registro inmobiliaria pide capturar el
-- "Cargo" del representante legal (ej: Gerente, Representante Legal,
-- Director Comercial). Opcional para no romper registros existentes.

ALTER TABLE perfiles
  ADD COLUMN IF NOT EXISTS cargo_representante VARCHAR(100);

COMMENT ON COLUMN perfiles.cargo_representante IS 'Cargo del representante legal (solo inmobiliaria) — pedido por Mario en mockup nueva propuesta UI.';

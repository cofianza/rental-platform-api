-- ============================================================
-- Token público para que el solicitante cargue documentación adicional
-- ------------------------------------------------------------
-- Cuando el estudio queda 'condicionado' y la inmobiliaria creó el expediente,
-- el solicitante no tiene cuenta para subir sus soportes. Este token permite
-- un enlace público (sin login) para que cargue la documentación, igual que
-- los flujos de estudio/autorización. La inmobiliaria genera y envía el enlace
-- desde el expediente.
-- ============================================================

ALTER TABLE public.expedientes
  ADD COLUMN IF NOT EXISTS token_documentos VARCHAR(64),
  ADD COLUMN IF NOT EXISTS token_documentos_expiracion TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_expedientes_token_documentos
  ON public.expedientes(token_documentos)
  WHERE token_documentos IS NOT NULL;

COMMENT ON COLUMN public.expedientes.token_documentos IS
  'Token opaco para el enlace público de carga de documentación del solicitante (condicionado).';

-- Política Anexo A.4: el independiente informal (sin RUT activo) no puede recibir
-- aprobación automática. La autorización pregunta «¿Tienes RUT activo?» solo a
-- quien declara 'independiente'; un «No» explícito manda a revisión manual
-- (reglas-duras.ts). NULL = no contestó (no se asume nada). Idempotente; la API
-- ya desplegada funciona sin esta columna (el UPDATE aparte solo deja un aviso).
ALTER TABLE public.autorizacion_perfil_prospecto
  ADD COLUMN IF NOT EXISTS tiene_rut BOOLEAN;

COMMENT ON COLUMN public.autorizacion_perfil_prospecto.tiene_rut IS
  'Respuesta a «¿Tienes RUT activo?» (solo independientes). false → revisión manual (Política Anexo A.4). NULL = no contestó.';

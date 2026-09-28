-- E2 · La vista de sombra respeta los permisos de quien consulta.
-- Riesgo de romper: NULO (nadie fuera de service_role la lee; la API no la usa).
ALTER VIEW public.v_estudios_sombra_vs_real SET (security_invoker = on);
-- Rollback: ALTER VIEW public.v_estudios_sombra_vs_real RESET (security_invoker);

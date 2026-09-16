-- ============================================================
-- NIT único por inmobiliaria
--
-- El registro escribía el NIT sin consultar: dos personas de la misma
-- inmobiliaria podían registrarse por separado y `ensureOrgConOwner` creaba una
-- SEGUNDA organización con la misma razón social. Resultado: cartera partida,
-- equipo invisible entre sí, y dos clientes ante la DIAN donde hay uno.
--
-- El servicio ya hace un pre-chequeo (registration.service.ts), pero eso tiene
-- una carrera: dos registros simultáneos la pasan los dos. Este índice es el
-- cierre real.
--
-- Parcial: solo aplica a filas con NIT. Los propietarios individuales y los
-- solicitantes lo tienen NULL y no se ven afectados.
--
-- Verificado antes de crearlo: 0 NIT duplicados en producción (2026-09-16).
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_perfiles_nit
  ON public.perfiles (nit)
  WHERE nit IS NOT NULL AND btrim(nit) <> '';

COMMENT ON INDEX public.uq_perfiles_nit IS
  'Una inmobiliaria por NIT. El segundo registro recibe 23505 → NIT_ALREADY_EXISTS.';

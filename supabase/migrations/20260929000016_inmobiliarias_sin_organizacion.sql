-- ============================================================
-- Inmobiliarias dadas de alta desde el panel, sin organización
--
-- Solo el registro público creaba la organización (ensureOrgConOwner). El alta
-- del administrador (/usuarios, "Nueva inmobiliaria") dejaba la cuenta sin
-- organización ni membresía: /auth/me devolvía rol_miembro null, la web le
-- mostraba sus datos en solo lectura y createInmueble la mandaba a completar
-- esos mismos datos. El API ya crea la organización en el alta; esto repara
-- las cuentas que quedaron así (mismo patrón que 20260619000001, 4a/4b).
--
-- Solo perfiles 'inmobiliaria' que NUNCA tuvieron membresía: un ex-miembro
-- (fila revocada) no se convierte en titular de una agencia propia.
-- Idempotente.
-- ============================================================

INSERT INTO public.inmobiliarias (nombre, owner_perfil_id)
SELECT
  COALESCE(
    NULLIF(TRIM(p.razon_social), ''),
    NULLIF(TRIM(p.nombre || ' ' || COALESCE(p.apellido, '')), ''),
    'Inmobiliaria'
  ),
  p.id
FROM public.perfiles p
WHERE p.rol = 'inmobiliaria'
  AND NOT EXISTS (SELECT 1 FROM public.inmobiliaria_miembros m WHERE m.perfil_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM public.inmobiliarias i WHERE i.owner_perfil_id = p.id);

INSERT INTO public.inmobiliaria_miembros (inmobiliaria_id, perfil_id, rol_miembro, estado)
SELECT i.id, i.owner_perfil_id, 'owner', 'activo'
FROM public.inmobiliarias i
JOIN public.perfiles p ON p.id = i.owner_perfil_id
WHERE p.rol = 'inmobiliaria'
  AND NOT EXISTS (SELECT 1 FROM public.inmobiliaria_miembros m WHERE m.perfil_id = i.owner_perfil_id);

-- Sus fichas registradas sin organización pasan a la suya: con org, el API
-- acota solicitantes por inmobiliaria_id y dejaría de verlas (y la
-- deduplicación crearía otra ficha de la misma persona). Se salta la que
-- chocaría con una ficha de la org con el mismo documento (índice único).
UPDATE public.solicitantes s
SET inmobiliaria_id = i.id
FROM public.inmobiliarias i
JOIN public.inmobiliaria_miembros m
  ON m.inmobiliaria_id = i.id AND m.perfil_id = i.owner_perfil_id
 AND m.rol_miembro = 'owner' AND m.estado = 'activo'
JOIN public.perfiles p ON p.id = i.owner_perfil_id AND p.rol = 'inmobiliaria'
WHERE s.creado_por = i.owner_perfil_id
  AND s.inmobiliaria_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.solicitantes o
    WHERE o.inmobiliaria_id = i.id
      AND o.tipo_documento = s.tipo_documento
      AND o.numero_documento = s.numero_documento
  );

-- Verificación (debe devolver 0):
-- SELECT count(*) FROM public.perfiles p
-- WHERE p.rol = 'inmobiliaria'
--   AND NOT EXISTS (SELECT 1 FROM public.inmobiliaria_miembros m WHERE m.perfil_id = p.id);
-- SELECT count(*) FROM public.solicitantes s
-- JOIN public.inmobiliarias i ON i.owner_perfil_id = s.creado_por
-- WHERE s.inmobiliaria_id IS NULL;

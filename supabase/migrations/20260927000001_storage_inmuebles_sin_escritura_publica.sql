-- ============================================================
-- Seguridad (urgente): el bucket `inmuebles` (fotos de los inmuebles) se
-- podía escribir y borrar con la llave anon, que va en el JS público de la
-- web. Cualquiera podía subir, reemplazar o borrar fotos de cualquier inmueble
-- sin iniciar sesión.
--
-- Desde hace tiempo todo pasa por la API (service_role, que no mira estas
-- políticas): subir con POST /inmuebles/upload-fachada y borrar con
-- DELETE /inmuebles/:id/fotos/:fotoId, que valida el acceso al inmueble y
-- borra el archivo. La web ya no toca storage (commit del mismo día).
--
-- También se quitan los SELECT: un bucket público se lee por su URL pública
-- sin revisar políticas; el SELECT solo servía para LISTAR el bucket entero
-- con la llave anon (incluidas fotos de inmuebles que no están en la
-- vitrina). Nadie lista: la web solo usa URLs /object/public/. La última
-- política es del bucket `inmuebles-fotos`, vacío y sin uso en el código.
--
-- Resultado: las fotos se siguen viendo igual (bucket público); escribir,
-- borrar y listar queda solo para la API.
-- ============================================================

DROP POLICY IF EXISTS "Allow public uploads to inmuebles" ON storage.objects;
DROP POLICY IF EXISTS "Allow public deletes from inmuebles" ON storage.objects;
DROP POLICY IF EXISTS "Usuarios autenticados pueden subir fotos" ON storage.objects;
DROP POLICY IF EXISTS "Usuarios autenticados pueden actualizar fotos" ON storage.objects;
DROP POLICY IF EXISTS "Usuarios autenticados pueden eliminar fotos" ON storage.objects;
DROP POLICY IF EXISTS "Allow public reads from inmuebles" ON storage.objects;
DROP POLICY IF EXISTS "Fotos de inmuebles son publicas" ON storage.objects;
DROP POLICY IF EXISTS "Fotos públicas de inmuebles" ON storage.objects;

-- Verificación (debe devolver 0 filas):
--   SELECT policyname FROM pg_policies
--   WHERE schemaname = 'storage' AND tablename = 'objects'
--     AND (qual LIKE '%inmuebles%' OR with_check LIKE '%inmuebles%');

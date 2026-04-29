-- =====================================================
-- Notificaciones in-app (Realtime via Supabase)
--
-- El backend escribe filas con service-role; el frontend se suscribe via
-- supabase.channel() filtrando por user_id. RLS garantiza que cada perfil
-- solo lee/actualiza sus propias notificaciones.
-- =====================================================

CREATE TABLE notificaciones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES perfiles(id) ON DELETE CASCADE,
  -- Categoria libre (cita.creada, cita.aceptada, estudio.aprobado,
  -- contrato.firmado, pago.confirmado, etc). El frontend la usa para
  -- decidir icono/color del item en el dropdown.
  tipo        TEXT NOT NULL,
  titulo      TEXT NOT NULL,
  mensaje     TEXT NOT NULL,
  -- Ruta interna a la que el clic redirige (eg. /expedientes/<id>).
  link        TEXT,
  -- Datos extra opcionales por si el frontend quiere mostrar contexto.
  payload     JSONB,
  -- NULL = no leida. Marcar leida = SET leida_at = NOW().
  leida_at    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index ordenado por usuario+fecha desc para listar las mas recientes
-- y filtrar no-leidas (leida_at IS NULL) eficientemente.
CREATE INDEX notificaciones_user_created_idx
  ON notificaciones (user_id, created_at DESC);

CREATE INDEX notificaciones_user_unread_idx
  ON notificaciones (user_id) WHERE leida_at IS NULL;

ALTER TABLE notificaciones ENABLE ROW LEVEL SECURITY;

-- Cada usuario lee solo sus propias notificaciones.
CREATE POLICY "users_read_own_notificaciones" ON notificaciones
  FOR SELECT USING (user_id = auth.uid());

-- Cada usuario marca como leida (UPDATE leida_at) solo sus propias.
CREATE POLICY "users_update_own_notificaciones" ON notificaciones
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- INSERT solo via service_role (sin policy publica). Los usuarios no pueden
-- crear notificaciones — solo el backend.

-- Habilita Realtime broadcast para INSERT/UPDATE en esta tabla.
ALTER PUBLICATION supabase_realtime ADD TABLE notificaciones;

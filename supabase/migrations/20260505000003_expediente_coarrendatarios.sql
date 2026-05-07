-- ============================================================
-- Co-arrendatario: nuevo flujo cuando el estudio queda condicionado.
--
-- Mario (5-may-2026): la promesa "rentar sin fiador" no admite pedir
-- codeudor ni documentos extra al solicitante. En lugar de eso, cuando
-- el estudio queda condicionado, le pedimos al solicitante que invite
-- a un co-arrendatario (la persona con quien va a vivir). El
-- co-arrendatario acepta T&C + política y se le hace su propio estudio
-- TransUnion. Los dos estudios se ponderan: si combinados pasan, el
-- expediente sube a 'aprobado'; si no, se rechaza.
--
-- IMPORTANTE: el cobro original ($80.000) cubre los dos estudios — no
-- se cobra al co-arrendatario.
--
-- Esta tabla guarda los datos del co-arrendatario invitado, el token
-- único de invitación, su decisión, y un FK al estudio que se le creó.
-- El co-arrendatario NO necesita crear cuenta — solo aceptar desde el
-- link público que recibe por correo.
-- ============================================================

CREATE TABLE expediente_coarrendatarios (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expediente_id         UUID NOT NULL REFERENCES expedientes(id) ON DELETE CASCADE,

  -- Datos capturados por el solicitante al invitar.
  nombre                VARCHAR(100) NOT NULL,
  apellido              VARCHAR(100) NOT NULL,
  tipo_documento        tipo_documento_id NOT NULL DEFAULT 'cc',
  numero_documento      VARCHAR(20) NOT NULL,
  email                 VARCHAR(255) NOT NULL,
  telefono              VARCHAR(20),

  -- Token de invitación: el co-arrendatario llega a /coarrendatario/[token].
  -- Cifrado en URL como random hex 32 bytes.
  token                 VARCHAR(64) NOT NULL UNIQUE,
  token_expiracion      TIMESTAMPTZ NOT NULL,

  -- Estado del flujo:
  --   pendiente_aceptacion → invitación enviada, sin respuesta
  --   aceptado             → aceptó T&C + política, se disparó estudio
  --   rechazado_invitacion → declinó la invitación
  --   estudio_completado   → su estudio terminó (aprobado/rechazado/condicionado)
  estado                VARCHAR(30) NOT NULL DEFAULT 'pendiente_aceptacion'
                          CHECK (estado IN (
                            'pendiente_aceptacion',
                            'aceptado',
                            'rechazado_invitacion',
                            'estudio_completado'
                          )),

  -- Auditoría legal de aceptación: si la persona acepta, registramos cuándo,
  -- desde qué IP y user-agent (mismo patrón que terminos_aceptaciones).
  aceptado_at           TIMESTAMPTZ,
  aceptado_ip           VARCHAR(45),
  aceptado_user_agent   TEXT,
  rechazado_at          TIMESTAMPTZ,

  -- FK al estudio que se le creó al aceptar. Se llena tras dispatch a TransUnion.
  estudio_id            UUID REFERENCES estudios(id) ON DELETE SET NULL,

  -- Quién invitó (titular del expediente). FK opcional para legacy.
  invitado_por          UUID REFERENCES perfiles(id) ON DELETE SET NULL,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER expediente_coarrendatarios_updated_at
  BEFORE UPDATE ON expediente_coarrendatarios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Solo un coarrendatario activo (no rechazado) por expediente. Si se rechaza
-- y el solicitante quiere invitar a otro, debe primero dejar el primero como
-- 'rechazado_invitacion'.
CREATE UNIQUE INDEX idx_expediente_coarrendatarios_expediente_activo
  ON expediente_coarrendatarios(expediente_id)
  WHERE estado <> 'rechazado_invitacion';

-- Lookup eficiente desde la página pública por token (path principal).
CREATE INDEX idx_expediente_coarrendatarios_token
  ON expediente_coarrendatarios(token);

CREATE INDEX idx_expediente_coarrendatarios_expediente
  ON expediente_coarrendatarios(expediente_id);

COMMENT ON TABLE expediente_coarrendatarios IS
  'Invitaciones de co-arrendatario para expedientes condicionados. Mario (5-may-2026): reemplaza el flujo de subir documentación adicional. El co-arrendatario acepta T&C y se le hace estudio TransUnion automáticamente; el resultado se pondera con el del titular para decidir el expediente.';

COMMENT ON COLUMN expediente_coarrendatarios.estudio_id IS
  'Estudio TransUnion creado para este co-arrendatario tras aceptar la invitación. NULL antes de aceptar.';

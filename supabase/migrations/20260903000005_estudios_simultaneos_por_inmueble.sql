-- ============================================================
-- Estudios simultaneos por inmueble (Flujo de Gerencia, modulo de estudios,
-- §4.2 — CAMBIO APROBADO).
--
-- Literal del documento: "Una misma propiedad debe admitir varios estudios en
-- curso de manera simultanea. La propiedad NO se bloquea porque exista un
-- estudio en proceso. [...] La propiedad se marca como reservada y deja de
-- admitir nuevos estudios unicamente cuando un estudio resulta APROBADO y
-- avanza a la generacion del contrato."
--
-- LA REGLA NUEVA, EN UNA LINEA:
--   el estado del inmueble sigue el ciclo del CONTRATO, no el del ESTUDIO.
--
-- Por eso, despues de esta migracion, NINGUN RPC de estudios escribe
-- `inmuebles.estado`: ni al crear el estudio, ni al cancelarlo, ni al registrar
-- su resultado. Cancelar el estudio de UN candidato entre varios no puede
-- cambiar el estado de la propiedad de los demas.
--
-- ── QUE PASA CON 'en_estudio' ─────────────────────────────────────────────
--
-- DEJA DE ESCRIBIRSE. El valor NO se elimina del enum estado_inmueble: hay
-- filas historicas y ~14 archivos que lo nombran, y borrarlo del enum romperia
-- datos y codigo. Simplemente ningun camino nuevo lo produce — mientras hay
-- estudios en curso el inmueble se queda 'disponible'.
--
-- La alternativa (conservarlo como estado informativo NO bloqueante) se
-- descarto porque obligaria a cambiar TODA consulta que hoy filtra
-- `estado = 'disponible'` — que es la REGLA CANONICA DE VITRINA de la
-- auditoria previa, escrita en ~8 sitios del backend y otros tantos de la web.
-- Son mas sitios que tocar, cada uno una oportunidad de reintroducir el doble
-- arriendo, y el que se olvide falla en silencio. El indicador de estudios
-- activos (§4.2) transporta esa misma informacion sin falsear la
-- disponibilidad, y ademas dice CUANTOS. Justificacion completa en
-- src/modules/estudios/estudios-simultaneos.guard.ts.
--
-- 'ocupado' NO cambia: sigue bloqueando exactamente igual que hoy.
--
-- ── DONDE QUEDA LA PROTECCION CONTRA EL DOBLE ARRIENDO ────────────────────
--
-- Se corre del inicio (bloquear al primer estudio) al final (reservar al
-- aprobar), y ese punto tiene que ser a prueba de concurrencia. Lo es por dos
-- mecanismos que se refuerzan:
--
--   1. `inmuebles.reservado_por_expediente_id` — un TITULAR ESCALAR. Una fila,
--      una columna, un titular. Es estructuralmente imposible que dos
--      expedientes queden reservados sobre el mismo inmueble, porque no hay
--      dos valores posibles en una sola celda.
--   2. `fn_reservar_inmueble_para_contrato` toma la fila con SELECT ... FOR
--      UPDATE antes de decidir. La segunda de dos aprobaciones concurrentes se
--      bloquea ahi, y al despertar lee la version nueva con el titular ya
--      escrito -> RAISE 'INMUEBLE_YA_RESERVADO' -> 409 en la API.
--
-- (Un indice unico parcial sobre `contratos` seria la red equivalente, pero
--  `contratos` no tiene `inmueble_id` — llega al inmueble via `expediente_id` —
--  y Postgres no admite indices unicos que crucen tablas. La columna escalar da
--  la misma garantia.)
--
-- ── PRESERVADO DE TRABAJO ANTERIOR ────────────────────────────────────────
--
--   * Auditoria "vitrina vs ocupado": la regla canonica
--     `publicado <=> visible_vitrina = true AND estado = 'disponible'` NO se
--     toca. Lo unico que cambia es cuantos inmuebles califican. La reserva usa
--     'ocupado' + visible_vitrina=false justamente para salir de la vitrina por
--     la regla de siempre, sin logica nueva.
--   * 20260817000002 ("no liberar el inmueble si el expediente ya esta
--     aprobado"): su intencion se conserva y se ENDURECE. Antes se expresaba
--     como "no liberes si el expediente esta aprobado"; ahora se expresa como
--     "solo libera si ESTE expediente es el titular de la reserva", que cubre
--     el mismo caso y ademas el nuevo (varios candidatos: el rechazo de B no
--     puede soltar la reserva de A).
-- ============================================================


-- ============================================================
-- 1. Titular de la reserva
-- ============================================================

ALTER TABLE inmuebles
  ADD COLUMN IF NOT EXISTS reservado_por_expediente_id UUID
    REFERENCES expedientes(id) ON DELETE SET NULL;

COMMENT ON COLUMN inmuebles.reservado_por_expediente_id IS
  'Expediente aprobado que reservo la propiedad al generar su contrato (Flujo §4.2). NULL = sin reserva. Es el titular unico: al ser una sola celda de la fila del inmueble, dos aprobaciones concurrentes no pueden producir dos reservas. Se limpia al terminar/cancelar el contrato o al rechazarse/cerrarse el expediente titular.';

-- Indice parcial: solo interesan las filas reservadas (hoy 3 de 5, y en
-- regimen normal una fraccion pequeña del inventario).
CREATE INDEX IF NOT EXISTS idx_inmuebles_reservado_por_expediente
  ON inmuebles (reservado_por_expediente_id)
  WHERE reservado_por_expediente_id IS NOT NULL;


-- ============================================================
-- 2. Normalizacion de los inmuebles atascados en 'en_estudio'
--
-- CRITERIO (revisado fila por fila contra produccion el 2026-09-03, no
-- aplicado en bloque):
--
--   Un inmueble 'en_estudio' CONSERVA la reserva si y solo si alguno de sus
--   expedientes tiene un contrato NO TERMINAL. "No terminal" se define POR
--   EXCLUSION —cualquier estado que no sea 'finalizado' ni 'cancelado'— y no
--   por una lista positiva: 'en_revision' y 'aprobado' son estados de primera
--   clase de la linea principal del state machine (borrador -> en_revision ->
--   aprobado -> pendiente_firma) y enumerarlos a mano ya se olvido una vez.
--   Un contrato en 'en_revision' compromete la propiedad igual que uno en
--   'pendiente_firma': avanza a firma sin volver a pasar por el CAS. Ese es
--   exactamente el hecho que la regla nueva
--   considera reserva: "un estudio aprobado avanzo a la generacion del
--   contrato". En ese caso pasa a 'ocupado' + visible_vitrina=false + titular
--   anotado. Todos los demas pasan a 'disponible'.
--
--   Un expediente 'aprobado' SIN contrato se libera a proposito: bajo la regla
--   nueva la reserva nace al generar el contrato, no al aprobar. Si el gestor
--   genera el contrato despues, el CAS de fn_reservar_inmueble_para_contrato
--   la vuelve a tomar — y si otro candidato llego primero, recibe un 409
--   claro en vez de un doble arriendo silencioso.
--
-- ESTADO MEDIDO (SELECT de verificacion, 2026-09-03 — ninguno de los 4 tenia
-- UN SOLO estudio en curso; estaban atascados por fuga del bloqueo temporal,
-- no por candidatos vivos):
--
--   2051    vitrina=false  EXP-2026-0004 cerrado    (contratos finalizado + 2 cancelados)
--                          EXP-2026-0006 aprobado   contrato BORRADOR
--                          -> RESERVADO por EXP-2026-0006
--   2054    vitrina=TRUE   EXP-2026-0005 aprobado   contrato PENDIENTE_FIRMA
--                          EXP-2026-0007 borrador   (sin contrato)
--                          -> RESERVADO por EXP-2026-0005; la vitrina se apaga
--   2062    vitrina=false  EXP-2026-0001 borrador   (sin contrato)
--                          EXP-2026-0010 aprobado   contrato BORRADOR
--                          -> RESERVADO por EXP-2026-0010
--   Apt-013 vitrina=TRUE   EXP-2026-0008 cerrado    (sin contrato)
--                          EXP-2026-0009 condicionado (sin contrato)
--                          -> DISPONIBLE (ningun contrato en curso)
--
-- DECISION EXPLICITA SOBRE visible_vitrina (la migracion tiene que decidirlo,
-- porque 2054 y Apt-013 lo tienen encendido):
--
--   * Los que quedan RESERVADOS -> visible_vitrina = false. Obligatorio: la
--     regla canonica dice que un inmueble fuera de 'disponible' no se publica,
--     y dejar el flag encendido reproduce el bug Apt-001 de jul-2026 (el panel
--     mostraba "En vitrina" y el toggle en ON sobre un inmueble arrendado).
--     Afecta a 2054.
--
--   * Los que quedan DISPONIBLES -> se RESPETA el flag tal como esta. NO se
--     apaga. Apt-013 vuelve a aparecer publicado, y eso es lo correcto por dos
--     razones: (a) ese true lo puso su dueño, y apagarlo seria despublicarle
--     una propiedad sin que lo pidiera; (b) es literalmente el comportamiento
--     que la auditoria previa dejo preparado — la coercion de visible_vitrina
--     del PUT exime a 'en_estudio' a proposito, con el comentario "el flag se
--     CONSERVA para que el inmueble vuelva solo a la vitrina si el estudio se
--     cae". Aqui el estudio se cayo. Y es ademas lo que §4.2 persigue: hoy el
--     80% del inventario esta fuera de la vitrina por este bloqueo.
-- ============================================================

-- 2a. Los que conservan reserva: 'en_estudio' -> 'ocupado' + titular.
WITH titular AS (
  SELECT DISTINCT ON (e.inmueble_id)
         e.inmueble_id,
         e.id AS expediente_id
    FROM expedientes e
    JOIN contratos c ON c.expediente_id = e.id
   WHERE c.estado::TEXT NOT IN ('finalizado', 'cancelado')
     AND e.inmueble_id IN (SELECT id FROM inmuebles WHERE estado::TEXT = 'en_estudio')
   ORDER BY e.inmueble_id,
            -- el contrato mas avanzado manda; a igualdad, el mas reciente
            CASE c.estado::TEXT
              WHEN 'vigente' THEN 0
              WHEN 'firmado' THEN 1
              WHEN 'pendiente_firma' THEN 2
              WHEN 'aprobado' THEN 3
              WHEN 'en_revision' THEN 4
              ELSE 5
            END,
            c.created_at DESC
)
UPDATE inmuebles i
   SET estado = 'ocupado',
       visible_vitrina = FALSE,
       reservado_por_expediente_id = t.expediente_id,
       updated_at = NOW()
  FROM titular t
 WHERE i.id = t.inmueble_id
   AND i.estado::TEXT = 'en_estudio';

-- 2b. El resto: 'en_estudio' -> 'disponible', CONSERVANDO visible_vitrina.
UPDATE inmuebles
   SET estado = 'disponible',
       updated_at = NOW()
 WHERE estado::TEXT = 'en_estudio';

-- 2c. Backfill del titular en los inmuebles que YA estaban 'ocupado' antes de
--     esta migracion por un contrato en curso. Sin esto, un 'ocupado' heredado
--     no tiene titular anotado y la liberacion holder-aware no sabria a quien
--     pertenece. No toca los 'ocupado' sin contrato en curso (activaciones
--     manuales, contratos en papel): esos siguen bloqueando por estado, como
--     siempre.
WITH titular AS (
  SELECT DISTINCT ON (e.inmueble_id)
         e.inmueble_id,
         e.id AS expediente_id
    FROM expedientes e
    JOIN contratos c ON c.expediente_id = e.id
   WHERE c.estado::TEXT NOT IN ('finalizado', 'cancelado')
   ORDER BY e.inmueble_id,
            CASE c.estado::TEXT
              WHEN 'vigente' THEN 0
              WHEN 'firmado' THEN 1
              WHEN 'pendiente_firma' THEN 2
              WHEN 'aprobado' THEN 3
              WHEN 'en_revision' THEN 4
              ELSE 5
            END,
            c.created_at DESC
)
UPDATE inmuebles i
   SET reservado_por_expediente_id = t.expediente_id,
       updated_at = NOW()
  FROM titular t
 WHERE i.id = t.inmueble_id
   AND i.estado::TEXT = 'ocupado'
   AND i.reservado_por_expediente_id IS NULL;


-- ============================================================
-- 3. fn_crear_estudio — sin bloqueo por estudio en curso
--
-- Cambios respecto de 20260316000001:
--   - FUERA el `IF v_inmueble_estado = 'en_estudio' THEN RAISE` (el aborto del
--     segundo estudio: justo lo que §4.2 manda quitar).
--   - FUERA el `UPDATE inmuebles SET estado='en_estudio'` final. Ademas de ser
--     lo que este cambio elimina, era INCONDICIONAL: sin guard de estado
--     origen podia pisar un 'ocupado' o un 'inactivo' legitimos.
--   - ENTRA el guard de RESERVA: una propiedad ya reservada (o arrendada) deja
--     de admitir estudios nuevos. Es el bloqueo que sustituye al anterior, al
--     final del flujo en vez de al principio.
--   - El SELECT ... FOR UPDATE se conserva, ahora si con un proposito real:
--     serializa la lectura del titular contra una reserva concurrente.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_crear_estudio(
  p_expediente_id UUID,
  p_inmueble_id UUID,
  p_tipo TEXT,
  p_proveedor TEXT,
  p_duracion_contrato_meses INT,
  p_pago_por TEXT,
  p_observaciones TEXT DEFAULT NULL,
  p_solicitado_por UUID DEFAULT NULL,
  p_autorizacion_habeas_data_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_estudio_id UUID;
  v_inmueble_estado TEXT;
  v_reservado_por UUID;
BEGIN
  SELECT estado::TEXT, reservado_por_expediente_id
    INTO v_inmueble_estado, v_reservado_por
    FROM inmuebles
   WHERE id = p_inmueble_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inmueble no encontrado: %', p_inmueble_id;
  END IF;

  -- §4.2: varios estudios en curso a la vez SI se admiten. Lo unico que cierra
  -- la puerta es que la propiedad ya este comprometida.
  IF v_inmueble_estado = 'inactivo' THEN
    RAISE EXCEPTION 'INMUEBLE_RESERVADO: el inmueble esta inactivo';
  END IF;

  IF v_inmueble_estado = 'ocupado'
     AND (v_reservado_por IS NULL OR v_reservado_por <> p_expediente_id) THEN
    RAISE EXCEPTION 'INMUEBLE_RESERVADO: la propiedad ya esta reservada o arrendada';
  END IF;

  INSERT INTO estudios (
    expediente_id, tipo, proveedor, estado, resultado,
    duracion_contrato_meses, pago_por, observaciones,
    solicitado_por, autorizacion_habeas_data_id
  ) VALUES (
    p_expediente_id,
    p_tipo::tipo_estudio,
    p_proveedor::proveedor_estudio,
    'solicitado',
    'pendiente',
    p_duracion_contrato_meses,
    p_pago_por,
    p_observaciones,
    p_solicitado_por,
    p_autorizacion_habeas_data_id
  )
  RETURNING id INTO v_estudio_id;

  -- El inmueble NO se toca: su estado sigue el ciclo del contrato.
  RETURN v_estudio_id;
END;
$$;

COMMENT ON FUNCTION fn_crear_estudio(UUID, UUID, TEXT, TEXT, INT, TEXT, TEXT, UUID, UUID) IS
  'Crea un estudio. Ya NO bloquea el inmueble ni aborta si hay otros estudios en curso (Flujo 4.2): varios candidatos se evaluan en paralelo. Solo rechaza si la propiedad esta reservada por otro expediente, arrendada o inactiva.';


-- ============================================================
-- 4. fn_crear_estudio_desde_inmueble — mismo cambio
-- ============================================================
CREATE OR REPLACE FUNCTION fn_crear_estudio_desde_inmueble(
  p_inmueble_id UUID,
  p_solicitante_id UUID,
  p_tipo TEXT,
  p_proveedor TEXT,
  p_duracion_contrato_meses INT,
  p_pago_por TEXT,
  p_observaciones TEXT DEFAULT NULL,
  p_solicitado_por UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_inmueble_estado TEXT;
  v_reservado_por UUID;
  v_expediente_id UUID;
  v_estudio_id UUID;
BEGIN
  SELECT estado::TEXT, reservado_por_expediente_id
    INTO v_inmueble_estado, v_reservado_por
    FROM inmuebles
   WHERE id = p_inmueble_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inmueble no encontrado: %', p_inmueble_id;
  END IF;

  IF v_inmueble_estado = 'inactivo' THEN
    RAISE EXCEPTION 'INMUEBLE_RESERVADO: el inmueble esta inactivo';
  END IF;

  -- Aqui el expediente aun no existe, asi que cualquier reserva es ajena.
  IF v_inmueble_estado = 'ocupado' THEN
    RAISE EXCEPTION 'INMUEBLE_RESERVADO: la propiedad ya esta reservada o arrendada';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM solicitantes WHERE id = p_solicitante_id) THEN
    RAISE EXCEPTION 'Solicitante no encontrado: %', p_solicitante_id;
  END IF;

  INSERT INTO expedientes (inmueble_id, solicitante_id, creado_por)
  VALUES (p_inmueble_id, p_solicitante_id, p_solicitado_por)
  RETURNING id INTO v_expediente_id;

  INSERT INTO estudios (
    expediente_id, tipo, proveedor, estado, resultado,
    duracion_contrato_meses, pago_por, observaciones,
    solicitado_por
  ) VALUES (
    v_expediente_id,
    p_tipo::tipo_estudio,
    p_proveedor::proveedor_estudio,
    'solicitado',
    'pendiente',
    p_duracion_contrato_meses,
    p_pago_por,
    p_observaciones,
    p_solicitado_por
  )
  RETURNING id INTO v_estudio_id;

  -- El inmueble NO se toca.
  RETURN json_build_object(
    'expediente_id', v_expediente_id,
    'estudio_id', v_estudio_id
  );
END;
$$;

COMMENT ON FUNCTION fn_crear_estudio_desde_inmueble(UUID, UUID, TEXT, TEXT, INT, TEXT, TEXT, UUID) IS
  'Crea expediente + estudio desde un inmueble. Ya NO bloquea el inmueble ni aborta por estudios en curso (Flujo 4.2). Solo rechaza si la propiedad esta reservada, arrendada o inactiva.';


-- ============================================================
-- 5. fn_habilitar_estudio_expediente — le FALTABA el guard del inmueble
--
-- Este es el camino REAL del piloto (propietario / inmobiliaria pulsan
-- "Habilitar estudio"). Nunca miro `inmuebles.estado`: hacia FOR UPDATE del
-- EXPEDIENTE, y el bloqueo del inmueble lo aplicaba despues la capa de
-- aplicacion, fuera de la transaccion y fire-and-forget. Por eso los estudios
-- paralelos ya ocurrian de facto y el bloqueo era una ilusion.
--
-- Ahora que la proteccion vive al final, este camino tiene que respetarla: se
-- le agrega el MISMO guard de reserva. Todo lo demas queda idéntico a
-- 20260817000001 (eleccion de buro, gate de cita, timeline).
-- ============================================================
CREATE OR REPLACE FUNCTION fn_habilitar_estudio_expediente(
  p_expediente_id UUID,
  p_user_id UUID,
  p_proveedor TEXT DEFAULT 'transunion'
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
  v_numero TEXT;
  v_estado TEXT;
  v_source TEXT;
  v_estudio_habilitado BOOLEAN;
  v_cita_omitida BOOLEAN;
  v_inmueble_id UUID;
  v_estudio_id UUID;
  v_cita_realizada_count INT;
  v_inmueble_estado TEXT;
  v_reservado_por UUID;
BEGIN
  -- 0. Validar el buro antes de tocar nada.
  IF p_proveedor NOT IN ('transunion', 'datacredito') THEN
    RAISE EXCEPTION 'Proveedor no ejecutable para habilitar estudio: % (use transunion o datacredito)', p_proveedor;
  END IF;

  -- 1. Lock + fetch del expediente para prevenir condicion de carrera.
  SELECT id, numero, estado::TEXT, source::TEXT, estudio_habilitado, cita_omitida, inmueble_id
    INTO v_id, v_numero, v_estado, v_source, v_estudio_habilitado, v_cita_omitida, v_inmueble_id
    FROM expedientes
   WHERE id = p_expediente_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expediente no encontrado: %', p_expediente_id;
  END IF;

  -- 2. Idempotencia: si ya estaba habilitado, conflicto.
  IF v_estudio_habilitado = TRUE THEN
    RAISE EXCEPTION 'Estudio ya habilitado para este expediente';
  END IF;

  -- 3. Rango de estados permitido.
  IF v_estado NOT IN ('borrador', 'en_revision', 'informacion_incompleta') THEN
    RAISE EXCEPTION 'Estado no permitido para habilitar estudio: %', v_estado;
  END IF;

  -- 3b. Guard de RESERVA (nuevo). Varios candidatos en paralelo SI, pero no
  --     sobre una propiedad ya comprometida con un contrato en curso.
  IF v_inmueble_id IS NOT NULL THEN
    SELECT estado::TEXT, reservado_por_expediente_id
      INTO v_inmueble_estado, v_reservado_por
      FROM inmuebles
     WHERE id = v_inmueble_id
     FOR UPDATE;

    IF v_inmueble_estado = 'inactivo' THEN
      RAISE EXCEPTION 'INMUEBLE_RESERVADO: el inmueble esta inactivo';
    END IF;

    IF v_inmueble_estado = 'ocupado'
       AND (v_reservado_por IS NULL OR v_reservado_por <> p_expediente_id) THEN
      RAISE EXCEPTION 'INMUEBLE_RESERVADO: la propiedad ya esta reservada o arrendada';
    END IF;
  END IF;

  -- 4. Gate de cita realizada. Se salta cuando source='invitacion' O cuando el
  --    gestor marco cita_omitida=true (visita coordinada por fuera).
  IF v_source IS DISTINCT FROM 'invitacion' AND v_cita_omitida IS NOT TRUE THEN
    SELECT COUNT(*) INTO v_cita_realizada_count
      FROM citas
     WHERE expediente_id = p_expediente_id
       AND estado = 'realizada';

    IF v_cita_realizada_count = 0 THEN
      RAISE EXCEPTION 'Se requiere al menos una cita realizada antes de habilitar el estudio';
    END IF;
  END IF;

  -- 5. UPDATE expediente.
  UPDATE expedientes
     SET estudio_habilitado = TRUE,
         updated_at = NOW()
   WHERE id = p_expediente_id;

  -- 6. INSERT placeholder en estudios, con el buro elegido.
  INSERT INTO estudios (
    expediente_id, tipo, proveedor, solicitado_por
  ) VALUES (
    p_expediente_id,
    'individual'::tipo_estudio,
    p_proveedor::proveedor_estudio,
    p_user_id
  )
  RETURNING id INTO v_estudio_id;

  -- 7. Timeline event atomico.
  INSERT INTO eventos_timeline (
    expediente_id, tipo, descripcion, usuario_id, metadata
  ) VALUES (
    p_expediente_id,
    'estudio',
    'Estudio crediticio habilitado',
    p_user_id,
    json_build_object(
      'estudio_id', v_estudio_id,
      'via', 'panel',
      'cita_omitida', v_cita_omitida,
      'proveedor', p_proveedor
    )
  );

  -- El inmueble NO se bloquea (Flujo 4.2). Antes lo hacia la capa de
  -- aplicacion despues de esta funcion, fire-and-forget; esa llamada tambien
  -- se retiro.
  RETURN json_build_object(
    'expediente_id', v_id,
    'numero', v_numero,
    'estudio_id', v_estudio_id,
    'proveedor', p_proveedor
  );
END;
$$;

COMMENT ON FUNCTION fn_habilitar_estudio_expediente(UUID, UUID, TEXT) IS
  'Habilita el estudio de un expediente y crea el placeholder con el buro elegido. Ya NO bloquea el inmueble (Flujo 4.2, estudios simultaneos), pero SI rechaza si la propiedad esta reservada por otro expediente, arrendada o inactiva.';


-- ============================================================
-- 6. fn_cancelar_estudio — deja de liberar el inmueble
--
-- Antes ponia el inmueble en 'disponible' sin mirar si quedaban otros estudios
-- o expedientes vivos. Con estudios simultaneos eso seria un error de bulto:
-- cancelar el estudio de UN candidato liberaria una propiedad que otros siguen
-- disputando — o peor, una ya reservada.
--
-- Como el estado del inmueble ya no sigue el ciclo del estudio, aqui
-- simplemente no hay nada que liberar. La reserva solo la suelta el ciclo del
-- contrato (fn_liberar_reserva_expediente / liberarInmuebleTrasContrato).
-- ============================================================
CREATE OR REPLACE FUNCTION fn_cancelar_estudio(
  p_estudio_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_estado TEXT;
BEGIN
  SELECT estado::TEXT INTO v_estado
    FROM estudios
   WHERE id = p_estudio_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estudio no encontrado: %', p_estudio_id;
  END IF;

  IF v_estado IN ('completado', 'cancelado', 'fallido') THEN
    RAISE EXCEPTION 'No se puede cancelar un estudio en estado: %', v_estado;
  END IF;

  UPDATE estudios
     SET estado = 'cancelado', updated_at = NOW()
   WHERE id = p_estudio_id;

  RETURN p_estudio_id;
END;
$$;

COMMENT ON FUNCTION fn_cancelar_estudio(UUID) IS
  'Cancela un estudio no terminal. Ya NO toca el inmueble (Flujo 4.2): con estudios simultaneos, cancelar el estudio de un candidato no puede liberar una propiedad que otros siguen disputando o que ya esta reservada.';


-- ============================================================
-- 7. fn_registrar_resultado_estudio — liberacion HOLDER-AWARE
--
-- El paso 5 liberaba con el guard `estado='en_estudio'` mas, desde
-- 20260817000002, `expediente <> 'aprobado'`. Con estudios simultaneos ese
-- criterio ya no alcanza: el rechazo del candidato B no debe tocar nada si la
-- reserva es de A.
--
-- Criterio nuevo: se ACUMULAN tres condiciones, y hacen falta las tres.
--
--   1. ESTE expediente es el titular de la reserva. Protege de que el rechazo
--      del candidato B suelte la reserva que tomo A.
--   2. El expediente no esta en 'aprobado' ni 'cerrado', y no tiene ningun
--      contrato no terminal. Es el guard de 20260817000002, que el titular NO
--      subsume — al contrario, es justo donde el titular hace DISPARAR la
--      liberacion: el estudio del co-arrendatario se inserta con el MISMO
--      expediente_id que el titular (coarrendatarios.service.ts), asi que un
--      'rechazado' tardio de ese co-arrendatario entra por aqui con el
--      expediente ya aprobado y su contrato en firma. Sin esta condicion
--      devolveria a 'disponible' una propiedad comprometida.
--   3. El inmueble no esta 'inactivo'. Nunca se revive un soft-delete: mismo
--      criterio que fn_liberar_reserva_expediente y liberarInmuebleTrasContrato
--      (el codigo viejo lo conseguia de rebote con `AND estado = 'en_estudio'`).
-- ============================================================
CREATE OR REPLACE FUNCTION fn_registrar_resultado_estudio(
  p_estudio_id UUID,
  p_resultado TEXT,
  p_observaciones TEXT,
  p_score INT DEFAULT NULL,
  p_motivo_rechazo TEXT DEFAULT NULL,
  p_condiciones TEXT DEFAULT NULL,
  p_certificado_url TEXT DEFAULT NULL,
  p_usuario_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_estado TEXT;
  v_resultado_actual TEXT;
  v_expediente_id UUID;
  v_inmueble_id UUID;
  v_expediente_estado TEXT;
  v_descripcion TEXT;
BEGIN
  -- 1. Lock estudio row to prevent race conditions
  SELECT estado, resultado, expediente_id
    INTO v_estado, v_resultado_actual, v_expediente_id
    FROM estudios
   WHERE id = p_estudio_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estudio no encontrado: %', p_estudio_id;
  END IF;

  -- 2. Validate estado
  IF v_estado NOT IN ('solicitado', 'en_proceso') THEN
    RAISE EXCEPTION 'Solo se puede registrar resultado en estudios en estado solicitado o en_proceso. Estado actual: %', v_estado;
  END IF;

  -- 3. Validate resultado still pendiente
  IF v_resultado_actual <> 'pendiente' THEN
    RAISE EXCEPTION 'Este estudio ya tiene un resultado registrado: %', v_resultado_actual;
  END IF;

  -- 4. Update estudio atomically
  UPDATE estudios
     SET resultado = p_resultado::resultado_estudio,
         observaciones = p_observaciones,
         estado = 'completado',
         fecha_completado = NOW(),
         score = COALESCE(p_score, score),
         motivo_rechazo = COALESCE(p_motivo_rechazo, motivo_rechazo),
         condiciones = COALESCE(p_condiciones, condiciones),
         certificado_url = COALESCE(p_certificado_url, certificado_url)
   WHERE id = p_estudio_id;

  -- 5. Soltar la reserva SOLO si el candidato rechazado es el titular Y el
  --    expediente no esta ya comprometido. Si la reserva es de otro expediente
  --    (o no hay reserva), no se toca nada: los demas candidatos siguen su
  --    curso y el inmueble su propio ciclo. Y si el titular ya avanzo al
  --    contrato, tampoco: el rechazo tardio de un estudio suyo (tipicamente el
  --    del co-arrendatario, que comparte expediente_id) no puede devolver al
  --    mercado una propiedad con contrato vivo — guard de 20260817000002.
  IF p_resultado = 'rechazado' THEN
    SELECT e.inmueble_id, e.estado::TEXT
      INTO v_inmueble_id, v_expediente_estado
      FROM expedientes e
     WHERE e.id = v_expediente_id;

    IF v_inmueble_id IS NOT NULL
       AND v_expediente_estado NOT IN ('aprobado', 'cerrado')
       AND NOT EXISTS (
         SELECT 1
           FROM contratos c
          WHERE c.expediente_id = v_expediente_id
            AND c.estado::TEXT NOT IN ('finalizado', 'cancelado')
       )
    THEN
      UPDATE inmuebles
         SET estado = 'disponible',
             reservado_por_expediente_id = NULL,
             updated_at = NOW()
       WHERE id = v_inmueble_id
         AND reservado_por_expediente_id = v_expediente_id
         AND estado::TEXT <> 'inactivo';
    END IF;
  END IF;

  -- 6. Build description
  v_descripcion := 'Resultado de estudio registrado: ' || p_resultado;

  -- 7. Insert timeline event
  INSERT INTO eventos_timeline (
    expediente_id, tipo, descripcion, usuario_id, metadata
  ) VALUES (
    v_expediente_id,
    'estudio',
    v_descripcion,
    p_usuario_id,
    jsonb_build_object(
      'estudio_id', p_estudio_id,
      'resultado', p_resultado,
      'score', p_score
    )
  );

  RETURN p_estudio_id;
END;
$$;

COMMENT ON FUNCTION fn_registrar_resultado_estudio(UUID, TEXT, TEXT, INT, TEXT, TEXT, TEXT, UUID) IS
  'Registra el resultado de un estudio de forma atomica. Solo suelta la reserva del inmueble si el resultado es rechazado Y este expediente es el titular Y el expediente no esta aprobado/cerrado ni tiene contrato no terminal (guard de 20260817000002, que el titular NO subsume) Y el inmueble no esta inactivo.';


-- ============================================================
-- 8. fn_reservar_inmueble_para_contrato — EL CAS
--
-- Punto unico donde la propiedad se compromete. Lo llama generarContrato, que
-- es por donde pasan los dos caminos aprobado -> contrato (aprobarCondicionado
-- y generarContratoExpediente).
--
-- Atomicidad: SELECT ... FOR UPDATE sobre la fila del inmueble ANTES de
-- decidir. De dos aprobaciones concurrentes, la segunda se bloquea ahi; cuando
-- despierta, Postgres le entrega la version nueva de la fila (con el titular ya
-- escrito por la primera) y cae en el RAISE. No existe entrelazado que permita
-- dos reservas.
--
-- Idempotente para el propio titular: regenerar el contrato del mismo
-- expediente devuelve ya_reservado, no un 409.
--
-- Devuelve ademas los OTROS candidatos vivos sobre la propiedad, para que la
-- capa TS notifique a esos solicitantes (§4.2 "los demas estudios en curso se
-- notifican al solicitante"). Se calculan aqui, dentro de la transaccion que
-- gano el CAS, para que notifique EXACTAMENTE uno.
--
-- "Candidato vivo" NO es solo "estudio sin terminar". Incluye tambien al
-- expediente cuyo estudio YA cerro pero sigue 'aprobado' o 'condicionado': ese
-- es precisamente el mas afectado —el que iba a generar su propio contrato y
-- se va a estrellar contra el 409— y con el criterio estrecho era el unico que
-- se quedaba sin aviso.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_reservar_inmueble_para_contrato(
  p_expediente_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_inmueble_id UUID;
  v_inmueble_estado TEXT;
  v_reservado_por UUID;
  v_codigo TEXT;
  v_direccion TEXT;
  v_ya_reservado BOOLEAN := FALSE;
  v_afectados JSON;
BEGIN
  SELECT inmueble_id INTO v_inmueble_id
    FROM expedientes
   WHERE id = p_expediente_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expediente no encontrado: %', p_expediente_id;
  END IF;

  -- Un expediente sin inmueble no reserva nada, pero tampoco es un error: el
  -- contrato puede generarse igual.
  IF v_inmueble_id IS NULL THEN
    RETURN json_build_object('reservado', FALSE, 'sin_inmueble', TRUE, 'afectados', '[]'::JSON);
  END IF;

  -- ── EL LOCK ──
  SELECT estado::TEXT, reservado_por_expediente_id, codigo, direccion
    INTO v_inmueble_estado, v_reservado_por, v_codigo, v_direccion
    FROM inmuebles
   WHERE id = v_inmueble_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inmueble no encontrado: %', v_inmueble_id;
  END IF;

  IF v_inmueble_estado = 'inactivo' THEN
    RAISE EXCEPTION 'INMUEBLE_YA_RESERVADO: el inmueble esta inactivo';
  END IF;

  IF v_reservado_por IS NOT NULL AND v_reservado_por = p_expediente_id THEN
    -- Idempotencia: ya era nuestro.
    v_ya_reservado := TRUE;
  ELSIF v_reservado_por IS NOT NULL THEN
    RAISE EXCEPTION 'INMUEBLE_YA_RESERVADO: reservado por el expediente %', v_reservado_por;
  ELSIF v_inmueble_estado = 'ocupado' THEN
    -- Arrendado sin titular anotado (activacion manual, contrato en papel,
    -- fila anterior a esta migracion). Mismo bloqueo de siempre.
    RAISE EXCEPTION 'INMUEBLE_YA_RESERVADO: la propiedad ya esta arrendada';
  ELSE
    -- Ganamos. 'ocupado' + fuera de vitrina = la regla canonica de siempre.
    UPDATE inmuebles
       SET estado = 'ocupado',
           visible_vitrina = FALSE,
           reservado_por_expediente_id = p_expediente_id,
           updated_at = NOW()
     WHERE id = v_inmueble_id;
  END IF;

  -- Los DEMAS candidatos con estudio en curso sobre esta propiedad. Solo se
  -- calculan cuando de verdad acabamos de reservar: en el camino idempotente
  -- ya se notifico en la llamada anterior.
  IF v_ya_reservado THEN
    v_afectados := '[]'::JSON;
  ELSE
    SELECT COALESCE(json_agg(x), '[]'::JSON) INTO v_afectados
      FROM (
        SELECT DISTINCT
               e.id          AS expediente_id,
               e.numero      AS expediente_numero,
               e.solicitante_id,
               s.nombre      AS solicitante_nombre,
               s.apellido    AS solicitante_apellido,
               s.email       AS solicitante_email
          FROM expedientes e
          JOIN estudios es ON es.expediente_id = e.id
          LEFT JOIN solicitantes s ON s.id = e.solicitante_id
         WHERE e.inmueble_id = v_inmueble_id
           AND e.id <> p_expediente_id
           AND e.estado::TEXT NOT IN ('cerrado', 'rechazado')
           AND (
                 -- estudio todavia en curso
                 es.estado::TEXT NOT IN ('completado', 'fallido', 'cancelado')
                 -- o estudio ya cerrado pero el candidato sigue vivo
                 OR e.estado::TEXT IN ('aprobado', 'condicionado')
               )
      ) x;
  END IF;

  RETURN json_build_object(
    'reservado', NOT v_ya_reservado,
    'ya_reservado', v_ya_reservado,
    'inmueble_id', v_inmueble_id,
    'inmueble_codigo', v_codigo,
    'inmueble_direccion', v_direccion,
    'afectados', v_afectados
  );
END;
$$;

COMMENT ON FUNCTION fn_reservar_inmueble_para_contrato(UUID) IS
  'Reserva atomicamente el inmueble de un expediente aprobado que avanza al contrato (Flujo 4.2). SELECT ... FOR UPDATE + titular escalar: dos aprobaciones concurrentes producen UNA sola reserva; la perdedora recibe INMUEBLE_YA_RESERVADO. Devuelve los demas candidatos vivos (estudio en curso, o estudio cerrado con el expediente aun aprobado/condicionado) para notificarlos.';


-- ============================================================
-- 9. fn_liberar_reserva_expediente — la contrapartida
--
-- Suelta la reserva SOLO si el expediente indicado es el titular. Se llama al
-- rechazar/cerrar el expediente y al terminar/cancelar su contrato.
--
-- `p_volver_disponible` decide si ademas devuelve el estado a 'disponible':
--   TRUE  (rechazo/cierre del expediente, cancelacion pre-firma) — la propiedad
--         nunca llego a arrendarse, vuelve al mercado.
--   FALSE (solo limpiar el titular) para los caminos que ya gestionan el estado
--         por su cuenta con sus propios guards (liberarInmuebleTrasContrato,
--         que ademas apaga visible_vitrina y respeta el guard de renovacion).
--
-- visible_vitrina NO se enciende nunca aqui: el dueño decide cuando volver a
-- publicar. Mismo criterio que toda la auditoria de vitrina.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_liberar_reserva_expediente(
  p_expediente_id UUID,
  p_volver_disponible BOOLEAN DEFAULT TRUE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_filas INT;
BEGIN
  UPDATE inmuebles
     SET reservado_por_expediente_id = NULL,
         estado = CASE
                    WHEN p_volver_disponible AND estado::TEXT <> 'inactivo' THEN 'disponible'
                    ELSE estado
                  END,
         updated_at = NOW()
   WHERE reservado_por_expediente_id = p_expediente_id;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  RETURN v_filas > 0;
END;
$$;

COMMENT ON FUNCTION fn_liberar_reserva_expediente(UUID, BOOLEAN) IS
  'Suelta la reserva del inmueble solo si el expediente dado es su titular. Devuelve true si libero algo. No enciende visible_vitrina: republicar es decision del dueño.';


-- ============================================================
-- 10. fn_inmuebles_estado_estudios — el indicador, sin N+1
--
-- §4.2: "Si la propiedad ya tiene estudios en curso, se muestra un indicador
-- con el numero de estudios activos, sin impedir la seleccion."
--
-- Una sola llamada por PAGINA de resultados (<= limit ids), no una por fila.
-- PostgREST no puede agregar a dos saltos (inmuebles -> expedientes ->
-- estudios) en una proyeccion usable, asi que se sigue el patron que el repo ya
-- usa en getVitrinaAdmin: una query extra + Map en la capa TS.
--
-- "En curso" = los 8 estados no finales del enum estado_estudio. Es la misma
-- definicion que ESTADOS_ESTUDIO_FINALES en TS; las dos listas tienen que
-- moverse juntas.
--
-- Devuelve tambien `reservado`, que la UI necesita para distinguir "Reservado"
-- (contrato en proceso, aun sin firmar) de "Arrendado" (contrato vigente) — dos
-- cosas que en `estado` son ambas 'ocupado'.
--
-- Indices que la sirven: idx_expedientes_inmueble, idx_estudios_expediente,
-- idx_estudios_estado.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_inmuebles_estado_estudios(
  p_inmueble_ids UUID[]
)
RETURNS TABLE (
  inmueble_id UUID,
  estudios_activos INT,
  expedientes_activos INT,
  reservado BOOLEAN,
  arrendado BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    i.id AS inmueble_id,
    COALESCE(ag.estudios_activos, 0)::INT     AS estudios_activos,
    COALESCE(ag.expedientes_activos, 0)::INT  AS expedientes_activos,
    (i.reservado_por_expediente_id IS NOT NULL
       AND NOT COALESCE(vig.vigente, FALSE))  AS reservado,
    COALESCE(vig.vigente, FALSE)              AS arrendado
  FROM inmuebles i
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::INT                        AS estudios_activos,
           COUNT(DISTINCT e.id)::INT            AS expedientes_activos
      FROM expedientes e
      JOIN estudios es ON es.expediente_id = e.id
     WHERE e.inmueble_id = i.id
       AND es.estado::TEXT NOT IN ('completado', 'fallido', 'cancelado')
       AND e.estado::TEXT NOT IN ('cerrado', 'rechazado')
  ) ag ON TRUE
  LEFT JOIN LATERAL (
    SELECT TRUE AS vigente
      FROM expedientes e
      JOIN contratos c ON c.expediente_id = e.id
     WHERE e.inmueble_id = i.id
       AND c.estado::TEXT = 'vigente'
     LIMIT 1
  ) vig ON TRUE
  WHERE i.id = ANY(p_inmueble_ids);
$$;

COMMENT ON FUNCTION fn_inmuebles_estado_estudios(UUID[]) IS
  'Indicador del Flujo 4.2: cuantos estudios en curso tiene cada inmueble, y si esta reservado (contrato en proceso) o arrendado (contrato vigente). Una llamada por pagina de resultados — evita el N+1.';

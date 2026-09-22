-- ============================================================
-- Contratos V3 — Entrega 6: posfirma (§11.6, §12.1-12.2).
-- ------------------------------------------------------------
-- (a) transicionar_contrato: la matriz V3 admite vigente -> finalizado
--     (TERMINADO). Copia exacta de 20260925000002 con esa sola linea.
-- (b) expedientes: no se cierra el estudio de un contrato V3 con fianza activa
--     o terminada sin acta de entrega e inventario (§12.2), ni con el contrato
--     EN FIRMA (su proceso sigue vivo en Auco: al firmar quedaria una fianza
--     activa sobre un estudio cerrado; primero se cancela). Trigger: cubre la
--     RPC de 4 y de 5 argumentos, los UPDATE directos y el editor SQL. Solo V3:
--     los autocierres del flujo anterior no revisan el error del UPDATE.
-- (c) list_expedientes_with_relations: condicion (h) "acta pendiente" en las
--     CUATRO copias del bloque "requiere accion" (§12.1). Copia exacta de
--     20260925000003 con esa condicion agregada. Misma firma -> CREATE OR
--     REPLACE (conserva los permisos: anon/authenticated siguen sin EXECUTE).
--
-- Correr DESPUES de las tres de la Entrega 5 (20260925000001..3).
-- ROLLBACK: reaplicar (a) de 20260925000002 y (c) de 20260925000003, y
--   DROP TRIGGER expedientes_cierre_requiere_acta ON public.expedientes;
--   DROP FUNCTION public.fn_expediente_cierre_requiere_acta();
-- ============================================================

DO $$ BEGIN
  IF to_regclass('public.contrato_v3_sobres') IS NULL THEN
    RAISE EXCEPTION 'Corre primero las migraciones de la Entrega 5 (20260925000001, 000002 y 000003)';
  END IF;
END $$;

-- ── (a) transicionar_contrato ──

CREATE OR REPLACE FUNCTION public.transicionar_contrato(
  p_contrato_id uuid,
  p_nuevo_estado estado_contrato,
  p_descripcion text,
  p_usuario_id uuid,
  p_comentario text DEFAULT NULL::text,
  p_motivo text DEFAULT NULL::text
)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_estado_anterior estado_contrato;
  v_destinacion TEXT;
  v_contrato RECORD;
  v_historial_id UUID;
  v_transicion_valida BOOLEAN;
BEGIN
  -- Bloquear la fila para prevenir transiciones concurrentes
  SELECT estado, destinacion INTO v_estado_anterior, v_destinacion
  FROM contratos
  WHERE id = p_contrato_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contrato no encontrado: %', p_contrato_id;
  END IF;

  IF v_destinacion IS NOT NULL THEN
    -- Contratos V3 (§11): EN FIRMA = pendiente_firma, FIANZA ACTIVA = vigente.
    -- Nunca pasan por 'firmado'. borrador -> pendiente_firma lo hace el
    -- asistente con un UPDATE con control de concurrencia, no esta funcion.
    -- TERMINADO (§11.6) solo desde FIANZA ACTIVA; una fianza activa no se
    -- cancela (§11.5): se termina.
    v_transicion_valida := CASE v_estado_anterior
      WHEN 'borrador'          THEN p_nuevo_estado IN ('cancelado')
      WHEN 'pendiente_firma'   THEN p_nuevo_estado IN ('vigente', 'firma_incompleta', 'cancelado')
      WHEN 'firma_incompleta'  THEN p_nuevo_estado IN ('pendiente_firma', 'cancelado')
      WHEN 'vigente'           THEN p_nuevo_estado IN ('finalizado')
      ELSE FALSE
    END;
  ELSE
    -- Validar transicion de estado permitida (flujo anterior, sin cambios)
    v_transicion_valida := CASE v_estado_anterior
      WHEN 'borrador'          THEN p_nuevo_estado IN ('en_revision', 'cancelado')
      WHEN 'en_revision'       THEN p_nuevo_estado IN ('aprobado', 'borrador', 'cancelado')
      WHEN 'aprobado'          THEN p_nuevo_estado IN ('pendiente_firma', 'borrador', 'cancelado')
      WHEN 'pendiente_firma'   THEN p_nuevo_estado IN ('firmado', 'cancelado')
      WHEN 'firmado'           THEN p_nuevo_estado IN ('vigente')
      WHEN 'vigente'           THEN p_nuevo_estado IN ('finalizado', 'cancelado')
      WHEN 'finalizado'        THEN FALSE
      WHEN 'cancelado'         THEN FALSE
      ELSE FALSE
    END;
  END IF;

  IF NOT v_transicion_valida THEN
    RAISE EXCEPTION 'Transicion no permitida: % -> %', v_estado_anterior, p_nuevo_estado;
  END IF;

  -- Actualizar estado del contrato
  UPDATE contratos
  SET estado = p_nuevo_estado,
      updated_at = NOW()
  WHERE id = p_contrato_id
  RETURNING * INTO v_contrato;

  -- Insertar en historial de estados
  INSERT INTO contrato_historial_estados (
    contrato_id, estado_anterior, estado_nuevo,
    comentario, motivo, descripcion, usuario_id
  )
  VALUES (
    p_contrato_id, v_estado_anterior, p_nuevo_estado,
    p_comentario, p_motivo, p_descripcion, p_usuario_id
  )
  RETURNING id INTO v_historial_id;

  RETURN json_build_object(
    'contrato_id', p_contrato_id,
    'estado_anterior', v_estado_anterior,
    'estado_nuevo', p_nuevo_estado,
    'historial_id', v_historial_id,
    'updated_at', v_contrato.updated_at
  );
END;
$function$;

-- ── (b) sin acta de entrega no se cierra el estudio (§12.2) ──
-- SECURITY DEFINER: contrato_archivos tiene RLS sin politicas; como invoker un
-- rol sin privilegios no veria el acta y el cierre fallaria siempre.

CREATE OR REPLACE FUNCTION public.fn_expediente_cierre_requiere_acta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM contratos c
    WHERE c.expediente_id = NEW.id AND c.destinacion IS NOT NULL AND c.estado = 'pendiente_firma'
  ) THEN
    RAISE EXCEPTION 'CONTRATO_EN_FIRMA: el contrato del estudio esta en firma; cancelalo antes de cerrar el estudio';
  END IF;
  IF EXISTS (
    SELECT 1 FROM contratos c
    WHERE c.expediente_id = NEW.id
      AND c.destinacion IS NOT NULL
      AND c.estado IN ('vigente', 'finalizado')
      AND NOT EXISTS (
        SELECT 1 FROM contrato_archivos a WHERE a.contrato_id = c.id AND a.tipo_archivo = 'acta_entrega'
      )
  ) THEN
    RAISE EXCEPTION 'ACTA_ENTREGA_REQUERIDA: el contrato del estudio tiene la fianza activa o terminada y no tiene acta de entrega e inventario';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS expedientes_cierre_requiere_acta ON public.expedientes;
CREATE TRIGGER expedientes_cierre_requiere_acta
  BEFORE UPDATE OF estado ON public.expedientes
  FOR EACH ROW
  WHEN (NEW.estado = 'cerrado' AND OLD.estado IS DISTINCT FROM 'cerrado')
  EXECUTE FUNCTION public.fn_expediente_cierre_requiere_acta();

-- ── (c) "Requieren mi accion" con el acta pendiente (§12.1) ──

CREATE OR REPLACE FUNCTION public.list_expedientes_with_relations(
  p_search text DEFAULT NULL::text,
  p_estados text[] DEFAULT NULL::text[],
  p_analista_id uuid DEFAULT NULL::uuid,
  p_inmueble_id uuid DEFAULT NULL::uuid,
  p_fecha_desde timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_fecha_hasta timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_sort_field text DEFAULT 'created_at'::text,
  p_sort_direction text DEFAULT 'desc'::text,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_estudio_filtro text DEFAULT NULL::text,
  p_allowed_expediente_ids uuid[] DEFAULT NULL::uuid[],
  p_miembro_responsable_id uuid DEFAULT NULL::uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  result JSON;
  total_count BIGINT;
  -- Mismo plazo que la API (lib/calibracion.ts, DIAS_EXPIRACION_ESTUDIO).
  v_dias_expiracion NUMERIC := COALESCE(
    (SELECT valor FROM parametros_calibracion WHERE clave = 'DIAS_EXPIRACION_ESTUDIO'), 15);
BEGIN
  SELECT COUNT(*)
  INTO total_count
  FROM expedientes e
  LEFT JOIN inmuebles i ON i.id = e.inmueble_id
  LEFT JOIN solicitantes s ON s.id = e.solicitante_id
  LEFT JOIN LATERAL (
    SELECT es.estado::TEXT AS estado, es.resultado::TEXT AS resultado, es.score, es.created_at,
           es.pago_por::TEXT AS pago_por,
           -- Flujo §12 (espejo de estudios/expiracion.ts): la evaluación espera
           -- al prospecto y su última autorización lleva más del plazo sin firmar.
           (e.estado::TEXT NOT IN ('cerrado','rechazado')
            AND es.estado::TEXT IN ('solicitado','pago_pendiente','pagado','formulario_enviado')
            AND EXISTS (
              SELECT 1 FROM (
                SELECT ah.created_at, ah.estado::TEXT AS estado
                FROM autorizaciones_habeas_data ah
                WHERE ah.expediente_id = e.id AND ah.coarrendatario_id IS NULL
                ORDER BY ah.created_at DESC
                LIMIT 1
              ) ult
              WHERE ult.estado <> 'autorizado'
                AND ult.created_at + v_dias_expiracion * INTERVAL '1 day' <= now()
            )) AS expirado
    FROM estudios es
    WHERE es.expediente_id = e.id
    ORDER BY es.created_at DESC
    LIMIT 1
  ) ev ON TRUE
  WHERE (p_allowed_expediente_ids IS NULL OR e.id = ANY(p_allowed_expediente_ids))
    AND (p_estados IS NULL OR e.estado::TEXT = ANY(p_estados))
    AND (p_analista_id IS NULL OR e.analista_id = p_analista_id)
    AND (p_miembro_responsable_id IS NULL OR e.miembro_responsable_id = p_miembro_responsable_id)
    AND (p_inmueble_id IS NULL OR e.inmueble_id = p_inmueble_id)
    AND (p_fecha_desde IS NULL OR e.created_at >= p_fecha_desde)
    AND (p_fecha_hasta IS NULL OR e.created_at <= p_fecha_hasta)
    AND (p_search IS NULL OR (
      e.numero ILIKE '%' || p_search || '%'
      OR s.nombre ILIKE '%' || p_search || '%'
      OR s.apellido ILIKE '%' || p_search || '%'
      OR s.numero_documento ILIKE '%' || p_search || '%'
      OR i.direccion ILIKE '%' || p_search || '%'
      OR i.codigo ILIKE '%' || p_search || '%'
    ))
    AND (
      p_estudio_filtro IS NULL OR p_estudio_filtro = 'todos'
      OR (p_estudio_filtro = 'aprobado' AND ev.resultado = 'aprobado')
      OR (p_estudio_filtro = 'rechazado' AND ev.resultado = 'rechazado')
      OR (p_estudio_filtro = 'condicionado' AND ev.resultado = 'condicionado')
      OR (p_estudio_filtro = 'en_proceso' AND ev.created_at IS NOT NULL AND ev.resultado = 'pendiente')
      OR (p_estudio_filtro = 'sin_estudio' AND ev.created_at IS NULL)
      OR (p_estudio_filtro = 'requiere_accion' AND (
        -- (a) cita resuelta pero la evaluación aún no se habilita
        (e.estado IN ('borrador','en_revision','informacion_incompleta')
         AND e.estudio_habilitado = FALSE
         AND COALESCE(e.estudio_rechazado, FALSE) = FALSE
         AND (e.cita_omitida OR e.source = 'invitacion'
              OR EXISTS (SELECT 1 FROM citas c2 WHERE c2.expediente_id = e.id AND c2.estado = 'realizada')))
        -- (b) evaluación esperando que alguien decida quién paga
        OR (ev.estado = 'pago_pendiente' AND ev.pago_por IS NULL)
        -- (c) la consulta al buró falló: hay que reintentar
        OR (ev.estado = 'fallido')
        -- (d) condicionado: aprobar, pedir soportes o sumar co-arrendatario
        OR (e.estado = 'condicionado')
        -- (e) aprobado sin contrato todavía
        OR (e.estado = 'aprobado'
            AND NOT EXISTS (SELECT 1 FROM contratos ct WHERE ct.expediente_id = e.id AND ct.estado <> 'cancelado'))
        -- (f) la autorización expiró: le toca al gestor reenviarla (Flujo §12)
        OR COALESCE(ev.expirado, FALSE)
        -- (g) firma incompleta (V3 §11.7.4-5): reenviar o cancelar le toca al gestor
        OR EXISTS (SELECT 1 FROM contratos ctf WHERE ctf.expediente_id = e.id AND ctf.estado = 'firma_incompleta')
        -- (h) fianza activa o terminada sin acta de entrega e inventario (V3 §12.1-12.2): cargarla le toca al gestor
        OR EXISTS (SELECT 1 FROM contratos cta WHERE cta.expediente_id = e.id AND cta.destinacion IS NOT NULL
                   AND cta.estado IN ('vigente', 'finalizado')
                   AND NOT EXISTS (SELECT 1 FROM contrato_archivos caa WHERE caa.contrato_id = cta.id AND caa.tipo_archivo = 'acta_entrega'))
      ))
    );

  SELECT json_build_object(
    'data', COALESCE(json_agg(sub.row_data), '[]'::json),
    'total', total_count
  ) INTO result
  FROM (
    SELECT json_build_object(
      'id', e.id,
      'numero', e.numero,
      'estado', e.estado,
      'notas', e.notas,
      'coarrendatario_nombre', e.coarrendatario_nombre,
      'coarrendatario_tipo_documento', e.coarrendatario_tipo_documento,
      'coarrendatario_documento', e.coarrendatario_documento,
      'coarrendatario_parentesco', e.coarrendatario_parentesco,
      'analista_id', e.analista_id,
      'miembro_responsable_id', e.miembro_responsable_id,
      'inmueble_id', e.inmueble_id,
      'solicitante_id', e.solicitante_id,
      'creado_por', e.creado_por,
      'cancelado_at', e.cancelado_at,
      'motivo_cancelacion', e.motivo_cancelacion,
      'estado_pre_cancelacion', e.estado_pre_cancelacion,
      'created_at', e.created_at,
      'updated_at', e.updated_at,
      -- "El paso de cita está resuelto": realizada, omitida (3.2) o no
      -- requerida (expediente creado por invitación). Mismo criterio que el
      -- gate de fn_habilitar_estudio_expediente.
      'cita_realizada', (
        e.cita_omitida
        OR e.source = 'invitacion'
        OR EXISTS (
          SELECT 1 FROM citas c
          WHERE c.expediente_id = e.id AND c.estado = 'realizada'
        )
      ),
      'cita_omitida', e.cita_omitida,
      -- ¿Este estudio espera algo del gestor? (mismo predicado que el filtro)
      'requiere_accion', COALESCE((
        -- (a) cita resuelta pero la evaluación aún no se habilita
        (e.estado IN ('borrador','en_revision','informacion_incompleta')
         AND e.estudio_habilitado = FALSE
         AND COALESCE(e.estudio_rechazado, FALSE) = FALSE
         AND (e.cita_omitida OR e.source = 'invitacion'
              OR EXISTS (SELECT 1 FROM citas c2 WHERE c2.expediente_id = e.id AND c2.estado = 'realizada')))
        -- (b) evaluación esperando que alguien decida quién paga
        OR (ev.estado = 'pago_pendiente' AND ev.pago_por IS NULL)
        -- (c) la consulta al buró falló: hay que reintentar
        OR (ev.estado = 'fallido')
        -- (d) condicionado: aprobar, pedir soportes o sumar co-arrendatario
        OR (e.estado = 'condicionado')
        -- (e) aprobado sin contrato todavía
        OR (e.estado = 'aprobado'
            AND NOT EXISTS (SELECT 1 FROM contratos ct WHERE ct.expediente_id = e.id AND ct.estado <> 'cancelado'))
        -- (f) la autorización expiró: le toca al gestor reenviarla (Flujo §12)
        OR COALESCE(ev.expirado, FALSE)
        -- (g) firma incompleta (V3 §11.7.4-5): reenviar o cancelar le toca al gestor
        OR EXISTS (SELECT 1 FROM contratos ctf WHERE ctf.expediente_id = e.id AND ctf.estado = 'firma_incompleta')
        -- (h) fianza activa o terminada sin acta de entrega e inventario (V3 §12.1-12.2): cargarla le toca al gestor
        OR EXISTS (SELECT 1 FROM contratos cta WHERE cta.expediente_id = e.id AND cta.destinacion IS NOT NULL
                   AND cta.estado IN ('vigente', 'finalizado')
                   AND NOT EXISTS (SELECT 1 FROM contrato_archivos caa WHERE caa.contrato_id = cta.id AND caa.tipo_archivo = 'acta_entrega'))
      ), FALSE),
      -- De quién depende ahora mismo, para no abrir el detalle a adivinar.
      'depende_de', CASE
        WHEN COALESCE((
        -- (a) cita resuelta pero la evaluación aún no se habilita
        (e.estado IN ('borrador','en_revision','informacion_incompleta')
         AND e.estudio_habilitado = FALSE
         AND COALESCE(e.estudio_rechazado, FALSE) = FALSE
         AND (e.cita_omitida OR e.source = 'invitacion'
              OR EXISTS (SELECT 1 FROM citas c2 WHERE c2.expediente_id = e.id AND c2.estado = 'realizada')))
        -- (b) evaluación esperando que alguien decida quién paga
        OR (ev.estado = 'pago_pendiente' AND ev.pago_por IS NULL)
        -- (c) la consulta al buró falló: hay que reintentar
        OR (ev.estado = 'fallido')
        -- (d) condicionado: aprobar, pedir soportes o sumar co-arrendatario
        OR (e.estado = 'condicionado')
        -- (e) aprobado sin contrato todavía
        OR (e.estado = 'aprobado'
            AND NOT EXISTS (SELECT 1 FROM contratos ct WHERE ct.expediente_id = e.id AND ct.estado <> 'cancelado'))
        -- (f) la autorización expiró: le toca al gestor reenviarla (Flujo §12)
        OR COALESCE(ev.expirado, FALSE)
        -- (g) firma incompleta (V3 §11.7.4-5): reenviar o cancelar le toca al gestor
        OR EXISTS (SELECT 1 FROM contratos ctf WHERE ctf.expediente_id = e.id AND ctf.estado = 'firma_incompleta')
        -- (h) fianza activa o terminada sin acta de entrega e inventario (V3 §12.1-12.2): cargarla le toca al gestor
        OR EXISTS (SELECT 1 FROM contratos cta WHERE cta.expediente_id = e.id AND cta.destinacion IS NOT NULL
                   AND cta.estado IN ('vigente', 'finalizado')
                   AND NOT EXISTS (SELECT 1 FROM contrato_archivos caa WHERE caa.contrato_id = cta.id AND caa.tipo_archivo = 'acta_entrega'))
      ), FALSE) THEN 'gestor'
        WHEN ev.estado IN ('solicitado','pago_pendiente','autorizado','formulario_enviado') THEN 'prospecto'
        WHEN ev.estado IN ('pagado','formulario_completado','documentos_cargados','en_proceso') THEN 'cofianza'
        WHEN EXISTS (SELECT 1 FROM contratos ct2 WHERE ct2.expediente_id = e.id AND ct2.estado = 'pendiente_firma') THEN 'prospecto'
        ELSE NULL
      END,
      'estudio_vigente', CASE WHEN ev.created_at IS NOT NULL THEN json_build_object(
        'estado', ev.estado,
        'resultado', ev.resultado,
        'score', ev.score,
        'created_at', ev.created_at,
        'expirado', COALESCE(ev.expirado, FALSE)
      ) ELSE NULL END,
      'inmueble', json_build_object(
        'id', i.id,
        'codigo', i.codigo,
        'direccion', i.direccion,
        'ciudad', i.ciudad,
        'tipo', i.tipo
      ),
      'solicitante', json_build_object(
        'id', s.id,
        'nombre', s.nombre,
        'apellido', s.apellido,
        'tipo_documento', s.tipo_documento,
        'numero_documento', s.numero_documento,
        'email', s.email
      ),
      'analista', CASE WHEN a.id IS NOT NULL THEN json_build_object(
        'id', a.id,
        'nombre', a.nombre,
        'apellido', a.apellido
      ) ELSE NULL END,
      'creador', CASE WHEN c.id IS NOT NULL THEN json_build_object(
        'id', c.id,
        'nombre', c.nombre,
        'apellido', c.apellido
      ) ELSE NULL END
    ) AS row_data
    FROM expedientes e
    LEFT JOIN inmuebles i ON i.id = e.inmueble_id
    LEFT JOIN solicitantes s ON s.id = e.solicitante_id
    LEFT JOIN perfiles a ON a.id = e.analista_id
    LEFT JOIN perfiles c ON c.id = e.creado_por
    LEFT JOIN LATERAL (
      SELECT es.estado::TEXT AS estado, es.resultado::TEXT AS resultado, es.score, es.created_at,
             es.pago_por::TEXT AS pago_por,
             (e.estado::TEXT NOT IN ('cerrado','rechazado')
              AND es.estado::TEXT IN ('solicitado','pago_pendiente','pagado','formulario_enviado')
              AND EXISTS (
                SELECT 1 FROM (
                  SELECT ah.created_at, ah.estado::TEXT AS estado
                  FROM autorizaciones_habeas_data ah
                  WHERE ah.expediente_id = e.id AND ah.coarrendatario_id IS NULL
                  ORDER BY ah.created_at DESC
                  LIMIT 1
                ) ult
                WHERE ult.estado <> 'autorizado'
                  AND ult.created_at + v_dias_expiracion * INTERVAL '1 day' <= now()
              )) AS expirado
      FROM estudios es
      WHERE es.expediente_id = e.id
      ORDER BY es.created_at DESC
      LIMIT 1
    ) ev ON TRUE
    WHERE (p_allowed_expediente_ids IS NULL OR e.id = ANY(p_allowed_expediente_ids))
      AND (p_estados IS NULL OR e.estado::TEXT = ANY(p_estados))
      AND (p_analista_id IS NULL OR e.analista_id = p_analista_id)
    AND (p_miembro_responsable_id IS NULL OR e.miembro_responsable_id = p_miembro_responsable_id)
      AND (p_inmueble_id IS NULL OR e.inmueble_id = p_inmueble_id)
      AND (p_fecha_desde IS NULL OR e.created_at >= p_fecha_desde)
      AND (p_fecha_hasta IS NULL OR e.created_at <= p_fecha_hasta)
      AND (p_search IS NULL OR (
        e.numero ILIKE '%' || p_search || '%'
        OR s.nombre ILIKE '%' || p_search || '%'
        OR s.apellido ILIKE '%' || p_search || '%'
        OR s.numero_documento ILIKE '%' || p_search || '%'
        OR i.direccion ILIKE '%' || p_search || '%'
        OR i.codigo ILIKE '%' || p_search || '%'
      ))
      AND (
        p_estudio_filtro IS NULL OR p_estudio_filtro = 'todos'
        OR (p_estudio_filtro = 'aprobado' AND ev.resultado = 'aprobado')
        OR (p_estudio_filtro = 'rechazado' AND ev.resultado = 'rechazado')
        OR (p_estudio_filtro = 'condicionado' AND ev.resultado = 'condicionado')
        OR (p_estudio_filtro = 'en_proceso' AND ev.created_at IS NOT NULL AND ev.resultado = 'pendiente')
        OR (p_estudio_filtro = 'sin_estudio' AND ev.created_at IS NULL)
        OR (p_estudio_filtro = 'requiere_accion' AND (
        -- (a) cita resuelta pero la evaluación aún no se habilita
        (e.estado IN ('borrador','en_revision','informacion_incompleta')
         AND e.estudio_habilitado = FALSE
         AND COALESCE(e.estudio_rechazado, FALSE) = FALSE
         AND (e.cita_omitida OR e.source = 'invitacion'
              OR EXISTS (SELECT 1 FROM citas c2 WHERE c2.expediente_id = e.id AND c2.estado = 'realizada')))
        -- (b) evaluación esperando que alguien decida quién paga
        OR (ev.estado = 'pago_pendiente' AND ev.pago_por IS NULL)
        -- (c) la consulta al buró falló: hay que reintentar
        OR (ev.estado = 'fallido')
        -- (d) condicionado: aprobar, pedir soportes o sumar co-arrendatario
        OR (e.estado = 'condicionado')
        -- (e) aprobado sin contrato todavía
        OR (e.estado = 'aprobado'
            AND NOT EXISTS (SELECT 1 FROM contratos ct WHERE ct.expediente_id = e.id AND ct.estado <> 'cancelado'))
        -- (f) la autorización expiró: le toca al gestor reenviarla (Flujo §12)
        OR COALESCE(ev.expirado, FALSE)
        -- (g) firma incompleta (V3 §11.7.4-5): reenviar o cancelar le toca al gestor
        OR EXISTS (SELECT 1 FROM contratos ctf WHERE ctf.expediente_id = e.id AND ctf.estado = 'firma_incompleta')
        -- (h) fianza activa o terminada sin acta de entrega e inventario (V3 §12.1-12.2): cargarla le toca al gestor
        OR EXISTS (SELECT 1 FROM contratos cta WHERE cta.expediente_id = e.id AND cta.destinacion IS NOT NULL
                   AND cta.estado IN ('vigente', 'finalizado')
                   AND NOT EXISTS (SELECT 1 FROM contrato_archivos caa WHERE caa.contrato_id = cta.id AND caa.tipo_archivo = 'acta_entrega'))
      ))
      )
    ORDER BY
      CASE WHEN p_sort_field = 'created_at' AND p_sort_direction = 'desc' THEN e.created_at END DESC,
      CASE WHEN p_sort_field = 'created_at' AND p_sort_direction = 'asc' THEN e.created_at END ASC,
      CASE WHEN p_sort_field = 'numero' AND p_sort_direction = 'desc' THEN e.numero END DESC,
      CASE WHEN p_sort_field = 'numero' AND p_sort_direction = 'asc' THEN e.numero END ASC,
      CASE WHEN p_sort_field = 'estado' AND p_sort_direction = 'desc' THEN e.estado::TEXT END DESC,
      CASE WHEN p_sort_field = 'estado' AND p_sort_direction = 'asc' THEN e.estado::TEXT END ASC,
      CASE WHEN p_sort_field = 'updated_at' AND p_sort_direction = 'desc' THEN e.updated_at END DESC,
      CASE WHEN p_sort_field = 'updated_at' AND p_sort_direction = 'asc' THEN e.updated_at END ASC
    LIMIT p_limit
    OFFSET p_offset
  ) sub;

  RETURN result;
END;
$function$;

-- ============================================================
-- Verificacion manual (no deja rastro). Pegar completo en el SQL editor; cada
-- error esperado se atrapa y, si algo no cuadra, aborta con "FALLA (x)". Al
-- final debe salir el NOTICE "Verificacion E6: todo OK".
--   BEGIN;
--   DO $v$
--   DECLARE
--     e UUID := (SELECT x.id FROM expedientes x WHERE x.estado <> 'cerrado' AND NOT EXISTS (
--       SELECT 1 FROM contratos t WHERE t.expediente_id = x.id AND t.estado <> 'cancelado')
--       AND x.id NOT IN (SELECT (d->>'id')::uuid FROM json_array_elements(
--         list_expedientes_with_relations(p_estudio_filtro => 'requiere_accion', p_limit => 1000)->'data') d)
--       LIMIT 1);
--     c UUID; antes INT; despues INT;
--   BEGIN
--     ASSERT e IS NOT NULL, 'FALLA: no hay un estudio abierto sin contrato para la prueba';
--     SELECT (list_expedientes_with_relations(p_estudio_filtro => 'requiere_accion', p_limit => 1000)->>'total')::INT INTO antes;
--     INSERT INTO contratos (expediente_id, estado, destinacion, iva_canon_pct, datos_variables)
--       VALUES (e, 'borrador', 'vivienda', 0, '{"asistente":{}}') RETURNING id INTO c;
--     -- (b) EN FIRMA no cierra
--     UPDATE contratos SET estado = 'pendiente_firma' WHERE id = c;   -- OLD en borrador: el congelamiento no lo revisa
--     BEGIN
--       UPDATE expedientes SET estado = 'cerrado' WHERE id = e;
--       RAISE EXCEPTION 'FALLA (b): cerro con el contrato en firma';
--     EXCEPTION WHEN raise_exception THEN
--       IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--       ASSERT SQLERRM LIKE 'CONTRATO_EN_FIRMA%', 'FALLA (b): otro error: ' || SQLERRM;
--     END;
--     UPDATE contratos SET estado = 'vigente' WHERE id = c;   -- pendiente_firma -> vigente: columnas congeladas intactas
--     -- (c) acta pendiente -> entra en "Requieren mi accion"
--     SELECT (list_expedientes_with_relations(p_estudio_filtro => 'requiere_accion', p_limit => 1000)->>'total')::INT INTO despues;
--     ASSERT despues = antes + 1, format('FALLA (c): el total paso de %s a %s (esperado +1)', antes, despues);
--     -- (b) sin acta no cierra
--     BEGIN
--       UPDATE expedientes SET estado = 'cerrado' WHERE id = e;
--       RAISE EXCEPTION 'FALLA (b): cerro sin acta';
--     EXCEPTION WHEN raise_exception THEN
--       IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--       ASSERT SQLERRM LIKE 'ACTA_ENTREGA_REQUERIDA%', 'FALLA (b): otro error: ' || SQLERRM;
--     END;
--     -- (a) vigente -> cancelado sigue prohibido; vigente -> finalizado ahora si
--     BEGIN
--       PERFORM transicionar_contrato(c, 'cancelado', 'v', NULL);
--       RAISE EXCEPTION 'FALLA (a): cancelo una fianza activa';
--     EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--     END;
--     PERFORM transicionar_contrato(c, 'finalizado', 'v', NULL);
--     -- (b) terminado sin acta tampoco cierra
--     BEGIN
--       UPDATE expedientes SET estado = 'cerrado' WHERE id = e;
--       RAISE EXCEPTION 'FALLA (b): cerro un terminado sin acta';
--     EXCEPTION WHEN raise_exception THEN
--       IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF;
--     END;
--     -- (b) con acta si cierra, y (c) sale de "Requieren mi accion"
--     INSERT INTO contrato_archivos (contrato_id, tipo_archivo, storage_key, nombre_archivo, tipo_mime, tamano_bytes, hash_integridad)
--       VALUES (c, 'acta_entrega', 'verificacion/acta.pdf', 'acta.pdf', 'application/pdf', 1, repeat('0', 64));
--     SELECT (list_expedientes_with_relations(p_estudio_filtro => 'requiere_accion', p_limit => 1000)->>'total')::INT INTO despues;
--     ASSERT despues = antes, format('FALLA (c): con acta el total quedo en %s (esperado %s)', despues, antes);
--     UPDATE expedientes SET estado = 'cerrado' WHERE id = e;
--     RAISE NOTICE 'Verificacion E6: todo OK';
--   END $v$;
--   ROLLBACK;
-- ============================================================

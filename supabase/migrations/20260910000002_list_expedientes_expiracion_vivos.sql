-- ============================================================
-- Expiración solo para estudios vivos
-- ------------------------------------------------------------
-- 20260910000001 marcaba `expirado` a cualquier estudio cuya evaluación
-- siguiera esperando al prospecto con la autorización vencida, aunque el
-- estudio ya estuviera cerrado (cancelado incluido) o no aprobable: esos
-- aparecían en "Requieren mi acción" con "Te toca a ti" y el badge
-- "Expirado", cuando ya no hay nada que reenviar.
--
-- Único cambio: `expirado` exige e.estado fuera de ('cerrado','rechazado'),
-- los estados terminales de expedientes.service.ts. Misma firma → CREATE OR
-- REPLACE. ROLLBACK: reaplicar 20260910000001.
-- ============================================================

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

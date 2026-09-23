-- ============================================================
-- Adenda 1 del módulo de contratos, respuesta 21: el estudio que un
-- administrador cerró SIN ACTA sale de «Requieren mi acción». La condición (h)
-- (fianza activa o terminada sin acta de entrega) no miraba ese cierre y lo
-- dejaba ahí para siempre.
--
-- Requiere 20260930000002 (expedientes.cierre_sin_acta_en). Parte del cuerpo
-- DESPLEGADO de list_expedientes_with_relations: el de 20260929000037,
-- verificado contra producción el 2026-09-23 (md5(prosrc) =
-- b333e3c6a3babd4987092ed53b6d13c1). Único cambio: `AND e.cierre_sin_acta_en
-- IS NULL` en las cuatro copias de (h). El resto es idéntico.
--
-- Guardas (en una transacción: si abortan no se reemplaza nada, también con
-- psql -f sin ON_ERROR_STOP): falta la columna → corre antes la 000002; el
-- cuerpo desplegado no es ni el de 20260929000037 ni el de esta migración
-- (otra la cambió) → rehacerla sobre el desplegado. Idempotente.
-- Misma firma → CREATE OR REPLACE conserva los permisos; se repite el REVOKE
-- de 20260929000037 (solo service_role la ejecuta).
-- ROLLBACK: reaplicar 20260929000037.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'expedientes' AND column_name = 'cierre_sin_acta_en'
  ) THEN
    RAISE EXCEPTION 'Corre primero 20260930000002_expediente_cierre_sin_acta.sql: falta la columna expedientes.cierre_sin_acta_en';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'list_expedientes_with_relations')
     NOT IN ('b333e3c6a3babd4987092ed53b6d13c1', '65a257953ea32c6b856b74659ca4867c') THEN
    RAISE EXCEPTION 'list_expedientes_with_relations cambió después de 20260929000037: rehacer esta migración sobre el cuerpo desplegado';
  END IF;
END $$;

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
  -- Respaldo si el enlace no guardó su vencimiento (lib/calibracion.ts,
  -- DIAS_EXPIRACION_ESTUDIO).
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
                SELECT ah.created_at, ah.estado::TEXT AS estado, ah.token_expiracion
                FROM autorizaciones_habeas_data ah
                WHERE ah.expediente_id = e.id AND ah.coarrendatario_id IS NULL
                ORDER BY ah.created_at DESC
                LIMIT 1
              ) ult
              WHERE ult.estado <> 'autorizado'
                AND COALESCE(ult.token_expiracion, ult.created_at + v_dias_expiracion * INTERVAL '1 day') <= now()
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
        -- (h) fianza activa o terminada sin acta de entrega e inventario (V3 §12.1-12.2): cargarla le toca al gestor,
        --     salvo que un administrador haya cerrado el estudio sin acta (Adenda 1 contratos, respuesta 21)
        OR EXISTS (SELECT 1 FROM contratos cta WHERE cta.expediente_id = e.id AND cta.destinacion IS NOT NULL AND e.cierre_sin_acta_en IS NULL
                   AND cta.estado IN ('vigente', 'finalizado')
                   AND NOT EXISTS (SELECT 1 FROM contrato_archivos caa WHERE caa.contrato_id = cta.id AND caa.tipo_archivo = 'acta_entrega'))
        -- (i) V3 EN FIRMA que espera a la inmobiliaria: el último envío no llegó a Auco o se anuló (Reintentar),
        --     o ya firmaron todos menos EL ARRENDADOR, que firma de último (V3 §6.5)
        OR EXISTS (SELECT 1 FROM contratos ctv
                   JOIN LATERAL (SELECT sv.estado, sv.firmantes FROM contrato_v3_sobres sv
                                 WHERE sv.contrato_id = ctv.id ORDER BY sv.intento DESC LIMIT 1) us ON TRUE
                   WHERE ctv.expediente_id = e.id AND ctv.destinacion IS NOT NULL AND ctv.estado = 'pendiente_firma'
                     AND (us.estado IN ('fallido', 'cancelado')
                          OR (us.estado = 'en_firma' AND NOT EXISTS (
                                SELECT 1 FROM jsonb_array_elements(us.firmantes) fv
                                JOIN contrato_partes cpv ON cpv.id::TEXT = fv->>'parteId'
                                WHERE cpv.rol <> 'arrendador' AND fv->>'estado' <> 'firmado'))))
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
        -- (h) fianza activa o terminada sin acta de entrega e inventario (V3 §12.1-12.2): cargarla le toca al gestor,
        --     salvo que un administrador haya cerrado el estudio sin acta (Adenda 1 contratos, respuesta 21)
        OR EXISTS (SELECT 1 FROM contratos cta WHERE cta.expediente_id = e.id AND cta.destinacion IS NOT NULL AND e.cierre_sin_acta_en IS NULL
                   AND cta.estado IN ('vigente', 'finalizado')
                   AND NOT EXISTS (SELECT 1 FROM contrato_archivos caa WHERE caa.contrato_id = cta.id AND caa.tipo_archivo = 'acta_entrega'))
        -- (i) V3 EN FIRMA que espera a la inmobiliaria: el último envío no llegó a Auco o se anuló (Reintentar),
        --     o ya firmaron todos menos EL ARRENDADOR, que firma de último (V3 §6.5)
        OR EXISTS (SELECT 1 FROM contratos ctv
                   JOIN LATERAL (SELECT sv.estado, sv.firmantes FROM contrato_v3_sobres sv
                                 WHERE sv.contrato_id = ctv.id ORDER BY sv.intento DESC LIMIT 1) us ON TRUE
                   WHERE ctv.expediente_id = e.id AND ctv.destinacion IS NOT NULL AND ctv.estado = 'pendiente_firma'
                     AND (us.estado IN ('fallido', 'cancelado')
                          OR (us.estado = 'en_firma' AND NOT EXISTS (
                                SELECT 1 FROM jsonb_array_elements(us.firmantes) fv
                                JOIN contrato_partes cpv ON cpv.id::TEXT = fv->>'parteId'
                                WHERE cpv.rol <> 'arrendador' AND fv->>'estado' <> 'firmado'))))
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
        -- (h) fianza activa o terminada sin acta de entrega e inventario (V3 §12.1-12.2): cargarla le toca al gestor,
        --     salvo que un administrador haya cerrado el estudio sin acta (Adenda 1 contratos, respuesta 21)
        OR EXISTS (SELECT 1 FROM contratos cta WHERE cta.expediente_id = e.id AND cta.destinacion IS NOT NULL AND e.cierre_sin_acta_en IS NULL
                   AND cta.estado IN ('vigente', 'finalizado')
                   AND NOT EXISTS (SELECT 1 FROM contrato_archivos caa WHERE caa.contrato_id = cta.id AND caa.tipo_archivo = 'acta_entrega'))
        -- (i) V3 EN FIRMA que espera a la inmobiliaria: el último envío no llegó a Auco o se anuló (Reintentar),
        --     o ya firmaron todos menos EL ARRENDADOR, que firma de último (V3 §6.5)
        OR EXISTS (SELECT 1 FROM contratos ctv
                   JOIN LATERAL (SELECT sv.estado, sv.firmantes FROM contrato_v3_sobres sv
                                 WHERE sv.contrato_id = ctv.id ORDER BY sv.intento DESC LIMIT 1) us ON TRUE
                   WHERE ctv.expediente_id = e.id AND ctv.destinacion IS NOT NULL AND ctv.estado = 'pendiente_firma'
                     AND (us.estado IN ('fallido', 'cancelado')
                          OR (us.estado = 'en_firma' AND NOT EXISTS (
                                SELECT 1 FROM jsonb_array_elements(us.firmantes) fv
                                JOIN contrato_partes cpv ON cpv.id::TEXT = fv->>'parteId'
                                WHERE cpv.rol <> 'arrendador' AND fv->>'estado' <> 'firmado'))))
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
                  SELECT ah.created_at, ah.estado::TEXT AS estado, ah.token_expiracion
                  FROM autorizaciones_habeas_data ah
                  WHERE ah.expediente_id = e.id AND ah.coarrendatario_id IS NULL
                  ORDER BY ah.created_at DESC
                  LIMIT 1
                ) ult
                WHERE ult.estado <> 'autorizado'
                  AND COALESCE(ult.token_expiracion, ult.created_at + v_dias_expiracion * INTERVAL '1 day') <= now()
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
        -- (h) fianza activa o terminada sin acta de entrega e inventario (V3 §12.1-12.2): cargarla le toca al gestor,
        --     salvo que un administrador haya cerrado el estudio sin acta (Adenda 1 contratos, respuesta 21)
        OR EXISTS (SELECT 1 FROM contratos cta WHERE cta.expediente_id = e.id AND cta.destinacion IS NOT NULL AND e.cierre_sin_acta_en IS NULL
                   AND cta.estado IN ('vigente', 'finalizado')
                   AND NOT EXISTS (SELECT 1 FROM contrato_archivos caa WHERE caa.contrato_id = cta.id AND caa.tipo_archivo = 'acta_entrega'))
        -- (i) V3 EN FIRMA que espera a la inmobiliaria: el último envío no llegó a Auco o se anuló (Reintentar),
        --     o ya firmaron todos menos EL ARRENDADOR, que firma de último (V3 §6.5)
        OR EXISTS (SELECT 1 FROM contratos ctv
                   JOIN LATERAL (SELECT sv.estado, sv.firmantes FROM contrato_v3_sobres sv
                                 WHERE sv.contrato_id = ctv.id ORDER BY sv.intento DESC LIMIT 1) us ON TRUE
                   WHERE ctv.expediente_id = e.id AND ctv.destinacion IS NOT NULL AND ctv.estado = 'pendiente_firma'
                     AND (us.estado IN ('fallido', 'cancelado')
                          OR (us.estado = 'en_firma' AND NOT EXISTS (
                                SELECT 1 FROM jsonb_array_elements(us.firmantes) fv
                                JOIN contrato_partes cpv ON cpv.id::TEXT = fv->>'parteId'
                                WHERE cpv.rol <> 'arrendador' AND fv->>'estado' <> 'firmado'))))
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

REVOKE EXECUTE ON FUNCTION public.list_expedientes_with_relations(text, text[], uuid, uuid, timestamptz, timestamptz, text, text, integer, integer, text, uuid[], uuid) FROM PUBLIC, anon, authenticated;

COMMIT;

-- ============================================================
-- Verificación de solo lectura (después de correrla):
--   SELECT md5(prosrc) FROM pg_proc WHERE proname = 'list_expedientes_with_relations';
--   -- esperado: 65a257953ea32c6b856b74659ca4867c
--   SELECT (length(prosrc) - length(replace(prosrc, 'e.cierre_sin_acta_en IS NULL', ''))) / length('e.cierre_sin_acta_en IS NULL')
--     FROM pg_proc WHERE proname = 'list_expedientes_with_relations';
--   -- esperado: 4
--
-- Verificación funcional (no deja rastro). Pegar completo en el SQL editor; al
-- final debe salir el NOTICE "Verificacion 000002b: todo OK".
--   BEGIN;
--   DO $v$
--   DECLARE
--     e UUID := (SELECT x.id FROM expedientes x WHERE x.estado <> 'cerrado' AND NOT EXISTS (
--       SELECT 1 FROM contratos t WHERE t.expediente_id = x.id AND t.estado <> 'cancelado')
--       AND x.id NOT IN (SELECT (d->>'id')::uuid FROM json_array_elements(
--         list_expedientes_with_relations(p_estudio_filtro => 'requiere_accion', p_limit => 1000)->'data') d)
--       LIMIT 1);
--     adm UUID := (SELECT id FROM perfiles WHERE rol = 'administrador' LIMIT 1);
--     antes INT; despues INT;
--   BEGIN
--     ASSERT e IS NOT NULL AND adm IS NOT NULL, 'FALLA: faltan datos para la prueba';
--     SELECT (list_expedientes_with_relations(p_estudio_filtro => 'requiere_accion', p_limit => 1000)->>'total')::INT INTO antes;
--     INSERT INTO contratos (expediente_id, estado, destinacion, iva_canon_pct, datos_variables)
--       VALUES (e, 'borrador', 'vivienda', 0, '{"asistente":{}}');
--     UPDATE contratos SET estado = 'vigente' WHERE expediente_id = e AND estado = 'borrador';
--     SELECT (list_expedientes_with_relations(p_estudio_filtro => 'requiere_accion', p_limit => 1000)->>'total')::INT INTO despues;
--     ASSERT despues = antes + 1, format('FALLA: con el acta pendiente el total paso de %s a %s (esperado +1)', antes, despues);
--     UPDATE expedientes SET estado = 'cerrado', cierre_sin_acta_en = now(), cierre_sin_acta_por = adm,
--       cierre_sin_acta_motivo = 'Prueba de la verificacion 000002b' WHERE id = e;
--     SELECT (list_expedientes_with_relations(p_estudio_filtro => 'requiere_accion', p_limit => 1000)->>'total')::INT INTO despues;
--     ASSERT despues = antes, format('FALLA: cerrado sin acta el total quedo en %s (esperado %s)', despues, antes);
--     RAISE NOTICE 'Verificacion 000002b: todo OK';
--   END $v$;
--   ROLLBACK;
-- ============================================================

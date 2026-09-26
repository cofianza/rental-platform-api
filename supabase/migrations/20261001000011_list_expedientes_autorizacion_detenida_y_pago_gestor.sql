-- ============================================================
-- Revisión de lógica 2026-09-25 (puntos 3 y 4 del bloque de autorización):
-- «Requieren mi acción» y «De quién depende» del listado de estudios.
--
-- (f) Una autorización DETENIDA antes del plazo —el prospecto reportó «No soy
--     yo» / «los datos están mal», el documento que escribió no coincide con
--     la ficha (§8.1), o se revocó— queda 'expirado'/'revocado' con el
--     token_expiracion todavía en el futuro. El listado seguía diciendo
--     «Esperando al prospecto» sobre un enlace que ya no se puede firmar. Ahora
--     cuenta como `expirado` (misma salida: corregir y reenviar) → requiere
--     acción del gestor. Espejo de evaluarExpiracion (estudios/expiracion.ts).
-- (j) Opción B (paga la inmobiliaria en Mercado Pago, Adenda 2 §7): mientras
--     ese pago no se haga, la solicitud de autorización NO sale y el estudio
--     queda en 'solicitado'; la lista decía «depende del prospecto». Ahora:
--     requiere acción del gestor. «Es de la inmobiliaria» = mismo criterio que
--     quienPaga (pago-estudio.service.ts): método distinto de pasarela, o el
--     correo del pagador es el de la cuenta que creó el cobro.
--
-- Parte del cuerpo de 20260930000007 (md5(prosrc) =
-- 65a257953ea32c6b856b74659ca4867c). Únicos cambios: la condición de
-- `expirado` y la columna `pago_gestor_pendiente` en los dos LATERAL `ev`, y
-- (j) en las cuatro copias del predicado. Misma firma → CREATE OR REPLACE
-- conserva los permisos; se repite el REVOKE (solo service_role la ejecuta).
--
-- Guarda (en una transacción): si el cuerpo desplegado no es el de
-- 20260930000007 ni el de esta migración, otra lo cambió → rehacerla sobre el
-- desplegado. Idempotente. Solo reemplaza la función: no escribe datos.
-- ROLLBACK: reaplicar 20260930000007.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'list_expedientes_with_relations')
     NOT IN ('65a257953ea32c6b856b74659ca4867c', '8041645f7ff05066f8a3bc23469f57ac') THEN
    RAISE EXCEPTION 'list_expedientes_with_relations cambió después de 20260930000007: rehacer esta migración sobre el cuerpo desplegado';
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
           -- al prospecto y su última autorización lleva más del plazo sin firmar,
           -- o se detuvo antes («No soy yo», documento que no coincide, revocada).
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
                AND (ult.estado IN ('expirado','revocado')
                     OR COALESCE(ult.token_expiracion, ult.created_at + v_dias_expiracion * INTERVAL '1 day') <= now())
            )) AS expirado,
           -- Opción B (Adenda 2 §7): el cobro del estudio es de la inmobiliaria (espejo de
           -- quienPaga en pago-estudio.service.ts) y no se ha pagado; la autorización le
           -- sale al prospecto solo cuando se confirme ese pago.
           (e.estado::TEXT NOT IN ('cerrado','rechazado')
            AND es.estado::TEXT IN ('solicitado','pago_pendiente')
            AND NOT EXISTS (SELECT 1 FROM autorizaciones_habeas_data ah2
                            WHERE ah2.expediente_id = e.id AND ah2.coarrendatario_id IS NULL)
            AND COALESCE((
              SELECT pg.estado::TEXT IN ('pendiente','fallido')
                     AND (pg.metodo::TEXT <> 'pasarela' OR lower(pg.email_pagador) = lower(u.email))
              FROM pagos pg
              LEFT JOIN auth.users u ON u.id = pg.creado_por
              WHERE pg.expediente_id = e.id AND pg.concepto = 'estudio' AND pg.estado <> 'cancelado'
              ORDER BY pg.created_at DESC
              LIMIT 1
            ), FALSE)) AS pago_gestor_pendiente
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
        -- (f) la autorización expiró o se detuvo: le toca al gestor corregir y reenviarla (Flujo §12)
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
        -- (j) opción B sin pagar: el pago del estudio es de la inmobiliaria (Adenda 2 §7)
        OR COALESCE(ev.pago_gestor_pendiente, FALSE)
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
        -- (f) la autorización expiró o se detuvo: le toca al gestor corregir y reenviarla (Flujo §12)
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
        -- (j) opción B sin pagar: el pago del estudio es de la inmobiliaria (Adenda 2 §7)
        OR COALESCE(ev.pago_gestor_pendiente, FALSE)
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
        -- (f) la autorización expiró o se detuvo: le toca al gestor corregir y reenviarla (Flujo §12)
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
        -- (j) opción B sin pagar: el pago del estudio es de la inmobiliaria (Adenda 2 §7)
        OR COALESCE(ev.pago_gestor_pendiente, FALSE)
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
                  AND (ult.estado IN ('expirado','revocado')
                       OR COALESCE(ult.token_expiracion, ult.created_at + v_dias_expiracion * INTERVAL '1 day') <= now())
              )) AS expirado,
             (e.estado::TEXT NOT IN ('cerrado','rechazado')
              AND es.estado::TEXT IN ('solicitado','pago_pendiente')
              AND NOT EXISTS (SELECT 1 FROM autorizaciones_habeas_data ah2
                              WHERE ah2.expediente_id = e.id AND ah2.coarrendatario_id IS NULL)
              AND COALESCE((
                SELECT pg.estado::TEXT IN ('pendiente','fallido')
                       AND (pg.metodo::TEXT <> 'pasarela' OR lower(pg.email_pagador) = lower(u.email))
                FROM pagos pg
                LEFT JOIN auth.users u ON u.id = pg.creado_por
                WHERE pg.expediente_id = e.id AND pg.concepto = 'estudio' AND pg.estado <> 'cancelado'
                ORDER BY pg.created_at DESC
                LIMIT 1
              ), FALSE)) AS pago_gestor_pendiente
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
        -- (f) la autorización expiró o se detuvo: le toca al gestor corregir y reenviarla (Flujo §12)
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
        -- (j) opción B sin pagar: el pago del estudio es de la inmobiliaria (Adenda 2 §7)
        OR COALESCE(ev.pago_gestor_pendiente, FALSE)
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
--   -- esperado: 8041645f7ff05066f8a3bc23469f57ac
--   SELECT (length(prosrc) - length(replace(prosrc, 'ev.pago_gestor_pendiente', ''))) / length('ev.pago_gestor_pendiente')
--     FROM pg_proc WHERE proname = 'list_expedientes_with_relations';
--   -- esperado: 4
--
-- Estudios que cambian de «depende de»: detenidos y opción B sin pagar.
--   SELECT d->>'numero' AS numero, d->>'depende_de' AS depende_de, d->'estudio_vigente'->>'expirado' AS expirado
--     FROM json_array_elements(
--       list_expedientes_with_relations(p_estudio_filtro => 'requiere_accion', p_limit => 1000)->'data') d
--    WHERE d->'estudio_vigente'->>'estado' IN ('solicitado','pago_pendiente');
-- ============================================================

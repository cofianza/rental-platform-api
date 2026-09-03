// ============================================================
// Gate de autorizacion previa a la consulta en centrales de riesgo.
//
// Flujo del modulo de estudios, seccion 8.4 (literal): "La autorizacion para
// consultar y reportar en centrales de informacion debe ser PREVIA, expresa e
// informada, en los terminos de la Ley 1266 de 2008 y la Ley 1581 de 2012.
// Ademas debe ser demostrable si alguna vez es cuestionada."
//
// Hasta el 2026-09-03 `ejecutarEstudio` nunca leia autorizaciones_habeas_data:
// su unico gate era la bandera expedientes.estudio_habilitado. Resultado
// medido en produccion: en 4 de 7 estudios completados se consulto el buro
// ANTES de que la persona autorizara (hasta 13,9 minutos antes).
//
// Este modulo tiene dos piezas a proposito:
//   - evaluarAutorizacionPrevia: funcion PURA (fila + fecha -> veredicto). Es
//     la regla de negocio, y es lo que cubre scripts/check-autorizacion-previa.ts.
//   - assertAutorizacionVigente: resuelve el sujeto en Supabase, aplica la
//     funcion pura y traduce el veredicto a un AppError accionable.
//
// El gate se invoca ANTES de tomar el lock del estudio y ANTES de cualquier
// llamada al proveedor: un estudio bloqueado aqui no consume consulta
// facturable ni deja el estudio colgado en 'en_proceso'.
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/** Codigo de dominio unico del gate. La web lo usa para el mensaje accionable. */
export const AUTORIZACION_PREVIA_ERROR_CODE = 'AUTORIZACION_PREVIA_REQUERIDA';

/**
 * Subconjunto de `autorizaciones_habeas_data` del que depende la decision.
 * Deliberadamente estructural (no el tipo generado de Supabase) para que la
 * funcion pura se pueda ejercitar sin base de datos.
 */
export interface AutorizacionEvidencia {
  id: string;
  estado: string;
  autorizado_en: string | null;
  fecha_revocacion: string | null;
  vigente_hasta: string | null;
  numero_documento_aceptante: string | null;
  tipo_documento_aceptante: string | null;
  solicitante_id: string | null;
  coarrendatario_id: string | null;
}

export type MotivoRechazoAutorizacion =
  | 'sin_autorizacion'
  | 'otro_titular'
  | 'no_firmada'
  | 'revocada'
  | 'posterior_a_la_consulta'
  | 'caducada'
  | 'documento_distinto';

export interface SujetoAutorizacion {
  /** Titular del expediente. Excluyente con coarrendatarioId. */
  solicitanteId?: string | null;
  /** Co-arrendatario invitado: exige SU propia autorizacion, no la del titular. */
  coarrendatarioId?: string | null;
}

export interface ContextoAutorizacion {
  /** Instante en el que se consultaria el buro. La firma debe ser anterior. */
  momentoConsulta: Date;
  sujeto: SujetoAutorizacion;
  /** Documento que se le va a mandar al buro. Se contrasta con el congelado. */
  numeroDocumentoConsultado?: string | null;
  /**
   * Tipo de documento que se le va a mandar al buro. Es el PAR (tipo, numero)
   * lo que identifica a una persona en la central de riesgo: con el mismo
   * numero, 'cc' y 'ce' son dos titulares de datos distintos.
   */
  tipoDocumentoConsultado?: string | null;
  /**
   * Documento VIVO del sujeto (solicitantes / expediente_coarrendatarios),
   * leido antes de sincronizarDocumentoSolicitante. Solo se usa como respaldo
   * cuando la fila no congelo el documento (las 8 autorizaciones anteriores al
   * 2026-09-03): sin el, esas filas dejarian consultar cualquier documento.
   */
  documentoSujetoActual?: { tipo?: string | null; numero?: string | null } | null;
}

export type VeredictoAutorizacion =
  | {
      ok: true;
      autorizacionId: string;
      /**
       * false cuando la fila no trae numero_documento_aceptante: son las
       * autorizaciones firmadas antes del 2026-09-03, que no capturaron el
       * dato. Se aceptan (no se puede invalidar evidencia historica) pero el
       * caller lo deja en el log.
       */
      documentoVerificado: boolean;
    }
  | { ok: false; motivo: MotivoRechazoAutorizacion; detalle: string };

/** Cedulas y NITs se comparan sin puntos, guiones ni espacios. */
function normalizarDocumento(valor: string | null | undefined): string {
  return (valor ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

/** El tipo es un enum de la base ('cc', 'ce', 'ti', 'pasaporte', 'nit'). */
function normalizarTipoDocumento(valor: string | null | undefined): string {
  return (valor ?? '').trim().toLowerCase();
}

/**
 * Regla de negocio del 8.4, sin dependencias. Replica el predicado SQL
 * `fn_autorizacion_es_vigente` (migracion 20260903000002) y le suma las dos
 * comprobaciones que el predicado no puede hacer: que la autorizacion sea del
 * sujeto correcto y que sea ANTERIOR al momento de la consulta.
 */
export function evaluarAutorizacionPrevia(
  autorizacion: AutorizacionEvidencia | null | undefined,
  contexto: ContextoAutorizacion,
): VeredictoAutorizacion {
  if (!autorizacion) {
    return {
      ok: false,
      motivo: 'sin_autorizacion',
      detalle: 'No existe ninguna autorizacion de tratamiento de datos para este sujeto.',
    };
  }

  // 1. El sujeto. Un co-arrendatario NO queda cubierto por la firma del
  //    titular: es otro titular de datos y su consulta al buro es propia.
  const esperaCoarrendatario = !!contexto.sujeto.coarrendatarioId;
  if (esperaCoarrendatario) {
    if (autorizacion.coarrendatario_id !== contexto.sujeto.coarrendatarioId) {
      return {
        ok: false,
        motivo: 'otro_titular',
        detalle: 'La autorizacion encontrada no es la del co-arrendatario que se va a consultar.',
      };
    }
  } else if (
    contexto.sujeto.solicitanteId &&
    autorizacion.solicitante_id !== contexto.sujeto.solicitanteId
  ) {
    return {
      ok: false,
      motivo: 'otro_titular',
      detalle: 'La autorizacion encontrada pertenece a otro solicitante.',
    };
  }

  // 2. Firmada.
  if (autorizacion.estado !== 'autorizado' || !autorizacion.autorizado_en) {
    if (autorizacion.estado === 'revocado') {
      return {
        ok: false,
        motivo: 'revocada',
        detalle: 'La autorizacion fue revocada por el titular.',
      };
    }
    return {
      ok: false,
      motivo: 'no_firmada',
      detalle: `La autorizacion existe pero no esta firmada (estado: ${autorizacion.estado}).`,
    };
  }

  // 3. No revocada. `estado` y `fecha_revocacion` se escriben juntos, pero se
  //    verifican por separado: una fila con fecha de revocacion y estado
  //    'autorizado' seria un dato roto y debe bloquear igual.
  if (autorizacion.fecha_revocacion) {
    return {
      ok: false,
      motivo: 'revocada',
      detalle: 'La autorizacion fue revocada por el titular.',
    };
  }

  // 4. PREVIA. El corazon del 8.4: si la firma es posterior al momento en que
  //    se consulta el buro, la consulta no estaba autorizada cuando ocurrio.
  const autorizadoEn = new Date(autorizacion.autorizado_en);
  if (Number.isNaN(autorizadoEn.getTime())) {
    return {
      ok: false,
      motivo: 'no_firmada',
      detalle: 'La autorizacion no tiene una fecha de aceptacion legible.',
    };
  }
  if (autorizadoEn.getTime() > contexto.momentoConsulta.getTime()) {
    return {
      ok: false,
      motivo: 'posterior_a_la_consulta',
      detalle: 'La autorizacion es posterior al momento de la consulta: no fue previa.',
    };
  }

  // 5. Vigente. vigente_hasta NULL = sin vigencia declarada = vigente (las 8
  //    autorizaciones anteriores al 2026-09-03).
  if (autorizacion.vigente_hasta) {
    const vigenteHasta = new Date(autorizacion.vigente_hasta);
    if (!Number.isNaN(vigenteHasta.getTime()) && vigenteHasta.getTime() <= contexto.momentoConsulta.getTime()) {
      return {
        ok: false,
        motivo: 'caducada',
        detalle: 'La autorizacion caduco. Hay que solicitar una nueva antes de consultar el buro.',
      };
    }
  }

  // 6. Mismo documento. Se compara el PAR (tipo, numero), no solo el numero:
  //    ambos viajan al buro y con el mismo numero un 'cc' y un 'ce' son dos
  //    titulares de datos distintos. Los dos llegan desde el body de
  //    /estudios/:id/ejecutar, asi que comparar solo el numero dejaba consultar
  //    a otra persona amparandose en una autorizacion legitima.
  //
  //    Referencia = el dato CONGELADO al firmar. Cuando falta (las 8 filas
  //    anteriores al 2026-09-03) se cae al snapshot vivo del sujeto: es peor
  //    prueba, pero deja de admitir cualquier documento.
  const documentoCongelado = normalizarDocumento(autorizacion.numero_documento_aceptante);
  const tipoCongelado = normalizarTipoDocumento(autorizacion.tipo_documento_aceptante);
  const numeroReferencia =
    documentoCongelado || normalizarDocumento(contexto.documentoSujetoActual?.numero);
  const tipoReferencia =
    tipoCongelado || normalizarTipoDocumento(contexto.documentoSujetoActual?.tipo);

  const documentoConsultado = normalizarDocumento(contexto.numeroDocumentoConsultado);
  const tipoConsultado = normalizarTipoDocumento(contexto.tipoDocumentoConsultado);

  if (numeroReferencia && documentoConsultado && numeroReferencia !== documentoConsultado) {
    return {
      ok: false,
      motivo: 'documento_distinto',
      detalle:
        'El documento que se va a consultar no coincide con el documento de quien firmo la autorizacion.',
    };
  }
  if (tipoReferencia && tipoConsultado && tipoReferencia !== tipoConsultado) {
    return {
      ok: false,
      motivo: 'documento_distinto',
      detalle:
        'El tipo de documento que se va a consultar no coincide con el de quien firmo la autorizacion.',
    };
  }

  return { ok: true, autorizacionId: autorizacion.id, documentoVerificado: !!documentoCongelado };
}

/** Mensaje accionable para el gestor, por motivo. */
const MENSAJE_POR_MOTIVO: Record<MotivoRechazoAutorizacion, string> = {
  sin_autorizacion:
    'El solicitante aun no ha autorizado la consulta en centrales de riesgo. Envie la solicitud de autorizacion antes de ejecutar el estudio.',
  no_firmada:
    'La solicitud de autorizacion fue enviada pero el solicitante todavia no la ha firmado. Espere la firma o reenvie el enlace antes de ejecutar el estudio.',
  revocada:
    'El solicitante revoco su autorizacion de tratamiento de datos. No se puede consultar centrales de riesgo: solicite una nueva autorizacion.',
  caducada:
    'La autorizacion de tratamiento de datos ya caduco. Envie una nueva solicitud de autorizacion antes de ejecutar el estudio.',
  posterior_a_la_consulta:
    'La autorizacion es posterior al momento de la consulta. La autorizacion debe ser previa (Ley 1266 de 2008): vuelva a ejecutar el estudio.',
  otro_titular:
    'La autorizacion registrada no corresponde a la persona que se va a consultar. Envie la solicitud de autorizacion a esa persona antes de ejecutar el estudio.',
  documento_distinto:
    'El documento que se va a consultar no coincide con el de quien firmo la autorizacion. Corrija el documento o solicite una nueva autorizacion a esa persona.',
};

const MENSAJE_COARRENDATARIO_SIN_AUTORIZACION =
  'El co-arrendatario invitado aun no ha autorizado la consulta en centrales de riesgo. Reenvie la invitacion para que acepte la autorizacion antes de ejecutar su estudio.';

/** Columnas de la fila que necesita el gate. */
const COLUMNAS_EVIDENCIA =
  'id, estado, autorizado_en, fecha_revocacion, vigente_hasta, numero_documento_aceptante, tipo_documento_aceptante, solicitante_id, coarrendatario_id';

/**
 * Cuantas autorizaciones del sujeto se revisan. Un expediente acumula filas
 * cuando se reenvia el enlace (las anteriores quedan 'expirado'), asi que mirar
 * solo la ultima podia esconder una firma valida detras de un reenvio.
 */
const MAX_AUTORIZACIONES_REVISADAS = 5;

interface AssertArgs {
  estudioId: string;
  expedienteId: string;
  /** `estudios.tipo`: 'individual' | 'con_coarrendatario'. */
  tipoEstudio: string;
  /** Documento efectivo que se le mandara al buro (ya con el override aplicado). */
  numeroDocumentoConsultado?: string | null;
  /** Tipo de documento efectivo que se le mandara al buro (idem). */
  tipoDocumentoConsultado?: string | null;
  /** Por defecto, ahora. Se pasa explicito para poder re-afirmar antes del fetch. */
  momentoConsulta?: Date;
}

/**
 * Lanza si no hay una autorizacion previa vigente del sujeto correcto.
 * Devuelve el id de la autorizacion que habilita la consulta, para dejarlo
 * escrito en `estudios.autorizacion_habeas_data_id`.
 */
export async function assertAutorizacionVigente(args: AssertArgs): Promise<{ autorizacionId: string }> {
  const momentoConsulta = args.momentoConsulta ?? new Date();
  const esCoarrendatario = args.tipoEstudio === 'con_coarrendatario';

  let sujeto: SujetoAutorizacion;
  // Snapshot vivo del sujeto. Respaldo del paso 6 para las autorizaciones que
  // no congelaron el documento. Se lee AQUI, antes de que ejecutarEstudio
  // llame a sincronizarDocumentoSolicitante (que reescribe
  // solicitantes.numero_documento con el documento que se va a consultar y
  // dejaria la comparacion siempre en verdadero).
  let documentoSujetoActual: { tipo?: string | null; numero?: string | null } | null = null;

  if (esCoarrendatario) {
    // El estudio 'con_coarrendatario' consulta al INVITADO, no al titular
    // (ver el salto de sincronizarDocumentoSolicitante en ejecutarEstudio).
    const COLUMNAS_COA = 'id, tipo_documento, numero_documento';
    type CoaRow = { id?: string; tipo_documento?: string | null; numero_documento?: string | null };

    const { data: coaRow } = await (supabase
      .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
      .select(COLUMNAS_COA)
      .eq('estudio_id', args.estudioId)
      .maybeSingle();

    let coa = coaRow as CoaRow | null;

    if (!coa?.id) {
      // El vinculo estudio_id se escribe justo despues de crear el estudio;
      // si aun no esta, caemos al co-arrendatario activo del expediente.
      const { data: activoRow } = await (supabase
        .from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>)
        .select(COLUMNAS_COA)
        .eq('expediente_id', args.expedienteId)
        .neq('estado', 'rechazado_invitacion')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      coa = activoRow as CoaRow | null;
    }

    if (!coa?.id) {
      throw AppError.badRequest(MENSAJE_COARRENDATARIO_SIN_AUTORIZACION, AUTORIZACION_PREVIA_ERROR_CODE, {
        motivo: 'sin_autorizacion',
        sujeto: 'coarrendatario',
      });
    }

    sujeto = { coarrendatarioId: coa.id };
    documentoSujetoActual = { tipo: coa.tipo_documento, numero: coa.numero_documento };
  } else {
    const { data: expRow } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('solicitante_id, solicitantes(tipo_documento, numero_documento)')
      .eq('id', args.expedienteId)
      .maybeSingle();

    const exp = expRow as {
      solicitante_id?: string | null;
      solicitantes?: { tipo_documento?: string | null; numero_documento?: string | null } | null;
    } | null;

    const solicitanteId = exp?.solicitante_id ?? null;
    if (!solicitanteId) {
      throw AppError.badRequest(MENSAJE_POR_MOTIVO.sin_autorizacion, AUTORIZACION_PREVIA_ERROR_CODE, {
        motivo: 'sin_autorizacion',
        sujeto: 'solicitante',
      });
    }
    sujeto = { solicitanteId };
    documentoSujetoActual = {
      tipo: exp?.solicitantes?.tipo_documento,
      numero: exp?.solicitantes?.numero_documento,
    };
  }

  // Se buscan las autorizaciones DEL SUJETO (no del expediente): asi una
  // autorizacion del titular nunca puede cubrir al co-arrendatario ni al reves.
  //
  // Se traen las ultimas, no solo la firmada: si la unica que hay esta
  // pendiente o revocada, el gestor tiene que leer ESO y no un generico "no ha
  // autorizado". Se evalua cada una y basta con que una sirva; si ninguna
  // sirve, se reporta el motivo de la mas reciente.
  const query = (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select(COLUMNAS_EVIDENCIA)
    .order('created_at', { ascending: false })
    .limit(MAX_AUTORIZACIONES_REVISADAS);

  const { data: filas, error } = await (esCoarrendatario
    ? query.eq('coarrendatario_id', sujeto.coarrendatarioId as string)
    : query.eq('solicitante_id', sujeto.solicitanteId as string).eq('expediente_id', args.expedienteId));

  if (error) {
    // Nunca dejar pasar por un fallo de lectura: sin evidencia legible no hay
    // autorizacion demostrable, y una consulta al buro es irreversible.
    logger.error(
      { error: error.message, estudioId: args.estudioId, expedienteId: args.expedienteId },
      'assertAutorizacionVigente: error leyendo la autorizacion habeas data',
    );
    throw AppError.badRequest(
      'No se pudo verificar la autorizacion de tratamiento de datos. El estudio no se ejecuta sin esa verificacion.',
      AUTORIZACION_PREVIA_ERROR_CODE,
      { motivo: 'sin_autorizacion' },
    );
  }

  const contexto: ContextoAutorizacion = {
    momentoConsulta,
    sujeto,
    numeroDocumentoConsultado: args.numeroDocumentoConsultado,
    tipoDocumentoConsultado: args.tipoDocumentoConsultado,
    documentoSujetoActual,
  };
  const candidatas = (filas ?? []) as unknown as AutorizacionEvidencia[];
  const veredictos = candidatas.map((fila) => evaluarAutorizacionPrevia(fila, contexto));
  const veredicto =
    veredictos.find((v) => v.ok) ??
    veredictos[0] ??
    evaluarAutorizacionPrevia(null, contexto);

  if (!veredicto.ok) {
    logger.warn(
      {
        estudioId: args.estudioId,
        expedienteId: args.expedienteId,
        tipoEstudio: args.tipoEstudio,
        motivo: veredicto.motivo,
        detalle: veredicto.detalle,
      },
      'Gate 8.4: consulta al buro bloqueada por falta de autorizacion previa',
    );
    const mensaje =
      esCoarrendatario && veredicto.motivo === 'sin_autorizacion'
        ? MENSAJE_COARRENDATARIO_SIN_AUTORIZACION
        : MENSAJE_POR_MOTIVO[veredicto.motivo];
    throw AppError.badRequest(mensaje, AUTORIZACION_PREVIA_ERROR_CODE, {
      motivo: veredicto.motivo,
      sujeto: esCoarrendatario ? 'coarrendatario' : 'solicitante',
    });
  }

  if (!veredicto.documentoVerificado) {
    logger.warn(
      { estudioId: args.estudioId, autorizacionId: veredicto.autorizacionId },
      'Gate 8.4: autorizacion sin numero_documento_aceptante (firmada antes del 2026-09-03) — evidencia parcial, se contrasto contra el documento vivo del sujeto',
    );
  }

  return { autorizacionId: veredicto.autorizacionId };
}

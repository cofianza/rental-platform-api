// ============================================================
// Biometria de identidad via AucoFace — Politica de Evaluacion V4.1
// ------------------------------------------------------------
// QUE PIDE LA POLITICA, literal:
//
//   Anexo A (las CINCO categorias de perfil, primera fila de cada una):
//         "Cedula de ciudadania (validada via biometria AUCO o equivalente)
//          — Obligatorio — Vigente"
//   §14   "API biometria / Registraduria no responde -> REVISION MANUAL
//          OBLIGATORIA. No aprobar automaticamente sin validacion de identidad."
//   §7    "Documento de identidad con reporte de perdida o suplantacion en
//          RNEC -> RECHAZO AUTOMATICO. Fuente: Registraduria / AUCO"
//
// Y el Flujo §12 nombra el hueco que esto cierra:
//         "Enlace reenviado a un tercero. El enlace es unico y personal [...]
//          La confirmacion de identidad y el registro del documento aceptante
//          son la defensa. Documentar este riesgo con el desarrollador."
//   Hoy esa defensa es que el prospecto teclee su cedula y reciba el OTP en el
//   celular registrado. Quien reenvie el enlace con la cedula a la mano pasa.
//   El cotejo cara-vs-documento es lo unico que lo cierra.
//
// ------------------------------------------------------------
// LA BIOMETRIA NUNCA RECHAZA. NI UNA SOLA VEZ.
//
// El unico rechazo que la Politica ata a esta fuente es el §7 —documento
// reportado como PERDIDO O SUPLANTADO en RNEC—, y AucoFace no reporta eso:
// devuelve un porcentaje de similitud y, como mucho, 'DOCUMENT_FAKE', que no
// distingue un documento falso de una foto mala de uno real. Rechazar con eso
// seria inventar la regla y, por §2 ("falla controlada [...] nunca rechaza por
// fallo tecnico"), justo lo prohibido.
//
// Todo lo que no cuadre —no coincide, Auco no responde, el prospecto no quiso
// dar la foto— termina en lo MISMO: revision manual (§14). Un humano mira.
//
// EL PROSPECTO PUEDE NEGARSE, y no es un caso borde: la foto de la cara es
// dato biometrico = SENSIBLE (Ley 1581 art. 5), y el art. 6 obliga a
// informarle que NO esta obligado a autorizar su tratamiento. Un flujo que lo
// bloquee al negarse convierte un derecho en letra muerta. Por eso 'omitida'
// es un estado de primera clase y se comporta igual que un fallo: revision
// manual, no portazo.
//
// ------------------------------------------------------------
// DOS PIEZAS, como en antecedentes.ts y reglas-duras.ts
//   - interpretarBiometria / requiereRevisionManualPorBiometria: PURAS.
//     Es lo que cubre scripts/check-biometria.ts sin red ni Supabase.
//   - validarIdentidadProspecto: habla con Auco. NUNCA lanza.
//
// LAS IMAGENES NO SE GUARDAN. Se mandan a Auco, se guarda el veredicto y el
// `code` del proceso (con el que Auco puede reproducir la evidencia si alguna
// vez se cuestiona). Guardar la selfie y la foto de la cedula en nuestra base
// multiplicaria el dano de cualquier filtracion sin agregar nada que el code
// no de. Principio de minimizacion (Ley 1581 art. 4-c).
// ============================================================

import { env } from '@/config';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { validarBiometria } from '@/lib/auco';
import type { AucoVerifaceResponse } from '@/lib/auco';
import { mapearTipoDocumentoAuco } from '@/modules/estudios/antecedentes';

// ── Vocabulario ─────────────────────────────────────────────

export type EstadoBiometria =
  /** Cotejo hecho y por encima del umbral. */
  | 'verificada'
  /** Cotejo hecho y por debajo del umbral, o Auco marco error. */
  | 'no_coincide'
  /** Auco no respondio / imagen ilegible / documento no consultable. */
  | 'no_verificada'
  /** El prospecto ejercio su derecho a no dar el dato sensible (art. 6). */
  | 'omitida'
  /** El interruptor esta apagado: no se pidio. */
  | 'desactivada';

export interface ResumenBiometria {
  fuente: 'aucoface';
  estado: EstadoBiometria;
  /** Codigo del proceso en Auco: con el se reproduce la evidencia. */
  code: string | null;
  verificado_en: string;
  /** 0-100. null cuando Auco no llego a cotejar. */
  similitud: number | null;
  umbral: number;
  /** Motivo legible cuando NO quedo 'verificada'. */
  motivo: string | null;
  /**
   * §7: el documento que Auco leyo (OCR) coincide con el que se va a
   * consultar. null = no se pudo comparar (Auco no devolvio el numero).
   */
  documento_coincide: boolean | null;
  /** Numero leido por OCR, ENMASCARADO. Nunca el completo. */
  documento_ocr_masked: string | null;
  /** Nombre leido del documento. Sirve para el cotejo manual del analista. */
  nombre_ocr: string | null;
}

function base(estado: EstadoBiometria, verificadoEn: string, motivo: string | null, umbral: number): ResumenBiometria {
  return {
    fuente: 'aucoface',
    estado,
    code: null,
    verificado_en: verificadoEn,
    similitud: null,
    umbral,
    motivo,
    documento_coincide: null,
    documento_ocr_masked: null,
    nombre_ocr: null,
  };
}

export function biometriaDesactivada(verificadoEn: string = new Date().toISOString(), umbral = 0): ResumenBiometria {
  return base('desactivada', verificadoEn, null, umbral);
}

export function biometriaOmitida(
  verificadoEn: string = new Date().toISOString(),
  umbral = 0,
): ResumenBiometria {
  return base(
    'omitida',
    verificadoEn,
    'El titular ejercio su derecho a no autorizar el tratamiento de datos biometricos (Ley 1581, art. 6).',
    umbral,
  );
}

/** La persona siguio sin cotejo (no tomo las fotos o no le funciono la camara). */
export function biometriaSinCotejo(motivo: string, umbral: number): ResumenBiometria {
  return base('no_verificada', new Date().toISOString(), motivo, umbral);
}

/** Deja los 3 ultimos digitos. Mismo criterio que el resto del modulo. */
function maskDoc(numero: string | null | undefined): string | null {
  const n = String(numero ?? '').replace(/\D/g, '');
  if (!n) return null;
  return n.length <= 3 ? '***' : `${'*'.repeat(n.length - 3)}${n.slice(-3)}`;
}

/** Compara dos documentos ignorando puntos, espacios y ceros a la izquierda. */
export function mismoDocumento(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const norm = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return null;
  return na === nb;
}

// ── Interpretacion PURA ─────────────────────────────────────

export interface EntradaInterpretacion {
  respuesta: AucoVerifaceResponse | null | undefined;
  /** El documento que el sistema tiene por bueno (solicitantes.numero_documento). */
  documentoEsperado: string | null | undefined;
  umbral: number;
  verificadoEn?: string;
}

/**
 * Traduce la respuesta de POST /veriface/validate al veredicto.
 *
 * Auco trae DOS senales y no dicen lo mismo:
 *   - `error` (raiz): su propio juicio del cotejo cara-vs-documento.
 *   - `similarity`: el porcentaje, 0-100.
 *   - `identificationCard.error` + `message`: la lectura del DOCUMENTO
 *     ('DOCUMENT_FAKE', foto borrosa, reverso en vez de anverso...).
 *
 * Se exigen las dos: `error:false` Y `similarity >= umbral`. Confiar solo en
 * `error` deja el corte en manos de Auco (que puede moverlo sin avisar) y
 * Gerencia no tendria numero que auditar; confiar solo en `similarity`
 * ignoraria que Auco vio un documento falso.
 *
 * `identificationCard.error` NO tumba por si solo cuando el cotejo paso: una
 * cedula vieja o mal iluminada puede fallar el OCR y aun asi cotejar la cara
 * bien. Se anota en el motivo y el documento queda sin comparar (null), que
 * ya de por si manda el caso a revision.
 */
export function interpretarBiometria(entrada: EntradaInterpretacion): ResumenBiometria {
  const { respuesta, documentoEsperado, umbral } = entrada;
  const verificadoEn = entrada.verificadoEn ?? new Date().toISOString();

  if (!respuesta || typeof respuesta !== 'object') {
    return base('no_verificada', verificadoEn, 'Auco no devolvio un resultado legible', umbral);
  }

  const res = base('no_verificada', verificadoEn, null, umbral);
  res.code = typeof respuesta.code === 'string' && respuesta.code.trim() !== '' ? respuesta.code : null;

  const sim = typeof respuesta.similarity === 'number' && Number.isFinite(respuesta.similarity)
    ? Math.round(respuesta.similarity * 100) / 100
    : null;
  res.similitud = sim;

  const tarjeta = respuesta.identificationCard;
  const datos = (tarjeta?.data ?? {}) as Record<string, unknown>;
  const ocrNumero = typeof datos.personalNumber === 'string' ? datos.personalNumber : null;
  const ocrNombre =
    (typeof datos.fullName === 'string' && datos.fullName) ||
    (typeof datos.name === 'string' && datos.name) ||
    null;
  res.documento_ocr_masked = maskDoc(ocrNumero);
  res.nombre_ocr = ocrNombre;
  res.documento_coincide = mismoDocumento(ocrNumero, documentoEsperado);

  const mensajeTarjeta = typeof tarjeta?.message === 'string' ? tarjeta.message : null;

  if (sim === null) {
    res.motivo = mensajeTarjeta
      ? `Auco no pudo cotejar (${mensajeTarjeta})`
      : 'Auco no devolvio el porcentaje de similitud';
    return res;
  }

  const cotejoOk = respuesta.error !== true && sim >= umbral;
  if (!cotejoOk) {
    res.estado = 'no_coincide';
    res.motivo =
      `La foto no coincide con el documento (similitud ${sim}%, minimo ${umbral}%)` +
      (mensajeTarjeta ? `. Lectura del documento: ${mensajeTarjeta}` : '');
    return res;
  }

  res.estado = 'verificada';
  // §7: el cotejo paso pero el documento leido es OTRO. No se rechaza (ver el
  // encabezado), pero es exactamente la "inconsistencia documental objetiva"
  // del §7 y no puede pasar como verificacion limpia.
  if (res.documento_coincide === false) {
    res.motivo = `El documento fotografiado (${res.documento_ocr_masked ?? 's/d'}) no es el que se va a consultar`;
  } else if (res.documento_coincide === null) {
    res.motivo = mensajeTarjeta
      ? `Cotejo correcto, pero no se pudo leer el numero del documento (${mensajeTarjeta})`
      : 'Cotejo correcto, pero Auco no devolvio el numero del documento para compararlo';
  }
  return res;
}

/**
 * §14 + Anexo A: cuando la identidad NO se puede dar por validada y por tanto
 * NO cabe aprobacion automatica. Devuelve el motivo para el gestor, o null.
 *
 * 'desactivada' -> null: el interruptor esta apagado, no se pidio la foto y
 * nada cambia respecto de como opera el sistema hoy.
 */
export function requiereRevisionManualPorBiometria(b: ResumenBiometria | null | undefined): string | null {
  if (!b || b.estado === 'desactivada') return null;

  const cola = 'No se aprueba automaticamente sin validacion de identidad (Politica §14 y Anexo A).';

  switch (b.estado) {
    case 'omitida':
      return `Revision manual obligatoria (Politica §14): el titular no autorizo la validacion biometrica, que es su derecho (Ley 1581, art. 6). ${cola}`;
    case 'no_verificada':
      return `Revision manual obligatoria (Politica §14): identidad SIN VERIFICAR — ${b.motivo ?? 'Auco no respondio'}. ${cola}`;
    case 'no_coincide':
      return `Revision manual obligatoria (Politica §14): ${b.motivo ?? 'la foto no coincide con el documento'}. ${cola}`;
    case 'verificada':
      // Cotejo bueno pero documento distinto o ilegible: §7 (inconsistencia
      // documental objetiva) — "RECHAZO o REVISION segun criterio". Revision.
      return b.documento_coincide === true
        ? null
        : `Revision manual (Politica §7): la cara coincide (similitud ${b.similitud ?? 's/d'}%), pero ${b.motivo ?? 'el documento no se pudo confirmar'}. ${cola}`;
  }
}

/** Lee lo que quedo en la columna. Tolera null, JSON viejo o basura. */
export function leerResumenBiometria(v: unknown): ResumenBiometria | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.estado !== 'string') return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    fuente: 'aucoface',
    estado: o.estado as EstadoBiometria,
    code: typeof o.code === 'string' ? o.code : null,
    verificado_en: String(o.verificado_en ?? ''),
    similitud: num(o.similitud),
    umbral: num(o.umbral) ?? 0,
    motivo: typeof o.motivo === 'string' ? o.motivo : null,
    documento_coincide: typeof o.documento_coincide === 'boolean' ? o.documento_coincide : null,
    documento_ocr_masked: typeof o.documento_ocr_masked === 'string' ? o.documento_ocr_masked : null,
    nombre_ocr: typeof o.nombre_ocr === 'string' ? o.nombre_ocr : null,
  };
}

/**
 * Veredicto guardado para un expediente.
 *
 * VIVE AQUI Y NO EN `src/modules/estudios/` A PROPOSITO: ese arbol tiene
 * prohibido nombrar `autorizacion_perfil_prospecto` —lo verifica
 * scripts/check-ingreso-declarado.ts— porque en esa misma tabla esta el
 * ingreso DECLARADO por el prospecto, que la Politica §4.2 excluye del
 * scorecard. Exponer la lectura desde aqui deja al modulo que decide sin
 * conocer la tabla, y el guard sin excepciones que erosionarlo.
 *
 * SELECT propio y tolerante: si la migracion 20260907000003 no corrio,
 * nombrar la columna reventaria el SELECT entero (42703). Aqui un fallo solo
 * devuelve null y el estudio se evalua sin biometria.
 */
export async function leerBiometriaDeExpediente(expedienteId: string): Promise<ResumenBiometria | null> {
  try {
    const { data, error } = await (supabase
      .from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
      .select('biometria')
      .eq('expediente_id', expedienteId)
      .maybeSingle();
    if (error) {
      logger.warn({ expedienteId, error: error.message }, 'Biometria: no se pudo leer el veredicto del estudio');
      return null;
    }
    return leerResumenBiometria((data as { biometria?: unknown } | null)?.biometria);
  } catch (err) {
    logger.warn({ expedienteId, err: err instanceof Error ? err.message : String(err) }, 'Biometria: excepcion leyendo el veredicto del estudio');
    return null;
  }
}

// ── Auco ────────────────────────────────────────────────────

export interface EntradaValidacion {
  /** Solo para el log; no viaja a Auco. */
  autorizacionId: string;
  /** Tipo y numero del documento contra el que se coteja. */
  tipo_documento: string | null | undefined;
  numero_documento: string | null | undefined;
  /** Base64 (data URL o crudo) de la cedula. */
  documentImage: string;
  /** Base64 (data URL o crudo) de la selfie. */
  photo: string;
}

/**
 * Autorizacion del prospecto: AucoFace con el umbral del env, si el
 * interruptor AUCO_BIOMETRIA_ENABLED esta encendido.
 */
export async function validarIdentidadProspecto(input: EntradaValidacion): Promise<ResumenBiometria> {
  const umbral = env.AUCO_BIOMETRIA_UMBRAL_SIMILITUD;
  if (!env.AUCO_BIOMETRIA_ENABLED) return biometriaDesactivada(new Date().toISOString(), umbral);
  return cotejarConAuco(input.autorizacionId, input, umbral);
}

/**
 * Llama a AucoFace y devuelve el veredicto con el umbral dado. NUNCA lanza:
 * cualquier fallo es 'no_verificada' con su motivo, y quien llama manda el
 * caso a un humano. `ref` solo va al log. Lo usan la autorizacion y la firma
 * del contrato (Adenda 2 §9, firma/verificacion-identidad.service.ts).
 */
export async function cotejarConAuco(
  ref: string,
  input: Omit<EntradaValidacion, 'autorizacionId'>,
  umbral: number,
): Promise<ResumenBiometria> {
  const ahora = new Date().toISOString();
  const tipo = mapearTipoDocumentoAuco(input.tipo_documento);
  const numero = String(input.numero_documento ?? '').trim();
  if (!tipo || !numero) {
    return base(
      'no_verificada',
      ahora,
      `Documento no consultable en Auco (tipo '${input.tipo_documento ?? ''}')`,
      umbral,
    );
  }

  try {
    const respuesta = await validarBiometria(
      {
        country: 'CO',
        type: tipo,
        identification: numero,
        documentImage: input.documentImage,
        photo: input.photo,
      },
      env.AUCO_BIOMETRIA_TIMEOUT_MS,
    );
    const resumen = interpretarBiometria({
      respuesta,
      documentoEsperado: numero,
      umbral,
      verificadoEn: new Date().toISOString(),
    });
    logger.info(
      {
        ref,
        code: resumen.code,
        estado: resumen.estado,
        similitud: resumen.similitud,
        umbral,
        documentoCoincide: resumen.documento_coincide,
      },
      'AucoFace: cotejo biometrico resuelto',
    );
    return resumen;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ ref, err: msg }, 'AucoFace: fallo el cotejo');
    return base('no_verificada', ahora, `Auco no respondio: ${msg}`, umbral);
  }
}

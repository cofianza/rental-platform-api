// ============================================================
// Antecedentes via Auco (background check) — Politica de Evaluacion V4.1
// ------------------------------------------------------------
// Que decide y que no, literal de la Politica:
//
//   §6    "Reporte en listas restrictivas (OFAC, ONU, listas Clinton) —
//          verificado via AUCO u operador integrado en tiempo real
//          -> RECHAZO AUTOMATICO". (La "lista Clinton" ES la lista SDN de la
//          OFAC: OFAC + ONU cubren las tres.)
//   §14   "API listas restrictivas no responde -> REVISION MANUAL OBLIGATORIA.
//          No aprobar automaticamente sin chequeo de listas."
//   §16.5 "Antecedentes (Policia, Procuraduria, Contraloria) via proveedor de
//          validacion. Operan exclusivamente como flag de REVISION MANUAL.
//          Nunca constituyen causal de rechazo automatico."
//   §4.4  Seguridad social: la afiliacion FOSYGA/BDUA alimenta V4 del
//          scorecard (sombra). NO es el IBC: Auco dice SI cotiza, no CUANTO.
//   §16.3 BDME (contaduria): se registra, NO puntua — "toda integracion nueva
//          se activa mediante version menor del modelo".
//
// INTERRUPTOR: AUCO_BACKGROUND_CHECK_ENABLED. OFF (default) = no se consulta a
// Auco y ninguna decision cambia. ON = la regla dura 'listas_restrictivas' y
// la revision manual del §14/§16.5 quedan ACTIVAS. Antes de encenderlo:
// scripts/test-auco-background.ts (si el modulo no esta habilitado en la
// cuenta, el §14 manda TODO aprobado a revision manual — fail-closed).
//
// DOS PIEZAS, como en reglas-duras.ts:
//   - interpretarBackgroundCheck / requiereRevisionManual: PURAS (payload de
//     Auco -> resumen -> motivo). Es lo que cubre scripts/check-antecedentes.ts.
//   - verificarAntecedentes: habla con Auco. NUNCA lanza: cualquier fallo es
//     un resumen 'no_verificado' con su motivo, y el §14 decide que hacer.
// ============================================================

import { env } from '@/config';
import { logger } from '@/lib/logger';
import { crearBackgroundCheck, obtenerBackgroundCheck } from '@/lib/auco';
import type { AucoTipoDocumento } from '@/lib/auco';

// ── Vocabulario ─────────────────────────────────────────────

export type EstadoAntecedentes = 'verificado' | 'no_verificado' | 'desactivado';

/** Lo que trae `validation.fosyga` (BDUA). Estado/regimen/tipo en MAYUSCULAS. */
export interface SeguridadSocialAuco {
  estado: string | null;        // 'ACTIVO' | 'RETIRADO' | ...
  regimen: string | null;       // 'CONTRIBUTIVO' | 'SUBSIDIADO' | 'ESPECIAL'
  tipo_afiliado: string | null; // 'COTIZANTE' | 'BENEFICIARIO' | 'CABEZA DE FAMILIA' | ...
  entidad: string | null;
}

export interface ResumenAntecedentes {
  fuente: 'auco';
  estado: EstadoAntecedentes;
  /** Codigo del proceso en Auco. Permite reconsultar el reporte y su PDF. */
  code: string | null;
  consultado_en: string;
  /** Por que quedo 'no_verificado'. null en los otros estados. */
  motivo: string | null;
  /** Regla dura §6. Lista Clinton = OFAC SDN. */
  listas_vinculantes: { ofac: boolean; onu: boolean };
  reportado_en_listas: boolean;
  /** §16.5 y §14: flags de REVISION MANUAL. Nunca rechazan. */
  flags_revision: string[];
  /**
   * Fuentes de `validation.errores` que SI importan aqui (fosyga, policia,
   * procuraduria...). Las que no alimentan ninguna decision (colpsic, jcc,
   * reputacional, offshoreleaks...) se descartan: en la sonda real fallaron 23
   * fuentes a la vez y ninguna de las que deciden.
   */
  fuentes_con_error: string[];
  /** Clasificacion de Auco: 'bajo' | 'medio' | 'alto'. */
  nivel: string | null;
  seguridad_social: SeguridadSocialAuco | null;
  registraduria_estado: string | null;
  /** §16.3 — Boletin de Deudores Morosos del Estado. Se registra, no puntua. */
  contaduria_bdme: boolean | null;
  /** `validation` de Auco sin `reputacional` (ver interpretarBackgroundCheck). */
  raw: Record<string, unknown> | null;
}

// ── Lectura tolerante (misma filosofia que motor/features.ts) ───

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
/** Auco mezcla booleanos reales con los strings "True"/"False" de los hallazgos. */
function bool(v: unknown): boolean {
  return v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}
function lleno(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : false;
}
function texto(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t.toUpperCase();
}

function base(estado: EstadoAntecedentes, consultadoEn: string, code: string | null, motivo: string | null): ResumenAntecedentes {
  return {
    fuente: 'auco',
    estado,
    code,
    consultado_en: consultadoEn,
    motivo,
    listas_vinculantes: { ofac: false, onu: false },
    reportado_en_listas: false,
    flags_revision: [],
    fuentes_con_error: [],
    nivel: null,
    seguridad_social: null,
    registraduria_estado: null,
    contaduria_bdme: null,
    raw: null,
  };
}

export function antecedentesDesactivados(consultadoEn: string = new Date().toISOString()): ResumenAntecedentes {
  return base('desactivado', consultadoEn, null, null);
}

export function antecedentesNoVerificados(
  motivo: string,
  code: string | null = null,
  consultadoEn: string = new Date().toISOString(),
): ResumenAntecedentes {
  return base('no_verificado', consultadoEn, code, motivo);
}

/** Enum `tipo_documento_id` de la base -> codigo de Auco. null = no consultable. */
export function mapearTipoDocumentoAuco(tipo: string | null | undefined): AucoTipoDocumento | null {
  switch (String(tipo ?? '').trim().toLowerCase()) {
    case 'cc': return 'CC';
    case 'ce': return 'CE';
    case 'nit': return 'NIT';
    case 'pasaporte': case 'pp': return 'PP';
    case 'ppt': return 'PPT';
    default: return null;
  }
}

// ── Fuentes de Auco que alimentan una decision ──────────────

/** §6 / §14: sin estas no hay chequeo de listas. */
const FUENTES_LISTAS: readonly string[] = ['ofac', 'ofac_nombre', 'ofac_resultados', 'lista_onu'];
/** §16.5: flag de revision manual. */
const FUENTES_ANTECEDENTES: readonly string[] = ['policia', 'procuraduria', 'contraloria', 'interpol', 'europol', 'peps', 'peps_denom', 'lista_banco_mundial'];
/** §4.4: V4. */
const FUENTES_SEGURIDAD_SOCIAL: readonly string[] = ['fosyga'];
const FUENTES_QUE_DECIDEN: readonly string[] = [...FUENTES_LISTAS, ...FUENTES_ANTECEDENTES, ...FUENTES_SEGURIDAD_SOCIAL];

// ── Interpretacion PURA ─────────────────────────────────────

/**
 * Traduce la respuesta del GET /validate/background al resumen.
 *
 *   - `ready:false` o sin `validation` -> no_verificado (el §14 decide).
 *   - alguna fuente de LISTAS en `errores` (ofac, ofac_nombre, ofac_resultados,
 *     lista_onu) -> no_verificado: sin chequeo de listas no hay aprobacion
 *     automatica (§14). `validation.error:true` por SI SOLO no basta: Auco lo
 *     enciende si CUALQUIER fuente fallo, y en la sonda real fallaron 23 de
 *     una vez (colpsic, cpbiol, reputacional...) que no deciden nada.
 *   - OFAC (cualquiera de sus tres banderas) u ONU -> reportado_en_listas.
 *   - Policia / Procuraduria / Contraloria / Interpol / Europol / Banco
 *     Mundial / PEPs / hallazgos altos / nivel alto / documento no vigente /
 *     fuentes con error -> flags_revision (NUNCA rechazo, §16.5).
 *
 * `raw` conserva el bloque `validation` como evidencia (§2 trazabilidad),
 * MENOS `reputacional`: noticias y redes sociales por coincidencia de NOMBRE,
 * que no alimentan ninguna decision y son lo mas invasivo del reporte
 * (minimizacion, Ley 1581).
 */
export function interpretarBackgroundCheck(
  respuesta: unknown,
  code: string | null,
  consultadoEn: string = new Date().toISOString(),
): ResumenAntecedentes {
  const r = obj(respuesta);
  if (!r) return antecedentesNoVerificados('respuesta de Auco ilegible', code, consultadoEn);
  if (r.ready !== true) {
    return antecedentesNoVerificados('Auco no termino la validacion dentro del presupuesto', code, consultadoEn);
  }
  const v = obj(r.validation);
  if (!v) return antecedentesNoVerificados('respuesta de Auco sin bloque validation', code, consultadoEn);

  const errores = Array.isArray(v.errores) ? v.errores.map((e) => String(e).trim().toLowerCase()) : [];
  const listasConError = errores.filter((e) => FUENTES_LISTAS.includes(e));
  if (listasConError.length > 0) {
    return antecedentesNoVerificados(
      `Auco no pudo consultar las listas restrictivas (${listasConError.join(', ')})`,
      code,
      consultadoEn,
    );
  }
  // Sin listas y sin ninguna bandera: Auco no consulto nada util (p. ej. un
  // documento que Registraduria no resuelve). No se puede afirmar "sin reporte".
  if (bool(v.error) && !('ofac' in v) && !('lista_onu' in v)) {
    return antecedentesNoVerificados('Auco reporto error y no devolvio las listas', code, consultadoEn);
  }

  const res = base('verificado', consultadoEn, code, null);
  res.fuentes_con_error = errores.filter((e) => FUENTES_QUE_DECIDEN.includes(e));

  // Regla dura §6 — solo lo que la Politica nombra.
  res.listas_vinculantes = {
    ofac: bool(v.ofac) || bool(v.ofac_nombre) || bool(v.ofac_resultados),
    onu: bool(v.lista_onu),
  };
  res.reportado_en_listas = res.listas_vinculantes.ofac || res.listas_vinculantes.onu;

  // Flags §16.5 / §14 — revision manual, nunca rechazo.
  const flags: string[] = [];
  if (bool(v.policia)) flags.push('policia');
  if (lleno(v.procuraduria)) flags.push('procuraduria');
  if (bool(v.contraloria)) flags.push('contraloria');
  if (bool(v.interpol)) flags.push('interpol');
  if (lleno(v.europol)) flags.push('europol');
  const bm = obj(v.lista_banco_mundial);
  if (bm && (lleno(bm.debarred_firms_individuals) || lleno(bm.others_sanctions))) flags.push('banco_mundial');
  if (lleno(v.peps) || lleno(v.peps_denom)) flags.push('peps');
  const hallazgos = obj(v.hallazgos);
  if (hallazgos && lleno(hallazgos.altos)) flags.push('hallazgos_altos');
  res.nivel = typeof v.nivel === 'string' ? v.nivel.trim().toLowerCase() || null : null;
  if (res.nivel === 'alto') flags.push('nivel_alto');
  const reg = obj(v.registraduria);
  res.registraduria_estado = texto(reg?.estado);
  // Decision de Gerencia (Mario, 2026-09-09): "sin informacion de la
  // Registraduria no podemos seguir, el estudio debe quedar pendiente para
  // poderlo revisar". Antes, una respuesta sin estado no producia nada y el
  // estudio podia aprobarse solo sin haber confirmado que la cedula existe.
  // Igual que el resto del §16.5: revision manual, nunca rechazo automatico.
  if (!res.registraduria_estado) flags.push('registraduria_sin_informacion');
  else if (res.registraduria_estado !== 'VIGENTE') flags.push('documento_no_vigente');
  const def = obj(v.defuncion);
  const vigenciaDef = texto(def?.validity);
  if (vigenciaDef && !vigenciaDef.includes('VIVO')) flags.push('defuncion');
  // §16.5: si fallo una de SUS fuentes (policia, procuraduria...) no se puede
  // afirmar que no hay antecedentes -> flag, igual que un hallazgo.
  if (res.fuentes_con_error.some((e) => FUENTES_ANTECEDENTES.includes(e))) flags.push('fuentes_con_error');
  res.flags_revision = flags;

  // §4.4 — afiliacion (BDUA). Sin registro = objeto vacio o ausente.
  const fosyga = obj(v.fosyga);
  const ssEstado = texto(fosyga?.estado);
  res.seguridad_social = fosyga && Object.keys(fosyga).length > 0
    ? {
        estado: ssEstado,
        regimen: texto(fosyga.regimen),
        tipo_afiliado: texto(fosyga.tipo_afiliado),
        entidad: typeof fosyga.entidad === 'string' ? fosyga.entidad : null,
      }
    : null;

  res.contaduria_bdme = typeof v.contaduria === 'boolean' ? v.contaduria : null;

  const { reputacional: _omitido, ...resto } = v;
  void _omitido;
  res.raw = resto;
  return res;
}

/**
 * §14 + §16.5: cuando el resultado NO puede aprobarse automaticamente aunque
 * el buro haya dicho 'aprobado'. Devuelve el motivo para el gestor, o null.
 *
 *   - 'desactivado' / sin resumen -> null: el interruptor esta apagado y no se
 *     cambia nada (no es una falla de API: no se consulto).
 *   - 'no_verificado' -> §14, obligatoria.
 *   - flags -> §16.5.
 */
export function requiereRevisionManual(a: ResumenAntecedentes | null | undefined): string | null {
  if (!a || a.estado === 'desactivado') return null;
  if (a.estado === 'no_verificado') {
    return (
      `Revision manual obligatoria (Politica §14): listas restrictivas SIN VERIFICAR — ${a.motivo ?? 'Auco no respondio'}. ` +
      'No se aprueba automaticamente sin chequeo de listas.'
    );
  }
  if (a.flags_revision.includes('registraduria_sin_informacion')) {
    return (
      'Revision manual: la Registraduria no entrego informacion de la cedula, asi que no se pudo ' +
      'confirmar que el documento exista y este vigente. Decision de Gerencia (2026-09-09): el estudio ' +
      'queda pendiente hasta que un analista lo revise.' +
      (a.flags_revision.length > 1
        ? ` El background check reporta ademas: ${a.flags_revision.filter((f) => f !== 'registraduria_sin_informacion').join(', ')}.`
        : '')
    );
  }
  if (a.flags_revision.length > 0) {
    return (
      `Revision manual (Politica §16.5): el background check de Auco reporta ${a.flags_revision.join(', ')}. ` +
      'No es causal de rechazo automatico: un analista debe revisar el reporte.'
    );
  }
  return null;
}

/** Lee lo que quedo en `estudios.antecedentes`. Tolera null, JSON viejo o basura. */
export function leerResumenAntecedentes(v: unknown): ResumenAntecedentes | null {
  const o = obj(v);
  if (!o || typeof o.estado !== 'string') return null;
  const lv = obj(o.listas_vinculantes);
  return {
    ...base(o.estado as EstadoAntecedentes, String(o.consultado_en ?? ''), typeof o.code === 'string' ? o.code : null, typeof o.motivo === 'string' ? o.motivo : null),
    listas_vinculantes: { ofac: bool(lv?.ofac), onu: bool(lv?.onu) },
    reportado_en_listas: bool(o.reportado_en_listas),
    flags_revision: Array.isArray(o.flags_revision) ? o.flags_revision.map(String) : [],
    fuentes_con_error: Array.isArray(o.fuentes_con_error) ? o.fuentes_con_error.map(String) : [],
    nivel: typeof o.nivel === 'string' ? o.nivel : null,
    seguridad_social: (obj(o.seguridad_social) as SeguridadSocialAuco | null) ?? null,
    registraduria_estado: typeof o.registraduria_estado === 'string' ? o.registraduria_estado : null,
    contaduria_bdme: typeof o.contaduria_bdme === 'boolean' ? o.contaduria_bdme : null,
    raw: obj(o.raw),
  };
}

// ── Auco ────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Sonda real (2026-09-07, api.auco.ai): 56 s hasta ready. 3 s entre GETs.
const INTERVALO_SONDEO_MS = 3000;

export interface EntradaVerificacion {
  estudioId: string;
  tipo_documento: string | null | undefined;
  numero_documento: string;
  /** Solo lo exige Auco para pasaporte (PP). */
  nombre_completo?: string | null;
}

/**
 * POST + sondeo del GET hasta `ready` o hasta agotar el presupuesto. NUNCA
 * lanza. Se dispara ANTES de llamar al buro para que las dos esperas se
 * solapen (ver procesarEstudioAsync).
 */
export async function verificarAntecedentes(
  input: EntradaVerificacion,
  opts: { budgetMs?: number } = {},
): Promise<ResumenAntecedentes> {
  const ahora = new Date().toISOString();
  if (!env.AUCO_BACKGROUND_CHECK_ENABLED) return antecedentesDesactivados(ahora);

  const tipo = mapearTipoDocumentoAuco(input.tipo_documento);
  if (!tipo) {
    return antecedentesNoVerificados(
      `tipo de documento '${input.tipo_documento ?? ''}' no consultable en Auco`,
      null,
      ahora,
    );
  }
  const numero = input.numero_documento.trim();
  if (!numero) return antecedentesNoVerificados('sin numero de documento', null, ahora);

  const budget = opts.budgetMs ?? env.AUCO_BACKGROUND_TIMEOUT_MS;
  const porLlamada = env.BURO_REQUEST_TIMEOUT_MS;
  const inicio = Date.now();
  let code: string | null = null;

  try {
    const creado = await crearBackgroundCheck(
      {
        type: tipo,
        identification: numero,
        ...(tipo === 'PP' || tipo === 'INT' ? { name: input.nombre_completo ?? undefined } : {}),
      },
      porLlamada,
    );
    code = creado.code;
    logger.info({ estudioId: input.estudioId, code, tipo }, 'Auco background check creado');

    while (Date.now() - inicio < budget) {
      const resp = await obtenerBackgroundCheck(code, porLlamada);
      if (resp?.ready === true) {
        const resumen = interpretarBackgroundCheck(resp, code, new Date().toISOString());
        logger.info(
          {
            estudioId: input.estudioId,
            code,
            estado: resumen.estado,
            reportado: resumen.reportado_en_listas,
            flags: resumen.flags_revision,
            nivel: resumen.nivel,
            ms: Date.now() - inicio,
          },
          'Auco background check listo',
        );
        return resumen;
      }
      const restante = budget - (Date.now() - inicio);
      if (restante <= 0) break;
      await sleep(Math.min(INTERVALO_SONDEO_MS, restante));
    }
    logger.warn({ estudioId: input.estudioId, code, budget }, 'Auco background check: sin resultado dentro del presupuesto');
    return antecedentesNoVerificados(`Auco no entrego el resultado en ${budget} ms`, code, ahora);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ estudioId: input.estudioId, code, err: msg }, 'Auco background check fallo');
    return antecedentesNoVerificados(`Auco no respondio: ${msg}`, code, ahora);
  }
}

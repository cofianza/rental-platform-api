/**
 * Check del background check de Auco (Politica V4.1 §6, §14, §16.5, §4.4).
 *
 * Es el tercer punto del sistema donde el motor deja de medir y DECIDE: una
 * lectura equivocada del JSON de Auco rechaza a alguien que no esta en ninguna
 * lista, o aprueba en automatico a alguien reportado. Y los dos errores son
 * silenciosos: el estudio sale con un `resultado` valido — solo que el
 * equivocado.
 *
 * Lo que se recorre, todo PURO (sin Supabase, sin Auco):
 *   1. interpretarBackgroundCheck sobre la respuesta de EJEMPLO de la
 *      documentacion de Auco (sin reporte), sobre un hit OFAC, un hit ONU, un
 *      'ready:false', un error y basura.
 *   2. El motor: V4 solo desde la central (Adenda §1.2), la regla dura global y la decision.
 *   3. aplicarReglasDuras + los textos: el gestor ve la lista; el prospecto
 *      NUNCA ve "OFAC", "lista", "Auco" ni "rechazado" (§2, §13).
 *   4. requiereRevisionManual: 'no_verificado' -> obligatoria (§14); flags ->
 *      §16.5; 'desactivado' -> nada.
 *   5. El roundtrip del marcador en motivo_rechazo (respaldo sin columna).
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-antecedentes.ts
 */

import assert from 'node:assert';

for (const [k, v] of Object.entries({
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'x',
  SUPABASE_SERVICE_ROLE_KEY: 'x',
  SUPABASE_JWT_SECRET: 'x',
  RESEND_API_KEY: 'x',
  AUCO_SENDER_EMAIL: 'qa@cofianza.co',
})) {
  if (!process.env[k]) process.env[k] = v;
}

import {
  interpretarBackgroundCheck,
  requiereRevisionManual,
  leerResumenAntecedentes,
  mapearTipoDocumentoAuco,
  antecedentesDesactivados,
  antecedentesNoVerificados,
} from '@/modules/estudios/antecedentes';
import type { ResumenAntecedentes } from '@/modules/estudios/antecedentes';
import { evaluarSombra, MODELO_VERSION } from '@/modules/estudios/motor';
import { V4_PUNTOS_AFILIADO_ACTIVO, V4_PUNTOS_BENEFICIARIO, type VinculacionCentral } from '@/modules/estudios/motor/scorecard';
import { construirFilaSombra } from '@/modules/estudios/motor/fila';
import {
  REGLAS_DURAS_ACTIVAS,
  aplicarReglasDuras,
  inferirReglasDurasDesdeMotivo,
  motivoParaProspectoDesdeMotivoGestor,
} from '@/modules/estudios/reglas-duras';

const HOY = '2026-09-07T12:00:00.000Z';
let pasos = 0;
function ok(cond: boolean, msg: string): void {
  assert.ok(cond, msg);
  pasos++;
}

// ── 1. Respuesta de ejemplo de la documentacion de Auco (sin reporte) ──
function respuestaAuco(overrides: Record<string, unknown> = {}, ready = true): Record<string, unknown> {
  return {
    code: 'XXXXXXXXX',
    ready,
    validation: {
      contaduria: false,
      contraloria: false,
      defuncion: { validity: 'Vigente (Vivo)' },
      hallazgos: { altos: [], bajos: [{ codigo: 'sigep', coincidencia: 'True' }], infos: [], medios: [] },
      nivel: 'bajo',
      interpol: false,
      ofac: false,
      policia: false,
      registraduria: { cedula: '1001001010', estado: 'VIGENTE' },
      error: false,
      errores: [],
      fosyga: { estado: 'ACTIVO', regimen: 'CONTRIBUTIVO', tipo_afiliado: 'COTIZANTE', entidad: 'EPS SURAMERICANA S.A.' },
      lista_onu: false,
      lista_banco_mundial: { debarred_firms_individuals: [], others_sanctions: [] },
      europol: [],
      ofac_nombre: false,
      ofac_resultados: false,
      peps: [],
      peps_denom: [],
      procuraduria: [],
      reputacional: { news: [{ title: 'noticia por nombre' }], social: [] },
      ...overrides,
    },
  };
}

const limpio = interpretarBackgroundCheck(respuestaAuco(), 'XXXXXXXXX', HOY);
ok(limpio.estado === 'verificado', 'ejemplo de Auco -> verificado');
ok(!limpio.reportado_en_listas, 'ejemplo de Auco -> sin reporte en listas');
ok(limpio.flags_revision.length === 0, `ejemplo de Auco -> sin flags (${limpio.flags_revision.join(',')})`);
ok(limpio.seguridad_social?.estado === 'ACTIVO' && limpio.seguridad_social.tipo_afiliado === 'COTIZANTE', 'FOSYGA leido');
ok(limpio.registraduria_estado === 'VIGENTE', 'registraduria leida');
ok(limpio.contaduria_bdme === false, 'BDME leido (se registra, no puntua)');
ok(limpio.raw !== null && !('reputacional' in limpio.raw) && 'ofac' in limpio.raw, 'raw conserva la evidencia y descarta reputacional');
ok(limpio.code === 'XXXXXXXXX' && limpio.consultado_en === HOY, 'code y fecha');

const ofac = interpretarBackgroundCheck(respuestaAuco({ ofac_resultados: true, nivel: 'alto', hallazgos: { altos: [{ codigo: 'ofac' }], bajos: [], infos: [], medios: [] } }), 'C1', HOY);
ok(ofac.reportado_en_listas && ofac.listas_vinculantes.ofac && !ofac.listas_vinculantes.onu, 'cualquiera de las 3 banderas OFAC = reportado');
ok(ofac.flags_revision.includes('nivel_alto') && ofac.flags_revision.includes('hallazgos_altos'), 'nivel alto y hallazgos altos son flags');

const onu = interpretarBackgroundCheck(respuestaAuco({ lista_onu: true }), 'C2', HOY);
ok(onu.reportado_en_listas && onu.listas_vinculantes.onu, 'ONU = reportado');

// §16.5: antecedentes son FLAG, no reporte.
const policia = interpretarBackgroundCheck(respuestaAuco({ policia: true, procuraduria: [{ x: 1 }], interpol: true, peps: [{}] }), 'C3', HOY);
ok(!policia.reportado_en_listas, 'policia/procuraduria/interpol/peps NO son reporte en listas');
ok(['policia', 'procuraduria', 'interpol', 'peps'].every((f) => policia.flags_revision.includes(f)), `flags §16.5: ${policia.flags_revision.join(',')}`);

const noVigente = interpretarBackgroundCheck(respuestaAuco({ registraduria: { estado: 'CANCELADA POR MUERTE' }, defuncion: { validity: 'Fallecido' }, error: true, errores: ['policia'] }), 'C4', HOY);
ok(['documento_no_vigente', 'defuncion', 'fuentes_con_error'].every((f) => noVigente.flags_revision.includes(f)), 'documento no vigente, defuncion y policia con error son flags');
ok(noVigente.estado === 'verificado' && noVigente.fuentes_con_error.join() === 'policia', 'un error en policia no invalida las listas (§16.5 = flag)');

// Decision de Gerencia (Mario, 2026-09-09): sin informacion de la Registraduria
// el estudio NO sigue solo — queda pendiente de revision manual.
const sinRegistraduria = interpretarBackgroundCheck(respuestaAuco({ registraduria: {} }), 'C4b', HOY);
ok(sinRegistraduria.flags_revision.includes('registraduria_sin_informacion'), 'Registraduria sin estado -> flag de revision');
ok((requiereRevisionManual(sinRegistraduria) ?? '').includes('Registraduria'), 'Registraduria sin dato -> revision manual con motivo propio');
ok(requiereRevisionManual(limpio) === null, 'Registraduria VIGENTE -> sigue sin revision manual');

const pendiente = interpretarBackgroundCheck(respuestaAuco({}, false), 'C5', HOY);
ok(pendiente.estado === 'no_verificado' && pendiente.code === 'C5', 'ready:false -> no_verificado con code');
// Lo que devolvio la sonda real del 2026-09-07 con la cedula de ejemplo: 23
// fuentes en `errores`, entre ellas lista_onu y ofac_nombre.
const sondaReal = interpretarBackgroundCheck(respuestaAuco({ error: true, errores: ['contaduria', 'fosyga', 'rut', 'ofac_nombre', 'insolvencias', 'sigep', 'interpol', 'reputacional', 'lista_onu', 'europol', 'colpsic', 'jcc', 'anec', 'cpbiol'] }), 'C6', HOY);
ok(sondaReal.estado === 'no_verificado' && (sondaReal.motivo ?? '').includes('lista_onu') && (sondaReal.motivo ?? '').includes('ofac_nombre'), 'listas en errores -> no_verificado (§14) nombrando cuales');
const ruidoIrrelevante = interpretarBackgroundCheck(respuestaAuco({ error: true, errores: ['colpsic', 'jcc', 'anec', 'cpbiol', 'reputacional', 'offshoreleaks'] }), 'C6b', HOY);
ok(ruidoIrrelevante.estado === 'verificado' && ruidoIrrelevante.flags_revision.length === 0 && ruidoIrrelevante.fuentes_con_error.length === 0, 'error:true por fuentes irrelevantes NO manda a revision');
const sinListas = interpretarBackgroundCheck({ code: 'x', ready: true, validation: { error: true, errores: [] } }, 'C6c', HOY);
ok(sinListas.estado === 'no_verificado', 'error:true sin bloque de listas -> no_verificado');
const fosygaCaido = interpretarBackgroundCheck(respuestaAuco({ error: true, errores: ['fosyga'] }), 'C6d', HOY);
ok(fosygaCaido.estado === 'verificado' && fosygaCaido.fuentes_con_error.join() === 'fosyga' && fosygaCaido.flags_revision.length === 0, 'fosyga con error: verificado, sin flag, V4 no calculable');
for (const basura of [null, undefined, 'x', 42, [], {}, { ready: true }, { ready: true, validation: 'no' }]) {
  const r = interpretarBackgroundCheck(basura, null, HOY);
  ok(r.estado === 'no_verificado' && !r.reportado_en_listas, `basura ${JSON.stringify(basura)} -> no_verificado, nunca reportado`);
}
const sinFosyga = interpretarBackgroundCheck(respuestaAuco({ fosyga: {} }), 'C7', HOY);
ok(sinFosyga.estado === 'verificado' && sinFosyga.seguridad_social === null, 'fosyga vacio = sin registro');

// mapeo de documento
ok(mapearTipoDocumentoAuco('cc') === 'CC' && mapearTipoDocumentoAuco('CE') === 'CE' && mapearTipoDocumentoAuco('pasaporte') === 'PP' && mapearTipoDocumentoAuco('nit') === 'NIT', 'mapeo enum -> Auco');
ok(mapearTipoDocumentoAuco('ti') === null && mapearTipoDocumentoAuco('') === null && mapearTipoDocumentoAuco(undefined) === null, 'TI / vacio no se consultan');

// roundtrip por la columna
const releido = leerResumenAntecedentes(JSON.parse(JSON.stringify(ofac)));
ok(releido?.estado === 'verificado' && releido.reportado_en_listas && releido.listas_vinculantes.ofac, 'leerResumenAntecedentes reconstruye el resumen');
ok(leerResumenAntecedentes(null) === null && leerResumenAntecedentes({}) === null && leerResumenAntecedentes('x') === null, 'columna vacia/basura -> null');

// ── 2. Motor: V4 y regla global ────────────────────────────
function payloadDC(score = 850): Record<string, unknown> {
  return {
    ReportHDCplus: {
      report: {
        consultDate: '2026-09-01',
        scores: [{ scoreType: 'DF', scoreCode: 'DF', score }],
        creditVision: [],
        agregatedInfo: [{ salariosFuente: 3000, cuotaMensual: 300 }],
        liabilities: [],
      },
    },
  };
}
function v4(a: ResumenAntecedentes | null, vinculacion: VinculacionCentral | null = null) {
  const s = evaluarSombra({ proveedor: 'datacredito', payload: payloadDC(), canon_mensual_cop: 900_000, fecha_evaluacion: HOY, antecedentes: a, vinculacion_central: vinculacion });
  const p = s.puntajes.find((x) => x.variable === 'V4')!;
  return { s, p };
}
// Adenda §1.2: V4 sale de la CENTRAL, no de Auco. Sin vinculacion reportada por
// la central, V4 queda fuera de la ponderacion, haya o no background check.
ok(v4(null).p.estado === 'no_calculable' && v4(limpio).p.estado === 'no_calculable', 'sin vinculacion de la central -> V4 no calculable, con o sin Auco');
ok(v4(limpio).s.variables_no_calculables.includes('V4'), 'V4 figura entre las no calculables');
ok(v4(limpio).s.puntaje_bruto_alcanzable === v4(null).s.puntaje_bruto_alcanzable, 'Auco ya no mueve el techo alcanzable');
const cotizante = v4(limpio, { estado: 'cotizante', fuente: 'datacredito' });
ok(cotizante.p.puntos === V4_PUNTOS_AFILIADO_ACTIVO, 'central: cotizante -> 5 (tope sin pension)');
ok(v4(limpio, { estado: 'beneficiario', fuente: 'datacredito' }).p.puntos === V4_PUNTOS_BENEFICIARIO, 'central: beneficiario -> 3');
const inactiva = v4(limpio, { estado: 'inactiva', fuente: 'transunion' });
ok(inactiva.p.puntos === 0 && inactiva.p.estado === 'calculada', 'central: inactiva -> 0 (calculada, no null)');
ok(cotizante.s.puntaje_bruto_alcanzable === v4(null).s.puntaje_bruto_alcanzable + 8, 'con vinculacion de la central el techo sube los 8 de V4');
ok(v4(limpio).s.antecedentes !== null && !('raw' in (v4(limpio).s.antecedentes as object)), 'la salida ecoa antecedentes sin raw');

const conHit = v4(ofac).s;
ok(conHit.decision_sombra === 'rechazado', 'OFAC -> decision sombra rechazado');
ok(conHit.reglas_duras.some((r) => r.codigo === 'listas_restrictivas' && r.variable === 'global'), 'regla global en reglas_duras');
const sinReglaListas = (a: ResumenAntecedentes) => !v4(a).s.reglas_duras.some((r) => r.codigo === 'listas_restrictivas');
ok(sinReglaListas(noVigente) && v4(noVigente).s.decision_sombra === v4(limpio).s.decision_sombra, 'flags §16.5 NO disparan la regla global en el motor');
ok(sinReglaListas(antecedentesNoVerificados('t', 'C', HOY)), 'no_verificado NO es un hit');
const fila = construirFilaSombra('e1', conHit) as Record<string, unknown>;
ok((fila.reglas_duras_activadas as string[]).includes('listas_restrictivas'), 'la fila sombra lleva el codigo');
ok(JSON.stringify(fila.features_crudas).includes('"antecedentes"') && !JSON.stringify(fila.features_crudas).includes('"raw"'), 'features_crudas lleva el resumen sin raw');
ok(MODELO_VERSION === 'v4.1-adenda1-6var' && MODELO_VERSION.length <= 20, 'version del modelo actualizada (Adenda 1, V4 con fuente)');

// ── 3. Decision real + textos ───────────────────────────────
ok((REGLAS_DURAS_ACTIVAS as readonly string[]).includes('listas_restrictivas'), 'listas_restrictivas esta en la lista blanca');
const v = aplicarReglasDuras({ resultadoPropuesto: 'aprobado', salida: conHit });
ok(v.rechaza && v.resultadoFinal === 'rechazado' && v.cambiaResultado, 'aprobado del buro + OFAC -> rechazado');
if (v.rechaza) {
  ok(v.reglas.includes('listas_restrictivas'), 'la regla que decidio');
  ok(v.motivoGestor.includes('OFAC') && v.motivoGestor.includes('C1') && v.motivoGestor.includes('§6'), 'el gestor ve la lista, el proceso y la seccion');
  const p = v.motivoProspecto.toLowerCase();
  for (const prohibida of ['ofac', 'onu', 'lista', 'auco', 'rechaz', 'clinton', 'sarlaft']) {
    ok(!p.includes(prohibida), `el prospecto no lee "${prohibida}"`);
  }
  ok(p.startsWith('no aprobable por ahora'), 'lenguaje del §10 para el prospecto');
  ok(inferirReglasDurasDesdeMotivo(v.motivoGestor).includes('listas_restrictivas'), 'roundtrip por el marcador de motivo_rechazo');
  ok((motivoParaProspectoDesdeMotivoGestor(v.motivoGestor) ?? '').startsWith('No aprobable'), 'redaccion para el prospecto desde el motivo del gestor');
}
const sinHit = aplicarReglasDuras({ resultadoPropuesto: 'aprobado', salida: v4(limpio).s });
ok(!sinHit.rechaza && sinHit.resultadoFinal === 'aprobado', 'sin reporte -> el aprobado del buro se respeta');
ok(!aplicarReglasDuras({ resultadoPropuesto: 'aprobado', salida: v4(noVigente).s }).rechaza, 'flags §16.5 no rechazan en la decision real');

// ── 4. §14 / §16.5 ──────────────────────────────────────────
ok(requiereRevisionManual(null) === null && requiereRevisionManual(antecedentesDesactivados(HOY)) === null, 'apagado -> no cambia nada');
ok((requiereRevisionManual(antecedentesNoVerificados('Auco no respondio', 'C', HOY)) ?? '').includes('§14'), 'no_verificado -> revision obligatoria §14');
ok((requiereRevisionManual(policia) ?? '').includes('§16.5') && (requiereRevisionManual(policia) ?? '').includes('policia'), 'flags -> revision §16.5 con los flags');
ok(requiereRevisionManual(limpio) === null, 'verificado y limpio -> aprobacion automatica posible');
ok(requiereRevisionManual(ofac) !== null, 'un hit tambien lleva flags (nivel alto): la regla dura manda antes');

console.log(`\nOK — ${pasos} aserciones: Auco decide lo que la Politica dice (§6 rechaza OFAC/ONU; §14 y §16.5 revisan; V4 solo desde la central, Adenda §1.2).`);

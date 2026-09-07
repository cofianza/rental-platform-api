/**
 * Matriz de casos de la decision con el scorecard — Adenda 1 §2 y §3, con la
 * Politica §3.1 y §10 (casos A-G).
 *
 * La Adenda §11 lo exige: "Antes de aplicar cualquier cambio de parametro en
 * produccion, debe ejecutarse la matriz de casos de prueba completa y
 * verificarse que ningun caso critico cambie de resultado de forma no
 * intencional." Este es ese check. Corre sobre las funciones PURAS de
 * decision.ts, con corridas del motor sinteticas: aqui se prueba la DECISION,
 * no el extractor (eso es check-scorecard.ts).
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-decision-adenda.ts
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

import { decidirCascada, decidirResultado, type UmbralesDecision } from '@/modules/estudios/decision';
import type { SalidaSombra, DecisionSombra } from '@/modules/estudios/motor';
import { CALIBRACION_DEFAULT } from '@/lib/calibracion';

const U: UmbralesDecision = {
  cascadaRechazo: CALIBRACION_DEFAULT.UMBRAL_CASCADA_RECHAZO,
  cascadaAprobacion: CALIBRACION_DEFAULT.UMBRAL_CASCADA_APROBACION,
  aprobacion: CALIBRACION_DEFAULT.UMBRAL_APROBACION_AUTOMATICA,
  zonaGris: CALIBRACION_DEFAULT.UMBRAL_ZONA_GRIS,
  coarrendatario: CALIBRACION_DEFAULT.UMBRAL_COARRENDATARIO,
};

/** Corrida sintetica: solo lo que la decision lee. */
function salida(o: { puntaje: number | null; decision?: DecisionSombra; motivo?: string; inconsistencia?: boolean; obligatoria?: string | null }): SalidaSombra {
  const decision: DecisionSombra =
    o.decision ?? (o.puntaje === null ? 'no_calculable' : o.puntaje >= U.aprobacion ? 'aprobado' : o.puntaje >= U.zonaGris ? 'revision_manual' : 'rechazado');
  return {
    puntaje_normalizado: o.puntaje,
    decision_sombra: decision,
    decision_motivo: o.motivo ?? `sintetico ${o.puntaje}`,
    motivo_no_calculable: decision === 'no_calculable' ? (o.motivo ?? 'sin variables') : null,
    inconsistencia_score_buros: o.inconsistencia ?? false,
    revision_obligatoria: o.obligatoria ?? null,
    reglas_duras: [],
  } as unknown as SalidaSombra;
}

let pasos = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); pasos++; };
const sinFlags = { u: U, motivosRevision: [] as string[], reglasDurasActivas: [] as string[] };

console.log('\nAdenda §2.1 — cascada sobre la central primaria');

ok(decidirCascada(salida({ puntaje: 97 }), ['dti_mayor_65'], U).resultadoAnticipado === 'rechazado', 'regla dura con la primaria -> rechazado');
ok(decidirCascada(salida({ puntaje: 97 }), ['dti_mayor_65'], U).consultarSecundaria === false, '  ...y NO se consulta la segunda (Paso 2)');
ok(decidirCascada(salida({ puntaje: 39.99 }), [], U).resultadoAnticipado === 'rechazado', '39.99 < 40 -> rechazado sin segunda consulta');
ok(decidirCascada(salida({ puntaje: 40 }), [], U).consultarSecundaria === true, '40 -> se consulta la segunda');
ok(decidirCascada(salida({ puntaje: 89.99 }), [], U).consultarSecundaria === true, '89.99 -> se consulta la segunda');
ok(decidirCascada(salida({ puntaje: 90 }), [], U).resultadoAnticipado === 'aprobado', '90 -> aprobado sin segunda consulta (asuncion de riesgo §2.2)');
ok(decidirCascada(salida({ puntaje: 90 }), [], U).consultarSecundaria === false, '  ...sin consultar TransUnion');
ok(decidirCascada(salida({ puntaje: null }), [], U).consultarSecundaria === true, 'primaria sin puntaje -> se consulta la otra (Politica §4.1, no-hit no rechaza)');
ok(decidirCascada(salida({ puntaje: null }), [], U).resultadoAnticipado === null, '  ...y no se anticipa nada');

console.log('\nPolitica §10 — casos de referencia');

// A: ~97, ninguna regla dura -> APROBADO AUTOMATICO
const A = decidirResultado({ ...sinFlags, salida: salida({ puntaje: 97 }) });
ok(A.resultado === 'aprobado' && A.via === 'automatica', 'A: 97 -> aprobado automatico');

// B: ~74, zona gris sin coarrendatario -> REVISION MANUAL
const B = decidirResultado({ ...sinFlags, salida: salida({ puntaje: 74 }) });
ok(B.resultado === 'condicionado' && B.via === 'revision_manual', 'B: 74 sin coarrendatario -> revision manual');

// C: mora vigente (regla dura) -> RECHAZO, el puntaje no cuenta
const C = decidirResultado({ ...sinFlags, salida: salida({ puntaje: 95 }), reglasDurasActivas: ['mora_vigente'] });
ok(C.resultado === 'rechazado' && C.via === null, 'C: regla dura -> rechazado aunque el puntaje sea 95');

// D: ~52 con score 480 -> JERARQUIA: revision manual, no rechazo
const D = decidirResultado({ ...sinFlags, salida: salida({ puntaje: 52, decision: 'revision_manual', obligatoria: 'Score externo 480 en la banda de revision manual obligatoria (450-599, Politica §3.1)' }) });
ok(D.resultado === 'condicionado' && D.motivo.includes('480'), 'D: score 450-599 fuerza revision manual sobre el <70');
ok(decidirResultado({ ...sinFlags, salida: salida({ puntaje: 75, obligatoria: 'Score externo 500 en la banda de revision manual obligatoria (450-599, Politica §3.1)' }), coarrendatario: { puntaje: 95, reglaDura: false } }).resultado === 'condicionado', 'la revision OBLIGATORIA no la levanta ni un coarrendatario de 95');

// E: ~88 -> APROBADO AUTOMATICO
const E = decidirResultado({ ...sinFlags, salida: salida({ puntaje: 88 }) });
ok(E.resultado === 'aprobado', 'E: 88 -> aprobado automatico');
ok(decidirCascada(salida({ puntaje: 88 }), [], U).consultarSecundaria === true, 'E: 88 esta en 40-89, asi que antes se consulto la segunda central');

// F1: ~28, ingreso inverificable -> RECHAZADO
const F1 = decidirResultado({ ...sinFlags, salida: salida({ puntaje: 28 }) });
ok(F1.resultado === 'rechazado', 'F1: 28 -> rechazado');
ok(decidirCascada(salida({ puntaje: 28 }), [], U).consultarSecundaria === false, 'F1: 28 < 40, sin segunda consulta');

// G: diferencia > 80 entre centrales -> REVISION MANUAL OBLIGATORIA
const G = decidirResultado({ ...sinFlags, salida: salida({ puntaje: 80, decision: 'revision_manual', obligatoria: 'Caso G: diferencia entre centrales mayor a 80 puntos', inconsistencia: true }) });
ok(G.resultado === 'condicionado' && G.motivo.includes('Caso G'), 'G: inconsistencia entre centrales -> revision manual');

console.log('\nAdenda §3 — la zona gris y el coarrendatario');

ok(decidirResultado({ ...sinFlags, salida: salida({ puntaje: 85 }) }).resultado === 'aprobado', '85 -> aprobado');
ok(decidirResultado({ ...sinFlags, salida: salida({ puntaje: 84 }) }).resultado === 'condicionado', '84 sin coarrendatario -> revision manual (NO perfil medio)');
for (const p of [70, 79, 84]) {
  const con = decidirResultado({ ...sinFlags, salida: salida({ puntaje: p }), coarrendatario: { puntaje: 80, reglaDura: false } });
  ok(con.resultado === 'aprobado' && con.via === 'condicionada_coarrendatario', `${p} + coarrendatario 80 -> aprobacion automatica condicionada`);
  const sin = decidirResultado({ ...sinFlags, salida: salida({ puntaje: p }), coarrendatario: { puntaje: 79, reglaDura: false } });
  ok(sin.resultado === 'condicionado', `${p} + coarrendatario 79 -> revision manual`);
}
ok(decidirResultado({ ...sinFlags, salida: salida({ puntaje: 75 }), coarrendatario: { puntaje: 95, reglaDura: true } }).resultado === 'condicionado', 'coarrendatario con regla dura no aprueba (§5: contamina el conjunto)');
ok(decidirResultado({ ...sinFlags, salida: salida({ puntaje: 69.9 }), coarrendatario: { puntaje: 100, reglaDura: false } }).resultado === 'rechazado', '< 70: ningun coarrendatario compensa');

console.log('\n§14 / §16.5 / §8 — los flags impiden la aprobacion automatica');

const conFlag = decidirResultado({ ...sinFlags, salida: salida({ puntaje: 95 }), motivosRevision: ['Revision manual obligatoria (Politica §14): listas restrictivas SIN VERIFICAR'] });
ok(conFlag.resultado === 'condicionado' && conFlag.motivo.includes('§14'), '95 con listas sin verificar -> revision manual, no aprobado');
ok(decidirResultado({ ...sinFlags, salida: salida({ puntaje: 75 }), coarrendatario: { puntaje: 90, reglaDura: false }, motivosRevision: ['flag'] }).resultado === 'condicionado', 'el flag tambien frena la condicionada con coarrendatario');
ok(decidirResultado({ ...sinFlags, salida: salida({ puntaje: 60 }), motivosRevision: ['flag'] }).resultado === 'rechazado', 'pero un < 70 sigue siendo rechazado: el flag no rescata');
ok(decidirResultado({ ...sinFlags, salida: salida({ puntaje: null }) }).resultado === 'condicionado', 'sin puntaje en ninguna central -> revision manual (§14), nunca rechazo');

console.log('\nLos umbrales del panel mandan');
const U2 = { ...U, aprobacion: 90, zonaGris: 60, coarrendatario: 85, cascadaAprobacion: 95, cascadaRechazo: 30 };
ok(decidirResultado({ ...sinFlags, u: U2, salida: salida({ puntaje: 88 }) }).resultado === 'condicionado', '88 < 90 ya no aprueba');
ok(decidirResultado({ ...sinFlags, u: U2, salida: salida({ puntaje: 62 }) }).resultado === 'condicionado', '62 >= 60 entra a zona gris');
ok(decidirCascada(salida({ puntaje: 92 }), [], U2).consultarSecundaria === true, '92 < 95 sigue consultando la segunda');
ok(decidirCascada(salida({ puntaje: 31 }), [], U2).consultarSecundaria === true, '31 >= 30 consulta la segunda');

console.log(`\nOK — ${pasos} aserciones: la matriz A-G, la cascada y las bandas de la Adenda deciden como el documento dice.`);

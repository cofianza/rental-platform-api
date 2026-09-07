/**
 * Check de la invariante del PASO 5 (Flujo §8.2 vs Politica V4.1 §4.2):
 *
 *   EL INGRESO DECLARADO POR EL PROSPECTO NO ENTRA AL MOTOR DE DECISION.
 *
 * Los dos documentos de Gerencia se contradicen: el Flujo §8.2 le pregunta al
 * prospecto cuanto recibe al mes, y la Politica §4.2 dice literalmente que "el
 * ingreso mensual es INFERIDO AUTOMATICAMENTE POR EL SISTEMA a partir de las
 * fuentes disponibles". Resolverlo mal no sesga una metrica: RECHAZA gente.
 * Las DOS unicas reglas duras vivas en produccion (dti_mayor_65,
 * canon_ingreso_mayor_40) son exactamente las dos que se calculan sobre el
 * ingreso, y el dato es manipulable en los dos sentidos — inflarlo esquiva las
 * dos reglas, un cero de menos las dispara sobre alguien solvente.
 *
 * La invariante NO es un valor que se pueda testear: es una AUSENCIA. Por eso
 * la mitad de este archivo es un grep. Se verifica sobre TODO
 * src/modules/estudios/, no solo sobre motor/: ahi vive tambien
 * autorizacion.guard.ts, la ultima parada antes de la consulta FACTURABLE al
 * buro.
 *
 * Y la otra mitad ejercita el motor de verdad: con TransUnion (que no entrega
 * ingreso inferido por ningun nodo del combo 1901) dti_pct y canon_ingreso_pct
 * tienen que seguir siendo NULL, no 0 y no el declarado. Si algun dia alguien
 * "destraba el DTI" rellenando ese hueco, este check cae.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-ingreso-declarado.ts
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// El motor es puro, pero sus imports transitivos validan el env al cargar.
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

import { evaluarSombra } from '@/modules/estudios/motor';
import {
  senalDiscrepanciaIngreso,
  DISCREPANCIA_INGRESO_PCT,
} from '@/modules/autorizaciones/ingreso-declarado';

let fallos = 0;
function fila(ok: boolean, etiqueta: string, detalle: string): void {
  if (!ok) fallos++;
  console.log(`${ok ? '✓' : '✗'} ${etiqueta.padEnd(52)} ${detalle}`);
}

console.log('\n── §8.2 / §4.2 — el ingreso declarado no contamina el scorecard ──\n');

// ============================================================
// 1. El identificador del declarado no aparece en el modulo que decide
// ============================================================

const RAIZ = path.resolve(__dirname, '..', 'src', 'modules', 'estudios');
const PROHIBIDAS = ['ingreso_declarado', 'perfil_prospecto', 'situacion_laboral', 'donde_labora'];
// Excepcion unica y explicita, y acotada al identificador: submitFormulario
// desvia el ingreso del formulario publico HACIA la tabla del §8.2 para
// sacarlo de datos_formulario (donde EstudioDetailModal se lo enseñaba a la
// inmobiliaria). Es el unico sitio de este arbol que puede nombrarlo, y solo
// para ESCRIBIR: 'situacion_laboral' y 'donde_labora' siguen prohibidos ahi.
const EXCEPCIONES: Record<string, string[]> = {
  [path.join(RAIZ, 'estudios.service.ts')]: ['ingreso_declarado', 'perfil_prospecto'],
};

function archivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : archivosTs(full);
    return e.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

const contaminados: string[] = [];
for (const archivo of archivosTs(RAIZ)) {
  const permitidas = EXCEPCIONES[archivo] ?? [];
  const contenido = fs.readFileSync(archivo, 'utf8');
  for (const aguja of PROHIBIDAS) {
    if (!permitidas.includes(aguja) && contenido.includes(aguja)) {
      contaminados.push(`${path.relative(RAIZ, archivo)} menciona "${aguja}"`);
    }
  }
}
assert.deepStrictEqual(
  contaminados,
  [],
  `src/modules/estudios/ no puede nombrar el ingreso declarado:\n  ${contaminados.join('\n  ')}`,
);
fila(true, 'ausencia en src/modules/estudios/', `${PROHIBIDAS.length} identificadores prohibidos, 0 apariciones`);

// El motor, en particular, ni siquiera tiene la excepcion.
const motor = archivosTs(path.join(RAIZ, 'motor'));
for (const archivo of motor) {
  const contenido = fs.readFileSync(archivo, 'utf8');
  for (const aguja of [...PROHIBIDAS, 'autorizacion_perfil_prospecto']) {
    assert.ok(!contenido.includes(aguja), `motor/${path.basename(archivo)} menciona "${aguja}"`);
  }
}
fila(true, 'ausencia en motor/ (sin excepciones)', `${motor.length} archivos revisados`);

// ============================================================
// 2. Con TransUnion, V2/V3 siguen en NULL — no en 0 y no en el declarado
// ============================================================
//
// Es la comprobacion que atrapa el "atajo tentador": rellenar
// features.ingreso_mensual_inferido_cop con lo que el prospecto tecleo para
// que el DTI deje de ser no calculable. Ese hueco es REAL y tiene que verse.

const salidaTU = evaluarSombra({
  proveedor: 'transunion',
  payload: { score: { puntaje: 700 } },
  canon_mensual_cop: 2_000_000,
});

assert.strictEqual(salidaTU.dti_pct, null, 'con TransUnion el DTI no es calculable');
assert.strictEqual(salidaTU.canon_ingreso_pct, null, 'con TransUnion canon/ingreso no es calculable');
assert.strictEqual(
  salidaTU.features.ingreso_mensual_inferido_cop,
  null,
  'TransUnion no entrega ingreso inferido: null, NO 0 y NO el declarado',
);
assert.strictEqual(
  salidaTU.features.ausencias.ingreso_mensual_inferido_cop,
  'no_soportado',
  'la brecha de fuentes tiene que seguir siendo VISIBLE (ausencia marcada)',
);
assert.deepStrictEqual(
  salidaTU.reglas_duras,
  [],
  'sin ingreso no hay regla dura: nunca se rechaza por un dato que el buro no mando',
);
fila(true, 'TransUnion: DTI y canon/ingreso en null', 'ausencia marcada "no_soportado", 0 reglas duras');

// evaluarSombra recibe SOLO el payload crudo del buro y el canon. No hay
// ningun parametro por el que el formulario pudiera entrar.
const firmaEvaluarSombra = Object.keys({
  proveedor: 0,
  payload: 0,
  canon_mensual_cop: 0,
  score_persistido: 0,
  fecha_evaluacion: 0,
});
assert.ok(
  !firmaEvaluarSombra.some((k) => /ingreso|formulario|declarad/i.test(k)),
  'la entrada del motor no admite ingreso ni formulario',
);
fila(true, 'superficie de entrada del motor', 'proveedor + payload del buro + canon; nada mas');

// ============================================================
// 3. La senal de discrepancia es inerte sin ingreso inferido
// ============================================================
//
// Es el UNICO uso automatico que la Politica permite para el declarado, y solo
// como SENAL para la revision manual. Tiene que ser null —no false, no 0— si
// falta cualquiera de los dos lados: quien vea un "0%" va a querer cerrarlo.

assert.strictEqual(senalDiscrepanciaIngreso(3_000_000, null), null, 'sin inferido no hay senal');
assert.strictEqual(senalDiscrepanciaIngreso(null, 3_000_000), null, 'sin declarado no hay senal');
assert.strictEqual(senalDiscrepanciaIngreso(3_000_000, 0), null, 'inferido 0 no es un divisor valido');

const dentro = senalDiscrepanciaIngreso(4_000_000, 3_000_000); // 33.33%
assert.ok(dentro && dentro.hay === false, `33% no supera el umbral de ${DISCREPANCIA_INGRESO_PCT}%`);
const fuera = senalDiscrepanciaIngreso(5_000_000, 3_000_000); // 66.67%
assert.ok(fuera && fuera.hay === true, '66% si supera el umbral');
// Tambien a la baja: declarar de menos tambien es una discrepancia.
const abajo = senalDiscrepanciaIngreso(1_000_000, 3_000_000); // 66.67%
assert.ok(abajo && abajo.hay === true, 'la desviacion se mide en valor absoluto');
fila(true, 'senal de discrepancia', `null si falta un lado; umbral ${DISCREPANCIA_INGRESO_PCT}% en ambos sentidos`);

// ============================================================
// 4. La senal no toca el motor
// ============================================================

const fuenteSenal = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'modules', 'autorizaciones', 'ingreso-declarado.ts'),
  'utf8',
);
assert.ok(!/from '@\/modules\/estudios/.test(fuenteSenal), 'la senal no importa nada del modulo de estudios');
assert.ok(!/supabase/i.test(fuenteSenal), 'la senal es pura: no persiste nada');
fila(true, 'la senal es pura y no persiste', 'sin imports del motor, sin Supabase');

// ============================================================

console.log(fallos === 0 ? '\nOK — todas las aserciones pasaron' : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);

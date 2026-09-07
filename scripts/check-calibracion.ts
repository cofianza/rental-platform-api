/**
 * Check del panel de calibracion — Adenda 1 §11.
 *
 * Los defaults tienen que ser los del documento, letra por letra: es lo que
 * corre en produccion hasta que Gerencia mueva algo. Y la validacion tiene que
 * rechazar lo absurdo (un factor de 0, un umbral de 150) porque el panel lo
 * edita un humano sin desarrollo de por medio.
 *
 * Correr:
 *   npx ts-node -r tsconfig-paths/register scripts/check-calibracion.ts
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

import { CALIBRACION_DEFAULT, PARAMETROS, validarParametro } from '@/lib/calibracion';

let pasos = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); pasos++; };

// Adenda §11, literal.
const ESPERADO: Record<string, number> = {
  FACTOR_AJUSTE_INGRESO: 1.15,
  UMBRAL_CASCADA_RECHAZO: 40,
  UMBRAL_CASCADA_APROBACION: 90,
  UMBRAL_DIFERENCIA_INGRESO: 50,
  VIGENCIA_CRC_DIAS: 60,
  DIAS_EXPIRACION_ESTUDIO: 15,
  UMBRAL_COARRENDATARIO: 80,
  UMBRAL_APROBACION_AUTOMATICA: 85,
  UMBRAL_ZONA_GRIS: 70,
};
for (const [clave, valor] of Object.entries(ESPERADO)) {
  ok(CALIBRACION_DEFAULT[clave as keyof typeof CALIBRACION_DEFAULT] === valor, `${clave} = ${valor} (Adenda §11)`);
}
ok(CALIBRACION_DEFAULT.CANON_MAX_TRANSITORIO === 3_000_000, 'CANON_MAX_TRANSITORIO arranca con lo que corre en produccion (3.000.000, Flujo §4.4)');
ok(PARAMETROS.length === 10, 'diez parametros en el panel');
ok(PARAMETROS.every((p) => p.descripcion.length > 10 && p.seccion.length > 0), 'todos con descripcion y seccion');
ok(PARAMETROS.find((p) => p.clave === 'FACTOR_AJUSTE_INGRESO')?.advertencia?.includes('46%') === true, 'la advertencia de la Adenda §1.1 (46% / 74,7%) queda registrada');

// Validacion.
ok(validarParametro('FACTOR_AJUSTE_INGRESO', 1.15)?.error === null, '1.15 valido');
ok(validarParametro('FACTOR_AJUSTE_INGRESO', 0)?.error !== null, 'factor 0 invalido');
ok(validarParametro('FACTOR_AJUSTE_INGRESO', 2.5)?.error !== null, 'factor 2.5 fuera de rango');
ok(validarParametro('UMBRAL_APROBACION_AUTOMATICA', 85.5)?.error !== null, 'un umbral no admite decimales');
ok(validarParametro('UMBRAL_APROBACION_AUTOMATICA', 150)?.error !== null, 'un umbral no pasa de 100');
ok(validarParametro('VIGENCIA_CRC_DIAS', 60)?.error === null, '60 dias valido');
ok(validarParametro('VIGENCIA_CRC_DIAS', 0)?.error !== null, '0 dias invalido');
ok(validarParametro('NO_EXISTE', 1) === null, 'clave desconocida -> null');
ok(validarParametro('UMBRAL_ZONA_GRIS', Number.NaN)?.error !== null, 'NaN invalido');
ok(validarParametro('UMBRAL_ZONA_GRIS', '70' as unknown as number)?.error !== null, 'string invalido');

console.log(`\nOK — ${pasos} aserciones: los parametros del panel son los de la Adenda §11 y se validan.`);

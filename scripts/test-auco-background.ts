/**
 * Sonda: ¿la cuenta de Auco tiene habilitados Background Check y AucoFace?
 *
 * Hace UNA validacion real contra el ambiente configurado (AUCO_API_URL) con
 * la cedula de EJEMPLO de la documentacion de Auco, sondea hasta que este
 * lista y muestra el resumen que usaria el motor. Luego llama a AucoFace con
 * imagenes invalidas: un 400 significa "modulo activo, mala imagen"; un
 * 401/403/404 significa "modulo no habilitado en este plan".
 *
 * Correr contra las llaves de Railway (las del .env.local dan 401):
 *   railway run npx ts-node -r tsconfig-paths/register scripts/test-auco-background.ts
 * o con un documento real:
 *   AUCO_PROBE_DOC=1234567890 AUCO_PROBE_TIPO=CC railway run npx ts-node ...
 */

import 'dotenv/config';

for (const [k, v] of Object.entries({
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'x',
  SUPABASE_SERVICE_ROLE_KEY: 'x',
  SUPABASE_JWT_SECRET: 'x',
  RESEND_API_KEY: 'x',
})) {
  if (!process.env[k]) process.env[k] = v;
}

import { env } from '@/config';
import { crearBackgroundCheck, obtenerBackgroundCheck, validarBiometria } from '@/lib/auco';
import { interpretarBackgroundCheck } from '@/modules/estudios/antecedentes';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  console.log('---- Auco background check probe ----');
  console.log('API URL:', env.AUCO_API_URL);
  console.log('Sender :', env.AUCO_SENDER_EMAIL);
  console.log('Keys   :', env.AUCO_PRIVATE_KEY.slice(0, 6) + '… /', env.AUCO_PUBLIC_KEY.slice(0, 6) + '…');
  console.log('Flag   : AUCO_BACKGROUND_CHECK_ENABLED =', env.AUCO_BACKGROUND_CHECK_ENABLED);

  const identification = process.env.AUCO_PROBE_DOC ?? '1001001010';
  const type = (process.env.AUCO_PROBE_TIPO ?? 'CC') as 'CC' | 'CE' | 'NIT' | 'PP';

  // 1. Background check
  let code: string | null = null;
  try {
    const t0 = Date.now();
    const creado = await crearBackgroundCheck({ type, identification }, 8000);
    code = creado.code;
    console.log(`\n[1] POST /validate/background -> code=${code} (${Date.now() - t0} ms)  => MODULO HABILITADO`);
  } catch (err) {
    console.log('\n[1] POST /validate/background FALLO:', err instanceof Error ? err.message : err);
    console.log('    401/403/404 = el modulo Background Check NO esta habilitado en esta cuenta/plan.');
  }

  if (code) {
    const inicio = Date.now();
    let listo = false;
    while (Date.now() - inicio < 90_000) {
      const resp = await obtenerBackgroundCheck(code, 8000);
      if (resp.ready === true) {
        const resumen = interpretarBackgroundCheck(resp, code);
        console.log(`\n[2] GET /validate/background listo en ${Date.now() - inicio} ms`);
        console.log('    estado        :', resumen.estado, resumen.motivo ? `(${resumen.motivo})` : '');
        console.log('    OFAC / ONU    :', resumen.listas_vinculantes, '-> reportado:', resumen.reportado_en_listas);
        console.log('    flags revision:', resumen.flags_revision.length ? resumen.flags_revision.join(', ') : '(ninguno)');
        console.log('    nivel         :', resumen.nivel);
        console.log('    FOSYGA        :', resumen.seguridad_social);
        console.log('    Registraduria :', resumen.registraduria_estado);
        console.log('    BDME          :', resumen.contaduria_bdme);
        listo = true;
        break;
      }
      process.stdout.write('.');
      await sleep(3000);
    }
    if (!listo) console.log('\n[2] Sin resultado en 90 s (ready:false). Con AUCO_BACKGROUND_TIMEOUT_MS=30000 esto seria "no_verificado" -> revision manual (§14).');
  }

  // 2. AucoFace (solo para saber si el modulo responde; las imagenes son basura a proposito)
  try {
    const r = await validarBiometria(
      { country: 'CO', type: 'CC', identification, documentImage: 'data:image/png;base64,AAAA', photo: 'data:image/png;base64,AAAA' },
      8000,
    );
    console.log('\n[3] POST /veriface/validate respondio 200:', JSON.stringify(r).slice(0, 200), '=> MODULO HABILITADO');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /\((\d{3})\)/.exec(msg)?.[1];
    console.log('\n[3] POST /veriface/validate ->', msg.slice(0, 200));
    console.log(status === '400'
      ? '    400 = modulo AucoFace HABILITADO (rechazo la imagen basura, que es lo esperado).'
      : '    401/403/404 = modulo AucoFace NO habilitado en esta cuenta/plan.');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

// ============================================================
// Script de prueba STANDALONE: TransUnion UAT — Combo 1901
// Uso: npm run test:transunion
// No depende de config del proyecto (Supabase, Stripe, etc.)
// ============================================================

import dotenv from 'dotenv';
dotenv.config();

const SEPARATOR = '─'.repeat(60);

// ── Config desde .env (solo TransUnion) ─────────────────────
const CONFIG = {
  apiUrl: process.env.TRANSUNION_API_URL ?? 'https://tucoapplicationserviceuat.transunion.co/ws/v1/rest/consultarCombo',
  username: process.env.TRANSUNION_USERNAME ?? '',
  password: process.env.TRANSUNION_PASSWORD ?? '',
  policyId: process.env.TRANSUNION_POLICY_ID ?? '3176',
  motivo: process.env.TRANSUNION_CONSULTA_MOTIVO ?? '22',
};

const TIMEOUT_MS = 30_000;

const TIPO_DOC_MAP: Record<string, string> = {
  cc: '1', nit: '2', ce: '3', ti: '4', pasaporte: '5',
};

const EXCLUSION_MESSAGES: Record<string, string> = {
  '-7': 'Titular fallecido o documento no elegible',
  '-6': 'Tipo de documento no elegible para scoring',
  '-5': 'Sin informacion crediticia en activo ni pasivo',
  '-4': 'Solo informacion en el pasivo',
};

// ── HTTP request directo ────────────────────────────────────

async function consultarTransUnion(tipoDoc: string, numDoc: string) {
  const tipoId = TIPO_DOC_MAP[tipoDoc];
  if (!tipoId) throw new Error(`Tipo documento "${tipoDoc}" no soportado`);

  const body = {
    codigoInformacion: '1901',
    tipoIdentificacion: tipoId,
    numeroIdentificacion: numDoc,
    motivoConsulta: CONFIG.motivo,
    idPolitica: CONFIG.policyId,
    numeroCuenta: '',
    tipoEntidad: '',
    tipoCuenta: '',
    codigoEntidad: '',
  };

  const basicAuth = Buffer.from(`${CONFIG.username}:${CONFIG.password}`).toString('base64');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(CONFIG.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ── Parseo de respuesta ─────────────────────────────────────

function printResult(response: any, elapsed: number) {
  // Error de TransUnion (campo "codigo" en root)
  if (response.codigo !== undefined) {
    console.log(`\n  Estado:     ERROR TransUnion`);
    console.log(`  Tiempo:     ${elapsed}ms`);
    console.log(`  Codigo:     ${response.codigo}`);
    console.log(`  Mensaje:    ${response.mensaje}`);
    if (response.idtransaccion) {
      console.log(`  Transaccion: ${response.idtransaccion}`);
    }
    return;
  }

  console.log(`\n  Estado:     EXITOSO`);
  console.log(`  Tiempo:     ${elapsed}ms`);

  // Tercero
  const tercero = response.Tercero;
  if (tercero) {
    console.log(`\n  --- Tercero ---`);
    console.log(`  Nombre:        ${tercero.NombreTitular ?? 'N/A'}`);
    console.log(`  Estado doc:    ${tercero.Estado ?? 'N/A'}`);
    console.log(`  Rango edad:    ${tercero.RangoEdad ?? 'N/A'}`);
    console.log(`  Lugar exp:     ${tercero.LugarExpedicion ?? 'N/A'}`);
  }

  // CreditVision
  const cv = response.CreditVision_5694;
  if (cv) {
    const variables = cv.fechaCorte?.[0]?.variables ?? [];
    const scoreVar = variables.find((v: any) => v.nombre === 'CREDITVISION');
    const scoreValue = scoreVar ? parseInt(scoreVar.valor, 10) : null;

    console.log(`\n  --- CreditVision ---`);
    console.log(`  Transaction ID: ${cv.transactionId ?? 'N/A'}`);

    if (scoreValue !== null && scoreValue < 0) {
      const msg = EXCLUSION_MESSAGES[String(scoreValue)] ?? `Exclusion desconocida`;
      console.log(`  Score:          EXCLUSION (${scoreValue})`);
      console.log(`  Motivo:         ${msg}`);
      console.log(`  Resultado:      CONDICIONADO (revision manual)`);
    } else if (scoreValue !== null) {
      const resultado = scoreValue >= 600 ? 'APROBADO' : scoreValue >= 400 ? 'CONDICIONADO' : 'RECHAZADO';
      console.log(`  Score:          ${scoreValue}`);
      console.log(`  Resultado:      ${resultado}`);
    } else {
      console.log(`  Score:          NO DISPONIBLE`);
      console.log(`  Resultado:      CONDICIONADO (revision manual)`);
    }

    // Mostrar todas las variables
    if (variables.length > 0) {
      console.log(`  Variables:`);
      for (const v of variables) {
        console.log(`    ${v.nombre}: ${v.valor}`);
      }
    }
  }

  // Info Comercial
  const ic = response.Informacion_Comercial_154;
  if (ic?.Consolidado?.Registro) {
    const reg = ic.Consolidado.Registro;
    console.log(`\n  --- Info Comercial (Consolidado) ---`);
    console.log(`  Obligaciones:   ${reg.NumeroObligaciones ?? 'N/A'}`);
    console.log(`  Saldo total:    ${formatCOP(reg.TotalSaldo)}`);
    console.log(`  Saldo en mora:  ${formatCOP(reg.SaldoObligacionesMora)}`);
    console.log(`  Valor mora:     ${formatCOP(reg.ValorMora)}`);
  }
}

function formatCOP(value: string | undefined): string {
  if (!value) return '$0';
  const num = parseInt(value, 10);
  if (isNaN(num)) return value;
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(num);
}

// ── Tests ───────────────────────────────────────────────────

async function runTest(label: string, tipoDoc: string, numDoc: string) {
  console.log('\n' + SEPARATOR);
  console.log(`  ${label}`);
  console.log(SEPARATOR);

  const start = Date.now();
  try {
    const response = await consultarTransUnion(tipoDoc, numDoc);
    printResult(response, Date.now() - start);
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\n  Estado:     ERROR DE CONEXION`);
    console.log(`  Tiempo:     ${elapsed}ms`);
    console.log(`  Error:      ${msg}`);
  }
}

async function main() {
  console.log('\n' + SEPARATOR);
  console.log('  TransUnion UAT — Test de integracion');
  console.log(SEPARATOR);

  console.log(`\n  API URL:    ${CONFIG.apiUrl}`);
  console.log(`  Username:   ${CONFIG.username ? CONFIG.username.slice(0, 3) + '***' : '(no configurado)'}`);
  console.log(`  Password:   ${CONFIG.password ? '****' : '(no configurada)'}`);
  console.log(`  Policy ID:  ${CONFIG.policyId}`);
  console.log(`  Motivo:     ${CONFIG.motivo}`);

  if (!CONFIG.username || !CONFIG.password) {
    console.error('\n  ERROR: TRANSUNION_USERNAME y TRANSUNION_PASSWORD son requeridos en .env\n');
    process.exit(1);
  }

  // Test 1: Documento ejemplo del manual
  await runTest('Test 1: CC 11636939 (ejemplo manual)', 'cc', '11636939');

  // Test 2: Documento que probablemente no existe
  await runTest('Test 2: CC 99999999 (inexistente)', 'cc', '99999999');

  // Test 3: Health check (documento vacío → error controlado)
  await runTest('Test 3: Health check (doc vacio)', 'cc', '');

  console.log('\n' + SEPARATOR);
  console.log('  Tests completados');
  console.log(SEPARATOR + '\n');
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});

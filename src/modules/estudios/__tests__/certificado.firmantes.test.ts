import { describe, it, expect, vi, beforeEach } from 'vitest';
import PDFDocument from 'pdfkit';

// ============================================================
// CRC para firmantes — Adenda 1 del módulo de contratos, respuesta 5: "El
// certificado que se adjunta al paquete de firma NO lleva puntaje ni
// observaciones. El certificado completo queda disponible únicamente en el
// panel de la inmobiliaria o del propietario."
//
// El texto del PDF se lee del spy sobre doc.text (pdfkit comprime el binario).
// Supabase con colas POR TABLA, como estudios.prospecto-redaccion.test.
// ============================================================

const { queues, enqueue, mockFrom, storage, archivos } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'eq', 'in', 'like', 'order', 'limit'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) chain[m] = () => chain;
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  const archivos = new Map<string, Buffer>();
  const storage = {
    download: vi.fn(async (key: string) => {
      const b = archivos.get(key);
      return b ? { data: new Blob([new Uint8Array(b)]), error: null } : { data: null, error: { message: 'Object not found' } };
    }),
    upload: vi.fn(async (key: string, b: Buffer) => {
      archivos.set(key, b);
      return { data: {}, error: null };
    }),
    createSignedUrl: vi.fn(async (key: string) => ({ data: { signedUrl: `https://storage.test/${key}` }, error: null })),
  };
  return {
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockFrom: vi.fn((table: string) => chainFor(table)),
    storage,
    archivos,
  };
});

const mockEnv = vi.hoisted(() => ({
  FRONTEND_URL: 'https://www.cofianza.co',
  MOTOR_DECIDE_ENABLED: false,
  MOTOR_RUTA_USA_SCORECARD: false,
}));
vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), storage: { from: () => storage } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/calibracion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/calibracion')>();
  return { ...actual, getCalibracion: vi.fn(async () => actual.CALIBRACION_DEFAULT) };
});
vi.mock('@/lib/companyConfig', () => ({
  getCompany: vi.fn(async () => ({
    name: 'COFIANZA S.A.S.',
    nit: '902.038.122-7',
    address: 'Calle 1',
    phone: '300',
    email: 'hola@cofianza.co',
    website: 'cofianza.co',
    certificateValidityDays: 60,
  })),
}));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn(async () => undefined) }));

import {
  crcParaArrendatario,
  crcParaFirmantes,
  descargarCertificado,
  generarCertificado,
  generateCertificateCode,
  generateCertificatePdf,
  generateQrCode,
  leerSombraDelEstudio,
  llaveDeVersion,
  paraArrendatario,
  sinPuntaje,
  verificarCertificado,
  type CertificatePdfData,
} from '../certificado.service';
import { calcularTarifas } from '../tarifas';

const textos = vi.spyOn(
  (PDFDocument as unknown as { prototype: { text: (t: unknown, ...r: unknown[]) => unknown } }).prototype,
  'text',
);
const impreso = () => textos.mock.calls.map((c) => String(c[0])).join('\n');

// Lo que revela el puntaje o es nota del analista.
const SENSIBLE = ['773', 'Observaciones', 'Nota interna del analista', '87 pts', 'puntaje 92', 'Denominador', 'Score'];
const NOTA = 'Esta versión no incluye el puntaje ni las observaciones de la evaluación.';

const DATOS: CertificatePdfData = {
  codigo: 'CERT-2026-00042',
  fechaEmision: '2026-09-01T16:00:00Z',
  fechaVencimiento: '2026-10-31T16:00:00Z',
  solicitanteNombre: 'Ana',
  solicitanteApellido: 'Pérez',
  solicitanteTipoDoc: 'cc',
  solicitanteNumDoc: '1026130143',
  solicitanteEmail: 'ana@correo.co',
  solicitanteTelefono: '3001234567',
  tipoEstudio: 'individual',
  inmuebleDireccion: 'Calle 1 # 2-3',
  inmuebleCiudad: 'Medellín',
  inmuebleDepartamento: 'Antioquia',
  inmuebleTipo: 'apartamento',
  inmuebleUso: 'vivienda',
  inmuebleEstrato: 4,
  inmuebleValorArriendo: 2_000_000,
  inmuebleArea: 60,
  inmuebleCodigo: 'INM-1',
  resultado: 'aprobado',
  score: 773,
  proveedor: 'DataCrédito',
  fechaEstudio: '2026-09-01T15:00:00Z',
  duracionContrato: 12,
  observaciones: 'Nota interna del analista',
  condiciones: 'Presentar el contrato laboral',
  canonEvaluado: 2_000_000,
  canonMaximoTolerado: 2_300_000,
  requiereAcompanante: false,
  coarrendatarioVinculado: false,
  rutaEtiqueta: 'Aprobado automatico (87 pts)',
  modeloVersion: 'v4.1',
  tarifas: calcularTarifas({ via: 'automatica', conCoarrendatario: false, canonCop: 2_000_000, ivaPct: 19 }),
  factorAjusteIngreso: 1.15,
  fuentesConsultadas: 'DataCrédito',
  decisionCascada: 'puntaje 92 >= 90 con la primaria: aprobado sin consultar la segunda central',
  denominadorPuntaje: '105 puntos (V1, V2, V3)',
  canonIngresoPct: null,
};

const CERT = {
  id: 'cert-1',
  estudio_id: 'est-1',
  codigo: 'CERT-2026-00042',
  version: 1,
  pdf_storage_key: 'estudios/est-1/certificado/uuid-1.pdf',
  fecha_emision: '2026-09-01T16:00:00Z',
  fecha_vencimiento: '2026-10-31T16:00:00Z',
};

const ESTUDIO = {
  id: 'est-1',
  expediente_id: 'exp-1',
  tipo: 'individual',
  estado: 'completado',
  resultado: 'aprobado',
  score: 773,
  observaciones: 'Nota interna del analista',
  condiciones: null,
  proveedor: 'datacredito',
  proveedor_secundario: null,
  referencia_proveedor: 'REF-1',
  fecha_completado: new Date().toISOString(),
  created_at: new Date().toISOString(),
  canon_evaluado: '2000000',
  cascada: { via: 'automatica', decision_cascada: 'puntaje 92 >= 90 con la primaria: aprobado sin consultar la segunda central' },
  regla_dura_activada: null,
  tarifa_override: null,
  duracion_contrato_meses: 12,
  expedientes: {
    numero: 'EXP-2026-0001',
    estado: 'aprobado',
    duracion_contrato_meses: 12,
    solicitantes: { nombre: 'Ana', apellido: 'Pérez', tipo_documento: 'cc', numero_documento: '1026130143', email: 'ana@correo.co', telefono: '3001234567' },
    inmuebles: { direccion: 'Calle 1 # 2-3', ciudad: 'Medellín', departamento: 'Antioquia', tipo: 'apartamento', uso: 'vivienda', estrato: 4, valor_arriendo: 2_000_000, area_m2: 60, codigo: 'INM-1' },
  },
};

let QR: Buffer;

beforeEach(async () => {
  queues.clear();
  archivos.clear();
  vi.clearAllMocks();
  QR ??= await generateQrCode('https://www.cofianza.co/verificar/CERT-2026-00042');
});

describe('el PDF sin puntaje', () => {
  it('el completo trae puntaje y observaciones; el de firmantes, ninguno y lo dice', async () => {
    await generateCertificatePdf(DATOS, QR);
    const completo = impreso();
    for (const s of SENSIBLE) expect(completo).toContain(s);
    expect(completo).not.toContain(NOTA);

    textos.mockClear();
    await generateCertificatePdf(sinPuntaje(DATOS), QR);
    const firmantes = impreso();
    for (const s of SENSIBLE) expect(firmantes).not.toContain(s);
    expect(firmantes).toContain(NOTA);
    // Lo demás del certificado sigue: número, resultado y tarifas.
    for (const s of ['CERT-2026-00042', 'APROBADO', 'Tarifa mensual de la fianza', 'Prima de vinculación']) {
      expect(firmantes).toContain(s);
    }
  });

  // P13 (Ley 1266): la de firmantes más su propio puntaje; nada más.
  it('la del arrendatario trae su puntaje; ni condiciones, ni observaciones, ni perfil, ni cascada, ni denominador', async () => {
    await generateCertificatePdf(paraArrendatario(DATOS), QR);
    const t = impreso();
    expect(t).toContain('Score');
    expect(t).toContain('773');
    for (const s of ['Presentar el contrato laboral', 'Observaciones', 'Nota interna del analista', '87 pts', 'puntaje 92', 'Denominador']) {
      expect(t).not.toContain(s);
    }
    expect(t).not.toMatch(/aprobación (automática|condicionada|tras)/);
    expect(t).toContain('Esta versión no incluye las observaciones de la evaluación.');
    expect(t).not.toContain(NOTA);
  });

  // A10: las condiciones del analista cuentan como observaciones.
  it('las condiciones del analista van en el completo y no en las versiones reducidas', async () => {
    await generateCertificatePdf(DATOS, QR);
    expect(impreso()).toContain('Presentar el contrato laboral');

    for (const reducida of [sinPuntaje(DATOS), paraArrendatario(DATOS)]) {
      textos.mockClear();
      await generateCertificatePdf(reducida, QR);
      expect(impreso()).not.toContain('Presentar el contrato laboral');
      expect(textos.mock.calls.some((c) => c[0] === 'Condiciones')).toBe(false);
    }
  });

  // La nota depende de la versión, no de si hay score.
  it('la del arrendatario sin score (registro manual) dice lo que falta en su versión', async () => {
    await generateCertificatePdf(paraArrendatario({ ...DATOS, score: null }), QR);
    expect(impreso()).toContain('Esta versión no incluye las observaciones de la evaluación.');
    expect(impreso()).not.toContain(NOTA);
  });
});

// Adenda 1 del módulo de contratos, respuesta 19: "El certificado debe registrar
// expresamente que la relación canon/ingreso no fue verificable".
describe('relación canon/ingreso', () => {
  const NO_VERIFICABLE = 'No verificable (no se contó con ingreso verificado)';

  it('sin ingreso verificado lo registra, en las dos versiones, y no promete el recálculo', async () => {
    for (const d of [DATOS, sinPuntaje(DATOS)]) {
      textos.mockClear();
      await generateCertificatePdf(d, QR);
      const t = impreso();
      expect(t).toContain('Relación canon/ingreso');
      expect(t).toContain(NO_VERIFICABLE);
      expect(t).toContain('La relación canon/ingreso no se recalcula porque no fue verificable.');
      expect(t).not.toContain('se mantenga en o por debajo del 40%');
    }
  });

  it('con ingreso, el completo imprime la cifra; el de firmantes no (deja ver el ingreso)', async () => {
    const conIngreso = { ...DATOS, canonIngresoPct: 28.57 };
    await generateCertificatePdf(conIngreso, QR);
    const completo = impreso();
    expect(completo).toContain('28,57%');
    expect(completo).not.toContain(NO_VERIFICABLE);
    expect(completo).toContain('se mantenga en o por debajo del 40%');

    textos.mockClear();
    await generateCertificatePdf(sinPuntaje(conIngreso), QR);
    const firmantes = impreso();
    expect(firmantes).not.toContain('28,57');
    expect(firmantes).not.toContain(NO_VERIFICABLE);
  });

  it('un error leyendo la corrida se lanza: no se imprime «no verificable» por un fallo de la base', async () => {
    enqueue('estudios_scorecard_sombra', { data: null, error: { message: 'canceling statement due to statement timeout' } });
    await expect(leerSombraDelEstudio('est-1')).rejects.toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
    // Sin fila (estudio anterior al motor) sí es legítimo: sale sin cifra.
    enqueue('estudios_scorecard_sombra', { data: null, error: null });
    await expect(leerSombraDelEstudio('est-1')).resolves.toBeNull();
  });

  it('se lee de la corrida del motor, sobre el ingreso ajustado como en el asistente de contratos', async () => {
    enqueue('estudios_scorecard_sombra', { data: { canon_ingreso_pct: '40.00', canon_ingreso_ajustado_pct: '34.78' }, error: null });
    expect((await leerSombraDelEstudio('est-1'))?.canonIngresoPct).toBe(34.78);
    // Corrida anterior al factor (solo el crudo): el asistente no la recalcula, el CRC no la afirma.
    enqueue('estudios_scorecard_sombra', { data: { canon_ingreso_pct: '74.60', canon_ingreso_ajustado_pct: null }, error: null });
    expect((await leerSombraDelEstudio('est-1'))?.canonIngresoPct).toBeNull();
  });
});

describe('filas del certificado', () => {
  it('un valor de varias líneas empuja la fila siguiente en vez de montarse', async () => {
    // Dos líneas (~150 caracteres): la fila siguiente baja más de los 16 puntos de una.
    await generateCertificatePdf({ ...DATOS, observaciones: 'Una observación larga del analista. '.repeat(4) }, QR);
    const y = (etiqueta: string) => textos.mock.calls.find((c) => c[0] === etiqueta)?.[2] as number;
    expect(y('Condiciones') - y('Observaciones')).toBeGreaterThan(20);
    expect(y('Fecha del estudio') - y('Proveedor')).toBe(16);
  });
});

describe('QR y pie', () => {
  // Estudio sin canon congelado y con el inmueble a medio llenar: la trazabilidad
  // cabe al fondo de la página 1 y el QR (y=720) con el pie se salían de la hoja.
  it('van juntos en la misma página', async () => {
    const corto = {
      ...DATOS,
      canonEvaluado: null,
      canonMaximoTolerado: null,
      inmuebleEstrato: null,
      inmuebleValorArriendo: null,
      inmuebleArea: null,
      inmuebleCodigo: null,
      observaciones: null,
      condiciones: null,
    };
    await generateCertificatePdf(sinPuntaje(corto), QR);
    // Carta: 792 de alto y 50 de margen; lo que pase de 742 pdfkit lo lleva a otra hoja.
    const pie = textos.mock.calls.find((c) => String(c[0]).startsWith('COFIANZA S.A.S. | NIT'));
    expect(pie?.[2] as number).toBeLessThanOrEqual(742 - 9);
  });
});

// Adenda 1 del módulo de contratos §1.1: "La prima y la tarifa causan IVA, siempre."
describe('IVA de la prima y la tarifa', () => {
  it('las dos llevan su IVA, con la tarifa del panel, en las dos versiones', async () => {
    await generateCertificatePdf(DATOS, QR);
    const completo = impreso();
    expect(completo).toMatch(/2% del canon más IVA \(aprobación automática\): \$\s40\.000 \+ IVA del 19% = \$\s47\.600/);
    expect(completo).toMatch(/20% del canon más IVA, pago único al activar: \$\s400\.000 \+ IVA del 19% = \$\s476\.000/);

    // Sin la vía de aprobación: deja inferir la banda del puntaje.
    textos.mockClear();
    await generateCertificatePdf(sinPuntaje(DATOS), QR);
    const firmantes = impreso();
    expect(firmantes).toMatch(/2% del canon más IVA: \$\s40\.000 \+ IVA del 19% = \$\s47\.600/);
    expect(firmantes).toMatch(/20% del canon más IVA, pago único al activar: \$\s400\.000 \+ IVA del 19% = \$\s476\.000/);
    expect(firmantes).not.toMatch(/aprobación (automática|condicionada|tras)/);

    textos.mockClear();
    const tarifas = calcularTarifas({ via: 'condicionada_coarrendatario', conCoarrendatario: true, canonCop: 2_000_000, ivaPct: 16 });
    await generateCertificatePdf({ ...DATOS, tarifas }, QR);
    const t = impreso();
    expect(t).toMatch(/2,5% del canon más IVA \(aprobación condicionada con coarrendatario\): \$\s50\.000 \+ IVA del 16% = \$\s58\.000/);
    expect(t).toMatch(/10% del canon más IVA, pago único al activar: \$\s200\.000 \+ IVA del 16% = \$\s232\.000/);
  });
});

// A1: regla del cashback de la Adenda 1 del módulo de contratos (§3.4.2, §3.4.4, §5.9).
describe('cashback', () => {
  const REGLA =
    '30% de las tarifas mensuales pagadas, a favor de quien las pagó, si al terminar el contrato Cofianza no tuvo que ' +
    'cubrir sumas y el arrendador cumplió sus obligaciones de reporte; no aplica sobre la prima';

  it('imprime la condición nueva, en las tres versiones, y no la vieja de «sin moras»', async () => {
    for (const d of [DATOS, sinPuntaje(DATOS), paraArrendatario(DATOS)]) {
      textos.mockClear();
      await generateCertificatePdf(d, QR);
      const t = impreso();
      expect(t).toContain(REGLA);
      expect(t).not.toContain('sin moras');
    }
  });
});

describe('quién recibe cuál', () => {
  const FIRMANTES = llaveDeVersion(CERT.pdf_storage_key, 'firmantes');
  const ARRENDATARIO = llaveDeVersion(CERT.pdf_storage_key, 'arrendatario');

  it('las llaves de firmantes y del arrendatario viven al lado de la del completo', () => {
    expect(FIRMANTES).toBe('estudios/est-1/certificado/uuid-1-firmantes.pdf');
    expect(ARRENDATARIO).toBe('estudios/est-1/certificado/uuid-1-arrendatario.pdf');
  });

  // P13 (Ley 1266): el arrendatario conoce su puntaje.
  it('el arrendatario (solicitante) baja su versión, con su puntaje; la inmobiliaria, la completa', async () => {
    archivos.set(FIRMANTES, Buffer.from('%PDF firmantes'));
    archivos.set(ARRENDATARIO, Buffer.from('%PDF arrendatario'));

    enqueue('estudios', { data: { expediente_id: 'exp-1', tipo: 'individual' }, error: null });
    enqueue('estudios_certificados', { data: CERT, error: null });
    const delSolicitante = await descargarCertificado('est-1', 'u-1', 'solicitante');
    expect(delSolicitante.url).toBe(`https://storage.test/${ARRENDATARIO}`);

    enqueue('estudios', { data: { expediente_id: 'exp-1', tipo: 'individual' }, error: null });
    enqueue('estudios_certificados', { data: CERT, error: null });
    const deLaInmobiliaria = await descargarCertificado('est-1', 'u-2', 'inmobiliaria');
    expect(deLaInmobiliaria.url).toBe(`https://storage.test/${CERT.pdf_storage_key}`);
  });

  it('un CRC emitido antes sin versión para firmantes: se genera una vez, con su número y sus fechas', async () => {
    enqueue('estudios', { data: ESTUDIO, error: null });

    const r = await crcParaFirmantes(CERT);

    expect(r.key).toBe(FIRMANTES);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(storage.upload).toHaveBeenCalledWith(FIRMANTES, r.pdf, expect.objectContaining({ upsert: false }));
    const texto = impreso();
    for (const s of ['773', 'Nota interna del analista', 'puntaje 92']) expect(texto).not.toContain(s);
    expect(texto).toContain(NOTA);
    expect(texto).toContain('CERT-2026-00042');
    expect(texto).toContain('31 de octubre de 2026');

    // Ya guardada: la siguiente vez solo se lee.
    textos.mockClear();
    await crcParaFirmantes(CERT);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(textos).not.toHaveBeenCalled();
  });

  // Regenerar con el estudio de hoy imprimiría un resultado que ya no es.
  it('sin la versión guardada y con el estudio de hoy no certificable, no la regenera: 409 y nada se sube', async () => {
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ ...ESTUDIO, resultado: 'rechazado' }, 'ESTUDIO_NO_CERTIFICABLE'],
      [{ ...ESTUDIO, estado: 'en_proceso', resultado: 'pendiente' }, 'ESTUDIO_NO_COMPLETADO'],
      // Condicionado que el analista negó: el estudio sigue 'condicionado', el expediente no.
      [{ ...ESTUDIO, resultado: 'condicionado', expedientes: { ...ESTUDIO.expedientes, estado: 'rechazado' } }, 'ESTUDIO_NO_CERTIFICABLE'],
    ];
    for (const [estudio, errorCode] of casos) {
      enqueue('estudios', { data: estudio, error: null });
      await expect(crcParaFirmantes(CERT)).rejects.toMatchObject({ statusCode: 409, errorCode });
    }
    expect(storage.upload).not.toHaveBeenCalled();
    expect(textos).not.toHaveBeenCalled();
  });

  it('la del arrendatario se genera una vez, a pedido, con las mismas compuertas', async () => {
    enqueue('estudios', { data: ESTUDIO, error: null });

    const r = await crcParaArrendatario(CERT);

    expect(r.key).toBe(ARRENDATARIO);
    expect(storage.upload).toHaveBeenCalledWith(ARRENDATARIO, r.pdf, expect.objectContaining({ upsert: false }));
    const texto = impreso();
    expect(texto).toContain('773');
    for (const s of ['Nota interna del analista', 'puntaje 92']) expect(texto).not.toContain(s);

    // Con el estudio de hoy no certificable, otra versión no se genera.
    storage.upload.mockClear();
    enqueue('estudios', { data: { ...ESTUDIO, resultado: 'rechazado' }, error: null });
    await expect(crcParaArrendatario({ ...CERT, pdf_storage_key: 'estudios/est-1/certificado/uuid-2.pdf' })).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'ESTUDIO_NO_CERTIFICABLE',
    });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  // El contrato firmado cierra el expediente sin estado previo; cancelar deja
  // el estado del que venía. Un condicionado que Cofianza aprobó sigue
  // aprobado en la versión que se genera después, igual que en /verificar.
  it('la del arrendatario pedida con el estudio ya cerrado conserva la aprobación de Cofianza', async () => {
    const casos: Array<[string | null, () => void]> = [
      ['aprobado', () => undefined],
      // Sin marca, con la prueba del cierre natural: el contrato firmado.
      [null, () => enqueue('contratos', { data: [{ id: 'k-1' }], error: null })],
    ];
    for (const [pre, prueba] of casos) {
      textos.mockClear();
      prueba();
      const expedientes = { ...ESTUDIO.expedientes, estado: 'cerrado', estado_pre_cancelacion: pre };
      enqueue('estudios', { data: { ...ESTUDIO, resultado: 'condicionado', expedientes }, error: null });
      await crcParaArrendatario({ ...CERT, pdf_storage_key: `estudios/est-1/certificado/cierre-${pre}.pdf` });
      expect(impreso()).toContain('APROBADO');
      expect(impreso()).not.toContain('CONDICIONADO');
    }
  });

  // P32: condicionado cancelado en revisión. Ninguna versión nueva: el PDF diría
  // CONDICIONADO sobre un certificado que /verificar da por sin efecto.
  it('de un certificado sin efecto no se genera ninguna versión: ni el completo, ni el de firmantes, ni el del arrendatario', async () => {
    const SIN_EFECTO = { statusCode: 409, message: 'Este certificado ya no tiene efecto.' };
    const cancelado = {
      ...ESTUDIO,
      resultado: 'condicionado',
      expedientes: { ...ESTUDIO.expedientes, estado: 'cerrado', estado_pre_cancelacion: 'condicionado' },
    };

    enqueue('estudios', { data: cancelado, error: null });
    await expect(generarCertificado('est-1', 'u-1', undefined, 'operador_analista')).rejects.toMatchObject(SIN_EFECTO);
    enqueue('estudios', { data: cancelado, error: null });
    await expect(crcParaFirmantes(CERT)).rejects.toMatchObject(SIN_EFECTO);
    enqueue('estudios', { data: cancelado, error: null });
    await expect(crcParaArrendatario(CERT)).rejects.toMatchObject(SIN_EFECTO);

    expect(storage.upload).not.toHaveBeenCalled();
    expect(textos).not.toHaveBeenCalled();
  });

  it('el generador no pone APROBADO a un resultado sin sello', async () => {
    await expect(generateCertificatePdf({ ...DATOS, resultado: 'rechazado' }, QR)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'ESTUDIO_NO_CERTIFICABLE',
    });
    expect(textos).not.toHaveBeenCalled();
  });

  it('al emitir el CRC se suben los dos: el completo y, al lado, el de firmantes', async () => {
    enqueue('estudios', { data: ESTUDIO, error: null });
    enqueue('estudios_certificados', { data: null, error: null }, { data: { id: 'cert-9' }, error: null });

    const cert = await generarCertificado('est-1', 'u-1', undefined, 'operador_analista');

    const subidas = storage.upload.mock.calls.map((c) => c[0]);
    // La del arrendatario no: se genera cuando la pida.
    expect(subidas).toEqual([cert.pdf_storage_key, llaveDeVersion(cert.pdf_storage_key, 'firmantes')]);
  });
});

// P10 (Ley 1581 art. 4): el código no se puede recorrer y la verificación
// pública muestra lo justo para cotejar el papel.
describe('código del certificado', () => {
  it('es aleatorio, cabe en la columna (20) y no usa 0/O ni 1/I', () => {
    const codigos = Array.from({ length: 50 }, () => generateCertificateCode());
    for (const c of codigos) {
      expect(c).toMatch(/^CERT-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
      expect(c.length).toBeLessThanOrEqual(20);
    }
    expect(new Set(codigos).size).toBe(codigos.length);
    // Ya no lee el último emitido.
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('verificación pública', () => {
  const CODIGO = 'CERT-7KQ4-M9XH-2RPA';
  const fila = (expediente: Record<string, unknown>, resultado = 'aprobado', vence = '2999-01-01T00:00:00Z') => ({
    data: {
      codigo: CODIGO,
      fecha_emision: '2026-09-01T16:00:00Z',
      fecha_vencimiento: vence,
      estudios: {
        resultado,
        expediente_id: 'exp-1',
        expedientes: {
          solicitantes: { nombre: 'Ana María', apellido: 'Pérez Gómez', numero_documento: '1026130143' },
          inmuebles: { direccion: 'Calle 1 # 2-3', ciudad: 'Medellín' },
          ...expediente,
        },
      },
    },
    error: null,
  });

  it('identidad reducida a iniciales y últimos 4 del documento; sin dirección', async () => {
    enqueue('estudios_certificados', fila({ estado: 'aprobado' }));
    const v = await verificarCertificado(CODIGO);
    expect(v).toMatchObject({
      status: 'valido_vigente',
      resultado: 'aprobado',
      nombre_masked: 'A. M. P. G.',
      numero_documento_masked: '****0143',
      fecha_emision: '2026-09-01T16:00:00Z',
    });
    expect(v).not.toHaveProperty('direccion_masked');
    const json = JSON.stringify(v);
    for (const s of ['Ana', 'María', 'Pérez', 'Gómez', 'Calle', 'Medellín', '102613']) expect(json).not.toContain(s);
  });

  // P32: el analista negó el caso o se cerró sin aprobarse.
  it('un CRC en revisión que Cofianza negó o que se cerró sin aprobarse queda sin efecto, sin decir por qué', async () => {
    const casos: Array<Record<string, unknown>> = [
      { estado: 'rechazado', estado_pre_cancelacion: null },
      { estado: 'cerrado', estado_pre_cancelacion: 'rechazado' },
      { estado: 'cerrado', estado_pre_cancelacion: 'condicionado' },
    ];
    for (const exp of casos) {
      enqueue('estudios_certificados', fila(exp, 'condicionado'));
      const v = await verificarCertificado(CODIGO);
      expect(v).toMatchObject({ status: 'sin_efecto', resultado: '', fecha_emision: '2026-09-01T16:00:00Z' });
    }
    // Aunque además haya vencido: sin efecto dice más.
    enqueue('estudios_certificados', fila({ estado: 'rechazado' }, 'condicionado', '2026-01-01T00:00:00Z'));
    expect(await verificarCertificado(CODIGO)).toMatchObject({ status: 'sin_efecto' });
  });

  it('en revisión, o aprobado aunque después se cierre, sigue con efecto y dice lo mismo que el PDF', async () => {
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ estado: 'condicionado', estado_pre_cancelacion: null }, 'condicionado'],
      [{ estado: 'aprobado', estado_pre_cancelacion: null }, 'aprobado'],
      // Aprobado y después cancelado (la persona desistió): el CRC aprobado sigue.
      [{ estado: 'cerrado', estado_pre_cancelacion: 'aprobado' }, 'aprobado'],
      // El contrato firmado cierra el estudio sin estado previo (con la prueba).
      [{ estado: 'cerrado', estado_pre_cancelacion: null, contrato: true }, 'aprobado'],
    ];
    for (const [{ contrato, ...exp }, resultado] of casos) {
      if (contrato) enqueue('contratos', { data: [{ id: 'k-1' }], error: null });
      enqueue('estudios_certificados', fila(exp, 'condicionado'));
      expect(await verificarCertificado(CODIGO)).toMatchObject({ status: 'valido_vigente', resultado });
    }
    // Un aprobado por el buró no depende del expediente.
    enqueue('estudios_certificados', fila({ estado: 'cerrado', estado_pre_cancelacion: 'aprobado' }, 'aprobado'));
    expect(await verificarCertificado(CODIGO)).toMatchObject({ status: 'valido_vigente', resultado: 'aprobado' });
  });

  it('se genera una versión nueva si y solo si /verificar no la da por sin efecto', async () => {
    const casos: Array<[Record<string, unknown>, boolean]> = [
      [{ estado: 'rechazado', estado_pre_cancelacion: null }, true],
      [{ estado: 'cerrado', estado_pre_cancelacion: 'rechazado' }, true],
      [{ estado: 'cerrado', estado_pre_cancelacion: 'condicionado' }, true],
      [{ estado: 'cerrado', estado_pre_cancelacion: 'aprobado' }, false],
      [{ estado: 'cerrado', estado_pre_cancelacion: null }, true],
      [{ estado: 'cerrado', estado_pre_cancelacion: null, contrato: true }, false],
      [{ estado: 'aprobado', estado_pre_cancelacion: null }, false],
      [{ estado: 'condicionado', estado_pre_cancelacion: null }, false],
    ];
    for (const [{ contrato, ...exp }, sinEfecto] of casos) {
      if (contrato) enqueue('contratos', { data: [{ id: 'k-1' }], error: null }, { data: [{ id: 'k-1' }], error: null });
      enqueue('estudios_certificados', fila(exp, 'condicionado'));
      expect((await verificarCertificado(CODIGO)).status === 'sin_efecto').toBe(sinEfecto);

      const expedientes = { ...ESTUDIO.expedientes, ...exp };
      enqueue('estudios', { data: { ...ESTUDIO, resultado: 'condicionado', expedientes }, error: null });
      const generar = crcParaArrendatario({ ...CERT, pdf_storage_key: `estudios/est-1/certificado/${String(exp.estado)}-${String(exp.estado_pre_cancelacion)}-${String(contrato)}.pdf` });
      if (sinEfecto) await expect(generar).rejects.toMatchObject({ statusCode: 409, errorCode: 'ESTUDIO_NO_CERTIFICABLE' });
      else await expect(generar).resolves.toMatchObject({ key: expect.stringContaining('-arrendatario.pdf') });
    }
  });

  // La marca va en un UPDATE aparte del RPC: si falla, un caso cancelado o
  // negado no puede salir «Válido — Aprobado» en un documento público.
  it('cerrado sin marca: aprobado solo con prueba positiva (contrato firmado o el paso a cerrado del RPC)', async () => {
    const CERRADO = { estado: 'cerrado', estado_pre_cancelacion: null };
    const casos: Array<[string, () => void, string]> = [
      ['sin prueba', () => undefined, 'sin_efecto'],
      ['contrato firmado', () => enqueue('contratos', { data: [{ id: 'k-1' }], error: null }), 'valido_vigente'],
      ['RPC desde aprobado', () => enqueue('eventos_timeline', { data: [{ estado_anterior: 'aprobado' }], error: null }), 'valido_vigente'],
      ['RPC desde revisión', () => enqueue('eventos_timeline', { data: [{ estado_anterior: 'condicionado' }], error: null }), 'sin_efecto'],
      ['RPC desde rechazado', () => enqueue('eventos_timeline', { data: [{ estado_anterior: 'rechazado' }], error: null }), 'sin_efecto'],
    ];
    for (const [nombre, prueba, status] of casos) {
      prueba();
      enqueue('estudios_certificados', fila(CERRADO, 'condicionado'));
      expect(await verificarCertificado(CODIGO), nombre).toMatchObject({ status });
    }
  });

  it('si no se puede leer cómo se cerró, no publica nada: 503', async () => {
    enqueue('contratos', { data: null, error: { message: 'canceling statement due to statement timeout' } });
    enqueue('estudios_certificados', fila({ estado: 'cerrado', estado_pre_cancelacion: null }, 'condicionado'));
    await expect(verificarCertificado(CODIGO)).rejects.toMatchObject({ statusCode: 503, errorCode: 'LECTURA_NO_VERIFICABLE' });
  });

  it('vencido y no encontrado', async () => {
    enqueue('estudios_certificados', fila({ estado: 'aprobado' }, 'aprobado', '2026-01-01T00:00:00Z'));
    expect(await verificarCertificado(CODIGO)).toMatchObject({ status: 'valido_vencido', resultado: 'aprobado' });

    enqueue('estudios_certificados', { data: null, error: { code: 'PGRST116' } });
    const v = await verificarCertificado(CODIGO);
    expect(v).toMatchObject({ status: 'invalido', nombre_masked: '', numero_documento_masked: '' });
    expect(v).not.toHaveProperty('direccion_masked');
  });
});

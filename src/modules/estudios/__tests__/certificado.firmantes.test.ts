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
  const PASSTHROUGH = ['select', 'insert', 'update', 'eq', 'like', 'order', 'limit'];
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
  crcParaFirmantes,
  descargarCertificado,
  generarCertificado,
  generateCertificatePdf,
  generateQrCode,
  leerSombraDelEstudio,
  llaveFirmantes,
  sinPuntaje,
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
    // Lo demás del certificado sigue: número, resultado, condiciones y tarifas.
    for (const s of ['CERT-2026-00042', 'APROBADO', 'Presentar el contrato laboral', 'Tarifa mensual de la fianza', 'Prima de vinculación']) {
      expect(firmantes).toContain(s);
    }
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

  it('se lee de la corrida del motor: el ajustado por el factor y, si no lo hay, el crudo', async () => {
    enqueue('estudios_scorecard_sombra', { data: { canon_ingreso_pct: '40.00', canon_ingreso_ajustado_pct: '34.78' }, error: null });
    expect((await leerSombraDelEstudio('est-1'))?.canonIngresoPct).toBe(34.78);
    enqueue('estudios_scorecard_sombra', { data: { canon_ingreso_pct: '74.60', canon_ingreso_ajustado_pct: null }, error: null });
    expect((await leerSombraDelEstudio('est-1'))?.canonIngresoPct).toBe(74.6);
    enqueue('estudios_scorecard_sombra', { data: { canon_ingreso_pct: null, canon_ingreso_ajustado_pct: null }, error: null });
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

// Adenda 1 del módulo de contratos §1.1: "La prima y la tarifa causan IVA, siempre."
describe('IVA de la prima y la tarifa', () => {
  it('las dos llevan su IVA, con la tarifa del panel, en las dos versiones', async () => {
    for (const d of [DATOS, sinPuntaje(DATOS)]) {
      textos.mockClear();
      await generateCertificatePdf(d, QR);
      const t = impreso();
      expect(t).toMatch(/2% del canon más IVA \(aprobación automática\): \$\s40\.000 \+ IVA del 19% = \$\s47\.600/);
      expect(t).toMatch(/20% del canon más IVA, pago único al activar: \$\s400\.000 \+ IVA del 19% = \$\s476\.000/);
    }

    textos.mockClear();
    const tarifas = calcularTarifas({ via: 'condicionada_coarrendatario', conCoarrendatario: true, canonCop: 2_000_000, ivaPct: 16 });
    await generateCertificatePdf({ ...DATOS, tarifas }, QR);
    const t = impreso();
    expect(t).toMatch(/2,5% del canon más IVA \(aprobación condicionada con coarrendatario\): \$\s50\.000 \+ IVA del 16% = \$\s58\.000/);
    expect(t).toMatch(/10% del canon más IVA, pago único al activar: \$\s200\.000 \+ IVA del 16% = \$\s232\.000/);
  });
});

describe('quién recibe cuál', () => {
  const FIRMANTES = llaveFirmantes(CERT.pdf_storage_key);

  it('la llave de firmantes vive al lado de la del completo', () => {
    expect(FIRMANTES).toBe('estudios/est-1/certificado/uuid-1-firmantes.pdf');
  });

  it('el arrendatario (solicitante) baja la versión sin puntaje; la inmobiliaria, la completa', async () => {
    archivos.set(FIRMANTES, Buffer.from('%PDF firmantes'));

    enqueue('estudios', { data: { expediente_id: 'exp-1', tipo: 'individual' }, error: null });
    enqueue('estudios_certificados', { data: CERT, error: null });
    const delSolicitante = await descargarCertificado('est-1', 'u-1', 'solicitante');
    expect(delSolicitante.url).toBe(`https://storage.test/${FIRMANTES}`);

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

  it('el generador no pone APROBADO a un resultado sin sello', async () => {
    await expect(generateCertificatePdf({ ...DATOS, resultado: 'rechazado' }, QR)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'ESTUDIO_NO_CERTIFICABLE',
    });
    expect(textos).not.toHaveBeenCalled();
  });

  it('al emitir el CRC se suben los dos: el completo y, al lado, el de firmantes', async () => {
    enqueue('estudios', { data: ESTUDIO, error: null });
    enqueue('estudios_certificados', { data: null, error: null }, { data: null, error: null }, { data: { id: 'cert-9' }, error: null });

    const cert = await generarCertificado('est-1', 'u-1', undefined, 'operador_analista');

    const subidas = storage.upload.mock.calls.map((c) => c[0]);
    expect(subidas).toEqual([cert.pdf_storage_key, llaveFirmantes(cert.pdf_storage_key)]);
  });
});

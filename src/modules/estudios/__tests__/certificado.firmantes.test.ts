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

  it('al emitir el CRC se suben los dos: el completo y, al lado, el de firmantes', async () => {
    enqueue('estudios', { data: ESTUDIO, error: null });
    enqueue('estudios_certificados', { data: null, error: null }, { data: null, error: null }, { data: { id: 'cert-9' }, error: null });

    const cert = await generarCertificado('est-1', 'u-1', undefined, 'operador_analista');

    const subidas = storage.upload.mock.calls.map((c) => c[0]);
    expect(subidas).toEqual([cert.pdf_storage_key, llaveFirmantes(cert.pdf_storage_key)]);
  });
});

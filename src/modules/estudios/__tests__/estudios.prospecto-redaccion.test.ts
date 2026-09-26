import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Lo que el TITULAR (rol solicitante) recibe de los estudios de su expediente:
// ni el estudio de su co-arrendatario (otra persona, Ley 1266) ni el crudo del
// buro de su propio estudio (trae el score que la Politica §11 le oculta).
// Mismo mock de Supabase que coarrendatarios: builder encadenable + colas POR
// TABLA y `ops` para afirmar el filtro de la consulta.
// ============================================================

const { mockEnv, ops, queues, enqueue, mockFrom, storageApi } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'eq', 'neq', 'is', 'in', 'or', 'gte', 'order', 'limit', 'range'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    // Flags *_ENABLED / MOTOR_* apagados; lo demas un string.
    mockEnv: new Proxy({} as Record<string, unknown>, {
      get: (_t, k) => (typeof k === 'string' && (k.endsWith('_ENABLED') || k.startsWith('MOTOR_')) ? false : 'x'),
    }),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockFrom: vi.fn((table: string) => chainFor(table)),
    storageApi: {
      download: vi.fn(async () => ({ data: new Blob(['%PDF']), error: null })),
      createSignedUrl: vi.fn(async (key: string) => ({ data: { signedUrl: `https://storage.test/${key}` }, error: null })),
    },
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: vi.fn(), storage: { from: () => storageApi } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/email', () => ({ sendEstudioFormEmail: vi.fn() }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({ DIAS_EXPIRACION_ESTUDIO: 30 })) }));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: vi.fn(),
  perfilEsDuenoDeInmueble: vi.fn(),
  assertExpedienteAccess: vi.fn(async () => undefined),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(),
  findPerfilIdByEmail: vi.fn(),
  notificarResponsableExpediente: vi.fn(),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));

import {
  getEstudioById,
  listEstudios,
  getCertificadoViewUrl,
  buscarEstudioVigentePorDocumento,
  registrarResultado,
  assertScoreExternoVigente,
  motivosRevisionTrasCascada,
} from '../estudios.service';
import { descargarCertificado, generarCertificado } from '../certificado.service';
import { tarifasDelEstudio } from '../tarifa-override.service';
import { contrasteIngresoProspecto } from '@/modules/autorizaciones/ingreso-declarado';
import { resolveAllowedExpedienteIds } from '@/lib/tenantScope';
import { getCalibracion } from '@/lib/calibracion';

const fila = (tipo: string) => ({
  id: 'est-1',
  expediente_id: 'exp-1',
  tipo,
  estado: 'completado',
  resultado: 'aprobado',
  score: 780,
  respuesta_proveedor: { score: 780, obligaciones: [] },
  token_self_service: 'tok',
  datos_formulario: { numero_documento: '123' },
});

beforeEach(() => {
  queues.clear();
  ops.length = 0;
});

describe('estudios del expediente vistos por el titular', () => {
  it('el estudio del co-arrendatario le da 404 por id', async () => {
    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    await expect(getEstudioById('est-1', 'u-1', 'solicitante')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('en su propio estudio no le viajan el crudo del buro ni el token; si su cedula', async () => {
    enqueue('estudios', { data: fila('individual'), error: null });
    const e = (await getEstudioById('est-1', 'u-1', 'solicitante')) as Record<string, unknown>;
    expect(e.respuesta_proveedor).toBeNull();
    expect(e.token_self_service).toBeNull();
    expect(e.score).toBeNull();
    expect(e.datos_formulario).toEqual({ numero_documento: '123' });
  });

  it('el gestor sigue viendo el estudio del co-arrendatario completo', async () => {
    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    const e = (await getEstudioById('est-1', 'u-1', 'operador_analista')) as Record<string, unknown>;
    expect(e.respuesta_proveedor).toEqual({ score: 780, obligaciones: [] });
  });

  it('el listado del titular excluye el del co-arrendatario en la consulta (el total sale bien)', async () => {
    enqueue('expedientes', { data: { id: 'exp-1' }, error: null });
    await listEstudios('exp-1', { page: 1, limit: 10 } as never, 'u-1', 'solicitante');
    expect(ops).toContainEqual({ table: 'estudios', method: 'neq', args: ['tipo', 'con_coarrendatario'] });

    ops.length = 0;
    enqueue('expedientes', { data: { id: 'exp-1' }, error: null });
    await listEstudios('exp-1', { page: 1, limit: 10 } as never, 'u-2', 'inmobiliaria');
    expect(ops.some((o) => o.method === 'neq')).toBe(false);
  });
});

// La tarjeta y el CRC leen la decisión de Cofianza con la misma regla
// (decisionDeCofianza): no se contradicen.
describe('la decisión de Cofianza en la tarjeta', () => {
  const condicionado = { ...fila('individual'), resultado: 'condicionado' };
  const ruta = async () => ((await getEstudioById('est-1', 'u-1', 'operador_analista')) as { ruta: { ruta: string } }).ruta.ruta;

  it('un condicionado aprobado y después cerrado se ve aprobado, como en el certificado', async () => {
    enqueue('estudios', { data: condicionado, error: null });
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'cerrado', estado_pre_cancelacion: 'aprobado' }, error: null });
    expect(await ruta()).toBe('perfil_medio');
  });

  it('la tarjeta recibe la decisión: un condicionado cancelado en revisión es sin_aprobar', async () => {
    enqueue('estudios', { data: condicionado, error: null });
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'cerrado', estado_pre_cancelacion: 'condicionado' }, error: null });
    expect(await getEstudioById('est-1', 'u-1', 'solicitante')).toMatchObject({ decision_cofianza: 'sin_aprobar' });

    enqueue('estudios', { data: condicionado, error: null });
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'condicionado', estado_pre_cancelacion: null }, error: null });
    expect(await getEstudioById('est-1', 'u-1', 'solicitante')).toMatchObject({ decision_cofianza: 'en_curso' });
  });

  it('cerrado sin marca: aprobado solo con la prueba del cierre natural', async () => {
    enqueue('estudios', { data: condicionado, error: null });
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'cerrado', estado_pre_cancelacion: null }, error: null });
    enqueue('contratos', { data: [{ id: 'k-1' }], error: null });
    expect(await ruta()).toBe('perfil_medio');

    enqueue('estudios', { data: condicionado, error: null });
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'cerrado', estado_pre_cancelacion: null }, error: null });
    enqueue('eventos_timeline', { data: [{ estado_anterior: 'rechazado' }], error: null });
    expect(await ruta()).toBe('no_aprobable');
  });
});

// P32: la web no ofrece descargar ni generar un certificado que quedó sin
// efecto (cada clic daba 409). Misma regla que /verificar.
describe('certificado sin efecto en el estudio', () => {
  it('el listado lo marca según cómo terminó el caso', async () => {
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'cerrado', estado_pre_cancelacion: 'condicionado' }, error: null });
    enqueue('estudios', { data: [{ ...fila('individual'), resultado: 'condicionado', certificado_url: 'k.pdf' }], error: null, count: 1 });
    const cancelado = await listEstudios('exp-1', { page: 1, limit: 10 } as never, 'u-1', 'solicitante');
    expect(cancelado.estudios[0]).toMatchObject({ certificado_sin_efecto: true });

    enqueue('expedientes', { data: { id: 'exp-1', estado: 'aprobado', estado_pre_cancelacion: null }, error: null });
    enqueue('estudios', { data: [{ ...fila('individual'), certificado_url: 'k.pdf' }], error: null, count: 1 });
    const aprobado = await listEstudios('exp-1', { page: 1, limit: 10 } as never, 'u-1', 'solicitante');
    expect(aprobado.estudios[0]).toMatchObject({ certificado_sin_efecto: false });
  });

  it('el detalle también, aunque el estudio diga aprobado', async () => {
    enqueue('estudios', { data: { ...fila('individual'), certificado_url: 'k.pdf' }, error: null });
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'rechazado', estado_pre_cancelacion: null }, error: null });
    expect(await getEstudioById('est-1', 'u-1', 'solicitante')).toMatchObject({ certificado_sin_efecto: true });
  });
});

// Las lecturas no se caen si la prueba del cierre no se puede leer: la
// descarga y la generación del certificado ya fallan cerradas con 503.
describe('la decisión de Cofianza en las lecturas', () => {
  const CERRADO_SIN_MARCA = { id: 'exp-1', estado: 'cerrado', estado_pre_cancelacion: null };
  const FALLA = { data: null, error: { message: 'canceling statement due to statement timeout' } };

  it('si falla la lectura de la prueba, el listado y el detalle degradan: sin marca de sin efecto', async () => {
    enqueue('expedientes', { data: CERRADO_SIN_MARCA, error: null });
    enqueue('estudios', { data: [{ ...fila('individual'), certificado_url: 'k.pdf' }], error: null, count: 1 });
    enqueue('contratos', FALLA);
    const lista = await listEstudios('exp-1', { page: 1, limit: 10 } as never, 'u-1', 'solicitante');
    expect(lista.estudios[0]).toMatchObject({ certificado_sin_efecto: false, ruta: { ruta: 'perfil_medio' } });

    enqueue('estudios', { data: { ...fila('individual'), certificado_url: 'k.pdf' }, error: null });
    enqueue('expedientes', { data: CERRADO_SIN_MARCA, error: null });
    enqueue('contratos', FALLA);
    expect(await getEstudioById('est-1', 'u-1', 'solicitante')).toMatchObject({ certificado_sin_efecto: false });
  });

  it('sin filas aprobadas ni condicionadas no busca la prueba', async () => {
    enqueue('expedientes', { data: CERRADO_SIN_MARCA, error: null });
    enqueue('estudios', { data: [{ ...fila('individual'), resultado: 'rechazado' }], error: null, count: 1 });
    await listEstudios('exp-1', { page: 1, limit: 10 } as never, 'u-2', 'inmobiliaria');
    expect(ops.some((o) => o.table === 'contratos' || o.table === 'eventos_timeline')).toBe(false);
  });
});

describe('las demas rutas por id que el titular alcanza', () => {
  // El 404 del guard, no el de "no hay certificado".
  const OCULTO = { statusCode: 404, errorCode: 'ESTUDIO_NOT_FOUND' };
  // El id le llega por GET /expedientes/:id/coarrendatario y por la notificacion.
  it('certificado (url y descarga) y tarifa del estudio del co-arrendatario: 404', async () => {
    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    await expect(getCertificadoViewUrl('est-1', 'u-1', 'solicitante')).rejects.toMatchObject(OCULTO);

    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    await expect(descargarCertificado('est-1', 'u-1', 'solicitante')).rejects.toMatchObject(OCULTO);
    expect(ops.some((o) => o.table === 'estudios_certificados')).toBe(false);

    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    await expect(tarifasDelEstudio('est-1', 'u-1', 'solicitante')).rejects.toMatchObject(OCULTO);
  });

  // certificado_url es el CRC completo (o el reporte del buró adjunto), con
  // observaciones y datos del modelo. P13 (Ley 1266): el titular baja su
  // versión, la de firmantes con su puntaje.
  it('/certificado/url del titular: su versión del CRC, no lo que haya en certificado_url', async () => {
    const completo = 'estudios/est-1/certificado/uuid-1.pdf';
    // getCertificadoViewUrl, descargarCertificado y las compuertas de su versión.
    enqueue('estudios', { data: { ...fila('individual'), certificado_url: completo }, error: null });
    enqueue('estudios', { data: fila('individual'), error: null }, { data: fila('individual'), error: null });
    enqueue('estudios_certificados', {
      data: { id: 'c-1', codigo: 'CERT-2026-00001', version: 1, pdf_storage_key: completo, fecha_emision: '2026-09-01', fecha_vencimiento: '2026-10-31' },
      error: null,
    });
    const r = await getCertificadoViewUrl('est-1', 'u-1', 'solicitante');
    expect(r.url).toBe('https://storage.test/estudios/est-1/certificado/uuid-1-arrendatario.pdf');
  });

  it('el gestor si baja el certificado del co-arrendatario', async () => {
    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    // Pasa el guard y llega a buscar el certificado (no hay: 404 de certificado).
    await expect(descargarCertificado('est-1', 'u-1', 'operador_analista')).rejects.toMatchObject({
      errorCode: 'CERTIFICADO_NOT_FOUND',
    });
  });

  it('/vigente con la cedula del co-arrendatario no le trae su estudio', async () => {
    vi.mocked(resolveAllowedExpedienteIds).mockResolvedValueOnce(['exp-1']);
    vi.mocked(getCalibracion).mockResolvedValueOnce({ VIGENCIA_CRC_DIAS: 60 } as never);
    await buscarEstudioVigentePorDocumento('cc', '123', 'u-1', 'solicitante');
    expect(ops).toContainEqual({ table: 'estudios', method: 'neq', args: ['tipo', 'con_coarrendatario'] });
  });
});

describe('ruta del §10 cuando el analista ya decidio el condicionado', () => {
  const condicionado = { ...fila('individual'), resultado: 'condicionado' };

  it('aprobado por el analista: la tarjeta deja de decir "Estamos revisando"', async () => {
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'aprobado', estado_pre_cancelacion: null }, error: null });
    enqueue('estudios', { data: [condicionado], error: null, count: 1 });
    const { estudios } = await listEstudios('exp-1', { page: 1, limit: 10 } as never, 'u-1', 'solicitante');
    const ruta = (estudios[0] as { ruta: { ruta: string; titulo: string } }).ruta;
    expect(ruta.ruta).not.toBe('en_revision');
    expect(ruta.titulo).toMatch(/aprobado/);
  });

  it('negado por el analista: no aprobable, igual que el banner', async () => {
    enqueue('estudios', { data: condicionado, error: null });
    enqueue('expedientes', { data: { estado: 'rechazado', estado_pre_cancelacion: null }, error: null });
    const e = (await getEstudioById('est-1', 'u-1', 'solicitante')) as { ruta: { ruta: string } };
    expect(e.ruta.ruta).toBe('no_aprobable');
  });

  it('aprobado y despues cerrado no pasa a "no aprobable"', async () => {
    enqueue('estudios', { data: condicionado, error: null });
    enqueue('expedientes', { data: { estado: 'cerrado', estado_pre_cancelacion: 'aprobado' }, error: null });
    const e = (await getEstudioById('est-1', 'u-1', 'solicitante')) as { ruta: { ruta: string } };
    expect(e.ruta.ruta).not.toBe('no_aprobable');
  });
});

describe('CRC del estudio del co-arrendatario', () => {
  it('no se emite, ni siquiera por un operador: saldria a nombre del titular con el resultado de otra persona', async () => {
    enqueue('estudios', { data: fila('con_coarrendatario'), error: null });
    await expect(generarCertificado('est-1', 'u-1', undefined, 'operador_analista')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'ESTUDIO_COARRENDATARIO_NO_CERTIFICABLE',
    });
    expect(ops.some((o) => o.table === 'estudios_certificados')).toBe(false);
  });
});

describe('§5.2 estudio vigente por documento', () => {
  it('filtra el numero en SQL antes del limit (con mas de 25 evaluaciones en la ventana no se pierde)', async () => {
    vi.mocked(resolveAllowedExpedienteIds).mockResolvedValueOnce(null);
    vi.mocked(getCalibracion).mockResolvedValueOnce({ VIGENCIA_CRC_DIAS: 60 } as never);
    await buscarEstudioVigentePorDocumento('cc', ' 123 ', 'u-1', 'operador_analista');
    expect(ops).toContainEqual({ table: 'estudios', method: 'eq', args: ['datos_formulario->>numero_documento', '123'] });
  });
});

describe('§5.2 solo promete reutilizar lo reutilizable', () => {
  const vigente = (tipo: string) => ({
    id: 'est-v', expediente_id: 'exp-v', tipo, resultado: 'aprobado', canon_evaluado: 2_000_000,
    fecha_completado: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    datos_formulario: { tipo_documento: 'cc', numero_documento: '123' }, expedientes: { numero: 'EXP-9' },
  });

  it('la evaluacion como co-arrendatario existe pero no se ofrece como reutilizable', async () => {
    vi.mocked(resolveAllowedExpedienteIds).mockResolvedValueOnce(null);
    vi.mocked(getCalibracion).mockResolvedValueOnce({ VIGENCIA_CRC_DIAS: 60 } as never);
    enqueue('estudios', { data: [vigente('con_coarrendatario')], error: null });
    enqueue('expedientes', { data: { estado: 'aprobado', inmueble_id: null, inmobiliaria_id: null }, error: null });
    enqueue('contratos', { data: [], error: null });
    const r = await buscarEstudioVigentePorDocumento('cc', '123', 'u-1', 'operador_analista');
    expect(r).toMatchObject({ id: 'est-v', expediente_numero: 'EXP-9', reutilizable: false });
    expect(r?.motivo_no_reutilizable).toMatch(/co-arrendatario/);
  });

  it('aprobado, sin contrato: reutilizable', async () => {
    vi.mocked(resolveAllowedExpedienteIds).mockResolvedValueOnce(null);
    vi.mocked(getCalibracion).mockResolvedValueOnce({ VIGENCIA_CRC_DIAS: 60 } as never);
    enqueue('estudios', { data: [vigente('individual')], error: null });
    enqueue('expedientes', { data: { estado: 'aprobado', inmueble_id: null, inmobiliaria_id: null }, error: null });
    enqueue('contratos', { data: [], error: null });
    const r = await buscarEstudioVigentePorDocumento('cc', '123', 'u-1', 'operador_analista');
    expect(r).toMatchObject({ reutilizable: true, motivo_no_reutilizable: null });
  });
});

describe('contraste de ingreso (Adenda §8) sin cifras', () => {
  it('el motivo que va a observaciones no lleva el declarado, el estimado ni el umbral', async () => {
    enqueue('autorizacion_perfil_prospecto', { data: { ingreso_declarado_cop: 9_000_000 }, error: null });
    const motivo = await contrasteIngresoProspecto('exp-1', 3_000_000, 50);
    expect(motivo).toMatch(/Revision manual \(Adenda §8\)/);
    expect(motivo).not.toMatch(/\d{3}|%/);
  });
});

describe('Politica §8: vigencia del score externo en el registro manual', () => {
  const DIA = 24 * 60 * 60 * 1000;
  const ahora = Date.parse('2026-09-25T15:00:00Z');

  it('hasta 30 dias desde la consulta se registra; despues pide reconsultar', () => {
    expect(() => assertScoreExternoVigente(null, ahora)).not.toThrow();
    expect(() => assertScoreExternoVigente(new Date(ahora - 30 * DIA).toISOString(), ahora)).not.toThrow();
    expect(() => assertScoreExternoVigente(new Date(ahora - 31 * DIA).toISOString(), ahora)).toThrow(/reconsultar el buró/);
  });

  it('la re-evaluacion se mide contra la consulta del padre, no contra hoy', async () => {
    enqueue(
      'estudios',
      {
        data: {
          id: 'hijo', estado: 'solicitado', resultado: 'pendiente', expediente_id: 'exp-1', canon_evaluado: null,
          proveedor: 'datacredito', tipo: 'individual', estudio_padre_id: 'padre', referencia_proveedor: null,
        },
        error: null,
      },
      { data: { fecha_completado: new Date(Date.now() - 40 * DIA).toISOString(), canon_evaluado: 2_000_000, canon_evaluado_origen: 'inmueble' }, error: null },
    );
    await expect(
      registrarResultado('hijo', { resultado: 'aprobado', observaciones: 'soportes ok' } as never, 'u-1', undefined, 'operador_analista'),
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'DATOS_BURO_VENCIDOS' });
  });
});

describe('cascada: la banda de revision se lee con el promedio de las dos centrales', () => {
  const banda = 'Score externo 540 en la banda de revision manual obligatoria (450-599, Politica §3.1 / Adenda 2 §2)';

  it('si el promedio sale de la banda, el motivo de la primaria no sigue', () => {
    expect(motivosRevisionTrasCascada(banda, banda, null)).toBeNull();
  });

  it('los demas motivos (listas, ingreso) se quedan; la banda nueva entra si la hay', () => {
    const otro = 'Revisión manual obligatoria (Política §4.3): la relación canon / ingreso es 38%.';
    expect(motivosRevisionTrasCascada(`${banda} ${otro}`, banda, null)).toBe(otro);
    expect(motivosRevisionTrasCascada(banda, banda, 'Score externo 580 en la banda')).toBe('Score externo 580 en la banda');
    expect(motivosRevisionTrasCascada(otro, null, null)).toBe(otro);
  });
});

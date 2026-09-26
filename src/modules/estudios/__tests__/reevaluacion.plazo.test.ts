import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ============================================================
// Politica §11 (decision 7): 15 dias habiles para radicar la apelacion desde
// la notificacion del no aprobado, y Cofianza responde en 10. El plazo lo
// valida solicitarReEvaluacion, el historial (`puede_reevaluar`) y la URL de
// subida de soportes. Mock de Supabase con colas por tabla.
//
// P33: la re-evaluacion es solo del no aprobado y exige fundamento; el
// condicionado se resuelve con la revision manual.
// ============================================================

const { mockEnv, queues, enqueue, mockFrom, mockStorageFrom, mockResolver, mockOnEstudio, inserts, filtros } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const inserts: Array<{ table: string; fila: Res }> = [];
  const filtros: Array<{ table: string; col: string; val: unknown }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'eq', 'neq', 'is', 'in', 'or', 'gte', 'order', 'limit', 'range'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) chain[m] = () => chain;
    chain.insert = (fila: Res) => {
      inserts.push({ table, fila });
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      filtros.push({ table, col, val });
      return chain;
    };
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    inserts,
    filtros,
    mockEnv: new Proxy({} as Record<string, unknown>, {
      get: (_t, k) => (typeof k === 'string' && (k.endsWith('_ENABLED') || k.startsWith('MOTOR_')) ? false : 'x'),
    }),
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockFrom: vi.fn((table: string) => chainFor(table)),
    mockStorageFrom: vi.fn(() => ({
      createSignedUploadUrl: vi.fn(async () => ({ data: { signedUrl: 'https://up', token: 't' }, error: null })),
    })),
    mockOnEstudio: vi.fn(async (..._a: unknown[]) => undefined),
    // Lo que el analista registra pasa tal cual (sin reglas duras ni motor).
    mockResolver: vi.fn(async (a: { resultadoPropuesto: string; motivoRechazo?: string | null }) => ({
      resultado: a.resultadoPropuesto,
      observaciones: null,
      motivoRechazo: a.motivoRechazo ?? null,
      salida: null,
      veredicto: { rechaza: false, reglas: [] },
      apisFallidas: [],
      revisionManual: null,
    })),
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t), rpc: vi.fn(), storage: { from: mockStorageFrom } },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/email', () => ({ sendEstudioFormEmail: vi.fn() }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({})) }));
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
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onEstudioCompletado: mockOnEstudio }));
vi.mock('../tope-canon.guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tope-canon.guard')>()),
  assertCanonDentroDelTope: vi.fn(async () => undefined),
}));
vi.mock('../pago.guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pago.guard')>()),
  estudioYaCobrado: vi.fn(async () => true),
}));
vi.mock('../reglas-duras', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../reglas-duras')>()),
  resolverResultadoEstudio: mockResolver,
}));

import { supabase } from '@/lib/supabase';
import { logAudit } from '@/lib/auditLog';
import { getHistorialReEvaluacion, getSoportePresignedUrl, plazoApelacion, registrarResultado, solicitarReEvaluacion } from '../estudios.service';
import { reEvaluarSchema, registrarResultadoSchema } from '../estudios.schema';

const hace = (dias: number) => new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

const rechazado = (fechaCompletado: string) => ({
  id: 'est-1',
  expediente_id: 'exp-1',
  tipo: 'individual',
  estado: 'completado',
  resultado: 'rechazado',
  estudio_padre_id: null,
  fecha_completado: fechaCompletado,
});

function encolarHistorial(fechaCompletado: string) {
  enqueue(
    'estudios',
    { data: { expediente_id: 'exp-1', tipo: 'individual' }, error: null }, // guard
    { data: { id: 'est-1', estudio_padre_id: null }, error: null }, // raiz
    { data: [rechazado(fechaCompletado)], error: null }, // cadena
  );
  enqueue('estudios_documentos_soporte', { data: [], error: null });
}

beforeEach(() => {
  queues.clear();
  inserts.length = 0;
  filtros.length = 0;
  mockStorageFrom.mockClear();
  (supabase.rpc as unknown as Mock).mockReset();
});

describe('plazo de re-evaluacion (Politica §11)', () => {
  it('rechazado hace 40 dias corridos: el historial ya no ofrece re-evaluar', async () => {
    encolarHistorial(hace(40));
    const h = await getHistorialReEvaluacion('est-1', 'u-1', 'operador_analista');
    expect(h.puede_reevaluar).toBe(false);
    expect(h.plazo_vencido).toBe(true);
  });

  it('rechazado ayer: sigue dentro del plazo', async () => {
    encolarHistorial(hace(1));
    const h = await getHistorialReEvaluacion('est-1', 'u-1', 'operador_analista');
    expect(h.puede_reevaluar).toBe(true);
    expect(h.plazo_vencido).toBe(false);
  });

  it('fuera del plazo no se firma la URL de subida de soportes', async () => {
    enqueue('estudios', { data: rechazado(hace(40)), error: null });
    await expect(
      getSoportePresignedUrl(
        'est-1',
        { nombre_original: 'a.pdf', tipo_mime: 'application/pdf', tamano_bytes: 10, proposito: 'otros_soportes' } as never,
        'u-1',
        'operador_analista',
      ),
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'REEVALUACION_FUERA_DE_PLAZO' });
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });
});

describe('condicionado: se resuelve con la revision manual (P33)', () => {
  const condicionado = { ...rechazado(hace(1)), resultado: 'condicionado' };
  const soporte = { nombre_original: 'a.pdf', tipo_mime: 'application/pdf', tamano_bytes: 10, proposito: 'otros_soportes' };

  it('no se firman soportes ni el historial ofrece re-evaluar', async () => {
    enqueue('estudios', { data: condicionado, error: null });
    await expect(getSoportePresignedUrl('est-1', soporte as never, 'u-1', 'operador_analista'))
      .rejects.toMatchObject({ statusCode: 400, errorCode: 'ESTUDIO_NO_REEVALUABLE' });
    expect(mockStorageFrom).not.toHaveBeenCalled();

    enqueue(
      'estudios',
      { data: { expediente_id: 'exp-1', tipo: 'individual' }, error: null },
      { data: { id: 'est-1', estudio_padre_id: null }, error: null },
      { data: [condicionado], error: null },
    );
    enqueue('estudios_documentos_soporte', { data: [], error: null });
    expect((await getHistorialReEvaluacion('est-1', 'u-1', 'operador_analista')).puede_reevaluar).toBe(false);
  });

  it('A4: si la revision manual lo nego (expediente rechazado), se re-evalua como un rechazo', async () => {
    enqueue('estudios', { data: condicionado, error: null });
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'rechazado', estado_pre_cancelacion: null }, error: null });
    await getSoportePresignedUrl('est-1', soporte as never, 'u-1', 'operador_analista').catch(() => undefined);
    expect(mockStorageFrom).toHaveBeenCalled();

    enqueue(
      'estudios',
      { data: { expediente_id: 'exp-1', tipo: 'individual' }, error: null },
      { data: { id: 'est-1', estudio_padre_id: null }, error: null },
      { data: [condicionado], error: null },
    );
    enqueue('estudios_documentos_soporte', { data: [], error: null });
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'rechazado', estado_pre_cancelacion: null }, error: null });
    expect((await getHistorialReEvaluacion('est-1', 'u-1', 'operador_analista')).puede_reevaluar).toBe(true);
  });

  it('A4: el condicionado del co-arrendatario no se re-evalua aunque el caso se haya negado', async () => {
    enqueue('estudios', { data: { ...condicionado, tipo: 'con_coarrendatario' }, error: null });
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'rechazado', estado_pre_cancelacion: null }, error: null });
    await expect(getSoportePresignedUrl('est-1', soporte as never, 'u-1', 'operador_analista'))
      .rejects.toMatchObject({ errorCode: 'ESTUDIO_NO_REEVALUABLE' });
  });

  it('la re-evaluacion exige fundamento', () => {
    expect(reEvaluarSchema.safeParse({}).success).toBe(false);
    expect(reEvaluarSchema.safeParse({ observaciones: '   corto  ' }).success).toBe(false);
    expect(reEvaluarSchema.safeParse({ observaciones: 'Nuevo certificado laboral con ingresos' }).success).toBe(true);
  });

  const hija = (tipo: string) => ({
    id: 'est-2', estado: 'en_proceso', resultado: 'pendiente', expediente_id: 'exp-1',
    canon_evaluado: 2_000_000, proveedor: 'manual', tipo,
  });
  const aprobar = () =>
    registrarResultado('est-2', { resultado: 'aprobado', score: 700 } as never, 'u-1', undefined, 'operador_analista');
  // Error del RPC: prueba que el registro paso el guard y llego a escribir.
  const rpcLlega = () =>
    (supabase.rpc as unknown as Mock).mockResolvedValue({ error: { message: 'Solo se puede registrar resultado' } });

  it('un aprobado registrado a mano no saca al titular de condicionado', async () => {
    enqueue('estudios', { data: hija('individual'), error: null });
    enqueue('expedientes', { data: { estado: 'condicionado' }, error: null });
    await expect(aprobar()).rejects.toMatchObject({ statusCode: 400, errorCode: 'EVALUACION_REQUERIDA' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('la apelacion de un rechazado y el estudio del co-arrendatario si se registran', async () => {
    rpcLlega();
    enqueue('estudios', { data: hija('individual'), error: null });
    enqueue('expedientes', { data: { estado: 'rechazado' }, error: null });
    await expect(aprobar()).rejects.toMatchObject({ errorCode: 'ESTUDIO_ESTADO_INVALIDO' });

    enqueue('estudios', { data: hija('con_coarrendatario'), error: null });
    enqueue('expedientes', { data: { estado: 'condicionado' }, error: null });
    await expect(aprobar()).rejects.toMatchObject({ errorCode: 'ESTUDIO_ESTADO_INVALIDO' });
    expect(supabase.rpc).toHaveBeenCalledTimes(2);
  });
});

// P34 por «Registrar resultado»: el rechazo del analista lleva un fundamento
// interno y un motivo corto; el gestor solo ve el motivo.
describe('registrar un rechazo a mano (P34)', () => {
  const base = { resultado: 'rechazado', observaciones: 'Reporte SIFIN revisado' };

  it('pide el fundamento interno y un motivo corto para el gestor', () => {
    expect(registrarResultadoSchema.safeParse({ ...base, motivo_rechazo: 'No cumple la política de Cofianza' }).success).toBe(false);
    expect(registrarResultadoSchema.safeParse({ ...base, fundamento: 'Dos obligaciones castigadas' }).success).toBe(false);
    const ok = { ...base, fundamento: 'Dos obligaciones castigadas', motivo_rechazo: 'No cumple la política de Cofianza' };
    expect(registrarResultadoSchema.safeParse(ok).success).toBe(true);
    expect(registrarResultadoSchema.safeParse({ ...ok, motivo_rechazo: 'x'.repeat(501) }).success).toBe(false);
  });

  it('el fundamento va al timeline y a la bitácora; el motivo, al banner (vía el orquestador)', async () => {
    (supabase.rpc as unknown as Mock).mockResolvedValue({ error: null });
    enqueue(
      'estudios',
      { data: { id: 'est-2', estado: 'en_proceso', resultado: 'pendiente', expediente_id: 'exp-1', canon_evaluado: 2_000_000, proveedor: 'manual', tipo: 'individual' }, error: null },
      { data: { tipo: 'individual' }, error: null }, // hook post-resultado
    );
    const input = { ...base, fundamento: 'Dos obligaciones castigadas', motivo_rechazo: 'No cumple la política de Cofianza' };
    await registrarResultado('est-2', input as never, 'u-1', undefined, 'operador_analista').catch(() => undefined);

    const rpc = (supabase.rpc as unknown as Mock).mock.calls[0][1] as Record<string, unknown>;
    expect(rpc.p_motivo_rechazo).toBe('No cumple la política de Cofianza');
    expect(JSON.stringify(rpc)).not.toContain('castigadas');
    expect(inserts).toContainEqual({
      table: 'eventos_timeline',
      fila: expect.objectContaining({ metadata: { estudio_id: 'est-2', fundamento: 'Dos obligaciones castigadas' } }),
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ detalle: expect.objectContaining({ fundamento: 'Dos obligaciones castigadas' }) }));
    await vi.waitFor(() =>
      expect(mockOnEstudio).toHaveBeenCalledWith(expect.objectContaining({ motivoAnalista: 'No cumple la política de Cofianza' })),
    );
  });
});

// P33: el fundamento de la re-evaluación es interno. Iba a `observaciones` del
// estudio hijo, que ve el gestor y que después sobrescribe el resultado.
describe('fundamento de la re-evaluación', () => {
  it('queda en el timeline y la bitácora, no en el estudio', async () => {
    enqueue(
      'estudios',
      {
        data: {
          ...rechazado(hace(1)), proveedor: 'manual', duracion_contrato_meses: 12, pago_por: 'inmobiliaria',
          canon_evaluado: 2_000_000, canon_evaluado_origen: 'inmueble', datos_formulario: { tipo_documento: 'cc', numero_documento: '123' },
        },
        error: null,
      },
      { data: null, error: null }, // sin re-evaluación previa
      { data: { id: 'est-2' }, error: null }, // hijo creado
    );
    enqueue('estudios_documentos_soporte', { data: { created_at: hace(1) }, error: null });

    await solicitarReEvaluacion('est-1', { observaciones: 'Certificado laboral nuevo' }, 'u-1', undefined, 'operador_analista').catch(() => undefined);

    const hijo = inserts.find((i) => i.table === 'estudios')?.fila;
    expect(hijo).toMatchObject({ estudio_padre_id: 'est-1', observaciones: null });
    // Re-evalúa el mismo reporte: hereda el canon evaluado y el documento (§5.2).
    expect(hijo).toMatchObject({
      canon_evaluado: 2_000_000,
      canon_evaluado_origen: 'inmueble',
      datos_formulario: { tipo_documento: 'cc', numero_documento: '123' },
    });
    expect(inserts).toContainEqual({
      table: 'eventos_timeline',
      fila: expect.objectContaining({ metadata: expect.objectContaining({ fundamento: 'Certificado laboral nuevo' }) }),
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ detalle: expect.objectContaining({ fundamento: 'Certificado laboral nuevo' }) }));
  });
});

// Decision 7 (Politica §11): el plazo corre desde la NOTIFICACION del no
// aprobado, en dias habiles de Colombia (con festivos). 2026-10-12 es festivo.
describe('plazo de la apelacion: notificacion, festivos y radicacion (decision 7)', () => {
  const NOTIFICACION = '2026-10-01T15:00:00Z'; // jueves
  const soporte = { nombre_original: 'a.pdf', tipo_mime: 'application/pdf', tamano_bytes: 10, proposito: 'otros_soportes' };
  const hoyEs = (iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  };
  afterEach(() => vi.useRealTimers());

  it('con festivo: el dia 15 habil cae un dia despues (23-oct, no 22-oct)', () => {
    expect(plazoApelacion(NOTIFICACION, null, new Date('2026-10-23T20:00:00Z'))).toEqual({
      apelar_hasta: '2026-10-23', responder_hasta: null, vencido: false,
    });
    expect(plazoApelacion(NOTIFICACION, null, new Date('2026-10-26T15:00:00Z')).vencido).toBe(true);
    // Por fecha de Bogota: las 22:00 del 1-oct en Bogota siguen siendo el 1-oct.
    expect(plazoApelacion('2026-10-02T03:00:00Z', null, new Date('2026-10-23T20:00:00Z')).apelar_hasta).toBe('2026-10-23');
    // Cofianza responde en 10 dias habiles desde la radicacion (2-nov es festivo).
    expect(plazoApelacion(NOTIFICACION, '2026-10-22T15:00:00Z').responder_hasta).toBe('2026-11-06');
  });

  it('rechazo: cuenta desde el registro del resultado, no desde fecha_completado', async () => {
    hoyEs('2026-10-30T15:00:00Z');
    // Re-evaluacion rechazada: fecha_completado anclada en la consulta del padre.
    enqueue('estudios', { data: rechazado('2026-08-01T15:00:00Z'), error: null });
    enqueue('eventos_timeline', { data: { created_at: '2026-10-20T15:00:00Z' }, error: null });
    await getSoportePresignedUrl('est-1', soporte as never, 'u-1', 'operador_analista');
    expect(mockStorageFrom).toHaveBeenCalled();
    expect(filtros).toEqual(expect.arrayContaining([
      { table: 'eventos_timeline', col: 'metadata->>estudio_id', val: 'est-1' },
      { table: 'eventos_timeline', col: 'metadata->>resultado', val: 'rechazado' },
    ]));
  });

  it('condicionado negado tarde: el plazo corre desde que Cofianza lo nego', async () => {
    hoyEs('2026-10-30T15:00:00Z');
    const condicionado = { ...rechazado('2026-09-01T15:00:00Z'), resultado: 'condicionado' };
    enqueue(
      'estudios',
      { data: { expediente_id: 'exp-1', tipo: 'individual' }, error: null },
      { data: { id: 'est-1', estudio_padre_id: null }, error: null },
      { data: [condicionado], error: null },
    );
    enqueue('estudios_documentos_soporte', { data: [], error: null });
    enqueue('expedientes', { data: { id: 'exp-1', estado: 'rechazado', estado_pre_cancelacion: null }, error: null });
    enqueue('eventos_timeline', { data: { created_at: '2026-10-20T15:00:00Z' }, error: null });

    const h = await getHistorialReEvaluacion('est-1', 'u-1', 'operador_analista');
    expect(h).toMatchObject({ puede_reevaluar: true, plazo_vencido: false, apelar_hasta: '2026-11-11', responder_hasta: null });
    expect(filtros).toEqual(expect.arrayContaining([
      { table: 'eventos_timeline', col: 'tipo', val: 'estado' },
      { table: 'eventos_timeline', col: 'estado_nuevo', val: 'rechazado' },
    ]));
  });

  const solicitarElDia20 = (primerSoporte: string | null) => {
    hoyEs('2026-10-30T15:00:00Z'); // dia habil 20 desde la notificacion
    enqueue(
      'estudios',
      {
        data: { ...rechazado(NOTIFICACION), proveedor: 'manual', duracion_contrato_meses: 12, pago_por: 'inmobiliaria' },
        error: null,
      },
      { data: null, error: null }, // sin re-evaluacion previa
      { data: { id: 'est-2' }, error: null }, // hijo creado
    );
    enqueue('estudios_documentos_soporte', { data: primerSoporte ? { created_at: primerSoporte } : null, error: null });
    enqueue('eventos_timeline', { data: { created_at: NOTIFICACION }, error: null });
    return solicitarReEvaluacion('est-1', { observaciones: 'Certificado laboral nuevo' }, 'u-1', undefined, 'operador_analista');
  };

  it('radicada a tiempo (dia 14) y re-evaluada el dia 20: se registra', async () => {
    await solicitarElDia20('2026-10-22T15:00:00Z').catch(() => undefined);
    expect(inserts.find((i) => i.table === 'estudios')?.fila).toMatchObject({ estudio_padre_id: 'est-1' });
  });

  it('radicada el dia 16, o sin soportes el dia 20: fuera de plazo', async () => {
    await expect(solicitarElDia20('2026-10-26T15:00:00Z'))
      .rejects.toMatchObject({ statusCode: 400, errorCode: 'REEVALUACION_FUERA_DE_PLAZO', details: { apelar_hasta: '2026-10-23' } });
    queues.clear();
    await expect(solicitarElDia20(null)).rejects.toMatchObject({ errorCode: 'REEVALUACION_FUERA_DE_PLAZO' });
    expect(inserts.some((i) => i.table === 'estudios')).toBe(false);
  });
});

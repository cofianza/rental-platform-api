/**
 * Matriz de casos de prueba del motor — VERSION 2.0 (Gerencia, QA_MOTOR_COFIANZA_V2.xlsx
 * + QA_MOTOR_NOTA_ANEXA_V2.docx). Condicion para encender MOTOR_DECIDE_ENABLED.
 *
 * Corre contra el codigo REAL, sin replicas: un reporte de DataCredito /
 * TransUnion simulado entra por resolverResultadoEstudio (extractor ->
 * scorecard -> reglas duras -> motivos de revision) y decidirConCascada
 * (cascada, segunda central, decision y traza de estudios.cascada). Solo el I/O
 * esta simulado: Supabase, el panel (defaults de la Adenda), el canon y la
 * segunda central. La ponderacion con el coarrendatario usa veredictoScorecard
 * (lo que decide ponderarConScorecard) sobre la fila sombra real
 * (construirFilaSombra), y el caso L usa decidirSinCentrales, lo mismo que
 * registra procesarEstudioAsync (su flujo: ejecutar.cierre.test.ts).
 *
 * Criterios de la nota (§2): decision vinculante; normalizado ±0,5; bruto y
 * desglose EXACTOS; las reglas duras no calculan puntaje (§2.4, sinPuntaje en
 * C, P, Q, S y M); traza (centrales consultadas, ingreso bruto y ajustado,
 * motivo, fuente, denominador).
 * Cada fila es un `it` con expect.soft: un criterio que falla no oculta los demas.
 * Lo que depende de Mario queda como it.todo o comentado en la fila.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const { ops, mockEnv, mockCanon, mockSecundaria, mockSolicitar } = vi.hoisted(() => {
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  return {
    ops,
    mockEnv: new Proxy({}, { get: (_t, k) => (typeof k === 'string' && (k.endsWith('_ENABLED') || k.startsWith('MOTOR_')) ? false : 'x') }),
    mockCanon: { valor: null as number | null },
    mockSecundaria: { score: null as number | null, payload: null as unknown },
    mockSolicitar: vi.fn(async () => ({ referencia_proveedor: 'QA-SEC', status: 'completed' })),
  };
});

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'insert', 'upsert', 'eq', 'in', 'order', 'limit']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => ({ data: null, error: null });
    chain.single = async () => ({ data: null, error: null });
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
    return chain;
  };
  return { supabase: { from: (t: string) => chainFor(t), rpc: vi.fn(), storage: { from: vi.fn() } } };
});
vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/email', () => ({ sendEstudioFormEmail: vi.fn() }));
vi.mock('@/lib/calibracion', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/calibracion')>();
  return { ...m, getCalibracion: vi.fn(async () => m.CALIBRACION_DEFAULT) };
});
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(),
  findPerfilIdByEmail: vi.fn(),
  notificarResponsableExpediente: vi.fn(),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));
vi.mock('@/modules/estudios/tope-canon.guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/estudios/tope-canon.guard')>()),
  leerCanonDelInmueble: vi.fn(async () => mockCanon.valor),
}));
vi.mock('@/modules/estudios/providers/factory', () => ({
  getProvider: vi.fn(() => ({
    solicitar: mockSolicitar,
    obtenerResultado: vi.fn(async () => ({ resultado: 'aprobado', score: mockSecundaria.score, datos_crudos: mockSecundaria.payload })),
  })),
  getAllProviderIds: vi.fn(() => ['transunion', 'datacredito']),
}));
vi.mock('@/modules/autorizaciones/ingreso-declarado', () => ({ contrasteIngresoProspecto: vi.fn(async () => null) }));
vi.mock('@/modules/autorizaciones/biometria', () => ({
  leerBiometriaDeExpediente: vi.fn(async () => null),
  requiereRevisionManualPorBiometria: () => null,
}));

import type { EntradaSombra, SalidaSombra, CodigoVariable } from '../index';
import { construirFilaSombra } from '../fila';
import { CONFLICTO_REGLAS_COARRENDATARIO, CONFLICTO_REGLAS_R2, decidirCascada, decidirResultado, decidirSinCentrales, type UmbralesDecision } from '../../decision';
import { resolverResultadoEstudio } from '../../reglas-duras';
import { decidirConCascada } from '../../estudios.service';
import type { ProviderSolicitudInput } from '../../providers/types';
import { ponderarConCoarrendatario, veredictoScorecard, type FilaScorecard } from '../../../coarrendatarios/ponderacion';
import { calcularTarifas, viaPorRutaDeAprobacion } from '../../tarifas';
import { CALIBRACION_DEFAULT as CAL } from '@/lib/calibracion';

// ── Parametros vigentes (defaults del panel = los de la Adenda) ─────────────
const U: UmbralesDecision = {
  cascadaRechazo: CAL.UMBRAL_CASCADA_RECHAZO, // 40
  cascadaAprobacion: CAL.UMBRAL_CASCADA_APROBACION, // 90
  aprobacion: CAL.UMBRAL_APROBACION_AUTOMATICA, // 85
  zonaGris: CAL.UMBRAL_ZONA_GRIS, // 70
  coarrendatario: CAL.UMBRAL_COARRENDATARIO, // 80
};
const HOY = '2026-09-25T12:00:00.000Z';
const CONSULTA = '2026-09-20';
const CORTE = '2026-08-31';

/** Fin de mes `atras` meses antes de agosto 2026 (0 = 2026-08-31). */
const finDeMes = (atras: number) => new Date(Date.UTC(2026, 8 - atras, 0)).toISOString().slice(0, 10);

// Ingreso crudo 2.000.000 x FACTOR 1,15 = 2.300.000 ajustado: los % de la
// matriz (DTI, canon/ingreso) se leen sobre el AJUSTADO (caso Q lo dice literal).
const INGRESO_CRUDO = 2_000_000;
const AJUSTADO = Math.round(INGRESO_CRUDO * CAL.FACTOR_AJUSTE_INGRESO);
const pctAjustado = (pct: number) => (pct / 100) * AJUSTADO;

// ── Reporte simulado de DataCredito HDC Plus (forma real del provider) ──────
interface PerfilDC {
  score: number;
  /** Pesos, multiplo de 1000. null = DW con reason 50 (ingreso no estimable). */
  ingresoCop?: number | null;
  cuotaCop: number;
  /** economicSector de cada obligacion ('1' financiero, '3' real, '4' telco). [] = sin historial. */
  sectores: string[];
  mesesObservados: number;
  /** behaviourDate (fin de mes) con marca '1' (mora 30-59 dias). */
  moraEn?: string[];
  /** null = la central no reporta la primera obligacion. */
  maturationSince: string | null;
  moraVigente?: boolean;
}

function reporteDC(p: PerfilDC): Record<string, unknown> {
  const ingreso = p.ingresoCop === undefined ? INGRESO_CRUDO : p.ingresoCop;
  const liabilities: unknown[] = p.sectores.map((s) => ({
    account: { economicSector: s },
    status: { payment: { businessBureauEvent: '01' } },
    values: [{ behaviourDate: CORTE, businessValueBalanceOverdue: 0 }],
  }));
  if (p.moraVigente) {
    liabilities.push({
      account: { economicSector: '1', businessLineName: 'BANCO QA' },
      status: { payment: { businessBureauEvent: '17', businessBureauEventDesc: 'ESTA EN MORA 30' } },
      values: [{ behaviourDate: CORTE, businessValueBalanceOverdue: 350, delinquencyMaturation: 45 }],
    });
  }
  return {
    ReportHDCplus: {
      productResult: { consultDate: CONSULTA },
      models: [{ modelCode: 'DF', scoreValue: p.score }],
      productValueList: [[ingreso === null ? { productCode: 'DW', value: 0, reason: 50 } : { productCode: 'DW', value: ingreso / 1000, reason: 0 }]],
      agregatedInfo: {
        overview: {
          principals: { currentCredits: liabilities.length, closedCredits: 0, ...(p.maturationSince ? { maturationSince: p.maturationSince } : {}) },
          balances: { valueMonthlyPayment: p.cuotaCop / 1000, totaldebtBalance: 0, totalValueBalanceOverdue: 0, debtBalanceD30: 0, debtBalanceD60: 0, debtBalanceD90: 0 },
          behavior: {
            month: Array.from({ length: p.mesesObservados }, (_, i) => ({
              behaviourDate: finDeMes(i),
              behaviour: p.moraEn?.includes(finDeMes(i)) ? '1' : 'N',
            })),
          },
        },
      },
      liabilities,
      creditCard: [],
    },
  };
}

/** Reporte simulado de TransUnion combo 1901 (sin estimador de ingreso). */
function reporteTU(score: number): Record<string, unknown> {
  return {
    Tercero: { Fecha: CONSULTA },
    CreditVision_5694: { fechaCorte: [{ valor: CORTE, variables: [{ nombre: 'CREDITVISION', valor: score }] }] },
    Informacion_Comercial_154: {
      Consolidado: { Registro: { PaqueteInformacion: 'Total', NumeroObligaciones: 1, CantidadObligacionesMora: 0, ValorMora: 0 } },
      SectorFinancieroAlDia: {
        Obligacion: [{ FechaApertura: '31/01/2015', LineaCredito: 'TDC', MoraMaxima: 0, Comportamientos: `|${Array(24).fill('N').join('|')}|` }],
      },
    },
  };
}

const dc = (p: PerfilDC, canonPct: number): EntradaSombra => ({
  proveedor: 'datacredito',
  payload: reporteDC(p),
  canon_mensual_cop: pctAjustado(canonPct),
});

/** Insumo del buro: con el, decidirConCascada PUEDE consultar la segunda central. */
const INSUMO: ProviderSolicitudInput = {
  estudio_id: 'est-qa',
  tipo: 'individual',
  nombre_completo: 'QA Matriz',
  tipo_documento: 'cc',
  numero_documento: '1020304050',
  email: 'qa@cofianza.co',
  telefono: '3000000000',
};

type TrazaCascada = ReturnType<typeof decidirSinCentrales>['traza'];

/**
 * Camino REAL de un estudio con el motor encendido (registrarResultadoInline):
 * resolverResultadoEstudio sobre la primaria -> decidirConCascada. Sin
 * `insumo` ni `scoreSecundario` la cascada decide con la primaria como fuente
 * unica (lo que la matriz asume cuando no da score de TransUnion).
 */
async function decidir(primaria: EntradaSombra, o: { scoreSecundario?: number; insumo?: boolean; centralCaida?: string } = {}) {
  ops.length = 0;
  mockSolicitar.mockClear();
  mockCanon.valor = primaria.canon_mensual_cop ?? null;
  mockSecundaria.score = o.scoreSecundario ?? null;
  mockSecundaria.payload = o.scoreSecundario !== undefined ? reporteTU(o.scoreSecundario) : null;
  const proveedor = primaria.proveedor as string;
  const payload = (primaria.payload ?? null) as Record<string, unknown> | null;

  const res = await resolverResultadoEstudio({
    estudioId: 'est-qa',
    expedienteId: 'exp-qa',
    resultadoPropuesto: 'aprobado',
    proveedor,
    datosCrudos: payload,
    antecedentes: null,
    tipoDocumento: 'cc',
    tipoEstudio: 'individual',
  });
  const salidaPrimaria = res.salida as SalidaSombra;
  const c = await decidirConCascada({
    estudioId: 'est-qa',
    expedienteId: 'exp-qa',
    proveedorPrimario: proveedor,
    payloadPrimario: payload,
    resultadoBuro: 'aprobado',
    salidaPrimaria,
    veredictoPrimario: res.veredicto,
    revisionManual: res.revisionManual,
    providerInput: o.insumo || o.scoreSecundario !== undefined ? INSUMO : undefined,
    antecedentes: null,
    centralCaida: o.centralCaida ?? null,
  });
  const traza = ops
    .filter((op) => op.table === 'estudios' && op.method === 'update')
    .map((op) => op.args[0] as { cascada?: TrazaCascada })
    .find((a) => a.cascada)?.cascada as TrazaCascada;
  return {
    res,
    salidaPrimaria,
    salida: c.salida,
    veredicto: c.veredicto,
    cascada: decidirCascada(salidaPrimaria, res.veredicto.rechaza ? res.veredicto.reglas : [], U),
    d: { resultado: c.resultado, motivo: c.motivo, via: c.via },
    traza,
  };
}

/** Contrato de decision.ts con el coarrendatario en la mano (mismos insumos que usa decidirConCascada). */
const conCoarrendatario = (r: Awaited<ReturnType<typeof decidir>>, coa: { puntaje: number; reglaDura: boolean }) =>
  decidirResultado({
    salida: r.salida,
    reglasDurasActivas: r.veredicto.rechaza ? r.veredicto.reglas : [],
    u: U,
    coarrendatario: coa,
    motivosRevision: r.res.revisionManual ? [r.res.revisionManual] : [],
  });

/**
 * Camino real de la ponderacion (onCoarrendatarioEstudioCompletado): el
 * titular se decide solo y, al llegar el coarrendatario, veredictoScorecard
 * sobre las filas sombra de cada uno -> ponderarConCoarrendatario. El
 * coarrendatario va como puntaje suelto o como su corrida real del motor.
 */
function ponderar(r: Awaited<ReturnType<typeof decidir>>, coa: number | SalidaSombra) {
  const v = veredictoScorecard({
    titular: construirFilaSombra('est-titular', r.salida, {}) as unknown as FilaScorecard,
    coa: typeof coa === 'number' ? { puntaje_normalizado: coa } : (construirFilaSombra('est-coa', coa, {}) as unknown as FilaScorecard),
    coaConReglaDura: false,
    u: U,
  });
  const combinado = ponderarConCoarrendatario({ titular: r.d.resultado, coaConReglaDura: false, scorecard: v?.resultado ?? null });
  return { v, combinado };
}

/** Desglose en el vocabulario de la matriz. null (no calculable, cuenta 0) se lee 0. */
function desglose(s: SalidaSombra) {
  const pts = (v: CodigoVariable) => s.puntajes.find((p) => p.variable === v)?.puntos ?? 0;
  return { score: pts('V1'), dti: pts('V2'), canon: pts('V3'), exp: pts('V5'), comp: pts('V6'), ant: pts('V8') };
}

/** Normalizacion: bruto EXACTO, normalizado ±0,5, desglose EXACTO, denominador 96 registrado. */
function normalizacion(s: SalidaSombra, bruto: number, normalizado: number, esperado: ReturnType<typeof desglose>) {
  expect.soft(s.puntaje_bruto, 'bruto exacto').toBe(bruto);
  expect.soft(Math.abs((s.puntaje_normalizado ?? -99) - normalizado), `normalizado ${s.puntaje_normalizado} vs ${normalizado} ±0,5`).toBeLessThanOrEqual(0.5);
  expect.soft(desglose(s), 'desglose por variable exacto').toEqual(esperado);
  expect.soft(s.denominador_normalizacion, 'denominador registrado en la salida').toBe(96);
  expect.soft(s.variables_participantes, 'variables que participaron').toEqual(['V1', 'V2', 'V3', 'V5', 'V6', 'V8']);
  const fila = construirFilaSombra('est-qa', s, {});
  expect.soft((fila.features_crudas as Record<string, unknown>).denominador_normalizacion, 'denominador en la fila sombra').toBe(96);
}

/**
 * §2.4: "Las reglas duras no calculan puntaje [...] el motor debe rechazar sin
 * calcular las variables restantes. Si el motor devuelve un puntaje en esos
 * casos, la prueba falla aunque la decision sea correcta." Salida del motor,
 * fila sombra y traza de la cascada, sin puntaje y con la regla como motivo.
 */
function sinPuntaje(r: Awaited<ReturnType<typeof decidir>>, regla: string) {
  const s = r.salida;
  expect.soft([s.puntaje_normalizado, s.puntaje_bruto, s.puntaje_maximo_alcanzable], 'salida del motor sin puntaje').toEqual([null, null, null]);
  expect.soft(s.puntajes.filter((p) => p.reglaDura === null).map((p) => p.variable), 'sin las variables restantes').toEqual([]);
  expect.soft(s.decision_sombra, 'decision del motor').toBe('rechazado');
  expect.soft(s.decision_motivo, 'motivo del motor = la regla dura').toContain(regla);
  expect.soft(r.d.motivo, 'motivo de la decision = la regla dura').toContain(regla);
  const fila = construirFilaSombra('est-qa', s, {});
  expect.soft([fila.decision_sombra, fila.puntaje_normalizado, fila.puntaje_bruto], 'fila sombra: rechazado sin puntaje').toEqual(['rechazado', null, null]);
  expect.soft(fila.reglas_duras_activadas, 'fila sombra: la regla').toContain(regla);
  expect.soft(fila.motivo_no_calculable, 'fila sombra: por que no hay puntaje').toContain(regla);
  expect.soft(Object.values(fila.puntaje_por_variable as Record<string, { regla_dura: string | null }>).every((p) => p.regla_dura), 'fila sombra: solo la variable de la regla').toBe(true);
  if (r.traza) expect.soft([r.traza.puntaje_primaria, r.traza.puntaje_final], 'traza de la cascada sin puntaje').toEqual([null, null]);
}

/** §2.5: traza de una sola central (la primaria), sin segunda consulta. */
function unaCentral(r: Awaited<ReturnType<typeof decidir>>) {
  expect.soft(mockSolicitar, 'no se consulta TransUnion').not.toHaveBeenCalled();
  expect.soft(r.traza?.centrales_consultadas, 'traza: centrales consultadas').toEqual(['datacredito']);
  expect.soft(r.traza?.secundaria_consultada, 'traza: secundaria_consultada').toBe(false);
}

// Las fechas del motor (antiguedad, ventana de 24 meses) se miden contra HOY.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(HOY));
});
afterAll(() => {
  vi.useRealTimers();
});

// ── Perfiles base de la matriz ──────────────────────────────────────────────
const MAS_8_ANIOS = '2010-01-31';
const CINCO_A_8 = '2020-01-31';
const DOS_A_5 = '2023-01-31';
/** Caso B: independiente formal, 670, DTI 38%, canon 30%, sin mora 24m, 5-8 anios. */
const PERFIL_B: PerfilDC = { score: 670, cuotaCop: pctAjustado(38), sectores: ['1'], mesesObservados: 24, maturationSince: CINCO_A_8 };
const DESGLOSE_B = { score: 40, dti: 8, canon: 7, exp: 6, comp: 10, ant: 4 };
/** Caso R: 600, DTI 60%, canon 35%, sin experiencia (solo telcos), sin antiguedad reportada. */
const PERFIL_R: PerfilDC = { score: 600, cuotaCop: pctAjustado(60), sectores: ['4'], mesesObservados: 24, maturationSince: null };

// ============================================================================
// 7.1 Reglas duras: C, P, Q, S
// ============================================================================
describe('7.1 Reglas duras (§2.4: sin puntaje)', () => {
  it('C — mora VIGENTE: RECHAZADO (RECHAZO_MORA_VIGENTE), sin puntaje', async () => {
    const r = await decidir(dc({ score: 750, cuotaCop: pctAjustado(30), sectores: ['1'], mesesObservados: 24, maturationSince: MAS_8_ANIOS, moraVigente: true }, 25), { insumo: true });
    expect.soft(r.d.resultado, 'decision').toBe('rechazado');
    expect.soft(r.veredicto.reglas, 'regla').toContain('mora_vigente');
    unaCentral(r);
    expect.soft(r.salida.features.mora_vigente_desde, 'fecha de ocurrencia registrada').toBe('2026-07-17');
    sinPuntaje(r, 'mora_vigente');
  });

  it('P — DTI 70% con score 800: RECHAZADO (RECHAZO_DTI_MAYOR_65), sin puntaje', async () => {
    const r = await decidir(dc({ score: 800, cuotaCop: pctAjustado(70), sectores: ['1'], mesesObservados: 24, maturationSince: MAS_8_ANIOS }, 25), { insumo: true });
    expect.soft(r.d.resultado, 'decision').toBe('rechazado');
    expect.soft(r.veredicto.reglas, 'regla').toEqual(['dti_mayor_65']);
    unaCentral(r);
    sinPuntaje(r, 'dti_mayor_65');
  });

  it('Q — canon 45% del ingreso AJUSTADO: RECHAZADO (RECHAZO_CANON_MAYOR_40), sin puntaje', async () => {
    const r = await decidir(dc({ score: 800, cuotaCop: pctAjustado(20), sectores: ['1'], mesesObservados: 24, maturationSince: MAS_8_ANIOS }, 45), { insumo: true });
    expect.soft(r.salida.canon_ingreso_pct, 'canon/ingreso sobre el ajustado').toBe(45);
    expect.soft(r.d.resultado, 'decision').toBe('rechazado');
    expect.soft(r.veredicto.reglas, 'regla').toEqual(['canon_ingreso_mayor_40']);
    sinPuntaje(r, 'canon_ingreso_mayor_40');
  });

  it('S — score 440: RECHAZADO sin segunda consulta (RECHAZO_SCORE_MENOR_450), sin puntaje', async () => {
    const r = await decidir(dc({ score: 440, cuotaCop: pctAjustado(20), sectores: ['1'], mesesObservados: 24, maturationSince: MAS_8_ANIOS }, 25), { insumo: true });
    expect.soft(r.d.resultado, 'decision').toBe('rechazado');
    expect.soft(r.veredicto.reglas, 'regla').toEqual(['score_menor_450']);
    expect.soft(r.cascada.consultarSecundaria, 'sin segunda consulta').toBe(false);
    unaCentral(r);
    sinPuntaje(r, 'score_menor_450');
  });
});

// ============================================================================
// 7.2 Normalizacion (denominador 96): A, B, D, E
// ============================================================================
describe('7.2 Normalizacion', () => {
  it('A — perfil automatico perfecto: 96/96 = 100, APROBADO AUTOMATICO', async () => {
    const r = await decidir(dc({ score: 820, cuotaCop: pctAjustado(20), sectores: ['1'], mesesObservados: 24, maturationSince: MAS_8_ANIOS }, 25), { insumo: true });
    normalizacion(r.salida, 96, 100, { score: 50, dti: 15, canon: 10, exp: 6, comp: 10, ant: 5 });
    expect.soft(r.d.resultado, 'decision').toBe('aprobado');
    expect.soft(r.d.via, 'via').toBe('automatica');
  });

  it('B — 75/96 = 78,1 sin coarrendatario: REVISION MANUAL', async () => {
    // La matriz no da score de TransUnion: se decide con la primaria como fuente unica.
    const r = await decidir(dc(PERFIL_B, 30));
    normalizacion(r.salida, 75, 78.1, DESGLOSE_B);
    expect.soft(r.d.resultado, 'decision').toBe('condicionado');
    expect.soft(r.d.via, 'via').toBe('revision_manual');
  });

  it('D — joven sin historial, score 480: 40/96 = 41,7 pero la banda 450-599 fuerza REVISION MANUAL', async () => {
    const r = await decidir(dc({ score: 480, cuotaCop: pctAjustado(20), sectores: [], mesesObservados: 0, maturationSince: null }, 25));
    normalizacion(r.salida, 40, 41.7, { score: 10, dti: 15, canon: 10, exp: 0, comp: 5, ant: 0 });
    expect.soft(r.d.resultado, 'decision').toBe('condicionado');
    expect.soft(r.d.motivo, 'motivo = banda de score').toMatch(/480/);
  });

  it('E — pensionado, score 700: 90/96 = 93,8, APROBADO AUTOMATICO', async () => {
    const r = await decidir(dc({ score: 700, cuotaCop: pctAjustado(25), sectores: ['1'], mesesObservados: 24, maturationSince: MAS_8_ANIOS }, 25), { insumo: true });
    normalizacion(r.salida, 90, 93.8, { score: 44, dti: 15, canon: 10, exp: 6, comp: 10, ant: 5 });
    expect.soft(r.d.resultado, 'decision').toBe('aprobado');
  });
});

// ============================================================================
// 7.3 Cascada: H, I, J, K, L
// ============================================================================
describe('7.3 Cascada de centrales', () => {
  it('H — normalizado 32,3 < 40: RECHAZADO consultando UNA sola central', async () => {
    // "Sin antiguedad" con una mora de hace 10 meses solo es coherente si la
    // central no reporta la primera obligacion (V8 no calculable, cuenta 0).
    const r = await decidir(dc({ score: 600, cuotaCop: pctAjustado(60), sectores: ['4'], mesesObservados: 24, moraEn: [finDeMes(9)], maturationSince: null }, 25), { insumo: true });
    normalizacion(r.salida, 31, 32.3, { score: 34, dti: 2, canon: 10, exp: 0, comp: -15, ant: 0 });
    expect.soft(r.cascada.resultadoAnticipado, 'salida de rechazo de la cascada').toBe('rechazado');
    unaCentral(r);
    expect.soft(r.d.resultado, 'decision').toBe('rechazado');
  });

  it('I — normalizado 95,8 >= 90: APROBADO consultando UNA sola central', async () => {
    const r = await decidir(dc({ score: 760, cuotaCop: pctAjustado(25), sectores: ['1'], mesesObservados: 24, maturationSince: CINCO_A_8 }, 25), { insumo: true });
    normalizacion(r.salida, 92, 95.8, { score: 47, dti: 15, canon: 10, exp: 6, comp: 10, ant: 4 });
    expect.soft(r.cascada.resultadoAnticipado, 'salida de aprobacion de la cascada').toBe('aprobado');
    unaCentral(r);
    expect.soft(r.d.resultado, 'decision').toBe('aprobado');
  });

  // Pendiente confirmacion de Mario: la fila J de la matriz (DC 670, TU 830)
  // se contradice con G (|670 - 830| = 160 > 80 dispara el Caso G, revision
  // manual). Se prueba con los valores PROPUESTOS a Mario: DC 710 y TU 790 ->
  // promedio 750, diferencia exactamente 80 (no > 80), mismo 85,4 y APROBADO.
  it('J — DC 710 (82,3) -> TransUnion 790 -> promedio 750 -> RECALCULA 82/96 = 85,4: APROBADO AUTOMATICO (valores propuestos, pendiente confirmacion de Mario)', async () => {
    const r = await decidir(dc({ ...PERFIL_B, score: 710 }, 30), { scoreSecundario: 790 });
    expect.soft(r.salidaPrimaria.puntaje_normalizado, 'normalizado de la primaria (79/96)').toBe(82.3);
    expect.soft(r.cascada.consultarSecundaria, 'banda intermedia: se consulta la segunda').toBe(true);
    expect.soft(mockSolicitar, 'se consulta TransUnion una vez').toHaveBeenCalledTimes(1);
    expect.soft(r.traza?.centrales_consultadas, 'traza: dos centrales').toEqual(['datacredito', 'transunion']);
    expect.soft(r.traza?.secundaria_consultada, 'traza: secundaria_consultada').toBe(true);
    expect.soft(r.salida.features.score_externo, 'V1 = promedio').toBe(750);
    expect.soft(r.salida.fuente_score_externo, 'fuente').toBe('PROMEDIO');
    expect.soft(r.salida.scores_individuales, 'scores de cada central').toEqual({ DATACREDITO: 710, TRANSUNION: 790 });
    normalizacion(r.salida, 82, 85.4, { score: 47, dti: 8, canon: 7, exp: 6, comp: 10, ant: 4 });
    expect.soft(r.salida.inconsistencia_score_buros, 'diferencia 80 no es > 80: no hay Caso G').toBe(false);
    expect.soft(r.d.resultado, 'decision').toBe('aprobado');
    expect.soft(r.d.via, 'via').toBe('automatica');
  });

  it('K — DataCredito no responde: TransUnion 700 como primaria con los MISMOS umbrales, traza con el fallo', async () => {
    const r = await decidir({ proveedor: 'transunion', payload: reporteTU(700), canon_mensual_cop: pctAjustado(25) }, { insumo: true, centralCaida: 'datacredito' });
    expect.soft(r.salida.fuente_score_externo, 'fuente_score_externo').toBe('TRANSUNION');
    expect.soft(r.salida.puntaje_normalizado, 'la evaluacion continua con TransUnion').not.toBeNull();
    // Sin estimador de ingreso V2/V3 salen del denominador (Adenda 2 §4.3): 96 - 25.
    expect.soft(r.salida.denominador_normalizacion, 'denominador registrado').toBe(71);
    expect.soft(r.cascada.motivo, 'mismos umbrales de cascada (40/90)').toMatch(/90|40/);
    expect.soft(r.d.resultado, 'no rechaza por la caida de la primaria').not.toBe('rechazado');
    expect.soft(mockSolicitar, 'la central caida no se vuelve a consultar').not.toHaveBeenCalled();
    expect.soft(r.traza, 'traza del fallo de DataCredito').toMatchObject({
      primaria: 'transunion',
      primaria_original: 'datacredito',
      fallback_2_3: true,
      apis_fallidas: ['datacredito'],
      centrales_consultadas: ['transunion'],
      fuente_score: 'TRANSUNION',
      denominador: 71,
    });
  });

  it('L — ninguna central responde: REVISION MANUAL OBLIGATORIA, fuente NO_DISPONIBLE, traza con las dos caidas', () => {
    // Lo que registra procesarEstudioAsync cuando DataCredito y TransUnion
    // fallan en la misma ejecucion (el flujo: ejecutar.cierre.test.ts).
    const { salida, decision, traza } = decidirSinCentrales({ primaria: 'transunion', centralCaida: 'datacredito', u: U, decididoEn: HOY });
    expect.soft(salida.fuente_score_externo, 'fuente_score_externo').toBe('NO_DISPONIBLE');
    expect.soft(decision.resultado, 'decision').toBe('condicionado');
    expect.soft(decision.via, 'via').toBe('revision_manual');
    expect.soft(traza, 'traza').toMatchObject({
      primaria_original: 'datacredito',
      fallback_2_3: true,
      apis_fallidas: ['datacredito', 'transunion'],
      centrales_consultadas: [],
      secundaria_consultada: false,
      fuente_score: 'NO_DISPONIBLE',
      resultado: 'condicionado',
      via: 'revision_manual',
    });
  });
});

// ============================================================================
// 7.4 Coarrendatario: N, O, R
// ============================================================================
describe('7.4 Coarrendatario', () => {
  it('N — B (78,1) + coarrendatario 85: APROBADO AUTOMATICO CONDICIONADO, tarifa 2,5% y prima 10%', async () => {
    const r = await decidir(dc(PERFIL_B, 30));
    normalizacion(r.salida, 75, 78.1, DESGLOSE_B);
    const d = conCoarrendatario(r, { puntaje: 85, reglaDura: false });
    expect.soft(d.resultado, 'decision (decidirResultado)').toBe('aprobado');
    expect.soft(d.via, 'via').toBe('condicionada_coarrendatario');
    expect.soft(r.d.resultado, 'el titular solo queda en revision manual').toBe('condicionado');
    const { combinado } = ponderar(r, 85);
    expect.soft(combinado, 'decision (ponderacion)').toBe('aprobado');
    const via = viaPorRutaDeAprobacion({ aprobadoPorPonderacion: combinado === 'aprobado', viaMotor: null, resultadoEstudio: 'aprobado', conReporteDeCentral: true });
    const t = calcularTarifas({ via, conCoarrendatario: true, canonCop: pctAjustado(30), ivaPct: CAL.TARIFA_IVA });
    expect.soft(t.tarifa_mensual_pct, 'tarifa').toBe(2.5);
    expect.soft(t.prima_vinculacion_pct, 'prima').toBe(10);
  });

  it('O — B (78,1) + coarrendatario 65 (< 70): RECHAZADO', async () => {
    const r = await decidir(dc(PERFIL_B, 30));
    normalizacion(r.salida, 75, 78.1, DESGLOSE_B);
    expect.soft(conCoarrendatario(r, { puntaje: 65, reglaDura: false }).resultado, 'decision (decidirResultado)').toBe('rechazado');
    expect.soft(ponderar(r, 65).combinado, 'decision (ponderacion)').toBe('rechazado');
    // Entre 70 y 79 no compensa ni hunde: sigue en revision manual.
    expect.soft(conCoarrendatario(r, { puntaje: 75, reglaDura: false }).resultado, 'coarrendatario 75 (decidirResultado)').toBe('condicionado');
    expect.soft(ponderar(r, 75).combinado, 'coarrendatario 75 (ponderacion)').toBe('revision_manual');
  });

  // Nota §5 (R2) del lado del coarrendatario: su score 450-599 (Adenda 2 §2,
  // revision manual con prioridad sobre el < 70) choca con el caso O. Sin
  // definicion de la Gerencia: revision manual con la marca de conflicto.
  it('O con coarrendatario de score 520 (47,9 < 70): REVISION MANUAL y traza de conflicto, no rechazo', async () => {
    const r = await decidir(dc(PERFIL_B, 30));
    const coa = (await decidir(dc(PERFIL_F, 30))).salida;
    expect.soft(coa.puntaje_normalizado, 'precondicion: coarrendatario < 70').toBe(47.9);
    expect.soft(coa.revision_obligatoria, 'precondicion: score del coarrendatario en la banda 450-599').toMatch(/520/);
    const d = conCoarrendatario(r, { puntaje: coa.puntaje_normalizado, reglaDura: false, scoreEnBandaRevision: true });
    expect.soft(d.resultado, 'decision (decidirResultado)').toBe('condicionado');
    expect.soft(d.via, 'via').toBe('revision_manual');
    expect.soft(d.motivo, 'traza: conflicto de reglas del coarrendatario').toContain(CONFLICTO_REGLAS_COARRENDATARIO);
    const { v, combinado } = ponderar(r, coa);
    expect.soft(combinado, 'decision (ponderacion)').toBe('revision_manual');
    expect.soft(v?.conflicto, 'ponderacion: conflicto de reglas del coarrendatario').toBe(CONFLICTO_REGLAS_COARRENDATARIO);
  });

  it('R — afianzado 52,1 (< 70) + coarrendatario 95: RECHAZADO', async () => {
    const r = await decidir(dc(PERFIL_R, 35));
    normalizacion(r.salida, 50, 52.1, { score: 34, dti: 2, canon: 4, exp: 0, comp: 10, ant: 0 });
    expect.soft(conCoarrendatario(r, { puntaje: 95, reglaDura: false }).resultado, 'decision (decidirResultado)').toBe('rechazado');
    expect.soft(r.d.resultado, 'el titular solo ya es rechazado').toBe('rechazado');
    expect.soft(ponderar(r, 95).combinado, 'decision (ponderacion)').toBe('rechazado');
  });
});

// ============================================================================
// 7.5 Motivos y traza: F1, F2, G, M
// ============================================================================
const PERFIL_F: PerfilDC = { score: 520, cuotaCop: pctAjustado(30), sectores: ['3'], mesesObservados: 24, maturationSince: DOS_A_5 };
const DESGLOSE_F = { score: 10, dti: 12, canon: 7, exp: 4, comp: 10, ant: 3 };

describe('7.5 Motivos y traza', () => {
  it('F1 — score 520, ingreso NO inferible: REVISION MANUAL por ingreso Y por score', async () => {
    const r = await decidir(dc({ ...PERFIL_F, ingresoCop: null }, 30));
    const f2 = await decidir(dc(PERFIL_F, 30));
    // Pendiente confirmacion de Mario: la matriz da 46/96 = 47,9 (el desglose de
    // F2), pero sin ingreso DTI y canon/ingreso no se pueden calcular y cuentan
    // 0 dentro del denominador (como en D, H y R): 27/96 = 28,1.
    normalizacion(r.salida, 27, 28.1, { ...DESGLOSE_F, dti: 0, canon: 0 });
    expect.soft(r.d.resultado, 'decision').toBe('condicionado');
    expect.soft(r.d.motivo, 'motivo registrado: ingreso no inferible').toMatch(/ingreso/i);
    expect.soft(r.d.motivo, 'motivo registrado: score').toMatch(/520/);
    expect.soft(r.d.motivo.match(/520/g), 'la banda de score no se repite').toHaveLength(1);
    expect.soft(r.traza?.decision, 'traza: el motivo queda en estudios.cascada').toBe(r.d.motivo);
    expect.soft(r.d.motivo, 'F1 y F2 deben registrar motivos distintos').not.toBe(f2.d.motivo);
  });

  it('F2 — score 520, ingreso SI inferible: 46/96 = 47,9, REVISION MANUAL solo por score', async () => {
    const r = await decidir(dc(PERFIL_F, 30));
    normalizacion(r.salida, 46, 47.9, DESGLOSE_F);
    expect.soft(r.d.resultado, 'decision').toBe('condicionado');
    expect.soft(r.d.motivo, 'motivo: score').toMatch(/520/);
    expect.soft(r.d.motivo, 'sin motivo de ingreso').not.toMatch(/ingreso/i);
  });

  it('G — DC 680 (banda 40-89) y TU 590, diferencia 90 > 80: REVISION MANUAL OBLIGATORIA', async () => {
    const r = await decidir(dc({ ...PERFIL_B, score: 680 }, 30), { scoreSecundario: 590 });
    const p = r.salidaPrimaria.puntaje_normalizado ?? -1;
    expect.soft(p >= U.cascadaRechazo && p < U.cascadaAprobacion, `precondicion: normalizado DC ${p} en 40-89`).toBe(true);
    expect.soft(r.traza?.centrales_consultadas, 'se consultaron las dos centrales').toEqual(['datacredito', 'transunion']);
    expect.soft(r.salida.inconsistencia_score_buros, 'inconsistencia').toBe(true);
    expect.soft(r.d.resultado, 'decision').toBe('condicionado');
    expect.soft(r.d.via, 'via').toBe('revision_manual');
    expect.soft(r.d.motivo, 'motivo Caso G').toMatch(/Caso G/);
  });

  it('M — ingreso 3.000.000 x 1,15 = 3.450.000, canon 1.400.000: RECHAZADO sobre el AJUSTADO (40,6%), traza con ambos, sin puntaje', async () => {
    const perfil: PerfilDC = { score: 750, ingresoCop: 3_000_000, cuotaCop: 690_000, sectores: ['1'], mesesObservados: 24, maturationSince: MAS_8_ANIOS };
    const r = await decidir({ proveedor: 'datacredito', payload: reporteDC(perfil), canon_mensual_cop: 1_400_000 }, { insumo: true });
    expect.soft(r.d.resultado, 'decision').toBe('rechazado');
    expect.soft(r.veredicto.reglas, 'regla').toEqual(['canon_ingreso_mayor_40']);
    expect.soft(r.salida.canon_ingreso_pct, 'canon/ingreso sobre el ajustado').toBe(40.58);
    expect.soft(r.salida.dti_pct, 'DTI sobre el ajustado (690.000 / 3.450.000)').toBe(20);
    expect.soft(r.salida.features.ingreso_mensual_inferido_cop, 'traza: ingreso bruto').toBe(3_000_000);
    expect.soft(r.salida.ingreso_inferido_ajustado_cop, 'traza: ingreso ajustado').toBe(3_450_000);
    if (r.veredicto.rechaza) {
      expect.soft(r.veredicto.detalle.ingreso_mensual_inferido_cop, 'detalle del rechazo: bruto').toBe(3_000_000);
      expect.soft(r.veredicto.detalle.ingreso_mensual_ajustado_cop, 'detalle del rechazo: ajustado').toBe(3_450_000);
    }
    const fila = construirFilaSombra('est-qa', r.salida, {});
    expect.soft([fila.ingreso_inferido_cop, fila.ingreso_inferido_ajustado_cop], 'fila sombra: ambos valores').toEqual([3_000_000, 3_450_000]);
    sinPuntaje(r, 'canon_ingreso_mayor_40');
    // Discriminante: 1.380.000 es 46% del bruto pero 40,0% exacto del ajustado -> no rechaza.
    const borde = await decidir({ proveedor: 'datacredito', payload: reporteDC(perfil), canon_mensual_cop: 1_380_000 });
    expect.soft(borde.veredicto.reglas, 'la regla se evalua sobre el ajustado, no sobre el bruto').not.toContain('canon_ingreso_mayor_40');
  });
});

// ============================================================================
// R2 — conflicto de reglas SIN DEFINIR por la Gerencia: no se programa ninguna
// de las dos interpretaciones. Salida conservadora (nota §5): revision manual
// con la traza marcada como conflicto pendiente.
// ============================================================================
it('R2 — score 520, normalizado 27,1, coarrendatario 95: REVISION MANUAL y traza de conflicto pendiente de la Gerencia', async () => {
  const r = await decidir(dc({ ...PERFIL_R, score: 520 }, 35));
  normalizacion(r.salida, 26, 27.1, { score: 10, dti: 2, canon: 4, exp: 0, comp: 10, ant: 0 });
  expect.soft(r.d.resultado, 'el titular solo: revision manual por la banda').toBe('condicionado');
  // Contrato de decision.ts con el coarrendatario en la mano.
  const d = conCoarrendatario(r, { puntaje: 95, reglaDura: false });
  expect.soft(d.resultado, 'decision (decidirResultado)').toBe('condicionado');
  expect.soft(d.via, 'via').toBe('revision_manual');
  expect.soft(d.motivo, 'traza: conflicto de reglas').toContain(CONFLICTO_REGLAS_R2);
  // Camino real: la ponderacion deja el caso en revision y registra el conflicto.
  const { v, combinado } = ponderar(r, 95);
  expect.soft(combinado, 'decision (ponderacion)').toBe('revision_manual');
  expect.soft(v?.conflicto, 'ponderacion: conflicto de reglas').toBe(CONFLICTO_REGLAS_R2);
  // Sin coarrendatario alto no hay conflicto que registrar.
  expect.soft(conCoarrendatario(r, { puntaje: 75, reglaDura: false }).motivo, 'coarrendatario 75: sin conflicto').not.toContain(CONFLICTO_REGLAS_R2);
});

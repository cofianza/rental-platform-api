import { describe, it, expect, vi, beforeEach } from 'vitest';

// Punto unico de decision (resolverResultadoEstudio): que motivos de revision
// manual aplican segun QUIEN es la persona evaluada y QUIEN decide.

const { filaEstudio, mockContraste, mockBiometria } = vi.hoisted(() => ({
  filaEstudio: { current: null as Record<string, unknown> | null },
  mockContraste: vi.fn(async () => 'Revision manual (Adenda §8): el ingreso declarado difiere del estimado.'),
  mockBiometria: vi.fn(async () => null),
}));

vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: filaEstudio.current, error: null });
  return { supabase: { from: () => chain } };
});
vi.mock('@/config', () => ({ env: new Proxy({}, { get: () => false }) }));
vi.mock('@/config/env', () => ({ env: new Proxy({}, { get: () => false }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/calibracion', () => ({
  getCalibracion: vi.fn(async () => ({
    FACTOR_AJUSTE_INGRESO: 1.15,
    UMBRAL_APROBACION_AUTOMATICA: 85,
    UMBRAL_ZONA_GRIS: 70,
    UMBRAL_SCORE_RECHAZO: 450,
    UMBRAL_SCORE_REVISION: 600,
    UMBRAL_DIFERENCIA_INGRESO: 50,
  })),
}));
vi.mock('../tope-canon.guard', () => ({ leerCanonDelInmueble: vi.fn(async () => 2_000_000), formatearCOP: (n: number) => String(n) }));
vi.mock('@/modules/autorizaciones/ingreso-declarado', () => ({ contrasteIngresoProspecto: mockContraste }));
vi.mock('@/modules/autorizaciones/biometria', () => ({
  leerBiometriaDeExpediente: mockBiometria,
  requiereRevisionManualPorBiometria: () => null,
}));

import {
  resolverResultadoEstudio,
  motivoProspectoReglasDuras,
  REGLAS_DURAS_ACTIVAS,
  motivoRevisionCanonIngreso,
  motivoRevisionSituacionLaboral,
} from '../reglas-duras';
import type { SalidaSombra } from '../motor';

const base = { estudioId: 'est-1', expedienteId: 'exp-1', resultadoPropuesto: 'aprobado', antecedentes: null };

beforeEach(() => {
  vi.clearAllMocks();
  filaEstudio.current = null;
});

describe('estudio del co-arrendatario', () => {
  it('no se contrasta con el ingreso que declaro el titular ni se usa su biometria', async () => {
    filaEstudio.current = { proveedor: 'transunion', respuesta_proveedor: null, score: 780, datos_formulario: { tipo_documento: 'cc' }, tipo: 'con_coarrendatario' };
    const r = await resolverResultadoEstudio(base);
    expect(mockContraste).not.toHaveBeenCalled();
    expect(mockBiometria).not.toHaveBeenCalled();
    expect(r.observaciones ?? '').not.toMatch(/Adenda §8/);
  });

  it('el del titular si pasa por el contraste (tipo leido de la fila)', async () => {
    filaEstudio.current = { proveedor: 'transunion', respuesta_proveedor: null, score: 780, datos_formulario: { tipo_documento: 'cc' }, tipo: 'individual' };
    await resolverResultadoEstudio(base);
    expect(mockContraste).toHaveBeenCalledWith('exp-1', null, 50);
    expect(mockBiometria).toHaveBeenCalledWith('exp-1');
  });
});

describe('resultado registrado a mano por un analista', () => {
  // Cedula de extranjeria (§15) y score digitado en la banda 450-599 (Adenda 2 §2).
  const manual = { proveedor: 'manual', respuesta_proveedor: null, score: null, datos_formulario: { tipo_documento: 'ce' }, tipo: 'individual' };

  it('su aprobado queda aprobado; los motivos van como nota', async () => {
    filaEstudio.current = manual;
    const r = await resolverResultadoEstudio({ ...base, score: 520, decidePersona: true });
    expect(r.resultado).toBe('aprobado');
    expect(r.revisionManual).toBeTruthy();
    expect(r.observaciones).toMatch(/§15/);
  });

  it('el mismo caso por un camino automatico sigue bajando a condicionado', async () => {
    filaEstudio.current = manual;
    const r = await resolverResultadoEstudio({ ...base, score: 520 });
    expect(r.resultado).toBe('condicionado');
  });
});

describe('motivo para el prospecto (P30)', () => {
  it('ninguna regla dura le sugiere un co-arrendatario: no cambia el resultado (§5)', () => {
    for (const regla of REGLAS_DURAS_ACTIVAS) {
      expect(motivoProspectoReglasDuras([regla])).not.toMatch(/co-?arrendatario/i);
    }
    expect(motivoProspectoReglasDuras(['dti_mayor_65', 'canon_ingreso_mayor_40'])).not.toMatch(/co-?arrendatario/i);
  });

  it('la salida sigue a la causa', () => {
    const canon = motivoProspectoReglasDuras(['canon_ingreso_mayor_40']);
    expect(canon).toMatch(/canon menor/);
    expect(canon).not.toMatch(/compromisos/);
    const dti = motivoProspectoReglasDuras(['dti_mayor_65']);
    expect(dti).toMatch(/reducir tus compromisos/);
    expect(dti).not.toMatch(/canon menor/);
    expect(motivoProspectoReglasDuras(['mora_vigente'])).toMatch(/ponerte al día/);
    expect(motivoProspectoReglasDuras(['score_menor_450'])).toMatch(/volver a solicitarlo más adelante/);
  });

  it('con varias causas, las salidas de todas', () => {
    const m = motivoProspectoReglasDuras(['mora_vigente', 'dti_mayor_65', 'canon_ingreso_mayor_40']);
    expect(m).toMatch(/en mora/);
    expect(m).toMatch(/ponerte al día en tus obligaciones, reducir tus compromisos financieros actuales, buscar un inmueble de canon menor y volver a solicitarlo/);
    expect(motivoProspectoReglasDuras(['score_menor_450', 'mora_mayor_30d_6m'])).toMatch(/ponerte al día.* y volver a solicitarlo más adelante/);
  });
});

describe('Politica §4.3: canon/ingreso entre 35 % y 40 % va a revision manual (A5)', () => {
  const salida = (pct: number | null) => ({ canon_ingreso_pct: pct }) as unknown as SalidaSombra;
  it('solo la banda >35 y <=40 da motivo', () => {
    expect(motivoRevisionCanonIngreso(salida(35))).toBeNull();
    expect(motivoRevisionCanonIngreso(salida(35.01))).toMatch(/§4\.3/);
    expect(motivoRevisionCanonIngreso(salida(40))).toMatch(/40%/);
    // Por encima del 40 % ya es regla dura (rechazo), no revision.
    expect(motivoRevisionCanonIngreso(salida(40.01))).toBeNull();
    expect(motivoRevisionCanonIngreso(salida(null))).toBeNull();
    expect(motivoRevisionCanonIngreso(null)).toBeNull();
  });
});

describe('Politica Anexo A.4/A.5: situacion laboral declarada (P9)', () => {
  it('«otro» e independiente con un «No» al RUT van a revision; lo demas no', () => {
    expect(motivoRevisionSituacionLaboral({ situacion_laboral: 'otro' })).toMatch(/Anexo A/);
    expect(motivoRevisionSituacionLaboral({ situacion_laboral: 'independiente', tiene_rut: false })).toMatch(/A\.4.*sin RUT/);
    expect(motivoRevisionSituacionLaboral({ situacion_laboral: 'independiente', tiene_rut: true })).toBeNull();
    // Sin respuesta (paso opcional o columna sin migrar) no se afirma nada.
    expect(motivoRevisionSituacionLaboral({ situacion_laboral: 'independiente' })).toBeNull();
    expect(motivoRevisionSituacionLaboral({ situacion_laboral: 'empleado', tiene_rut: false })).toBeNull();
    expect(motivoRevisionSituacionLaboral(null)).toBeNull();
  });

  // El mock de Supabase devuelve la misma fila a toda lectura: sirve de estudio y de perfil §8.2.
  const fila = { proveedor: 'transunion', respuesta_proveedor: null, score: 780, datos_formulario: { tipo_documento: 'cc' } };

  it('el aprobado automatico del titular baja a condicionado con el motivo', async () => {
    filaEstudio.current = { ...fila, tipo: 'individual', situacion_laboral: 'independiente', tiene_rut: false };
    const r = await resolverResultadoEstudio(base);
    expect(r.resultado).toBe('condicionado');
    expect(r.revisionManual).toMatch(/sin RUT/);
  });

  it('en el estudio del co-arrendatario no se usa lo que declaro el titular', async () => {
    filaEstudio.current = { ...fila, tipo: 'con_coarrendatario', situacion_laboral: 'otro' };
    const r = await resolverResultadoEstudio(base);
    expect(r.revisionManual ?? '').not.toMatch(/Anexo A/);
  });
});

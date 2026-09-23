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

import { resolverResultadoEstudio } from '../reglas-duras';

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

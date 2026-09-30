import { describe, it, expect, vi } from 'vitest';

// Texto VISIBLE de las observaciones y del motivo de rechazo (inmobiliaria,
// propietario, CRC) separado del interno (analista). Funciones puras.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: new Proxy({}, { get: () => 'x' }) }));
vi.mock('@/config/env', () => ({ env: new Proxy({}, { get: () => 'x' }) }));

import {
  AVISO_REVISION_ANALISTA,
  inferirReglasDurasDesdeMotivo,
  motivoGestorReglasDuras,
  motivoVisibleDesdeMotivoGestor,
  observacionesParaAgencia,
  observacionesVisibles,
  type DetalleReglasDuras,
} from '../reglas-duras';
import { requiereRevisionManual, type ResumenAntecedentes } from '../antecedentes';
import { MOTIVO_INGRESO_NO_VERIFICABLE } from '../reglas-duras';
import { etiquetaSinPuntaje } from '../rutas-resultado';

const INTERNO = /§|Adenda|Pol[ií]tica|Cascada|background|fuentes_con_error|Decision|Para el analista|\.\./;

describe('observaciones del caso del recorrido (TransUnion 741, Registraduría sin dato)', () => {
  const antecedentes = {
    estado: 'verificado',
    flags_revision: ['registraduria_sin_informacion', 'fuentes_con_error'],
  } as unknown as ResumenAntecedentes;
  const motivos = [requiereRevisionManual(antecedentes), MOTIVO_INGRESO_NO_VERIFICABLE].join(' ');

  it('resumen + aviso + motivos, una sola vez, en usted y sin referencias internas', () => {
    const obs = observacionesVisibles({
      resumen: 'Resultado de TransUnion: puntaje 741; 4 obligaciones registradas.',
      resultado: 'condicionado',
      reglas: [],
      motivosRevision: motivos,
      // El motor repite los motivos en su decisión: no se duplican.
      motivoModelo: MOTIVO_INGRESO_NO_VERIFICABLE,
    });
    expect(obs).toBe(
      'Resultado de TransUnion: puntaje 741; 4 obligaciones registradas. El caso pasa a revisión de un analista de Cofianza. ' +
        'No fue posible confirmar la vigencia del documento con la Registraduría. Algunas fuentes de antecedentes no respondieron. ' +
        'No fue posible verificar el ingreso con las fuentes disponibles.',
    );
    expect(obs).not.toMatch(INTERNO);
  });

  it('rechazo por regla dura: la condición, sin cifras ni umbrales', () => {
    const obs = observacionesVisibles({ resumen: 'Resultado de DataCrédito: puntaje 700.', resultado: 'rechazado', reglas: ['dti_mayor_65'], motivosRevision: null });
    expect(obs).toBe('Resultado de DataCrédito: puntaje 700. No cumple una condición obligatoria de la política de riesgo: capacidad de endeudamiento insuficiente.');
  });

  it('registro manual (B20): solo lo que escribe el analista', () => {
    expect(observacionesVisibles({ resumen: 'Soportes verificados.', resultado: 'aprobado', reglas: [], motivosRevision: motivos, decidePersona: true })).toBe('Soportes verificados.');
  });
});

describe('motivo de rechazo por regla dura', () => {
  const d = {
    dti_pct: 70.5, dti_umbral: 65, canon_ingreso_pct: null, canon_ingreso_umbral: 40,
    ingreso_mensual_inferido_cop: 3_000_000, ingreso_mensual_ajustado_cop: 3_450_000, factor_ajuste_ingreso: 1.15,
    cuota_mensual_vigente_cop: 2_000_000, cuota_fianza_cop: null, canon_evaluado_cop: 1_400_000,
    score_externo: 700, score_umbral_rechazo: 450, proveedor: 'datacredito', modelo_version: 'v4.1',
  } as unknown as DetalleReglasDuras;

  it('el del gestor: cifras con coma decimal, sin referencias; se sigue reconociendo', () => {
    const m = motivoGestorReglasDuras(['dti_mayor_65'], d);
    expect(m).toContain('70,5% supera el máximo de 65%');
    expect(m).toContain('factor de ajuste 1,15');
    expect(m).not.toMatch(/§|Adenda|Politica|s\/d/);
    expect(inferirReglasDurasDesdeMotivo(m)).toEqual(['dti_mayor_65']);
  });

  it('la inmobiliaria recibe la condición, también de un motivo guardado con el formato anterior', () => {
    const visible = 'No cumple una condición obligatoria de la política de riesgo: capacidad de endeudamiento insuficiente.';
    expect(motivoVisibleDesdeMotivoGestor(motivoGestorReglasDuras(['dti_mayor_65'], d))).toBe(visible);
    const anterior =
      'Rechazo automatico por regla dura de la Politica de Evaluacion V4.1. Capacidad de endeudamiento (DTI, §4.2): 70% supera el maximo de 65%.';
    expect(inferirReglasDurasDesdeMotivo(anterior)).toEqual(['dti_mayor_65']);
    expect(motivoVisibleDesdeMotivoGestor(anterior)).toBe(visible);
    expect(motivoVisibleDesdeMotivoGestor('Decision del modelo (Adenda 1): Puntaje 65 < 70')).toBe(
      'El resultado de la evaluación no alcanza el mínimo para aprobar.',
    );
    // El que escribe el analista para la agencia pasa igual.
    expect(motivoVisibleDesdeMotivoGestor('Documentos inconsistentes.')).toBe('Documentos inconsistentes.');
  });
});

describe('observaciones guardadas antes de separar el texto interno', () => {
  const LEGADO =
    'Score CreditVision: 741. Obligaciones totales: 4. Saldo total: $ 25.756 Revision manual: la Registraduria no entrego informacion de la cedula. ' +
    'Decision de Gerencia (2026-09-09): el estudio queda pendiente. El background check reporta ademas: fuentes_con_error. ' +
    'Revisión manual obligatoria (Política §6/§14, Adenda 2 §3): no se pudo inferir el ingreso. Cascada (Adenda §2): puntaje 77.5 entre 40 y 89. ' +
    'Decision del modelo: Revision manual..';

  it('la agencia ve el resumen de la central y el aviso, sin lo interno', () => {
    expect(observacionesParaAgencia(LEGADO, 'condicionado')).toBe(
      `Score CreditVision: 741. Obligaciones totales: 4. Saldo total: $ 25.756. ${AVISO_REVISION_ANALISTA}`,
    );
  });

  it('un fallido con referencias pierde solo esas frases; un texto nuevo pasa igual', () => {
    const fallido =
      'DataCrédito tampoco respondió (Adenda §2.3 → Política §14: sin centrales no hay decisión automática). TransUnion no está disponible en este momento. ' +
      'Adenda 1 §2.3: si DataCrédito no responde, reintente.';
    expect(observacionesParaAgencia(fallido, null)).toBe('TransUnion no está disponible en este momento.');
    const nuevo = `Resultado de TransUnion: puntaje 741. ${AVISO_REVISION_ANALISTA}`;
    expect(observacionesParaAgencia(nuevo, 'condicionado')).toBe(nuevo);
  });
});

describe('etiqueta del gestor', () => {
  it('sin el puntaje del modelo para la agencia', () => {
    expect(etiquetaSinPuntaje('Perfil intermedio (77,5 puntos): aprobado con co-arrendatario (82 puntos)')).toBe(
      'Perfil intermedio: aprobado con co-arrendatario',
    );
  });
});

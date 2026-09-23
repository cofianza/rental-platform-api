import { describe, it, expect } from 'vitest';
import { calcularTarifas, sobreCanon, textosTarifaContrato } from '../tarifas';

// Adenda 1 del módulo de contratos §1.1: la prima y la tarifa causan IVA,
// siempre. La versión anterior omitía el de la prima.

const base = { via: 'automatica' as const, conCoarrendatario: false, canonCop: 1_500_000, ivaPct: 19 };

describe('prima de vinculación con IVA', () => {
  it('canon 1.500.000, aprobado automático y firma solo: prima 300.000 + IVA = 357.000; tarifa 30.000 + IVA = 35.700', () => {
    const t = calcularTarifas(base);
    expect(t.prima_vinculacion_cop).toBe(300_000); // sigue siendo la base, sin IVA
    expect(t.prima_vinculacion_con_iva_cop).toBe(357_000);
    expect(t.tarifa_mensual_cop).toBe(30_000);
    expect(t.tarifa_mensual_con_iva_cop).toBe(35_700);
  });

  it('con coarrendatario (10 %) y redondeo al peso', () => {
    const t = calcularTarifas({ ...base, conCoarrendatario: true, canonCop: 1_234_567 });
    expect(t.prima_vinculacion_cop).toBe(123_457);
    expect(t.prima_vinculacion_con_iva_cop).toBe(146_914); // 123.457 × 1,19 = 146.913,83
  });

  it('sin canon no inventa cifras', () => {
    const t = calcularTarifas({ ...base, canonCop: null });
    expect(t.prima_vinculacion_con_iva_cop).toBeNull();
  });

  it('sobreCanon: el % del certificado sobre el canon pactado, con el override de Gerencia', () => {
    const evaluado = calcularTarifas({
      ...base,
      override: { prima_vinculacion_pct: 15, autorizado_por: 'g', autorizado_en: '2026-09-23T00:00:00Z' },
    });
    const pactado = sobreCanon(evaluado, 1_600_000);
    expect(pactado.prima_vinculacion_pct).toBe(15);
    expect(pactado.prima_vinculacion_cop).toBe(240_000);
    expect(pactado.prima_vinculacion_con_iva_cop).toBe(285_600);
    expect(pactado.tarifa_mensual_con_iva_cop).toBe(38_080); // 2 % de 1.600.000 = 32.000 + IVA
  });
});

describe('contrato V4: la prima dice que lleva IVA, como la tarifa', () => {
  it('imprime «(más IVA)» en la prima', () => {
    expect(textosTarifaContrato(calcularTarifas(base))).toEqual({
      comision_texto: 'el 2,0% (más IVA)',
      prima_texto: '20% (más IVA)',
    });
  });

  it('vista previa sin estudio: los marcadores también', () => {
    expect(textosTarifaContrato(null).prima_texto).toBe('[prima de vinculación + IVA]');
  });
});

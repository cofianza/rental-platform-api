/**
 * H58/H103 (decisión 2026-09-28): motivos de lista + texto opcional, con un
 * texto visible (inmobiliaria) y otro interno (Cofianza).
 */
import { describe, it, expect } from 'vitest';
import { componerMotivos, MOTIVOS_DECISION } from '../motivos-decision';
import { registrarResultadoSchema } from '../estudios.schema';
import { transitionBodySchema } from '@/modules/expedientes/expediente-workflow.schema';

describe('catálogo', () => {
  it('lo visible no lleva umbrales ni perfiles (secreto industrial, decisión del usuario)', () => {
    for (const tipo of Object.values(MOTIVOS_DECISION)) {
      for (const m of Object.values(tipo)) {
        expect(m.visible).not.toMatch(/\d|%|extranjer|independiente|rentista/i);
      }
    }
  });

  it('R2, R4 y R5: la inmobiliaria ve solo «No cumple la Política de riesgo»', () => {
    for (const c of ['R2', 'R4', 'R5'] as const) {
      expect(MOTIVOS_DECISION.rechazar[c].visible).toBe('No cumple la Política de riesgo');
    }
  });
});

describe('componerMotivos', () => {
  it('visible sin repetir; interno con código por línea y el detalle', () => {
    const t = componerMotivos('rechazar', ['R2', 'R5', 'R3'], 'Dos obligaciones castigadas');
    expect(t.visible).toBe('No cumple la Política de riesgo; Capacidad de pago insuficiente');
    expect(t.interno.split('\n')).toEqual([
      expect.stringMatching(/^R2 · Mora vigente/),
      expect.stringMatching(/^R5 · Reporte en listas/),
      expect.stringMatching(/^R3 · Endeudamiento/),
      'Detalle del analista: Dos obligaciones castigadas',
    ]);
  });
});

describe('schemas', () => {
  it('registrar resultado: rechazo solo con motivos llena motivo_rechazo, fundamento y observaciones', () => {
    const r = registrarResultadoSchema.safeParse({ resultado: 'rechazado', motivos: ['R1'] });
    expect(r.success).toBe(true);
    const d = r.data as Record<string, string>;
    expect(d.motivo_rechazo).toBe('El historial crediticio no cumple la Política');
    expect(d.fundamento).toMatch(/^R1 · Score externo/);
    expect(d.observaciones).toBe(d.fundamento);
  });

  it('condicionar: las condiciones que ve la inmobiliaria llevan el detalle', () => {
    const r = registrarResultadoSchema.safeParse({ resultado: 'condicionado', motivos: ['C2'], motivo_detalle: 'Extractos de 6 meses' });
    expect((r.data as Record<string, string>).condiciones).toBe('Requiere documentos de ingreso adicionales. Extractos de 6 meses');
  });

  it('«Otro» exige texto; un código de otra decisión no vale', () => {
    expect(registrarResultadoSchema.safeParse({ resultado: 'rechazado', motivos: ['R9'] }).success).toBe(false);
    expect(registrarResultadoSchema.safeParse({ resultado: 'rechazado', motivos: ['R9'], motivo_detalle: 'Fraude documental evidente' }).success).toBe(true);
    expect(registrarResultadoSchema.safeParse({ resultado: 'rechazado', motivos: ['C1'] }).success).toBe(false);
  });

  it('el texto libre de siempre sigue valiendo (web anterior)', () => {
    expect(
      registrarResultadoSchema.safeParse({
        resultado: 'rechazado',
        observaciones: 'Observaciones largas',
        motivo_rechazo: 'No cumple la política de Cofianza',
        fundamento: 'Dos obligaciones castigadas',
      }).success,
    ).toBe(true);
  });

  it('transición a rechazado con motivos llena motivo (visible) y comentario (interno)', () => {
    const r = transitionBodySchema.safeParse({ nuevo_estado: 'rechazado', motivos: ['R4'] });
    expect(r.success).toBe(true);
    const d = r.data as Record<string, string>;
    expect(d.motivo).toBe('No cumple la Política de riesgo');
    expect(d.comentario).toMatch(/^R4 · Proceso de restitución/);
  });
});

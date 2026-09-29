/**
 * H58/H103 (decisión 2026-09-28): motivos de lista + texto opcional, con un
 * texto visible (inmobiliaria) y otro interno (Cofianza).
 */
import { describe, it, expect, vi } from 'vitest';
import { componerMotivos, guardarCodigosMotivo, MOTIVOS_DECISION } from '../motivos-decision';

const { mockUpdate, mockEq } = vi.hoisted(() => {
  const mockEq = vi.fn(async () => ({ error: { message: 'fallo de red' } }));
  return { mockEq, mockUpdate: vi.fn(() => ({ eq: mockEq })) };
});
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(() => ({ update: mockUpdate })) } }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { registrarResultadoSchema } from '../estudios.schema';
import { transitionBodySchema } from '@/modules/expedientes/expediente-workflow.schema';
import { aprobarCondicionadoBody } from '@/modules/expedientes/expediente-workflow.schema';
import { OPCIONES_V7, OPCIONES_V9 } from '../motor/scorecard';

const EVALUACION = { estabilidad_laboral: Object.keys(OPCIONES_V7)[0], arrendamiento_previo: Object.keys(OPCIONES_V9)[0] };

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
    // B20: las observaciones las ve la inmobiliaria: nunca el texto interno.
    expect(d.observaciones).toBe('El historial crediticio no cumple la Política');
  });

  it('B21: condicionar también deja el fundamento interno; las observaciones no lo llevan', () => {
    const r = registrarResultadoSchema.safeParse({ resultado: 'condicionado', motivos: ['C1'] });
    const d = r.data as Record<string, string>;
    expect(d.fundamento).toMatch(/^C1 · Requiere coarrendatario con puntaje ≥ 80/);
    expect(d.observaciones).toBe('Requiere coarrendatario');
    expect(d.observaciones).not.toMatch(/≥|§/);
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

describe('guardarCodigosMotivo', () => {
  it('guarda los códigos y, si el UPDATE falla, lo registra como error sin lanzar', async () => {
    await expect(guardarCodigosMotivo('estudios', 'est-1', ['R1', 'R3'])).resolves.toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledWith({ motivos_decision: ['R1', 'R3'] });
    expect(mockEq).toHaveBeenCalledWith('id', 'est-1');
    const { logger } = await import('@/lib/logger');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tabla: 'estudios', id: 'est-1', codigos: ['R1', 'R3'] }),
      'No se guardaron los códigos de motivo de la decisión',
    );
  });

  it('sin códigos o sin id no escribe', async () => {
    mockUpdate.mockClear();
    await guardarCodigosMotivo('eventos_timeline', null, ['A1']);
    await guardarCodigosMotivo('eventos_timeline', 'ev-1', []);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('M4 y M6: fundamento interno completo y sin 400 por largo', () => {
  const detalleMax = 'd'.repeat(1000);
  const todos = (t: keyof typeof MOTIVOS_DECISION) => Object.keys(MOTIVOS_DECISION[t]);

  it('transición: todos los motivos + detalle de 1000 + un comentario viejo de 1000 caben', () => {
    for (const nuevo_estado of ['rechazado', 'aprobado'] as const) {
      const r = transitionBodySchema.safeParse({
        nuevo_estado,
        motivos: todos(nuevo_estado === 'rechazado' ? 'rechazar' : 'aprobar'),
        motivo_detalle: detalleMax,
        comentario: 'c'.repeat(1000),
      });
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    }
  });

  it('M4: un comentario que quedó de otra transición no reemplaza los motivos: va al final', () => {
    const r = transitionBodySchema.safeParse({ nuevo_estado: 'rechazado', motivos: ['R3'], comentario: 'Texto de la cancelación' });
    const d = r.data as Record<string, string>;
    expect(d.comentario.split('\n')).toEqual([expect.stringMatching(/^R3 · Endeudamiento/), 'Texto adicional: Texto de la cancelación']);
  });

  it('registrar resultado: todos los motivos + detalle al máximo, en rechazo y en condicionado', () => {
    expect(registrarResultadoSchema.safeParse({ resultado: 'rechazado', motivos: todos('rechazar'), motivo_detalle: detalleMax }).success).toBe(true);
    expect(registrarResultadoSchema.safeParse({ resultado: 'condicionado', motivos: todos('condicionar'), motivo_detalle: detalleMax }).success).toBe(true);
  });

  it('aprobar-condicionado: todos los motivos + detalle al máximo + fundamento escrito', () => {
    const r = aprobarCondicionadoBody.safeParse({
      motivos: todos('aprobar'),
      motivo_detalle: detalleMax,
      fundamento: 'f'.repeat(1000),
      documentos_consultados: [],
      evaluacion: EVALUACION,
    });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect((r.data as { fundamento: string }).fundamento).toMatch(/^A1 · /);
  });
});

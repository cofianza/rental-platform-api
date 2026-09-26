import { describe, it, expect, vi } from 'vitest';

const { mockUpserts } = vi.hoisted(() => ({
  mockUpserts: [] as Array<{ fila: Record<string, unknown>; error: { code: string; message: string } | null }>,
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      upsert: async (fila: Record<string, unknown>) => {
        // El CHECK viejo (sin la migracion 20261001000010): 'rechazado' sin puntaje rebota.
        const error = fila.decision_sombra === 'rechazado' && fila.puntaje_normalizado === null
          ? { code: '23514', message: 'violates check constraint "chk_scorecard_sombra_no_calculable"' }
          : null;
        mockUpserts.push({ fila, error });
        return { error };
      },
    }),
  },
}));
vi.mock('@/config', () => ({ env: {} }));
vi.mock('@/config/env', () => ({ env: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { evaluarSombra } from '../motor';
import { construirFilaSombra } from '../motor/fila';
import { registrarScorecardSombra } from '../motor/sombra.service';
import { aplicarReglasDuras } from '../reglas-duras';

// ============================================================
// Politica §9: una corrida SIN puntaje (no-hit, thin file, buro degradado)
// tambien deja fila en estudios_scorecard_sombra — con la traza de ejecucion
// (apis_fallidas, session_id, tiempo...) y encuadrada como 'no_calculable',
// que es lo unico que admite chk_scorecard_sombra_no_calculable sin puntaje.
// ============================================================

describe('construirFilaSombra — corrida sin puntaje (Politica §9)', () => {
  // Sin payload el motor devuelve la salida degradada: puntaje null.
  const degradada = evaluarSombra({
    proveedor: 'transunion',
    payload: null,
    fecha_evaluacion: '2026-09-08T12:00:00.000Z',
  });

  it('la corrida degradada del motor sale no_calculable y sin puntaje', () => {
    expect(degradada.puntaje_normalizado).toBeNull();
    expect(degradada.decision_sombra).toBe('no_calculable');
  });

  it('conserva la traza del §9 aunque no haya nada que puntuar', () => {
    const fila = construirFilaSombra('est-1', degradada, {
      apis_fallidas: ['datacredito', 'datacredito'],
      session_id: 'sesion-1',
      tiempo_procesamiento_ms: 1234,
      analista_responsable: 'AUTOMATICO',
    });
    expect(fila.decision_sombra).toBe('no_calculable');
    expect(fila.puntaje_normalizado).toBeNull();
    expect(fila.motivo_no_calculable).toBeTruthy();
    expect(fila.apis_fallidas).toEqual(['datacredito']);
    expect(fila.session_id).toBe('sesion-1');
    expect(fila.tiempo_procesamiento_ms).toBe(1234);
    expect(fila.analista_responsable).toBe('AUTOMATICO');
    expect(fila.fuente_ingreso_inferido).toBe('NO_DISPONIBLE');
  });

  // Nota QA V2 §2.4: la regla dura no calcula puntaje. La migracion
  // 20261001000010 admite 'rechazado' sin puntaje si hay regla dura.
  const rechazoSinPuntaje = {
    ...degradada,
    decision_sombra: 'rechazado' as const,
    decision_motivo: 'Regla dura global activada: listas_restrictivas',
    motivo_no_calculable: null,
    reglas_duras: [{ codigo: 'listas_restrictivas' as const, variable: 'global' as const, detalle: 'OFAC' }],
  };

  it('un rechazo por regla dura sin puntaje queda rechazado, con la regla como motivo', () => {
    const fila = construirFilaSombra('est-2', rechazoSinPuntaje);
    expect(fila.decision_sombra).toBe('rechazado');
    expect(fila.puntaje_normalizado).toBeNull();
    expect(fila.reglas_duras_activadas).toEqual(['listas_restrictivas']);
    expect(fila.motivo_no_calculable).toBe('Regla dura global activada: listas_restrictivas');
  });

  it('un rechazo sin puntaje y SIN regla dura sigue encuadrado como no_calculable', () => {
    const fila = construirFilaSombra('est-2b', { ...rechazoSinPuntaje, reglas_duras: [] });
    expect(fila.decision_sombra).toBe('no_calculable');
    expect((fila.features_crudas as Record<string, unknown>).decision_sombra_motor).toBe('rechazado');
  });

  it('antes de correr la migracion, el CHECK viejo no pierde la fila: se reintenta como no_calculable', async () => {
    mockUpserts.length = 0;
    await registrarScorecardSombra({ estudioId: 'est-4', expedienteId: 'exp-4', salidaPrecalculada: rechazoSinPuntaje });
    expect(mockUpserts.map((u) => [u.fila.decision_sombra, u.error?.code ?? null])).toEqual([
      ['rechazado', '23514'],
      ['no_calculable', null],
    ]);
    expect(mockUpserts[1].fila.reglas_duras_activadas).toEqual(['listas_restrictivas']);
    expect(mockUpserts[1].fila.motivo_no_calculable).toBe('Regla dura global activada: listas_restrictivas');
  });

  it('un score capturado a mano (PERSISTIDO) bajo 450 no dispara la regla dura ni anula el puntaje', () => {
    const manual = evaluarSombra({ proveedor: 'manual', payload: null, score_persistido: 420, canon_mensual_cop: 1_000_000, fecha_evaluacion: '2026-09-08T12:00:00.000Z' });
    expect(manual.features.score_modelo).toBe('PERSISTIDO');
    expect(manual.reglas_duras).toEqual([]);
    expect(manual.puntaje_normalizado).not.toBeNull();
    expect(aplicarReglasDuras({ resultadoPropuesto: 'aprobado', salida: manual }).rechaza).toBe(false);
  });

  it('no toca la decision cuando SI hay puntaje', () => {
    const conPuntaje = { ...degradada, puntaje_normalizado: 72, decision_sombra: 'revision_manual' as const };
    const fila = construirFilaSombra('est-3', conPuntaje);
    expect(fila.decision_sombra).toBe('revision_manual');
    expect(fila.puntaje_normalizado).toBe(72);
    expect((fila.features_crudas as Record<string, unknown>).decision_sombra_motor).toBe('revision_manual');
  });
});

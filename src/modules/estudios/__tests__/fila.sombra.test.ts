import { describe, it, expect } from 'vitest';
import { evaluarSombra } from '../motor';
import { construirFilaSombra } from '../motor/fila';

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

  it('encuadra como no_calculable un rechazo por regla dura global sin puntaje (CHECK de la tabla)', () => {
    // decidirSombra puede rechazar por listas restrictivas ANTES de tener
    // puntaje. Esa fila, tal cual, violaria el CHECK.
    const rechazoSinPuntaje = {
      ...degradada,
      decision_sombra: 'rechazado' as const,
      decision_motivo: 'Regla dura global activada: listas_restrictivas',
      motivo_no_calculable: null,
    };
    const fila = construirFilaSombra('est-2', rechazoSinPuntaje);
    expect(fila.decision_sombra).toBe('no_calculable');
    expect(fila.motivo_no_calculable).toBe('Regla dura global activada: listas_restrictivas');
    expect((fila.features_crudas as Record<string, unknown>).decision_sombra_motor).toBe('rechazado');
  });

  it('no toca la decision cuando SI hay puntaje', () => {
    const conPuntaje = { ...degradada, puntaje_normalizado: 72, decision_sombra: 'revision_manual' as const };
    const fila = construirFilaSombra('est-3', conPuntaje);
    expect(fila.decision_sombra).toBe('revision_manual');
    expect(fila.puntaje_normalizado).toBe(72);
    expect((fila.features_crudas as Record<string, unknown>).decision_sombra_motor).toBe('revision_manual');
  });
});

import { describe, it, expect } from 'vitest';
import { resolverRuta } from '../rutas-resultado';

// Revisión 2026-09-29 M8: con el trato de usted, «No necesita finca raíz» se
// leía como dicho al prospecto; quien no la necesita es el coarrendatario.
describe('zona gris: mensaje del coarrendatario', () => {
  it('dice que es el coarrendatario quien no necesita finca raíz', () => {
    const r = resolverRuta({
      puntaje: 75, resultadoVigente: 'aprobado', reglaDuraActivada: false,
      coarrendatarioVinculado: false, puntajeCoarrendatario: null,
    });
    expect(r.ruta).toBe('coarrendatario_requerido');
    expect(r.mensaje).toContain('Su coarrendatario no necesita finca raíz');
  });
});

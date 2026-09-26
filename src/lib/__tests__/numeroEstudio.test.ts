import { describe, it, expect } from 'vitest';
import { formatNumeroEstudio, limpiarBusquedaNumeroEstudio } from '../numeroEstudio';

describe('numero del estudio (Flujo §13)', () => {
  it('muestra «N.° 2026-0005» y no duplica el prefijo', () => {
    expect(formatNumeroEstudio('EXP-2026-0005')).toBe('N.° 2026-0005');
    expect(formatNumeroEstudio('N.° 2026-0005')).toBe('N.° 2026-0005');
    expect(formatNumeroEstudio(null)).toBe('');
  });

  it('la búsqueda acepta el guardado, el corto y el que se muestra', () => {
    expect(limpiarBusquedaNumeroEstudio('EXP-2026-0005')).toBe('EXP-2026-0005');
    expect(limpiarBusquedaNumeroEstudio('2026-0005')).toBe('2026-0005');
    expect(limpiarBusquedaNumeroEstudio('Estudio N.° 2026-0005')).toBe('2026-0005');
    expect(limpiarBusquedaNumeroEstudio('N° 2026-0005')).toBe('2026-0005');
    expect(limpiarBusquedaNumeroEstudio('estudio')).toBe('estudio');
  });
});

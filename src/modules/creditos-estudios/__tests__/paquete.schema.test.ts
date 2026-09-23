import { describe, it, expect } from 'vitest';
import { createPaqueteSchema, updatePaqueteSchema } from '../creditos-estudios.schema';

describe('descripción del paquete', () => {
  it('vacía se guarda como null (borrarla sí se aplica)', () => {
    expect(updatePaqueteSchema.parse({ descripcion: '  ' }).descripcion).toBeNull();
  });

  it('sin la clave no toca la columna y con texto lo conserva', () => {
    expect(updatePaqueteSchema.parse({ nombre: 'Básico' })).not.toHaveProperty('descripcion');
    expect(createPaqueteSchema.parse({ nombre: 'B', descripcion: 'x', cantidad_estudios: 1, precio_cop: 1000 }).descripcion).toBe('x');
  });
});

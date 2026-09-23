import { describe, it, expect } from 'vitest';
import { createPlantillaSchema } from '../plantillas.schema';

// La activa más reciente es la de todos los contratos nuevos: crear una
// plantilla sin decirlo no puede volverla la vigente.
describe('crear plantilla', () => {
  it('nace inactiva si no se pide lo contrario', () => {
    expect(createPlantillaSchema.parse({ nombre: 'Borrador', contenido: 'Texto' }).activa).toBe(false);
  });
});

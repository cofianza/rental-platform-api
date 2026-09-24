/**
 * P19 (Adenda 2 §5.1): el propietario directo sube los documentos del estudio
 * de su candidato y borra los suyos pendientes, pero no decide (no valida).
 * La inmobiliaria también borra su propio archivo pendiente.
 */
import { describe, it, expect } from 'vitest';
import { hasPermission } from '../permissions';

describe('documentos por rol', () => {
  it('el propietario sube y borra, pero no valida', () => {
    expect(hasPermission('propietario', 'documentos', 'create')).toBe(true);
    expect(hasPermission('propietario', 'documentos', 'delete')).toBe(true);
    expect(hasPermission('propietario', 'documentos', 'validar')).toBe(false);
  });

  it('la inmobiliaria borra su archivo pendiente, pero no valida', () => {
    expect(hasPermission('inmobiliaria', 'documentos', 'delete')).toBe(true);
    expect(hasPermission('inmobiliaria', 'documentos', 'validar')).toBe(false);
  });
});

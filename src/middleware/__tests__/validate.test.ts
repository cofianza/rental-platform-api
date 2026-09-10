import { describe, it, expect } from 'vitest';
import { mensajeDeValidacion } from '../validate';

describe('mensajeDeValidacion', () => {
  it('usa el mensaje del campo cuando el schema lo escribió', () => {
    expect(mensajeDeValidacion([{ field: 'email', message: 'Email invalido' }])).toBe('Email invalido');
  });

  it('cambia el mensaje por defecto de zod (en inglés) por uno genérico', () => {
    expect(mensajeDeValidacion([{ field: 'id', message: 'Invalid input: expected string, received undefined' }])).toBe(
      'Revisa los datos: hay un campo con un valor no válido.',
    );
  });

  it('dice cuántos errores más hay', () => {
    const errores = [
      { field: 'a', message: 'Minimo 1 mes' },
      { field: 'b', message: 'Email invalido' },
      { field: 'c', message: 'Token invalido' },
    ];
    expect(mensajeDeValidacion(errores)).toBe('Minimo 1 mes (y 2 errores más)');
    expect(mensajeDeValidacion(errores.slice(0, 2))).toBe('Minimo 1 mes (y 1 error más)');
  });
});

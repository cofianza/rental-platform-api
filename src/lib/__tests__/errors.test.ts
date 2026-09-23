import { describe, it, expect } from 'vitest';
import type { PostgrestError } from '@supabase/supabase-js';
import { fromSupabaseError } from '../errors';

const pg = (code: string, message: string) => ({ code, message, details: '', hint: '' }) as unknown as PostgrestError;

describe('fromSupabaseError', () => {
  it('un error de base sin mapear no le llega al usuario en ingles; el crudo queda en cause', () => {
    const crudo = pg('PGRST200', "Could not find a relationship between 'citas' and 'inmuebles'");
    const e = fromSupabaseError(crudo);
    expect(e).toMatchObject({ statusCode: 500, errorCode: 'DATABASE_ERROR' });
    expect(e.message).toBe('No pudimos completar la operación. Intenta de nuevo.');
    expect(e.cause).toBe(crudo);
  });

  it('el RAISE de nuestras funciones (P0001) conserva su mensaje en español', () => {
    const e = fromSupabaseError(pg('P0001', 'El estudio ya tiene un resultado registrado'));
    expect(e.message).toBe('El estudio ya tiene un resultado registrado');
  });

  it('los codigos mapeados siguen igual', () => {
    expect(fromSupabaseError(pg('23505', 'duplicate key'))).toMatchObject({ statusCode: 409, errorCode: 'DUPLICATE_ENTRY' });
  });
});

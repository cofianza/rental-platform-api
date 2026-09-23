import { describe, it, expect, vi } from 'vitest';

// Vencimiento del contrato V4 (PDF y contratos.fecha_fin): un inicio el 29, 30
// o 31 no puede correrse al mes siguiente.
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({}), storage: { from: () => ({}) } }, supabaseAuth: {} }));
vi.mock('@/config', () => ({ env: { RESEND_API_KEY: 're_test' } }));
vi.mock('@/config/env', () => ({ env: { RESEND_API_KEY: 're_test' } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { addMonths } from '../contratos.service';

const sumar = (iso: string, meses: number) => {
  const d = addMonths(new Date(`${iso}T00:00:00`), meses);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('addMonths', () => {
  it('sin el día en el mes de llegada, el último del mes', () => {
    expect(sumar('2026-08-31', 6)).toBe('2027-02-28');
    expect(sumar('2028-02-29', 12)).toBe('2029-02-28');
    expect(sumar('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('lo normal sigue igual', () => {
    expect(sumar('2026-10-01', 12)).toBe('2027-10-01');
    expect(sumar('2026-08-15', 6)).toBe('2027-02-15');
  });
});

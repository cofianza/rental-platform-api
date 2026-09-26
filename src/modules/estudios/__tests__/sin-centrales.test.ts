import { describe, it, expect } from 'vitest';
import { esSinCentrales } from '../decision';

describe('esSinCentrales (caso L, Política §14)', () => {
  it('ninguna central respondió', () => {
    expect(esSinCentrales({ centrales_consultadas: [], apis_fallidas: ['datacredito', 'transunion'] })).toBe(true);
  });
  it('respondió al menos una, o no hay traza', () => {
    expect(esSinCentrales({ centrales_consultadas: ['transunion'], apis_fallidas: ['datacredito'] })).toBe(false);
    expect(esSinCentrales({ centrales_consultadas: [], apis_fallidas: [] })).toBe(false);
    expect(esSinCentrales(null)).toBe(false);
    expect(esSinCentrales({})).toBe(false);
  });
});

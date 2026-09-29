import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/tenantScope', () => ({ resolveNombreDueno: vi.fn() }));

import { agruparCuposVencidos, rangoMesBogota } from '../reportes.service';

// Adenda de precios §3.9: cupos vencidos del mes para el registro contable.
describe('§3.9: reporte de cupos vencidos del mes', () => {
  it('el mes va de las 00:00 del día 1 a las 00:00 del mes siguiente, hora Colombia', () => {
    expect(rangoMesBogota('2026-09')).toEqual({ desde: '2026-09-01T00:00:00-05:00', hasta: '2026-10-01T00:00:00-05:00' });
    expect(rangoMesBogota('2026-12')).toEqual({ desde: '2026-12-01T00:00:00-05:00', hasta: '2027-01-01T00:00:00-05:00' });
  });

  it('agrupa por organización y compra con el valor base unitario de la compra (sin IVA)', () => {
    const paq5 = { cantidad_estudios: 5, precio_cop: 350000, completed_at: '2026-03-02T15:00:00Z', created_at: '2026-03-02T14:00:00Z' };
    const filas = agruparCuposVencidos(
      [
        { perfil_id: 'org-b', cantidad: -2, lote: { compra_id: 'c-1', compra: paq5 } },
        { perfil_id: 'org-b', cantidad: -1, lote: { compra_id: 'c-1', compra: paq5 } }, // reserva extinguida después
        { perfil_id: 'org-a', cantidad: -3, lote: { compra_id: null, compra: null } }, // ajuste sin compra
      ],
      new Map([['org-a', 'Alfa'], ['org-b', 'Beta']]),
    );
    expect(filas).toEqual([
      { perfil_id: 'org-a', organizacion: 'Alfa', compra_id: null, fecha_compra: null, cupos_paquete: null, cupos_vencidos: 3, valor_unitario: 0, valor_total: 0 },
      { perfil_id: 'org-b', organizacion: 'Beta', compra_id: 'c-1', fecha_compra: '2026-03-02T15:00:00Z', cupos_paquete: 5, cupos_vencidos: 3, valor_unitario: 70000, valor_total: 210000 },
    ]);
  });
});

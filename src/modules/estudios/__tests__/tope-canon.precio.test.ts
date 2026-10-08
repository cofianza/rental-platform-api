/**
 * CORR §5.2: GET /estudios/tope-canon trae también el precio que se le cobrará
 * al prospecto, con IVA incluido y sacado de la calibración (no un valor fijo).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../estudios.service', () => ({}));
vi.mock('../certificado.service', () => ({}));
vi.mock('../reasignacion.service', () => ({ reasignarEstudio: vi.fn() }));
vi.mock('../tarifa-override.service', () => ({}));
vi.mock('../tope-canon.guard', () => ({ getTopeCanonVigente: vi.fn(async () => 3_000_000) }));
vi.mock('@/modules/pago-estudio/pago-estudio.service', () => ({
  getPrecioEstudio: vi.fn(async () => ({ base: 80_000, iva: 15_200, total: 95_200, tarifaIva: 19 })),
  montoProspecto: (m: number, t: number) => `$${m.toLocaleString('es-CO')}${t > 0 ? ' (IVA incluido)' : ''}`,
}));

import { getTopeCanon } from '../estudios.controller';

describe('GET /estudios/tope-canon', () => {
  it('devuelve el tope y el precio al prospecto con IVA incluido', async () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    await getTopeCanon({} as never, res as never);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { tope_cop: 3_000_000, precio_estudio: '$95.200 (IVA incluido)' } }),
    );
  });
});

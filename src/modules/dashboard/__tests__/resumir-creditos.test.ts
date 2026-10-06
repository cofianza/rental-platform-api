import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/estudios/certificado.service', () => ({ viaDelEstudio: vi.fn() }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn() }));

import { resumirCreditos } from '../dashboard-secciones.service';

describe('resumirCreditos', () => {
  it('suma compras, disponibles y usados (último movimiento de cada pago = consumo)', () => {
    const r = resumirCreditos(
      [
        { perfil_id: 'a', cantidad_estudios: 10, fecha: '2026-09-01' },
        { perfil_id: 'a', cantidad_estudios: 5, fecha: '2026-10-01' },
      ],
      [{ perfil_id: 'a', cantidad_disponible: 11 }],
      [
        { perfil_id: 'a', pago_id: 'p1', tipo: 'reserva' },
        { perfil_id: 'a', pago_id: 'p1', tipo: 'consumo' },
        { perfil_id: 'a', pago_id: 'p2', tipo: 'reserva' }, // sigue reservado
        { perfil_id: 'a', pago_id: 'p3', tipo: 'reserva' },
        { perfil_id: 'a', pago_id: 'p3', tipo: 'liberacion' }, // sin resultado
        { perfil_id: 'a', pago_id: null, tipo: 'consumo' }, // consumo viejo
      ],
    );
    expect(r.get('a')).toEqual({ comprados: 15, usados: 2, disponibles: 11, ultimaCompra: '2026-10-01' });
  });
});

import { describe, it, expect } from 'vitest';
import { evaluarExpiracion } from '../expiracion';

// §12: un enlace detenido antes del plazo ("No soy yo", documento que no
// coincide, revocado) ya no espera al prospecto: le toca al gestor.

const DIA = 86_400_000;
const ahoraMs = Date.parse('2026-09-25T12:00:00Z');
const base = {
  estado: 'solicitado',
  autorizacionSolicitadaEn: new Date(ahoraMs - 2 * DIA).toISOString(),
  autorizacionFirmada: false,
  ahoraMs,
};

describe('evaluarExpiracion', () => {
  it('pendiente dentro del plazo: espera al prospecto', () => {
    const v = evaluarExpiracion({ ...base, autorizacionEstado: 'pendiente' });
    expect(v).toMatchObject({ expirado: false, diasRestantes: 13 });
    expect(v.detenida).toBeUndefined();
  });

  it("'expirado' o 'revocado' antes del plazo: detenida, le toca al gestor", () => {
    for (const autorizacionEstado of ['expirado', 'revocado']) {
      const v = evaluarExpiracion({ ...base, autorizacionEstado });
      expect(v).toMatchObject({ expirado: true, detenida: true, diasRestantes: null });
      expect(v.motivo).toContain('reenvia');
    }
  });

  it('vencido el plazo manda el reloj, aunque la fila diga expirado', () => {
    const v = evaluarExpiracion({
      ...base,
      autorizacionSolicitadaEn: new Date(ahoraMs - 20 * DIA).toISOString(),
      autorizacionEstado: 'expirado',
    });
    expect(v).toMatchObject({ expirado: true });
    expect(v.detenida).toBeUndefined();
    expect(v.motivo).toContain('no autorizo dentro de los 15 dias');
  });

  it('sin el estado (llamadores viejos) solo cuenta el reloj', () => {
    expect(evaluarExpiracion(base)).toMatchObject({ expirado: false });
  });
});

/**
 * POST /expedientes/:id/liberar-estudio-credito: el estudio tiene que estar en
 * la cartera de quien gasta el crédito. El servicio solo miraba la organización
 * del inmueble (perfilEsDuenoDeInmueble), así que el asesor restringido
 * liberaba con créditos de la inmobiliaria los estudios de sus compañeros.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { mockAssert, mockLiberar } = vi.hoisted(() => ({ mockAssert: vi.fn(), mockLiberar: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: mockAssert }));
vi.mock('../creditos-estudios.service', () => ({ liberarEstudioConCredito: mockLiberar }));
vi.mock('@/lib/response', () => ({ sendSuccess: vi.fn(), sendCreated: vi.fn() }));

import { liberarEstudio } from '../creditos-estudios.controller';

const req = {
  params: { expedienteId: 'exp-1' },
  body: {},
  user: { id: 'asesor', rol: 'inmobiliaria' },
  ip: '203.0.113.7',
} as unknown as Request;
const res = {} as Response;

beforeEach(() => vi.clearAllMocks());

describe('liberar un estudio con créditos', () => {
  it('estudio de un compañero (fuera de su cartera): 404 sin gastar créditos', async () => {
    mockAssert.mockRejectedValueOnce(Object.assign(new Error('Estudio no encontrado'), { statusCode: 404 }));
    await expect(liberarEstudio(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockAssert).toHaveBeenCalledWith('exp-1', 'asesor', 'inmobiliaria');
    expect(mockLiberar).not.toHaveBeenCalled();
  });

  it('en su cartera, libera', async () => {
    mockAssert.mockResolvedValueOnce(undefined);
    mockLiberar.mockResolvedValueOnce({ pago_id: 'p-1', saldo_restante: 3, lote_id: 'l-1' });
    await liberarEstudio(req, res);
    expect(mockLiberar).toHaveBeenCalledWith('exp-1', 'asesor', 'asesor', '203.0.113.7', undefined);
  });
});

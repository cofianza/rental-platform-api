/**
 * POST /expedientes/:id/liberar-estudio-credito: el estudio tiene que estar en
 * la cartera de quien gasta el crédito. El servicio solo miraba la organización
 * del inmueble (perfilEsDuenoDeInmueble), así que el asesor restringido
 * liberaba con créditos de la inmobiliaria los estudios de sus compañeros.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { mockAssert, mockLiberar, mockDueno, mockAvisar, mockSendCreated } = vi.hoisted(() => ({
  mockAssert: vi.fn(),
  mockLiberar: vi.fn(),
  mockDueno: vi.fn(),
  mockAvisar: vi.fn(async () => undefined),
  mockSendCreated: vi.fn(),
}));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: mockAssert }));
vi.mock('../creditos-estudios.service', () => ({
  liberarEstudioConCredito: mockLiberar,
  duenoCreditosDeExpediente: mockDueno,
  avisarCreditoUsadoPorCofianza: mockAvisar,
}));
vi.mock('@/lib/response', () => ({ sendSuccess: vi.fn(), sendCreated: mockSendCreated }));

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

// H99: Cofianza paga la evaluación con un crédito de la inmobiliaria dueña.
describe('liberar con crédito desde Cofianza (admin/operador)', () => {
  const reqInterno = (rol: string) =>
    ({ ...req, user: { id: 'operador-1', rol }, body: {} }) as unknown as Request;

  it.each(['administrador', 'operador_analista'])('%s: gasta el saldo del titular de la org y firma el movimiento', async (rol) => {
    mockAssert.mockResolvedValueOnce(undefined);
    mockDueno.mockResolvedValueOnce('titular-org');
    mockLiberar.mockResolvedValueOnce({ pago_id: 'p-1', saldo_restante: 2, lote_id: 'l-1' });
    await liberarEstudio(reqInterno(rol), res);
    expect(mockDueno).toHaveBeenCalledWith('exp-1');
    expect(mockLiberar).toHaveBeenCalledWith(
      'exp-1',
      'titular-org',
      'operador-1',
      '203.0.113.7',
      'Liberado por Cofianza con crédito del paquete de la inmobiliaria',
    );
    // La inmobiliaria se entera del crédito que gastó Cofianza, con el saldo que queda.
    expect(mockAvisar).toHaveBeenCalledWith('exp-1', 2, 'titular-org');
  });

  it('la respuesta no espera al aviso a la inmobiliaria', async () => {
    mockAssert.mockResolvedValueOnce(undefined);
    mockDueno.mockResolvedValueOnce('titular-org');
    mockLiberar.mockResolvedValueOnce({ pago_id: 'p-1', saldo_restante: 2, lote_id: 'l-1' });
    mockAvisar.mockReturnValueOnce(new Promise(() => undefined));
    await liberarEstudio(reqInterno('administrador'), res);
    expect(mockSendCreated).toHaveBeenCalledWith(res, expect.objectContaining({ saldo_restante: 2 }));
  });

  it('si el consumo falla no se avisa', async () => {
    mockAssert.mockResolvedValueOnce(undefined);
    mockDueno.mockResolvedValueOnce('titular-org');
    mockLiberar.mockRejectedValueOnce(new Error('SIN_SALDO_CREDITOS'));
    await expect(liberarEstudio(reqInterno('operador_analista'), res)).rejects.toThrow('SIN_SALDO_CREDITOS');
    expect(mockAvisar).not.toHaveBeenCalled();
  });

  it('estudio sin inmobiliaria (propietario individual): 409 sin tocar créditos', async () => {
    mockAssert.mockResolvedValueOnce(undefined);
    mockDueno.mockResolvedValueOnce(null);
    await expect(liberarEstudio(reqInterno('administrador'), res)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'SIN_INMOBILIARIA',
    });
    expect(mockLiberar).not.toHaveBeenCalled();
  });

  it('la inmobiliaria no pasa por la resolución del dueño (comportamiento igual)', async () => {
    mockAssert.mockResolvedValueOnce(undefined);
    mockLiberar.mockResolvedValueOnce({ pago_id: 'p-1', saldo_restante: 3, lote_id: 'l-1' });
    await liberarEstudio(req, res);
    expect(mockDueno).not.toHaveBeenCalled();
    // Gasta su propio crédito: no hay aviso.
    expect(mockAvisar).not.toHaveBeenCalled();
  });
});

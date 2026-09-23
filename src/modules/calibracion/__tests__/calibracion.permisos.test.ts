/**
 * Adenda 1 del módulo de contratos, respuesta 17: los parámetros de riesgo solo
 * los cambia la Gerencia General (GERENCIA_GENERAL_EMAILS, y además
 * administrador); los operativos, cualquier administrador. Toda modificación
 * deja valor anterior, valor nuevo, usuario y fecha.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { mockEnv, setParametro, listarParametros, logAudit, sendSuccess } = vi.hoisted(() => ({
  mockEnv: { CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000, GERENCIA_GENERAL_EMAILS: [] as string[] },
  setParametro: vi.fn(),
  listarParametros: vi.fn(),
  logAudit: vi.fn(),
  sendSuccess: vi.fn(),
}));

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/calibracion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/calibracion')>()),
  setParametro,
  listarParametros,
}));
vi.mock('@/lib/auditLog', () => ({
  logAudit,
  AUDIT_ACTIONS: { CALIBRACION_PARAMETRO_CAMBIADO: 'calibracion_parametro_cambiado' },
  AUDIT_ENTITIES: { CALIBRACION: 'calibracion' },
}));
vi.mock('@/lib/response', () => ({ sendSuccess }));
vi.mock('../calibracion.service', () => ({ resumenCascada: vi.fn(), resumenRevisionManual: vi.fn() }));

import { actualizar, listar } from '../calibracion.controller';
import { nivelDe, PARAMETROS, puedeEditarParametro } from '@/lib/calibracion';

const ADMIN = { id: 'u-admin', email: 'analista@cofianza.co', rol: 'administrador', activo: true };
const GERENTE = { ...ADMIN, id: 'u-mario', email: 'mario@cofianza.co' };
const patch = (user: typeof ADMIN, clave: string, valor: number) =>
  ({ params: { clave }, body: { valor, motivo: 'prueba' }, user, ip: '1.1.1.1' }) as unknown as Request;
const res = {} as Response;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.GERENCIA_GENERAL_EMAILS = ['mario@cofianza.co'];
  setParametro.mockImplementation(async (clave: string, valor: number) => ({ clave, valor, valor_anterior: 15 }));
});

describe('clasificación riesgo / operativo', () => {
  it('solo los plazos operativos quedan fuera de la Gerencia General; en la duda, riesgo', () => {
    const operativos = PARAMETROS.filter((p) => nivelDe(p.clave) === 'operativo').map((p) => p.clave);
    expect(operativos).toEqual(['DIAS_EXPIRACION_ESTUDIO', 'VIGENCIA_MESES_DEFECTO', 'DIAS_EXPIRACION_FIRMA', 'DIAS_RESERVA_INMUEBLE']);
    for (const clave of ['CANON_MAX_TRANSITORIO', 'TOPE_CANON_COMERCIAL', 'UMBRAL_SCORE_RECHAZO', 'VIGENCIA_CRC_DIAS'])
      expect(nivelDe(clave)).toBe('riesgo');
    expect(nivelDe('NO_EXISTE')).toBe('riesgo');
  });

  it('la lista blanca no sirve sin el rol administrador', () => {
    expect(puedeEditarParametro('UMBRAL_ZONA_GRIS', { rol: 'gerencia_consulta', email: 'mario@cofianza.co' })).toBe(false);
    expect(puedeEditarParametro('DIAS_EXPIRACION_FIRMA', { rol: 'operador_analista', email: 'x@y.co' })).toBe(false);
  });
});

describe('PATCH /admin/calibracion/:clave', () => {
  // El permiso por nivel (403) lo exige setParametro: lib/__tests__/calibracion.test.ts.
  it('pasa el usuario completo a setParametro y la bitácora queda con valor anterior, nuevo, nivel y correo', async () => {
    await actualizar(patch(ADMIN, 'DIAS_EXPIRACION_FIRMA', 20), res);

    expect(setParametro).toHaveBeenCalledWith('DIAS_EXPIRACION_FIRMA', 20, ADMIN, 'prueba');
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      usuarioId: 'u-admin',
      entidadId: 'DIAS_EXPIRACION_FIRMA',
      detalle: { valor_anterior: 15, valor_nuevo: 20, nivel: 'operativo', email: 'analista@cofianza.co', motivo: 'prueba' },
    });
  });

  it('si setParametro rechaza (403), no queda bitácora', async () => {
    setParametro.mockRejectedValueOnce(Object.assign(new Error('x'), { statusCode: 403 }));
    await expect(actualizar(patch(ADMIN, 'UMBRAL_ZONA_GRIS', 72), res)).rejects.toMatchObject({ statusCode: 403 });
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('GET /admin/calibracion', () => {
  it('dice el nivel de cada parámetro y si ESTE usuario puede editarlo', async () => {
    listarParametros.mockResolvedValue(
      PARAMETROS.map((p) => ({ ...p, valor: p.valorDefault, actualizado_en: null, actualizado_por: null })),
    );
    const filas = async (user: typeof ADMIN) => {
      sendSuccess.mockClear();
      await listar({ user } as unknown as Request, res);
      return sendSuccess.mock.calls[0][1] as Array<{ clave: string; nivel: string; editable: boolean }>;
    };

    const admin = await filas(ADMIN);
    expect(admin.find((f) => f.clave === 'TOPE_CANON_COMERCIAL')).toMatchObject({ nivel: 'riesgo', editable: false });
    expect(admin.find((f) => f.clave === 'DIAS_EXPIRACION_FIRMA')).toMatchObject({ nivel: 'operativo', editable: true });
    expect((await filas(GERENTE)).every((f) => f.editable)).toBe(true);
  });
});

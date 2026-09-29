import { describe, it, expect, vi, beforeEach } from 'vitest';

// Adenda de precios v1.0 §7.1, §7.3, §7.4.
const { filas, ops, mockAudit, mockEscalar } = vi.hoisted(() => ({
  filas: {} as Record<string, unknown>,
  ops: [] as Array<{ table: string; method: string; payload?: unknown }>,
  mockAudit: vi.fn(),
  mockEscalar: vi.fn(async (..._a: unknown[]) => true),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: filas[table] ?? null, error: null });
      chain.update = (payload: unknown) => {
        ops.push({ table, method: 'update', payload });
        return { eq: async () => ({ error: null }) };
      };
      chain.insert = async (payload: unknown) => {
        ops.push({ table, method: 'insert', payload });
        return { error: null };
      };
      return chain;
    },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { GERENCIA_GENERAL_EMAILS: ['gerencia@cofianza.co'] } }));
vi.mock('@/config/env', () => ({ env: { CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));
vi.mock('@/lib/calibracion', () => ({
  getCalibracion: vi.fn(async () => ({ CANON_MAX_TRANSITORIO: 3_000_000, TOPE_CANON_COMERCIAL: 4_000_000 })),
}));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn(async () => undefined) }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: mockAudit,
  AUDIT_ACTIONS: { EXPEDIENTE_EXCEPCION_TOPE: 'expediente_excepcion_tope' },
  AUDIT_ENTITIES: { EXPEDIENTE: 'expediente' },
}));
vi.mock('@/modules/contratos/tope-coafianzamiento', () => ({ escalarTopeCanon: mockEscalar }));

import {
  assertAprobacionDentroDelTope,
  autorizarExcepcionTope,
  calConExcepcion,
  requiereGerencia,
  retenerAprobadoSobreTope,
} from '../excepcion-tope.service';

const GERENCIA = { id: 'ger-1', rol: 'administrador', email: 'gerencia@cofianza.co' };
const ADMIN = { id: 'adm-1', rol: 'administrador', email: 'admin@cofianza.co' };
const OPERADOR = { id: 'op-1', rol: 'operador_analista', email: 'op@cofianza.co' };

const caso = (canon: number, excepcion: number | null = null) => {
  filas.expedientes = { inmueble_id: 'inm-1', estado: 'condicionado', excepcion_tope_canon_cop: excepcion };
  filas.inmuebles = { valor_arriendo: String(canon), uso: 'vivienda' };
};

beforeEach(() => {
  ops.length = 0;
  mockAudit.mockClear();
  mockEscalar.mockClear();
});

describe('reglas puras', () => {
  it('requiereGerencia: solo sobre el tope y sin excepción (el tope es inclusivo)', () => {
    expect(requiereGerencia({ canonCop: 3_000_000, topeCop: 3_000_000, excepcionCop: null })).toBe(false);
    expect(requiereGerencia({ canonCop: 3_000_001, topeCop: 3_000_000, excepcionCop: null })).toBe(true);
    expect(requiereGerencia({ canonCop: 3_500_000, topeCop: 3_000_000, excepcionCop: 3_500_000 })).toBe(false);
    expect(requiereGerencia({ canonCop: null, topeCop: 3_000_000, excepcionCop: null })).toBe(false);
  });

  it('calConExcepcion: el canon autorizado es el techo; sin excepción, la calibración igual', () => {
    const cal = { CANON_MAX_TRANSITORIO: 3_000_000, TOPE_CANON_COMERCIAL: 4_000_000 };
    expect(calConExcepcion(cal, null)).toBe(cal);
    expect(calConExcepcion(cal, '3500000.00')).toEqual({ CANON_MAX_TRANSITORIO: 3_500_000, TOPE_CANON_COMERCIAL: 4_000_000 });
  });
});

describe('§7.3 — aprobar por encima del tope', () => {
  it('operador o administrador que no es Gerencia: 403 SOLO_GERENCIA_GENERAL', async () => {
    caso(3_500_000);
    for (const u of [OPERADOR, ADMIN]) {
      await expect(assertAprobacionDentroDelTope('exp-1', u)).rejects.toMatchObject({
        statusCode: 403,
        errorCode: 'SOLO_GERENCIA_GENERAL',
      });
    }
    expect(ops).toHaveLength(0);
  });

  it('dentro del tope, o con la excepción registrada, aprueba cualquiera', async () => {
    caso(3_000_000);
    await expect(assertAprobacionDentroDelTope('exp-1', OPERADOR)).resolves.toBeUndefined();
    caso(3_500_000, 3_500_000);
    await expect(assertAprobacionDentroDelTope('exp-1', OPERADOR)).resolves.toBeUndefined();
    expect(ops).toHaveLength(0);
  });

  it('la Gerencia aprueba directo y la excepción queda registrada con el canon del inmueble', async () => {
    caso(3_500_000);
    await assertAprobacionDentroDelTope('exp-1', GERENCIA);
    expect(ops.find((o) => o.table === 'expedientes')?.payload).toMatchObject({
      excepcion_tope_canon_cop: 3_500_000,
      excepcion_tope_por: 'ger-1',
    });
  });
});

describe('§7.3-7.4 — la Gerencia autoriza la excepción', () => {
  it('no Gerencia: 403 sin escribir', async () => {
    caso(3_500_000);
    await expect(
      autorizarExcepcionTope('exp-1', { canon_autorizado_cop: 3_600_000, motivo: 'Arrendatario con respaldo' }, ADMIN),
    ).rejects.toMatchObject({ statusCode: 403, errorCode: 'SOLO_GERENCIA_GENERAL' });
    expect(ops).toHaveLength(0);
  });

  it('registra usuario, fecha y hora, canon autorizado y motivo; timeline y bitácora', async () => {
    caso(3_500_000);
    const r = await autorizarExcepcionTope('exp-1', { canon_autorizado_cop: 3_600_000, motivo: ' Respaldo patrimonial ' }, GERENCIA, '1.2.3.4');
    expect(r.excepcionCop).toBe(3_600_000);
    const upd = ops.find((o) => o.table === 'expedientes' && o.method === 'update')?.payload as Record<string, unknown>;
    expect(upd).toMatchObject({ excepcion_tope_canon_cop: 3_600_000, excepcion_tope_por: 'ger-1', excepcion_tope_motivo: 'Respaldo patrimonial' });
    expect(typeof upd.excepcion_tope_en).toBe('string');
    expect(ops.some((o) => o.table === 'eventos_timeline' && o.method === 'insert')).toBe(true);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ usuarioId: 'ger-1', accion: 'expediente_excepcion_tope', entidadId: 'exp-1', ip: '1.2.3.4' }),
    );
  });

  it('un canon autorizado que no supera el tope no es excepción: 400', async () => {
    caso(3_500_000);
    await expect(
      autorizarExcepcionTope('exp-1', { canon_autorizado_cop: 3_000_000, motivo: 'Motivo suficiente' }, GERENCIA),
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'EXCEPCION_TOPE_NO_APLICA' });
  });
});

describe('§7.1 — el motor manda a revisión', () => {
  it('aprobado sobre el tope sin excepción → condicionado con nota y escala a la Gerencia', async () => {
    caso(3_500_000);
    const r = await retenerAprobadoSobreTope('exp-1', { resultado: 'aprobado', observaciones: 'Puntaje 90' });
    expect(r.resultado).toBe('condicionado');
    expect(r.observaciones).toContain('Gerencia General');
    await vi.waitFor(() => expect(mockEscalar).toHaveBeenCalledWith('exp-1', 3_500_000, 3_000_000, 'estudio'));
  });

  it('nunca rechaza por el tope, y dentro del tope o con excepción no toca nada', async () => {
    caso(3_500_000);
    const rechazado = { resultado: 'rechazado', observaciones: null };
    expect(await retenerAprobadoSobreTope('exp-1', rechazado)).toBe(rechazado);
    const aprobado = { resultado: 'aprobado', observaciones: null };
    caso(2_000_000);
    expect(await retenerAprobadoSobreTope('exp-1', aprobado)).toBe(aprobado);
    caso(3_500_000, 3_500_000);
    expect(await retenerAprobadoSobreTope('exp-1', aprobado)).toBe(aprobado);
  });
});

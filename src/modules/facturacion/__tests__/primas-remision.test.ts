import { describe, it, expect, vi, beforeEach } from 'vitest';

// Adenda de precios §5.1-§5.3: prima Trasladada por remitir. Mock de Supabase
// con colas por tabla (patrón de reconciliar.test): cada await consume el
// siguiente resultado de la tabla; todas las llamadas quedan en `ops`.

const { ops, queues, enqueue, next, efectos } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (t: string): Res => queues.get(t)?.shift() ?? { data: null, error: null };
  return {
    ops,
    queues,
    enqueue: (t: string, ...items: Res[]) => queues.set(t, [...(queues.get(t) ?? []), ...items]),
    next,
    efectos: { notificar: vi.fn(async () => undefined), correo: vi.fn(async () => undefined), audit: vi.fn() },
  };
});

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'is', 'not', 'in', 'order', 'limit'])
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return { supabase: { from: (t: string) => chainFor(t) } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: efectos.audit, AUDIT_ACTIONS: { PRIMA_REMITIDA: 'prima_remitida' }, AUDIT_ENTITIES: { CONTRATO: 'contrato' } }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: efectos.notificar,
  enviarCorreoNotificacion: efectos.correo,
}));

import { barrerReporteRemision, marcarRemitida, registrarPrimaTrasladada, venceRemision, venceReportadoHoy } from '../primas-remision.service';

const tabla = (t: string, m: string) => ops.filter((o) => o.table === t && o.method === m);
const ok = (data: unknown) => ({ data, error: null });

beforeEach(() => {
  ops.length = 0;
  queues.clear();
  vi.clearAllMocks();
});

describe('venceRemision (§5.1: día 10 del mes siguiente; §5.3: 10 días de anticipación)', () => {
  it.each([
    ['2026-09-01', '2026-10-10'],
    ['2026-09-20', '2026-10-10'], // último día fuera de la ventana (30 − 10)
    ['2026-09-21', '2026-11-10'], // entra en los últimos 10 días del mes
    ['2026-09-30', '2026-11-10'],
    ['2026-10-21', '2026-11-10'], // octubre tiene 31: el 21 aún no es de los últimos 10
    ['2026-10-22', '2026-12-10'],
    ['2026-11-25', '2027-01-10'], // cruce de año
    ['2026-12-31', '2027-02-10'],
    ['2027-02-18', '2027-03-10'], // febrero de 28 días
    ['2027-02-19', '2027-04-10'],
    ['2028-02-19', '2028-03-10'], // febrero bisiesto (29)
    ['2028-02-20', '2028-04-10'],
  ])('activación %s → remitir a más tardar %s', (activacion, vence) => {
    expect(venceRemision(activacion)).toBe(vence);
  });

  it('el reporte del último día del mes previo siempre queda después de la activación y 10 días antes', () => {
    for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2029, 0, 1); d += 86_400_000) {
      const activacion = new Date(d).toISOString().slice(0, 10);
      const vence = venceRemision(activacion);
      const [a, m] = vence.split('-').map(Number);
      const reporte = new Date(Date.UTC(a, m - 1, 0)).toISOString().slice(0, 10); // último día del mes anterior
      expect(venceReportadoHoy(reporte)).toBe(vence);
      expect(reporte > activacion).toBe(true);
      expect((Date.parse(vence) - Date.parse(reporte)) / 86_400_000).toBe(10);
    }
  });

  it('venceReportadoHoy: solo el último día del mes', () => {
    expect(venceReportadoHoy('2026-09-30')).toBe('2026-10-10');
    expect(venceReportadoHoy('2026-12-31')).toBe('2027-01-10');
    expect(venceReportadoHoy('2027-02-28')).toBe('2027-03-10');
    expect(venceReportadoHoy('2028-02-28')).toBeNull();
    expect(venceReportadoHoy('2026-09-29')).toBeNull();
  });
});

describe('registrarPrimaTrasladada', () => {
  const entrada = { inmobiliariaId: 'org1', contratoId: 'c1', montoCop: 71400, venceEn: '2026-10-10' };

  it('upsert idempotente por (contrato, concepto) que no pisa una fila ya creada; monto completo (§5.2: sin beneficio ni descuento)', async () => {
    await registrarPrimaTrasladada(entrada);
    const [up] = tabla('cuentas_por_cobrar_inmobiliaria', 'upsert');
    expect(up.args[0]).toEqual({ inmobiliaria_id: 'org1', contrato_id: 'c1', concepto: 'prima_trasladada', monto_cop: 71400, vence_en: '2026-10-10' });
    expect(up.args[1]).toEqual({ onConflict: 'contrato_id,concepto', ignoreDuplicates: true });
  });

  it('un error de la base lanza (la activación se reintenta); sin la migración no rompe la activación', async () => {
    enqueue('cuentas_por_cobrar_inmobiliaria', { data: null, error: { code: '08006', message: 'caída' } });
    await expect(registrarPrimaTrasladada(entrada)).rejects.toThrow('caída');
    enqueue('cuentas_por_cobrar_inmobiliaria', { data: null, error: { code: 'PGRST205', message: 'no table' } });
    await expect(registrarPrimaTrasladada(entrada)).resolves.toBeUndefined();
  });
});

describe('barrerReporteRemision (§5.3)', () => {
  const FILAS = [
    { id: 'x1', inmobiliaria_id: 'org1', contrato_id: 'c1', monto_cop: 71400, vence_en: '2026-10-10', estado: 'pendiente', contratos: { numero: 'CTO-1', expediente_id: 'e1', direccion: 'Calle 1' } },
    { id: 'x2', inmobiliaria_id: 'org1', contrato_id: 'c2', monto_cop: 35700, vence_en: '2026-10-10', estado: 'pendiente', contratos: { numero: 'CTO-2', expediente_id: 'e2', direccion: null } },
  ];
  // 30/09 18:00 en Bogotá = 23:00 UTC; 01/10 02:00 UTC sigue siendo 30/09 en Bogotá.
  const ULTIMO_DIA = new Date('2026-09-30T23:00:00Z');

  it('fuera del último día del mes no consulta nada', async () => {
    expect(await barrerReporteRemision(new Date('2026-09-29T15:00:00Z'))).toEqual({ inmobiliarias: 0 });
    expect(await barrerReporteRemision(new Date('2026-10-01T06:00:00Z'))).toEqual({ inmobiliarias: 0 });
    expect(ops).toEqual([]);
  });

  it('el último día (hora de Bogotá) avisa a los titulares con el detalle y deja constancia para no repetir', async () => {
    enqueue('cuentas_por_cobrar_inmobiliaria', ok(FILAS));
    enqueue('inmobiliaria_miembros', ok([{ perfil_id: 'm1' }, { perfil_id: 'm4' }]));
    expect(await barrerReporteRemision(new Date('2026-10-01T02:00:00Z'))).toEqual({ inmobiliarias: 1 });

    const filtros = ops.filter((o) => o.table === 'cuentas_por_cobrar_inmobiliaria').map((o) => [o.method, ...o.args]);
    expect(filtros).toContainEqual(['eq', 'estado', 'pendiente']);
    expect(filtros).toContainEqual(['eq', 'vence_en', '2026-10-10']);
    expect(filtros).toContainEqual(['is', 'reporte_enviado_en', null]);
    expect(tabla('inmobiliaria_miembros', 'eq').map((o) => o.args)).toContainEqual(['rol_miembro', 'owner']);

    const avisos = efectos.notificar.mock.calls.map((c) => (c as unknown as [{ userId: string; titulo: string; mensaje: string }])[0]);
    expect(avisos.map((a) => a.userId)).toEqual(['m1', 'm4']);
    expect(efectos.correo).toHaveBeenCalledTimes(2);
    expect(avisos[0].titulo).toContain('10/10/2026');
    expect(avisos[0].mensaje).toContain('Le informamos');
    expect(avisos[0].mensaje).toContain('contrato CTO-1, inmueble Calle 1: $71.400 (IVA incluido)');
    expect(avisos[0].mensaje).toContain('contrato CTO-2: $35.700 (IVA incluido)');
    expect(avisos[0].mensaje).toContain('Total: $107.100 (IVA incluido)');

    const [marca] = tabla('cuentas_por_cobrar_inmobiliaria', 'update');
    expect(marca.args[0]).toHaveProperty('reporte_enviado_en');
    expect(tabla('cuentas_por_cobrar_inmobiliaria', 'in')[0].args).toEqual(['id', ['x1', 'x2']]);
  });

  it('ya reportadas (la consulta no las devuelve): no repite', async () => {
    enqueue('cuentas_por_cobrar_inmobiliaria', ok([]));
    expect(await barrerReporteRemision(ULTIMO_DIA)).toEqual({ inmobiliarias: 0 });
    expect(efectos.notificar).not.toHaveBeenCalled();
    expect(tabla('cuentas_por_cobrar_inmobiliaria', 'update')).toEqual([]);
  });

  it('una inmobiliaria sin titulares activos no queda marcada: se reintenta en la siguiente pasada', async () => {
    enqueue('cuentas_por_cobrar_inmobiliaria', ok(FILAS));
    enqueue('inmobiliaria_miembros', ok([]));
    expect(await barrerReporteRemision(ULTIMO_DIA)).toEqual({ inmobiliarias: 0 });
    expect(tabla('cuentas_por_cobrar_inmobiliaria', 'update')).toEqual([]);
  });
});

describe('marcarRemitida', () => {
  it('solo pasa de pendiente a remitida, con quién, cuándo y nota; deja traza en la bitácora', async () => {
    enqueue('cuentas_por_cobrar_inmobiliaria', ok({ id: 'x1', contrato_id: 'c1', monto_cop: 71400, vence_en: '2026-10-10' }));
    await marcarRemitida('x1', 'op1', 'Transferencia 123', '1.2.3.4');
    const [up] = tabla('cuentas_por_cobrar_inmobiliaria', 'update');
    expect(up.args[0]).toMatchObject({ estado: 'remitida', remitida_por: 'op1', notas: 'Transferencia 123' });
    expect(tabla('cuentas_por_cobrar_inmobiliaria', 'eq').map((o) => o.args)).toContainEqual(['estado', 'pendiente']);
    expect(efectos.audit).toHaveBeenCalledWith(
      expect.objectContaining({ usuarioId: 'op1', accion: 'prima_remitida', entidadId: 'c1', detalle: expect.objectContaining({ cuenta_id: 'x1' }) }),
    );
  });

  it('una ya remitida responde 409 y una que no existe 404', async () => {
    enqueue('cuentas_por_cobrar_inmobiliaria', ok(null), ok({ estado: 'remitida' }));
    await expect(marcarRemitida('x1', 'op1', null)).rejects.toMatchObject({ statusCode: 409, errorCode: 'CUENTA_NO_PENDIENTE' });
    enqueue('cuentas_por_cobrar_inmobiliaria', ok(null), ok(null));
    await expect(marcarRemitida('x9', 'op1', null)).rejects.toMatchObject({ statusCode: 404 });
    expect(efectos.audit).not.toHaveBeenCalled();
  });
});

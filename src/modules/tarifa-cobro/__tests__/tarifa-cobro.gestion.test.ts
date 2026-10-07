import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Plan cobro-tarifa-mensual §6, pagos, anulación y alcance (B5, B6, B9).
// Mock de Supabase con colas por tabla: cada await consume el siguiente
// resultado de la tabla; todas las llamadas quedan en `ops`.

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
    efectos: {
      membresia: vi.fn(async () => null as { orgId: string; rolMiembro: string } | null),
      assertExpediente: vi.fn(async () => undefined),
      admins: vi.fn(async () => undefined),
      gerencia: vi.fn(async () => undefined),
      titulares: vi.fn(async () => 1),
      aviso: vi.fn(async () => undefined),
    },
  };
});

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'neq', 'is', 'not', 'in', 'lt', 'gt', 'order', 'limit', 'range'])
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return { supabase: { from: (t: string) => chainFor(t) } };
});
vi.mock('@/config', () => ({ env: { GERENCIA_GENERAL_EMAILS: ['gg@cofianza.co'] } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: async () => ({ TARIFA_COBRO_DESDE: 202611, IPC_ANUAL: 5.1 }), mesCobroDesde: () => '2026-11-01' }));
vi.mock('@/lib/tenantScope', () => ({ getActiveMembership: efectos.membresia, assertExpedienteAccess: efectos.assertExpediente }));
vi.mock('@/modules/pagos/pagos.service', () => ({ avisarAdministradores: efectos.admins }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: efectos.aviso }));
vi.mock('../tarifa-cobro.service', () => ({ avisarGerencia: efectos.gerencia, avisarTitulares: efectos.titulares, leerContratos: vi.fn() }));

import {
  anularLinea,
  listarCuentas,
  marcarNoRecaudada,
  obtenerCuenta,
  pagarCuenta,
  pagarLinea,
  recordarAtrasos,
  registrarCondicion,
  revisarLineasPorTerminacion,
} from '../tarifa-cobro.gestion.service';

const ok = (data: unknown) => ({ data, error: null });
const de = (t: string, m: string) => ops.filter((o) => o.table === t && o.method === m);
const L = 'cuentas_cobro_tarifa_lineas';
const K = 'cuentas_cobro_tarifa';
const ADMIN = { id: 'a1', rol: 'administrador', email: 'ops@cofianza.co' };
const GERENCIA = { id: 'g1', rol: 'administrador', email: 'gg@cofianza.co' };
const TITULAR = { id: 't1', rol: 'inmobiliaria', email: 't@inmo.co' };
const PAGO = { referencia: 'TRF-1', fecha: '2026-12-08' };
const linea = (o: Record<string, unknown> = {}) => ({
  id: 'l1',
  estado: 'pendiente',
  periodo: '2026-12-01',
  modalidad: 'tradicional',
  facturable: true,
  contrato_id: 'c1',
  total_cop: 29750,
  cuenta: { id: 'k1', estado: 'emitida', inmobiliaria_id: 'orgA', periodo: '2026-12-01', factura_id: 'f1' },
  contrato: { numero: 'CTO-1' },
  ...o,
});

beforeEach(() => {
  ops.length = 0;
  queues.clear();
  vi.clearAllMocks();
  efectos.membresia.mockResolvedValue({ orgId: 'orgA', rolMiembro: 'owner' });
});

describe('pagos (B5)', () => {
  it('pago de una línea: condicionado a pendiente/no_recaudada, con fecha y referencia', async () => {
    enqueue(L, ok(linea()), ok({ id: 'l1', estado: 'pagada' }));
    await pagarLinea('l1', PAGO, 'a1');
    const upd = de(L, 'update')[0].args[0] as Record<string, unknown>;
    expect(upd).toMatchObject({ estado: 'pagada', pagada_en: '2026-12-08', referencia_pago: 'TRF-1', marcada_por: 'a1' });
    expect(de(L, 'in')).toContainEqual({ table: L, method: 'in', args: ['estado', ['pendiente', 'no_recaudada']] });
  });

  it('carrera entre dos confirmaciones: la segunda recibe 409', async () => {
    enqueue(L, ok(linea()), ok(null));
    await expect(pagarLinea('l1', PAGO, 'a1')).rejects.toMatchObject({ statusCode: 409, errorCode: 'LINEA_NO_PENDIENTE' });
  });

  it('no_recaudada → pagada cuando el arrendatario paga tarde (Trasladada)', async () => {
    enqueue(L, ok(linea({ estado: 'no_recaudada', modalidad: 'trasladada', facturable: false })), ok({ id: 'l1', estado: 'pagada' }));
    await expect(pagarLinea('l1', PAGO, 'a1')).resolves.toMatchObject({ estado: 'pagada' });
  });

  it('no se paga una línea de una cuenta sin emitir', async () => {
    enqueue(L, ok(linea({ cuenta: { id: 'k1', estado: 'borrador', inmobiliaria_id: 'orgA', factura_id: null } })));
    await expect(pagarLinea('l1', PAGO, 'a1')).rejects.toMatchObject({ statusCode: 409 });
    expect(de(L, 'update')).toHaveLength(0);
  });

  it('cuenta entera: una sola actualización sobre las pendientes; sin pendientes, 409', async () => {
    enqueue(K, ok({ id: 'k1', estado: 'emitida', inmobiliaria_id: 'orgA', periodo: '2026-12-01' }));
    enqueue(L, ok([{ id: 'l1' }, { id: 'l2' }]));
    await expect(pagarCuenta('k1', PAGO, 'a1')).resolves.toEqual({ cuenta_id: 'k1', lineas_pagadas: 2 });
    expect(de(L, 'update')).toHaveLength(1);
    expect(de(L, 'eq')).toContainEqual({ table: L, method: 'eq', args: ['estado', 'pendiente'] });

    enqueue(K, ok({ id: 'k1', estado: 'emitida', inmobiliaria_id: 'orgA', periodo: '2026-12-01' }));
    enqueue(L, ok([]));
    await expect(pagarCuenta('k1', PAGO, 'a1')).rejects.toMatchObject({ statusCode: 409, errorCode: 'CUENTA_SIN_PENDIENTES' });
  });
});

describe('no recaudada (D11)', () => {
  it('el titular la marca en Trasladada; avisa a Cofianza y le recuerda reportar la mora', async () => {
    enqueue(L, ok(linea({ modalidad: 'trasladada', facturable: false })), ok({ id: 'l1', estado: 'no_recaudada' }));
    await marcarNoRecaudada('l1', TITULAR);
    expect(efectos.admins).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'tarifa.no_recaudada' }));
    expect(efectos.aviso).toHaveBeenCalledWith(expect.objectContaining({ userId: 't1', tipo: 'tarifa.recordar_mora', link: '/moras' }));
  });

  it('en Tradicional no se puede', async () => {
    enqueue(L, ok(linea()));
    await expect(marcarNoRecaudada('l1', TITULAR)).rejects.toMatchObject({ statusCode: 409, errorCode: 'LINEA_NO_TRASLADADA' });
  });

  it('solo_lectura y miembros no titulares: 403 sin tocar nada', async () => {
    for (const rolMiembro of ['solo_lectura', 'miembro']) {
      efectos.membresia.mockResolvedValueOnce({ orgId: 'orgA', rolMiembro });
      await expect(marcarNoRecaudada('l1', TITULAR)).rejects.toMatchObject({ statusCode: 403, errorCode: 'SOLO_TITULARES' });
    }
    expect(ops).toHaveLength(0);
  });

  it('una línea de otra inmobiliaria: 404', async () => {
    enqueue(L, ok(linea({ modalidad: 'trasladada', cuenta: { id: 'k9', estado: 'emitida', inmobiliaria_id: 'orgB', factura_id: null } })));
    await expect(marcarNoRecaudada('l1', TITULAR)).rejects.toMatchObject({ statusCode: 404 });
    expect(de(L, 'update')).toHaveLength(0);
  });
});

describe('alcance multi-tenant', () => {
  it('el titular de A solo lista las cuentas de A', async () => {
    enqueue(K, ok([]));
    await listarCuentas(TITULAR);
    expect(de(K, 'eq')).toContainEqual({ table: K, method: 'eq', args: ['inmobiliaria_id', 'orgA'] });
  });

  it('Cofianza lista sin filtro de organización', async () => {
    enqueue(K, ok([]));
    await listarCuentas(ADMIN);
    expect(de(K, 'eq')).toHaveLength(0);
    expect(efectos.membresia).not.toHaveBeenCalled();
  });

  it('el titular de A no abre la cuenta de B (404)', async () => {
    enqueue(K, ok({ id: 'k9', inmobiliaria_id: 'orgB', estado: 'emitida', vence_en: '2026-12-10', lineas: [] }));
    await expect(obtenerCuenta('k9', TITULAR)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('un miembro que no es titular recibe 403', async () => {
    efectos.membresia.mockResolvedValueOnce({ orgId: 'orgA', rolMiembro: 'miembro' });
    await expect(listarCuentas(TITULAR)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('la situación sale de las líneas y el saldo es lo pendiente', async () => {
    enqueue(K, ok([{ id: 'k1', inmobiliaria_id: 'orgA', estado: 'emitida', vence_en: '2000-01-10', periodo: '2000-01-01', lineas: [
      { estado: 'pagada', total_cop: 100, requiere_nota_credito: false },
      { estado: 'pendiente', total_cop: 29750.4, requiere_nota_credito: false },
    ] }]));
    const [c] = await listarCuentas(ADMIN, { situacion: 'vencida' });
    expect(c).toMatchObject({ situacion: 'vencida', saldo_cop: 29750, lineas_n: 2 });
  });
});

describe('anulación (B5)', () => {
  it('solo Gerencia General', async () => {
    await expect(anularLinea('l1', 'Error de canon', ADMIN)).rejects.toMatchObject({ statusCode: 403 });
    expect(ops).toHaveLength(0);
  });

  it('una línea facturada queda para nota crédito y se avisa', async () => {
    enqueue(L, ok(linea()), ok({ id: 'l1', estado: 'anulada', requiere_nota_credito: true }));
    enqueue('facturas', ok({ factus_number: 'FE12' }));
    await anularLinea('l1', 'Error de canon', GERENCIA);
    expect(de(L, 'update')[0].args[0]).toMatchObject({ estado: 'anulada', anulada_motivo: 'Error de canon', requiere_nota_credito: true });
    expect(efectos.admins).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'factura.nota_credito', mensaje: expect.stringContaining('FE12') }));
  });

  it('una línea pagada no se anula (el barrido la volvería a cobrar): 409 sin tocar nada', async () => {
    enqueue(L, ok(linea({ estado: 'pagada' })));
    await expect(anularLinea('l1', 'Error de canon', GERENCIA)).rejects.toMatchObject({ statusCode: 409, errorCode: 'LINEA_PAGADA' });
    expect(de(L, 'update')).toHaveLength(0);
  });

  it('Trasladada (sin factura) no pide nota crédito; dos anulaciones a la vez: 409', async () => {
    enqueue(L, ok(linea({ facturable: false, modalidad: 'trasladada' })), ok(null));
    await expect(anularLinea('l1', 'Duplicada', GERENCIA)).rejects.toMatchObject({ statusCode: 409 });
    expect(de(L, 'update')[0].args[0]).toMatchObject({ requiere_nota_credito: false });
    expect(de(L, 'in')).toContainEqual({ table: L, method: 'in', args: ['estado', ['pendiente', 'no_recaudada']] });
  });
});

describe('terminación tardía (A5)', () => {
  it('anula las líneas posteriores al mes de terminación, avisa la nota crédito y el saldo a favor', async () => {
    enqueue('contratos', ok({ id: 'c1', numero: 'CTO-1', estado: 'finalizado', fecha_terminacion: '2026-12-20T15:00:00Z', fecha_terminacion_efectiva: '2026-11-15', migracion_filas: [] }));
    enqueue(L, ok([
      linea({ id: 'l12', periodo: '2026-12-01' }),
      linea({ id: 'l01', periodo: '2027-01-01', cuenta: { id: 'k2', estado: 'borrador', factura_id: null } }),
      linea({ id: 'lp', periodo: '2027-01-01', estado: 'pagada' }),
    ]), ok([{ id: 'l12' }]), ok([{ id: 'l01' }]));
    enqueue('facturas', ok({ factus_number: 'FE7' }));
    await expect(revisarLineasPorTerminacion('c1', null)).resolves.toBe(2);
    // corte = noviembre: la efectiva prevalece sobre fecha_terminacion
    expect(de(L, 'gt')).toContainEqual({ table: L, method: 'gt', args: ['periodo', '2026-11-01'] });
    const upd = de(L, 'update').map((o) => o.args[0] as Record<string, unknown>);
    expect(upd).toHaveLength(2);
    expect(upd[0]).toMatchObject({ estado: 'anulada', requiere_nota_credito: true });
    expect(upd[1]).toMatchObject({ requiere_nota_credito: false }); // borrador: sin factura
    expect(efectos.admins).toHaveBeenCalledTimes(1);
    expect(efectos.admins).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'factura.nota_credito', mensaje: expect.stringContaining('2026-12') }));
    expect(efectos.gerencia).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'tarifa.saldo_a_favor' }));
  });

  it('una línea de una cuenta que se está emitiendo no se toca: se le avisa a Gerencia para anularla a mano', async () => {
    enqueue('contratos', ok({ id: 'c1', numero: 'CTO-1', estado: 'finalizado', fecha_terminacion: null, fecha_terminacion_efectiva: '2026-11-15', migracion_filas: [] }));
    enqueue(L, ok([
      linea({ id: 'l12', periodo: '2026-12-01', cuenta: { id: 'k1', estado: 'emitiendo', factura_id: null } }),
      linea({ id: 'l01', periodo: '2027-01-01', cuenta: { id: 'k2', estado: 'borrador', factura_id: null } }),
    ]), { data: null, error: { code: 'P0T01', message: 'congelada' } });
    await expect(revisarLineasPorTerminacion('c1', null)).resolves.toBe(0);
    expect(de(L, 'update')).toHaveLength(1); // solo la de borrador, que pasó a emitiendo entre la lectura y la escritura
    expect(efectos.gerencia).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: 'tarifa.terminacion_durante_emision', payload: { contrato_id: 'c1', periodos: ['2026-12', '2027-01'] } }),
    );
  });

  it('migrado excluido: corta en el mes de la exclusión aunque siga sin terminación', async () => {
    enqueue('contratos', ok({ id: 'm1', numero: 'MIG-1', estado: 'vigente', fecha_terminacion: null, fecha_terminacion_efectiva: null, migracion_filas: [{ excluido_en: '2027-02-10T15:00:00Z' }] }));
    enqueue(L, ok([]));
    await expect(revisarLineasPorTerminacion('m1', 'a1')).resolves.toBe(0);
    expect(de(L, 'gt')[0].args).toEqual(['periodo', '2027-02-01']);
  });

  it('vigente sin terminación ni exclusión: no toca nada', async () => {
    enqueue('contratos', ok({ id: 'c1', estado: 'vigente', fecha_terminacion: null, fecha_terminacion_efectiva: null, migracion_filas: [] }));
    await expect(revisarLineasPorTerminacion('c1', null)).resolves.toBe(0);
    expect(de(L, 'select')).toHaveLength(0);
  });
});

describe('recordatorios (B6)', () => {
  // Martes 2026-12-22, 10:00 en Bogotá.
  const MARTES = new Date('2026-12-22T15:00:00Z');

  it('a +7 días: avisa a los titulares una vez (transición condicionada); sin saldo, nada', async () => {
    enqueue(K, ok([
      { id: 'k1', inmobiliaria_id: 'orgA', periodo: '2026-12-01', vence_en: '2026-12-10', recordatorio_n: 1, inmobiliarias: { nombre: 'A' }, lineas: [{ estado: 'pendiente', total_cop: 29750 }] },
      { id: 'k2', inmobiliaria_id: 'orgB', periodo: '2026-12-01', vence_en: '2026-12-10', recordatorio_n: 0, inmobiliarias: { nombre: 'B' }, lineas: [{ estado: 'pagada', total_cop: 29750 }] },
    ]), ok([{ id: 'k1' }]));
    await expect(recordarAtrasos(MARTES)).resolves.toEqual({ enviados: 1 });
    expect(de(K, 'update')[0].args[0]).toMatchObject({ recordatorio_n: 2 });
    expect(de(K, 'eq')).toContainEqual({ table: K, method: 'eq', args: ['recordatorio_n', 1] });
    expect(efectos.titulares).toHaveBeenCalledWith('orgA', expect.objectContaining({ tipo: 'tarifa.recordatorio_pago', mensaje: expect.stringContaining('$29.750') }));
    expect(efectos.admins).not.toHaveBeenCalled();
  });

  it('a +15 también a los administradores', async () => {
    enqueue(K, ok([
      { id: 'k1', inmobiliaria_id: 'orgA', periodo: '2026-12-01', vence_en: '2026-12-01', recordatorio_n: 2, inmobiliarias: { nombre: 'A' }, lineas: [{ estado: 'pendiente', total_cop: 100 }] },
    ]), ok([{ id: 'k1' }]));
    await recordarAtrasos(MARTES);
    expect(efectos.admins).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'tarifa.atraso' }));
  });

  it('fuera de la franja de cobranza (domingo) no lee nada', async () => {
    await expect(recordarAtrasos(new Date('2026-12-20T15:00:00Z'))).resolves.toEqual({ enviados: 0 });
    expect(ops).toHaveLength(0);
  });
});

describe('condiciones de cobro (B9)', () => {
  // 15/02/2027 en Bogotá: febrero ya está cortado; el primer mes sin cortar es marzo.
  beforeEach(() => vi.useFakeTimers({ now: new Date('2027-02-15T15:00:00Z'), toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('el % solo lo registra Gerencia General', async () => {
    await expect(registrarCondicion('c1', { fecha: '2027-03-01', tarifa_pct: 2 }, TITULAR)).rejects.toMatchObject({ statusCode: 403 });
    expect(ops).toHaveLength(0);
  });

  it('canon a mitad de mes: rige desde el día 1 del siguiente; pasa por tenantScope y no pisa el %', async () => {
    enqueue('contratos', ok({ id: 'c1', expediente_id: 'e1' }));
    enqueue('contrato_condiciones_cobro', ok({ id: 'x' }));
    await registrarCondicion('c1', { fecha: '2027-03-15', canon_cop: 1_051_000 }, TITULAR);
    expect(efectos.assertExpediente).toHaveBeenCalledWith('e1', 't1', 'inmobiliaria');
    const fila = de('contrato_condiciones_cobro', 'upsert')[0].args[0] as Record<string, unknown>;
    expect(fila).toEqual({ contrato_id: 'c1', desde: '2027-04-01', registrado_por: 't1', canon_cop: 1_051_000 });
  });

  it('D9: la inmobiliaria no registra un canon sobre un mes ya cortado (400, sin escribir)', async () => {
    enqueue('contratos', ok({ id: 'c1', expediente_id: 'e1' }));
    await expect(registrarCondicion('c1', { fecha: '2027-02-01', canon_cop: 1 }, TITULAR)).rejects.toMatchObject({ statusCode: 400, errorCode: 'CONDICION_RETROACTIVA' });
    enqueue('contratos', ok({ id: 'c1', expediente_id: 'e1' }));
    await expect(registrarCondicion('c1', { fecha: '2020-01-01', canon_cop: 1 }, TITULAR)).rejects.toMatchObject({ statusCode: 400 });
    expect(de('contrato_condiciones_cobro', 'upsert')).toHaveLength(0);
  });

  it('D9: desde el primer mes sin cortar sí; Cofianza puede corregir hacia atrás', async () => {
    enqueue('contratos', ok({ id: 'c1', expediente_id: 'e1' }));
    enqueue('contrato_condiciones_cobro', ok({ id: 'x' }));
    await registrarCondicion('c1', { fecha: '2027-03-01', canon_cop: 1_051_000 }, TITULAR);
    enqueue('contratos', ok({ id: 'c1', expediente_id: 'e1' }));
    enqueue('contrato_condiciones_cobro', ok({ id: 'y' }));
    await registrarCondicion('c1', { fecha: '2026-12-01', canon_cop: 990_000 }, ADMIN);
    expect(de('contrato_condiciones_cobro', 'upsert').map((o) => (o.args[0] as { desde: string }).desde)).toEqual(['2027-03-01', '2026-12-01']);
  });
});

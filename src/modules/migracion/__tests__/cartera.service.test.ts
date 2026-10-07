import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Migración — exclusión de cobertura (§7.2.1-§7.2.2): CAS sobre la fila,
// reversión si el contrato no se cancela, suspensión solo por declaración falsa.
// Mock de Supabase con colas por tabla (patrón de acta-firma.test.ts).
// ============================================================

const { ops, enqueue, queues, chainFor, efectos } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'is', 'not', 'in', 'neq', 'order', 'limit', 'range'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH)
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    chainFor,
    efectos: {
      cancelar: vi.fn(async () => true),
      suspender: vi.fn(async () => true),
      notificarYCorreo: vi.fn(async () => undefined),
      gerencia: vi.fn(async () => ['gg1']),
      logAudit: vi.fn(),
      cancelarMoras: vi.fn(async () => ({ canceladas: 0, pagadasPorCofianza: [] as { ticket_numero: string; monto: number | null }[] })),
    },
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => chainFor(t), storage: { from: vi.fn() } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: efectos.logAudit,
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({})) }));
vi.mock('@/modules/contratos/contrato-workflow.service', () => ({ cancelarContratoMigradoPorSistema: efectos.cancelar }));
vi.mock('@/modules/beneficios/beneficios.service', () => ({ gerenciaGeneralIds: efectos.gerencia }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: efectos.notificarYCorreo }));
vi.mock('@/modules/moras/moras.service', () => ({ cancelarMorasSinCobertura: efectos.cancelarMoras }));
vi.mock('../habilitacion.service', () => ({ BUCKET: 'b', suspenderMigraciones: efectos.suspender }));

import { excluirContrato } from '../cartera.service';

const FILA = {
  id: 'f1',
  lote_id: 'l1',
  inmobiliaria_id: 'org1',
  n_fila: 3,
  datos: { direccion: 'Cra 1 # 2-3', canon: 1_000_000, arrendatario: { nombre: 'Ana', apellido: 'Paz' } },
  resultado: 'aceptada',
  motivos: [],
  advertencias: [],
  reportable: true,
  reportable_motivo: null,
  tarifa_acta_pct: 2,
  tarifa_pct: 2,
  tarifa_desde: '2026-10-16',
  verificacion_individual_en: null,
  en_revision: false,
  en_revision_motivo: null,
  excluido_en: null,
  excluido_motivo: null,
  contrato: { id: 'c1', numero: 'CTO-2026-001', estado: 'vigente', valor_arriendo: 1_000_000, fecha_firma: '2026-10-16T15:00:00Z', fecha_terminacion: null },
  lote: { id: 'l1', numero: 'MIG-2026-001', estado: 'activo' },
};

const updatesFila = () => ops.filter((o) => o.table === 'migracion_filas' && o.method === 'update').map((o) => o.args[0]);

beforeEach(() => {
  ops.length = 0;
  queues.clear();
  vi.clearAllMocks();
  efectos.cancelar.mockResolvedValue(true);
  efectos.suspender.mockResolvedValue(true);
  efectos.cancelarMoras.mockResolvedValue({ canceladas: 0, pagadasPorCofianza: [] });
});

describe('excluirContrato', () => {
  it('declaración falsa: cancela el contrato, suspende la inmobiliaria y avisa a Gerencia y titulares', async () => {
    enqueue('migracion_filas', { data: FILA, error: null }, { data: [{ id: 'f1' }], error: null }, { data: { ...FILA, excluido_en: 'x', excluido_motivo: 'declaracion_falsa', contrato: { ...FILA.contrato, estado: 'cancelado' } }, error: null });
    enqueue('inmobiliaria_miembros', { data: [{ perfil_id: 'p1' }], error: null });
    enqueue('migracion_auditorias', { data: [], error: null });

    const r = await excluirContrato('f1', 'declaracion_falsa', null, 'u1');

    expect(efectos.cancelar).toHaveBeenCalledWith('c1', 'Declaración falsa de comportamiento de pago', 'u1');
    expect(efectos.suspender).toHaveBeenCalledWith('org1', expect.stringContaining('CTO-2026-001'));
    expect(efectos.notificarYCorreo).toHaveBeenCalledWith(expect.objectContaining({ userId: 'gg1', tipo: 'migracion.suspendida' }));
    expect(efectos.notificarYCorreo).toHaveBeenCalledWith(expect.objectContaining({ userId: 'p1', tipo: 'migracion.contrato_excluido' }));
    expect(r.inmobiliaria_suspendida).toBe(true);
    expect(r.estado).toBe('excluido');
  });

  it('auditoría no entregada: excluye sin suspender la inmobiliaria', async () => {
    enqueue('migracion_filas', { data: FILA, error: null }, { data: [{ id: 'f1' }], error: null }, { data: FILA, error: null });
    await excluirContrato('f1', 'auditoria_no_entregada', null, 'u1');
    expect(efectos.cancelar).toHaveBeenCalled();
    expect(efectos.suspender).not.toHaveBeenCalled();
  });

  it('si el contrato ya no estaba vigente al cancelar, revierte la fila y responde 409', async () => {
    efectos.cancelar.mockResolvedValue(false);
    enqueue('migracion_filas', { data: FILA, error: null }, { data: [{ id: 'f1' }], error: null });
    await expect(excluirContrato('f1', 'declaracion_falsa', null, 'u1')).rejects.toMatchObject({ errorCode: 'CONTRATO_ESTADO_CAMBIADO' });
    expect(updatesFila()).toEqual([
      expect.objectContaining({ excluido_motivo: 'declaracion_falsa' }),
      { excluido_en: null, excluido_motivo: null },
    ]);
    expect(efectos.suspender).not.toHaveBeenCalled();
  });

  it('dos clics: el CAS que no toca filas responde 409 y no cancela', async () => {
    enqueue('migracion_filas', { data: FILA, error: null }, { data: [], error: null });
    await expect(excluirContrato('f1', 'declaracion_falsa', null, 'u1')).rejects.toMatchObject({ errorCode: 'MIGRACION_YA_EXCLUIDA' });
    expect(efectos.cancelar).not.toHaveBeenCalled();
  });

  it('cancela las moras activas y avisa a Gerencia lo que Cofianza ya pagó (§7.2.3)', async () => {
    efectos.cancelarMoras.mockResolvedValue({ canceladas: 1, pagadasPorCofianza: [{ ticket_numero: 'MOR-2026-007', monto: 1_000_000 }] });
    enqueue('migracion_filas', { data: FILA, error: null }, { data: [{ id: 'f1' }], error: null }, { data: FILA, error: null });
    await excluirContrato('f1', 'auditoria_no_entregada', null, 'u1');
    expect(efectos.cancelarMoras).toHaveBeenCalledWith('c1', expect.stringContaining('Sin cobertura'), 'u1');
    expect(efectos.notificarYCorreo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'gg1', tipo: 'migracion.compensacion', mensaje: expect.stringContaining('MOR-2026-007') }),
    );
  });

  it('un contrato migrado ya finalizado se excluye sin cancelarlo (§7.3.1)', async () => {
    const fin = { ...FILA, contrato: { ...FILA.contrato, estado: 'finalizado' } };
    enqueue('migracion_filas', { data: fin, error: null }, { data: [{ id: 'f1' }], error: null }, { data: { ...fin, excluido_en: 'x', excluido_motivo: 'auditoria_no_entregada' }, error: null });
    const r = await excluirContrato('f1', 'auditoria_no_entregada', null, 'u1');
    expect(efectos.cancelar).not.toHaveBeenCalled();
    expect(efectos.cancelarMoras).toHaveBeenCalled();
    expect(r.estado_etiqueta).toBe('Excluido por soportes de auditoría no entregados');
  });

  it('sin fianza activa (lote sin firmar) no excluye', async () => {
    enqueue('migracion_filas', { data: { ...FILA, contrato: null }, error: null });
    await expect(excluirContrato('f1', 'declaracion_falsa', null, 'u1')).rejects.toMatchObject({ errorCode: 'MIGRACION_SIN_FIANZA_ACTIVA' });
    expect(updatesFila()).toEqual([]);
  });
});

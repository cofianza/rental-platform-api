import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dashboardService from '../dashboard.service';

// ── Mock Supabase ───────────────────────────────────────────

const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockNeq = vi.fn();
const mockGte = vi.fn();
const mockLte = vi.fn();
const mockIn = vi.fn();
const mockOrder = vi.fn();
const mockFilter = vi.fn();
const mockLimit = vi.fn();

function createChain(finalData: unknown, finalCount?: number) {
  const chain: Record<string, unknown> = {};
  // order/range: las consultas paginan con fetchAll.
  const methods = { select: mockSelect, eq: mockEq, neq: mockNeq, gte: mockGte, lte: mockLte, in: mockIn, order: mockOrder, filter: mockFilter, limit: mockLimit, range: vi.fn() };

  for (const [name, fn] of Object.entries(methods)) {
    fn.mockImplementation(() => chain);
    chain[name] = fn;
  }

  // Terminal: return data
  chain.then = undefined;

  // Make it thenable for await
  Object.defineProperty(chain, 'then', {
    value: (resolve: (val: unknown) => void) => {
      resolve({ data: finalData, error: null, count: finalCount });
    },
    configurable: true,
  });

  return chain;
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock('@/lib/tenantScope', () => ({
  resolvePortfolioInmuebleIds: vi.fn(async () => ['i1']),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Ingresos de fianza: la vía del estudio de cada contrato, con TARIFA_IVA.
vi.mock('@/modules/estudios/certificado.service', () => ({
  viaDelEstudio: vi.fn(async (e: { expediente_id: string }) => {
    if (e.expediente_id === 'e2') throw new Error('timeout');
    return 'automatica';
  }),
}));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({ TARIFA_IVA: 19 })) }));

import { supabase } from '@/lib/supabase';
const mockFrom = supabase.from as ReturnType<typeof vi.fn>;
const mockRpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

// ── Tests ───────────────────────────────────────────────────

describe('Dashboard Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSummary()', () => {
    // Estudios creados en el periodo y sus decisiones en la línea de tiempo
    // (orden ascendente, como las pide la consulta).
    const eventos = [
      // e1: aprobado a los 2 días y luego cerrado por el contrato (el cierre no
      // es una decisión: no viene en esta consulta).
      { expediente_id: 'e1', estado_nuevo: 'aprobado', created_at: '2026-03-03T00:00:00Z', expedientes: { created_at: '2026-03-01T00:00:00Z' } },
      // e3: rechazado a las 12 horas.
      { expediente_id: 'e3', estado_nuevo: 'rechazado', created_at: '2026-03-02T12:00:00Z', expedientes: { created_at: '2026-03-02T00:00:00Z' } },
      // e2: condicionado a los 4 días y aprobado después (ponderación).
      { expediente_id: 'e2', estado_nuevo: 'condicionado', created_at: '2026-03-05T00:00:00Z', expedientes: { created_at: '2026-03-01T00:00:00Z' } },
      { expediente_id: 'e2', estado_nuevo: 'aprobado', created_at: '2026-03-06T00:00:00Z', expedientes: { created_at: '2026-03-01T00:00:00Z' } },
    ];

    function mockTablas() {
      let expCall = 0;
      mockFrom.mockImplementation((table: string) => {
        if (table === 'expedientes') {
          expCall++;
          // 1ª: conteo de activos; 2ª: conteo por estado del periodo.
          return expCall === 1
            ? createChain(null, 5)
            : createChain([{ estado: 'cerrado' }, { estado: 'condicionado' }, { estado: 'rechazado' }]);
        }
        if (table === 'eventos_timeline') return createChain(eventos);
        if (table === 'pagos') return createChain([{ monto: 500000 }, { monto: 1000000 }]);
        return createChain([]);
      });
    }

    it('tasa y tiempo salen de la primera y la última decisión, no del estado ni de updated_at', async () => {
      mockTablas();

      const result = await dashboardService.getSummary('2026-03-01', '2026-03-31');

      // Decisión vigente: aprobado, aprobado, rechazado → 2 de 3. El aprobado
      // que terminó 'cerrado' cuenta como aprobado.
      expect(result.tasaAprobacion).toBe(66.67);
      // Primera decisión: 2 días, 4 días y 0,5 días → 2,17.
      expect(result.tiempoPromedioResolucionDias).toBe(2.17);
      expect(result.totalExpedientesActivos).toBe(5);
      expect(result.expedientesPorEstado).toEqual({ cerrado: 1, condicionado: 1, rechazado: 1 });
      expect(result.ingresosDelPeriodo).toBe(1500000);
      expect(mockFrom).toHaveBeenCalledWith('eventos_timeline');
      expect(mockEq).toHaveBeenCalledWith('tipo', 'estado');
    });

    it('"Estudios activos" no cuenta rechazados ni cerrados', async () => {
      mockTablas();

      await dashboardService.getSummary('2026-03-01', '2026-03-31');

      const filtroEstado = mockIn.mock.calls.find(([col]) => col === 'estado');
      expect(filtroEstado?.[1]).toEqual(['borrador', 'en_revision', 'informacion_incompleta', 'condicionado', 'aprobado']);
      expect(mockNeq).not.toHaveBeenCalledWith('estado', 'cerrado');
    });

    it('un condicionado que sigue sin decidir va aparte: no baja la tasa (P26)', async () => {
      mockTablas();
      eventos.push({ expediente_id: 'e4', estado_nuevo: 'condicionado', created_at: '2026-03-07T00:00:00Z', expedientes: { created_at: '2026-03-06T00:00:00Z' } });

      try {
        const result = await dashboardService.getSummary('2026-03-01', '2026-03-31');
        // Aprobado, aprobado, rechazado: 2 de 3 decididos. e4 no cuenta.
        expect(result.tasaAprobacion).toBe(66.67);
      } finally {
        eventos.pop();
      }
    });

    it('sin decisiones en el periodo: tasa y tiempo en 0', async () => {
      mockFrom.mockImplementation((table: string) =>
        table === 'expedientes' ? createChain(null, 0) : createChain([]),
      );

      const result = await dashboardService.getSummary('2026-03-01', '2026-03-31');

      expect(result.tasaAprobacion).toBe(0);
      expect(result.tiempoPromedioResolucionDias).toBe(0);
    });
  });

  describe('getExpedientesPorEstado()', () => {
    it('deberia retornar conteo agrupado por estado', async () => {
      mockFrom.mockImplementation(() => {
        return createChain([
          { estado: 'borrador' },
          { estado: 'borrador' },
          { estado: 'en_revision' },
          { estado: 'aprobado' },
        ]);
      });

      const result = await dashboardService.getExpedientesPorEstado('2026-01-01', '2026-12-31');

      expect(result).toBeInstanceOf(Array);
      const borrador = result.find((r) => r.estado === 'borrador');
      expect(borrador?.count).toBe(2);
      const aprobado = result.find((r) => r.estado === 'aprobado');
      expect(aprobado?.count).toBe(1);
    });

    it('deberia usar mes en curso si no se envian fechas', async () => {
      mockFrom.mockImplementation(() => createChain([]));

      const result = await dashboardService.getExpedientesPorEstado();

      expect(result).toBeInstanceOf(Array);
      expect(mockFrom).toHaveBeenCalledWith('expedientes');
    });

    it('deberia retornar array vacio si no hay datos', async () => {
      mockFrom.mockImplementation(() => createChain([]));

      const result = await dashboardService.getExpedientesPorEstado('2026-01-01', '2026-01-02');

      expect(result).toEqual([]);
    });
  });

  describe('getMiCarteraAnalitica()', () => {
    it('"Desempeño de tus estudios" cuenta solo la evaluación del titular', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'expedientes') return createChain([{ id: 'e1' }]);
        if (table === 'estudios') {
          return createChain([
            { resultado: 'aprobado', score: 800, created_at: new Date().toISOString(), fecha_completado: null },
          ]);
        }
        return createChain([]);
      });

      const r = await dashboardService.getMiCarteraAnalitica('p1');

      expect(mockNeq).toHaveBeenCalledWith('tipo', 'con_coarrendatario');
      expect(r.estudios).toMatchObject({ total: 1, scorePromedio: 800 });
    });

    it('P26: «de N en total» cuenta estudios, como los aprobados (la evaluación repetida cuenta una vez)', async () => {
      const hoy = new Date().toISOString();
      mockFrom.mockImplementation((table: string) => {
        if (table === 'expedientes') return createChain([{ id: 'e1' }]);
        if (table === 'estudios') {
          return createChain([
            { expediente_id: 'e1', resultado: null, score: null, created_at: hoy, fecha_completado: null },
            { expediente_id: 'e1', resultado: 'aprobado', score: 800, created_at: hoy, fecha_completado: hoy },
            { expediente_id: 'e2', resultado: 'rechazado', score: 400, created_at: hoy, fecha_completado: hoy },
          ]);
        }
        return createChain([]);
      });

      const r = await dashboardService.getMiCarteraAnalitica('p1');

      expect(r.estudios.total).toBe(2);
    });

    it('P26: la tasa usa la decisión efectiva, como el informe y el dashboard', async () => {
      const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();
      const ev = (id: string, estado_nuevo: string, dias: number, estado: string) => ({
        expediente_id: id, estado_nuevo, metadata: null, created_at: hace(dias), expedientes: { created_at: hace(40), estado },
      });
      mockFrom.mockImplementation((table: string) =>
        table === 'eventos_timeline'
          ? createChain([
              // e1: condicionado y luego aprobado por el analista → aprobado.
              ev('e1', 'condicionado', 5, 'aprobado'),
              ev('e1', 'aprobado', 3, 'aprobado'),
              // e2: sigue condicionado → en decisión, fuera de la tasa.
              ev('e2', 'condicionado', 2, 'condicionado'),
              ev('e3', 'rechazado', 1, 'rechazado'),
              // e4: aprobado hace 60 días → no entra en los 30, sí en el total.
              ev('e4', 'aprobado', 60, 'cerrado'),
            ])
          : createChain([]),
      );

      const r = await dashboardService.getMiCarteraAnalitica('p1');

      expect(r.estudios.aprobados).toBe(2);
      expect(r.estudios.decisiones30d).toEqual({ aprobados: 1, condicionados: 1, rechazados: 1, total: 2, tasaAprobacion: 50 });
    });

    it('salud de cartera: contratos y moras activas en la misma consulta (sin idas en serie)', async () => {
      const hace10Dias = new Date(Date.now() - 10 * 86_400_000).toISOString();
      mockFrom.mockImplementation((table: string) =>
        table === 'contratos'
          ? createChain([
              { valor_arriendo: 1000000, moras_tickets: [{ reportado_at: hace10Dias }] },
              { valor_arriendo: '3000000', moras_tickets: [] },
            ])
          : createChain([]),
      );

      const r = await dashboardService.getMiCarteraAnalitica('p1');

      expect(mockFrom).not.toHaveBeenCalledWith('expedientes');
      expect(mockFrom).not.toHaveBeenCalledWith('moras_tickets');
      expect(r.salud).toEqual({
        contratosActivos: 2,
        morosidadPct: 50,
        moraActiva: 1,
        diasPromedioMora: 10,
        canonGestionado: 4000000,
      });
    });
  });

  describe('getMisInmuebles()', () => {
    it('arma las tarjetas con 3 consultas en paralelo, sin pasar por expedientes ni moras sueltas', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'inmuebles') {
          return createChain([
            { id: 'i1', codigo: 'APT-1', valor_arriendo: 1500000, estado: 'ocupado', visible_vitrina: false },
            { id: 'i2', codigo: 'APT-2', valor_arriendo: 900000, estado: 'disponible', visible_vitrina: true },
          ]);
        }
        if (table === 'contratos') {
          return createChain([
            {
              id: 'c2', expediente_id: 'e2', estado: 'vigente', fecha_inicio: '2026-06-01', fecha_fin: '2027-06-01',
              expedientes: { inmueble_id: 'i1', solicitantes: { nombre: 'Ana', apellido: 'Pérez' } },
              moras_tickets: [{ estado: 'fase_1' }],
            },
            {
              id: 'c1', expediente_id: 'e1', estado: 'finalizado', fecha_inicio: '2025-01-01', fecha_fin: '2026-01-01',
              expedientes: { inmueble_id: 'i1', solicitantes: { nombre: 'Luis', apellido: 'Gómez' } },
              moras_tickets: [],
            },
          ]);
        }
        return createChain([]);
      });
      mockRpc.mockResolvedValue({ data: [{ inmueble_id: 'i2', estudios_activos: 2, reservado: false }], error: null });

      const r = await dashboardService.getMisInmuebles('p1');

      expect(mockFrom).not.toHaveBeenCalledWith('expedientes');
      expect(mockFrom).not.toHaveBeenCalledWith('moras_tickets');
      expect(mockIn).toHaveBeenCalledWith('expedientes.inmueble_id', ['i1']);
      const i1 = r.inmuebles.find((i) => i.id === 'i1')!;
      expect(i1).toMatchObject({ inquilino: 'Ana Pérez', contratoId: 'c2', expedienteId: 'e2', garantiaActiva: true, pago: 'mora' });
      expect(i1.historial.map((h) => h.inquilino)).toEqual(['Ana Pérez', 'Luis Gómez']);
      expect(r.inmuebles.find((i) => i.id === 'i2')).toMatchObject({ garantiaActiva: false, pago: null, estudiosActivos: 2 });
      expect(r.resumen).toMatchObject({ total: 2, arrendados: 1, disponibles: 1, enVitrina: 1, ingresoMes: 1500000 });
    });
  });

  describe('getAdminOverview()', () => {
    it('«Inmobiliarias activas» cuenta las filas activas de /inmobiliarias', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'perfiles') {
          return createChain([
            { id: 't1', estado: 'activo' }, // titular activo
            { id: 't2', estado: 'inactivo' }, // titulares desactivados desde el panel
            { id: 't3', estado: 'inactivo' },
            { id: 'm1', estado: 'activo' }, // miembro del equipo de t1: no es otra inmobiliaria
            { id: 'l1', estado: 'activo' }, // cuenta sin equipo
          ]);
        }
        // inmobiliarias.estado sigue en 'activa' aunque se desactive el titular.
        if (table === 'inmobiliarias') {
          return createChain(
            [{ id: 'o1', owner_perfil_id: 't1' }, { id: 'o2', owner_perfil_id: 't2' }, { id: 'o3', owner_perfil_id: 't3' }],
            3,
          );
        }
        if (table === 'inmobiliaria_miembros') {
          return createChain([{ perfil_id: 't1' }, { perfil_id: 't2' }, { perfil_id: 't3' }, { perfil_id: 'm1' }]);
        }
        return createChain([]);
      });

      const r = await dashboardService.getAdminOverview();

      expect(r.kpis.inmobiliariasActivas).toBe(2); // t1 y l1
      // Sin dónde registrar el desembolso (P41), el KPI sale como «sin data».
      expect(r.meta.metricasNoDisponibles).toContain('desembolsado');
    });

    it('«Ingresos fianzas»: la tarifa de cada contrato sobre su canon, más IVA (no $20.000 × contratos)', async () => {
      const contrato = (id: string, exp: string) => ({ id, expediente_id: exp, estado: 'vigente', valor_arriendo: '1500000', fecha_inicio: null, fecha_fin: null, expedientes: null });
      mockFrom.mockImplementation((table: string) => {
        if (table === 'contratos') return createChain([contrato('c1', 'e1'), contrato('c2', 'e2')]);
        if (table === 'estudios') {
          // Cada contrato encuentra su estudio completado.
          let exp = '';
          const chain: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'order', 'limit']) {
            chain[m] = (...a: unknown[]) => {
              if (m === 'eq' && a[0] === 'expediente_id') exp = String(a[1]);
              return chain;
            };
          }
          chain.maybeSingle = () => chain;
          chain.then = (resolve: (v: unknown) => void) => resolve({ data: { expediente_id: exp, resultado: 'aprobado' }, error: null });
          return chain;
        }
        return createChain([]);
      });
      // El overview queda 5 min en caché: sin esto devolvería el del test anterior.
      const ahora = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);

      const r = await dashboardService.getAdminOverview();
      ahora.mockRestore();

      // c1: 2,0 % de 1.500.000 = 30.000 + IVA 5.700. c2 no se pudo leer: queda
      // fuera y contado, sin tumbar el Resumen.
      expect(r.kpis.ingresosFianzas).toBe(30_000);
      expect(r.kpis.ivaRecaudado).toBe(5_700);
      expect(r.kpis.contratosSinTarifa).toBe(1);
      expect(r.config).toEqual({ valorAfianzamientoMensual: 30_000, ivaGarantiaPorcentaje: 19 });
    });
  });

  describe('getPortfolioStats()', () => {
    it('inquilinos y canon salen de una sola consulta a contratos con el expediente embebido', async () => {
      mockFrom.mockImplementation((table: string) =>
        table === 'contratos'
          ? createChain([
              { valor_arriendo: 1000000, expedientes: { solicitante_id: 's1' } },
              { valor_arriendo: 2000000, expedientes: { solicitante_id: 's1' } },
              { valor_arriendo: 500000, expedientes: { solicitante_id: 's2' } },
            ])
          : table === 'inmuebles'
            ? createChain([], 1) // activos (sin los dados de baja)
            : createChain([]),
      );

      const r = await dashboardService.getPortfolioStats('p1');

      expect(mockFrom).not.toHaveBeenCalledWith('expedientes');
      expect(r).toEqual({ propiedades_activas: 1, inquilinos_cartera: 2, canon_mensual: 3500000 });
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as secciones from '../dashboard-secciones.service';
import type { ViaAprobacion } from '@/modules/estudios/tarifas';

// ── Mock Supabase ───────────────────────────────────────────
//
// createChain devuelve un objeto "thenable" que imita la cadena del query
// builder de supabase-js (select/eq/in/order/single…) y resuelve { data, error }.
// mockFrom se configura por NOMBRE DE TABLA: cada función testeada consulta
// cada tabla a lo sumo una vez, así que mapear por tabla es suficiente.

interface ChainResult {
  data: unknown;
  error?: unknown;
  count?: number;
}

function createChain(result: ChainResult) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'neq', 'gte', 'lte', 'in', 'order', 'range', 'limit', 'is', 'not', 'or'];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  chain.single = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => void) => resolve({ error: null, ...result });
  return chain;
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn() },
}));

// dashboard.service (conteo de visitas del mes) importa el logger, que valida el env.
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// La tarifa de cada contrato sale de la vía de su estudio y el IVA de TARIFA_IVA.
const { mockViaDelEstudio } = vi.hoisted(() => ({ mockViaDelEstudio: vi.fn() }));
vi.mock('@/modules/estudios/certificado.service', () => ({ viaDelEstudio: mockViaDelEstudio }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({ TARIFA_IVA: 19 })) }));

import { supabase } from '@/lib/supabase';
const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;

/** Configura mockFrom para que devuelva un chain por nombre de tabla. */
function byTable(map: Record<string, ChainResult>) {
  mockFrom.mockImplementation((table: string) => createChain(map[table] ?? { data: [] }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── getIngresosAdmin ────────────────────────────────────────

describe('getIngresosAdmin()', () => {
  const contrato = (id: string, canon: string, extra: Record<string, unknown> = {}) => ({
    id,
    estado: 'vigente',
    valor_arriendo: canon,
    fecha_inicio: '2026-01-01',
    fecha_fin: null,
    expediente_id: `e-${id}`,
    expedientes: {
      inmuebles: { codigo: 'APT', direccion: 'Calle 1', ciudad: 'Medellín' },
      solicitantes: { nombre: 'Ana', apellido: 'Pérez' },
    },
    ...extra,
  });

  // El último estudio completado de cada expediente (null = no tiene) y la vía
  // con la que se aprobó; 'error' = no se pudo leer.
  const vias: Record<string, ViaAprobacion | 'error' | null> = {
    'e-c1': 'automatica',
    'e-c2': 'revision_manual',
    'e-c3': 'automatica', // no se usa: el V3 imprimió 2,5 %
    'e-c5': null,
    'e-c6': 'error',
  };
  const estudios = () => {
    let exp = '';
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) {
      chain[m] = (...a: unknown[]) => {
        if (m === 'eq' && a[0] === 'expediente_id') exp = String(a[1]);
        return chain;
      };
    }
    chain.maybeSingle = () => chain;
    chain.then = (resolve: (v: unknown) => void) =>
      resolve({ data: vias[exp] ? { expediente_id: exp, resultado: 'aprobado', tarifa_override: null } : null, error: null });
    return chain;
  };
  const tabla = (contratos: unknown[]) =>
    mockFrom.mockImplementation((t: string) => (t === 'estudios' ? estudios() : createChain({ data: t === 'contratos' ? contratos : [] })));

  beforeEach(() => {
    mockViaDelEstudio.mockImplementation(async (e: { expediente_id: string }) => {
      if (vias[e.expediente_id] === 'error') throw new Error('timeout');
      return vias[e.expediente_id];
    });
  });

  it('la tarifa real de cada contrato (su % sobre su canon) más IVA 19 %; el resto aparte con su motivo', async () => {
    tabla([
      contrato('c1', '1000000'),
      contrato('c2', '1500000'),
      contrato('c3', '2000000', { tarifa_congelada: 2.5 }),
      contrato('c4', '1000000', { fecha_inicio: '2999-01-01' }),
      contrato('c5', '1000000'),
      contrato('c6', '1000000'),
    ]);

    const r = await secciones.getIngresosAdmin();

    // 2,0 % de 1.000.000; 2,7 % de 1.500.000; 2,5 % congelado de 2.000.000.
    expect(r.porContrato.map(({ contratoId, afianzamiento, iva, total }) => ({ contratoId, afianzamiento, iva, total }))).toEqual([
      { contratoId: 'c1', afianzamiento: 20_000, iva: 3_800, total: 23_800 },
      { contratoId: 'c2', afianzamiento: 40_500, iva: 7_695, total: 48_195 },
      { contratoId: 'c3', afianzamiento: 50_000, iva: 9_500, total: 59_500 },
    ]);
    expect(r.totalAfianzamiento).toBe(110_500);
    expect(r.totalIva).toBe(20_995);
    expect(r.totalBruto).toBe(131_495);
    expect(r.valorAfianzamientoMensual).toBe(36_833); // promedio de los que entran
    expect(r.ivaGarantiaPorcentaje).toBe(19);
    // Empieza después, sin estudio completado (no se asume 2,7 %) y sin dato (no tumba el informe).
    expect(r.excluidos.map(({ contratoId, motivo }) => ({ contratoId, motivo }))).toEqual([
      { contratoId: 'c4', motivo: 'inicia_despues' },
      { contratoId: 'c5', motivo: 'sin_estudio' },
      { contratoId: 'c6', motivo: 'sin_dato' },
    ]);
    expect(mockViaDelEstudio).not.toHaveBeenCalledWith(expect.objectContaining({ expediente_id: 'e-c3' }));
    expect(mockFrom).not.toHaveBeenCalledWith('configuracion_sistema');
  });

  it('sin contratos activos: todo en 0, con el IVA de TARIFA_IVA', async () => {
    tabla([]);

    const r = await secciones.getIngresosAdmin();

    expect(r.valorAfianzamientoMensual).toBe(0);
    expect(r.ivaGarantiaPorcentaje).toBe(19);
    expect(r.totalBruto).toBe(0);
    expect(r.excluidos).toEqual([]);
  });
});

// ── listInquilinos ──────────────────────────────────────────

describe('listInquilinos()', () => {
  const contratoConSolicitante = {
    id: 'c1',
    estado: 'vigente',
    valor_arriendo: '1500000',
    fecha_inicio: null,
    fecha_fin: '2026-09-01',
    expediente_id: 'e1',
    expedientes: {
      id: 'e1',
      inmuebles: { codigo: 'APT-001', direccion: 'Calle 1', ciudad: 'Medellín' },
      solicitantes: {
        nombre: 'María',
        apellido: 'Rodríguez',
        numero_documento: '39169339',
        telefono: '+573001112233',
        email: 'maria@test.com',
        ocupacion: 'Ingeniera',
        actividad_economica: 'Tecnología',
        ingresos_mensuales: '4500000',
        empresa: 'Bancolombia',
        tipo_persona: 'natural',
      },
    },
  };

  it('mapea los campos nuevos del solicitante y marca al_dia sin mora', async () => {
    byTable({
      contratos: { data: [contratoConSolicitante] },
      estudios: { data: [{ expediente_id: 'e1', score: 80, resultado: 'aprobado', created_at: '2026-01-01' }] },
      moras_tickets: { data: [] },
      expediente_coarrendatarios: {
        data: [{ expediente_id: 'e1', nombre: 'Pedro', apellido: 'Gómez', estudios: { estado: 'completado', resultado: 'aprobado' } }],
      },
    });

    const rows = await secciones.listInquilinos();
    expect(rows).toHaveLength(1);
    const r = rows[0];

    expect(r.inquilino).toBe('María Rodríguez');
    expect(r.cedula).toBe('39169339');
    expect(r.inmueble).toBe('APT-001 Calle 1');
    expect(r.municipio).toBe('Medellín');
    expect(r.canon).toBe(1500000);
    expect(r.score).toBe(80);
    expect(r.resultado).toBe('aprobado');
    expect(r.pago).toBe('al_dia');
    expect(r.coarrendatario).toBe('Pedro Gómez');
    // Campos nuevos (Ronda 2)
    expect(r.email).toBe('maria@test.com');
    expect(r.ocupacion).toBe('Ingeniera');
    expect(r.actividadEconomica).toBe('Tecnología');
    expect(r.ingresos).toBe(4500000);
    expect(r.empresa).toBe('Bancolombia');
    expect(r.tipoPersona).toBe('natural');
    expect(r.fechaFin).toBe('2026-09-01');
  });

  it('score y resultado son de la última evaluación terminada del titular, no del coarrendatario', async () => {
    let estudiosChain: Record<string, ReturnType<typeof vi.fn>> | null = null;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'contratos') return createChain({ data: [contratoConSolicitante] });
      if (table === 'estudios') {
        const chain = createChain({ data: [{ expediente_id: 'e1', score: 70, resultado: 'aprobado' }] });
        estudiosChain = chain as unknown as Record<string, ReturnType<typeof vi.fn>>;
        return chain;
      }
      return createChain({ data: [] });
    });

    await secciones.listInquilinos();

    expect(estudiosChain!.neq).toHaveBeenCalledWith('tipo', 'con_coarrendatario');
    expect(estudiosChain!.neq).toHaveBeenCalledWith('resultado', 'pendiente');
  });

  it('P2: un coarrendatario con la evaluación rechazada no figura (no está en el contrato)', async () => {
    byTable({
      contratos: { data: [contratoConSolicitante] },
      estudios: { data: [] },
      moras_tickets: { data: [] },
      expediente_coarrendatarios: {
        data: [{ expediente_id: 'e1', nombre: 'Pedro', apellido: 'Gómez', estudios: { estado: 'completado', resultado: 'rechazado' } }],
      },
    });

    expect((await secciones.listInquilinos())[0].coarrendatario).toBeNull();
  });

  it('marca pago=mora cuando el contrato tiene mora activa', async () => {
    byTable({
      contratos: { data: [contratoConSolicitante] },
      estudios: { data: [] },
      moras_tickets: { data: [{ contrato_id: 'c1', estado: 'fase_2' }] },
      expediente_coarrendatarios: { data: [] },
    });

    const rows = await secciones.listInquilinos();
    expect(rows[0].pago).toBe('mora');
    expect(rows[0].score).toBeNull();
    expect(rows[0].coarrendatario).toBeNull();
  });
});

// ── getPerfilDetalle ────────────────────────────────────────

describe('getPerfilDetalle()', () => {
  const perfilPropietario = {
    id: 'p1',
    rol: 'propietario',
    nombre: 'Carlos',
    apellido: 'Ramírez',
    razon_social: null,
    nit: null,
    numero_documento: '79123456',
    telefono: '+573015556677',
    ciudad: 'Bogotá D.C.',
    direccion: 'Cra 7 # 1-2',
    direccion_comercial: null,
    estado: 'activo',
    created_at: '2026-01-10',
    nombre_representante: null,
    representante_legal: null,
    matricula_arrendador: 'MA-998',
    whatsapp_recaudo: '+573015556677',
    email_recaudo: 'recaudo@carlos.com',
    cuenta_recaudo_banco: 'Bancolombia',
    cuenta_recaudo_tipo: 'ahorros',
    cuenta_recaudo_numero: '12345678',
    cuenta_recaudo_titular_nombre: 'Carlos Ramírez',
    cuenta_recaudo_titular_nit: '79123456',
  };

  it('arma resumen, recaudo y cartera de contratos del aliado', async () => {
    byTable({
      perfiles: { data: perfilPropietario },
      inmuebles: {
        data: [{ id: 'i1', codigo: 'APT-001', direccion: 'Calle 1', ciudad: 'Bogotá', estado: 'ocupado', created_at: '2026-01-01' }],
      },
      expedientes: { data: [{ id: 'e1', inmueble_id: 'i1' }] },
      contratos: {
        data: [
          {
            id: 'c1',
            estado: 'vigente',
            valor_arriendo: '1500000',
            fecha_inicio: null,
            fecha_fin: '2026-09-01',
            expediente_id: 'e1',
            expedientes: {
              inmuebles: { codigo: 'APT-001', direccion: 'Calle 1' },
              solicitantes: { nombre: 'María', apellido: 'Rodríguez' },
            },
          },
        ],
      },
      moras_tickets: { data: [] },
    });

    const d = await secciones.getPerfilDetalle('p1');

    // Identidad (razon_social null → nombre + apellido; direccion_comercial null → direccion)
    expect(d.nombre).toBe('Carlos Ramírez');
    expect(d.documento).toBe('79123456');
    expect(d.ciudad).toBe('Bogotá D.C.');
    expect(d.direccion).toBe('Cra 7 # 1-2');
    expect(d.matriculaArrendador).toBe('MA-998');
    // Recaudo
    expect(d.recaudo.banco).toBe('Bancolombia');
    expect(d.recaudo.email).toBe('recaudo@carlos.com');
    expect(d.recaudo.numeroCuenta).toBe('12345678');
    // Resumen
    expect(d.resumen.inmuebles).toBe(1);
    expect(d.resumen.contratosActivos).toBe(1);
    expect(d.resumen.canonActivo).toBe(1500000);
    expect(d.resumen.moraActiva).toBe(0);
    // Cartera
    expect(d.contratos).toHaveLength(1);
    expect(d.contratos[0].inmueble).toBe('APT-001 Calle 1');
    expect(d.contratos[0].inquilino).toBe('María Rodríguez');
    expect(d.contratos[0].pago).toBe('al_dia');
    expect(d.inmuebles[0].codigo).toBe('APT-001');
  });

  it('titular de una inmobiliaria: la cartera es la de su organización', async () => {
    let inmueblesChain: Record<string, ReturnType<typeof vi.fn>> | null = null;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'inmobiliaria_miembros') {
        return createChain({
          data: [{ inmobiliaria_id: 'o1', rol_miembro: 'owner', inmobiliarias: { miembros_ven_todo: true } }],
        });
      }
      if (table === 'perfiles') return createChain({ data: { ...perfilPropietario, id: 't1', rol: 'inmobiliaria' } });
      if (table === 'inmuebles') {
        const chain = createChain({ data: [] });
        inmueblesChain = chain as unknown as Record<string, ReturnType<typeof vi.fn>>;
        return chain;
      }
      return createChain({ data: [] });
    });

    await secciones.getPerfilDetalle('t1');

    expect(inmueblesChain!.or).toHaveBeenCalledWith('inmobiliaria_id.eq.o1,propietario_id.eq.t1');
  });

  it('lanza error 404 cuando el perfil no existe', async () => {
    byTable({ perfiles: { data: null }, inmuebles: { data: [] } });
    await expect(secciones.getPerfilDetalle('no-existe')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── getVitrinaAdmin ─────────────────────────────────────────

describe('getVitrinaAdmin()', () => {
  it('visitas del mes = conteo exacto del mes; por inmueble cuenta vistas e interesados embebidos', async () => {
    let expedientesChain: Record<string, ReturnType<typeof vi.fn>> | null = null;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'inmuebles') {
        return createChain({
          data: [
            {
              id: 'i1', codigo: 'APT-1', direccion: 'Calle 1', estado: 'disponible', created_at: '2026-09-01',
              vitrina_interacciones: [{ tipo: 'vista' }, { tipo: 'vista' }],
              inmueble_interesados: [{ id: 'l1' }],
            },
            { id: 'i2', codigo: 'APT-2', estado: 'disponible', created_at: '2026-09-02', vitrina_interacciones: [], inmueble_interesados: [] },
          ],
        });
      }
      if (table === 'vitrina_interacciones') return createChain({ data: null, count: 1500 });
      if (table === 'expedientes') {
        const chain = createChain({ data: [] });
        expedientesChain = chain as unknown as Record<string, ReturnType<typeof vi.fn>>;
        return chain;
      }
      return createChain({ data: [] });
    });

    const r = await secciones.getVitrinaAdmin();

    expect(r.visitasMes).toBe(1500); // sin el tope de 1000 filas
    expect(r.publicados[0]).toMatchObject({ visitas: 2, contactos: 1 });
    expect(r.publicados[1]).toMatchObject({ visitas: 0, contactos: 0 });
    // Prospectos: el mismo criterio que el Resumen (sin cerrados).
    expect(expedientesChain!.neq).toHaveBeenCalledWith('estado', 'cerrado');
  });
});

// ── listInmobiliarias / listPropietarios ────────────────────

describe('listInmobiliarias() / listPropietarios()', () => {
  it('inmobiliaria: usa razon_social como nombre y cargoContacto es null (columna inexistente)', async () => {
    byTable({
      perfiles: {
        data: [
          {
            id: 'p1',
            razon_social: 'Inmobiliaria del Valle S.A.S',
            nombre: 'Inmobiliaria',
            apellido: 'Valle',
            nit: '901234567-8',
            nombre_representante: 'Juan Pablo',
            telefono: '+573154445678',
            ciudad: 'Cali',
            estado: 'activo',
            created_at: '2026-05-11',
          },
        ],
      },
      inmuebles: { data: [] }, // sin portafolio → agregados en 0
    });

    const rows = await secciones.listInmobiliarias();
    expect(rows[0].nombre).toBe('Inmobiliaria del Valle S.A.S');
    expect(rows[0].nit).toBe('901234567-8');
    expect(rows[0].contacto).toBe('Juan Pablo');
    expect(rows[0].cargoContacto).toBeNull();
    expect(rows[0].ciudad).toBe('Cali');
    expect(rows[0].contratosActivos).toBe(0);
  });

  it('inmobiliaria: una fila por organización (el titular) con la cartera de todo el equipo', async () => {
    const contrato = (canon: string, propietario: string, org: string | null, moras: number) => ({
      valor_arriendo: canon,
      expedientes: { inmuebles: { propietario_id: propietario, inmobiliaria_id: org } },
      moras_tickets: Array.from({ length: moras }, () => ({ estado: 'fase_2' })),
    });
    byTable({
      perfiles: {
        data: [
          { id: 't1', razon_social: 'Inmo Uno SAS', estado: 'activo', created_at: '2026-01-01' },
          { id: 'm1', nombre: 'Empleado', apellido: 'Uno', estado: 'activo', created_at: '2026-02-01' },
          { id: 'l1', razon_social: 'Suelta SAS', estado: 'activo', created_at: '2026-03-01' },
        ],
      },
      inmobiliarias: { data: [{ id: 'o1', owner_perfil_id: 't1' }] },
      inmobiliaria_miembros: { data: [{ perfil_id: 't1' }, { perfil_id: 'm1' }] },
      contratos: {
        data: [
          contrato('1000000', 'm1', 'o1', 1), // lo cargó el empleado: es de la organización
          contrato('2000000', 't1', 'o1', 0),
          contrato('500000', 'l1', null, 0), // cuenta sin equipo (legado)
        ],
      },
    });

    const rows = await secciones.listInmobiliarias();

    expect(rows.map((r) => r.id)).toEqual(['t1', 'l1']); // el empleado no es un aliado
    expect(rows[0]).toMatchObject({ contratosActivos: 2, canonTotal: 3000000, moraActivaCount: 1 });
    expect(rows[1]).toMatchObject({ contratosActivos: 1, canonTotal: 500000, moraActivaCount: 0 });
  });

  it('propietario: incluye ciudad (Ronda 2) y cédula', async () => {
    byTable({
      perfiles: {
        data: [
          {
            id: 'p2',
            nombre: 'Carlos',
            apellido: 'Ramírez',
            numero_documento: '79123456',
            telefono: '+573015556677',
            ciudad: 'Bogotá D.C.',
            estado: 'activo',
            created_at: '2026-01-10',
          },
        ],
      },
      inmuebles: { data: [] },
    });

    const rows = await secciones.listPropietarios();
    expect(rows[0].nombre).toBe('Carlos Ramírez');
    expect(rows[0].cedula).toBe('79123456');
    expect(rows[0].ciudad).toBe('Bogotá D.C.');
    expect(rows[0].moraActivaCount).toBe(0);
  });

  it('propietario: contratos, canon y moras en una sola consulta a contratos, por dueño del inmueble', async () => {
    const contrato = (canon: string, propietario: string, moras: number) => ({
      valor_arriendo: canon,
      expedientes: { inmuebles: { propietario_id: propietario, inmobiliaria_id: null } },
      moras_tickets: Array.from({ length: moras }, () => ({ estado: 'fase_1' })),
    });
    byTable({
      perfiles: {
        data: [
          { id: 'p1', nombre: 'Ana', apellido: 'Uno', estado: 'activo', created_at: '2026-01-01' },
          { id: 'p2', nombre: 'Beto', apellido: 'Dos', estado: 'activo', created_at: '2026-01-02' },
        ],
      },
      contratos: {
        data: [contrato('1000000', 'p1', 1), contrato('2000000', 'p1', 0), contrato('500000', 'otro', 2)],
      },
    });

    const rows = await secciones.listPropietarios();
    const p1 = rows.find((r) => r.id === 'p1')!;
    const p2 = rows.find((r) => r.id === 'p2')!;
    expect(p1).toMatchObject({ contratosActivos: 2, canonTotal: 3000000, moraActivaCount: 1 });
    expect(p2).toMatchObject({ contratosActivos: 0, canonTotal: 0, moraActivaCount: 0 });
    // Sin la cadena inmuebles → expedientes → moras con listas de ids en la URL.
    expect(mockFrom).not.toHaveBeenCalledWith('inmuebles');
    expect(mockFrom).not.toHaveBeenCalledWith('expedientes');
    expect(mockFrom).not.toHaveBeenCalledWith('moras_tickets');
  });
});

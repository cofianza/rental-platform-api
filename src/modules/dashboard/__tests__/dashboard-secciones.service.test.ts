import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as secciones from '../dashboard-secciones.service';

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
  const methods = ['select', 'eq', 'neq', 'gte', 'lte', 'in', 'order', 'range', 'limit', 'is', 'not'];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  chain.single = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => void) => resolve({ error: null, ...result });
  return chain;
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn() },
}));

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
  const contrato = (id: string, canon: string) => ({
    id,
    estado: 'vigente',
    valor_arriendo: canon,
    fecha_inicio: null,
    fecha_fin: null,
    expediente_id: `e-${id}`,
    expedientes: {
      inmuebles: { codigo: 'APT', direccion: 'Calle 1', ciudad: 'Medellín' },
      solicitantes: { nombre: 'Ana', apellido: 'Pérez' },
    },
  });

  it('IVA exento (iva_concepto_garantia = 0): afianzamiento plano × contratos, IVA 0', async () => {
    byTable({
      configuracion_sistema: {
        data: [
          { clave: 'valor_afianzamiento_mensual', valor: '20000' },
          { clave: 'iva_concepto_garantia', valor: '0' },
        ],
      },
      contratos: { data: [contrato('c1', '1000000'), contrato('c2', '1500000')] },
    });

    const r = await secciones.getIngresosAdmin();

    expect(r.valorAfianzamientoMensual).toBe(20000);
    expect(r.ivaGarantiaPorcentaje).toBe(0);
    expect(r.porContrato).toHaveLength(2);
    expect(r.porContrato[0].afianzamiento).toBe(20000);
    expect(r.porContrato[0].iva).toBe(0);
    expect(r.porContrato[0].total).toBe(20000);
    expect(r.totalAfianzamiento).toBe(40000);
    expect(r.totalIva).toBe(0);
    expect(r.totalBruto).toBe(40000);
  });

  it('IVA > 0 (19%): calcula IVA sobre el afianzamiento', async () => {
    byTable({
      configuracion_sistema: {
        data: [
          { clave: 'valor_afianzamiento_mensual', valor: '20000' },
          { clave: 'iva_concepto_garantia', valor: '19' },
        ],
      },
      contratos: { data: [contrato('c1', '1000000')] },
    });

    const r = await secciones.getIngresosAdmin();

    expect(r.ivaGarantiaPorcentaje).toBe(19);
    expect(r.porContrato[0].iva).toBe(3800); // round(20000 * 0.19)
    expect(r.porContrato[0].total).toBe(23800);
    expect(r.totalIva).toBe(3800);
  });

  it('sin config: usa defaults (afianzamiento 20000, IVA 0)', async () => {
    byTable({ configuracion_sistema: { data: [] }, contratos: { data: [] } });

    const r = await secciones.getIngresosAdmin();

    expect(r.valorAfianzamientoMensual).toBe(20000);
    expect(r.ivaGarantiaPorcentaje).toBe(0);
    expect(r.totalBruto).toBe(0);
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
      expediente_coarrendatarios: { data: [{ expediente_id: 'e1', nombre: 'Pedro', apellido: 'Gómez' }] },
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

  it('lanza error 404 cuando el perfil no existe', async () => {
    byTable({ perfiles: { data: null }, inmuebles: { data: [] } });
    await expect(secciones.getPerfilDetalle('no-existe')).rejects.toMatchObject({ statusCode: 404 });
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
});

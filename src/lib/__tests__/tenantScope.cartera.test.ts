/**
 * Cartera en una sola consulta (2026-09-23): el guard por id decide sobre la
 * fila con `expedienteVisible`, y las listas mandan la misma condición a
 * PostgREST. Aquí se compara esa condición con la regla de antes, escrita como
 * conjuntos (inmuebles de la org + propios + asignados → sus expedientes, más
 * los expedientes asignados en modo restringido), en TODAS las combinaciones
 * de rol, membresía y dueño/asignado de la fila. Si alguien cambia una de las
 * dos, este test dice en qué caso se separan.
 * La equivalencia contra la BD real se corrió a mano al hacer el cambio
 * (143 comparaciones, 0 diferencias).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { filas, ops } = vi.hoisted(() => ({
  filas: [] as Array<Record<string, unknown>>,
  ops: [] as Array<{ tabla: string; metodo: string; args: unknown[] }>,
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const chain: Record<string, unknown> = {
        then: (resolve: (v: unknown) => void) => resolve({ data: tabla === 'inmobiliaria_miembros' ? [...filas] : [], error: null }),
      };
      for (const m of ['select', 'eq', 'or', 'order', 'in'])
        chain[m] = (...args: unknown[]) => {
          ops.push({ tabla, metodo: m, args });
          return chain;
        };
      return chain;
    },
  },
}));

import {
  expedienteVisible,
  filtroPortafolio,
  invalidateMembresiasCache,
  resolveAllowedExpedienteIds,
  resolvePortfolioInmuebleIds,
} from '@/lib/tenantScope';

const YO = 'yo';
const ORG = 'org-1';

/** La regla de antes, por conjuntos, para UNA fila. */
function reglaAnterior(
  rol: 'inmobiliaria' | 'propietario',
  membresia: 'ninguna' | 'owner' | 'miembro_ve_todo' | 'miembro_restringido',
  fila: { propietario: string | null; org: string | null; inmAsignado: string | null; expAsignado: string | null; conInmueble: boolean },
): boolean {
  const completa = membresia === 'owner' || membresia === 'miembro_ve_todo';
  let inmuebleVisible: boolean;
  if (rol === 'propietario') inmuebleVisible = fila.propietario === YO;
  else {
    const propio = fila.propietario === YO || fila.inmAsignado === YO;
    inmuebleVisible = completa ? fila.org === ORG || propio : propio;
  }
  const modoRestringido = rol === 'propietario' || !completa;
  return (fila.conInmueble && inmuebleVisible) || (modoRestringido && fila.expAsignado === YO);
}

const cartera = (rol: 'inmobiliaria' | 'propietario', membresia: string) => {
  const completa = membresia === 'owner' || membresia === 'miembro_ve_todo';
  return rol === 'propietario'
    ? { perfilId: YO, orgIds: [], inmueblesAsignados: false, expedientesAsignados: true }
    : { perfilId: YO, orgIds: completa ? [ORG] : [], inmueblesAsignados: true, expedientesAsignados: !completa };
};

describe('cartera: condición por fila = regla anterior por conjuntos', () => {
  const quien = [YO, 'otro', null];
  const casos: Array<[string, string, Record<string, unknown>]> = [];
  for (const rol of ['inmobiliaria', 'propietario'] as const)
    for (const membresia of rol === 'propietario' ? ['ninguna'] : ['ninguna', 'owner', 'miembro_ve_todo', 'miembro_restringido'])
      for (const propietario of quien)
        for (const org of [ORG, 'org-2', null])
          for (const inmAsignado of quien)
            for (const expAsignado of quien)
              for (const conInmueble of [true, false])
                casos.push([rol, membresia, { propietario, org, inmAsignado, expAsignado, conInmueble }]);

  it(`coinciden en las ${casos.length} combinaciones`, () => {
    const distintos = casos.filter(([rol, membresia, f]) => {
      const fila = f as Parameters<typeof reglaAnterior>[2];
      const antes = reglaAnterior(rol as 'inmobiliaria', membresia as 'owner', fila);
      const ahora = expedienteVisible(cartera(rol as 'inmobiliaria', membresia), {
        miembro_responsable_id: fila.expAsignado,
        inmueble: fila.conInmueble
          ? { propietario_id: fila.propietario, inmobiliaria_id: fila.org, miembro_responsable_id: fila.inmAsignado }
          : null,
      });
      return antes !== ahora;
    });
    expect(distintos).toEqual([]);
  });
});

describe('resolveAllowedExpedienteIds: la condición que va a PostgREST', () => {
  beforeEach(() => {
    invalidateMembresiasCache();
    filas.length = 0;
    ops.length = 0;
  });

  it('titular: join con el inmueble y la org en el mismo .or(); sin consulta de asignados', async () => {
    filas.push({ inmobiliaria_id: ORG, rol_miembro: 'owner', inmobiliarias: { miembros_ven_todo: false } });
    await resolveAllowedExpedienteIds(YO, 'inmobiliaria');
    const exp = ops.filter((o) => o.tabla === 'expedientes');
    expect(exp.find((o) => o.metodo === 'select')?.args[0]).toContain('inmuebles!expedientes_inmueble_id_fkey!inner');
    expect(exp.find((o) => o.metodo === 'or')?.args).toEqual([
      `propietario_id.eq.${YO},miembro_responsable_id.eq.${YO},inmobiliaria_id.in.(${ORG})`,
      { referencedTable: 'inmuebles' },
    ]);
    expect(exp.filter((o) => o.metodo === 'eq')).toEqual([]);
  });

  it('miembro restringido: sin la org, y suma los estudios que le asignaron', async () => {
    filas.push({ inmobiliaria_id: ORG, rol_miembro: 'miembro', inmobiliarias: { miembros_ven_todo: false } });
    await resolveAllowedExpedienteIds(YO, 'inmobiliaria');
    const exp = ops.filter((o) => o.tabla === 'expedientes');
    expect(exp.find((o) => o.metodo === 'or')?.args[0]).toBe(`propietario_id.eq.${YO},miembro_responsable_id.eq.${YO}`);
    expect(exp.filter((o) => o.metodo === 'eq').map((o) => o.args)).toEqual([['miembro_responsable_id', YO]]);
  });

  it('otros roles no tienen cartera: [] sin consultar; los internos, sin filtro', async () => {
    expect(await resolveAllowedExpedienteIds(YO, 'solicitante')).toEqual([]);
    expect(await resolveAllowedExpedienteIds(YO, 'administrador')).toBeNull();
    expect(ops).toEqual([]);
  });
});

describe('filtroPortafolio: la lista de inmuebles filtra en su propia consulta', () => {
  beforeEach(() => {
    invalidateMembresiasCache();
    filas.length = 0;
    ops.length = 0;
  });

  it('titular: propios, asignados y la org; sin consultar inmuebles', async () => {
    filas.push({ inmobiliaria_id: ORG, rol_miembro: 'owner', inmobiliarias: { miembros_ven_todo: false } });
    expect(await filtroPortafolio(YO)).toBe(`propietario_id.eq.${YO},miembro_responsable_id.eq.${YO},inmobiliaria_id.in.(${ORG})`);
    expect(ops.filter((o) => o.tabla === 'inmuebles')).toEqual([]);
  });

  it('miembro restringido o propietario sin org: solo propios y asignados', async () => {
    filas.push({ inmobiliaria_id: ORG, rol_miembro: 'miembro', inmobiliarias: { miembros_ven_todo: false } });
    expect(await filtroPortafolio(YO)).toBe(`propietario_id.eq.${YO},miembro_responsable_id.eq.${YO}`);
    invalidateMembresiasCache();
    filas.length = 0;
    expect(await filtroPortafolio(YO)).toBe(`propietario_id.eq.${YO},miembro_responsable_id.eq.${YO}`);
  });

  it('es la misma condición que usa resolvePortfolioInmuebleIds', async () => {
    filas.push({ inmobiliaria_id: ORG, rol_miembro: 'miembro', inmobiliarias: { miembros_ven_todo: true } });
    await resolvePortfolioInmuebleIds(YO);
    const or = ops.find((o) => o.tabla === 'inmuebles' && o.metodo === 'or');
    expect(or?.args[0]).toBe(await filtroPortafolio(YO));
  });
});

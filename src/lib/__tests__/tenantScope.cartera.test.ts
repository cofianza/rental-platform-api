/**
 * Cartera en una sola consulta (2026-09-23): el guard por id decide sobre la
 * fila con `expedienteVisible`, y las listas mandan la misma condición a
 * PostgREST. Aquí se compara esa condición con la regla escrita como conjuntos
 * (inmuebles de la org + propios + asignados → sus expedientes, más los
 * expedientes asignados en modo restringido; lo asignado, solo dentro de su
 * organización activa), en TODAS las combinaciones de rol, membresía y
 * dueño/asignado de la fila. Si alguien cambia una de las dos, este test dice
 * en qué caso se separan.
 * La equivalencia contra la BD real se corrió a mano al hacer el cambio
 * (143 comparaciones, 0 diferencias); exigir la membresía activa a lo asignado
 * no cambió nada en producción (2026-09-24: 1 inmueble y 2 estudios asignados,
 * todos a miembros activos de su organización).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { filas, ops, inmueble } = vi.hoisted(() => ({
  filas: [] as Array<Record<string, unknown>>,
  ops: [] as Array<{ tabla: string; metodo: string; args: unknown[] }>,
  // La fila que lee assertInmuebleAccess (null = no existe).
  inmueble: { fila: null as Record<string, unknown> | null },
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const chain: Record<string, unknown> = {
        then: (resolve: (v: unknown) => void) => resolve({ data: tabla === 'inmobiliaria_miembros' ? [...filas] : [], error: null }),
        maybeSingle: async () => ({ data: tabla === 'inmuebles' ? inmueble.fila : null, error: null }),
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
  assertExpedienteAccess,
  assertInmuebleAccess,
  expedienteVisible,
  filtroPortafolio,
  invalidateMembresiasCache,
  puedeVerFilaExpediente,
  resolveAllowedExpedienteIds,
  resolveAllowedInmuebleIds,
  resolvePortfolioInmuebleIds,
} from '@/lib/tenantScope';

const YO = 'yo';
const ORG = 'org-1';

/** La regla por conjuntos, para UNA fila. Lo registrado y lo asignado cuentan solo en su organización activa. */
function reglaAnterior(
  rol: 'inmobiliaria' | 'propietario',
  membresia: 'ninguna' | 'owner' | 'miembro_ve_todo' | 'miembro_restringido',
  fila: { propietario: string | null; org: string | null; inmAsignado: string | null; expAsignado: string | null; conInmueble: boolean },
): boolean {
  const completa = membresia === 'owner' || membresia === 'miembro_ve_todo';
  const miOrg = rol === 'inmobiliaria' && membresia !== 'ninguna' ? ORG : null;
  const enMiOrg = !!miOrg && fila.org === miOrg;
  const registrado = fila.propietario === YO && (fila.org === null || enMiOrg);
  let inmuebleVisible: boolean;
  if (rol === 'propietario') inmuebleVisible = registrado;
  else {
    const propio = registrado || (fila.inmAsignado === YO && enMiOrg);
    inmuebleVisible = completa ? fila.org === ORG || propio : propio;
  }
  const modoRestringido = rol === 'propietario' || !completa;
  return (fila.conInmueble && inmuebleVisible) || (modoRestringido && fila.expAsignado === YO && fila.conInmueble && enMiOrg);
}

const cartera = (rol: 'inmobiliaria' | 'propietario', membresia: string) => {
  const completa = membresia === 'owner' || membresia === 'miembro_ve_todo';
  return rol === 'propietario'
    ? { perfilId: YO, orgIds: [], orgActiva: null, inmueblesAsignados: false, expedientesAsignados: true }
    : {
        perfilId: YO,
        orgIds: completa ? [ORG] : [],
        orgActiva: membresia === 'ninguna' ? null : ORG,
        inmueblesAsignados: true,
        expedientesAsignados: !completa,
      };
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
      `and(propietario_id.eq.${YO},or(inmobiliaria_id.is.null,inmobiliaria_id.eq.${ORG})),and(miembro_responsable_id.eq.${YO},inmobiliaria_id.eq.${ORG}),inmobiliaria_id.in.(${ORG})`,
      { referencedTable: 'inmuebles' },
    ]);
    expect(exp.filter((o) => o.metodo === 'eq')).toEqual([]);
  });

  it('miembro restringido: sin la org, y suma los estudios que le asignaron dentro de ella', async () => {
    filas.push({ inmobiliaria_id: ORG, rol_miembro: 'miembro', inmobiliarias: { miembros_ven_todo: false } });
    await resolveAllowedExpedienteIds(YO, 'inmobiliaria');
    const exp = ops.filter((o) => o.tabla === 'expedientes');
    expect(exp.find((o) => o.metodo === 'or')?.args[0]).toBe(
      `and(propietario_id.eq.${YO},or(inmobiliaria_id.is.null,inmobiliaria_id.eq.${ORG})),and(miembro_responsable_id.eq.${YO},inmobiliaria_id.eq.${ORG})`,
    );
    expect(exp.filter((o) => o.metodo === 'eq').map((o) => o.args)).toEqual([
      ['miembro_responsable_id', YO],
      ['inmuebles.inmobiliaria_id', ORG],
    ]);
  });

  it('sin membresía activa (lo quitaron del equipo), lo que siguiera asignado no cuenta', async () => {
    await resolveAllowedExpedienteIds(YO, 'inmobiliaria');
    const exp = ops.filter((o) => o.tabla === 'expedientes');
    expect(exp.find((o) => o.metodo === 'or')?.args[0]).toBe(`and(propietario_id.eq.${YO},inmobiliaria_id.is.null)`);
    expect(exp.filter((o) => o.metodo === 'eq')).toEqual([]);
  });

  it('un rol de cliente sin id no es una llamada de sistema: nada, sin consultar', async () => {
    expect(await resolveAllowedExpedienteIds('', 'inmobiliaria')).toEqual([]);
    expect(await resolveAllowedExpedienteIds(undefined, 'propietario')).toEqual([]);
    expect(await resolveAllowedInmuebleIds('', 'inmobiliaria')).toEqual([]);
    expect(ops).toEqual([]);
    // Sin rol sí es el sistema: sin filtro.
    expect(await resolveAllowedExpedienteIds(undefined, undefined)).toBeNull();
  });

  it('propietario: la lista de inmuebles usa la misma condición que su detalle (los suyos sin organización)', async () => {
    await resolveAllowedInmuebleIds(YO, 'propietario');
    expect(ops.find((o) => o.tabla === 'inmuebles' && o.metodo === 'or')?.args[0]).toBe(`and(propietario_id.eq.${YO},inmobiliaria_id.is.null)`);
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
    expect(await filtroPortafolio(YO)).toBe(
      `and(propietario_id.eq.${YO},or(inmobiliaria_id.is.null,inmobiliaria_id.eq.${ORG})),and(miembro_responsable_id.eq.${YO},inmobiliaria_id.eq.${ORG}),inmobiliaria_id.in.(${ORG})`,
    );
    expect(ops.filter((o) => o.tabla === 'inmuebles')).toEqual([]);
  });

  it('miembro restringido: propios y asignados en su org; sin org (propietario o exmiembro): solo propios', async () => {
    filas.push({ inmobiliaria_id: ORG, rol_miembro: 'miembro', inmobiliarias: { miembros_ven_todo: false } });
    expect(await filtroPortafolio(YO)).toBe(`and(propietario_id.eq.${YO},or(inmobiliaria_id.is.null,inmobiliaria_id.eq.${ORG})),and(miembro_responsable_id.eq.${YO},inmobiliaria_id.eq.${ORG})`);
    invalidateMembresiasCache();
    filas.length = 0;
    expect(await filtroPortafolio(YO)).toBe(`and(propietario_id.eq.${YO},inmobiliaria_id.is.null)`);
  });

  it('es la misma condición que usa resolvePortfolioInmuebleIds', async () => {
    filas.push({ inmobiliaria_id: ORG, rol_miembro: 'miembro', inmobiliarias: { miembros_ven_todo: true } });
    await resolvePortfolioInmuebleIds(YO);
    const or = ops.find((o) => o.tabla === 'inmuebles' && o.metodo === 'or');
    expect(or?.args[0]).toBe(await filtroPortafolio(YO));
  });
});

describe('puedeVerFilaExpediente: el guard del detalle del contrato', () => {
  beforeEach(() => {
    invalidateMembresiasCache();
    filas.length = 0;
    ops.length = 0;
  });
  const fila = (org: string | null) => ({
    miembro_responsable_id: null,
    inmueble: { propietario_id: 'otro', inmobiliaria_id: org, miembro_responsable_id: null },
  });

  it('decide sobre la fila sin consultar expedientes', async () => {
    filas.push({ inmobiliaria_id: ORG, rol_miembro: 'owner', inmobiliarias: { miembros_ven_todo: false } });
    expect(await puedeVerFilaExpediente(YO, 'inmobiliaria', fila(ORG))).toBe(true);
    expect(await puedeVerFilaExpediente(YO, 'inmobiliaria', fila('org-2'))).toBe(false);
    expect(await puedeVerFilaExpediente(YO, 'inmobiliaria', null)).toBe(false);
    expect(ops.filter((o) => o.tabla !== 'inmobiliaria_miembros')).toEqual([]);
  });

  it('internos y sin identidad ven; solicitante y otros roles no', async () => {
    expect(await puedeVerFilaExpediente(YO, 'administrador', null)).toBe(true);
    expect(await puedeVerFilaExpediente(undefined, undefined, null)).toBe(true);
    expect(await puedeVerFilaExpediente(YO, 'solicitante', fila(ORG))).toBe(false);
    expect(ops).toEqual([]);
  });

  it('un rol de cliente sin id no ve nada (no es una llamada de sistema)', async () => {
    filas.push({ inmobiliaria_id: ORG, rol_miembro: 'owner', inmobiliarias: { miembros_ven_todo: false } });
    expect(await puedeVerFilaExpediente('', 'inmobiliaria', fila(ORG))).toBe(false);
    expect(await puedeVerFilaExpediente(undefined, 'propietario', fila(ORG))).toBe(false);
  });
});

describe('assertInmuebleAccess: por enlace se abre lo mismo que muestra la lista', () => {
  beforeEach(() => {
    invalidateMembresiasCache();
    filas.length = 0;
    ops.length = 0;
    inmueble.fila = null;
  });

  const MEMBRESIAS: Record<string, { rol_miembro: string; venTodo: boolean } | null> = {
    ninguna: null,
    owner: { rol_miembro: 'owner', venTodo: false },
    miembro_ve_todo: { rol_miembro: 'miembro', venTodo: true },
    miembro_restringido: { rol_miembro: 'miembro', venTodo: false },
    lectura_restringido: { rol_miembro: 'solo_lectura', venTodo: false },
  };
  const conMembresia = (m: string) => {
    invalidateMembresiasCache();
    filas.length = 0;
    const mm = MEMBRESIAS[m];
    if (mm) filas.push({ inmobiliaria_id: ORG, rol_miembro: mm.rol_miembro, inmobiliarias: { miembros_ven_todo: mm.venTodo } });
  };
  const abre = (rol: string) => assertInmuebleAccess('inm-1', YO, rol).then(() => true, () => false);

  /** La regla de la lista (filtroPortafolio), por conjuntos: lo asignado, solo dentro de su organización. */
  const esperado = (rol: string, m: string, f: { propietario: string | null; org: string | null; responsable: string | null }) => {
    if (rol === 'propietario') return f.propietario === YO && f.org === null;
    const completa = m === 'owner' || m === 'miembro_ve_todo';
    const miOrg = m === 'ninguna' ? null : ORG;
    const registrado = f.propietario === YO && (f.org === null || (!!miOrg && f.org === miOrg));
    return registrado || (f.responsable === YO && !!miOrg && f.org === miOrg) || (completa && f.org === ORG);
  };

  it('coincide con la lista en todas las combinaciones de rol, membresía y dueño/asignado', async () => {
    const quien = [YO, 'otro', null];
    const distintos: unknown[] = [];
    const roles: Array<[string, string[]]> = [['inmobiliaria', Object.keys(MEMBRESIAS)], ['propietario', ['ninguna']]];
    for (const [rol, membresias] of roles)
      for (const m of membresias)
        for (const propietario of quien)
          for (const org of [ORG, 'org-2', null])
            for (const responsable of quien) {
              conMembresia(m);
              inmueble.fila = { propietario_id: propietario, inmobiliaria_id: org, miembro_responsable_id: responsable };
              if ((await abre(rol)) !== esperado(rol, m, { propietario, org, responsable }))
                distintos.push({ rol, m, propietario, org, responsable });
            }
    expect(distintos).toEqual([]);
  });

  it('el miembro restringido no abre el inmueble de un compañero; sí el suyo y el que le asignaron', async () => {
    conMembresia('miembro_restringido');
    inmueble.fila = { propietario_id: 'companero', inmobiliaria_id: ORG, miembro_responsable_id: null };
    await expect(assertInmuebleAccess('inm-1', YO, 'inmobiliaria')).rejects.toMatchObject({
      statusCode: 404,
      errorCode: 'INMUEBLE_NOT_FOUND',
    });
    inmueble.fila = { propietario_id: 'companero', inmobiliaria_id: ORG, miembro_responsable_id: YO };
    await expect(assertInmuebleAccess('inm-1', YO, 'inmobiliaria')).resolves.toBeUndefined();
    inmueble.fila = { propietario_id: YO, inmobiliaria_id: ORG, miembro_responsable_id: null };
    await expect(assertInmuebleAccess('inm-1', YO, 'inmobiliaria')).resolves.toBeUndefined();
  });

  it('el titular y el miembro que ve todo abren toda la organización, no otra', async () => {
    for (const m of ['owner', 'miembro_ve_todo']) {
      conMembresia(m);
      inmueble.fila = { propietario_id: 'companero', inmobiliaria_id: ORG, miembro_responsable_id: null };
      expect(await abre('inmobiliaria')).toBe(true);
      inmueble.fila = { propietario_id: 'otro', inmobiliaria_id: 'org-2', miembro_responsable_id: null };
      expect(await abre('inmobiliaria')).toBe(false);
    }
  });

  it('no existe: 404; internos y llamadas sin identidad no consultan; solicitante 404 sin consultar', async () => {
    conMembresia('owner');
    await expect(assertInmuebleAccess('inm-1', YO, 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    ops.length = 0;
    await expect(assertInmuebleAccess('inm-1', YO, 'administrador')).resolves.toBeUndefined();
    await expect(assertInmuebleAccess('inm-1', undefined, undefined)).resolves.toBeUndefined();
    await expect(assertInmuebleAccess('inm-1', YO, 'solicitante')).rejects.toMatchObject({ statusCode: 404 });
    expect(ops).toEqual([]);
  });

  it('un rol de cliente sin id se niega, no se trata como el sistema', async () => {
    conMembresia('owner');
    inmueble.fila = { propietario_id: '', inmobiliaria_id: ORG, miembro_responsable_id: null };
    await expect(assertInmuebleAccess('inm-1', '', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    await expect(assertInmuebleAccess('inm-1', undefined, 'propietario')).rejects.toMatchObject({ statusCode: 404 });
    await expect(assertExpedienteAccess('exp-1', '', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    await expect(assertExpedienteAccess('exp-1', undefined, undefined)).resolves.toBeUndefined();
  });

  it('exmiembro que conserva propietario_id en un inmueble de su organización anterior: no lo abre', async () => {
    conMembresia('ninguna');
    inmueble.fila = { propietario_id: YO, inmobiliaria_id: ORG, miembro_responsable_id: null };
    expect(await abre('inmobiliaria')).toBe(false);
    // Ya en otra organización (org-2 en la fila, la suya es ORG): tampoco.
    conMembresia('miembro_restringido');
    inmueble.fila = { propietario_id: YO, inmobiliaria_id: 'org-2', miembro_responsable_id: null };
    expect(await abre('inmobiliaria')).toBe(false);
    // Lo suyo sin organización sí.
    inmueble.fila = { propietario_id: YO, inmobiliaria_id: null, miembro_responsable_id: null };
    expect(await abre('inmobiliaria')).toBe(true);
  });

  it('propietario que fue inmobiliaria de una sola persona (conserva su membresía): abre y lista lo suyo de su org', async () => {
    conMembresia('owner');
    inmueble.fila = { propietario_id: YO, inmobiliaria_id: ORG, miembro_responsable_id: null };
    expect(await abre('propietario')).toBe(true);
    ops.length = 0;
    await resolveAllowedInmuebleIds(YO, 'propietario');
    expect(ops.find((o) => o.tabla === 'inmuebles' && o.metodo === 'or')?.args[0]).toBe(
      `and(propietario_id.eq.${YO},or(inmobiliaria_id.is.null,inmobiliaria_id.eq.${ORG}))`,
    );
    // Lo de otra organización, no.
    inmueble.fila = { propietario_id: YO, inmobiliaria_id: 'org-2', miembro_responsable_id: null };
    expect(await abre('propietario')).toBe(false);
  });

  it('asignado a quien ya no es del equipo o de otra organización: no lo abre', async () => {
    // Lo quitaron del equipo y la asignación quedó (liberarResponsablesDeMiembro es best-effort).
    conMembresia('ninguna');
    inmueble.fila = { propietario_id: 'titular', inmobiliaria_id: ORG, miembro_responsable_id: YO };
    expect(await abre('inmobiliaria')).toBe(false);
    // Está en otra organización: lo asignado en la anterior no cuenta.
    conMembresia('miembro_restringido');
    inmueble.fila = { propietario_id: 'titular', inmobiliaria_id: 'org-2', miembro_responsable_id: YO };
    expect(await abre('inmobiliaria')).toBe(false);
  });
});

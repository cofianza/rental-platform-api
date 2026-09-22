/**
 * Contratos V3 — catálogo de cláusulas adicionales (Entrega 4, diseño §5.1, D2, D13).
 *
 * Una sola tabla: la biblioteca de Cofianza (inmobiliaria_id NULL) y las
 * propias de cada inmobiliaria. Editar sube la versión UNA vez con CAS sobre
 * `version`; el texto exacto de cada versión que llegó a un contrato vive en
 * el registro (contrato_clausulas_adicionales, lo escribe generar) y cada
 * edición queda en la bitácora con el antes y el después.
 *
 * Aislamiento: la org de la inmobiliaria SIEMPRE sale de su membresía, nunca
 * del cuerpo; toda lectura y escritura propia filtra por ella (service_role
 * bypassa RLS). Las rutas de la inmobiliaria responden 404 con
 * CONTRATOS_V3_ENABLED apagado; las del administrador no (Cofianza carga la
 * biblioteca antes del lanzamiento).
 */

import { env } from '@/config';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { resolveInmobiliariaIdForPerfil } from '@/lib/tenantScope';
import type {
  CatalogoClausulas,
  ClausulaCatalogo,
  ClausulaEnContrato,
  ClausulaRegistro,
  Hallazgo,
  UsoClausula,
} from './asistente.types';
import { campos, REGLAS_VERSION, shaClausula, validarClausula } from './clausulas.reglas';
import { validarTexto } from './clausulas.ia';
import { mayus, ordinal } from './formato';
import type { CambiarEstadoBody, ClausulaBody, EditarClausulaBody, RegistroQuery } from './clausulas.schema';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
const TABLA = 'clausulas_adicionales';
const COLS = 'id, inmobiliaria_id, titulo, texto, version, estado, validacion, inhabilitada_motivo, updated_at';
const POR_PAGINA = 50;
// En el catálogo no hay contrato: el coarrendatario se juzga en el paso 4, con el contrato real.
const VIVIENDA = { destinacion: 'vivienda', sinCoarrendatario: false } as const;

type Ia = ClausulaEnContrato['ia'];
interface Fila {
  id: string;
  inmobiliaria_id: string | null;
  titulo: string;
  texto: string;
  version: number;
  estado: ClausulaRegistro['estado'];
  validacion: { reglas: string; ia: Ia } | null;
  inhabilitada_motivo: string | null;
  updated_at: string;
}
interface FilaRegistro extends Fila {
  created_at: string;
  inmobiliarias: { id: string; nombre: string } | null;
  contrato_clausulas_adicionales: { count: number }[] | null;
}
interface FilaUso {
  contrato_id: string;
  version: number;
  numero: number;
  created_at: string;
  contratos: { numero: string | null; estado: string; expediente_id: string } | null;
}
/** Lo que devuelve guardar: `avisos` (cita por número) no bloquean; la web los muestra como advertencia. */
export type ClausulaGuardada = ClausulaCatalogo & { avisos: Hallazgo[] };

// ── Errores (§5.1) ──

const noHabilitado = () =>
  AppError.notFound('Las cláusulas adicionales aún no están habilitadas.', 'CONTRATOS_V3_NO_HABILITADO');
const cambiada = () =>
  AppError.conflict(
    'La cláusula cambió, fue inhabilitada o ya no existe. Recarga para ver la versión actual.',
    'CLAUSULA_CAMBIADA',
  );
const noEncontrada = () => AppError.notFound('La cláusula no existe o ya fue eliminada.', 'CLAUSULA_NO_ENCONTRADA');

function dato<T>(r: { data: unknown; error: { message: string } | null }, que: string): T {
  if (r.error) {
    logger.error({ que, error: r.error.message }, 'Cláusulas adicionales: error de base de datos');
    throw new AppError(500, 'CLAUSULAS_ERROR', 'No pudimos procesar las cláusulas adicionales. Intenta de nuevo.');
  }
  return r.data as T;
}

// ── Mapeo ──

const aCatalogo = (f: Fila): ClausulaCatalogo => ({
  id: f.id,
  origen: f.inmobiliaria_id ? 'propia' : 'biblioteca',
  titulo: f.titulo,
  texto: f.texto,
  version: f.version,
  estado: f.estado as ClausulaCatalogo['estado'],
  inhabilitadaMotivo: f.inhabilitada_motivo,
  campos: f.inmobiliaria_id ? [] : campos(f.texto),
  actualizadaEn: f.updated_at,
});

const aRegistro = (f: FilaRegistro): ClausulaRegistro => ({
  ...aCatalogo(f),
  estado: f.estado,
  inmobiliaria: f.inmobiliarias ? { id: f.inmobiliarias.id, nombre: f.inmobiliarias.nombre } : null,
  usos: f.contrato_clausulas_adicionales?.[0]?.count ?? 0,
  creadaEn: f.created_at,
});

const foto = (f: Fila) => ({ titulo: f.titulo, texto: f.texto, version: f.version });

function auditar(userId: string, id: string, detalle: Record<string, unknown>, ip?: string): void {
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CLAUSULA_ADICIONAL_GUARDADA,
    entidad: AUDIT_ENTITIES.CLAUSULA_ADICIONAL,
    entidadId: id,
    detalle,
    ip,
  });
}

// ── Validación y escritura compartidas (org = null → biblioteca) ──

/**
 * Propias: reglas y, si está encendida, la IA (puede dar 503 sin guardar nada).
 * Biblioteca: reglas con [[campo]] permitidos, sin IA (§5.1). Cualquier hallazgo
 * → 422 con todos; a pino van solo los códigos y el sha256, nunca el texto.
 */
async function validar(c: ClausulaBody, org: string | null, iaPrevia?: Ia) {
  const r = org
    ? await validarTexto(c, { ...VIVIENDA, conIA: true, iaPrevia })
    : { ...validarClausula(c, { ...VIVIENDA, biblioteca: true }), ia: null };
  if (r.hallazgos.length) {
    logger.info(
      { codigos: r.hallazgos.map((h) => h.codigo), sha256: shaClausula(c) },
      'Cláusula adicional bloqueada al guardar',
    );
    throw new AppError(422, 'CLAUSULA_NO_PERMITIDA', r.hallazgos[0].mensaje, {
      hallazgos: r.hallazgos,
      avisos: r.avisos,
    });
  }
  return r;
}

async function crearEn(userId: string, org: string | null, c: ClausulaBody, ip?: string): Promise<ClausulaGuardada> {
  const r = await validar(c, org);
  const fila = dato<Fila>(
    await db(TABLA)
      .insert({
        inmobiliaria_id: org,
        titulo: c.titulo,
        texto: c.texto,
        validacion: { reglas: REGLAS_VERSION, ia: r.ia },
        creado_por: userId,
      } as never)
      .select(COLS)
      .single(),
    'crear',
  );
  auditar(userId, fila.id, { op: 'crear', despues: foto(fila) }, ip);
  return { ...aCatalogo(fila), avisos: r.avisos };
}

/**
 * Lee la versión vigente (para el "antes" de la bitácora y para no gastar una
 * revisión en una versión vieja), valida y hace el CAS. La inmobiliaria solo
 * edita sus propias cláusulas activas; el administrador, la biblioteca aunque
 * esté inhabilitada (para corregirla antes de reactivarla).
 */
async function editarEn(
  userId: string,
  org: string | null,
  id: string,
  b: EditarClausulaBody,
  ip?: string,
): Promise<ClausulaGuardada> {
  const leer = db(TABLA).select(COLS).eq('id', id);
  const antes = dato<Fila | null>(
    await (org ? leer.eq('inmobiliaria_id', org).eq('estado', 'activa') : leer.is('inmobiliaria_id', null)).maybeSingle(),
    'editar',
  );
  if (!antes || antes.version !== b.version) throw cambiada();

  const c = { titulo: b.titulo, texto: b.texto };
  const r = await validar(c, org, antes.validacion?.ia);
  const cas = db(TABLA)
    .update({
      titulo: c.titulo,
      texto: c.texto,
      version: antes.version + 1,
      validacion: { reglas: REGLAS_VERSION, ia: r.ia },
    } as never)
    .eq('id', id)
    .eq('version', antes.version);
  const filas = dato<Fila[] | null>(
    await (org ? cas.eq('inmobiliaria_id', org).eq('estado', 'activa') : cas.is('inmobiliaria_id', null)).select(COLS),
    'editar',
  );
  if (!filas?.length) throw cambiada();
  auditar(userId, id, { op: 'editar', antes: foto(antes), despues: foto(filas[0]) }, ip);
  return { ...aCatalogo(filas[0]), avisos: r.avisos };
}

// ── Inmobiliaria ──

async function orgDe(userId: string): Promise<string> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  const org = await resolveInmobiliariaIdForPerfil(userId);
  if (!org) throw AppError.forbidden('Tu usuario no pertenece a una inmobiliaria.', 'SIN_INMOBILIARIA');
  return org;
}

/** La biblioteca activa y las propias activas o inhabilitadas, por título. */
export async function catalogo(userId: string): Promise<CatalogoClausulas> {
  const org = await orgDe(userId);
  const [biblioteca, propias] = await Promise.all([
    db(TABLA).select(COLS).is('inmobiliaria_id', null).eq('estado', 'activa').order('titulo'),
    db(TABLA).select(COLS).eq('inmobiliaria_id', org).in('estado', ['activa', 'inhabilitada']).order('titulo'),
  ]);
  return {
    biblioteca: (dato<Fila[] | null>(biblioteca, 'catalogo') ?? []).map(aCatalogo),
    propias: (dato<Fila[] | null>(propias, 'catalogo') ?? []).map(aCatalogo),
  };
}

export async function crear(userId: string, c: ClausulaBody, ip?: string): Promise<ClausulaGuardada> {
  return crearEn(userId, await orgDe(userId), c, ip);
}

export async function editar(userId: string, id: string, b: EditarClausulaBody, ip?: string): Promise<ClausulaGuardada> {
  return editarEn(userId, await orgDe(userId), id, b, ip);
}

/** Borrado lógico: los contratos que ya la usan conservan su texto en el registro. */
export async function eliminar(userId: string, id: string, ip?: string): Promise<void> {
  const org = await orgDe(userId);
  const filas = dato<Fila[] | null>(
    await db(TABLA)
      .update({ estado: 'eliminada' } as never)
      .eq('id', id)
      .eq('inmobiliaria_id', org)
      .neq('estado', 'eliminada')
      .select(COLS),
    'eliminar',
  );
  if (!filas?.length) throw noEncontrada();
  auditar(userId, id, { op: 'eliminar', antes: foto(filas[0]) }, ip);
}

// ── Administrador (sin compuerta de flag) ──

/** Biblioteca y registro de todas las inmobiliarias, 50 por página, lo más reciente primero. */
export async function registro(q: RegistroQuery): Promise<{ items: ClausulaRegistro[]; total: number }> {
  let s = db(TABLA).select(
    `${COLS}, created_at, inmobiliarias(id, nombre), contrato_clausulas_adicionales(count)`,
    { count: 'exact' },
  );
  if (q.origen === 'biblioteca') s = s.is('inmobiliaria_id', null);
  if (q.origen === 'propia') s = s.not('inmobiliaria_id', 'is', null);
  if (q.estado) s = s.eq('estado', q.estado);
  // q ya viene sin la sintaxis de filtros de PostgREST (registroQuerySchema).
  if (q.q) s = s.or(`titulo.ilike.%${q.q}%,texto.ilike.%${q.q}%`);
  const desde = (q.page - 1) * POR_PAGINA;
  const r = await s.order('updated_at', { ascending: false }).range(desde, desde + POR_PAGINA - 1);
  return { items: (dato<FilaRegistro[] | null>(r, 'registro') ?? []).map(aRegistro), total: r.count ?? 0 };
}

/** Contratos que imprimieron la cláusula, con la versión y el número de cláusula usados. */
export async function usos(id: string): Promise<UsoClausula[]> {
  const filas = dato<FilaUso[] | null>(
    await db('contrato_clausulas_adicionales')
      .select('contrato_id, version, numero, created_at, contratos(numero, estado, expediente_id)')
      .eq('clausula_id', id)
      .order('created_at', { ascending: false }),
    'usos',
  );
  return (filas ?? []).map((f) => ({
    contratoId: f.contrato_id,
    contratoNumero: f.contratos?.numero ?? '',
    contratoEstado: f.contratos?.estado ?? '',
    expedienteId: f.contratos?.expediente_id ?? '',
    version: f.version,
    numero: mayus(ordinal(f.numero)),
    en: f.created_at,
  }));
}

export async function crearBiblioteca(userId: string, c: ClausulaBody, ip?: string): Promise<ClausulaGuardada> {
  return crearEn(userId, null, c, ip);
}

export async function editarBiblioteca(
  userId: string,
  id: string,
  b: EditarClausulaBody,
  ip?: string,
): Promise<ClausulaGuardada> {
  return editarEn(userId, null, id, b, ip);
}

/**
 * Inhabilitar (con motivo, lo ve la inmobiliaria) o reactivar cualquier cláusula
 * no eliminada. Solo hacia adelante: los contratos en borrador que la usan
 * quedan bloqueados en el paso 4; los firmados no cambian.
 */
export async function cambiarEstado(
  userId: string,
  id: string,
  b: CambiarEstadoBody,
  ip?: string,
): Promise<ClausulaCatalogo> {
  const cambio =
    b.estado === 'inhabilitada'
      ? { estado: b.estado, inhabilitada_motivo: b.motivo, inhabilitada_en: new Date().toISOString() }
      : { estado: b.estado, inhabilitada_motivo: null, inhabilitada_en: null };
  const filas = dato<Fila[] | null>(
    await db(TABLA).update(cambio as never).eq('id', id).neq('estado', 'eliminada').select(COLS),
    'estado',
  );
  if (!filas?.length) throw noEncontrada();
  auditar(
    userId,
    id,
    b.estado === 'inhabilitada' ? { op: 'inhabilitar', motivo: b.motivo } : { op: 'reactivar' },
    ip,
  );
  return aCatalogo(filas[0]);
}

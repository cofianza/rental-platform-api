// ============================================================
// Dashboard — Secciones del Centro de Control (admin)
//
// Endpoints de listado para las pestañas del Centro de Control (mockup
// htmls/15_*): Inmobiliarias, Propietarios, Inquilinos, Contratos, Vitrina,
// Ingresos. Mora/Soporte/Usuarios reutilizan sus módulos existentes.
//
// Toda la data es REAL. Campos del mockup SIN fuente en el schema (tier,
// inmobiliaria asociada del propietario, CxC, "contactado por") se omiten;
// no se inventan. Volumen pequeño (consola interna) → se agrega en memoria.
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';

// Estados de contrato considerados "activos" (firmado = listo, vigente = corriendo).
const ESTADOS_CONTRATO_ACTIVO = ['firmado', 'vigente'] as const;
const ESTADOS_MORA_ACTIVA = ['fase_1', 'fase_2', 'fase_3'] as const;
const POR_VENCER_DIAS = 60;

// ── Helper de agregación por perfil (propietario o inmobiliaria) ────
//
// Para un conjunto de perfiles (dueños de inmuebles), calcula #contratos
// activos, canon total y #moras activas. Cadena:
//   perfil → inmuebles.propietario_id → expedientes.inmueble_id →
//   contratos.expediente_id → moras_tickets.contrato_id

interface PerfilAgregado {
  contratosActivos: number;
  canonTotal: number;
  moraActivaCount: number;
}

async function agregarPorPerfil(perfilIds: string[]): Promise<Map<string, PerfilAgregado>> {
  const out = new Map<string, PerfilAgregado>();
  for (const id of perfilIds) out.set(id, { contratosActivos: 0, canonTotal: 0, moraActivaCount: 0 });
  if (perfilIds.length === 0) return out;

  // 1) inmuebles del perfil
  const { data: inmuebles, error: e1 } = await supabase
    .from('inmuebles')
    .select('id, propietario_id')
    .in('propietario_id', perfilIds);
  if (e1) throw fromSupabaseError(e1);

  const inmuebleToPerfil = new Map<string, string>();
  for (const i of (inmuebles ?? []) as Array<{ id: string; propietario_id: string }>) {
    inmuebleToPerfil.set(i.id, i.propietario_id);
  }
  const inmuebleIds = [...inmuebleToPerfil.keys()];
  if (inmuebleIds.length === 0) return out;

  // 2) expedientes de esos inmuebles
  const { data: expedientes, error: e2 } = await supabase
    .from('expedientes')
    .select('id, inmueble_id')
    .in('inmueble_id', inmuebleIds);
  if (e2) throw fromSupabaseError(e2);

  const expedienteToPerfil = new Map<string, string>();
  for (const ex of (expedientes ?? []) as Array<{ id: string; inmueble_id: string }>) {
    const perfil = inmuebleToPerfil.get(ex.inmueble_id);
    if (perfil) expedienteToPerfil.set(ex.id, perfil);
  }
  const expedienteIds = [...expedienteToPerfil.keys()];
  if (expedienteIds.length === 0) return out;

  // 3) contratos activos de esos expedientes
  const { data: contratos, error: e3 } = await supabase
    .from('contratos')
    .select('id, expediente_id, valor_arriendo, estado')
    .in('expediente_id', expedienteIds)
    .in('estado', ESTADOS_CONTRATO_ACTIVO as unknown as string[]);
  if (e3) throw fromSupabaseError(e3);

  const contratoToPerfil = new Map<string, string>();
  for (const c of (contratos ?? []) as Array<{ id: string; expediente_id: string; valor_arriendo: number | string | null }>) {
    const perfil = expedienteToPerfil.get(c.expediente_id);
    if (!perfil) continue;
    contratoToPerfil.set(c.id, perfil);
    const agg = out.get(perfil)!;
    agg.contratosActivos += 1;
    agg.canonTotal += Number(c.valor_arriendo ?? 0);
  }
  const contratoIds = [...contratoToPerfil.keys()];
  if (contratoIds.length === 0) return out;

  // 4) moras activas de esos contratos
  const { data: moras, error: e4 } = await (
    supabase.from('moras_tickets' as string) as ReturnType<typeof supabase.from>
  )
    .select('contrato_id, estado')
    .in('contrato_id', contratoIds)
    .in('estado', ESTADOS_MORA_ACTIVA as unknown as string[]);
  if (e4) throw fromSupabaseError(e4);

  for (const m of (moras ?? []) as Array<{ contrato_id: string; estado: string }>) {
    const perfil = contratoToPerfil.get(m.contrato_id);
    if (perfil) out.get(perfil)!.moraActivaCount += 1;
  }

  return out;
}

// ── INMOBILIARIAS ───────────────────────────────────────────

export interface InmobiliariaRow {
  id: string;
  nombre: string;
  nit: string | null;
  contacto: string | null;
  cargoContacto: string | null;
  telefono: string | null;
  ciudad: string | null;
  estado: string; // activo | inactivo
  desde: string; // created_at
  contratosActivos: number;
  canonTotal: number;
  moraActivaCount: number;
}

export async function listInmobiliarias(): Promise<InmobiliariaRow[]> {
  const { data, error } = await supabase
    .from('perfiles')
    .select('id, razon_social, nombre, apellido, nit, nombre_representante, telefono, ciudad, estado, created_at')
    .eq('rol', 'inmobiliaria')
    .order('created_at', { ascending: false });
  if (error) throw fromSupabaseError(error);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const agg = await agregarPorPerfil(rows.map((r) => r.id as string));

  return rows.map((r) => {
    const a = agg.get(r.id as string) ?? { contratosActivos: 0, canonTotal: 0, moraActivaCount: 0 };
    const razon = (r.razon_social as string) || `${r.nombre ?? ''} ${r.apellido ?? ''}`.trim() || '—';
    return {
      id: r.id as string,
      nombre: razon,
      nit: (r.nit as string) ?? null,
      contacto: (r.nombre_representante as string) ?? null,
      cargoContacto: null, // no existe columna de "cargo" del representante en perfiles → se omite (no se inventa)
      telefono: (r.telefono as string) ?? null,
      ciudad: (r.ciudad as string) ?? null,
      estado: (r.estado as string) ?? 'activo',
      desde: r.created_at as string,
      contratosActivos: a.contratosActivos,
      canonTotal: a.canonTotal,
      moraActivaCount: a.moraActivaCount,
    };
  });
}

// ── PROPIETARIOS ────────────────────────────────────────────

export interface PropietarioRow {
  id: string;
  nombre: string;
  cedula: string | null;
  telefono: string | null;
  ciudad: string | null;
  estado: string;
  desde: string;
  contratosActivos: number;
  canonTotal: number;
  moraActivaCount: number;
}

export async function listPropietarios(): Promise<PropietarioRow[]> {
  const { data, error } = await supabase
    .from('perfiles')
    .select('id, nombre, apellido, numero_documento, telefono, ciudad, estado, created_at')
    .eq('rol', 'propietario')
    .order('created_at', { ascending: false });
  if (error) throw fromSupabaseError(error);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const agg = await agregarPorPerfil(rows.map((r) => r.id as string));

  return rows.map((r) => {
    const a = agg.get(r.id as string) ?? { contratosActivos: 0, canonTotal: 0, moraActivaCount: 0 };
    return {
      id: r.id as string,
      nombre: `${r.nombre ?? ''} ${r.apellido ?? ''}`.trim() || '—',
      cedula: (r.numero_documento as string) ?? null,
      telefono: (r.telefono as string) ?? null,
      ciudad: (r.ciudad as string) ?? null,
      estado: (r.estado as string) ?? 'activo',
      desde: r.created_at as string,
      contratosActivos: a.contratosActivos,
      canonTotal: a.canonTotal,
      moraActivaCount: a.moraActivaCount,
    };
  });
}

// ── Helpers compartidos para Inquilinos / Contratos ─────────

interface ContratoRowDB {
  id: string;
  estado: string;
  valor_arriendo: number | string | null;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  motivo_cancelacion: string | null;
  expediente_id: string;
  expedientes: {
    id: string;
    ciudad?: string | null;
    inmuebles: { codigo: string | null; direccion: string | null; ciudad: string | null } | null;
    solicitantes: {
      nombre: string | null;
      apellido: string | null;
      numero_documento: string | null;
      telefono: string | null;
      email?: string | null;
      ocupacion?: string | null;
      actividad_economica?: string | null;
      ingresos_mensuales?: number | string | null;
      empresa?: string | null;
      tipo_persona?: string | null;
    } | null;
    propietario?: unknown;
  } | null;
}

function mesesTranscurridos(fechaInicio: string | null, now: Date): number {
  if (!fechaInicio) return 0;
  const ini = new Date(fechaInicio);
  if (Number.isNaN(ini.getTime())) return 0;
  return (now.getFullYear() - ini.getFullYear()) * 12 + (now.getMonth() - ini.getMonth());
}

function isPorVencer(fechaFin: string | null, now: Date): boolean {
  if (!fechaFin) return false;
  const fin = new Date(fechaFin);
  if (Number.isNaN(fin.getTime())) return false;
  const diff = Math.floor((fin.getTime() - now.getTime()) / 86_400_000);
  return diff >= 0 && diff <= POR_VENCER_DIAS;
}

function fmtInmueble(i: { codigo: string | null; direccion: string | null } | null | undefined): string {
  if (!i) return '—';
  if (i.codigo && i.direccion) return `${i.codigo} ${i.direccion}`;
  return i.codigo || i.direccion || '—';
}

// Mapa expediente_id → {score, resultado} (último estudio con resultado).
async function fetchEstudiosPorExpediente(expedienteIds: string[]): Promise<Map<string, { score: number | null; resultado: string | null }>> {
  const out = new Map<string, { score: number | null; resultado: string | null }>();
  if (expedienteIds.length === 0) return out;
  const { data, error } = await (
    supabase.from('estudios' as string) as ReturnType<typeof supabase.from>
  )
    .select('expediente_id, score, resultado, created_at')
    .in('expediente_id', expedienteIds)
    .order('created_at', { ascending: false });
  if (error) throw fromSupabaseError(error);
  for (const e of (data ?? []) as Array<{ expediente_id: string; score: number | null; resultado: string | null }>) {
    // El primero (más reciente) por expediente gana.
    if (!out.has(e.expediente_id)) out.set(e.expediente_id, { score: e.score, resultado: e.resultado });
  }
  return out;
}

// Set de contrato_id con mora activa (para estado de pago proxy).
async function fetchContratoIdsConMora(contratoIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (contratoIds.length === 0) return out;
  const { data, error } = await (
    supabase.from('moras_tickets' as string) as ReturnType<typeof supabase.from>
  )
    .select('contrato_id, estado')
    .in('contrato_id', contratoIds)
    .in('estado', ESTADOS_MORA_ACTIVA as unknown as string[]);
  if (error) throw fromSupabaseError(error);
  for (const m of (data ?? []) as Array<{ contrato_id: string }>) out.add(m.contrato_id);
  return out;
}

// Mapa expediente_id → nombre del coarrendatario.
async function fetchCoarrendatariosPorExpediente(expedienteIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (expedienteIds.length === 0) return out;
  const { data, error } = await (
    supabase.from('expediente_coarrendatarios' as string) as ReturnType<typeof supabase.from>
  )
    .select('expediente_id, nombre, apellido')
    .in('expediente_id', expedienteIds);
  if (error) throw fromSupabaseError(error);
  for (const c of (data ?? []) as Array<{ expediente_id: string; nombre: string | null; apellido: string | null }>) {
    if (!out.has(c.expediente_id)) out.set(c.expediente_id, `${c.nombre ?? ''} ${c.apellido ?? ''}`.trim());
  }
  return out;
}

// Mapa expediente_id → nombre propietario (vía inmueble.propietario_id → perfiles).
async function fetchPropietarioPorExpediente(expedienteIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (expedienteIds.length === 0) return out;
  const { data: exps, error: e1 } = await supabase
    .from('expedientes')
    .select('id, inmueble_id')
    .in('id', expedienteIds);
  if (e1) throw fromSupabaseError(e1);
  const expToInmueble = new Map<string, string>();
  const inmuebleIds = new Set<string>();
  for (const e of (exps ?? []) as Array<{ id: string; inmueble_id: string | null }>) {
    if (e.inmueble_id) { expToInmueble.set(e.id, e.inmueble_id); inmuebleIds.add(e.inmueble_id); }
  }
  if (inmuebleIds.size === 0) return out;

  const { data: inms, error: e2 } = await supabase
    .from('inmuebles')
    .select('id, propietario_id')
    .in('id', [...inmuebleIds]);
  if (e2) throw fromSupabaseError(e2);
  const inmuebleToPerfil = new Map<string, string>();
  const perfilIds = new Set<string>();
  for (const i of (inms ?? []) as Array<{ id: string; propietario_id: string | null }>) {
    if (i.propietario_id) { inmuebleToPerfil.set(i.id, i.propietario_id); perfilIds.add(i.propietario_id); }
  }
  if (perfilIds.size === 0) return out;

  const { data: perfs, error: e3 } = await supabase
    .from('perfiles')
    .select('id, nombre, apellido, razon_social')
    .in('id', [...perfilIds]);
  if (e3) throw fromSupabaseError(e3);
  const perfilNombre = new Map<string, string>();
  for (const p of (perfs ?? []) as Array<{ id: string; nombre: string | null; apellido: string | null; razon_social: string | null }>) {
    perfilNombre.set(p.id, p.razon_social || `${p.nombre ?? ''} ${p.apellido ?? ''}`.trim() || '—');
  }

  for (const [expId, inmId] of expToInmueble) {
    const perfil = inmuebleToPerfil.get(inmId);
    if (perfil) out.set(expId, perfilNombre.get(perfil) ?? '—');
  }
  return out;
}

const CONTRATO_SELECT =
  'id, estado, valor_arriendo, fecha_inicio, fecha_fin, motivo_cancelacion, expediente_id, ' +
  'expedientes(id, inmuebles(codigo, direccion, ciudad), solicitantes(nombre, apellido, numero_documento, telefono))';

// Variante con datos extra del solicitante (ficha de detalle en Inquilinos).
const INQUILINO_SELECT =
  'id, estado, valor_arriendo, fecha_inicio, fecha_fin, motivo_cancelacion, expediente_id, ' +
  'expedientes(id, inmuebles(codigo, direccion, ciudad), solicitantes(' +
  'nombre, apellido, numero_documento, telefono, email, ocupacion, actividad_economica, ingresos_mensuales, empresa, tipo_persona))';

// ── INQUILINOS (contratos activos, foco en el arrendatario) ──

export interface InquilinoRow {
  contratoId: string;
  expedienteId: string;
  inquilino: string;
  cedula: string | null;
  telefono: string | null;
  inmueble: string;
  municipio: string | null;
  canon: number;
  score: number | null;
  resultado: string | null;
  mes: number;
  pago: 'mora' | 'al_dia';
  coarrendatario: string | null;
  fechaFin: string | null;
  // Datos extra del solicitante (ficha de detalle).
  email: string | null;
  ocupacion: string | null;
  actividadEconomica: string | null;
  ingresos: number | null;
  empresa: string | null;
  tipoPersona: string | null;
}

export async function listInquilinos(): Promise<InquilinoRow[]> {
  const { data, error } = await (
    supabase.from('contratos' as string) as ReturnType<typeof supabase.from>
  )
    .select(INQUILINO_SELECT)
    .in('estado', ESTADOS_CONTRATO_ACTIVO as unknown as string[]);
  if (error) throw fromSupabaseError(error);

  const rows = (data ?? []) as unknown as ContratoRowDB[];
  const expedienteIds = rows.map((r) => r.expediente_id).filter(Boolean);
  const contratoIds = rows.map((r) => r.id);

  const [estudios, conMora, coarr] = await Promise.all([
    fetchEstudiosPorExpediente(expedienteIds),
    fetchContratoIdsConMora(contratoIds),
    fetchCoarrendatariosPorExpediente(expedienteIds),
  ]);

  const now = new Date();
  return rows.map((r) => {
    const sol = r.expedientes?.solicitantes ?? null;
    const inm = r.expedientes?.inmuebles ?? null;
    const est = estudios.get(r.expediente_id);
    const coa = coarr.get(r.expediente_id);
    return {
      contratoId: r.id,
      expedienteId: r.expediente_id,
      inquilino: sol ? `${sol.nombre ?? ''} ${sol.apellido ?? ''}`.trim() || '—' : '—',
      cedula: sol?.numero_documento ?? null,
      telefono: sol?.telefono ?? null,
      inmueble: fmtInmueble(inm),
      municipio: inm?.ciudad ?? null,
      canon: Number(r.valor_arriendo ?? 0),
      score: est?.score ?? null,
      resultado: est?.resultado ?? null,
      mes: mesesTranscurridos(r.fecha_inicio, now),
      pago: conMora.has(r.id) ? 'mora' : 'al_dia',
      coarrendatario: coa && coa.length > 0 ? coa : null,
      fechaFin: r.fecha_fin,
      email: sol?.email ?? null,
      ocupacion: sol?.ocupacion ?? null,
      actividadEconomica: sol?.actividad_economica ?? null,
      ingresos: sol?.ingresos_mensuales != null ? Number(sol.ingresos_mensuales) : null,
      empresa: sol?.empresa ?? null,
      tipoPersona: sol?.tipo_persona ?? null,
    };
  });
}

// ── CONTRATOS (todos, foco en el contrato) ──────────────────

export interface ContratoAdminRow {
  id: string;
  inmueble: string;
  inquilino: string;
  propietario: string;
  canon: number;
  inicio: string | null;
  fin: string | null;
  mes: number;
  estado: string; // estado real del enum
  porVencer: boolean; // computed
  pago: 'mora' | 'al_dia';
  motivoCierre: string | null;
}

export async function listContratosAdmin(): Promise<ContratoAdminRow[]> {
  const { data, error } = await (
    supabase.from('contratos' as string) as ReturnType<typeof supabase.from>
  )
    .select(CONTRATO_SELECT)
    .order('created_at', { ascending: false });
  if (error) throw fromSupabaseError(error);

  const rows = (data ?? []) as unknown as ContratoRowDB[];
  const expedienteIds = rows.map((r) => r.expediente_id).filter(Boolean);
  const contratoIds = rows.map((r) => r.id);

  const [conMora, propietarios] = await Promise.all([
    fetchContratoIdsConMora(contratoIds),
    fetchPropietarioPorExpediente(expedienteIds),
  ]);

  const now = new Date();
  return rows.map((r) => {
    const sol = r.expedientes?.solicitantes ?? null;
    const inm = r.expedientes?.inmuebles ?? null;
    return {
      id: r.id,
      inmueble: fmtInmueble(inm),
      inquilino: sol ? `${sol.nombre ?? ''} ${sol.apellido ?? ''}`.trim() || '—' : '—',
      propietario: propietarios.get(r.expediente_id) ?? '—',
      canon: Number(r.valor_arriendo ?? 0),
      inicio: r.fecha_inicio,
      fin: r.fecha_fin,
      mes: mesesTranscurridos(r.fecha_inicio, now),
      estado: r.estado,
      porVencer: r.estado === 'vigente' && isPorVencer(r.fecha_fin, now),
      pago: conMora.has(r.id) ? 'mora' : 'al_dia',
      motivoCierre: r.motivo_cancelacion ?? null,
    };
  });
}

// ── VITRINA (publicados + prospectos) ───────────────────────

export interface VitrinaPublicadoRow {
  id: string;
  codigo: string | null;
  inmueble: string;
  tipo: string | null;
  canon: number;
  municipio: string | null;
  publicado: string; // created_at (aprox)
  estado: string; // disponible | en_estudio | ocupado | inactivo
  visitas: number;
  contactos: number;
}

export interface VitrinaProspectoRow {
  expedienteId: string;
  nombre: string;
  telefono: string | null;
  inmueble: string;
  fecha: string;
  fuente: string;
  estado: string;
  notas: string | null;
}

export interface VitrinaData {
  publicados: VitrinaPublicadoRow[];
  prospectos: VitrinaProspectoRow[];
}

export async function getVitrinaAdmin(): Promise<VitrinaData> {
  // Publicados
  const { data: inms, error: e1 } = await (
    supabase.from('inmuebles' as string) as ReturnType<typeof supabase.from>
  )
    .select('id, codigo, direccion, ciudad, tipo, valor_arriendo, estado, created_at')
    .eq('visible_vitrina', true)
    .order('created_at', { ascending: false });
  if (e1) throw fromSupabaseError(e1);

  const inmRows = (inms ?? []) as Array<Record<string, unknown>>;
  const inmuebleIds = inmRows.map((r) => r.id as string);

  // Interacciones (vista/contacto) agregadas por inmueble
  const visitasPorInmueble = new Map<string, number>();
  const contactosPorInmueble = new Map<string, number>();
  if (inmuebleIds.length > 0) {
    const { data: inter, error: e2 } = await (
      supabase.from('vitrina_interacciones' as string) as ReturnType<typeof supabase.from>
    )
      .select('inmueble_id, tipo')
      .in('inmueble_id', inmuebleIds);
    if (e2) throw fromSupabaseError(e2);
    for (const it of (inter ?? []) as Array<{ inmueble_id: string; tipo: string }>) {
      const target = it.tipo === 'contacto' ? contactosPorInmueble : visitasPorInmueble;
      target.set(it.inmueble_id, (target.get(it.inmueble_id) ?? 0) + 1);
    }
  }

  const publicados: VitrinaPublicadoRow[] = inmRows.map((r) => ({
    id: r.id as string,
    codigo: (r.codigo as string) ?? null,
    inmueble: fmtInmueble({ codigo: (r.codigo as string) ?? null, direccion: (r.direccion as string) ?? null }),
    tipo: (r.tipo as string) ?? null,
    canon: Number(r.valor_arriendo ?? 0),
    municipio: (r.ciudad as string) ?? null,
    publicado: r.created_at as string,
    estado: (r.estado as string) ?? 'disponible',
    visitas: visitasPorInmueble.get(r.id as string) ?? 0,
    contactos: contactosPorInmueble.get(r.id as string) ?? 0,
  }));

  // Prospectos = expedientes provenientes de la vitrina pública
  const { data: exps, error: e3 } = await (
    supabase.from('expedientes' as string) as ReturnType<typeof supabase.from>
  )
    .select('id, source, estado, notas, created_at, inmuebles(codigo, direccion), solicitantes(nombre, apellido, telefono)')
    .eq('source', 'vitrina_publica')
    .order('created_at', { ascending: false });
  if (e3) throw fromSupabaseError(e3);

  const prospectos: VitrinaProspectoRow[] = ((exps ?? []) as Array<Record<string, unknown>>).map((r) => {
    const sol = r.solicitantes as { nombre: string | null; apellido: string | null; telefono: string | null } | null;
    const inm = r.inmuebles as { codigo: string | null; direccion: string | null } | null;
    return {
      expedienteId: r.id as string,
      nombre: sol ? `${sol.nombre ?? ''} ${sol.apellido ?? ''}`.trim() || '—' : '—',
      telefono: sol?.telefono ?? null,
      inmueble: fmtInmueble(inm),
      fecha: r.created_at as string,
      fuente: (r.source as string) ?? 'vitrina_publica',
      estado: (r.estado as string) ?? 'borrador',
      notas: (r.notas as string) ?? null,
    };
  });

  return { publicados, prospectos };
}

// ── INGRESOS (detalle por contrato + resumen) ───────────────
//
// Ingreso real = tarifa plana valor_afianzamiento_mensual × contrato activo
// (NO % del canon). IVA según iva_concepto_garantia (hoy 0/exento).

export interface IngresoContratoRow {
  contratoId: string;
  inquilino: string;
  inmueble: string;
  canon: number;
  afianzamiento: number;
  iva: number;
  total: number;
}

export interface IngresosData {
  valorAfianzamientoMensual: number;
  ivaGarantiaPorcentaje: number;
  totalAfianzamiento: number;
  totalIva: number;
  totalBruto: number;
  porContrato: IngresoContratoRow[];
}

async function getConfigIngresos(): Promise<{ afianzamiento: number; ivaPct: number }> {
  const { data } = await (
    supabase.from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>
  )
    .select('clave, valor')
    .in('clave', ['valor_afianzamiento_mensual', 'iva_concepto_garantia']);
  const map: Record<string, string> = {};
  for (const r of (data ?? []) as Array<{ clave: string; valor: string }>) map[r.clave] = r.valor;
  const afianzamiento = Number(map['valor_afianzamiento_mensual']);
  const ivaPct = Number(map['iva_concepto_garantia']);
  return {
    afianzamiento: Number.isFinite(afianzamiento) ? afianzamiento : 20000,
    ivaPct: Number.isFinite(ivaPct) ? ivaPct : 0,
  };
}

export async function getIngresosAdmin(): Promise<IngresosData> {
  const cfg = await getConfigIngresos();
  const ivaFactor = cfg.ivaPct / 100;

  const { data, error } = await (
    supabase.from('contratos' as string) as ReturnType<typeof supabase.from>
  )
    .select(CONTRATO_SELECT)
    .in('estado', ESTADOS_CONTRATO_ACTIVO as unknown as string[]);
  if (error) throw fromSupabaseError(error);

  const rows = (data ?? []) as unknown as ContratoRowDB[];
  const porContrato: IngresoContratoRow[] = rows.map((r) => {
    const sol = r.expedientes?.solicitantes ?? null;
    const inm = r.expedientes?.inmuebles ?? null;
    const afianzamiento = cfg.afianzamiento;
    const iva = Math.round(afianzamiento * ivaFactor);
    return {
      contratoId: r.id,
      inquilino: sol ? `${sol.nombre ?? ''} ${sol.apellido ?? ''}`.trim() || '—' : '—',
      inmueble: fmtInmueble(inm),
      canon: Number(r.valor_arriendo ?? 0),
      afianzamiento,
      iva,
      total: afianzamiento + iva,
    };
  });

  const totalAfianzamiento = porContrato.reduce((s, c) => s + c.afianzamiento, 0);
  const totalIva = porContrato.reduce((s, c) => s + c.iva, 0);

  return {
    valorAfianzamientoMensual: cfg.afianzamiento,
    ivaGarantiaPorcentaje: cfg.ivaPct,
    totalAfianzamiento,
    totalIva,
    totalBruto: totalAfianzamiento + totalIva,
    porContrato,
  };
}

// ── DETALLE DE ALIADO (inmobiliaria/propietario) ────────────
//
// Ficha 360° de un aliado para el drawer del Centro de Control: datos del
// perfil + recaudo + su cartera de contratos (cadena perfil → inmuebles →
// expedientes → contratos). Solo datos reales del esquema; sin invención.

export interface PerfilInmuebleRow {
  id: string;
  codigo: string | null;
  direccion: string | null;
  ciudad: string | null;
  estado: string | null;
}

export interface PerfilContratoRow {
  id: string;
  inmueble: string;
  inquilino: string;
  canon: number;
  estado: string;
  fechaInicio: string | null;
  fechaFin: string | null;
  mes: number;
  pago: 'mora' | 'al_dia';
}

export interface PerfilDetalle {
  id: string;
  rol: string;
  nombre: string;
  nit: string | null;
  documento: string | null;
  telefono: string | null;
  ciudad: string | null;
  direccion: string | null;
  estado: string;
  desde: string;
  representante: string | null;
  matriculaArrendador: string | null;
  recaudo: {
    whatsapp: string | null;
    email: string | null;
    banco: string | null;
    tipoCuenta: string | null;
    numeroCuenta: string | null;
    titularNombre: string | null;
    titularNit: string | null;
  };
  resumen: {
    inmuebles: number;
    contratosActivos: number;
    canonActivo: number;
    moraActiva: number;
  };
  inmuebles: PerfilInmuebleRow[];
  contratos: PerfilContratoRow[];
}

export async function getPerfilDetalle(id: string): Promise<PerfilDetalle> {
  // 1+2) Perfil e inmuebles son consultas independientes (ambas indexadas por
  // id / propietario_id) → se ejecutan en paralelo para evitar un waterfall
  // (regla async-parallel / server-parallel-fetching de Supabase/Vercel).
  const [perfilRes, inmueblesRes] = await Promise.all([
    (supabase.from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select(
        'id, rol, nombre, apellido, razon_social, nit, numero_documento, telefono, ciudad, direccion, ' +
          'direccion_comercial, estado, created_at, nombre_representante, representante_legal, matricula_arrendador, ' +
          'whatsapp_recaudo, email_recaudo, cuenta_recaudo_banco, cuenta_recaudo_tipo, cuenta_recaudo_numero, ' +
          'cuenta_recaudo_titular_nombre, cuenta_recaudo_titular_nit',
      )
      .eq('id', id)
      .single(),
    (supabase.from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .select('id, codigo, direccion, ciudad, estado, created_at')
      .eq('propietario_id', id)
      .order('created_at', { ascending: false }),
  ]);

  if (perfilRes.error) throw fromSupabaseError(perfilRes.error);
  if (!perfilRes.data) throw new AppError(404, 'NOT_FOUND', 'Perfil no encontrado');
  if (inmueblesRes.error) throw fromSupabaseError(inmueblesRes.error);
  const p = perfilRes.data as Record<string, unknown>;
  const inmRows = (inmueblesRes.data ?? []) as Array<Record<string, unknown>>;
  const inmuebleIds = inmRows.map((i) => i.id as string);

  // 3) Expedientes → 4) Contratos (con inmueble e inquilino) de esos inmuebles
  let contratos: PerfilContratoRow[] = [];
  if (inmuebleIds.length > 0) {
    const { data: exps, error: ee } = await supabase
      .from('expedientes')
      .select('id, inmueble_id')
      .in('inmueble_id', inmuebleIds);
    if (ee) throw fromSupabaseError(ee);
    const expedienteIds = ((exps ?? []) as Array<{ id: string }>).map((e) => e.id);

    if (expedienteIds.length > 0) {
      const { data: cont, error: ec } = await (
        supabase.from('contratos' as string) as ReturnType<typeof supabase.from>
      )
        .select(CONTRATO_SELECT)
        .in('expediente_id', expedienteIds)
        .order('created_at', { ascending: false });
      if (ec) throw fromSupabaseError(ec);

      const rows = (cont ?? []) as unknown as ContratoRowDB[];
      const conMora = await fetchContratoIdsConMora(rows.map((r) => r.id));
      const now = new Date();
      contratos = rows.map((r) => {
        const sol = r.expedientes?.solicitantes ?? null;
        const inm = r.expedientes?.inmuebles ?? null;
        return {
          id: r.id,
          inmueble: fmtInmueble(inm),
          inquilino: sol ? `${sol.nombre ?? ''} ${sol.apellido ?? ''}`.trim() || '—' : '—',
          canon: Number(r.valor_arriendo ?? 0),
          estado: r.estado,
          fechaInicio: r.fecha_inicio,
          fechaFin: r.fecha_fin,
          mes: mesesTranscurridos(r.fecha_inicio, now),
          pago: conMora.has(r.id) ? 'mora' : 'al_dia',
        };
      });
    }
  }

  const activos = contratos.filter((c) =>
    (ESTADOS_CONTRATO_ACTIVO as readonly string[]).includes(c.estado),
  );

  const nombre =
    (p.razon_social as string) || `${p.nombre ?? ''} ${p.apellido ?? ''}`.trim() || '—';

  return {
    id: p.id as string,
    rol: p.rol as string,
    nombre,
    nit: (p.nit as string) ?? null,
    documento: (p.numero_documento as string) ?? null,
    telefono: (p.telefono as string) ?? null,
    ciudad: (p.ciudad as string) ?? null,
    direccion: (p.direccion_comercial as string) || (p.direccion as string) || null,
    estado: (p.estado as string) ?? 'activo',
    desde: p.created_at as string,
    representante: (p.representante_legal as string) || (p.nombre_representante as string) || null,
    matriculaArrendador: (p.matricula_arrendador as string) ?? null,
    recaudo: {
      whatsapp: (p.whatsapp_recaudo as string) ?? null,
      email: (p.email_recaudo as string) ?? null,
      banco: (p.cuenta_recaudo_banco as string) ?? null,
      tipoCuenta: (p.cuenta_recaudo_tipo as string) ?? null,
      numeroCuenta: (p.cuenta_recaudo_numero as string) ?? null,
      titularNombre: (p.cuenta_recaudo_titular_nombre as string) ?? null,
      titularNit: (p.cuenta_recaudo_titular_nit as string) ?? null,
    },
    resumen: {
      inmuebles: inmRows.length,
      contratosActivos: activos.length,
      canonActivo: activos.reduce((s, c) => s + c.canon, 0),
      moraActiva: activos.filter((c) => c.pago === 'mora').length,
    },
    inmuebles: inmRows.map((i) => ({
      id: i.id as string,
      codigo: (i.codigo as string) ?? null,
      direccion: (i.direccion as string) ?? null,
      ciudad: (i.ciudad as string) ?? null,
      estado: (i.estado as string) ?? null,
    })),
    contratos,
  };
}

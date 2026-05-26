// ============================================================
// Módulo Moras — flujo de 3 fases con notificación WhatsApp.
// Mario 12-may-2026, mockup 13_*propietario.html.
//
//   fase_1 (Recordatorio)  →   reportado_at
//   fase_2 (Urgencia)      →   reportado_at + 4 días (auto o manual)
//   fase_3 (Legal)         →   reportado_at + 10 días (auto o manual)
//   pagada / cancelada     →   estados terminales
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { enviarTemplate as enviarTemplateWhatsApp } from '../whatsapp';
import type {
  ReportarMoraInput,
  ListMorasQuery,
  EscalarMoraInput,
  MarcarPagadaInput,
  CancelarMoraInput,
  AgregarMensajeInput,
} from './moras.schema';

const db = (table: string) =>
  supabase.from(table as string) as ReturnType<typeof supabase.from>;

const ESTADOS_ACTIVOS = ['fase_1', 'fase_2', 'fase_3'] as const;
type MoraEstado = 'fase_1' | 'fase_2' | 'fase_3' | 'pagada' | 'cancelada';

// ============================================================
// Helpers
// ============================================================

function diasDesde(date: string | Date): number {
  const start = new Date(date).getTime();
  return Math.floor((Date.now() - start) / (1000 * 60 * 60 * 24));
}

function formatCOP(monto: number): string {
  return new Intl.NumberFormat('es-CO').format(monto);
}

interface ContratoSnapshot {
  contrato_id: string;
  expediente_id: string | null;
  solicitante_id: string | null;
  inquilino_nombre: string;
  inquilino_telefono: string | null;
  inquilino_email: string | null;
  inmueble_codigo: string | null;
  inmueble_direccion: string | null;
  inmueble_propietario_id: string;
}

/**
 * Construye un snapshot del contrato — usado al reportar la mora para
 * que el ticket sobreviva aunque luego se modifique el contrato.
 */
async function snapshotContrato(contratoId: string): Promise<ContratoSnapshot> {
  const { data: contrato, error: contratoError } = (await db('contratos')
    .select('id, expediente_id, estado')
    .eq('id', contratoId)
    .single()) as {
      data: { id: string; expediente_id: string | null; estado: string } | null;
      error: { message: string } | null;
    };

  if (contratoError || !contrato) {
    throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
  }
  if (contrato.estado !== 'firmado' && contrato.estado !== 'vigente') {
    throw AppError.badRequest(
      'Solo se puede reportar mora sobre contratos firmados o vigentes',
      'CONTRATO_ESTADO_INVALIDO',
    );
  }

  if (!contrato.expediente_id) {
    throw AppError.badRequest('Contrato sin expediente vinculado', 'EXPEDIENTE_FALTANTE');
  }

  const { data: expediente, error: expError } = (await db('expedientes')
    .select('id, solicitante_id, inmueble_id')
    .eq('id', contrato.expediente_id)
    .single()) as {
      data: { id: string; solicitante_id: string | null; inmueble_id: string } | null;
      error: { message: string } | null;
    };

  if (expError || !expediente) {
    throw AppError.notFound('Expediente del contrato no encontrado');
  }

  let inquilino_nombre = 'Inquilino';
  let inquilino_telefono: string | null = null;
  let inquilino_email: string | null = null;
  if (expediente.solicitante_id) {
    const { data: sol } = (await db('solicitantes')
      .select('nombre, apellido, email, telefono')
      .eq('id', expediente.solicitante_id)
      .single()) as {
        data: { nombre: string; apellido: string; email: string; telefono: string | null } | null;
      };
    if (sol) {
      inquilino_nombre = `${sol.nombre} ${sol.apellido}`.trim();
      inquilino_telefono = sol.telefono;
      inquilino_email = sol.email;
    }
  }

  const { data: inmueble } = (await db('inmuebles')
    .select('codigo, direccion, propietario_id')
    .eq('id', expediente.inmueble_id)
    .single()) as {
      data: { codigo: string | null; direccion: string | null; propietario_id: string } | null;
    };

  if (!inmueble) {
    throw AppError.notFound('Inmueble del contrato no encontrado');
  }

  return {
    contrato_id: contrato.id,
    expediente_id: expediente.id,
    solicitante_id: expediente.solicitante_id,
    inquilino_nombre,
    inquilino_telefono,
    inquilino_email,
    inmueble_codigo: inmueble.codigo,
    inmueble_direccion: inmueble.direccion,
    inmueble_propietario_id: inmueble.propietario_id,
  };
}

/**
 * Verifica que el usuario tenga acceso a la mora — propietario dueño del
 * inmueble, admin u operador. La inmobiliaria también pasa cuando es
 * dueña del perfil del propietario (caso futuro), por ahora solo dueño.
 */
interface MoraAccessRow {
  id: string;
  estado: MoraEstado;
  reportado_por: string;
  reportado_at: string;
  inquilino_telefono: string | null;
  inquilino_nombre: string;
  inmueble_direccion: string | null;
  monto_mora: number;
}

async function assertMoraAccess(
  moraId: string,
  userId: string,
  rol: string,
): Promise<MoraAccessRow> {
  const { data: mora, error } = (await db('moras_tickets')
    .select(`
      id, estado, reportado_por, reportado_at,
      inquilino_telefono, inquilino_nombre, inmueble_direccion, monto_mora
    `)
    .eq('id', moraId)
    .single()) as { data: MoraAccessRow | null; error: { message: string } | null };

  if (error || !mora) throw AppError.notFound('Mora no encontrada', 'MORA_NOT_FOUND');

  if (rol === 'administrador' || rol === 'operador_analista') {
    return mora;
  }
  if (mora.reportado_por !== userId) {
    throw AppError.forbidden('No tienes acceso a esta mora', 'MORA_FORBIDDEN');
  }
  return mora;
}

// ============================================================
// Crear ticket de mora
// ============================================================

export async function reportarMora(input: ReportarMoraInput, userId: string) {
  const snap = await snapshotContrato(input.contrato_id);

  // Insertar el ticket — ticket_numero lo genera el DEFAULT en SQL
  const { data: inserted, error } = await db('moras_tickets')
    .insert({
      contrato_id: snap.contrato_id,
      expediente_id: snap.expediente_id,
      solicitante_id: snap.solicitante_id,
      inquilino_nombre: snap.inquilino_nombre,
      inquilino_telefono: snap.inquilino_telefono,
      inquilino_email: snap.inquilino_email,
      inmueble_codigo: snap.inmueble_codigo,
      inmueble_direccion: snap.inmueble_direccion,
      monto_mora: input.monto_mora,
      fecha_vencimiento_canon: input.fecha_vencimiento_canon,
      descripcion: input.descripcion ?? null,
      estado: 'fase_1',
      reportado_por: userId,
    } as never)
    .select(
      `id, ticket_numero, estado, reportado_at, inquilino_nombre, inquilino_telefono,
       inmueble_direccion, monto_mora`,
    )
    .single();

  if (error || !inserted) {
    logger.error({ error: error?.message, contratoId: input.contrato_id }, 'Error al reportar mora');
    throw fromSupabaseError(error ?? new Error('Error al crear el ticket de mora'));
  }

  const ticket = inserted as unknown as {
    id: string;
    ticket_numero: string;
    inquilino_telefono: string | null;
    inquilino_nombre: string;
    inmueble_direccion: string | null;
    monto_mora: number;
  };

  // Mensaje sistema en el chat
  await agregarMensajeInterno(
    ticket.id,
    'sistema',
    null,
    `Mora reportada — Fase 1 (Recordatorio). Se notifica al inquilino vía WhatsApp.`,
  );

  // WhatsApp Fase 1 al inquilino (fire-and-forget)
  await enviarTemplateWhatsApp({
    to: ticket.inquilino_telefono,
    template: 'MORA_FASE_1',
    variables: [
      ticket.inquilino_nombre.split(' ')[0] || 'Hola',
      ticket.inmueble_direccion ?? 'tu inmueble',
      formatCOP(ticket.monto_mora),
      new Date(input.fecha_vencimiento_canon).toLocaleDateString('es-CO', {
        day: '2-digit', month: 'short', year: 'numeric',
      }),
    ],
    context: { mora_id: ticket.id },
  });

  logger.info({ moraId: ticket.id, ticket: ticket.ticket_numero }, 'Ticket de mora creado');

  return getMoraById(ticket.id);
}

// ============================================================
// Listar
// ============================================================

export async function listMoras(query: ListMorasQuery, userId: string, rol: string) {
  const offset = (query.page - 1) * query.limit;

  let qb = db('moras_tickets')
    .select('*', { count: 'exact' })
    .order('reportado_at', { ascending: false });

  if (query.estado && query.estado !== 'todas') {
    qb = qb.eq('estado', query.estado);
  }
  if (query.contrato_id) {
    qb = qb.eq('contrato_id', query.contrato_id);
  }
  // Propietario/inmobiliaria solo ven las propias (las que reportaron).
  if (rol !== 'administrador' && rol !== 'operador_analista') {
    qb = qb.eq('reportado_por', userId);
  }

  const { data, error, count } = await qb.range(offset, offset + query.limit - 1);

  if (error) throw fromSupabaseError(error);

  return {
    data: (data ?? []) as unknown[],
    pagination: {
      page: query.page,
      limit: query.limit,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / query.limit),
    },
  };
}

// ============================================================
// Detalle + mensajes
// ============================================================

export async function getMoraById(id: string) {
  const { data: mora, error } = await db('moras_tickets')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !mora) throw AppError.notFound('Mora no encontrada', 'MORA_NOT_FOUND');

  const { data: mensajes } = await db('moras_mensajes')
    .select('*')
    .eq('mora_id', id)
    .order('created_at', { ascending: true });

  return { ...(mora as object), mensajes: mensajes ?? [] };
}

// ============================================================
// Escalar manualmente
// ============================================================

export async function escalarMora(id: string, input: EscalarMoraInput, userId: string, rol: string) {
  const mora = await assertMoraAccess(id, userId, rol);

  let proximoEstado: MoraEstado;
  let templateKey: 'MORA_FASE_2' | 'MORA_FASE_3';
  const updates: Record<string, unknown> = {};

  if (mora.estado === 'fase_1') {
    proximoEstado = 'fase_2';
    templateKey = 'MORA_FASE_2';
    updates.fase_2_at = new Date().toISOString();
  } else if (mora.estado === 'fase_2') {
    proximoEstado = 'fase_3';
    templateKey = 'MORA_FASE_3';
    updates.fase_3_at = new Date().toISOString();
  } else {
    throw AppError.badRequest(
      `No se puede escalar una mora en estado ${mora.estado}`,
      'MORA_ESTADO_INVALIDO',
    );
  }
  updates.estado = proximoEstado;

  const { error } = await db('moras_tickets').update(updates as never).eq('id', id);
  if (error) throw fromSupabaseError(error);

  await agregarMensajeInterno(
    id,
    'sistema',
    null,
    `Escalado a ${proximoEstado === 'fase_2' ? 'Fase 2 (Urgencia)' : 'Fase 3 (Legal)'}${
      input.notas ? `. Notas del asesor: ${input.notas}` : ''
    }`,
  );

  const diasMora = String(diasDesde(mora.reportado_at));
  await enviarTemplateWhatsApp({
    to: mora.inquilino_telefono,
    template: templateKey,
    variables: [
      mora.inquilino_nombre.split(' ')[0] || 'Hola',
      mora.inmueble_direccion ?? 'tu inmueble',
      formatCOP(mora.monto_mora),
      diasMora,
    ],
    context: { mora_id: id },
  });

  return getMoraById(id);
}

// ============================================================
// Marcar pagada
// ============================================================

export async function marcarPagada(id: string, input: MarcarPagadaInput, userId: string, rol: string) {
  const mora = await assertMoraAccess(id, userId, rol);

  if (!(ESTADOS_ACTIVOS as readonly string[]).includes(mora.estado)) {
    throw AppError.badRequest(
      `La mora ya está en estado terminal: ${mora.estado}`,
      'MORA_ESTADO_INVALIDO',
    );
  }

  const { error } = await db('moras_tickets')
    .update({
      estado: 'pagada',
      pagada_at: input.fecha_pago
        ? new Date(`${input.fecha_pago}T00:00:00`).toISOString()
        : new Date().toISOString(),
    } as never)
    .eq('id', id);

  if (error) throw fromSupabaseError(error);

  await agregarMensajeInterno(
    id,
    'sistema',
    null,
    `Mora marcada como pagada${input.notas ? `. Notas: ${input.notas}` : ''}`,
  );

  return getMoraById(id);
}

// ============================================================
// Cancelar
// ============================================================

export async function cancelarMora(id: string, input: CancelarMoraInput, userId: string, rol: string) {
  const mora = await assertMoraAccess(id, userId, rol);

  if (!(ESTADOS_ACTIVOS as readonly string[]).includes(mora.estado)) {
    throw AppError.badRequest(
      `La mora ya está en estado terminal: ${mora.estado}`,
      'MORA_ESTADO_INVALIDO',
    );
  }

  const { error } = await db('moras_tickets')
    .update({
      estado: 'cancelada',
      cancelada_at: new Date().toISOString(),
      cancelado_motivo: input.motivo,
    } as never)
    .eq('id', id);

  if (error) throw fromSupabaseError(error);

  await agregarMensajeInterno(id, 'sistema', null, `Mora cancelada. Motivo: ${input.motivo}`);

  return getMoraById(id);
}

// ============================================================
// Mensaje (asesor / propietario)
// ============================================================

export async function agregarMensaje(
  moraId: string,
  input: AgregarMensajeInput,
  userId: string,
  rol: string,
) {
  const mora = await assertMoraAccess(moraId, userId, rol);

  const autorTipo: 'asesor' | 'propietario' =
    rol === 'administrador' || rol === 'operador_analista' ? 'asesor' : 'propietario';

  const { data, error } = await db('moras_mensajes')
    .insert({
      mora_id: moraId,
      autor_tipo: autorTipo,
      autor_id: userId,
      mensaje: input.mensaje,
      via_whatsapp: input.via_whatsapp ?? false,
    } as never)
    .select('*')
    .single();

  if (error) throw fromSupabaseError(error);

  // Si el usuario marcó "via WhatsApp", reenvía el mismo texto al inquilino
  // usando una conversación libre (TODO en Meta: requiere ventana de 24h).
  if (input.via_whatsapp && mora.inquilino_telefono) {
    logger.info(
      { moraId, telefono: mora.inquilino_telefono },
      '[Moras] Mensaje de asesor a inquilino vía WhatsApp pendiente — usar conversación abierta cuando Meta esté integrado',
    );
  }

  return data;
}

async function agregarMensajeInterno(
  moraId: string,
  autorTipo: 'sistema' | 'asesor' | 'inquilino' | 'propietario',
  autorId: string | null,
  mensaje: string,
): Promise<void> {
  const { error } = await db('moras_mensajes').insert({
    mora_id: moraId,
    autor_tipo: autorTipo,
    autor_id: autorId,
    mensaje,
  } as never);
  if (error) {
    logger.warn({ error: error.message, moraId }, 'Error al insertar mensaje sistema en mora');
  }
}

// ============================================================
// Cron auto-escalado: Fase 1 → 2 (+4d), Fase 2 → 3 (+10d)
// ============================================================

const DIAS_FASE_2 = 4;
const DIAS_FASE_3 = 10;

export async function autoEscalar(): Promise<{ aFase2: number; aFase3: number }> {
  const ahora = new Date();
  const limiteFase2 = new Date(ahora.getTime() - DIAS_FASE_2 * 24 * 60 * 60 * 1000).toISOString();
  const limiteFase3 = new Date(ahora.getTime() - DIAS_FASE_3 * 24 * 60 * 60 * 1000).toISOString();

  // Fase 1 → 2 (lleva al menos 4 días en fase_1)
  const { data: aSubirF2 } = await db('moras_tickets')
    .select('id, inquilino_telefono, inquilino_nombre, inmueble_direccion, monto_mora, reportado_at')
    .eq('estado', 'fase_1')
    .lte('reportado_at', limiteFase2)
    .limit(100) as unknown as {
      data: Array<{
        id: string;
        inquilino_telefono: string | null;
        inquilino_nombre: string;
        inmueble_direccion: string | null;
        monto_mora: number;
        reportado_at: string;
      }> | null;
    };

  let aFase2 = 0;
  for (const m of aSubirF2 ?? []) {
    await db('moras_tickets')
      .update({ estado: 'fase_2', fase_2_at: ahora.toISOString() } as never)
      .eq('id', m.id);
    await agregarMensajeInterno(
      m.id,
      'sistema',
      null,
      'Escalado automático a Fase 2 (Urgencia) — 4 días sin pago.',
    );
    await enviarTemplateWhatsApp({
      to: m.inquilino_telefono,
      template: 'MORA_FASE_2',
      variables: [
        m.inquilino_nombre.split(' ')[0] || 'Hola',
        m.inmueble_direccion ?? 'tu inmueble',
        formatCOP(m.monto_mora),
        String(diasDesde(m.reportado_at)),
      ],
      context: { mora_id: m.id },
    });
    aFase2++;
  }

  // Fase 2 → 3 (lleva al menos 10 días totales desde reportado, lo que
  // significa ~6 días en fase_2 después del primer escalado).
  const { data: aSubirF3 } = await db('moras_tickets')
    .select('id, inquilino_telefono, inquilino_nombre, inmueble_direccion, monto_mora, reportado_at')
    .eq('estado', 'fase_2')
    .lte('reportado_at', limiteFase3)
    .limit(100) as unknown as {
      data: Array<{
        id: string;
        inquilino_telefono: string | null;
        inquilino_nombre: string;
        inmueble_direccion: string | null;
        monto_mora: number;
        reportado_at: string;
      }> | null;
    };

  let aFase3 = 0;
  for (const m of aSubirF3 ?? []) {
    await db('moras_tickets')
      .update({ estado: 'fase_3', fase_3_at: ahora.toISOString() } as never)
      .eq('id', m.id);
    await agregarMensajeInterno(
      m.id,
      'sistema',
      null,
      'Escalado automático a Fase 3 (Legal) — 10 días sin pago. Cofianza toma control.',
    );
    await enviarTemplateWhatsApp({
      to: m.inquilino_telefono,
      template: 'MORA_FASE_3',
      variables: [
        m.inquilino_nombre.split(' ')[0] || 'Hola',
        m.inmueble_direccion ?? 'tu inmueble',
        formatCOP(m.monto_mora),
        String(diasDesde(m.reportado_at)),
      ],
      context: { mora_id: m.id },
    });
    aFase3++;
  }

  logger.info({ aFase2, aFase3 }, 'Auto-escalado de moras ejecutado');
  return { aFase2, aFase3 };
}

// ============================================================
// Stats (KPI cards en la pestaña Reportar Mora)
// ============================================================

export interface MorasStats {
  reportadas_mes: number;
  resueltas: number;
  en_gestion: number;
  monto_total: number;
}

export async function getStats(userId: string, rol: string): Promise<MorasStats> {
  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);
  const isoMes = inicioMes.toISOString();

  let qb = db('moras_tickets').select('estado, monto_mora, reportado_at, reportado_por');
  if (rol !== 'administrador' && rol !== 'operador_analista') {
    qb = qb.eq('reportado_por', userId);
  }
  const { data, error } = await qb;
  if (error) throw fromSupabaseError(error);

  let reportadas_mes = 0;
  let resueltas = 0;
  let en_gestion = 0;
  let monto_total = 0;

  for (const row of (data ?? []) as Array<{
    estado: MoraEstado;
    monto_mora: number;
    reportado_at: string;
  }>) {
    if (row.reportado_at >= isoMes) reportadas_mes++;
    if (row.estado === 'pagada') resueltas++;
    if ((ESTADOS_ACTIVOS as readonly string[]).includes(row.estado)) {
      en_gestion++;
      monto_total += row.monto_mora;
    }
  }

  return { reportadas_mes, resueltas, en_gestion, monto_total };
}

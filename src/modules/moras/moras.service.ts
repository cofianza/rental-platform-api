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
import { env } from '@/config';
import { getCompany } from '@/lib/companyConfig';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { fetchAll } from '@/lib/fetchAll';
import { logger } from '@/lib/logger';
import { enviarTemplate as enviarTemplateWhatsApp, type EstadoEnvioWhatsApp, type WhatsappTemplateKey } from '../whatsapp';
import {
  assertExpedienteAccess,
  resolveAllowedExpedienteIds,
  resolveContactoDueno,
  resolvePerfilCanonicoDeInmueble,
} from '@/lib/tenantScope';
import { notificarUsuario } from '@/modules/notificaciones/notificaciones.service';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { diaBogota, momentoDeCobro } from './horario-cobranza';
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

/** Cofianza (administrador u operador); el resto es el dueño del inmueble. */
const esInterno = (rol: string) => rol === 'administrador' || rol === 'operador_analista';

// P27: en Fase 3 el caso es de Cofianza (CUARTA, Parágrafos Quinto y Sexto).
const casoDeCofianza = () =>
  AppError.forbidden(
    'El caso ya lo gestiona Cofianza. Si el inquilino te pagó, anótalo en el historial del caso.',
    'MORA_EN_FASE_3',
  );

/** Días en mora del canon (desde su vencimiento, en hora de Colombia), no desde el reporte. */
function diasEnMora(fechaVencimientoCanon: string): string {
  return String(Math.max(0, diasDesde(`${fechaVencimientoCanon}T00:00:00-05:00`)));
}

function formatCOP(monto: number): string {
  return new Intl.NumberFormat('es-CO').format(monto);
}

/**
 * Lo que pasó con el WhatsApp de cobro: lo que respondió el envío, o que quedó
 * para el horario permitido ('programado'; 'retenido' si el envío automático
 * está apagado y nada lo va a mandar solo).
 */
interface ResultadoCobro {
  estado: EstadoEnvioWhatsApp | 'programado' | 'retenido';
  programado_para?: string;
}

const fechaHoraBogota = (iso: string) =>
  new Date(iso).toLocaleString('es-CO', {
    timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
  });

// Lo que queda en el chat según lo que pasó con el WhatsApp: antes decía «se
// notifica al inquilino» aunque no tuviera teléfono o Meta rechazara el envío.
function avisoWhatsApp(r: ResultadoCobro): string {
  if (r.estado === 'programado') {
    return `El WhatsApp al inquilino sale el ${fechaHoraBogota(r.programado_para!)}: fuera del horario de cobranza o ya tuvo una gestión hoy (Ley 2300 de 2023).`;
  }
  if (r.estado === 'retenido') {
    return 'El WhatsApp al inquilino quedó en espera por el horario de cobranza (Ley 2300 de 2023), pero el envío automático está apagado: no sale hasta que lo enciendan. Si es urgente, avísale por otro medio dentro del horario.';
  }
  if (r.estado === 'aceptado') return 'Se envió el WhatsApp al inquilino.';
  if (r.estado === 'sin_telefono') return 'No se pudo avisar por WhatsApp: el inquilino no tiene teléfono registrado.';
  if (r.estado === 'mock') return 'WhatsApp en modo de prueba: no se envió al inquilino.';
  return 'El WhatsApp al inquilino falló; avísale por otro medio.';
}

/** El WhatsApp de cobro salió de verdad (así queda marcado en el historial). */
const salioPorWhatsApp = (r: ResultadoCobro) => r.estado === 'aceptado' || r.estado === 'mock';

/**
 * Aviso in-app al equipo de Cofianza (administrador + operador_analista). El
 * botón dice «Reportar a Cofianza» y la Fase 3 le promete al inquilino contacto
 * «en las próximas horas», pero nadie de Cofianza se enteraba si no abría
 * /moras. Quien hizo la acción no se avisa a sí mismo. Best-effort: nunca lanza.
 */
async function avisarCofianza(params: {
  moraId: string;
  actorId: string | null;
  tipo: string;
  titulo: string;
  mensaje: string;
}): Promise<void> {
  try {
    const { listOperators } = await import('@/modules/users/users.service');
    const internos = await listOperators().catch(() => []);
    await Promise.all(
      internos
        .filter((o) => o.id !== params.actorId)
        .map((o) =>
          notificarUsuario({
            userId: o.id,
            tipo: params.tipo,
            titulo: params.titulo,
            mensaje: params.mensaje,
            link: '/moras',
            payload: { mora_id: params.moraId },
          }),
        ),
    );
  } catch (err) {
    logger.warn({ err, moraId: params.moraId }, 'No se pudo avisar a Cofianza de la mora');
  }
}

/** Texto del aviso de Fase 3 al equipo: el inquilino ya espera la llamada. */
function mensajeFase3(m: { inquilino_nombre: string; inmueble_direccion: string | null; monto_mora: number }, aviso: string) {
  return `${m.inquilino_nombre} · ${m.inmueble_direccion ?? 'inmueble'} · $${formatCOP(m.monto_mora)}. Cofianza asume el cobro y el inquilino espera contacto en las próximas horas. ${aviso}`;
}

// ============================================================
// WhatsApp de cobro (Ley 2300 de 2023): fuera de la franja, o si el deudor ya
// tuvo una gestión hoy, queda en moras_tickets.whatsapp_programado_para y lo
// manda su propio barrido (enviarCobrosProgramados, MORAS_COBROS_PROGRAMADOS_ENABLED),
// sin perderse. La gestión del día se toma ANTES de enviar, en
// moras_gestiones_diarias (llave única teléfono + día).
// ============================================================

type FaseActiva = 'fase_1' | 'fase_2' | 'fase_3';

const NOMBRE_FASE: Record<FaseActiva, string> = {
  fase_1: 'Fase 1 (Recordatorio)',
  fase_2: 'Fase 2 (Urgencia)',
  fase_3: 'Fase 3 (Legal)',
};

interface MoraCobro {
  id: string;
  estado: FaseActiva;
  expediente_id: string | null;
  inquilino_telefono: string | null;
  inquilino_nombre: string;
  inmueble_direccion: string | null;
  monto_mora: number;
  fecha_vencimiento_canon: string;
}

/** El arrendador de la mora (quien recibe el canon): su nombre y su WhatsApp de recaudo. */
async function arrendadorDeMora(expedienteId: string | null) {
  if (!expedienteId) return null;
  const { data } = await db('expedientes')
    .select('inmuebles!expedientes_inmueble_id_fkey(propietario_id, inmobiliaria_id)')
    .eq('id', expedienteId)
    .maybeSingle();
  const inm = (data as { inmuebles: { propietario_id: string; inmobiliaria_id: string | null } | null } | null)?.inmuebles;
  return inm ? resolveContactoDueno(await resolvePerfilCanonicoDeInmueble(inm)) : null;
}

/** El WhatsApp de la fase en que está la mora. La 4.ª variable es el vencimiento en Fase 1 y los días en mora después. */
async function enviarCobro(m: MoraCobro): Promise<EstadoEnvioWhatsApp> {
  let template: WhatsappTemplateKey = m.estado === 'fase_1' ? 'MORA_FASE_1' : m.estado === 'fase_2' ? 'MORA_FASE_2' : 'MORA_FASE_3';
  const variables = [
    m.inquilino_nombre.split(' ')[0] || 'Hola',
    m.inmueble_direccion ?? 'tu inmueble',
    formatCOP(m.monto_mora),
    m.estado === 'fase_1'
      // La fecha llega sin hora (medianoche UTC): formatearla en UTC evita que
      // un servidor con otra zona la corra un día.
      ? new Date(m.fecha_vencimiento_canon).toLocaleDateString('es-CO', {
          day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
        })
      : diasEnMora(m.fecha_vencimiento_canon),
  ];
  // P28: la v1 pide el comprobante «por aquí», un número que nadie lee. La v2
  // lo manda al arrendador por su WhatsApp de recaudo y, en Fase 3, al correo
  // de soporte de Cofianza. Sin WhatsApp del arrendador se queda en la v1.
  if (env.WHATSAPP_MORA_PLANTILLAS_V2) {
    if (m.estado === 'fase_3') {
      template = 'MORA_FASE_3_V2';
      variables.push((await getCompany()).email);
    } else {
      // Sin número del arrendador, al correo de soporte; nunca «por aquí».
      const arrendador = await arrendadorDeMora(m.expediente_id);
      template = m.estado === 'fase_1' ? 'MORA_FASE_1_V2' : 'MORA_FASE_2_V2';
      variables.push(
        ...(arrendador?.whatsapp
          ? [arrendador.nombre ?? 'tu arrendador', `WhatsApp ${arrendador.whatsapp}`]
          : ['Cofianza', `correo ${(await getCompany()).email}`]),
      );
    }
  }
  return enviarTemplateWhatsApp({ to: m.inquilino_telefono, template, variables, context: { mora_id: m.id } });
}

/** Solo dígitos y con indicativo: «300 111 2233», «+57 300 1112233» y «573001112233» son el mismo deudor. */
function telefonoDeudor(telefono: string): string {
  const digitos = telefono.replace(/\D/g, '');
  return digitos.length === 10 ? `57${digitos}` : digitos;
}

// Sin la migración 20261001000007 no existen la columna ni la tabla del
// horario de cobranza; así lo dicen PostgREST y Postgres.
const faltaEnLaBase = (e: { code?: string } | null) =>
  !!e && ['PGRST204', 'PGRST205', '42703', '42P01'].includes(e.code ?? '');

/**
 * Toma la gestión del día del deudor ANTES de enviar: la llave única
 * (teléfono, día) hace que entre el barrido y un escalado a mano solo uno
 * escriba ese día. 'usada' = ya hubo una hoy.
 */
async function tomarGestionDelDia(
  telefono: string,
  moraId: string,
  ahora: Date,
): Promise<'libre' | 'usada' | 'sin_tabla' | 'error'> {
  const { error } = await db('moras_gestiones_diarias').insert({
    telefono: telefonoDeudor(telefono),
    dia: diaBogota(ahora),
    mora_id: moraId,
  } as never);
  if (!error) return 'libre';
  if (error.code === '23505') return 'usada';
  if (faltaEnLaBase(error)) return 'sin_tabla';
  logger.error({ error: error.message, moraId }, 'No se pudo tomar la gestión de cobranza del día');
  return 'error';
}

/**
 * WhatsApp de cobro de la fase actual: sale ya si cae en la franja y el deudor
 * no tuvo otra gestión hoy; si no, queda programado. Nunca lanza.
 */
async function cobrarPorWhatsApp(m: MoraCobro, ahora = new Date()): Promise<ResultadoCobro> {
  // Sin teléfono no hay a quién escribirle: enviarCobro devuelve 'sin_telefono'.
  if (!m.inquilino_telefono) return { estado: await enviarCobro(m) };

  let cuando = momentoDeCobro(ahora, null);
  if (cuando <= ahora) {
    const gestion = await tomarGestionDelDia(m.inquilino_telefono, m.id, ahora);
    if (gestion === 'error') return { estado: 'fallido' };
    if (gestion !== 'usada') {
      // Sale ya: se descarta lo que hubiera programado de una fase anterior.
      await db('moras_tickets').update({ whatsapp_programado_para: null } as never).eq('id', m.id);
      return { estado: await enviarCobro(m) };
    }
    cuando = momentoDeCobro(ahora, ahora); // ya tuvo su gestión hoy: mañana
  }

  const programado_para = cuando.toISOString();
  const { error } = await db('moras_tickets')
    .update({ whatsapp_programado_para: programado_para } as never)
    .eq('id', m.id);
  if (faltaEnLaBase(error)) {
    // Sin la migración no hay cola: sale ya, como antes. Solo en ese caso; un
    // error de red no puede mandar un cobro de noche.
    logger.warn({ moraId: m.id }, 'Sin la migración 20261001000007: el WhatsApp de cobro sale fuera del horario');
    return { estado: await enviarCobro(m) };
  }
  if (error) {
    logger.error({ error: error.message, moraId: m.id }, 'No se pudo programar el WhatsApp de cobro');
    return { estado: 'fallido' };
  }
  return { estado: env.MORAS_COBROS_PROGRAMADOS_ENABLED ? 'programado' : 'retenido', programado_para };
}

/**
 * Barrido de la Ley 2300: manda los WhatsApp de cobro programados que ya pueden
 * salir, con la plantilla de la fase en que esté hoy la mora. Va aparte del
 * autoescalado: apagar el escalado no apaga esta cola.
 */
export async function enviarCobrosProgramados(ahora = new Date()): Promise<number> {
  const { data, error } = await db('moras_tickets')
    .select(
      'id, ticket_numero, estado, expediente_id, whatsapp_programado_para, inquilino_telefono, inquilino_nombre, inmueble_direccion, monto_mora, fecha_vencimiento_canon',
    )
    .in('estado', ESTADOS_ACTIVOS as unknown as string[])
    .lte('whatsapp_programado_para', ahora.toISOString())
    .is('whatsapp_pausado_at', null)
    .limit(100);
  if (error) {
    logger.warn({ error: error.message }, 'No se pudieron leer los WhatsApp de cobro programados');
    return 0;
  }

  let enviados = 0;
  for (const m of (data ?? []) as Array<MoraCobro & { ticket_numero: string; whatsapp_programado_para: string }>) {
    // Tomar la fila, condicionado a lo leído: dos corridas a la vez no la mandan dos veces.
    const { data: tomada } = await db('moras_tickets')
      .update({ whatsapp_programado_para: null } as never)
      .eq('id', m.id)
      .eq('estado', m.estado)
      .eq('whatsapp_programado_para', m.whatsapp_programado_para)
      .is('whatsapp_pausado_at', null)
      .select('id');
    if (!tomada?.length) continue;
    // Horario y gestión del día otra vez: si no puede salir, vuelve a quedar programado.
    const cobro = await cobrarPorWhatsApp(m, ahora);
    if (cobro.estado === 'programado' || cobro.estado === 'retenido') continue;
    await agregarMensajeInterno(
      m.id,
      'sistema',
      null,
      `WhatsApp programado de ${NOMBRE_FASE[m.estado]}: ${avisoWhatsApp(cobro)}`,
      salioPorWhatsApp(cobro),
    );
    if (salioPorWhatsApp(cobro)) {
      enviados++;
      continue;
    }
    // No salió: que Cofianza lo sepa, el caso no puede quedar esperando en silencio.
    await avisarCofianza({
      moraId: m.id,
      actorId: null,
      tipo: 'mora.whatsapp_fallido',
      titulo: `No salió el WhatsApp de cobro — ${m.ticket_numero}`,
      mensaje: `${m.inquilino_nombre} · ${m.inmueble_direccion ?? 'inmueble'}. ${avisoWhatsApp(cobro)}`,
    });
  }
  return enviados;
}

interface ContratoSnapshot {
  contrato_id: string;
  expediente_id: string;
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
    throw AppError.badRequest('Contrato sin estudio vinculado', 'EXPEDIENTE_FALTANTE');
  }

  const { data: expediente, error: expError } = (await db('expedientes')
    .select('id, solicitante_id, inmueble_id')
    .eq('id', contrato.expediente_id)
    .single()) as {
      data: { id: string; solicitante_id: string | null; inmueble_id: string } | null;
      error: { message: string } | null;
    };

  if (expError || !expediente) {
    throw AppError.notFound('Estudio del contrato no encontrado');
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
  ticket_numero: string;
  estado: MoraEstado;
  expediente_id: string | null;
  reportado_por: string;
  reportado_at: string;
  fecha_vencimiento_canon: string;
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
      id, ticket_numero, estado, expediente_id, reportado_por, reportado_at, fecha_vencimiento_canon,
      inquilino_telefono, inquilino_nombre, inmueble_direccion, monto_mora
    `)
    .eq('id', moraId)
    .single()) as { data: MoraAccessRow | null; error: { message: string } | null };

  if (error || !mora) throw AppError.notFound('Mora no encontrada', 'MORA_NOT_FOUND');

  if (rol === 'administrador' || rol === 'operador_analista') {
    return mora;
  }
  // La mora es del estudio, no de quien la reportó: la ve y la gestiona quien ve
  // el estudio (el equipo de la inmobiliaria, según su alcance). Así un miembro
  // que sale del equipo deja de verla y el equipo no pierde las que él reportó.
  if (!mora.expediente_id) throw AppError.notFound('Mora no encontrada', 'MORA_NOT_FOUND');
  await assertExpedienteAccess(mora.expediente_id, userId, rol);
  return mora;
}

/** Detalle con su hilo, solo para quien ve el estudio de la mora (antes cualquiera por UUID). */
export async function obtenerMora(id: string, userId: string, rol: string) {
  await assertMoraAccess(id, userId, rol);
  return getMoraById(id);
}


// ============================================================
// Crear ticket de mora
// ============================================================

function moraDuplicada(ticket?: string) {
  return AppError.conflict(
    `Ya hay una mora activa para este canon${ticket ? ` (${ticket})` : ''}. Gestiónala desde la lista.`,
    'MORA_DUPLICADA',
  );
}

export async function reportarMora(input: ReportarMoraInput, userId: string, rol: string) {
  const snap = await snapshotContrato(input.contrato_id);
  // Solo sobre contratos de la cartera propia: sin esto se reportaba (y se le
  // escribía por WhatsApp al inquilino) sobre el contrato de otra agencia por UUID.
  await assertExpedienteAccess(snap.expediente_id, userId, rol);

  // Un canon, una mora activa: dos reportes del mismo canon (dos miembros, el
  // dueño y el operador) mandaban dos cobros al inquilino e inflaban los KPI.
  // El índice único parcial (migración 20260929000027) cubre el doble envío.
  const { data: yaActiva } = (await db('moras_tickets')
    .select('ticket_numero')
    .eq('contrato_id', snap.contrato_id)
    .eq('fecha_vencimiento_canon', input.fecha_vencimiento_canon)
    .in('estado', ESTADOS_ACTIVOS as unknown as string[])
    .limit(1)
    .maybeSingle()) as { data: { ticket_numero: string } | null };
  if (yaActiva) throw moraDuplicada(yaActiva.ticket_numero);

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

  if (error?.code === '23505') throw moraDuplicada();
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

  // WhatsApp Fase 1 al inquilino, ya o en el horario de cobranza (nunca lanza),
  // y según cómo salió, el mensaje de sistema.
  const cobro = await cobrarPorWhatsApp({
    ...ticket,
    estado: 'fase_1',
    expediente_id: snap.expediente_id,
    fecha_vencimiento_canon: input.fecha_vencimiento_canon,
  });
  const whatsapp_estado = cobro.estado;
  await agregarMensajeInterno(
    ticket.id,
    'sistema',
    userId,
    `Mora reportada — Fase 1 (Recordatorio). ${avisoWhatsApp(cobro)}`,
    salioPorWhatsApp(cobro),
  );
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.MORA_REPORTADA,
    entidad: AUDIT_ENTITIES.MORA,
    entidadId: ticket.id,
    detalle: {
      expediente_id: snap.expediente_id,
      contrato_id: snap.contrato_id,
      ticket: ticket.ticket_numero,
      monto_mora: input.monto_mora,
      fecha_vencimiento_canon: input.fecha_vencimiento_canon,
      whatsapp_estado,
    },
  });
  await avisarCofianza({
    moraId: ticket.id,
    actorId: userId,
    tipo: 'mora.reportada',
    titulo: `Nueva mora reportada — ${ticket.ticket_numero}`,
    mensaje: `${ticket.inquilino_nombre} · ${ticket.inmueble_direccion ?? 'inmueble'} · $${formatCOP(ticket.monto_mora)}. ${avisoWhatsApp(cobro)}`,
  });

  logger.info({ moraId: ticket.id, ticket: ticket.ticket_numero }, 'Ticket de mora creado');

  return {
    ...(await getMoraById(ticket.id)),
    whatsapp_estado,
    whatsapp_programado_para: cobro.programado_para ?? null,
  };
}

// ============================================================
// Listar
// ============================================================

export async function listMoras(query: ListMorasQuery, userId: string, rol: string) {
  const offset = (query.page - 1) * query.limit;

  let qb = db('moras_tickets')
    .select('*', { count: 'exact' })
    .order('reportado_at', { ascending: query.orden === 'asc' });

  if (query.estado === 'activas') {
    qb = qb.in('estado', ESTADOS_ACTIVOS as unknown as string[]);
  } else if (query.estado && query.estado !== 'todas') {
    qb = qb.eq('estado', query.estado);
  }
  if (query.contrato_id) {
    qb = qb.eq('contrato_id', query.contrato_id);
  }
  // Las de los estudios que el usuario ve (tenantScope: el equipo según su
  // alcance, el propietario las de sus inmuebles); roles internos, todas.
  const expedienteIds = await resolveAllowedExpedienteIds(userId, rol);
  if (expedienteIds !== null) {
    if (expedienteIds.length === 0) {
      return {
        data: [],
        pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
      };
    }
    qb = qb.in('expediente_id', expedienteIds);
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

  // Con el nombre de quien escribió o hizo la acción (antes el chat decía
  // «PROPIETARIO» también para la inmobiliaria y los de sistema, nada).
  const { data: mensajes } = await db('moras_mensajes')
    .select('*, autor:perfiles!moras_mensajes_autor_id_fkey(nombre, apellido)')
    .eq('mora_id', id)
    .order('created_at', { ascending: true });

  return { ...(mora as object), mensajes: mensajes ?? [] };
}

// ============================================================
// Escalar manualmente
// ============================================================

const moraYaCambio = () =>
  AppError.conflict('La mora ya cambió de fase. Revisa el detalle actualizado.', 'MORA_ESTADO_CAMBIO');

export async function escalarMora(id: string, input: EscalarMoraInput, userId: string, rol: string) {
  const mora = await assertMoraAccess(id, userId, rol);
  // La pantalla estaba vieja (otro ya la escaló): sin esto la llevaba a la
  // fase siguiente y le mandaba al inquilino una plantilla que nadie pidió.
  if (input.desde && input.desde !== mora.estado) throw moraYaCambio();
  // P27: la Fase 3 la decide Cofianza (o el escalado automático del día 10), y
  // el dueño no adelanta la Fase 2: el inquilino recibía «escalado a Cofianza»
  // el mismo día del reporte sin que Cofianza lo decidiera.
  if (!esInterno(rol)) {
    if (mora.estado === 'fase_2') {
      throw AppError.forbidden('El paso a Fase 3 lo decide Cofianza.', 'MORA_FASE_3_SOLO_COFIANZA');
    }
    if (mora.estado === 'fase_1' && diasDesde(mora.reportado_at) < DIAS_FASE_2) {
      throw AppError.badRequest(
        `Podrás escalar a Fase 2 a los ${DIAS_FASE_2} días del reporte.`,
        'MORA_FASE_2_ANTICIPADA',
      );
    }
  }

  let proximoEstado: 'fase_2' | 'fase_3';
  const updates: Record<string, unknown> = {};

  if (mora.estado === 'fase_1') {
    proximoEstado = 'fase_2';
    updates.fase_2_at = new Date().toISOString();
  } else if (mora.estado === 'fase_2') {
    proximoEstado = 'fase_3';
    updates.fase_3_at = new Date().toISOString();
  } else {
    throw AppError.badRequest(
      `No se puede escalar una mora en estado ${mora.estado}`,
      'MORA_ESTADO_INVALIDO',
    );
  }
  updates.estado = proximoEstado;

  // Condicionado a la fase leída, como el cron: dos escalados a la vez movían
  // la fila los dos y el inquilino recibía la plantilla dos veces.
  const { data: movida, error } = await db('moras_tickets')
    .update(updates as never)
    .eq('id', id)
    .eq('estado', mora.estado)
    .select('id');
  if (error) throw fromSupabaseError(error);
  if (!movida?.length) throw moraYaCambio();

  const cobro = await cobrarPorWhatsApp({ ...mora, estado: proximoEstado });
  const whatsapp_estado = cobro.estado;
  await agregarMensajeInterno(
    id,
    'sistema',
    userId,
    `Escalado a ${NOMBRE_FASE[proximoEstado]}. ${avisoWhatsApp(cobro)}${
      input.notas ? ` Notas del asesor: ${input.notas}` : ''
    }`,
    salioPorWhatsApp(cobro),
  );
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.MORA_ESCALADA,
    entidad: AUDIT_ENTITIES.MORA,
    entidadId: id,
    detalle: {
      expediente_id: mora.expediente_id,
      estado_anterior: mora.estado,
      estado_nuevo: proximoEstado,
      notas: input.notas ?? null,
      whatsapp_estado,
    },
  });
  if (proximoEstado === 'fase_3') {
    await avisarCofianza({
      moraId: id,
      actorId: userId,
      tipo: 'mora.fase_3',
      titulo: `Mora en Fase 3 — ${mora.ticket_numero}`,
      mensaje: mensajeFase3(mora, avisoWhatsApp(cobro)),
    });
  }

  return { ...(await getMoraById(id)), whatsapp_estado, whatsapp_programado_para: cobro.programado_para ?? null };
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
  if (mora.estado === 'fase_3' && !esInterno(rol)) throw casoDeCofianza();

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
    userId,
    `Mora marcada como pagada${input.notas ? `. Notas: ${input.notas}` : ''}`,
  );
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.MORA_PAGADA,
    entidad: AUDIT_ENTITIES.MORA,
    entidadId: id,
    detalle: {
      expediente_id: mora.expediente_id,
      estado_anterior: mora.estado,
      fecha_pago: input.fecha_pago ?? null,
      notas: input.notas ?? null,
    },
  });

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
  if (mora.estado === 'fase_3' && !esInterno(rol)) throw casoDeCofianza();

  const { error } = await db('moras_tickets')
    .update({
      estado: 'cancelada',
      cancelada_at: new Date().toISOString(),
      cancelado_motivo: input.motivo,
    } as never)
    .eq('id', id);

  if (error) throw fromSupabaseError(error);

  await agregarMensajeInterno(id, 'sistema', userId, `Mora cancelada. Motivo: ${input.motivo}`);
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.MORA_CANCELADA,
    entidad: AUDIT_ENTITIES.MORA,
    entidadId: id,
    detalle: { expediente_id: mora.expediente_id, estado_anterior: mora.estado, motivo: input.motivo },
  });

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

  const autorTipo: 'asesor' | 'propietario' = esInterno(rol) ? 'asesor' : 'propietario';

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

  // P27: en Fase 3 el caso es de Cofianza y el dueño solo anota en el historial;
  // esa nota (p. ej. «ya me pagó») le tiene que llegar a alguien. Si reporta un
  // pago, el WhatsApp de Fase 3 que esté esperando queda en pausa hasta que
  // Cofianza lo revise (reanudarWhatsApp o marcar pagada).
  if (mora.estado === 'fase_3' && !esInterno(rol)) {
    let pausado = false;
    if (input.reporta_pago) {
      const { data: enPausa } = await db('moras_tickets')
        .update({ whatsapp_pausado_at: new Date().toISOString() } as never)
        .eq('id', moraId)
        .eq('estado', 'fase_3')
        .not('whatsapp_programado_para', 'is', null)
        .select('id');
      pausado = !!enPausa?.length;
      if (pausado) {
        await agregarMensajeInterno(
          moraId,
          'sistema',
          userId,
          'El WhatsApp de Fase 3 quedó en pausa: el dueño reporta un pago y Cofianza lo revisa.',
        );
      }
    }
    await avisarCofianza({
      moraId,
      actorId: userId,
      tipo: input.reporta_pago ? 'mora.pago_reportado' : 'mora.nota_dueno',
      titulo: `${input.reporta_pago ? 'Pago reportado por el dueño' : 'Nota del dueño'} — ${mora.ticket_numero}`,
      mensaje: `${mora.inquilino_nombre} · ${mora.inmueble_direccion ?? 'inmueble'}: «${input.mensaje}»${
        pausado ? ' El WhatsApp de Fase 3 quedó en pausa hasta que lo revises.' : ''
      }`,
    });
  }

  return data;
}

/** Cofianza revisó el pago reportado y el cobro sigue: el WhatsApp de Fase 3 sale en el horario de cobranza. */
export async function reanudarWhatsApp(id: string, userId: string, rol: string) {
  await assertMoraAccess(id, userId, rol);
  const { data, error } = await db('moras_tickets')
    .update({ whatsapp_pausado_at: null } as never)
    .eq('id', id)
    .not('whatsapp_pausado_at', 'is', null)
    .select('id');
  if (error) throw fromSupabaseError(error);
  if (!data?.length) throw AppError.conflict('El WhatsApp de esta mora no está en pausa.', 'MORA_SIN_PAUSA');
  await agregarMensajeInterno(
    id,
    'sistema',
    userId,
    'Cofianza revisó el pago reportado y el cobro sigue: el WhatsApp de Fase 3 sale en el horario de cobranza.',
  );
  return getMoraById(id);
}

/** `viaWhatsapp`: el mensaje registra un WhatsApp de cobro que salió. */
async function agregarMensajeInterno(
  moraId: string,
  autorTipo: 'sistema' | 'asesor' | 'inquilino' | 'propietario',
  autorId: string | null,
  mensaje: string,
  viaWhatsapp = false,
): Promise<void> {
  const { error } = await db('moras_mensajes').insert({
    mora_id: moraId,
    autor_tipo: autorTipo,
    autor_id: autorId,
    mensaje,
    via_whatsapp: viaWhatsapp,
  } as never);
  if (error) {
    logger.warn({ error: error.message, moraId }, 'Error al insertar mensaje sistema en mora');
  }
}

/**
 * Nº de moras ACTIVAS (fase_1/2/3) de un contrato. Lo usa la UI de "Terminar
 * contrato" para advertir al operador antes de cerrar (una mora sobrevive a la
 * terminación por diseño — el cobro de la fianza sigue). Best-effort: 0 si falla.
 * OJO: no aplica tenant-scoping — asume que el caller ya validó ownership del
 * contrato (hoy: getContratoTransitions vía assertPuedeVerContrato).
 */
export async function contarMorasActivasDeContrato(contratoId: string): Promise<number> {
  const { count, error } = await db('moras_tickets')
    .select('id', { count: 'exact', head: true })
    .eq('contrato_id', contratoId)
    .in('estado', ESTADOS_ACTIVOS as unknown as string[]);
  if (error) {
    logger.warn({ error: error.message, contratoId }, 'No se pudo contar moras activas del contrato');
    return 0;
  }
  return count ?? 0;
}

/**
 * Deja un mensaje interno de sistema en las moras ACTIVAS de un contrato cuando
 * este se termina/cancela, SIN cambiar su estado. La mora sobrevive al contrato
 * a propósito (cobro de la fianza tras impago); esto solo da trazabilidad para
 * que el asesor revise si sigue vigente. Log-only: nunca lanza.
 */
export async function anotarContratoTerminadoEnMoras(
  contratoId: string,
  targetState: 'finalizado' | 'cancelado',
): Promise<void> {
  try {
    const { data } = await db('moras_tickets')
      .select('id')
      .eq('contrato_id', contratoId)
      .in('estado', ESTADOS_ACTIVOS as unknown as string[]);
    const moras = (data as Array<{ id: string }> | null) ?? [];
    const verbo = targetState === 'cancelado' ? 'canceló' : 'finalizó';
    for (const m of moras) {
      await agregarMensajeInterno(
        m.id,
        'sistema',
        null,
        `El contrato se ${verbo}. Revisar si esta mora sigue vigente (el cobro continúa salvo que se marque pagada o se cancele).`,
      );
    }
    if (moras.length > 0) {
      logger.info({ contratoId, moras: moras.length }, 'Moras activas anotadas por terminación del contrato');
    }
  } catch (err) {
    logger.warn({ err, contratoId }, 'No se pudieron anotar las moras al terminar el contrato');
  }
}

// ============================================================
// Cron auto-escalado: Fase 1 → 2 (+4d), Fase 2 → 3 (+10d)
// ============================================================

const DIAS_FASE_2 = 4;
const DIAS_FASE_3 = 10;
// Tiempo minimo que una mora debe pasar EN fase_2 antes de llegar a fase_3.
// Sin esto una mora vieja que entra a fase_2 en esta misma corrida cumple
// tambien el corte de los 10 dias desde reportado_at y salta 1 -> 3 de una,
// mandando los dos WhatsApp seguidos al inquilino.
const DIAS_EN_FASE_2 = DIAS_FASE_3 - DIAS_FASE_2;

export async function autoEscalar(): Promise<{ aFase2: number; aFase3: number }> {
  const ahora = new Date();
  const limiteFase2 = new Date(ahora.getTime() - DIAS_FASE_2 * 24 * 60 * 60 * 1000).toISOString();
  const limiteFase3 = new Date(ahora.getTime() - DIAS_FASE_3 * 24 * 60 * 60 * 1000).toISOString();
  const limiteEnFase2 = new Date(ahora.getTime() - DIAS_EN_FASE_2 * 24 * 60 * 60 * 1000).toISOString();

  // Fase 1 → 2 (lleva al menos 4 días en fase_1)
  const { data: aSubirF2 } = await db('moras_tickets')
    .select('id, expediente_id, inquilino_telefono, inquilino_nombre, inmueble_direccion, monto_mora, reportado_at, fecha_vencimiento_canon')
    .eq('estado', 'fase_1')
    .lte('reportado_at', limiteFase2)
    .limit(100) as unknown as {
      data: Array<{
        id: string;
        expediente_id: string | null;
        inquilino_telefono: string | null;
        inquilino_nombre: string;
        inmueble_direccion: string | null;
        monto_mora: number;
        reportado_at: string;
        fecha_vencimiento_canon: string;
      }> | null;
    };

  let aFase2 = 0;
  for (const m of aSubirF2 ?? []) {
    // El `.eq('estado', ...)` hace el UPDATE condicional: si otra corrida (o el
    // escalado manual) ya la movió, no afecta filas y no mandamos el WhatsApp
    // por segunda vez.
    const { data: movida } = await db('moras_tickets')
      .update({ estado: 'fase_2', fase_2_at: ahora.toISOString() } as never)
      .eq('id', m.id)
      .eq('estado', 'fase_1')
      .select('id') as unknown as { data: Array<{ id: string }> | null };
    if (!movida || movida.length === 0) continue;
    const cobro = await cobrarPorWhatsApp({ ...m, estado: 'fase_2' }, ahora);
    await agregarMensajeInterno(
      m.id,
      'sistema',
      null,
      `Escalado automático a Fase 2 (Urgencia) — 4 días sin pago. ${avisoWhatsApp(cobro)}`,
      salioPorWhatsApp(cobro),
    );
    aFase2++;
  }

  // Fase 2 → 3: al menos 10 días desde reportado Y al menos 6 días dentro de
  // fase_2. La segunda condición es la que evita el salto 1 → 3 en una sola
  // corrida; `fase_2_at` lo escriben tanto este cron como el escalado manual.
  const { data: aSubirF3 } = await db('moras_tickets')
    .select('id, ticket_numero, expediente_id, inquilino_telefono, inquilino_nombre, inmueble_direccion, monto_mora, reportado_at, fecha_vencimiento_canon')
    .eq('estado', 'fase_2')
    .lte('reportado_at', limiteFase3)
    .lte('fase_2_at', limiteEnFase2)
    .limit(100) as unknown as {
      data: Array<{
        id: string;
        ticket_numero: string;
        expediente_id: string | null;
        inquilino_telefono: string | null;
        inquilino_nombre: string;
        inmueble_direccion: string | null;
        monto_mora: number;
        reportado_at: string;
        fecha_vencimiento_canon: string;
      }> | null;
    };

  let aFase3 = 0;
  for (const m of aSubirF3 ?? []) {
    const { data: movida } = await db('moras_tickets')
      .update({ estado: 'fase_3', fase_3_at: ahora.toISOString() } as never)
      .eq('id', m.id)
      .eq('estado', 'fase_2')
      .select('id') as unknown as { data: Array<{ id: string }> | null };
    if (!movida || movida.length === 0) continue;
    const cobro = await cobrarPorWhatsApp({ ...m, estado: 'fase_3' }, ahora);
    await agregarMensajeInterno(
      m.id,
      'sistema',
      null,
      `Escalado automático a Fase 3 (Legal) — 10 días sin pago. Cofianza toma control. ${avisoWhatsApp(cobro)}`,
      salioPorWhatsApp(cobro),
    );
    await avisarCofianza({
      moraId: m.id,
      actorId: null,
      tipo: 'mora.fase_3',
      titulo: `Mora en Fase 3 — ${m.ticket_numero}`,
      mensaje: mensajeFase3(m, avisoWhatsApp(cobro)),
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

  // Mismas reglas que listMoras.
  const expedienteIds = await resolveAllowedExpedienteIds(userId, rol);
  if (expedienteIds !== null && expedienteIds.length === 0) {
    return { reportadas_mes: 0, resueltas: 0, en_gestion: 0, monto_total: 0 };
  }
  // Paginado: PostgREST corta en 1000 filas y el monto se sumaba sobre una muestra.
  const { data, error } = await fetchAll<{ estado: MoraEstado; monto_mora: number; reportado_at: string }>((desde, hasta) => {
    let qb = db('moras_tickets').select('estado, monto_mora, reportado_at');
    if (expedienteIds !== null) qb = qb.in('expediente_id', expedienteIds);
    return qb.order('id').range(desde, hasta);
  });
  if (error) throw fromSupabaseError(error);

  let reportadas_mes = 0;
  let resueltas = 0;
  let en_gestion = 0;
  let monto_total = 0;

  for (const row of data) {
    if (row.reportado_at >= isoMes) reportadas_mes++;
    if (row.estado === 'pagada') resueltas++;
    if ((ESTADOS_ACTIVOS as readonly string[]).includes(row.estado)) {
      en_gestion++;
      monto_total += row.monto_mora;
    }
  }

  return { reportadas_mes, resueltas, en_gestion, monto_total };
}

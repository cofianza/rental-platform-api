import { randomBytes } from 'crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  sendCitaSolicitadaPropietarioEmail,
  sendCitaConfirmadaSolicitanteEmail,
  sendCitaReprogramadaSolicitanteEmail,
  sendCitaCanceladaEmail,
} from '../orchestrator/orchestrator.emails';
import { assertCitaPermission, resolveAccessibleExpedienteIds } from './citas.permissions';
import { slotEstaDisponible } from '../disponibilidad/disponibilidad.service';
import { notificarUsuario, findPerfilIdByEmail } from '../notificaciones/notificaciones.service';
import { enviarTemplate as enviarTemplateWhatsApp } from '../whatsapp';
import type { UserRole } from '@/types/auth';
import type {
  CreateCitaInput,
  ConfirmarCitaInput,
  ReprogramarCitaInput,
  RealizarCitaInput,
  CancelarCitaInput,
  ListCitasQuery,
} from './citas.schema';

// ============================================================
// Helpers
// ============================================================

const db = (table: string) => (supabase.from(table as string) as ReturnType<typeof supabase.from>);

// Embeds aliasados (alias:tabla) para que el response use claves singulares:
// cita.expediente.inmueble.direccion, cita.expediente.solicitante.nombre.
// Patrón idéntico al ya usado en estudios.service.ts con `tipo_documento:tipos_documento`.
const CITA_SELECT = `
  id, expediente_id, estado, fecha_propuesta, fecha_confirmada,
  notas_solicitante, notas_propietario, motivo_cancelacion,
  creado_por, confirmado_por, acuse_solicitante_at,
  created_at, updated_at,
  expediente:expedientes (
    id, numero, estudio_habilitado, estudio_rechazado, motivo_estudio_rechazado,
    inmueble:inmuebles (id, direccion, ciudad),
    solicitante:solicitantes (
      nombre, apellido, telefono, email,
      tipo_documento, numero_documento, ciudad, ocupacion
    )
  )
`;

// ============================================================
// Timeline helper
// ============================================================

async function registrarTimelineCita(
  expedienteId: string,
  descripcion: string,
  usuarioId: string,
  metadata?: Record<string, unknown>,
) {
  const { error } = await db('eventos_timeline').insert({
    expediente_id: expedienteId,
    tipo: 'cita',
    descripcion,
    usuario_id: usuarioId,
    metadata: metadata || null,
  } as never);

  if (error) {
    logger.warn({ error: error.message, expedienteId }, 'Error al registrar evento timeline de cita');
  }
}

// ============================================================
// Fetch helpers
// ============================================================

async function fetchCita(id: string) {
  const { data, error } = await db('citas')
    .select(CITA_SELECT)
    .eq('id', id)
    .single();

  if (error || !data) {
    if (error?.code === 'PGRST116') {
      throw AppError.notFound('Cita no encontrada');
    }
    logger.error({ error: error?.message, id }, 'Error al obtener cita');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener la cita');
  }

  return data as unknown as Record<string, unknown>;
}


// ============================================================
// Validate state transition
// ============================================================

const VALID_TRANSITIONS: Record<string, string[]> = {
  solicitada: ['confirmada', 'cancelada'],
  confirmada: ['realizada', 'cancelada', 'no_asistio'],
};

function assertTransition(current: string, target: string) {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed || !allowed.includes(target)) {
    throw AppError.badRequest(
      `No se puede cambiar el estado de "${current}" a "${target}"`,
      'INVALID_STATE_TRANSITION',
    );
  }
}

// ============================================================
// Helpers de notificacion por email
// ============================================================

interface ExpedienteContexto {
  expedienteId: string;
  solicitanteEmail: string | null;
  solicitanteNombre: string;
  solicitanteTelefono: string | null;
  // Perfil-id del solicitante. Resuelto por email — null si aun no tiene
  // cuenta registrada (eg. solicitante externo invitado solo por email).
  solicitanteUserId: string | null;
  propietarioEmail: string | null;
  propietarioNombre: string;
  propietarioTelefono: string | null;
  // Perfil-id del propietario. Sale directo de inmueble.propietario_id.
  propietarioUserId: string;
  inmuebleDireccion: string;
  inmuebleCiudad: string;
}

/**
 * Garantiza que la cita tenga un token público (para los botones del WhatsApp).
 * Lo genera y persiste si aún no existe. Devuelve null si falla (el envío del
 * template entonces sigue sin botones — fire-and-forget).
 */
export async function ensureCitaToken(citaId: string): Promise<string | null> {
  // Normalmente el token ya existe (DEFAULT de la columna lo genera al insertar
  // la cita). Esto es la red de seguridad para citas viejas sin token.
  const { data: row } = await db('citas')
    .select('token')
    .eq('id', citaId)
    .maybeSingle() as { data: { token: string | null } | null };

  if (row?.token) return row.token;

  const token = randomBytes(32).toString('hex');
  const { error } = await db('citas').update({ token } as never).eq('id', citaId);
  if (error) {
    logger.warn({ error: error.message, citaId }, 'No se pudo generar el token público de la cita');
    return null;
  }
  return token;
}

export async function obtenerContextoExpediente(expedienteId: string): Promise<ExpedienteContexto | null> {
  // Obtener expediente con FKs
  const { data: exp } = await db('expedientes')
    .select('id, solicitante_id, inmueble_id')
    .eq('id', expedienteId)
    .single() as { data: { id: string; solicitante_id: string | null; inmueble_id: string } | null };

  if (!exp) return null;

  // Solicitante (puede ser null en expedientes externos no vinculados)
  let solicitanteEmail: string | null = null;
  let solicitanteNombre = '';
  let solicitanteTelefono: string | null = null;
  if (exp.solicitante_id) {
    const { data: sol } = await db('solicitantes')
      .select('nombre, apellido, email, telefono')
      .eq('id', exp.solicitante_id)
      .single() as { data: { nombre: string; apellido: string; email: string; telefono: string | null } | null };
    if (sol) {
      solicitanteEmail = sol.email;
      solicitanteNombre = `${sol.nombre} ${sol.apellido}`.trim();
      solicitanteTelefono = sol.telefono;
    }
  }

  // Inmueble + propietario
  const { data: inm } = await db('inmuebles')
    .select('direccion, ciudad, propietario_id')
    .eq('id', exp.inmueble_id)
    .single() as { data: { direccion: string; ciudad: string; propietario_id: string } | null };

  if (!inm) return null;

  const { data: perfil } = await db('perfiles')
    .select('nombre, apellido, razon_social, telefono')
    .eq('id', inm.propietario_id)
    .single() as { data: { nombre: string; apellido: string; razon_social: string | null; telefono: string | null } | null };

  let propietarioEmail: string | null = null;
  try {
    const { data: authData } = await supabase.auth.admin.getUserById(inm.propietario_id);
    propietarioEmail = authData?.user?.email || null;
  } catch (e) {
    logger.warn({ error: e, propietarioId: inm.propietario_id }, 'Error al obtener email de propietario');
  }

  const propietarioNombre = perfil?.razon_social || `${perfil?.nombre || ''} ${perfil?.apellido || ''}`.trim();

  // Perfil-id del solicitante: lookup por email contra auth.users. Puede no
  // existir aun (solicitante invitado externo) — devolvemos null y los
  // emisores de notificacion lo toleran.
  const solicitanteUserId = solicitanteEmail ? await findPerfilIdByEmail(solicitanteEmail) : null;

  return {
    expedienteId,
    solicitanteEmail,
    solicitanteNombre,
    solicitanteTelefono,
    solicitanteUserId,
    propietarioEmail,
    propietarioNombre,
    propietarioTelefono: perfil?.telefono ?? null,
    propietarioUserId: inm.propietario_id,
    inmuebleDireccion: inm.direccion,
    inmuebleCiudad: inm.ciudad,
  };
}

export async function notificarCitaCreada(citaId: string, expedienteId: string, fechaPropuesta: string, autoConfirm: boolean) {
  const ctx = await obtenerContextoExpediente(expedienteId);
  if (!ctx) return;

  const linkExpediente = `/expedientes/${ctx.expedienteId}`;
  const fechaLegible = new Date(fechaPropuesta).toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const primerNombreSol = ctx.solicitanteNombre.split(' ')[0] || 'Hola';

  if (autoConfirm) {
    // Cita creada ya confirmada por propietario/inmobiliaria → notificar al solicitante
    if (ctx.solicitanteEmail) {
      await sendCitaConfirmadaSolicitanteEmail({
        email: ctx.solicitanteEmail,
        nombre_solicitante: ctx.solicitanteNombre,
        inmueble: ctx.inmuebleDireccion,
        ciudad: ctx.inmuebleCiudad,
        fecha_confirmada: fechaPropuesta,
      });
    }
    notificarUsuario({
      userId: ctx.solicitanteUserId ?? '',
      tipo: 'cita.confirmada',
      titulo: 'Cita confirmada',
      mensaje: `Tu visita a ${ctx.inmuebleDireccion} fue confirmada.`,
      link: linkExpediente,
      payload: { expediente_id: ctx.expedienteId, fecha_confirmada: fechaPropuesta },
    });
    // Plantilla v2 con botones Reprogramar/Cancelar → inyectar el token de la
    // cita (este es el camino de "creada ya confirmada" por inmobiliaria/dueño).
    const token = await ensureCitaToken(citaId);
    await enviarTemplateWhatsApp({
      to: ctx.solicitanteTelefono,
      template: 'CITA_CONFIRMADA',
      variables: [primerNombreSol, ctx.inmuebleDireccion, ctx.inmuebleCiudad, fechaLegible],
      urlButtons: token ? [token, token] : undefined,
      context: { expediente_id: ctx.expedienteId },
    });
  } else {
    // Cita solicitada → notificar al propietario
    if (ctx.propietarioEmail) {
      await sendCitaSolicitadaPropietarioEmail({
        email: ctx.propietarioEmail,
        nombre_propietario: ctx.propietarioNombre,
        nombre_solicitante: ctx.solicitanteNombre,
        inmueble: ctx.inmuebleDireccion,
        ciudad: ctx.inmuebleCiudad,
        fecha_propuesta: fechaPropuesta,
      });
    }
    notificarUsuario({
      userId: ctx.propietarioUserId,
      tipo: 'cita.solicitada',
      titulo: 'Nueva visita solicitada',
      mensaje: `${ctx.solicitanteNombre || 'Un solicitante'} pidio visitar ${ctx.inmuebleDireccion}.`,
      link: linkExpediente,
      payload: { expediente_id: ctx.expedienteId, fecha_propuesta: fechaPropuesta },
    });
    // WhatsApp al dueño/inmobiliaria: el solicitante propuso/reprogramó una
    // visita y debe confirmarla. Cubre la 1ra solicitud y la reprogramación.
    const primerNombreProp = ctx.propietarioNombre.split(' ')[0] || 'Hola';
    await enviarTemplateWhatsApp({
      to: ctx.propietarioTelefono,
      template: 'CITA_SOLICITADA_DUENO',
      variables: [primerNombreProp, ctx.solicitanteNombre, ctx.inmuebleDireccion, ctx.inmuebleCiudad, fechaLegible],
      context: { expediente_id: ctx.expedienteId },
    });
  }
}

async function notificarCitaConfirmada(
  citaId: string,
  expedienteId: string,
  fechaPropuesta: string,
  fechaConfirmada: string,
  notasPropietario?: string,
) {
  const ctx = await obtenerContextoExpediente(expedienteId);
  if (!ctx?.solicitanteEmail) return;

  // Si el propietario confirmó cambiando la fecha/hora, usar template específico
  // de "reprogramada" para que el solicitante note el ajuste.
  const reprogramada =
    new Date(fechaPropuesta).getTime() !== new Date(fechaConfirmada).getTime();

  const linkExpediente = `/expedientes/${ctx.expedienteId}`;
  // Cadena legible para WhatsApp (timezone Bogota — el solicitante es CO).
  const fechaConfirmadaLegible = new Date(fechaConfirmada).toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const fechaPropuestaLegible = new Date(fechaPropuesta).toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const primerNombre = ctx.solicitanteNombre.split(' ')[0] || 'Hola';

  if (reprogramada) {
    await sendCitaReprogramadaSolicitanteEmail({
      email: ctx.solicitanteEmail,
      nombre_solicitante: ctx.solicitanteNombre,
      inmueble: ctx.inmuebleDireccion,
      ciudad: ctx.inmuebleCiudad,
      fecha_propuesta: fechaPropuesta,
      fecha_confirmada: fechaConfirmada,
      notas_propietario: notasPropietario,
    });
    notificarUsuario({
      userId: ctx.solicitanteUserId ?? '',
      tipo: 'cita.reprogramada',
      titulo: 'Cita reprogramada',
      mensaje: `El propietario ajustó la fecha de tu visita a ${ctx.inmuebleDireccion}.`,
      link: linkExpediente,
      payload: { expediente_id: ctx.expedienteId, fecha_confirmada: fechaConfirmada },
    });
    // WhatsApp al solicitante via Meta (Mario 12-may-2026 — provider mock).
    await enviarTemplateWhatsApp({
      to: ctx.solicitanteTelefono,
      template: 'CITA_REPROGRAMADA',
      variables: [primerNombre, ctx.inmuebleDireccion, fechaPropuestaLegible, fechaConfirmadaLegible],
      context: { expediente_id: ctx.expedienteId },
    });
    return;
  }

  await sendCitaConfirmadaSolicitanteEmail({
    email: ctx.solicitanteEmail,
    nombre_solicitante: ctx.solicitanteNombre,
    inmueble: ctx.inmuebleDireccion,
    ciudad: ctx.inmuebleCiudad,
    fecha_confirmada: fechaConfirmada,
    notas_propietario: notasPropietario,
  });
  notificarUsuario({
    userId: ctx.solicitanteUserId ?? '',
    tipo: 'cita.confirmada',
    titulo: 'Cita confirmada',
    mensaje: `Tu visita a ${ctx.inmuebleDireccion} fue confirmada.`,
    link: linkExpediente,
    payload: { expediente_id: ctx.expedienteId, fecha_confirmada: fechaConfirmada },
  });
  // WhatsApp al solicitante via Meta. La plantilla v2 lleva 2 botones URL
  // (Reprogramar / Cancelar) que abren cofianza.co/visita/<accion>/<token>;
  // el token de la cita se inyecta como sufijo de ambos botones.
  const token = await ensureCitaToken(citaId);
  await enviarTemplateWhatsApp({
    to: ctx.solicitanteTelefono,
    template: 'CITA_CONFIRMADA',
    variables: [primerNombre, ctx.inmuebleDireccion, ctx.inmuebleCiudad, fechaConfirmadaLegible],
    urlButtons: token ? [token, token] : undefined,
    context: { expediente_id: ctx.expedienteId },
  });
}

/**
 * Avisa a la contraparte que la cita fue cancelada (email + in-app).
 * Si lo cancela el propietario/inmobiliaria/admin -> notifica al solicitante.
 * Si lo cancela el solicitante -> notifica al propietario.
 * El rol del actor decide la direccion del aviso.
 */
export async function notificarCitaCancelada(
  expedienteId: string,
  fechaCita: string,
  motivo: string,
  canceladoPorRol: string,
) {
  const ctx = await obtenerContextoExpediente(expedienteId);
  if (!ctx) return;

  const linkExpediente = `/expedientes/${ctx.expedienteId}`;
  const canceladoPorPropietario = canceladoPorRol === 'propietario'
    || canceladoPorRol === 'inmobiliaria'
    || canceladoPorRol === 'administrador'
    || canceladoPorRol === 'operador_analista';

  const fechaCitaLegible = new Date(fechaCita).toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (canceladoPorPropietario) {
    // Avisar al solicitante
    if (ctx.solicitanteEmail) {
      await sendCitaCanceladaEmail({
        email: ctx.solicitanteEmail,
        nombre_destinatario: ctx.solicitanteNombre || 'Solicitante',
        inmueble: ctx.inmuebleDireccion,
        ciudad: ctx.inmuebleCiudad,
        fecha_cita: fechaCita,
        motivo,
        cancelado_por: 'propietario',
      });
    }
    notificarUsuario({
      userId: ctx.solicitanteUserId ?? '',
      tipo: 'cita.cancelada',
      titulo: 'Visita cancelada',
      mensaje: `El propietario canceló tu visita a ${ctx.inmuebleDireccion}. Motivo: ${motivo}`,
      link: linkExpediente,
      payload: { expediente_id: ctx.expedienteId, motivo },
    });
    await enviarTemplateWhatsApp({
      to: ctx.solicitanteTelefono,
      template: 'CITA_CANCELADA',
      variables: [
        ctx.solicitanteNombre.split(' ')[0] || 'Hola',
        ctx.inmuebleDireccion,
        fechaCitaLegible,
        motivo,
      ],
      context: { expediente_id: ctx.expedienteId },
    });
  } else {
    // Solicitante cancelo -> avisar al propietario
    if (ctx.propietarioEmail) {
      await sendCitaCanceladaEmail({
        email: ctx.propietarioEmail,
        nombre_destinatario: ctx.propietarioNombre || 'Propietario',
        inmueble: ctx.inmuebleDireccion,
        ciudad: ctx.inmuebleCiudad,
        fecha_cita: fechaCita,
        motivo,
        cancelado_por: 'solicitante',
      });
    }
    notificarUsuario({
      userId: ctx.propietarioUserId,
      tipo: 'cita.cancelada',
      titulo: 'Visita cancelada por el solicitante',
      mensaje: `${ctx.solicitanteNombre || 'El solicitante'} cancelo la visita a ${ctx.inmuebleDireccion}. Motivo: ${motivo}`,
      link: linkExpediente,
      payload: { expediente_id: ctx.expedienteId, motivo },
    });
    await enviarTemplateWhatsApp({
      to: ctx.propietarioTelefono,
      template: 'CITA_CANCELADA',
      variables: [
        ctx.propietarioNombre.split(' ')[0] || 'Hola',
        ctx.inmuebleDireccion,
        fechaCitaLegible,
        motivo,
      ],
      context: { expediente_id: ctx.expedienteId },
    });
  }
}

// ============================================================
// Create
// ============================================================

export async function createCita(input: CreateCitaInput, userId: string, userRol: string) {
  // Ownership + autorización fine-grained (también valida que el expediente exista)
  const expediente = await assertCitaPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId: input.expediente_id,
    action: 'create',
  });

  // Guard: no permitir crear una nueva cita si ya existe una activa para
  // este expediente (solicitada o confirmada). Defensa server-side aunque
  // el frontend ya esconde el boton — protege contra clientes desincronizados,
  // doble-click y llamadas directas a la API.
  const { data: existentes } = await db('citas')
    .select('id, estado')
    .eq('expediente_id', input.expediente_id)
    .in('estado', ['solicitada', 'confirmada'])
    .limit(1) as unknown as { data: { id: string; estado: string }[] | null };

  if (existentes && existentes.length > 0) {
    logger.warn(
      { userId, expedienteId: input.expediente_id, existente: existentes[0] },
      'Intento de crear cita con una activa ya existente',
    );
    throw AppError.conflict(
      `Ya existe una cita ${existentes[0].estado} para este expediente. Cancelala antes de agendar otra.`,
      'CITA_ACTIVA_EXISTE',
    );
  }

  // Guard anti-race: el solicitante pudo haber visto el slot libre y otro
  // solicitante lo tomó antes. El backend valida contra fn_slot_esta_disponible
  // que chequea antelación mínima + ventana de disponibilidad + ocupación.
  //
  // Solo aplica cuando rol=solicitante. Propietario/inmobiliaria/admin pueden
  // crear citas fuera de horario (casos excepcionales — operador, override).
  if (userRol === 'solicitante' && expediente.inmueblePropietarioId) {
    const disponible = await slotEstaDisponible(
      expediente.inmueblePropietarioId,
      input.fecha_propuesta,
    );
    if (!disponible) {
      logger.warn(
        {
          userId,
          expedienteId: input.expediente_id,
          propietarioId: expediente.inmueblePropietarioId,
          fecha_propuesta: input.fecha_propuesta,
        },
        'Intento de agendar slot no disponible',
      );
      throw AppError.badRequest(
        'El slot seleccionado ya no está disponible. Refresca y elige otro horario.',
        'SLOT_NO_DISPONIBLE',
      );
    }
  }

  // Determinar si la cita debe crearse ya confirmada
  // Solo propietario/inmobiliaria/admin pueden crear citas ya confirmadas
  const canAutoConfirm = userRol === 'propietario' || userRol === 'inmobiliaria' || userRol === 'administrador';
  const autoConfirm = !!input.confirmar_inmediatamente && canAutoConfirm;

  const insertData: Record<string, unknown> = {
    expediente_id: input.expediente_id,
    fecha_propuesta: input.fecha_propuesta,
    estado: autoConfirm ? 'confirmada' : 'solicitada',
    creado_por: userId,
  };
  if (autoConfirm) {
    insertData.fecha_confirmada = input.fecha_propuesta;
    insertData.confirmado_por = userId;
  }
  if (input.notas_solicitante) insertData.notas_solicitante = input.notas_solicitante;

  const { data, error } = await db('citas')
    .insert(insertData as never)
    .select(CITA_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al crear cita');
    if (error.code === '23503') {
      throw AppError.badRequest('Referencia invalida. Verifique los datos proporcionados', 'FK_VIOLATION');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear la cita');
  }

  const created = data as unknown as { id: string };
  const descripcion = autoConfirm
    ? `Cita confirmada para el expediente ${expediente.expedienteNumero}`
    : `Cita solicitada para el expediente ${expediente.expedienteNumero}`;

  await registrarTimelineCita(
    input.expediente_id,
    descripcion,
    userId,
    { cita_id: created.id, fecha_propuesta: input.fecha_propuesta },
  );

  // Disparar email apropiado segun el origen
  notificarCitaCreada(created.id, input.expediente_id, input.fecha_propuesta, autoConfirm).catch((e) =>
    logger.warn({ error: e, citaId: created.id }, 'Error al enviar notificacion de cita'),
  );

  logger.info({ citaId: created.id, expedienteId: input.expediente_id, autoConfirm }, 'Cita creada');
  return data;
}

// ============================================================
// List
// ============================================================

export async function getCitasByExpediente(query: ListCitasQuery, userId: string, userRol: string) {
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 20;
  const offset = (page - 1) * limit;

  // Resolver qué expedientes ve este usuario. null = sin filtro (admin/operador/gerencia).
  const accessibleIds = await resolveAccessibleExpedienteIds(userId, userRol as UserRole);
  if (accessibleIds !== null && accessibleIds.length === 0) {
    logger.debug({ userId, userRol }, 'Usuario sin expedientes accesibles — lista vacía');
    return {
      citas: [],
      pagination: { total: 0, page, limit, totalPages: 0 },
    };
  }
  if (
    accessibleIds !== null &&
    query.expediente_id &&
    !accessibleIds.includes(query.expediente_id)
  ) {
    logger.warn(
      { userId, userRol, expedienteId: query.expediente_id },
      'Intento de listar citas de expediente ajeno',
    );
    throw AppError.forbidden('No tienes permisos sobre este expediente', 'CITA_FORBIDDEN');
  }

  let qb = db('citas')
    .select(CITA_SELECT, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (query.expediente_id) {
    qb = qb.eq('expediente_id', query.expediente_id);
  } else if (accessibleIds !== null) {
    qb = qb.in('expediente_id', accessibleIds);
  }
  if (query.estado) {
    qb = qb.eq('estado', query.estado);
  }

  const { data, error, count } = await qb;

  if (error) {
    logger.error({ error: error.message }, 'Error al listar citas');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener la lista de citas');
  }

  const total = count ?? 0;
  return {
    citas: data || [],
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ============================================================
// Get by ID
// ============================================================

export async function getCitaById(id: string, userId: string, userRol: string) {
  const cita = await fetchCita(id);
  await assertCitaPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId: cita.expediente_id as string,
    action: 'read',
    citaCreadoPor: cita.creado_por as string | undefined,
  });
  return cita;
}

// ============================================================
// Confirmar (solicitada → confirmada)
// ============================================================

export async function confirmarCita(id: string, input: ConfirmarCitaInput, userId: string, userRol: string) {
  const cita = await fetchCita(id);
  await assertCitaPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId: cita.expediente_id as string,
    action: 'confirmar',
    citaCreadoPor: cita.creado_por as string | undefined,
  });
  assertTransition(cita.estado as string, 'confirmada');

  const updateData: Record<string, unknown> = {
    estado: 'confirmada',
    confirmado_por: userId,
    updated_at: new Date().toISOString(),
  };
  if (input.fecha_confirmada) updateData.fecha_confirmada = input.fecha_confirmada;
  if (input.notas_propietario) updateData.notas_propietario = input.notas_propietario;

  const { data, error } = await db('citas')
    .update(updateData as never)
    .eq('id', id)
    .select(CITA_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message, id }, 'Error al confirmar cita');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al confirmar la cita');
  }

  await registrarTimelineCita(
    cita.expediente_id as string,
    'Cita confirmada',
    userId,
    { cita_id: id, fecha_confirmada: input.fecha_confirmada || cita.fecha_propuesta },
  );

  // Notificar al solicitante que su cita fue confirmada
  notificarCitaConfirmada(
    id,
    cita.expediente_id as string,
    cita.fecha_propuesta as string,
    (input.fecha_confirmada || cita.fecha_propuesta) as string,
    input.notas_propietario,
  ).catch((e) => logger.warn({ error: e, citaId: id }, 'Error al enviar notificacion de cita confirmada'));

  logger.info({ citaId: id }, 'Cita confirmada');
  return data;
}

// ============================================================
// Reprogramar (solicitada|confirmada → ... segun rol)
//
// El comportamiento depende de quien lo dispara:
//
//   • Propietario / inmobiliaria / admin:
//       confirmada -> confirmada con nueva fecha. Self-loop intencional para
//       que el propietario pueda mover el horario despues de haber confirmado
//       (caso "se me cruzo otra cosa, propongo otro dia"). Avisa al
//       solicitante con el template 'reprogramada' y resetea el acuse para
//       que vuelva a aceptar/rechazar.
//
//   • Solicitante:
//       confirmada|solicitada -> 'solicitada' con la nueva fecha como
//       fecha_propuesta. Limpia fecha_confirmada/confirmado_por para que el
//       propietario tenga que volver a confirmar (es una nueva propuesta de
//       fecha, no una confirmacion). Avisa al propietario igual que cuando
//       crea la cita inicial.
// ============================================================

export async function reprogramarCita(
  id: string,
  input: ReprogramarCitaInput,
  userId: string,
  userRol: string,
) {
  const cita = await fetchCita(id);
  const expediente = await assertCitaPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId: cita.expediente_id as string,
    action: 'reprogramar',
    citaCreadoPor: cita.creado_por as string | undefined,
  });

  // Solo aplica a citas que estan vivas (solicitada o confirmada). Cualquier
  // otro estado (realizada/cancelada/no_asistio) no debe reprogramarse — el
  // flujo correcto es crear una nueva cita.
  const estadoActual = cita.estado as string;
  if (estadoActual !== 'solicitada' && estadoActual !== 'confirmada') {
    throw AppError.badRequest(
      `No se puede reprogramar una cita en estado "${estadoActual}"`,
      'INVALID_STATE_TRANSITION',
    );
  }

  // Validar que el slot pertenezca a la disponibilidad del propietario.
  if (expediente.inmueblePropietarioId) {
    const disponible = await slotEstaDisponible(
      expediente.inmueblePropietarioId,
      input.fecha_confirmada,
    );
    if (!disponible) {
      throw AppError.badRequest(
        'El horario seleccionado no esta dentro de la disponibilidad del propietario. Refresca y elige otro.',
        'SLOT_NO_DISPONIBLE',
      );
    }
  }

  const isSolicitante = userRol === 'solicitante';
  const fechaAnterior = (cita.fecha_confirmada || cita.fecha_propuesta) as string;

  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (isSolicitante) {
    // Solicitante propone una nueva fecha → vuelve a 'solicitada' y queda
    // pendiente de confirmacion del propietario. La nueva fecha es la
    // propuesta, no la confirmada.
    updateData.estado = 'solicitada';
    updateData.fecha_propuesta = input.fecha_confirmada;
    updateData.fecha_confirmada = null;
    updateData.confirmado_por = null;
    updateData.acuse_solicitante_at = null;
    if (input.notas_propietario) updateData.notas_solicitante = input.notas_propietario;
  } else {
    updateData.estado = 'confirmada';
    updateData.fecha_confirmada = input.fecha_confirmada;
    updateData.confirmado_por = userId;
    // Reset del acuse: el solicitante debe volver a aceptar/rechazar la nueva
    // fecha. Si lo dejabamos NOT NULL, el banner no volveria a aparecer.
    updateData.acuse_solicitante_at = null;
    if (input.notas_propietario) updateData.notas_propietario = input.notas_propietario;
  }

  const { data, error } = await db('citas')
    .update(updateData as never)
    .eq('id', id)
    .select(CITA_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message, id }, 'Error al reprogramar cita');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al reprogramar la cita');
  }

  const descTimeline = isSolicitante
    ? 'Solicitante propuso una nueva fecha de visita'
    : 'Cita reprogramada';

  await registrarTimelineCita(
    cita.expediente_id as string,
    descTimeline,
    userId,
    { cita_id: id, fecha_anterior: fechaAnterior, fecha_nueva: input.fecha_confirmada },
  );

  if (isSolicitante) {
    // Aviso al propietario igual que cita recien solicitada.
    notificarCitaCreada(
      id,
      cita.expediente_id as string,
      input.fecha_confirmada,
      false,
    ).catch((e) =>
      logger.warn({ error: e, citaId: id }, 'Error al notificar reprogramacion del solicitante'),
    );
  } else {
    // Aviso 'reprogramada' al solicitante (siempre, porque la fecha se movio).
    notificarCitaConfirmada(
      id,
      cita.expediente_id as string,
      fechaAnterior,
      input.fecha_confirmada,
      input.notas_propietario,
    ).catch((e) => logger.warn({ error: e, citaId: id }, 'Error al notificar reprogramacion de cita'));
  }

  logger.info({ citaId: id, userRol, isSolicitante }, 'Cita reprogramada');
  return data;
}

// ============================================================
// Acusar reprogramacion (solicitante acepta la nueva fecha)
//
// No cambia el estado (sigue 'confirmada'); solo registra el acuse para que
// el banner del frontend desaparezca. Notifica al propietario que el
// solicitante ya esta al tanto del nuevo horario.
// ============================================================

export async function acusarReprogramacion(id: string, userId: string, userRol: string) {
  const cita = await fetchCita(id);

  // Solo el solicitante (creador del expediente) puede acusar. assertCitaPermission
  // con action='read' valida pertenencia + admin/operador como fallback.
  await assertCitaPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId: cita.expediente_id as string,
    action: 'read',
    citaCreadoPor: cita.creado_por as string | undefined,
  });

  // Solo aplicable a citas confirmadas con reprogramacion pendiente.
  if (cita.estado !== 'confirmada') {
    throw AppError.badRequest(
      `Solo se puede acusar una cita en estado 'confirmada' (actual: ${cita.estado})`,
      'INVALID_STATE',
    );
  }
  if (cita.acuse_solicitante_at) {
    // Idempotente: no es un error, solo devolvemos el estado actual.
    return cita;
  }

  const { data, error } = await db('citas')
    .update({ acuse_solicitante_at: new Date().toISOString() } as never)
    .eq('id', id)
    .select(CITA_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message, id }, 'Error al acusar reprogramacion');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al confirmar el nuevo horario');
  }

  await registrarTimelineCita(
    cita.expediente_id as string,
    'Solicitante acepto el horario reprogramado',
    userId,
    { cita_id: id },
  );

  // Notificar al propietario in-app que el solicitante esta al tanto.
  notificarPropietarioAcuse(cita.expediente_id as string, cita.fecha_confirmada as string)
    .catch((e) => logger.warn({ error: e, citaId: id }, 'Error notificando acuse al propietario'));

  logger.info({ citaId: id, userId }, 'Solicitante acuso reprogramacion');
  return data;
}

async function notificarPropietarioAcuse(expedienteId: string, fechaConfirmada: string) {
  const ctx = await obtenerContextoExpediente(expedienteId);
  if (!ctx) return;
  const fechaStr = new Date(fechaConfirmada).toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
  notificarUsuario({
    userId: ctx.propietarioUserId,
    tipo: 'cita.acuse_solicitante',
    titulo: 'Solicitante acepto el horario',
    mensaje: `${ctx.solicitanteNombre || 'El solicitante'} confirmo la visita reprogramada para ${fechaStr}.`,
    link: `/expedientes/${ctx.expedienteId}`,
    payload: { expediente_id: ctx.expedienteId, fecha_confirmada: fechaConfirmada },
  });
}

// ============================================================
// Realizar (confirmada → realizada)
// ============================================================

export async function realizarCita(id: string, input: RealizarCitaInput, userId: string, userRol: string) {
  const cita = await fetchCita(id);
  await assertCitaPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId: cita.expediente_id as string,
    action: 'realizar',
    citaCreadoPor: cita.creado_por as string | undefined,
  });
  assertTransition(cita.estado as string, 'realizada');

  const updateData: Record<string, unknown> = {
    estado: 'realizada',
    updated_at: new Date().toISOString(),
  };
  if (input.notas_propietario) updateData.notas_propietario = input.notas_propietario;

  const { data, error } = await db('citas')
    .update(updateData as never)
    .eq('id', id)
    .select(CITA_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message, id }, 'Error al marcar cita como realizada');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al marcar la cita como realizada');
  }

  await registrarTimelineCita(
    cita.expediente_id as string,
    'Cita realizada',
    userId,
    { cita_id: id },
  );

  logger.info({ citaId: id }, 'Cita marcada como realizada');
  return data;
}

// ============================================================
// Cancelar (solicitada|confirmada → cancelada)
// ============================================================

export async function cancelarCita(id: string, input: CancelarCitaInput, userId: string, userRol: string) {
  const cita = await fetchCita(id);
  await assertCitaPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId: cita.expediente_id as string,
    action: 'cancelar',
    citaCreadoPor: cita.creado_por as string | undefined,
  });
  assertTransition(cita.estado as string, 'cancelada');

  const updateData: Record<string, unknown> = {
    estado: 'cancelada',
    motivo_cancelacion: input.motivo_cancelacion,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db('citas')
    .update(updateData as never)
    .eq('id', id)
    .select(CITA_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message, id }, 'Error al cancelar cita');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al cancelar la cita');
  }

  await registrarTimelineCita(
    cita.expediente_id as string,
    `Cita cancelada: ${input.motivo_cancelacion}`,
    userId,
    { cita_id: id, motivo: input.motivo_cancelacion },
  );

  // Avisar a la contraparte (email + notificacion in-app). Fire-and-forget
  // para no bloquear la respuesta — los errores van al logger.
  const fechaCita = (cita.fecha_confirmada || cita.fecha_propuesta) as string;
  notificarCitaCancelada(
    cita.expediente_id as string,
    fechaCita,
    input.motivo_cancelacion,
    userRol,
  ).catch((e) =>
    logger.warn({ error: e, citaId: id }, 'Error al enviar notificacion de cita cancelada'),
  );

  logger.info({ citaId: id }, 'Cita cancelada');
  return data;
}

// ============================================================
// No asistio (confirmada → no_asistio)
// ============================================================

export async function marcarNoAsistio(id: string, userId: string, userRol: string) {
  const cita = await fetchCita(id);
  await assertCitaPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId: cita.expediente_id as string,
    action: 'no_asistio',
    citaCreadoPor: cita.creado_por as string | undefined,
  });
  assertTransition(cita.estado as string, 'no_asistio');

  const updateData: Record<string, unknown> = {
    estado: 'no_asistio',
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db('citas')
    .update(updateData as never)
    .eq('id', id)
    .select(CITA_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message, id }, 'Error al marcar no asistio');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al marcar la cita como no asistida');
  }

  await registrarTimelineCita(
    cita.expediente_id as string,
    'Cita marcada como no asistida',
    userId,
    { cita_id: id },
  );

  logger.info({ citaId: id }, 'Cita marcada como no asistida');
  return data;
}

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  sendCitaSolicitadaPropietarioEmail,
  sendCitaConfirmadaSolicitanteEmail,
  sendCitaReprogramadaSolicitanteEmail,
} from '../orchestrator/orchestrator.emails';
import { assertCitaPermission, resolveAccessibleExpedienteIds } from './citas.permissions';
import { slotEstaDisponible } from '../disponibilidad/disponibilidad.service';
import type { UserRole } from '@/types/auth';
import type {
  CreateCitaInput,
  ConfirmarCitaInput,
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
  creado_por, confirmado_por, created_at, updated_at,
  expediente:expedientes (
    id, numero, estudio_habilitado,
    inmueble:inmuebles (direccion, ciudad),
    solicitante:solicitantes (nombre, apellido, telefono)
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
  solicitanteEmail: string | null;
  solicitanteNombre: string;
  propietarioEmail: string | null;
  propietarioNombre: string;
  inmuebleDireccion: string;
  inmuebleCiudad: string;
}

async function obtenerContextoExpediente(expedienteId: string): Promise<ExpedienteContexto | null> {
  // Obtener expediente con FKs
  const { data: exp } = await db('expedientes')
    .select('id, solicitante_id, inmueble_id')
    .eq('id', expedienteId)
    .single() as { data: { id: string; solicitante_id: string | null; inmueble_id: string } | null };

  if (!exp) return null;

  // Solicitante (puede ser null en expedientes externos no vinculados)
  let solicitanteEmail: string | null = null;
  let solicitanteNombre = '';
  if (exp.solicitante_id) {
    const { data: sol } = await db('solicitantes')
      .select('nombre, apellido, email')
      .eq('id', exp.solicitante_id)
      .single() as { data: { nombre: string; apellido: string; email: string } | null };
    if (sol) {
      solicitanteEmail = sol.email;
      solicitanteNombre = `${sol.nombre} ${sol.apellido}`.trim();
    }
  }

  // Inmueble + propietario
  const { data: inm } = await db('inmuebles')
    .select('direccion, ciudad, propietario_id')
    .eq('id', exp.inmueble_id)
    .single() as { data: { direccion: string; ciudad: string; propietario_id: string } | null };

  if (!inm) return null;

  const { data: perfil } = await db('perfiles')
    .select('nombre, apellido, razon_social')
    .eq('id', inm.propietario_id)
    .single() as { data: { nombre: string; apellido: string; razon_social: string | null } | null };

  let propietarioEmail: string | null = null;
  try {
    const { data: authData } = await supabase.auth.admin.getUserById(inm.propietario_id);
    propietarioEmail = authData?.user?.email || null;
  } catch (e) {
    logger.warn({ error: e, propietarioId: inm.propietario_id }, 'Error al obtener email de propietario');
  }

  const propietarioNombre = perfil?.razon_social || `${perfil?.nombre || ''} ${perfil?.apellido || ''}`.trim();

  return {
    solicitanteEmail,
    solicitanteNombre,
    propietarioEmail,
    propietarioNombre,
    inmuebleDireccion: inm.direccion,
    inmuebleCiudad: inm.ciudad,
  };
}

async function notificarCitaCreada(expedienteId: string, fechaPropuesta: string, autoConfirm: boolean) {
  const ctx = await obtenerContextoExpediente(expedienteId);
  if (!ctx) return;

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
  }
}

async function notificarCitaConfirmada(
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
  notificarCitaCreada(input.expediente_id, input.fecha_propuesta, autoConfirm).catch((e) =>
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
    cita.expediente_id as string,
    cita.fecha_propuesta as string,
    (input.fecha_confirmada || cita.fecha_propuesta) as string,
    input.notas_propietario,
  ).catch((e) => logger.warn({ error: e, citaId: id }, 'Error al enviar notificacion de cita confirmada'));

  logger.info({ citaId: id }, 'Cita confirmada');
  return data;
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

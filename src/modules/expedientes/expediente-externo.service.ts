import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { env } from '@/config/env';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendExpedienteInvitacionEmail } from '../orchestrator/orchestrator.emails';
import type { CrearExpedienteExternoInput } from './expediente-externo.schema';

// ── Type-safe Supabase helper (same pattern as rest of project) ──
const db = (table: string) => (supabase.from(table as string) as ReturnType<typeof supabase.from>);

// ============================================================
// Crear Expediente Externo (invitacion)
// ============================================================

export async function crearExpedienteExterno(input: CrearExpedienteExternoInput, userId: string, ip?: string) {
  const { inmueble_id, email_invitacion, notas } = input;

  // 1. Validar que el inmueble existe
  const { data: inmueble, error: inmuebleError } = await db('inmuebles')
    .select('id, codigo, direccion, ciudad')
    .eq('id', inmueble_id)
    .single();

  if (inmuebleError || !inmueble) {
    throw AppError.badRequest('Inmueble no encontrado. Verifique el ID proporcionado', 'INMUEBLE_NOT_FOUND');
  }

  const inm = inmueble as unknown as { id: string; codigo: string; direccion: string; ciudad: string };

  // 2. Obtener datos del invitador
  const { data: invitador, error: invitadorError } = await db('perfiles')
    .select('id, nombre, apellido')
    .eq('id', userId)
    .single();

  if (invitadorError || !invitador) {
    throw AppError.badRequest('No se pudo obtener informacion del usuario invitador', 'INVITADOR_NOT_FOUND');
  }

  const inv = invitador as unknown as { id: string; nombre: string; apellido: string };

  // 3. Generar token unico de invitacion
  const token = crypto.randomBytes(32).toString('hex');

  // 4. Crear expediente con source='invitacion'
  const insertData: Record<string, unknown> = {
    inmueble_id,
    creado_por: userId,
    source: 'invitacion',
    token_invitacion: token,
    email_invitacion,
  };
  if (notas) insertData.notas = notas;

  const { data, error } = await db('expedientes')
    .insert(insertData as never)
    .select('id, numero, estado, created_at')
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al crear expediente externo');
    if (error.code === '23503') {
      throw AppError.badRequest('Referencia invalida. Verifique los datos proporcionados', 'FK_VIOLATION');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el expediente externo');
  }

  const created = data as unknown as { id: string; numero: string; estado: string };

  // 5. Enviar email de invitacion
  try {
    await sendExpedienteInvitacionEmail({
      email: email_invitacion,
      nombre_invitador: `${inv.nombre} ${inv.apellido}`,
      inmueble: inm.direccion,
      ciudad: inm.ciudad,
      token,
      frontend_url: env.FRONTEND_URL,
    });
  } catch (emailError) {
    logger.error({ error: emailError, expedienteId: created.id }, 'Error al enviar email de invitacion (expediente ya creado)');
  }

  // 6. Registrar evento en timeline
  await db('eventos_timeline')
    .insert({
      expediente_id: created.id,
      tipo: 'creacion',
      descripcion: `Expediente externo creado. Invitacion enviada a ${email_invitacion}`,
      usuario_id: userId,
    } as never);

  // 7. Audit log
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.EXPEDIENTE_CREATED,
    entidad: AUDIT_ENTITIES.EXPEDIENTE,
    entidadId: created.id,
    detalle: {
      numero: created.numero,
      inmueble_id,
      source: 'invitacion',
      email_invitacion,
    },
    ip,
  });

  logger.info({ expedienteId: created.id, email_invitacion }, 'Expediente externo creado con invitacion');

  return created;
}

// ============================================================
// Vincular Expediente Externo (token → solicitante)
// ============================================================

export async function vincularExpedienteExterno(token: string, solicitanteId: string) {
  // 1. Buscar expediente por token_invitacion
  const { data: expediente, error: findError } = await db('expedientes')
    .select('id, numero, estado, solicitante_id, token_invitacion, email_invitacion')
    .eq('token_invitacion', token)
    .single();

  if (findError || !expediente) {
    throw AppError.notFound('Invitacion no encontrada o token invalido');
  }

  const exp = expediente as unknown as {
    id: string;
    numero: string;
    estado: string;
    solicitante_id: string | null;
    token_invitacion: string | null;
    email_invitacion: string | null;
  };

  // 2. Validar que el expediente no tenga ya un solicitante asignado
  if (exp.solicitante_id) {
    throw AppError.badRequest('Este expediente ya tiene un solicitante asignado', 'EXPEDIENTE_YA_VINCULADO');
  }

  // 3. Actualizar expediente: asignar solicitante, limpiar token, habilitar estudio
  const { error: updateError } = await db('expedientes')
    .update({
      solicitante_id: solicitanteId,
      token_invitacion: null,
      estudio_habilitado: true,
    } as never)
    .eq('id', exp.id);

  if (updateError) {
    logger.error({ error: updateError.message, expedienteId: exp.id }, 'Error al vincular expediente externo');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al vincular el expediente');
  }

  // 4. Registrar evento en timeline
  await db('eventos_timeline')
    .insert({
      expediente_id: exp.id,
      tipo: 'estado',
      descripcion: `Solicitante vinculado via invitacion externa. Estudio habilitado.`,
      usuario_id: solicitanteId,
      metadata: { via: 'invitacion_externa', email_invitacion: exp.email_invitacion },
    } as never);

  logger.info({ expedienteId: exp.id, solicitanteId }, 'Expediente externo vinculado con solicitante');

  // 5. Retornar expediente actualizado
  const { data: updated, error: getError } = await db('expedientes')
    .select('id, numero, estado, solicitante_id, estudio_habilitado, created_at, updated_at')
    .eq('id', exp.id)
    .single();

  if (getError || !updated) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener expediente actualizado');
  }

  return updated;
}

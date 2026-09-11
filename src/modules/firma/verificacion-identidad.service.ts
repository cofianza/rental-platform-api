/**
 * Verificacion de identidad antes de la FIRMA del contrato — Adenda 2 §9.
 *
 * Con FIRMA_BIOMETRIA_ENABLED, "Enviar a firma" ya no crea el sobre de Auco de
 * inmediato: le manda al arrendatario un correo a /verificar-identidad/:token.
 * Ahi lee el consentimiento aprobado (§9.2) completo y elige UNA de dos
 * casillas (§9.3). Si autoriza, se coteja su selfie contra su cedula
 * (AucoFace) con UMBRAL_SIMILITUD_BIOMETRICA del panel.
 *
 * NUNCA RECHAZA. Pase lo que pase (verificada, no coincide, Auco caido,
 * prefiere al analista), al terminar se crea el sobre y el contrato sigue:
 * no espera al analista. Si el cotejo no quedo limpio, un analista de Cofianza
 * verifica por otro medio y registra el resultado; si detecta suplantacion,
 * cancela el contrato.
 *
 * Hoy solo el arrendatario: el co-titular no firma en Auco (hueco anterior a
 * la Adenda). La tabla ya admite rol 'cotitular' para cuando firme.
 *
 * LAS IMAGENES NO SE GUARDAN: entran por el body, van a Auco y mueren con el
 * request. Se guarda el veredicto y el `code` de Auco (ver biometria.ts).
 */

import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { getCalibracion } from '@/lib/calibracion';
import { sendFirmaEmail } from '@/lib/email';
import { notificarUsuario } from '@/modules/notificaciones/notificaciones.service';
import {
  biometriaOmitida,
  biometriaSinCotejo,
  cotejarConAuco,
  leerResumenBiometria,
  requiereRevisionManualPorBiometria,
} from '@/modules/autorizaciones/biometria';
import type { ResumenBiometria } from '@/modules/autorizaciones/biometria';
import type { AuthUser } from '@/types/auth';
import { derivarFirmantes, evaluarFirmantes, crearSolicitudFirmaMultiparte } from './firma-multiparte.service';

const TABLA = 'firma_verificacion_identidad';
const TOKEN_EXPIRY_HOURS = 72;

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

/**
 * Texto aprobado por la Gerencia (Adenda 2 §9.2), literal. Si cambia una sola
 * palabra, cambia la version: cada fila guarda la version y el texto que vio.
 */
export const CONSENTIMIENTO_FIRMA = {
  version: 'adenda2-9.2-v1',
  parrafos: [
    'Para confirmar que eres tú quien está firmando este contrato, necesitamos comparar una fotografía tuya con la de tu documento de identidad. Esta comparación se hace de forma automática y solo para verificar tu identidad.',
    'Tu fotografía es un dato biométrico, que la ley clasifica como dato sensible. Por eso te informamos que no estás obligado a autorizar su tratamiento. Si prefieres no hacerlo, puedes continuar y un analista verificará tu identidad por otro medio, sin que eso afecte tu trámite.',
    'Si autorizas, COFIANZA S.A.S., NIT 902.038.122, tratará tu fotografía únicamente para verificar tu identidad en este proceso. No se comparte con la inmobiliaria ni con terceros, y se conserva por el tiempo necesario para el trámite y su respaldo probatorio. Puedes consultar, actualizar o solicitar la supresión de tus datos escribiendo a nuestro canal de atención.',
  ],
  opciones: {
    autoriza: 'Autorizo la verificación de mi identidad mediante comparación facial.',
    analista: 'Prefiero que un analista verifique mi identidad por otro medio.',
  },
} as const;

const TEXTO_PRESENTADO = [
  ...CONSENTIMIENTO_FIRMA.parrafos,
  `[ ] ${CONSENTIMIENTO_FIRMA.opciones.autoriza}`,
  `[ ] ${CONSENTIMIENTO_FIRMA.opciones.analista}`,
].join('\n\n');

type EstadoVerificacion = 'pendiente' | 'verificada' | 'no_coincide' | 'no_verificada' | 'omitida';

interface VerificacionRow {
  id: string;
  contrato_id: string;
  nombre: string;
  tipo_documento: string | null;
  numero_documento: string | null;
  token_expiracion: string;
  enviado_por: string | null;
  estado: EstadoVerificacion;
  opcion: 'autoriza' | 'analista' | null;
  resultado: unknown;
  revision: 'confirmada' | 'suplantacion' | null;
}

const SELECT = 'id, contrato_id, nombre, tipo_documento, numero_documento, token_expiracion, enviado_por, estado, opcion, resultado, revision';

/** Terminada y sin cotejo limpio: la tiene que mirar un analista. */
function requiereAnalista(v: { estado: string; resultado: unknown }): boolean {
  return v.estado !== 'pendiente' && requiereRevisionManualPorBiometria(leerResumenBiometria(v.resultado)) !== null;
}

async function contextoContrato(contratoId: string) {
  const { data } = await db('contratos')
    .select('expedientes(numero, inmuebles!expedientes_inmueble_id_fkey(direccion, ciudad))')
    .eq('id', contratoId)
    .maybeSingle();
  const exp = (data as {
    expedientes: { numero: string; inmuebles: { direccion: string; ciudad: string } | null } | null;
  } | null)?.expedientes;
  return {
    numero: exp?.numero ?? '',
    direccion: exp?.inmuebles?.direccion ?? '',
    ciudad: exp?.inmuebles?.ciudad ?? '',
  };
}

// ============================================================
// "Enviar a firma" — inicia (o reenvia) la verificacion
// ============================================================

/**
 * `pendiente: false` = el arrendatario ya paso por la verificacion y el sobre
 * puede salir. Si no, crea/renueva el enlace y le escribe.
 */
export async function iniciarVerificacionIdentidad(
  contratoId: string,
  userId: string,
): Promise<{ pendiente: boolean; message: string }> {
  const { data: prevRow } = await db(TABLA)
    .select('id, estado')
    .eq('contrato_id', contratoId)
    .eq('rol', 'arrendatario')
    .maybeSingle();
  const prev = prevRow as { id: string; estado: EstadoVerificacion } | null;
  if (prev && prev.estado !== 'pendiente') return { pendiente: false, message: '' };

  // Las mismas reglas del sobre (telefono y correo de cada firmante), AHORA:
  // que falle antes de que el arrendatario se tome la foto, no despues.
  const firmantes = await derivarFirmantes(contratoId);
  if (!evaluarFirmantes(firmantes).puede_enviar) {
    throw AppError.badRequest(
      'A un firmante le falta teléfono o correo, o dos firmantes comparten teléfono. Corrígelo antes de enviar a firma.',
      'FIRMANTE_DATOS_INCOMPLETOS',
    );
  }
  const arrendatario = firmantes.find((f) => f.rol_firmante === 'arrendatario')!;

  // Token nuevo en cada envio: el enlace anterior deja de servir.
  const ahora = new Date();
  const campos = {
    nombre: arrendatario.nombre,
    email: arrendatario.email,
    tipo_documento: arrendatario.tipo_documento,
    numero_documento: arrendatario.numero_documento,
    token: crypto.randomBytes(32).toString('hex'),
    token_expiracion: new Date(ahora.getTime() + TOKEN_EXPIRY_HOURS * 3600 * 1000).toISOString(),
    enviado_por: userId,
    updated_at: ahora.toISOString(),
  };
  const { error } = prev
    ? await db(TABLA).update(campos as never).eq('id', prev.id)
    : await db(TABLA).insert({ contrato_id: contratoId, rol: 'arrendatario', ...campos } as never);
  if (error) {
    throw new AppError(500, 'INTERNAL_ERROR', `No se pudo iniciar la verificación de identidad: ${error.message}`);
  }

  const ctx = await contextoContrato(contratoId);
  await sendFirmaEmail(
    arrendatario.email,
    arrendatario.nombre,
    `${env.FRONTEND_URL}/verificar-identidad/${campos.token}`,
    TOKEN_EXPIRY_HOURS,
    { direccion_inmueble: ctx.direccion || 'N/A', ciudad_inmueble: ctx.ciudad, nombre_arrendatario: arrendatario.nombre },
    {
      asunto: 'Confirma tu identidad para firmar tu contrato - Cofianza',
      intro: 'antes de firmar tu contrato de arrendamiento necesitamos confirmar que eres tú. Toma menos de dos minutos; al terminar te llega por WhatsApp el enlace para firmar.',
      boton: 'Confirmar mi identidad',
    },
  );

  logger.info({ contratoId, reenvio: !!prev }, 'Verificacion de identidad: enlace enviado al arrendatario');
  return {
    pendiente: true,
    message: prev
      ? 'Le reenviamos al arrendatario el enlace para confirmar su identidad.'
      : 'Le enviamos al arrendatario un correo para confirmar su identidad. Apenas lo haga, le llega el contrato para firmar por WhatsApp.',
  };
}

// ============================================================
// Pagina publica /verificar-identidad/:token
// ============================================================

async function porToken(token: string): Promise<VerificacionRow> {
  const { data } = await db(TABLA).select(SELECT).eq('token', token).maybeSingle();
  if (!data) throw AppError.notFound('Este enlace no es válido.', 'VERIFICACION_NO_ENCONTRADA');
  const v = data as VerificacionRow;
  if (v.estado === 'pendiente' && new Date(v.token_expiracion) < new Date()) {
    throw new AppError(410, 'ENLACE_EXPIRADO', 'El enlace venció. Pídele a quien te arrienda que te envíe uno nuevo.');
  }
  return v;
}

async function pendientePorToken(token: string): Promise<VerificacionRow> {
  const v = await porToken(token);
  if (v.estado !== 'pendiente') {
    throw AppError.conflict('Ya confirmaste tu identidad. El enlace para firmar te llega por WhatsApp.', 'VERIFICACION_COMPLETADA');
  }
  return v;
}

export async function getVerificacionPublica(token: string) {
  const v = await porToken(token);
  const ctx = await contextoContrato(v.contrato_id);
  return {
    nombre: v.nombre,
    inmueble: [ctx.direccion, ctx.ciudad].filter(Boolean).join(', '),
    completada: v.estado !== 'pendiente',
    consentimiento: CONSENTIMIENTO_FIRMA,
  };
}

/** §9.3: queda la opcion, la fecha y hora, la IP, el dispositivo y el texto exacto. */
export async function registrarConsentimiento(
  token: string,
  opcion: 'autoriza' | 'analista',
  meta: { ip?: string; dispositivo?: string },
): Promise<{ completada: boolean }> {
  const v = await pendientePorToken(token);
  const ahora = new Date().toISOString();
  const { error } = await db(TABLA)
    .update({
      opcion,
      opcion_en: ahora,
      ip: meta.ip ?? null,
      dispositivo: meta.dispositivo?.slice(0, 1000) ?? null,
      texto_version: CONSENTIMIENTO_FIRMA.version,
      texto: TEXTO_PRESENTADO,
      updated_at: ahora,
    } as never)
    .eq('id', v.id);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo registrar tu elección. Intenta de nuevo.');

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.FIRMA_IDENTIDAD_CONSENTIMIENTO,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: v.contrato_id,
    detalle: { verificacion_id: v.id, opcion, texto_version: CONSENTIMIENTO_FIRMA.version, dispositivo: meta.dispositivo ?? null },
    ip: meta.ip,
  });

  if (opcion === 'analista') {
    const { UMBRAL_SIMILITUD_BIOMETRICA } = await getCalibracion();
    await finalizar(v, biometriaOmitida(ahora, UMBRAL_SIMILITUD_BIOMETRICA));
    return { completada: true };
  }
  return { completada: false };
}

/** Copy para la persona. Sin cifras (son el parametro antifraude) ni dramatismo. */
function mensajePersona(r: ResumenBiometria): string {
  return r.estado === 'no_coincide'
    ? 'No pudimos confirmar que la foto y el documento sean de la misma persona. Puedes intentarlo de nuevo con mejor luz, o continuar: un analista de Cofianza verificará tu identidad por otro medio.'
    : 'No pudimos completar la verificación. Puedes intentarlo de nuevo o continuar: un analista de Cofianza verificará tu identidad por otro medio.';
}

/**
 * Un intento de cotejo. Si queda limpio, termina y sale el sobre. Si no, la
 * persona puede reintentar (acotado por el limiter por token: cada llamada se
 * factura en Auco) o continuar sin verificar.
 */
export async function verificarBiometriaFirma(
  token: string,
  imagenes: { documentImage: string; photo: string },
): Promise<{ completada: boolean; motivo: string | null }> {
  const v = await pendientePorToken(token);
  if (v.opcion !== 'autoriza') {
    throw AppError.badRequest('Primero marca que autorizas la verificación con foto.', 'SIN_CONSENTIMIENTO');
  }

  const { UMBRAL_SIMILITUD_BIOMETRICA } = await getCalibracion();
  const resumen = await cotejarConAuco(
    v.id,
    { tipo_documento: v.tipo_documento, numero_documento: v.numero_documento, ...imagenes },
    UMBRAL_SIMILITUD_BIOMETRICA,
  );

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.FIRMA_IDENTIDAD_BIOMETRIA,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: v.contrato_id,
    detalle: {
      verificacion_id: v.id,
      estado: resumen.estado,
      similitud: resumen.similitud,
      umbral: resumen.umbral,
      documento_coincide: resumen.documento_coincide,
      auco_code: resumen.code,
    },
  });

  if (requiereRevisionManualPorBiometria(resumen) === null) {
    await finalizar(v, resumen);
    return { completada: true, motivo: null };
  }
  await db(TABLA)
    .update({ resultado: resumen as unknown, updated_at: new Date().toISOString() } as never)
    .eq('id', v.id);
  return { completada: false, motivo: mensajePersona(resumen) };
}

/** Sigue sin cotejo limpio: con el ultimo intento, o sin ninguno. */
export async function continuarSinVerificar(token: string): Promise<{ completada: boolean }> {
  const v = await pendientePorToken(token);
  const { UMBRAL_SIMILITUD_BIOMETRICA } = await getCalibracion();
  const resumen =
    leerResumenBiometria(v.resultado) ??
    biometriaSinCotejo('La persona siguió sin completar el cotejo con foto.', UMBRAL_SIMILITUD_BIOMETRICA);
  await finalizar(v, resumen);
  return { completada: true };
}

/**
 * Cierra la verificacion y saca el sobre. El UPDATE solo pasa de 'pendiente'
 * (dos pestanas no la cierran dos veces). Un fallo de Auco no se le muestra a
 * la persona —ella ya hizo su parte—: se le avisa a quien envio el contrato.
 */
async function finalizar(v: VerificacionRow, resumen: ResumenBiometria): Promise<void> {
  const ahora = new Date().toISOString();
  const { data: cerradas } = await db(TABLA)
    .update({ estado: resumen.estado, resultado: resumen as unknown, completada_en: ahora, updated_at: ahora } as never)
    .eq('id', v.id)
    .eq('estado', 'pendiente')
    .select('id');
  if (!cerradas || (cerradas as unknown[]).length === 0) return;

  const ctx = await contextoContrato(v.contrato_id);
  if (requiereRevisionManualPorBiometria(resumen) !== null) {
    const { listOperators } = await import('@/modules/users/users.service');
    const analistas = await listOperators().catch(() => []);
    await Promise.all(
      analistas.map((a) =>
        notificarUsuario({
          userId: a.id,
          tipo: 'firma.identidad_revision',
          titulo: `Verificar identidad para la firma — ${ctx.numero}`,
          mensaje: `${v.nombre}: ${resumen.motivo ?? 'sin cotejo biométrico'}. El contrato sigue su curso; verifica su identidad por otro medio y registra el resultado en el contrato.`,
          link: `/contratos/${v.contrato_id}`,
          payload: { contrato_id: v.contrato_id, verificacion_id: v.id },
        }),
      ),
    );
  }

  try {
    await crearSolicitudFirmaMultiparte(v.contrato_id, v.enviado_por ?? '');
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err);
    logger.error({ contratoId: v.contrato_id, error: detalle }, 'Verificacion de identidad: no se pudo crear el sobre de Auco');
    if (v.enviado_por) {
      await notificarUsuario({
        userId: v.enviado_por,
        tipo: 'contrato.firma_error',
        titulo: `No se pudo enviar el contrato a firma — ${ctx.numero}`,
        mensaje: `El arrendatario ya confirmó su identidad, pero el envío a Auco falló: ${detalle}. Vuelve a enviarlo desde el contrato.`,
        link: `/contratos/${v.contrato_id}`,
      });
    }
  }
}

// ============================================================
// Panel del contrato + revision del analista
// ============================================================

/**
 * Lo que ve cada rol. El gestor (inmobiliaria/propietario) solo sabe si esta
 * pendiente o completada: el resultado del cotejo es de Cofianza (§9.2: "no se
 * comparte con la inmobiliaria"). Tolera que la tabla no exista (migracion sin
 * correr y flag apagado): el panel sigue como antes.
 */
export async function listarVerificaciones(contratoId: string, userRol?: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await db(TABLA)
    .select('id, rol, nombre, email, estado, token_expiracion, opcion, opcion_en, resultado, completada_en, revision, revision_nota, revisado_en')
    .eq('contrato_id', contratoId);
  if (error) return [];
  const interno = ['administrador', 'operador_analista', 'gerencia_consulta'].includes(userRol ?? '');
  return ((data ?? []) as Array<Record<string, unknown> & { estado: string; resultado: unknown }>).map((r) => {
    if (!interno) {
      return { id: r.id, rol: r.rol, nombre: r.nombre, email: r.email, estado: r.estado === 'pendiente' ? 'pendiente' : 'completada', token_expiracion: r.token_expiracion };
    }
    const resumen = leerResumenBiometria(r.resultado);
    return {
      ...r,
      resultado: undefined, // se resume abajo; el JSON completo no hace falta en el panel
      similitud: resumen?.similitud ?? null,
      umbral: resumen?.umbral ?? null,
      motivo: resumen?.motivo ?? null,
      requiere_analista: requiereAnalista(r),
    };
  });
}

/**
 * El analista registra lo que encontro al verificar por otro medio. Con
 * 'suplantacion' se cancela el contrato (Q4, Adenda 2 §9) antes de anotarlo:
 * no queda una suplantacion registrada sobre un contrato vivo.
 */
export async function revisarVerificacion(
  contratoId: string,
  verificacionId: string,
  input: { resultado: 'confirmada' | 'suplantacion'; nota: string },
  user: AuthUser,
): Promise<{ revision: string }> {
  const { data } = await db(TABLA).select(SELECT).eq('id', verificacionId).eq('contrato_id', contratoId).maybeSingle();
  const v = data as VerificacionRow | null;
  if (!v) throw AppError.notFound('Verificación no encontrada', 'VERIFICACION_NO_ENCONTRADA');
  if (v.revision) throw AppError.conflict('Esta verificación ya fue revisada.', 'VERIFICACION_YA_REVISADA');
  if (!requiereAnalista(v)) throw AppError.conflict('Esta verificación no requiere revisión.', 'VERIFICACION_SIN_REVISION');

  if (input.resultado === 'suplantacion') {
    const { data: c } = await db('contratos').select('estado').eq('id', contratoId).single();
    if (!['cancelado', 'finalizado'].includes((c as { estado: string } | null)?.estado ?? '')) {
      const { executeContratoTransition } = await import('@/modules/contratos/contrato-workflow.service');
      await executeContratoTransition(
        contratoId,
        {
          nuevo_estado: 'cancelado',
          comentario: input.nota,
          motivo: 'Suplantación de identidad detectada por Cofianza al verificar la firma (Adenda 2 §9).',
        },
        user,
      );
    }
  }

  const ahora = new Date().toISOString();
  const { error } = await db(TABLA)
    .update({ revision: input.resultado, revision_nota: input.nota, revisado_por: user.id, revisado_en: ahora, updated_at: ahora } as never)
    .eq('id', v.id);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo guardar la revisión.');

  logAudit({
    usuarioId: user.id,
    accion: AUDIT_ACTIONS.FIRMA_IDENTIDAD_REVISADA,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: { verificacion_id: v.id, revision: input.resultado, nota: input.nota, estado_cotejo: v.estado },
  });
  return { revision: input.resultado };
}

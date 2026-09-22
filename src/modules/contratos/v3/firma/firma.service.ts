/**
 * Contratos V3 — firma: acciones sobre el proceso de firma (Entrega 5, diseño
 * §3.6 y §7). Crear el sobre en Auco, reenviarlo desde FIRMA INCOMPLETA,
 * reintentar un envío fallido, cancelar antes de que se complete y armar la
 * vista del contrato fuera de borrador.
 *
 * Sin guard de flag aquí: las rutas del asistente ya exigen
 * CONTRATOS_V3_ENABLED; la cancelación entra por el workflow de contratos y
 * la biometría por su propia página.
 */

import { env } from '@/config';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, logAudit } from '@/lib/auditLog';
import { cancelDocument, getDocumentStatus, uploadDocumentForSignature } from '@/lib/auco';
import { getCalibracion } from '@/lib/calibracion';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { notificarUsuario } from '@/modules/notificaciones/notificaciones.service';
import type { EnvioV3 } from '../asistente.types';
import { construirSignProfile, datosDeFirma, partesCompletas, validarFirmantes, type FirmanteSobre } from './reglas';
import {
  leerContrato,
  leerPartes,
  leerSobre,
  reconciliarSobre,
  transicionar,
  ultimoSobre,
  vigenciaEstudio,
  type Sobre,
} from './reconciliar';

const BUCKET = 'documentos-expedientes';
const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;

/** Tiempo máximo del upload a Auco: el PDF va en base64 y una Ruta B pesa. */
const TIMEOUT_UPLOAD_MS = 120_000;

async function identidadPendientes(contratoId: string): Promise<number> {
  if (!env.FIRMA_BIOMETRIA_ENABLED) return 0;
  const { count, error } = await db('firma_verificacion_identidad')
    .select('id', { count: 'exact', head: true })
    .eq('contrato_id', contratoId)
    .eq('estado', 'pendiente');
  if (error) throw new AppError(500, 'INTERNAL_ERROR', `No se pudo leer la verificación de identidad: ${error.message}`);
  return count ?? 0;
}

async function sobreVivo(contratoId: string): Promise<Sobre | null> {
  const s = await ultimoSobre(contratoId);
  return s && (s.estado === 'creando' || s.estado === 'en_firma') ? s : null;
}

/**
 * Crea el proceso de firma en Auco para un contrato V3 en EN FIRMA con su PDF
 * final ya congelado en `storage_key` (contrato + CRC en la Ruta A; PDF de la
 * inmobiliaria + Anexo + CRC en la B). La usan el envío, el reenvío, el
 * reintento y el cierre de la verificación de identidad.
 *
 * Orden de firma = orden de contrato_partes (arrendatario → coarrendatario(s)
 * → arrendador). Cofianza no firma (§6.4).
 */
export async function crearSobre(contratoId: string, userId: string | null): Promise<Sobre> {
  const c = await leerContrato(contratoId);
  if (!c) throw AppError.notFound('Contrato no encontrado.');
  const { data: fila } = await db('contratos').select('destinacion, storage_key').eq('id', contratoId).maybeSingle();
  const extra = fila as { destinacion: string | null; storage_key: string | null } | null;
  if (!extra?.destinacion) throw AppError.badRequest('Este contrato no es del asistente V3.', 'CONTRATO_NO_ES_V3');
  if (c.estado !== 'pendiente_firma')
    throw AppError.conflict('El contrato no está en firma.', 'CONTRATO_ESTADO_CAMBIADO');
  if (!extra.storage_key) throw new AppError(500, 'CONTRATO_SIN_DOCUMENTO', 'El contrato no tiene documento para firmar.');

  const partes = await leerPartes(contratoId);
  const coarrendatarios = partes.filter((p) => p.rol === 'coarrendatario').length;
  // Un generar concurrente pudo borrar las partes entre la escritura y el cambio de estado.
  if (!partesCompletas(partes, coarrendatarios))
    throw new AppError(500, 'CONTRATO_PARTES_INCOMPLETAS', 'Las partes del contrato quedaron incompletas. Genera de nuevo la vista previa.');
  const fallas = validarFirmantes(partes);
  if (fallas.length)
    throw new AppError(422, 'FIRMANTES_INVALIDOS', 'Hay datos de los firmantes que Auco no acepta.', { fallas });
  if ((await identidadPendientes(contratoId)) > 0)
    throw AppError.conflict('Falta que los firmantes verifiquen su identidad.', 'IDENTIDAD_PENDIENTE');

  const cal = await getCalibracion();
  const expira = new Date(Date.now() + cal.DIAS_EXPIRACION_FIRMA * 86_400_000);
  const ultimo = await ultimoSobre(contratoId);
  const firmantes: FirmanteSobre[] = partes.map((p) => ({ parteId: p.id, estado: 'pendiente' }));
  const { data: creado, error: errIns } = await db('contrato_v3_sobres')
    .insert({
      contrato_id: contratoId,
      intento: (ultimo?.intento ?? 0) + 1,
      estado: 'creando',
      expira_en: expira.toISOString(),
      firmantes,
      enviado_por: userId,
    } as never)
    .select('id')
    .single();
  if (errIns) {
    if ((errIns as { code?: string }).code === '23505')
      throw AppError.conflict('Ya hay un envío a firma en curso para este contrato.', 'FIRMA_YA_EN_CURSO');
    throw new AppError(500, 'INTERNAL_ERROR', `No se pudo registrar el envío: ${errIns.message}`);
  }
  const sobre = (await leerSobre((creado as { id: string }).id))!;

  let code: string;
  try {
    const { data: pdf, error } = await supabase.storage.from(BUCKET).download(extra.storage_key);
    if (error || !pdf) throw new Error(`no se pudo leer el documento: ${error?.message ?? 'sin datos'}`);
    const ruta = c.datos_variables?.documento?.final?.ruta ?? 'A';
    code = await uploadDocumentForSignature(
      {
        email: env.AUCO_SENDER_EMAIL,
        name:
          ruta === 'B'
            ? `${c.numero} · Contrato, Anexo de Condiciones y CRC`
            : `${c.numero} · Contrato de arrendamiento y CRC`,
        subject: `Firma del contrato de arrendamiento ${c.numero}`,
        message: 'Te invitamos a firmar electrónicamente el contrato de arrendamiento. Recibirás un código por WhatsApp.',
        file: Buffer.from(await pdf.arrayBuffer()).toString('base64'),
        signProfile: construirSignProfile(partes),
        expiredDate: expira.toISOString(),
        custom: { cofianza_sobre: sobre.id },
      },
      TIMEOUT_UPLOAD_MS,
    );
  } catch (e) {
    const detalle = e instanceof Error ? e.message : String(e);
    await db('contrato_v3_sobres')
      .update({ estado: 'fallido', motivo: 'AUCO_UPLOAD', motivo_detalle: detalle.slice(0, 500) } as never)
      .eq('id', sobre.id)
      .eq('estado', 'creando');
    logger.error({ contratoId, sobreId: sobre.id, error: detalle }, 'Firma V3: Auco no creó el proceso');
    throw new AppError(502, 'AUCO_UPLOAD_FAILED', `Auco no aceptó el envío: ${detalle.slice(0, 300)}`);
  }

  const { data: act, error: errAct } = await db('contrato_v3_sobres')
    .update({ auco_code: code, estado: 'en_firma' } as never)
    .eq('id', sobre.id)
    .eq('estado', 'creando')
    .select('id');
  if (errAct) {
    // El proceso existe en Auco: el primer webhook (con `custom`) lo adopta.
    logger.error({ contratoId, sobreId: sobre.id, code, error: errAct.message }, 'Firma V3: proceso creado sin registrar');
    throw new AppError(500, 'FIRMA_ENVIADA_SIN_REGISTRO', 'Se envió a firma, pero no quedó registrado. Lo sincronizamos en unos minutos.');
  }
  if (!(act as unknown[] | null)?.length) {
    // Lo cancelaron mientras subía: se anula también en Auco.
    await db('contrato_v3_sobres').update({ auco_code: code } as never).eq('id', sobre.id).is('auco_code', null);
    await cancelDocument(code, { message: 'Contrato cancelado durante el envío', email: env.AUCO_SENDER_EMAIL })
      .then(() => db('contrato_v3_sobres').update({ auco_cancelado_en: new Date().toISOString() } as never).eq('id', sobre.id))
      .catch((e) => logger.warn({ code, e }, 'Firma V3: cancelación pendiente (la retoma el barrido)'));
    throw AppError.conflict('El contrato cambió mientras se enviaba a firma.', 'CONTRATO_ESTADO_CAMBIADO');
  }

  await db('eventos_timeline').insert({
    expediente_id: c.expediente_id,
    tipo: 'contrato',
    descripcion: `Contrato ${c.numero} enviado a firma${sobre.intento > 1 ? ` (intento ${sobre.intento})` : ''}`,
    usuario_id: userId,
    metadata: { contrato_id: contratoId, sobre_id: sobre.id, auco_code: code },
  } as never);
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.FIRMA_SOLICITUD_CREATED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: { v3: true, intento: sobre.intento, auco_code: code, expira: expira.toISOString() },
  });
  return (await leerSobre(sobre.id))!;
}

/**
 * Reenvío desde FIRMA INCOMPLETA (§11.7.5): sobre nuevo con el MISMO PDF
 * congelado, mientras el estudio siga vigente. Todos vuelven a firmar y cuesta
 * un crédito de Auco, pero el vencimiento lo fijamos nosotros y los eventos
 * del sobre anterior no tocan el nuevo. Si falla, vuelve a FIRMA INCOMPLETA.
 */
export async function reenviar(contratoId: string, userId: string): Promise<void> {
  const c = await leerContrato(contratoId);
  if (!c) throw AppError.notFound('Contrato no encontrado.');
  if (c.estado !== 'firma_incompleta')
    throw AppError.conflict('Solo se reenvía un contrato con la firma incompleta.', 'ESTADO_NO_PERMITE_REENVIO');
  const vig = await vigenciaEstudio(c);
  if (!vig?.vigente)
    throw AppError.conflict('El estudio ya no está vigente: se requiere una nueva evaluación.', 'CRC_VENCIDO');
  // La transición es el mutex: el segundo clic recibe "Transicion no permitida".
  const { error } = await (supabase as unknown as {
    rpc: (f: string, a: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  }).rpc('transicionar_contrato', {
    p_contrato_id: contratoId,
    p_nuevo_estado: 'pendiente_firma',
    p_descripcion: 'Reenviado a firma',
    p_usuario_id: userId,
    p_comentario: null,
    p_motivo: null,
  });
  if (error) throw AppError.conflict('El contrato cambió; recarga la página.', 'CONTRATO_ESTADO_CAMBIADO');
  try {
    await crearSobre(contratoId, userId);
  } catch (e) {
    if (e instanceof AppError && e.errorCode === 'FIRMA_ENVIADA_SIN_REGISTRO') throw e;
    await transicionar(contratoId, 'firma_incompleta', `Reenvío fallido: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500), userId);
    throw e;
  }
}

/** EN FIRMA sin sobre vivo (Auco falló después de la biometría, o el sobre quedó huérfano). */
export async function reintentar(contratoId: string, userId: string): Promise<void> {
  const c = await leerContrato(contratoId);
  if (!c) throw AppError.notFound('Contrato no encontrado.');
  if (c.estado !== 'pendiente_firma') throw AppError.conflict('El contrato no está en firma.', 'CONTRATO_ESTADO_CAMBIADO');
  if (await sobreVivo(contratoId)) throw AppError.conflict('Ya hay un envío a firma en curso.', 'FIRMA_YA_EN_CURSO');
  await crearSobre(contratoId, userId);
}

/**
 * La verificación de identidad de una persona se cerró (verificacion-identidad
 * .finalizar): si ya no queda ninguna pendiente, sale el sobre. Si Auco falla,
 * avisa a quien envió; el contrato queda EN FIRMA con "Reintentar".
 */
export async function continuarTrasIdentidad(contratoId: string, userId: string | null): Promise<void> {
  if ((await identidadPendientes(contratoId)) > 0) return;
  if (await sobreVivo(contratoId)) return;
  try {
    await crearSobre(contratoId, userId);
  } catch (e) {
    if (e instanceof AppError && e.errorCode === 'FIRMA_YA_EN_CURSO') return;
    logger.error({ contratoId, error: e instanceof Error ? e.message : String(e) }, 'Firma V3: no salió el sobre tras la verificación');
    if (userId)
      await notificarUsuario({
        userId,
        tipo: 'firma.envio_fallido',
        titulo: 'No se pudo enviar el contrato a firma',
        mensaje: 'La verificación de identidad terminó, pero Auco no aceptó el envío. Revísalo y reintenta desde el contrato.',
        link: '/contratos',
        payload: { contrato_id: contratoId },
      });
  }
}

/**
 * Cancelar antes de que se complete la firma (§11.5). Se llama desde el
 * workflow de contratos ANTES de la transición a `cancelado`. El sobre se marca
 * cancelado ANTES de ir a Auco: así el REJECTED con que Auco confirma la
 * cancelación encuentra el sobre fuera de `en_firma` y se ignora.
 * Nunca deja un CANCELADO con la firma completa en Auco.
 */
export async function cancelarFirmaV3(contratoId: string): Promise<void> {
  const ultimo = await ultimoSobre(contratoId);
  if (!ultimo) return;
  if (ultimo.estado === 'completo')
    throw AppError.conflict('Todas las partes ya firmaron: la fianza está activa.', 'FIRMA_COMPLETA');
  if (ultimo.estado !== 'creando' && ultimo.estado !== 'en_firma') return; // incompleta o sin sobre vivo: nada en Auco

  const { data: marcado } = await db('contrato_v3_sobres')
    .update({ estado: 'cancelado', motivo: 'CANCELADO' } as never)
    .eq('id', ultimo.id)
    .in('estado', ['creando', 'en_firma'])
    .select('id');
  if (!(marcado as unknown[] | null)?.length)
    throw AppError.conflict('El proceso de firma cambió; recarga la página.', 'CONTRATO_ESTADO_CAMBIADO');
  if (!ultimo.auco_code) return; // 'creando': crearSobre ve el CAS perdido y cancela en Auco al volver

  try {
    await cancelDocument(ultimo.auco_code, { message: 'Contrato cancelado por la inmobiliaria', email: env.AUCO_SENDER_EMAIL });
    await db('contrato_v3_sobres').update({ auco_cancelado_en: new Date().toISOString() } as never).eq('id', ultimo.id);
  } catch (e) {
    const info = await getDocumentStatus(ultimo.auco_code).catch(() => null);
    if (info?.status === 'REJECTED' || info?.status === 'EXPIRED') return; // ya cerrado en Auco
    // No se pudo anular: el sobre vuelve a estar en firma.
    await db('contrato_v3_sobres')
      .update({ estado: 'en_firma', motivo: null } as never)
      .eq('id', ultimo.id)
      .eq('estado', 'cancelado');
    if (info?.status === 'FINISH') {
      await reconciliarSobre(ultimo.id);
      throw AppError.conflict('Todas las partes ya firmaron: la fianza quedó activa.', 'CONTRATO_YA_FIRMADO');
    }
    logger.warn({ contratoId, error: e instanceof Error ? e.message : String(e) }, 'Firma V3: Auco no anuló el proceso');
    throw new AppError(502, 'AUCO_NO_DISPONIBLE', 'No pudimos anular el proceso en Auco; intenta en unos minutos.');
  }
}

/** Reconciliar a pedido (botón "Actualizar estado"). */
export async function actualizarFirma(contratoId: string): Promise<void> {
  const s = await ultimoSobre(contratoId);
  if (!s) throw AppError.notFound('Este contrato no tiene un proceso de firma.', 'SIN_SOBRE_ACTIVO');
  await reconciliarSobre(s.id);
}

/**
 * Vista del contrato V3 fuera de borrador (EN FIRMA, FIRMA INCOMPLETA,
 * FIANZA ACTIVA). Sin evaluar bloqueos: a los 61 días una fianza activa no
 * debe mostrar "estudio vencido".
 */
export async function estadoEnviado(contratoId: string): Promise<EnvioV3 | null> {
  const c = await leerContrato(contratoId);
  if (!c || !['pendiente_firma', 'firma_incompleta', 'vigente'].includes(c.estado)) return null;
  const [s, partes, pendientes, vig] = await Promise.all([
    ultimoSobre(contratoId),
    leerPartes(contratoId),
    identidadPendientes(contratoId),
    vigenciaEstudio(c),
  ]);
  const parte = new Map(partes.map((p) => [p.id, p]));
  const incompleto = c.estado === 'firma_incompleta' && s?.estado === 'incompleto' ? s : null;
  const textoAviso = incompleto?.aviso_detalle?.texto;
  const vivo = s && (s.estado === 'creando' || s.estado === 'en_firma');
  return {
    id: c.id,
    numero: c.numero,
    ruta: c.datos_variables?.documento?.final?.ruta ?? 'A',
    estado: c.estado as EnvioV3['estado'],
    fechaActivacion: c.fecha_firma,
    sobre: s && {
      intento: s.intento,
      estado: s.estado,
      enviadoEn: s.created_at,
      expiraEn: s.expira_en,
      motivo: s.motivo,
      motivoDetalle: s.motivo_detalle,
      firmantes: s.firmantes.map((f) => {
        const p = parte.get(f.parteId);
        return {
          rol: p?.rol ?? 'arrendatario',
          nombre: p ? datosDeFirma(p).nombre : '—',
          orden: p?.orden ?? 0,
          estado: f.estado,
          firmadoEn: f.firmadoEn ?? null,
        };
      }),
    },
    aviso:
      incompleto?.aviso_entregado_en && typeof textoAviso === 'string'
        ? { texto: textoAviso, entregadoEn: incompleto.aviso_entregado_en }
        : null,
    identidadPendientes: pendientes,
    reenvio:
      c.estado !== 'firma_incompleta'
        ? { puede: false, motivo: null }
        : vig?.vigente
          ? { puede: true, motivo: null }
          : { puede: false, motivo: 'El estudio ya no está vigente: se requiere una nueva evaluación.' },
    reintento: c.estado === 'pendiente_firma' && !vivo && pendientes === 0,
  };
}

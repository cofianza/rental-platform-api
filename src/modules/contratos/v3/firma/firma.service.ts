/**
 * Contratos V3 — firma: acciones sobre el proceso de firma (Entrega 5, diseño
 * §3.6 y §7). Crear el sobre en Auco, reenviarlo desde FIRMA INCOMPLETA,
 * reintentar un envío fallido, cancelar antes de que se complete y armar la
 * vista del contrato fuera de borrador. Adenda 1 del módulo de contratos:
 * prorrogar el plazo una vez (respuesta 10) y el acuse del aviso de firma
 * incompleta (respuesta 11).
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
import { resolveMembershipInmobiliariaIds, resolveRolMiembro } from '@/lib/tenantScope';
import { leerCierreSinActa } from '@/modules/expedientes/cierre-sin-acta';
import { notificarUsuario } from '@/modules/notificaciones/notificaciones.service';
import type { EnvioV3 } from '../asistente.types';
import { fechaBogota, periodoVigente, sumarMeses } from '../formato';
import {
  construirSignProfile,
  datosDeFirma,
  exigirPlazoDeFirma,
  faltanMarcas,
  fechaHora,
  firmantesDePartes,
  motivoSinMarcas,
  motivoSinPlazo,
  partesCompletas,
  plazoDeFirma,
  posicionesDeFirma,
  prorrogaDelPlazo,
  validarFirmantes,
  type FirmanteSobre,
} from './reglas';
import {
  activarContrato,
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

/** Algún sobre firmado por todas las partes (aunque la activación haya quedado a medias). */
async function sobreCompleto(contratoId: string): Promise<{ id: string } | null> {
  const { data, error } = await db('contrato_v3_sobres')
    .select('id')
    .eq('contrato_id', contratoId)
    .eq('estado', 'completo')
    .limit(1)
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo leer el proceso de firma.');
  return (data as { id: string } | null) ?? null;
}

/** Con la firma completa en algún sobre no se reintenta ni se cancela: se termina de activar (§11.5). */
async function exigirSinFirmaCompleta(contratoId: string): Promise<void> {
  const completo = await sobreCompleto(contratoId);
  if (!completo) return;
  const s = await leerSobre(completo.id);
  if (s) await activarContrato(s).catch((e) => logger.warn({ contratoId, e }, 'Firma V3: activación pendiente (la retoma el barrido)'));
  throw AppError.conflict('Todas las partes ya firmaron: la fianza queda activa.', 'FIRMA_COMPLETA');
}

/** Solo se reintenta si no hubo proceso o el último no llegó a Auco (fallido) o se anuló. */
const reintentable = (s: Sobre | null) => !s || s.estado === 'fallido' || s.estado === 'cancelado';

/** Un instante → 'dd/mm/aaaa' en Bogotá. */
const ddmmaaaa = (ms: number) => fechaBogota(new Date(ms)).split('-').reverse().join('/');

/**
 * Prórroga y acuse (Adenda 1), en un SELECT aparte y tolerante: si la
 * migración 20260930000001 no corrió, nombrar esas columnas haría fallar
 * entera la lectura del sobre (42703) y con ella toda la firma. Sin la
 * migración devuelve null; cualquier otro error, 503.
 */
interface Adenda {
  plazo_prorrogado_en: string | null;
  /** El vencimiento que se le mandó a Auco: la prórroga no lo pasa. */
  auco_expira_en: string | null;
  aviso_aceptado_en: string | null;
  aviso_aceptado_detalle: { nombre?: string } | null;
}

/** Columna que no existe (42703 al leer, PGRST204 al escribir): falta la migración 20260930000001. */
const sinMigracion = (error: unknown) => ['42703', 'PGRST204'].includes((error as { code?: string } | null)?.code ?? '');

async function leerAdenda(sobreId: string): Promise<Adenda | null> {
  const { data, error } = await db('contrato_v3_sobres')
    .select('plazo_prorrogado_en, auco_expira_en, aviso_aceptado_en, aviso_aceptado_detalle')
    .eq('id', sobreId)
    .maybeSingle();
  if (sinMigracion(error)) return null;
  if (error) throw new AppError(503, 'LECTURA_NO_VERIFICABLE', 'No pudimos leer el proceso de firma. Intenta de nuevo en un momento.');
  return (data as Adenda | null) ?? null;
}

/** El vencimiento que se le mandó a Auco (null = sobre anterior a la columna: sin ese tope). */
const topeAuco = (a: Adenda) => (a.auco_expira_en ? Date.parse(a.auco_expira_en) : null);

/** El aviso de §11.7.4 que de verdad se entregó (no una constancia de "omitido"). */
const avisoEntregado = (s: Sobre) => !!s.aviso_entregado_en && typeof s.aviso_detalle?.texto === 'string';

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
  // Ruta B: las firmas sobre el PDF de la inmobiliaria, con las marcas congeladas al enviar (409 si falta
  // alguna). Todos los caminos a Auco pasan por aquí: enviar, reenviar, reintentar y la verificación de identidad.
  const posiciones = posicionesDeFirma(partes, c.datos_variables?.documento?.final);
  if ((await identidadPendientes(contratoId)) > 0)
    throw AppError.conflict('Falta que los firmantes verifiquen su identidad.', 'IDENTIDAD_PENDIENTE');

  // Adenda 1, respuesta 10: el proceso de firma nunca pasa la vigencia del CRC.
  const [cal, vig] = await Promise.all([getCalibracion(), vigenciaEstudio(c)]);
  const plazo = exigirPlazoDeFirma(vig?.fin ?? null, cal.DIAS_EXPIRACION_FIRMA);
  const expira = new Date(plazo.expiraEn);
  const ultimo = await ultimoSobre(contratoId);
  const firmantes: FirmanteSobre[] = partes.map((p) => ({ parteId: p.id, estado: 'pendiente' }));
  const nuevo = {
    contrato_id: contratoId,
    intento: (ultimo?.intento ?? 0) + 1,
    estado: 'creando',
    expira_en: expira.toISOString(),
    firmantes,
    enviado_por: userId,
  };
  const insertar = (f: Record<string, unknown>) => db('contrato_v3_sobres').insert(f as never).select('id').single();
  // El vencimiento de Auco queda para topar la prórroga; sin la migración 20260930000001, sin él.
  let { data: creado, error: errIns } = await insertar({ ...nuevo, auco_expira_en: new Date(plazo.aucoExpira).toISOString() });
  if (sinMigracion(errIns)) ({ data: creado, error: errIns } = await insertar(nuevo));
  if (errIns) {
    if ((errIns as { code?: string }).code === '23505')
      throw AppError.conflict('Ya hay un envío a firma en curso para este contrato.', 'FIRMA_YA_EN_CURSO');
    logger.error({ contratoId, error: errIns.message }, 'Firma V3: no se pudo registrar el sobre');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo registrar el envío a firma. Intenta de nuevo.');
  }
  const sobre = (await leerSobre((creado as { id: string }).id))!;

  // Timeline y bitácora del envío: una sola vez y siempre aquí (donde está el
  // userId), también si el webhook adoptó el proceso antes de que respondiera
  // el upload (la adopción no registra nada). No lanza: el proceso ya salió.
  const registrarEnvio = async (auco: string) => {
    await Promise.resolve(
      db('eventos_timeline').insert({
        expediente_id: c.expediente_id,
        tipo: 'contrato',
        descripcion: `Contrato ${c.numero} enviado a firma${sobre.intento > 1 ? ` (intento ${sobre.intento})` : ''}`,
        usuario_id: userId,
        metadata: { contrato_id: contratoId, sobre_id: sobre.id, auco_code: auco },
      } as never),
    ).catch(() => undefined);
    logAudit({
      usuarioId: userId,
      accion: AUDIT_ACTIONS.FIRMA_SOLICITUD_CREATED,
      entidad: AUDIT_ENTITIES.CONTRATO,
      entidadId: contratoId,
      detalle: {
        v3: true,
        intento: sobre.intento,
        auco_code: auco,
        expira: expira.toISOString(),
        auco_expira: new Date(plazo.aucoExpira).toISOString(),
      },
    });
  };

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
        // Auco vence después (el máximo con la prórroga): el plazo que cuenta se dice aquí.
        message: `Te invitamos a firmar electrónicamente el contrato de arrendamiento. Tienes hasta el ${ddmmaaaa(plazo.expiraEn)} para firmar. Recibirás un código por WhatsApp.`,
        file: Buffer.from(await pdf.arrayBuffer()).toString('base64'),
        signProfile: construirSignProfile(partes, posiciones),
        expiredDate: new Date(plazo.aucoExpira).toISOString(),
        custom: { cofianza_sobre: sobre.id },
      },
      TIMEOUT_UPLOAD_MS,
    );
  } catch (e) {
    const detalle = e instanceof Error ? e.message : String(e);
    const { data: marcado } = await db('contrato_v3_sobres')
      .update({ estado: 'fallido', motivo: 'AUCO_UPLOAD', motivo_detalle: detalle.slice(0, 500) } as never)
      .eq('id', sobre.id)
      .eq('estado', 'creando')
      .select('id');
    if (!(marcado as unknown[] | null)?.length) {
      // Ya no está 'creando': el webhook adoptó el proceso (Auco sí lo creó y el
      // upload solo se demoró) o lo cancelaron mientras subía.
      const ahora = await leerSobre(sobre.id).catch(() => null);
      if (ahora?.estado === 'en_firma' && ahora.auco_code) {
        await registrarEnvio(ahora.auco_code);
        return ahora;
      }
      throw AppError.conflict('El contrato cambió mientras se enviaba a firma.', 'CONTRATO_ESTADO_CAMBIADO');
    }
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
    const ahora = await leerSobre(sobre.id).catch(() => null);
    // El webhook de Auco (CREATE, con `custom`) llegó antes que la respuesta del upload y ya lo adoptó.
    if (ahora?.estado === 'en_firma' && ahora.auco_code === code) {
      await registrarEnvio(code);
      return ahora;
    }
    // Lo cancelaron mientras subía: se anula también en Auco.
    await db('contrato_v3_sobres').update({ auco_code: code } as never).eq('id', sobre.id).is('auco_code', null);
    await cancelDocument(code, { message: 'Contrato cancelado durante el envío', email: env.AUCO_SENDER_EMAIL })
      .then(() => db('contrato_v3_sobres').update({ auco_cancelado_en: new Date().toISOString() } as never).eq('id', sobre.id))
      .catch((e) => logger.warn({ code, e }, 'Firma V3: cancelación pendiente (la retoma el barrido)'));
    throw AppError.conflict('El contrato cambió mientras se enviaba a firma.', 'CONTRATO_ESTADO_CAMBIADO');
  }

  // Desde aquí el proceso ya salió: nada puede lanzar (una reversión lo dejaría vivo en Auco).
  await registrarEnvio(code);
  return (await leerSobre(sobre.id).catch(() => null)) ?? { ...sobre, auco_code: code, estado: 'en_firma' };
}

/**
 * Reenvío desde FIRMA INCOMPLETA (§11.7.5): sobre nuevo con el MISMO PDF
 * congelado, mientras el estudio siga vigente. Todos vuelven a firmar y cuesta
 * un crédito de Auco, pero el vencimiento lo fijamos nosotros y los eventos
 * del sobre anterior no tocan el nuevo. Si falla, vuelve a FIRMA INCOMPLETA.
 * `rol` = el de quien reenvía: la inmobiliaria primero acepta el aviso (Adenda 1, respuesta 11).
 */
export async function reenviar(contratoId: string, userId: string, rol?: string): Promise<void> {
  const c = await leerContrato(contratoId);
  if (!c) throw AppError.notFound('Contrato no encontrado.');
  if (c.estado !== 'firma_incompleta')
    throw AppError.conflict('Solo se reenvía un contrato con la firma incompleta.', 'ESTADO_NO_PERMITE_REENVIO');
  // Ruta B: las marcas congeladas, antes de tocar el contrato (crearSobre lo repite).
  const final = c.datos_variables?.documento?.final;
  if (final?.ruta === 'B') posicionesDeFirma(await leerPartes(contratoId), final);
  // Con FIRMA INCOMPLETA el estudio se puede cerrar o rechazar; reenviar lo
  // activaría (y ocuparía el inmueble) sobre un estudio terminado.
  if (c.expedienteEstado === 'cerrado' || c.expedienteEstado === 'rechazado')
    throw AppError.conflict(
      `El estudio está ${c.expedienteEstado === 'rechazado' ? 'marcado como no aprobable' : 'cerrado'}: el contrato ya no se puede reenviar a firma.`,
      'EXPEDIENTE_CERRADO',
    );
  // Antes de tocar el contrato: al CRC le tiene que alcanzar para un proceso nuevo (crearSobre lo repite).
  const [vig, cal] = await Promise.all([vigenciaEstudio(c), getCalibracion()]);
  exigirPlazoDeFirma(vig?.fin ?? null, cal.DIAS_EXPIRACION_FIRMA);
  if (rol) await exigirAcuseAviso(contratoId, rol);
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
    await transicionar(contratoId, 'firma_incompleta', `Reenvío fallido: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500), userId).catch(
      (err) => logger.error({ contratoId, err }, 'Firma V3: el reenvío falló y el contrato no volvió a FIRMA INCOMPLETA'),
    );
    throw e;
  }
}

/** EN FIRMA sin sobre vivo (Auco falló después de la biometría, o el sobre quedó huérfano). */
export async function reintentar(contratoId: string, userId: string): Promise<void> {
  const c = await leerContrato(contratoId);
  if (!c) throw AppError.notFound('Contrato no encontrado.');
  if (c.estado !== 'pendiente_firma') throw AppError.conflict('El contrato no está en firma.', 'CONTRATO_ESTADO_CAMBIADO');
  await exigirSinFirmaCompleta(contratoId);
  if (!reintentable(await ultimoSobre(contratoId)))
    throw AppError.conflict('El proceso de firma sigue su curso; actualiza el estado.', 'FIRMA_YA_EN_CURSO');
  await crearSobre(contratoId, userId);
}

/**
 * La verificación de identidad de una persona se cerró (verificacion-identidad
 * .finalizar): si ya no queda ninguna pendiente, sale el sobre. Si Auco falla,
 * avisa a quien envió; el contrato queda EN FIRMA con "Reintentar".
 */
export async function continuarTrasIdentidad(contratoId: string, userId: string | null): Promise<void> {
  const c = await leerContrato(contratoId);
  if (c?.estado !== 'pendiente_firma') return; // lo cancelaron o revirtieron mientras verificaban
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
        link: `/expedientes/${c.expediente_id}/contrato`,
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
  await exigirSinFirmaCompleta(contratoId);
  const ultimo = await ultimoSobre(contratoId);
  if (!ultimo) return;
  if (ultimo.estado !== 'creando' && ultimo.estado !== 'en_firma') return; // incompleta o sin sobre vivo: nada en Auco

  const { data: marcado } = await db('contrato_v3_sobres')
    .update({ estado: 'cancelado', motivo: 'CANCELADO' } as never)
    .eq('id', ultimo.id)
    .in('estado', ['creando', 'en_firma'])
    .select('id');
  if (!(marcado as unknown[] | null)?.length)
    throw AppError.conflict('El proceso de firma cambió; recarga la página.', 'CONTRATO_ESTADO_CAMBIADO');
  if (!ultimo.auco_code) return; // 'creando': crearSobre ve el CAS perdido y cancela en Auco al volver

  const marcarCancelado = () =>
    db('contrato_v3_sobres').update({ auco_cancelado_en: new Date().toISOString() } as never).eq('id', ultimo.id);
  try {
    const r = await cancelDocument(ultimo.auco_code, { message: 'Contrato cancelado por la inmobiliaria', email: env.AUCO_SENDER_EMAIL });
    // Auco puede responder 200 con el documento en `errors` (p. ej. si ya estaba firmado).
    if (r?.success === false || (r?.errors?.cant ?? 0) > 0) throw new Error('Auco respondió que no canceló el proceso');
    await marcarCancelado();
  } catch (e) {
    const info = await getDocumentStatus(ultimo.auco_code).catch(() => null);
    if (info?.status === 'REJECTED' || info?.status === 'EXPIRED') {
      await marcarCancelado(); // ya cerrado en Auco: el barrido no tiene nada que reintentar
      return;
    }
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

// ── Adenda 1 del módulo de contratos: prórroga del plazo (respuesta 10) ──

const motivoSinProrroga = (m: 'vencido' | 'crc', finCrc?: number) =>
  m === 'vencido'
    ? 'El plazo para firmar ya venció: en unos minutos el contrato queda con la firma incompleta.'
    : `El proceso de firma no puede pasar la vigencia del certificado de riesgo${finCrc ? ` (vence el ${fechaHora(finCrc)})` : ''}: ya no admite prórroga.`;

/**
 * Una sola prórroga del plazo por proceso de firma, EN FIRMA y antes de que
 * venza: otros DIAS_EXPIRACION_FIRMA, sin pasar la vigencia del CRC. Solo
 * mueve expira_en: en Auco el proceso ya vence en el máximo (crearSobre).
 */
export async function prorrogarPlazo(contratoId: string, userId: string): Promise<void> {
  const c = await leerContrato(contratoId);
  if (!c) throw AppError.notFound('Contrato no encontrado.');
  const s = c.estado === 'pendiente_firma' ? await ultimoSobre(contratoId) : null;
  if (s?.estado !== 'en_firma')
    throw AppError.conflict('Solo se prorroga el plazo de un proceso de firma en curso.', 'SIN_SOBRE_ACTIVO');
  const adenda = await leerAdenda(s.id);
  if (!adenda)
    throw new AppError(503, 'PRORROGA_NO_DISPONIBLE', 'La prórroga del plazo todavía no está disponible. Intenta más tarde.');
  if (adenda.plazo_prorrogado_en)
    throw AppError.conflict('El plazo de este proceso de firma ya se prorrogó: solo se permite una vez.', 'PRORROGA_YA_USADA');
  const [cal, vig] = await Promise.all([getCalibracion(), vigenciaEstudio(c)]);
  const ahora = Date.now();
  const p = prorrogaDelPlazo(Date.parse(s.expira_en), cal.DIAS_EXPIRACION_FIRMA, vig?.fin ?? 0, ahora, topeAuco(adenda));
  if ('motivo' in p) throw AppError.conflict(motivoSinProrroga(p.motivo, vig?.fin), 'PRORROGA_NO_PERMITIDA');

  const hasta = new Date(p.hasta).toISOString();
  // La marca es el mutex: dos clics (o dos miembros) prorrogan una sola vez, y nunca un plazo ya vencido.
  const { data, error } = await db('contrato_v3_sobres')
    .update({ expira_en: hasta, plazo_prorrogado_en: new Date(ahora).toISOString(), plazo_prorrogado_por: userId } as never)
    .eq('id', s.id)
    .eq('estado', 'en_firma')
    .is('plazo_prorrogado_en', null)
    .gt('expira_en', new Date(ahora).toISOString())
    .select('id');
  if (error) {
    logger.error({ contratoId, error: error.message }, 'Firma V3: no se pudo prorrogar el plazo');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo prorrogar el plazo. Intenta de nuevo.');
  }
  if (!(data as unknown[] | null)?.length)
    throw AppError.conflict('El proceso de firma cambió; recarga la página.', 'CONTRATO_ESTADO_CAMBIADO');

  await Promise.resolve(
    db('eventos_timeline').insert({
      expediente_id: c.expediente_id,
      tipo: 'contrato',
      descripcion: `Plazo para firmar el contrato ${c.numero} prorrogado hasta el ${ddmmaaaa(p.hasta)} (única prórroga)`,
      usuario_id: userId,
      metadata: { contrato_id: contratoId, sobre_id: s.id, antes: s.expira_en, despues: hasta },
    } as never),
  ).catch(() => undefined);
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.FIRMA_PLAZO_PRORROGADO,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: { v3: true, sobre_id: s.id, intento: s.intento, antes: s.expira_en, despues: hasta },
  });
}

/** La prórroga como la ve la pantalla: las mismas puertas que prorrogarPlazo. */
function prorrogaVista(
  s: Sobre,
  adenda: Adenda | null,
  vig: { fin: number } | null,
  dias: number,
): NonNullable<EnvioV3['prorroga']> {
  if (!adenda) return { puede: false, motivo: 'La prórroga del plazo todavía no está disponible.', hasta: null, usadaEn: null };
  if (adenda.plazo_prorrogado_en) return { puede: false, motivo: null, hasta: null, usadaEn: adenda.plazo_prorrogado_en };
  const p = prorrogaDelPlazo(Date.parse(s.expira_en), dias, vig?.fin ?? 0, Date.now(), topeAuco(adenda));
  return 'motivo' in p
    ? { puede: false, motivo: motivoSinProrroga(p.motivo, vig?.fin), hasta: null, usadaEn: null }
    : { puede: true, motivo: null, hasta: new Date(p.hasta).toISOString(), usadaEn: null };
}

// ── Adenda 1 del módulo de contratos: acuse del aviso de firma incompleta (respuesta 11) ──

/**
 * El aviso de §11.7.4 exige acuse, con valor probatorio. Lo acepta un miembro de
 * la inmobiliaria del contrato (a ella se le advierte; el mismo criterio que el
 * aviso de las cláusulas adicionales): queda quién, cuándo y desde qué IP, en el
 * mismo sobre que guarda el texto exacto entregado. Si otro miembro ya lo
 * aceptó, no se reescribe.
 */
export async function aceptarAviso(
  contratoId: string,
  u: { id: string; rol: string; email: string; ip?: string },
): Promise<void> {
  const c = await leerContrato(contratoId);
  if (!c) throw AppError.notFound('Contrato no encontrado.');
  if (c.estado !== 'firma_incompleta')
    throw AppError.conflict('Este contrato no tiene un aviso de firma incompleta por aceptar.', 'SIN_AVISO_PENDIENTE');
  const s = await ultimoIncompleto(contratoId);
  if (!s || !avisoEntregado(s))
    throw AppError.conflict(
      'El aviso de firma incompleta todavía se está entregando. Intenta de nuevo en unos minutos.',
      'AVISO_NO_ENTREGADO',
    );
  const miembro =
    u.rol === 'inmobiliaria' &&
    (c.orgId ? (await resolveMembershipInmobiliariaIds(u.id)).includes(c.orgId) : s.enviado_por === u.id);
  if (!miembro)
    throw AppError.forbidden('El aviso lo acepta un miembro de la inmobiliaria del contrato.', 'AVISO_SOLO_INMOBILIARIA');

  const [perfilR, rolMiembro] = await Promise.all([
    db('perfiles').select('nombre, apellido').eq('id', u.id).maybeSingle(),
    resolveRolMiembro(u.id),
  ]);
  const perfil = perfilR.data as { nombre: string | null; apellido: string | null } | null;
  const nombre = `${perfil?.nombre ?? ''} ${perfil?.apellido ?? ''}`.trim() || u.email;
  const textoVersion = (s.aviso_detalle?.texto_version as string | undefined) ?? null;
  const { data, error } = await db('contrato_v3_sobres')
    .update({
      aviso_aceptado_en: new Date().toISOString(),
      aviso_aceptado_por: u.id,
      aviso_aceptado_detalle: { nombre, email: u.email, rolMiembro, ip: u.ip ?? null, textoVersion },
    } as never)
    .eq('id', s.id)
    .is('aviso_aceptado_en', null)
    .select('id');
  if (sinMigracion(error))
    throw new AppError(503, 'ACUSE_NO_DISPONIBLE', 'El registro del acuse todavía no está disponible. Intenta más tarde.');
  if (error) {
    logger.error({ contratoId, error: error.message }, 'Firma V3: no se pudo registrar el acuse del aviso');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo registrar la aceptación. Intenta de nuevo.');
  }
  if (!(data as unknown[] | null)?.length) return; // ya lo aceptó otro miembro: queda el primero

  await Promise.resolve(
    db('eventos_timeline').insert({
      expediente_id: c.expediente_id,
      tipo: 'contrato',
      descripcion: `${nombre} aceptó el aviso de firma incompleta del contrato ${c.numero}: la fianza no está operando`,
      usuario_id: u.id,
      metadata: { contrato_id: contratoId, sobre_id: s.id, texto_version: textoVersion },
    } as never),
  ).catch(() => undefined);
  logAudit({
    usuarioId: u.id,
    accion: AUDIT_ACTIONS.FIRMA_AVISO_ACEPTADO,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: { v3: true, sobre_id: s.id, texto_version: textoVersion, email: u.email },
    ip: u.ip,
  });
}

/**
 * Con la firma incompleta, la inmobiliaria no reenvía, no cancela ni cierra el
 * estudio sin haber aceptado antes el aviso: el acuse es la prueba de que supo
 * que la fianza no estaba operando. No frena a Cofianza (p. ej., la cancelación
 * por suplantación de identidad): el aviso es para la inmobiliaria.
 * La llaman con el contrato en FIRMA INCOMPLETA.
 */
export async function exigirAcuseAviso(contratoId: string, rol: string): Promise<void> {
  if (rol !== 'inmobiliaria') return;
  const s = await ultimoIncompleto(contratoId);
  if (!s) return;
  const adenda = await leerAdenda(s.id);
  if (!adenda) return; // sin la migración no hay dónde registrar el acuse: sigue como antes
  if (!avisoEntregado(s)) {
    if (s.aviso_entregado_en) return; // constancia de "omitido": no hubo aviso que aceptar
    throw AppError.conflict(
      'El aviso de firma incompleta todavía se está entregando. En unos minutos podrás leerlo y aceptarlo en el contrato.',
      'AVISO_NO_ENTREGADO',
    );
  }
  if (!adenda.aviso_aceptado_en)
    throw AppError.conflict(
      'Antes de seguir, lee y acepta el aviso de firma incompleta en el contrato: la fianza no está operando.',
      'AVISO_SIN_ACUSE',
    );
}

/** Cerrar el estudio cancela su contrato V3 con la firma incompleta: la misma puerta. */
export async function exigirAcuseDelEstudio(expedienteId: string, rol: string): Promise<void> {
  if (rol !== 'inmobiliaria') return;
  const { data, error } = await db('contratos')
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .not('destinacion', 'is', null);
  if (error)
    throw new AppError(503, 'LECTURA_NO_VERIFICABLE', 'No pudimos verificar el contrato del estudio. Intenta de nuevo en un momento.');
  for (const c of (data as { id: string; estado: string }[] | null) ?? [])
    if (c.estado === 'firma_incompleta') await exigirAcuseAviso(c.id, rol);
}

/** Las actas de entrega del contrato (§12.2: con una basta para cerrar el estudio), la más reciente primero. */
async function actasDeEntrega(contratoId: string): Promise<{ id: string; nombre: string; subidoEn: string }[]> {
  const { data, error } = await db('contrato_archivos')
    .select('id, nombre_archivo, created_at')
    .eq('contrato_id', contratoId)
    .eq('tipo_archivo', 'acta_entrega')
    .order('created_at', { ascending: false });
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo leer el acta de entrega.');
  return ((data as { id: string; nombre_archivo: string; created_at: string }[] | null) ?? []).map((a) => ({
    id: a.id,
    nombre: a.nombre_archivo,
    subidoEn: a.created_at,
  }));
}

/**
 * Vista del contrato V3 fuera de borrador (EN FIRMA, FIRMA INCOMPLETA,
 * FIANZA ACTIVA, TERMINADO). Sin evaluar bloqueos: a los 61 días una fianza
 * activa no debe mostrar "estudio vencido".
 */
export async function estadoEnviado(contratoId: string): Promise<EnvioV3 | null> {
  const c = await leerContrato(contratoId);
  if (!c || !['pendiente_firma', 'firma_incompleta', 'vigente', 'finalizado'].includes(c.estado)) return null;
  const firmado = c.estado === 'vigente' || c.estado === 'finalizado';
  const [s, partes, pendientes, vig, actas, cierreSinActa] = await Promise.all([
    ultimoSobre(contratoId),
    leerPartes(contratoId),
    identidadPendientes(contratoId),
    vigenciaEstudio(c),
    firmado ? actasDeEntrega(contratoId) : Promise.resolve([]),
    // Adenda 1 contratos (respuesta 21): cerrado sin acta, el acta ya no está pendiente.
    firmado ? leerCierreSinActa(c.expediente_id) : Promise.resolve(null),
  ]);
  const parte = new Map(partes.map((p) => [p.id, p]));
  // El aviso es el del último sobre incompleto: tras un reenvío fallido el último queda 'fallido'.
  const incompleto = c.estado === 'firma_incompleta' ? await ultimoIncompleto(contratoId) : null;
  const aviso = incompleto && avisoEntregado(incompleto) ? incompleto : null;
  const vivo = c.estado === 'pendiente_firma' && s?.estado === 'en_firma' ? s : null;
  const [adendaVivo, adendaAviso, cal] = await Promise.all([
    vivo ? leerAdenda(vivo.id) : null,
    incompleto ? leerAdenda(incompleto.id) : null,
    getCalibracion(),
  ]);
  const sinPlazo = vig ? plazoDeFirma(Date.now(), cal.DIAS_EXPIRACION_FIRMA, vig.fin) : ({ motivo: 'vencido' } as const);
  const ruta = c.datos_variables?.documento?.final?.ruta ?? 'A';
  // Ruta B: las mismas marcas congeladas que exige crearSobre (se congelan completas al enviar).
  const sinMarcas = ruta === 'B' ? faltanMarcas(firmantesDePartes(partes), c.datos_variables?.documento?.final?.firmasPropio?.marcas) : [];
  const acuse = adendaAviso?.aviso_aceptado_en
    ? { nombre: adendaAviso.aviso_aceptado_detalle?.nombre ?? '—', en: adendaAviso.aviso_aceptado_en }
    : null;
  return {
    id: c.id,
    numero: c.numero,
    ruta,
    estado: c.estado as EnvioV3['estado'],
    fechaActivacion: c.fecha_firma,
    fechaTerminacion: c.fecha_terminacion,
    vigencia: c.estado === 'vigente' ? vigenciaDe(c) : null,
    acta: firmado
      ? {
          pendiente: actas.length === 0 && !cierreSinActa,
          archivos: actas,
          cierreSinActa,
          datos: {
            fechaEntrega: c.datos_variables?.asistente?.paso3?.fechaEntrega ?? null,
            amoblado: c.datos_variables?.asistente?.paso2?.amoblado ?? null,
            inmueble: {
              direccion: c.datos_variables?.documento?.entrada?.inmueble?.direccion ?? null,
              municipio: c.datos_variables?.documento?.entrada?.inmueble?.municipio ?? null,
            },
            partes: partes.map((p) => ({ rol: p.rol, nombre: datosDeFirma(p).nombre })),
          },
        }
      : null,
    sobre: s && {
      intento: s.intento,
      estado: s.estado,
      enviadoEn: s.created_at,
      expiraEn: s.expira_en,
      motivo: s.motivo,
      motivoDetalle: s.motivo_detalle,
      firmantes: s.firmantes.map((f) => {
        const p = parte.get(f.parteId);
        const d = p ? datosDeFirma(p) : null;
        return {
          rol: p?.rol ?? 'arrendatario',
          nombre: d?.nombre ?? '—',
          telefono: d?.telefono ?? null,
          email: d?.email ?? null,
          orden: p?.orden ?? 0,
          estado: f.estado,
          firmadoEn: f.firmadoEn ?? null,
        };
      }),
    },
    aviso: aviso
      ? { texto: String(aviso.aviso_detalle?.texto), entregadoEn: aviso.aviso_entregado_en!, aceptado: acuse }
      : null,
    // Sin la migración 20260930000001 el acuse no se puede registrar y nada lo exige.
    acuseDisponible: !!adendaAviso,
    prorroga: vivo ? prorrogaVista(vivo, adendaVivo, vig, cal.DIAS_EXPIRACION_FIRMA) : null,
    identidadPendientes: pendientes,
    // Las mismas puertas que reenviar/reintentar (y la ruta del flag): un botón habilitado nunca recibe un 409.
    reenvio:
      c.estado !== 'firma_incompleta'
        ? { puede: false, motivo: null }
        : !env.CONTRATOS_V3_ENABLED
          ? { puede: false, motivo: 'El envío a firma está desactivado por ahora. Escríbenos si necesitas reenviarlo.' }
          : sinMarcas.length
            ? { puede: false, motivo: motivoSinMarcas(sinMarcas) }
            : c.expedienteEstado === 'cerrado' || c.expedienteEstado === 'rechazado'
            ? {
                puede: false,
                motivo: `El estudio está ${c.expedienteEstado === 'rechazado' ? 'marcado como no aprobable' : 'cerrado'}: el contrato ya no se puede reenviar a firma.`,
              }
            : !('motivo' in sinPlazo)
              ? { puede: true, motivo: null }
              : {
                  puede: false,
                  motivo: `${motivoSinPlazo(sinPlazo.motivo, vig?.fin)} Si no la vas a renovar, cancela el contrato para liberar el inmueble.`,
                },
    reintento: env.CONTRATOS_V3_ENABLED && c.estado === 'pendiente_firma' && reintentable(s) && pendientes === 0 && !sinMarcas.length,
  };
}

/** Prórroga automática: el período en curso, calculado (las fechas del contrato están congeladas). */
function vigenciaDe(c: { fecha_inicio: string | null; duracion_meses: number | null }): EnvioV3['vigencia'] {
  if (!c.fecha_inicio || !c.duracion_meses) return null;
  const p = periodoVigente(c.fecha_inicio, c.duracion_meses, fechaBogota(new Date()));
  return {
    inicio: c.fecha_inicio,
    vencimientoInicial: sumarMeses(c.fecha_inicio, c.duracion_meses),
    venceEl: p.hasta,
    prorrogas: p.prorrogas,
  };
}

/** El último sobre incompleto (el del aviso). Falla cerrado: sin leerlo no se sabe si falta el acuse. */
async function ultimoIncompleto(contratoId: string): Promise<Sobre | null> {
  const { data, error } = await db('contrato_v3_sobres')
    .select('id')
    .eq('contrato_id', contratoId)
    .eq('estado', 'incompleto')
    .order('intento', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new AppError(503, 'LECTURA_NO_VERIFICABLE', 'No pudimos leer el proceso de firma. Intenta de nuevo en un momento.');
  const fila = data as { id: string } | null;
  return fila ? leerSobre(fila.id) : null;
}

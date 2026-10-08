import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendAutorizacionEmail, sendOtpEmail } from '@/lib/email';
import { enviarMensaje } from '@/modules/whatsapp/whatsapp.service';
import { WHATSAPP_TEMPLATES } from '@/modules/whatsapp/templates';
import { assertExpedienteAccess, resolveAllowedExpedienteIds, resolveInmobiliariaIdForPerfil } from '@/lib/tenantScope';
import type { AuthUser } from '@/types/auth';
import type { TransitionInput } from '@/modules/expedientes/expediente-workflow.schema';
import { errorNoAfianzableSegunCobro, estudioYaCobrado as estudioPagado, leerSenalPagoEstudio } from '@/modules/estudios/pago.guard';
import { normalizarDocumento, normalizarTipoDocumento } from '@/modules/estudios/autorizacion.guard';
import { env } from '@/config';
import { getCalibracion } from '@/lib/calibracion';
import type {
  FirmarInput,
  RevocarInput,
  PerfilProspectoInput,
  ReportarIdentidadInput,
  ConfirmarIdentidadInput,
} from './autorizaciones.schema';
import { senalDiscrepanciaIngreso } from './ingreso-declarado';
import { textoLegalSolicitante, VERSIONES_BIOMETRIA } from './autorizaciones.texto';
// Cotejo biometrico AucoFace (Politica Anexo A + §14). Apagado por
// AUCO_BIOMETRIA_ENABLED no se pide nada y el texto legal no cambia.
import {
  validarIdentidadProspecto,
  biometriaOmitida,
  leerResumenBiometria,
} from './biometria';
import type { ResumenBiometria } from './biometria';
import { formatNumeroEstudio } from '@/lib/numeroEstudio';
import { existeOtraCuentaConDocumento, MSG_DOC_DE_OTRA_CUENTA_GESTOR } from '@/modules/solicitantes/solicitantes.service';
import { motivoNoAfianzable } from '@/modules/inmuebles/destinacion';
import {
  cerrarEnvios,
  contarCorrecciones,
  contarEnlacesTitular,
  contarIntentosFallidos,
  enmascararEmail,
  identidadRechazada,
  leerBloqueo,
  registrarEnvio,
  registrarIntentoDocumento,
  type MotivoCierre,
  type ResultadoCanal,
} from './bloqueo-documento';

// ============================================================
// Constants
// ============================================================

const OTP_EXPIRY_MINUTES = 5;
const OTP_COOLDOWN_SECONDS = 60;

// ============================================================
// Helper types
// ============================================================

interface AutorizacionRow {
  id: string;
  solicitante_id: string;
  expediente_id: string | null;
  canal: string;
  estado: string;
  token: string;
  token_expiracion: string;
  generado_por: string;
  autorizado_en: string | null;
  ip_autorizacion: string | null;
  user_agent: string | null;
  texto_autorizado: string | null;
  version_terminos: string | null;
  metodo_firma: string | null;
  datos_firma: string | null;
  hash_documento: string | null;
  fecha_revocacion: string | null;
  motivo_revocacion: string | null;
  created_at: string;
}

interface ExpedienteInfo {
  id: string;
  numero: string;
  estado: string;
  solicitante_id: string;
  solicitantes: {
    id: string;
    nombre: string;
    apellido: string;
    email: string;
    telefono: string | null;
    tipo_documento: string;
    numero_documento: string;
    tipo_persona?: string | null;
    creado_por?: string | null;
    inmobiliaria_id?: string | null;
  };
  inmuebles: {
    id: string;
    direccion: string;
    ciudad: string;
    barrio: string | null;
    propietario_id: string | null;
    inmobiliaria_id: string | null;
  };
}

interface OtpRow {
  id: string;
  autorizacion_id: string;
  codigo: string;
  expira_en: string;
  verificado: boolean;
  created_at: string;
}

// ============================================================
// 1. Get autorizacion status for expediente
// ============================================================

export async function getAutorizacionForExpediente(
  expedienteId: string,
  userId?: string,
  userRol?: string,
) {
  // Tenant guard: no-op para roles internos / llamadas sin identidad; lanza 404
  // para un propietario/inmobiliaria/solicitante fuera de su cartera. Esta fila
  // es evidencia legal de la firma habeas data (IP, dispositivo, texto literal),
  // así que no debe exponerse cross-tenant conociendo solo el expedienteId.
  // Las lecturas salen en paralelo con el guard (antes 4 idas en serie): si el
  // guard da 404, Promise.all rechaza y lo leído se descarta.
  const [, { data: expediente, error: expError }, { data: autorizacion }, perfil] = await Promise.all([
    assertExpedienteAccess(expedienteId, userId, userRol),
    // Verify expediente exists. Para roles internos el guard es no-op, así que
    // conservamos este 404 explícito de "no existe".
    (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('id', expedienteId)
      .single(),
    // Get latest autorizacion DEL TITULAR para este expediente. Incluye los
    // consentimientos opcionales que el solicitante eligió y la evidencia
    // completa de la firma (IP, dispositivo, versión y texto literal firmado) —
    // el panel admin los muestra como soporte legal de la autorización.
    //
    // `coarrendatario_id IS NULL` NO es opcional: desde 2026-09-03 el
    // coarrendatario invitado tiene su PROPIA fila con el MISMO expediente_id, y
    // como se inserta después, era la que devolvía el `order by created_at desc`.
    // El panel habría mostrado la IP, el dispositivo y el texto de OTRO titular
    // de datos como si fueran los del solicitante: exactamente la evidencia que
    // el 8.4 exige poder demostrar si alguna vez se cuestiona.
    (supabase
      .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, canal, metodo_firma, autorizado_en, hash_documento, fecha_revocacion, motivo_revocacion, token_expiracion, created_at, consent_analitica, consent_comercial, consent_historial_referencia, ip_autorizacion, user_agent, version_terminos, texto_autorizado, numero_documento_aceptante, tipo_documento_aceptante, vigente_hasta')
      .eq('expediente_id', expedienteId)
      .is('coarrendatario_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // PASO 5 (Flujo §8): lo que el prospecto declaro en su celular. Se adjunta
    // por ALLOWLIST construida campo a campo, NUNCA con `...perfil`.
    //
    // Una blocklist se rompe sola en cuanto alguien agregue una columna, y este
    // endpoint corre bajo authorize('expedientes','read') — que la inmobiliaria
    // tiene. La promesa que el §8.2 le hace al prospecto en pantalla ("esta
    // cifra no se la mostramos a la inmobiliaria") se sostiene AQUI, en el
    // servicio junto al tenant guard, no en el render: con DevTools se lee igual.
    leerPerfilProspecto(expedienteId, userRol),
  ]);

  if (expError || !expediente) {
    throw AppError.notFound('Estudio no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  if (!autorizacion) return null;

  // BLQ §8: estado derivado y lo que le queda al gestor (corregir y reenviar).
  const aut = autorizacion as Record<string, unknown> & { id: string; estado: string; created_at: string };
  const [bloqueo, enlaces, correcciones, cal] = await Promise.all([
    leerBloqueo(expedienteId, aut),
    contarEnlacesTitular(expedienteId).catch(() => null),
    contarCorrecciones(expedienteId).catch(() => null),
    getCalibracion(),
  ]);
  return {
    ...aut,
    perfil_prospecto: perfil,
    estado_bloqueo: bloqueo.estado,
    // 'intentos' o 'datos_incorrectos' («soy yo, pero los datos están mal»): la web dice qué pasó.
    motivo_bloqueo: bloqueo.estado === 'bloqueado_documento' ? bloqueo.motivo : null,
    correcciones_restantes: correcciones == null ? null : Math.max(0, cal.MAX_CORRECCIONES_DOCUMENTO - correcciones),
    // Para la inmobiliaria y el propietario; Cofianza no tiene límite.
    reenvios_restantes: enlaces == null ? null : Math.max(0, cal.MAX_REENVIOS_ENLACE - Math.max(0, enlaces - 1)),
  };
}

/** Roles internos de Cofianza: los unicos que ven el bloque §8.2. */
function esRolInternoCofianza(userRol?: string): boolean {
  return userRol === 'administrador' || userRol === 'operador_analista' || userRol === 'gerencia_consulta';
}

async function leerPerfilProspecto(
  expedienteId: string,
  userRol?: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await (supabase
    .from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('expediente_id', expedienteId)
    .maybeSingle();

  // Tabla ausente (migracion sin correr) o error: el resto de la card sigue.
  if (error || !data) return null;
  const p = data as Record<string, unknown>;

  // Lo que ve CUALQUIER rol con acceso al expediente: si el prospecto confirmo
  // quien es, si reporto que esos datos no son suyos (el gestor tiene que
  // poder corregir y reenviar) y si dijo que viene acompanado.
  const publico: Record<string, unknown> = {
    identidad_confirmada: p.identidad_confirmada ?? false,
    identidad_confirmada_en: p.identidad_confirmada_en ?? null,
    identidad_reporte: p.identidad_reporte ?? null,
    identidad_reporte_en: p.identidad_reporte_en ?? null,
    presentacion: p.presentacion ?? null,
    coarrendatario_intencion: p.coarrendatario_intencion ?? null,
  };

  if (!esRolInternoCofianza(userRol)) return publico;

  // Solo Cofianza: el bloque §8.2 completo, el texto libre del reporte (puede
  // contener cualquier cosa) y la senal de discrepancia — calculada al vuelo,
  // JAMAS persistida y jamas devuelta al motor.
  const declarado = p.ingreso_declarado_cop == null ? null : Number(p.ingreso_declarado_cop);
  return {
    ...publico,
    identidad_reporte_detalle: p.identidad_reporte_detalle ?? null,
    situacion_laboral: p.situacion_laboral ?? null,
    // Anexo A.3/A.4: solo lo responde el independiente (undefined sin la columna).
    tiene_rut: p.tiene_rut ?? null,
    donde_labora: p.donde_labora ?? null,
    ingreso_declarado_cop: declarado,
    discrepancia_ingreso: senalDiscrepanciaIngreso(
      declarado,
      await leerIngresoInferidoDelExpediente(expedienteId, declarado),
      (await getCalibracion()).UMBRAL_DIFERENCIA_INGRESO,
    ),
  };
}

/**
 * Ingreso INFERIDO por el buro para el expediente, solo para contrastarlo con
 * el declarado. Se lee de `estudios_scorecard_sombra` (el unico hogar legitimo
 * del inferido) y NO al reves: nada de esta funcion vuelve al motor.
 *
 * Hoy devuelve null casi siempre — TransUnion no entrega ingreso inferido por
 * ningun nodo del combo 1901 — y esa ausencia se respeta: NO se rellena con el
 * declarado. Rellenarla taparia la brecha de fuentes en vez de arreglarla.
 *
 * OJO: un expediente contiene estudios de MAS DE UN titular de datos. El
 * coarrendatario invitado comparte `expediente_id` (coarrendatarios.service
 * lo inserta con tipo='con_coarrendatario') y produce su propia fila en
 * estudios_scorecard_sombra. Sin el `.neq` de abajo, el declarado del TITULAR
 * se contrastaba contra el inferido del COARRENDATARIO: una discrepancia
 * fabricada entre dos personas distintas que ademas TAPABA la ausencia real
 * del titular, que es justo la brecha que este diseno quiere dejar visible.
 * Mismo filtro y misma razon que orchestrator.service.ts.
 */
async function leerIngresoInferidoDelExpediente(
  expedienteId: string,
  declarado: number | null,
): Promise<number | null> {
  if (declarado == null) return null; // sin declarado no hay nada que contrastar
  try {
    const { data: estudios } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('expediente_id', expedienteId)
      .neq('tipo', 'con_coarrendatario')
      .order('created_at', { ascending: false })
      .limit(5);
    const ids = ((estudios || []) as Array<{ id: string }>).map((e) => e.id);
    if (ids.length === 0) return null;

    const { data } = await (supabase
      .from('estudios_scorecard_sombra' as string) as ReturnType<typeof supabase.from>)
      .select('ingreso_inferido_cop')
      .in('estudio_id', ids)
      .not('ingreso_inferido_cop', 'is', null)
      .order('fecha_calculo', { ascending: false })
      .limit(1)
      .maybeSingle();
    const bruto = (data as { ingreso_inferido_cop?: number | string | null } | null)?.ingreso_inferido_cop;
    const n = typeof bruto === 'string' ? Number(bruto) : bruto;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ============================================================
// 2. Enviar enlace de autorizacion
// ============================================================

/**
 * {{2}} de la plantilla de autorización: la inmobiliaria por su nombre; sin
 * inmobiliaria (propietario directo) no se expone el nombre de una persona.
 */
async function quienSolicitaElEstudio(
  inm: { inmobiliaria_id?: string | null; propietario_id?: string | null } | null | undefined,
): Promise<string> {
  const generico = 'El propietario del inmueble';
  // B18: inmuebles de una inmobiliaria cargados antes de que tuviera
  // organización (migración 20260929000016) quedaron con inmobiliaria_id null.
  // Se resuelve por la organización de su dueño; un propietario individual no
  // tiene ninguna y sigue siendo «El propietario del inmueble».
  const inmobiliariaId =
    inm?.inmobiliaria_id || (inm?.propietario_id ? await resolveInmobiliariaIdForPerfil(inm.propietario_id) : null);
  if (!inmobiliariaId) return generico;
  const { data, error } = await (supabase
    .from('inmobiliarias' as string) as ReturnType<typeof supabase.from>)
    .select('nombre')
    .eq('id', inmobiliariaId)
    .maybeSingle();
  // B15: supabase-js no lanza. Sin esto, un fallo de lectura decía «El
  // propietario del inmueble» aunque el estudio lo pidiera una inmobiliaria.
  if (error) throw error;
  return ((data as { nombre?: string | null } | null)?.nombre || '').trim() || generico;
}

/** {{2}} del WhatsApp (y quién pide, en el correo): si no se pudo leer quién pide, un sujeto neutro (nunca uno falso). */
async function quienSolicitaParaMensaje(
  inm: { inmobiliaria_id?: string | null; propietario_id?: string | null } | null | undefined,
  expedienteId: string,
): Promise<string> {
  try {
    return await quienSolicitaElEstudio(inm);
  } catch (err) {
    logger.warn({ expedienteId, err: err instanceof Error ? err.message : String(err) }, 'No se pudo leer quién pide el estudio para el aviso de autorización');
    return 'Quien tramita su arriendo';
  }
}


/**
 * Escribe el tipo/número de documento en la ficha con las reglas de siempre:
 * una cuenta por documento (H43) y el índice por agencia (23505). Lo usan el
 * documento que faltaba (enviar enlace) y «Corregir documento» (BLQ §3). Muta
 * `sol` con lo guardado.
 */
async function escribirDocumentoFicha(
  solicitanteId: string,
  sol: ExpedienteInfo['solicitantes'],
  tipoNuevo: string | undefined,
  numeroNuevo: string | undefined,
  expedienteId: string,
  userRol?: string,
): Promise<void> {
  const cambiaNumero = !!numeroNuevo && numeroNuevo !== (sol.numero_documento ?? '');
  const cambiaTipo = !!tipoNuevo && tipoNuevo !== (sol.tipo_documento ?? '');
  if (!cambiaNumero && !cambiaTipo) return;
  // H43: si la ficha es la de una cuenta, la regla del registro (una cuenta
  // por documento). Las fichas de agencia no aplican.
  const numFinal = numeroNuevo || sol.numero_documento;
  if (numFinal && (await existeOtraCuentaConDocumento(tipoNuevo || sol.tipo_documento || 'cc', numFinal, sol))) {
    throw AppError.conflict(MSG_DOC_DE_OTRA_CUENTA_GESTOR, 'DOCUMENT_ALREADY_EXISTS');
  }
  const { error: docError } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .update({
      ...(cambiaNumero ? { numero_documento: numeroNuevo } : {}),
      ...(cambiaTipo ? { tipo_documento: tipoNuevo } : {}),
    } as never)
    .eq('id', solicitanteId);
  if (docError) {
    logger.warn({ error: docError.message, expedienteId }, 'No se pudo corregir el documento del solicitante');
    // 23505 = idx_solicitantes_documento_por_agencia: otra ficha de la misma
    // agencia (o del mismo propietario) ya tiene ese documento.
    if ((docError as { code?: string }).code === '23505') {
      const esCedula = (tipoNuevo || sol.tipo_documento) === 'cc';
      throw AppError.conflict(
        `${esCedula ? 'Esa cédula ya está registrada' : 'Ese documento ya está registrado'} para otro solicitante` +
          `${userRol === 'inmobiliaria' ? ' de su inmobiliaria' : ''}. Verifique el número o continúe con el estudio de ese solicitante.`,
        'DOCUMENTO_DUPLICADO',
      );
    }
    throw AppError.badRequest(
      'No se pudo corregir el documento del solicitante. Revíselo en su ficha y vuelva a intentarlo.',
      'DOCUMENTO_NO_ACTUALIZADO',
    );
  }
  if (cambiaNumero) sol.numero_documento = numeroNuevo!;
  if (cambiaTipo) sol.tipo_documento = tipoNuevo!;
}

export async function enviarEnlaceAutorizacion(
  expedienteId: string,
  userId: string,
  ip?: string,
  // Corrección del contacto (y del documento) del solicitante: si viene y
  // difiere, se persiste en `solicitantes` y el enlace va al corregido.
  contacto?: { email?: string; telefono?: string; tipo_documento?: string; numero_documento?: string },
  userRol?: string,
) {
  // 1. Get expediente with solicitante + inmueble
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, solicitante_id, solicitantes(id, nombre, apellido, email, telefono, tipo_documento, numero_documento, tipo_persona, creado_por, inmobiliaria_id), inmuebles!expedientes_inmueble_id_fkey(id, direccion, ciudad, barrio, propietario_id, inmobiliaria_id)')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Estudio no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  const exp = expediente as unknown as ExpedienteInfo;

  // 0b. Tenant guard: propietario/inmobiliaria solo pueden operar sobre
  // estudios de su cartera (el miembro restringido, los suyos o asignados).
  // Sin esto, cualquier usuario con ese rol podía redirigir el enlace (y ahora
  // reescribir el contacto) de solicitantes ajenos conociendo el expedienteId.
  // Admin/operador pasan.
  if (userRol === 'propietario' || userRol === 'inmobiliaria') {
    const esDueno = await assertExpedienteAccess(expedienteId, userId, userRol).then(
      () => true,
      () => false,
    );
    if (!esDueno) {
      throw AppError.forbidden(
        'No tiene permisos para enviar la autorización de este estudio',
        'AUTORIZACION_FORBIDDEN',
      );
    }
  }

  // 0c. Un estudio cerrado o rechazado ya no le pide nada al prospecto: el
  // enlace llegaria a una pantalla que no deja firmar (assertEstudioActivo).
  assertEstudioActivo(exp.estado);

  // 0c-bis. BLQ §4.5 y §8.2: todo envío después del primero es un reenvío
  // (manual, tras vencer o con el contacto corregido). La inmobiliaria y el
  // propietario tienen MAX_REENVIOS_ENLACE y no reenvían tras «no soy yo»;
  // Cofianza queda exenta, con traza. Antes de tocar el contacto o el documento.
  const enlacesPrevios = await contarEnlacesTitular(expedienteId);
  const esReenvio = enlacesPrevios > 0;
  const esGestorExterno = userRol === 'propietario' || userRol === 'inmobiliaria';
  if (esReenvio && esGestorExterno) {
    if (await identidadRechazada(expedienteId)) {
      throw AppError.conflict(
        'El titular de los datos respondió que no es él. Comuníquese con Cofianza para revisar el caso.',
        'IDENTIDAD_RECHAZADA',
      );
    }
    if (enlacesPrevios - 1 >= (await getCalibracion()).MAX_REENVIOS_ENLACE) {
      throw AppError.conflict(
        'Alcanzó el máximo de reenvíos de este estudio. Comuníquese con Cofianza.',
        'MAX_REENVIOS_ENLACE',
      );
    }
  }

  // 0d. Adenda de precios §6.1: un arrendatario con NIT no se estudia. H43 deja
  // escribir el documento aquí, después del registro; sin esto el NIT se
  // guardaba, el enlace salía y el bloqueo llegaba recién al cobrar.
  const motivoDoc = motivoNoAfianzable(undefined, {
    tipo_persona: exp.solicitantes?.tipo_persona,
    tipo_documento: contacto?.tipo_documento || exp.solicitantes?.tipo_documento,
  });
  // Si ya se pagó (gestor o cupo), el mensaje no dice «sin cobro» y Cofianza revisa la devolución.
  if (motivoDoc) throw await errorNoAfianzableSegunCobro(motivoDoc, [expedienteId]);

  // 1a. Aplicar la corrección de contacto si vino en el body. El teléfono
  // solo cuenta si trae dígitos reales (el PhoneInput de la web deja '+57 '
  // cuando se borra el número).
  const emailNuevo = contacto?.email?.trim().toLowerCase();
  const telNuevo =
    contacto?.telefono && contacto.telefono.replace(/\D/g, '').replace(/^57/, '').length >= 7
      ? contacto.telefono.trim()
      : undefined;
  const cambiaEmail = !!emailNuevo && emailNuevo !== (exp.solicitantes?.email ?? '').toLowerCase();
  const cambiaTel = !!telNuevo && telNuevo !== (exp.solicitantes?.telefono ?? '');
  if ((cambiaEmail || cambiaTel) && exp.solicitante_id) {
    const { error: contactoError } = await (supabase
      .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .update({
        ...(cambiaEmail ? { email: emailNuevo } : {}),
        ...(cambiaTel ? { telefono: telNuevo } : {}),
      } as never)
      .eq('id', exp.solicitante_id);
    if (contactoError) {
      logger.warn(
        { error: contactoError.message, expedienteId },
        'No se pudo actualizar el contacto del solicitante (el enlace se envía igual al corregido)',
      );
    }
    if (cambiaEmail && exp.solicitantes) exp.solicitantes.email = emailNuevo!;
    if (cambiaTel && exp.solicitantes) exp.solicitantes.telefono = telNuevo!;
  }

  // 1a-bis. Documento escrito con el enlace: solo el que FALTA (H43, ficha
  // sin documento). Con documento, cambiarlo es «Corregir documento» (BLQ §3):
  // ciego, con fuente y con límite; por aquí cambiaba el cotejo en silencio.
  const numeroNuevo = contacto?.numero_documento?.trim();
  const tipoNuevo = contacto?.tipo_documento;
  const cambiaNumero = !!numeroNuevo && numeroNuevo !== (exp.solicitantes?.numero_documento ?? '');
  const cambiaTipo = !!tipoNuevo && tipoNuevo !== (exp.solicitantes?.tipo_documento ?? '');
  if ((cambiaNumero || cambiaTipo) && exp.solicitante_id && exp.solicitantes) {
    if (exp.solicitantes.numero_documento?.trim()) {
      throw AppError.conflict(
        'El prospecto ya tiene un documento registrado. Para cambiarlo use «Corregir documento» en el estudio y luego reenvíe el enlace.',
        'DOCUMENTO_REQUIERE_CORRECCION',
      );
    }
    await escribirDocumentoFicha(exp.solicitante_id, exp.solicitantes, tipoNuevo, numeroNuevo, expedienteId, userRol);
  }

  if (!exp.solicitantes?.email) {
    throw AppError.badRequest('El solicitante no tiene email registrado', 'SOLICITANTE_SIN_EMAIL');
  }

  // H43: el auto-registro ya no pide el documento (la ficha nace con ''). Sin
  // número, §8.1 (documentoCoincide) mataría el enlace como "datos
  // incorrectos" apenas el prospecto lo abriera: mejor no emitirlo.
  if (!exp.solicitantes?.numero_documento?.trim()) {
    throw AppError.badRequest(
      'Falta el número de documento del prospecto. Agréguelo (o pídale que lo complete en «Mi cuenta») antes de enviarle la solicitud de autorización.',
      'SOLICITANTE_SIN_DOCUMENTO',
    );
  }

  // 1b. No re-crear un enlace si el inquilino YA firmó (estado autorizado, no
  // revocado Y VIGENTE). Un nuevo enlace pendiente podría re-firmarse y
  // re-disparar el estudio de crédito. Esto hace idempotente el auto-envío del
  // orquestador (doble webhook de pago) y evita pisar una firma existente desde
  // el botón manual.
  //
  // El predicado tiene que ser el MISMO que el del gate (fn_autorizacion_es_vigente
  // / evaluarAutorizacionPrevia), o las dos capas se contradicen:
  //   - sin `vigente_hasta`: una autorización caducada — que el gate rechaza con
  //     "envíe una nueva solicitud" — bloqueaba justo esa nueva solicitud, y la
  //     única salida era revocar, es decir fabricar en la evidencia legal una
  //     revocación del titular que nunca ocurrió.
  //   - sin `coarrendatario_id IS NULL`: la fila del coarrendatario (mismo
  //     expediente_id) bloqueaba el enlace del titular de inmediato.
  const { data: yaAutorizada } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero_documento_aceptante, tipo_documento_aceptante')
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .eq('estado', 'autorizado')
    .is('fecha_revocacion', null)
    .or(`vigente_hasta.is.null,vigente_hasta.gt.${new Date().toISOString()}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Salvo que se haya firmado con OTRO documento que el de la ficha (cédula mal
  // digitada y corregida): esa firma no ampara la consulta del documento bueno
  // (el gate responde documento_distinto) y la única salida era revocar, es
  // decir registrar una revocación que el titular nunca hizo. La firma vieja
  // queda como evidencia; el gate acepta cualquiera de las últimas que sirva.
  // Sin documento congelado (firmas anteriores al 2026-09-03) se trata como
  // el mismo.
  const firmada = yaAutorizada as {
    numero_documento_aceptante: string | null;
    tipo_documento_aceptante: string | null;
  } | null;
  const firmoOtroDocumento =
    !!firmada?.numero_documento_aceptante &&
    (normalizarDocumento(firmada.numero_documento_aceptante) !== normalizarDocumento(exp.solicitantes.numero_documento) ||
      (!!firmada.tipo_documento_aceptante &&
        normalizarTipoDocumento(firmada.tipo_documento_aceptante) !== normalizarTipoDocumento(exp.solicitantes.tipo_documento)));
  if (firmada && !firmoOtroDocumento) {
    throw AppError.badRequest(
      'Este estudio ya tiene una autorización firmada vigente.',
      'AUTORIZACION_YA_FIRMADA',
    );
  }

  // 2. Invalidate any existing pending autorizacion DEL TITULAR for this
  //    expediente (mismo filtro de sujeto que el resto del módulo). BLQ §4.2:
  //    nunca dos enlaces activos; el anterior queda «reemplazado».
  const { data: reemplazadas } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'expirado' } as never)
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .eq('estado', 'pendiente')
    .select('id');
  await cerrarEnvios(idsDe(reemplazadas), 'reemplazado');

  // 3. Generate secure token. El enlace vive lo mismo que el estudio (Flujo
  //    §14 "Plazo de expiracion: 15 dias"; Adenda §9 lo hace calibrable como
  //    DIAS_EXPIRACION_ESTUDIO): antes caducaba a las 48 h y el prospecto se
  //    encontraba un enlace muerto dentro de un estudio todavia vigente.
  const expiryHours = (await getCalibracion()).DIAS_EXPIRACION_ESTUDIO * 24;
  const token = crypto.randomBytes(32).toString('hex');
  const tokenExpiracion = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();

  // 4. Insert new autorizacion
  const textoLegal = textoLegalSolicitante(env.AUCO_BIOMETRIA_ENABLED);
  const { data: autorizacion, error: insertError } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .insert({
      solicitante_id: exp.solicitante_id,
      expediente_id: expedienteId,
      canal: 'enlace',
      estado: 'pendiente',
      token,
      token_expiracion: tokenExpiracion,
      generado_por: userId,
      // El texto y su version dependen del interruptor de biometria: el 2.0
      // afirma "no se recolectan datos sensibles" y con la camara encendida
      // eso seria falso. Se congela el que de verdad se le presento (§8.4).
      texto_autorizado: textoLegal.texto,
      version_terminos: textoLegal.version,
    } as never)
    .select('id')
    .single();

  if (insertError || !autorizacion) {
    logger.error({ error: insertError, expedienteId }, 'Error al crear autorizacion');
    throw AppError.badRequest('Error al crear la autorización', 'AUTORIZACION_CREATE_ERROR');
  }

  const autorizacionId = (autorizacion as unknown as { id: string }).id;

  // 5. Send email
  const autorizacionUrl = `${env.FRONTEND_URL}/autorizar/${token}`;
  const nombreCompleto = `${exp.solicitantes.nombre} ${exp.solicitantes.apellido}`;
  // M5: el correo y el WhatsApp nombran a quien pide el estudio y el inmueble
  // (mismo cálculo para los dos, una sola lectura).
  const inm = exp.inmuebles;
  const direccion = [inm?.direccion, inm?.ciudad].filter((v) => v?.trim()).join(', ') || 'el inmueble';
  const quienSolicita = await quienSolicitaParaMensaje(inm, expedienteId);

  // BLQ §7: resultado por canal, con el destino enmascarado.
  const envios: ResultadoCanal[] = [];

  // Email best-effort: si Resend falla (p.ej. dirección no verificada en dev),
  // NO debe bloquear el envío del link por WhatsApp que viene abajo.
  try {
    await sendAutorizacionEmail(exp.solicitantes.email, nombreCompleto, autorizacionUrl, expiryHours, {
      quienSolicita,
      direccion,
    });
    envios.push({ canal: 'correo', destino_enmascarado: enmascararEmail(exp.solicitantes.email), estado: 'enviado' });
  } catch (err) {
    // Sin el texto del error: puede traer la dirección completa.
    envios.push({ canal: 'correo', destino_enmascarado: enmascararEmail(exp.solicitantes.email), estado: 'fallido' });
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), expedienteId },
      'No se pudo enviar el email de autorización (se continúa con WhatsApp)',
    );
  }

  // 5b. Enviar también el link por WhatsApp si hay celular (best-effort; el
  // email queda como respaldo). WhatsApp directo vía Meta (no Auco).
  if (exp.solicitantes.telefono) {
    const res = await enviarMensaje({
      to: exp.solicitantes.telefono,
      template_id: WHATSAPP_TEMPLATES.AUTORIZACION_LINK.id,
      language: WHATSAPP_TEMPLATES.AUTORIZACION_LINK.language,
      variables: [
        exp.solicitantes.nombre,
        quienSolicita,
        direccion,
        autorizacionUrl,
        String(Math.round(expiryHours / 24)),
      ],
      context: { expediente_id: expedienteId },
    });
    envios.push({
      canal: 'whatsapp',
      destino_enmascarado: maskTelefono(exp.solicitantes.telefono),
      estado: res.estado,
      ...(res.estado === 'fallido' && res.error ? { error: String(res.error).slice(0, 200) } : {}),
    });
    if (res.estado === 'fallido') {
      logger.warn({ error: res.error, expedienteId }, 'No se pudo enviar el link de autorización por WhatsApp');
    }
  }

  await registrarEnvio({ autorizacionId, expedienteId, generadoPor: userId, esReenvio, envios });

  // 6. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.AUTORIZACION_ENLACE_SENT,
    entidad: AUDIT_ENTITIES.AUTORIZACION,
    entidadId: autorizacionId,
    detalle: {
      expediente_id: expedienteId,
      solicitante_id: exp.solicitante_id,
      email: exp.solicitantes.email,
      es_reenvio: esReenvio,
      // Cofianza pasada del límite de reenvíos (exenta, con traza).
      ...(esReenvio && !esGestorExterno ? { reenvio_numero: enlacesPrevios } : {}),
    },
    ip,
  });

  return {
    id: autorizacionId,
    estado: 'pendiente',
    token_expiracion: tokenExpiracion,
  };
}

// ============================================================
// 3. Get autorizacion by token (public)
// ============================================================

/** Ids de un `.update(...).select('id')`. */
function idsDe(data: unknown): string[] {
  return Array.isArray(data) ? (data as Array<{ id: string }>).map((r) => r.id) : [];
}

/** Enmascara un teléfono dejando visibles solo los 2 últimos dígitos. */
function maskTelefono(tel: string | null): string | null {
  if (!tel) return null;
  const digits = tel.replace(/\D/g, '');
  if (digits.length < 2) return null;
  return `••• ••${digits.slice(-2)}`;
}

/**
 * Un expediente cerrado o rechazado ya no avanza: su enlace no se abre para
 * firmar ni dispara nada (cancelado con la autorizacion pendiente, el
 * prospecto firmaba y leia "seguimos con tu estudio"). executeTransition
 * expira las pendientes al cerrar o rechazar; esto cubre los enlaces de antes
 * y cualquier otro camino. El mensaje no dice "rechazado" (§13).
 */
function assertEstudioActivo(estadoExpediente: string | null | undefined): void {
  if (estadoExpediente === 'cerrado' || estadoExpediente === 'rechazado') {
    throw AppError.badRequest('Este estudio ya no está activo.', 'ESTUDIO_NO_ACTIVO');
  }
}

/**
 * §8.1: el prospecto ESCRIBE su numero de documento y se compara aqui con el
 * de la ficha, que nunca se le muestra (ni enmascarado: los 4 ultimos digitos
 * eran media respuesta regalada al portador de un enlace reenviado, §12).
 * TransUnion consulta solo por numero, asi que un digito mal puesto por el
 * gestor consultaba a un tercero. Sin numero en la ficha no hay nada que
 * confirmar: no coincide.
 */
export function documentoCoincide(escrito: string | null | undefined, registrado: string | null | undefined): boolean {
  const ficha = normalizarDocumento(registrado);
  return ficha.length > 0 && normalizarDocumento(escrito) === ficha;
}

export async function getAutorizacionByToken(token: string) {
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, estado, token_expiracion, texto_autorizado, version_terminos, metodo_firma, expediente_id,
      solicitantes(nombre, apellido, telefono, tipo_documento),
      expedientes(numero, estado, inmuebles!expedientes_inmueble_id_fkey(direccion, ciudad, barrio, inmobiliaria_id, propietario_id))
    `)
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion por token');
    throw fromSupabaseError(error);
  }
  if (!autorizacion) {
    throw AppError.notFound('Autorización no encontrada o enlace inválido', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as {
    id: string;
    estado: string;
    token_expiracion: string;
    texto_autorizado: string;
    version_terminos: string;
    metodo_firma: string | null;
    expediente_id?: string | null;
    solicitantes: {
      nombre: string;
      apellido: string;
      telefono: string | null;
      tipo_documento: string | null;
    };
    expedientes: {
      numero: string;
      estado: string;
      inmuebles: {
        direccion: string; ciudad: string; barrio: string | null;
        inmobiliaria_id?: string | null; propietario_id?: string | null;
      };
    };
  };

  // El trámite antes que la fecha: reabrir DESPUÉS del vencimiento un enlace
  // que ya se firmó es la pantalla de éxito (y la del pago), no "pide otro".
  if (auth.estado === 'autorizado') {
    throw AppError.badRequest('Esta autorización ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
  }

  // Antes que el vencimiento y el estado: con el estudio cancelado, "pide otro
  // enlace" seria mandarlo a pedir algo que ya no existe.
  assertEstudioActivo(auth.expedientes?.estado);

  // Check if expired
  if (new Date(auth.token_expiracion) < new Date()) {
    // Mark as expired if still pending
    if (auth.estado === 'pendiente') {
      await (supabase
        .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'expirado' } as never)
        .eq('id', auth.id);
    }
    throw AppError.badRequest('El enlace de autorización ha expirado', 'AUTORIZACION_EXPIRADA');
  }

  if (auth.estado !== 'pendiente') {
    // Codigos distintos porque la pantalla del prospecto los trata distinto:
    // reabrir el enlace despues de firmar (gesto normalisimo: el enlace vive en
    // WhatsApp) tiene que mostrar la pantalla de exito, no una alerta roja. El
    // mensaje NO se le renderiza al prospecto — el front tiene copy propio —
    // asi que el nombre interno del enum se queda aqui, para los logs. (El
    // 'autorizado' ya salio arriba, antes del chequeo de vencimiento.)
    throw AppError.badRequest(
      `Esta autorización tiene estado: ${auth.estado}`,
      'AUTORIZACION_ESTADO_INVALIDO',
    );
  }

  // Solo se pide la selfie si el texto que el prospecto firma la incluye: los
  // enlaces emitidos con el interruptor apagado congelaron el texto sin la
  // clausula de datos sensibles (evidencia legal inconsistente si se cotejaba).
  const biometriaRequerida = biometriaAplica(auth.version_terminos);
  const biometriaPrevia = biometriaRequerida
    ? await leerBiometriaPorAutorizacion(auth.id)
    : null;

  // A1 / A2 (revisiones/ux-autorizacion-2026-09-28.md): quién pide el estudio y
  // si al prospecto le toca pagarlo, ANTES de pedirle el documento y de firmar.
  // Best-effort: si fallan, la pantalla funciona como antes (sin esos avisos),
  // pero queda en el log (B15): null = «no sé», nunca «no hay cobro».
  const sinDato = (campo: string) => (err: unknown) => {
    logger.warn({ autorizacionId: auth.id, campo, err: err instanceof Error ? err.message : String(err) }, 'Autorización pública: dato no disponible');
    return null;
  };
  const [solicitadoPor, pago] = await Promise.all([
    quienSolicitaElEstudio(auth.expedientes?.inmuebles).catch(sinDato('solicitado_por')),
    auth.expediente_id
      ? cobroAnticipado(auth.expediente_id).catch(sinDato('pago'))
      : Promise.resolve(null),
  ]);

  return {
    id: auth.id,
    estado: auth.estado,
    texto_legal: auth.texto_autorizado,
    version_terminos: auth.version_terminos,
    // Politica Anexo A + §14: si el interruptor esta encendido, la pantalla
    // suma el paso de camara. Se manda tambien el estado de lo YA verificado
    // para que reabrir el enlace (gesto normalisimo: vive en WhatsApp) no
    // obligue a repetir el cotejo ni, peor, lo pise con uno nuevo.
    biometria: {
      requerida: biometriaRequerida,
      estado: biometriaPrevia?.estado ?? null,
    },
    // Nombre de la inmobiliaria o «El propietario del inmueble» (nunca el de una persona).
    solicitado_por: solicitadoPor,
    // requerido=false también cuando ya está pagado o lo paga la inmobiliaria.
    pago,
    solicitante: {
      nombre: auth.solicitantes.nombre,
      apellido: auth.solicitantes.apellido,
      // PII minimizada para el portador del token: NO se devuelve el email completo
      // (la pantalla no lo usa) y el teléfono va enmascarado.
      telefono_masked: maskTelefono(auth.solicitantes.telefono),
      // §8.1: solo el TIPO. El numero lo escribe el prospecto y se compara en
      // el servidor (confirmarIdentidadProspecto): nunca viaja al portador.
      tipo_documento: auth.solicitantes.tipo_documento,
    },
    expediente: {
      // Flujo §13: la pantalla lo muestra tal cual («N.° 2026-0005»).
      numero_expediente: formatNumeroEstudio(auth.expedientes.numero),
      inmueble: {
        direccion: auth.expedientes.inmuebles.direccion,
        ciudad: auth.expedientes.inmuebles.ciudad,
        barrio: auth.expedientes.inmuebles.barrio,
      },
    },
  };
}

// ============================================================
// 3b. PASO 5 (Flujo §8) — perfil declarado por el prospecto
// ============================================================

/**
 * Repite el trio de validaciones que hacen todos los handlers publicos de este
 * modulo (existe / no expirado / estado 'pendiente') y devuelve el contexto
 * minimo. Que sea 'pendiente' NO es burocracia: es lo que impide que alguien
 * reescriba lo declarado despues de que la firma congelo la evidencia del 8.4,
 * y es la unica defensa que necesita esta tabla (por eso no lleva trigger de
 * inmutabilidad — ver el encabezado de la migracion 20260907000001).
 */
/** Biometria del prospecto: interruptor encendido Y texto firmado con la clausula. */
function biometriaAplica(versionTerminos: string | null | undefined): boolean {
  return env.AUCO_BIOMETRIA_ENABLED && VERSIONES_BIOMETRIA.includes(versionTerminos ?? '');
}

interface AutorizacionPendiente {
  id: string;
  expediente_id: string | null;
  solicitante_id: string;
  version_terminos: string | null;
  /** Documento de la ficha: solo para compararlo, nunca sale del servidor. */
  numero_documento: string | null;
  tipo_documento: string | null;
}

async function autorizacionPendientePorToken(token: string): Promise<AutorizacionPendiente> {
  const { data, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, token_expiracion, expediente_id, solicitante_id, version_terminos, solicitantes(numero_documento, tipo_documento), expedientes(estado)')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion por token');
    throw fromSupabaseError(error);
  }
  if (!data) {
    throw AppError.notFound('Autorización no encontrada o enlace inválido', 'AUTORIZACION_NOT_FOUND');
  }
  const auth = data as unknown as {
    id: string;
    estado: string;
    token_expiracion: string;
    expediente_id: string | null;
    solicitante_id: string;
    version_terminos: string | null;
    solicitantes: { numero_documento: string | null; tipo_documento?: string | null } | null;
    expedientes: { estado: string } | null;
  };
  // Primero: la biometria que cuelga de aqui es una consulta FACTURABLE a Auco.
  assertEstudioActivo(auth.expedientes?.estado);
  if (new Date(auth.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de autorización ha expirado', 'AUTORIZACION_EXPIRADA');
  }
  if (auth.estado !== 'pendiente') {
    throw AppError.badRequest('Este enlace de autorización ya no está vigente', 'AUTORIZACION_NO_VIGENTE');
  }
  return {
    id: auth.id,
    expediente_id: auth.expediente_id,
    solicitante_id: auth.solicitante_id,
    version_terminos: auth.version_terminos ?? null,
    numero_documento: auth.solicitantes?.numero_documento ?? null,
    tipo_documento: auth.solicitantes?.tipo_documento ?? null,
  };
}

/**
 * Columnas con las que se registra la confirmacion de identidad del §8.1 en
 * `autorizacion_perfil_prospecto`. UNA sola definicion para los dos caminos
 * que la escriben (confirmar-identidad y la firma, ambos con el documento
 * escrito y comparado): si divergieran, el banner del gestor diria una cosa
 * segun por donde haya entrado la confirmacion.
 *
 * Limpia ademas el reporte anterior. La fila es 1:1 con el EXPEDIENTE, no con
 * el enlace: sin esto, un reporte de 'datos_incorrectos' que el gestor ya
 * corrigio (ficha arreglada + enlace nuevo + prospecto correcto que confirma,
 * firma, paga y ejecuta) dejaba para siempre el banner ambar "el enlace se
 * detuvo y no se consulto ninguna central de riesgo" encima de un expediente
 * ya autorizado y ya consultado. Quien confirma hoy es quien manda; la traza
 * del reporte queda en el audit log y en el timeline.
 */
function camposIdentidadConfirmada(ahora: string): Record<string, unknown> {
  return {
    identidad_confirmada: true,
    identidad_confirmada_en: ahora,
    identidad_reporte: null,
    identidad_reporte_detalle: null,
    identidad_reporte_en: null,
  };
}

/**
 * Upsert de la confirmacion del §8.1 en la fila 1:1 del expediente.
 * Best-effort: la firma vuelve a comparar el documento, asi que perder esta
 * marca no abre nada; deshacer una firma por ella seria peor.
 */
async function registrarIdentidadConfirmada(expedienteId: string, autorizacionId: string, ahora: string): Promise<void> {
  try {
    const { error } = await (supabase
      .from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
      .upsert(
        {
          expediente_id: expedienteId,
          autorizacion_id: autorizacionId,
          updated_at: ahora,
          ...camposIdentidadConfirmada(ahora),
        } as never,
        { onConflict: 'expediente_id' },
      );
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), autorizacionId, expedienteId },
      '§8.1: no se pudo registrar la confirmacion de identidad',
    );
  }
}

/**
 * BLQ §1: registra el número digitado y, si no coincide, cuenta los fallidos
 * del enlace. Con intentos restantes el enlace sigue vivo; agotados, se detiene
 * (mismo camino que «los datos están mal», §12) y se alerta al asesor. Devuelve
 * los intentos que quedan; nunca el número registrado (§1.4). Son pocos
 * intentos por enlace: no hay oráculo para adivinar el número de otra persona.
 */
async function cotejarDocumento(
  auth: Pick<AutorizacionPendiente, 'id' | 'expediente_id' | 'solicitante_id' | 'numero_documento' | 'tipo_documento'>,
  escrito: string,
  origen: 'confirmacion' | 'firma',
  ip?: string,
  userAgent?: string,
): Promise<{ coincide: boolean; intentos_restantes: number }> {
  const coincide = documentoCoincide(escrito, auth.numero_documento);
  const { MAX_INTENTOS_DOCUMENTO } = await getCalibracion();
  // En la firma solo se registra el que no coincide: el acierto ya quedó al
  // confirmar. Pero no vale si los fallidos ya se agotaron (ráfaga en paralelo).
  if (coincide && origen === 'firma') {
    const fallidos = await contarIntentosFallidos(auth.id);
    return { coincide: fallidos == null || fallidos < MAX_INTENTOS_DOCUMENTO, intentos_restantes: 0 };
  }
  const intentos_restantes = await registrarIntentoDocumento({
    autorizacionId: auth.id,
    expedienteId: auth.expediente_id,
    tipoDigitado: auth.tipo_documento,
    valorDigitado: escrito,
    coincide,
    origen,
    ip,
    userAgent,
    maxIntentos: MAX_INTENTOS_DOCUMENTO,
  });
  if (!coincide && intentos_restantes === 0) {
    await detenerAutorizacion(auth, { motivo: 'datos_incorrectos', origen: 'documento_no_coincide' }, ip, userAgent);
  }
  // Acierto con los intentos ya agotados (ráfaga): no vale. Los fallidos ya detienen el enlace.
  if (coincide && intentos_restantes === 0) return { coincide: false, intentos_restantes: 0 };
  return { coincide, intentos_restantes: coincide ? MAX_INTENTOS_DOCUMENTO : intentos_restantes };
}

/**
 * §8.1: el prospecto escribe su numero de documento y se compara con la
 * ficha. Si coincide, queda confirmada su identidad; si no, le quedan
 * MAX_INTENTOS_DOCUMENTO en el mismo enlace (BLQ §1) y al agotarlos el enlace
 * se detiene y el gestor corrige y reenvía.
 */
export async function confirmarIdentidadProspecto(
  token: string,
  input: ConfirmarIdentidadInput,
  ip?: string,
  userAgent?: string,
): Promise<{ coincide: boolean; intentos_restantes?: number }> {
  const auth = await autorizacionPendientePorToken(token);
  const r = await cotejarDocumento(auth, input.numero_documento, 'confirmacion', ip, userAgent);
  if (!r.coincide) return { coincide: false, intentos_restantes: r.intentos_restantes };
  if (auth.expediente_id) {
    await registrarIdentidadConfirmada(auth.expediente_id, auth.id, new Date().toISOString());
  }
  return { coincide: true };
}

/**
 * Guarda lo que el prospecto declara en el PASO 5 (§8.2 laboral e ingreso,
 * §8.3 solo/acompanado). La identidad (§8.1) ya NO entra por aqui: exige el
 * documento escrito (confirmarIdentidadProspecto).
 *
 * Va a `autorizacion_perfil_prospecto` y NO a otro sitio, a proposito:
 *   - NO a `autorizaciones_habeas_data`: su trigger es una allowlist y
 *     cualquier columna nueva escrita ahi revienta la firma (restrict_violation)
 *     dejando a esa persona sin poder autorizar nunca;
 *   - NO a `solicitantes`: es el system-of-record del documento que se congela
 *     y se compara contra el buro, y su `ingresos_mensuales` es el numero del
 *     GESTOR, que la agencia si puede ver;
 *   - NO a `estudios.datos_formulario`: EstudioDetailModal vuelca ese JSON
 *     entero, clave por clave y sin allowlist, a la inmobiliaria — escribir el
 *     ingreso ahi haria falsa la promesa del §8.2 el primer dia.
 *
 * Best-effort: si la tabla no existe todavia (migracion sin correr) se loguea
 * y se sigue. Perder lo declarado es malo; bloquear la autorizacion, peor.
 */
export async function guardarPerfilProspecto(token: string, input: PerfilProspectoInput) {
  const auth = await autorizacionPendientePorToken(token);
  if (!auth.expediente_id) {
    logger.warn({ autorizacionId: auth.id }, 'PASO 5: autorizacion sin estudio — no se guarda el perfil');
    return { guardado: false };
  }

  const ahora = new Date().toISOString();
  // Solo las claves que vienen: un envio parcial no borra lo anterior.
  const fila: Record<string, unknown> = {
    expediente_id: auth.expediente_id,
    autorizacion_id: auth.id,
    updated_at: ahora,
  };
  if (input.situacion_laboral !== undefined) fila.situacion_laboral = input.situacion_laboral;
  if (input.donde_labora !== undefined) fila.donde_labora = input.donde_labora;
  if (input.ingreso_declarado_cop !== undefined) fila.ingreso_declarado_cop = input.ingreso_declarado_cop;
  if (input.presentacion !== undefined) fila.presentacion = input.presentacion;
  if (input.coarrendatario !== undefined) fila.coarrendatario_intencion = input.coarrendatario;

  const { error } = await (supabase
    .from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
    .upsert(fila as never, { onConflict: 'expediente_id' });

  if (error) {
    logger.warn(
      { error: error.message, expedienteId: auth.expediente_id },
      'PASO 5: no se pudo guardar el perfil declarado por el prospecto',
    );
    return { guardado: false };
  }

  // Politica Anexo A.3/A.4: «¿Tienes RUT activo?» distingue al independiente
  // formal del informal (este nunca se aprueba solo). UPDATE aparte a
  // proposito: la columna `tiene_rut` necesita migracion y, mientras no
  // exista, nombrarla en el upsert tiraria el perfil entero. Aqui solo se
  // pierde la respuesta del RUT (queda en el log).
  if (input.situacion_laboral === 'independiente' && input.tiene_rut !== undefined) {
    const { error: rutError } = await (supabase
      .from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
      .update({ tiene_rut: input.tiene_rut } as never)
      .eq('expediente_id', auth.expediente_id);
    if (rutError) {
      logger.warn(
        { error: rutError.message, expedienteId: auth.expediente_id },
        'PASO 5: no se pudo guardar la respuesta del RUT (¿falta la columna tiene_rut?)',
      );
    }
  }
  return { guardado: true };
}

// ============================================================
// 3c. PASO 5 — cotejo biometrico (Politica Anexo A + §14)
// ============================================================

/**
 * Lee el veredicto ya guardado para el expediente de esta autorizacion.
 * SELECT propio y tolerante: si la migracion 20260907000003 no corrio, nombrar
 * la columna reventaria el GET publico entero (42703) y dejaria al prospecto
 * sin pantalla. Aqui un fallo solo devuelve null.
 */
async function leerBiometriaPorAutorizacion(autorizacionId: string): Promise<ResumenBiometria | null> {
  try {
    const { data, error } = await (supabase
      .from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
      .select('biometria')
      .eq('autorizacion_id', autorizacionId)
      .maybeSingle();
    if (error) {
      logger.warn({ autorizacionId, error: error.message }, 'Biometria: no se pudo leer el veredicto previo');
      return null;
    }
    return leerResumenBiometria((data as { biometria?: unknown } | null)?.biometria);
  } catch (err) {
    logger.warn({ autorizacionId, err: err instanceof Error ? err.message : String(err) }, 'Biometria: excepcion leyendo el veredicto previo');
    return null;
  }
}

/** Guarda el veredicto en la fila del PASO 5. Best-effort, no lanza. */
async function persistirBiometria(
  expedienteId: string,
  autorizacionId: string,
  resumen: ResumenBiometria,
): Promise<boolean> {
  const { error } = await (supabase
    .from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
    .upsert(
      {
        expediente_id: expedienteId,
        autorizacion_id: autorizacionId,
        biometria: resumen as unknown,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: 'expediente_id' },
    );
  if (error) {
    logger.warn({ expedienteId, error: error.message }, 'Biometria: no se pudo persistir el veredicto');
    return false;
  }
  return true;
}

/**
 * Cotejo cara-vs-documento del prospecto. Cierra el riesgo que el Flujo §12
 * manda documentar ("enlace reenviado a un tercero").
 *
 * LO QUE ESTA FUNCION *NO* HACE: bloquear. Devuelve el veredicto y el front
 * deja continuar SIEMPRE — incluso con 'no_coincide'. Quien decide es el §14
 * mas adelante, mandando el estudio a revision manual. Bloquear aqui seria
 * (a) inventar un rechazo que la Politica no da a esta fuente y (b) dejar sin
 * salida a quien simplemente tiene mala camara.
 *
 * LAS IMAGENES NO SE GUARDAN NI SE LOGUEAN. Entran por el body, van a Auco y
 * mueren con el request (ver la migracion 20260907000003).
 */
export async function verificarBiometriaProspecto(
  token: string,
  input: { documentImage: string; photo: string },
) {
  const auth = await autorizacionPendientePorToken(token);
  // Adenda 2 §9 y §10: el mismo umbral del panel que la firma del contrato.
  const umbral = (await getCalibracion()).UMBRAL_SIMILITUD_BIOMETRICA;

  if (!biometriaAplica(auth.version_terminos)) {
    // No es un error del cliente: el front puede tener el paso cacheado de
    // antes de apagar el interruptor. Se responde 'desactivada' y sigue.
    return { estado: 'desactivada' as const, similitud: null, umbral, motivo: null, guardado: false };
  }

  const { data: solRow } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('tipo_documento, numero_documento')
    .eq('id', auth.solicitante_id)
    .maybeSingle();
  const sol = solRow as { tipo_documento?: string | null; numero_documento?: string | null } | null;

  const resumen = await validarIdentidadProspecto({
    autorizacionId: auth.id,
    tipo_documento: sol?.tipo_documento,
    numero_documento: sol?.numero_documento,
    documentImage: input.documentImage,
    photo: input.photo,
  });

  const guardado = auth.expediente_id
    ? await persistirBiometria(auth.expediente_id, auth.id, resumen)
    : false;

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.AUTORIZACION_BIOMETRIA,
    entidad: AUDIT_ENTITIES.AUTORIZACION,
    entidadId: auth.id,
    detalle: {
      estado: resumen.estado,
      similitud: resumen.similitud,
      umbral: resumen.umbral,
      documento_coincide: resumen.documento_coincide,
      auco_code: resumen.code,
      expediente_id: auth.expediente_id,
    },
  });

  // Al prospecto NO se le devuelve el porcentaje cuando no coincide: es un
  // parametro del control antifraude y sirve de oraculo para calibrar un
  // intento de suplantacion ("con esta foto subi de 41 a 63"). El gestor si lo
  // ve, en la ficha del expediente.
  return {
    estado: resumen.estado,
    similitud: resumen.estado === 'verificada' ? resumen.similitud : null,
    umbral,
    motivo: resumen.estado === 'verificada' ? null : mensajeProspectoBiometria(resumen.estado),
    guardado,
  };
}

/** Copy para el prospecto. Sin cifras, sin nombrar a Auco, sin dramatismo. */
function mensajeProspectoBiometria(estado: ResumenBiometria['estado']): string {
  switch (estado) {
    case 'no_coincide':
      return 'No pudimos confirmar que la foto y el documento sean de la misma persona. Puede intentarlo de nuevo con mejor luz, o continuar: alguien de nuestro equipo revisará su caso.';
    case 'omitida':
      return 'Continuamos sin la verificación con foto. Su estudio sigue: lo revisará una persona de nuestro equipo.';
    default:
      return 'No pudimos completar la verificación en este momento. Puede continuar: alguien de nuestro equipo revisará su caso.';
  }
}

/**
 * El prospecto se niega a dar la foto. Ley 1581 art. 6-a: NO esta obligado a
 * autorizar el tratamiento de un dato sensible, y el texto legal se lo dice.
 * Se registra el ejercicio del derecho —no el silencio— y el caso sigue vivo
 * rumbo a revision manual (§14).
 */
export async function omitirBiometriaProspecto(token: string) {
  const auth = await autorizacionPendientePorToken(token);
  const resumen = biometriaOmitida(new Date().toISOString(), (await getCalibracion()).UMBRAL_SIMILITUD_BIOMETRICA);

  const guardado = auth.expediente_id
    ? await persistirBiometria(auth.expediente_id, auth.id, resumen)
    : false;

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.AUTORIZACION_BIOMETRIA,
    entidad: AUDIT_ENTITIES.AUTORIZACION,
    entidadId: auth.id,
    detalle: { estado: 'omitida', expediente_id: auth.expediente_id },
  });

  return { estado: resumen.estado, motivo: mensajeProspectoBiometria('omitida'), guardado };
}

/**
 * §8.1 + §12: "El prospecto reporta que no es el. El estudio se detiene, se
 * marca para revision y se notifica al solicitante y a Cofianza."
 *
 * NO existe la "correccion" literal del §8.1 (que el prospecto reescriba su
 * documento desde la pantalla publica) y no es un olvido: ver el comentario de
 * `identidad_confirmada` en la migracion 20260907000001. Confirmar o reportar,
 * dos salidas, ninguna escribe identidad. La correccion real la hace el gestor
 * en el dashboard —donde esta auditada y scopeada— y reenvia el enlace.
 */
export async function reportarIdentidadProspecto(
  token: string,
  input: ReportarIdentidadInput,
  ip?: string,
  userAgent?: string,
) {
  let auth: AutorizacionPendiente;
  try {
    auth = await autorizacionPendientePorToken(token);
  } catch (err) {
    // M1 (revisión 2026-09-28): el enlace ya no está pendiente. Solo es éxito si
    // fue ESTE reporte el que lo detuvo (un reintento tras un corte de datos).
    // Si no (vencido, firmado en otra pestaña, detenido por otra cosa), el error
    // sigue: la pantalla no puede decir «detuvimos el proceso» sin reporte.
    if (err instanceof AppError && err.errorCode === 'AUTORIZACION_NO_VIGENTE' && (await yaReportadoPorToken(token))) {
      return { reportado: true };
    }
    throw err;
  }
  await detenerAutorizacion(auth, { ...input, origen: 'reporte_identidad_prospecto' }, ip, userAgent);
  return { reportado: true };
}

/** ¿Ya hay un reporte de identidad guardado para la autorización de este token? */
async function yaReportadoPorToken(token: string): Promise<boolean> {
  const { data: aut, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('token', token)
    .maybeSingle();
  const autorizacionId = (aut as { id?: string } | null)?.id;
  if (error || !autorizacionId) return false;
  const { data: rep, error: repError } = await (supabase
    .from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
    .select('identidad_reporte')
    .eq('autorizacion_id', autorizacionId)
    .not('identidad_reporte', 'is', null)
    .limit(1)
    .maybeSingle();
  return !repError && !!rep;
}

/** Por que se detiene el enlace: el reporte del prospecto o el documento que no coincide. */
interface Detencion extends ReportarIdentidadInput {
  origen: 'reporte_identidad_prospecto' | 'documento_no_coincide';
}

/**
 * Camino UNICO para detener un enlace pendiente (§12): reporte + expirar +
 * avisos. Lo usan el reporte del prospecto y el documento escrito que no
 * coincide con la ficha (§8.1).
 *
 * ORDEN NO NEGOCIABLE: primero se guarda el reporte, DESPUES se expira la
 * autorizacion. Al reves, el chequeo de estado='pendiente' del propio servicio
 * rechazaria la escritura del reporte y se perderia el motivo.
 */
async function detenerAutorizacion(
  auth: Pick<AutorizacionPendiente, 'id' | 'expediente_id' | 'solicitante_id'>,
  input: Detencion,
  ip?: string,
  userAgent?: string,
): Promise<void> {
  const ahora = new Date().toISOString();

  // 1. Traza del reporte (antes de expirar — ver el comentario de arriba).
  if (auth.expediente_id) {
    const { error: perfilError } = await (supabase
      .from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
      .upsert(
        {
          expediente_id: auth.expediente_id,
          autorizacion_id: auth.id,
          identidad_reporte: input.motivo,
          identidad_reporte_detalle: input.detalle ?? null,
          identidad_reporte_en: ahora,
          // Mismo truncado defensivo que coarrendatarios.service: un valor
          // largo daria un 22001 opaco justo en el camino de un reporte.
          identidad_reporte_ip: ip ? ip.slice(0, 45) : null,
          identidad_reporte_user_agent: userAgent ? userAgent.slice(0, 1000) : null,
          updated_at: ahora,
        } as never,
        { onConflict: 'expediente_id' },
      );
    if (perfilError) {
      logger.warn(
        { error: perfilError.message, expedienteId: auth.expediente_id },
        '§12: no se pudo guardar el reporte de identidad (el enlace se expira igual)',
      );
    }
  }

  // 2. Detener el proceso. 'expirado' es la UNICA transicion que
  //    fn_autorizaciones_habeas_data_inalterable permite sobre una fila
  //    pendiente, y solo puede tocar `estado`. Basta: sin autorizacion vigente,
  //    el gate fail-closed assertAutorizacionVigente impide toda consulta
  //    FACTURABLE al buro. Por eso no se inventa ningun estado nuevo de
  //    estudio ni de expediente.
  const { data: detenida, error: detErr } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'expirado' } as never)
    .eq('id', auth.id)
    .eq('estado', 'pendiente')
    .select('id');
  // Otra petición ya lo detuvo (ráfaga de fallidos): un solo aviso. Si no se
  // sabe (error), se avisa: mejor repetido que perdido.
  if (!detErr && Array.isArray(detenida) && detenida.length === 0) return;
  // BLQ §7: el motivo de cierre del enlace (intentos agotados o el reporte).
  const motivoCierre: MotivoCierre = input.origen === 'documento_no_coincide' ? 'intentos' : input.motivo;
  await cerrarEnvios([auth.id], motivoCierre);

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.AUTORIZACION_REVOCADA,
    entidad: AUDIT_ENTITIES.AUTORIZACION,
    entidadId: auth.id,
    detalle: {
      origen: input.origen,
      motivo: input.motivo,
      detalle: input.detalle ?? null,
      solicitante_id: auth.solicitante_id,
    },
    ip,
  });

  // 3. "Se marca para revision" + avisos. Fire-and-forget: el enlace ya quedo
  //    muerto, que es lo unico que no puede fallar.
  if (auth.expediente_id) {
    void avisarReporteIdentidad(auth.expediente_id, input).catch((err) =>
      logger.warn({ error: err }, '§12: fallo el fan-out del reporte de identidad'),
    );
  }
}

const MOTIVO_REPORTE_LABEL: Record<string, string> = {
  no_soy_yo: 'la persona que abrió el enlace dice que NO es el titular de esos datos',
  datos_incorrectos: 'los datos registrados no corresponden a esa persona',
};

/** El §8.1 nunca revela el numero: el aviso dice que no coincidio, no cual escribio. */
const LABEL_DOCUMENTO_NO_COINCIDE =
  'el número de documento que escribió quien abrió el enlace no coincide con el registrado';

/**
 * Evento de timeline + notificaciones del §12. Tipo 'estudio' a proposito: la
 * UI del timeline filtra por una lista CERRADA de tipos, asi que un tipo nuevo
 * se escribiria pero seria invisible (ya paso con citas y contratos).
 *
 * Canales: in-app + correo a Cofianza. BLQ §2: el documento que no coincide
 * (intentos agotados) es una alerta PRIORITARIA (tipo propio, que la web
 * destaca) con el texto del §2.2, y además WhatsApp al asesor, solo para ese
 * evento y solo con ALERTA_BLOQUEO_WHATSAPP=1 (se enciende cuando Meta apruebe
 * la plantilla).
 *
 * No se le escribe al contacto del solicitante: si acaban de reportar que
 * esos datos no son de esa persona, ese correo y ese telefono son justamente
 * los que estan en duda.
 */
async function avisarReporteIdentidad(expedienteId: string, input: Detencion) {
  const [{ notificarUsuario, notificarYCorreo, notificarResponsableExpediente }, { listOperators }] =
    await Promise.all([
      import('@/modules/notificaciones/notificaciones.service'),
      import('@/modules/users/users.service'),
    ]);

  const { data: expRow } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero, miembro_responsable_id, solicitantes(nombre, apellido), inmuebles!expedientes_inmueble_id_fkey(propietario_id, inmobiliaria_id, direccion)')
    .eq('id', expedienteId)
    .maybeSingle();
  const exp = expRow as unknown as {
    numero?: string;
    miembro_responsable_id?: string | null;
    solicitantes?: { nombre?: string | null; apellido?: string | null } | null;
    inmuebles?: { propietario_id?: string | null; inmobiliaria_id?: string | null; direccion?: string | null } | null;
  } | null;

  const titulo = 'Verificación de identidad detenida';
  const porDocumento = input.origen === 'documento_no_coincide';
  // `input.detalle` NO entra aqui, y no es un olvido. Es texto libre de un
  // endpoint PUBLICO sin sesion (500 chars, cualquier charset) y este mensaje
  // va a la campanita del propietario y del miembro responsable de la
  // inmobiliaria, y por correo HTML a todos los operadores: incrustarlo
  // (a) burlaba la allowlist de leerPerfilProspecto, que le esconde
  //     `identidad_reporte_detalle` justo a esos dos roles porque "puede
  //     contener cualquier cosa" (y suele traer PII de terceros), y
  // (b) convertia el dominio verificado de Cofianza en un vector de phishing
  //     (un <a href> del atacante dentro de un correo legitimo).
  // El detalle vive en UN solo sitio, con UN solo control de acceso:
  // autorizacion_perfil_prospecto.identidad_reporte_detalle, que AutorizacionSection
  // renderiza escapado por JSX y solo para roles internos.
  const motivoLabel =
    input.origen === 'documento_no_coincide' ? LABEL_DOCUMENTO_NO_COINCIDE : MOTIVO_REPORTE_LABEL[input.motivo];
  const nombreProspecto = `${exp?.solicitantes?.nombre ?? ''} ${exp?.solicitantes?.apellido ?? ''}`.trim() || 'su prospecto';
  const mensaje = porDocumento
    ? // BLQ §2.2: qué pasó, qué hacer y qué NO pasó con el cupo (§2.3).
      `El estudio de ${nombreProspecto} no pudo continuar: el número de documento no coincide con el registrado. ` +
      'Verifique el documento del prospecto, corrija el dato y reenvíe el enlace. ' +
      ((await pagadoConCupo(expedienteId)) ? 'No se consumió ningún cupo de su paquete.' : 'No se generó ningún cobro adicional.')
    : `En el estudio ${exp?.numero ? formatNumeroEstudio(exp.numero) : expedienteId}, ${motivoLabel}. ` +
      'Detuvimos el enlace de autorización y no se consultará ninguna central de riesgo. ' +
      'Revise los datos del solicitante y, si corresponde, envíe un enlace nuevo.' +
      (input.detalle ? ' Quien reportó dejó una nota: la ve el equipo de Cofianza en el estudio.' : '');
  const link = `/expedientes/${expedienteId}`;
  // La web destaca este tipo como alerta prioritaria (BLQ §2.1).
  const tipo = porDocumento ? 'autorizacion.bloqueo_documento' : 'autorizacion.identidad_reportada';
  const payload = { expediente_id: expedienteId, motivo: input.motivo, ...(porDocumento ? { prioridad: 'alta' } : {}) };
  const whatsappOn = porDocumento && (await getCalibracion()).ALERTA_BLOQUEO_WHATSAPP === 1;
  // La plantilla ya dice «n.º {{3}}»: el número sin el «N.°» de formatNumeroEstudio.
  const numero = formatNumeroEstudio(exp?.numero).replace(/^N\.° /, '');
  // {{1}} asesor (lo pone notificarResponsableExpediente), {{2}} prospecto, {{3}} n.º; botón = id del estudio.
  const whatsapp = whatsappOn
    ? { template: 'ESTUDIO_BLOQUEADO_DOCUMENTO' as const, variables: ['', nombreProspecto, numero], reservaNombre: 'señor(a)', urlButtons: [expedienteId] }
    : undefined;

  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'estudio',
      descripcion: `Autorizacion detenida: ${motivoLabel}. Marcado para revision.`,
      metadata: { automatico: true, origen: input.origen, motivo: input.motivo },
    } as never);

  const propietarioId = exp?.inmuebles?.propietario_id ?? null;
  const responsableId = exp?.miembro_responsable_id ?? null;
  if (propietarioId) {
    await notificarUsuario({
      userId: propietarioId,
      tipo,
      titulo,
      mensaje,
      link,
      payload,
    }).catch((e) => logger.warn({ error: e }, '§12: notif propietario'));
  }
  await notificarResponsableExpediente({
    expedienteId,
    miembroId: responsableId,
    excluirPerfilId: propietarioId,
    tipo,
    titulo,
    mensaje,
    link,
    payload,
    whatsapp,
  }).catch((e) => logger.warn({ error: e }, '§12: notif responsable'));
  // BLQ §2.4: sin responsable distinto del dueño, el WhatsApp va a los titulares
  // de la organización o, sin organización, al propietario.
  if (whatsapp && (!responsableId || responsableId === propietarioId)) {
    await avisarTitularesPorWhatsapp(expedienteId, exp?.inmuebles ?? null, whatsapp).catch((e) =>
      logger.warn({ error: e }, 'BLQ: WhatsApp a los titulares'),
    );
  }

  // "y a Cofianza": no existe un canal interno unico, asi que se avisa a los
  // operadores activos (in-app + correo con la cascara generica).
  const operadores = await listOperators().catch(() => []);
  await Promise.all(
    operadores.map((op) =>
      notificarYCorreo({
        userId: op.id,
        tipo,
        titulo,
        mensaje,
        link,
        payload,
      }).catch((e) => logger.warn({ error: e }, '§12: notif operador Cofianza')),
    ),
  );
}

/** BLQ §2.3: ¿la evaluación se pagó con un cupo del paquete? (reserva o consumo del expediente). */
async function pagadoConCupo(expedienteId: string): Promise<boolean> {
  const { data, error } = await (supabase
    .from('movimientos_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('expediente_id', expedienteId)
    .in('tipo', ['reserva', 'consumo'])
    .limit(1);
  return !error && ((data as unknown[] | null) ?? []).length > 0;
}

/** BLQ §2.4: WhatsApp a los titulares de la organización del inmueble o, si no hay, al propietario. */
async function avisarTitularesPorWhatsapp(
  expedienteId: string,
  inm: { propietario_id?: string | null; inmobiliaria_id?: string | null } | null,
  whatsapp: { variables: string[]; urlButtons: string[] },
): Promise<void> {
  const inmobiliariaId =
    inm?.inmobiliaria_id || (inm?.propietario_id ? await resolveInmobiliariaIdForPerfil(inm.propietario_id) : null);
  let ids: string[] = [];
  if (inmobiliariaId) {
    const { data } = await (supabase
      .from('inmobiliaria_miembros' as string) as ReturnType<typeof supabase.from>)
      .select('perfil_id')
      .eq('inmobiliaria_id', inmobiliariaId)
      .eq('estado', 'activo')
      .eq('rol_miembro', 'owner')
      .not('perfil_id', 'is', null);
    ids = ((data as Array<{ perfil_id: string }> | null) ?? []).map((m) => m.perfil_id);
  }
  if (ids.length === 0 && inm?.propietario_id) ids = [inm.propietario_id];
  if (ids.length === 0) return;
  const { data: perfiles } = await (supabase
    .from('perfiles' as string) as ReturnType<typeof supabase.from>)
    .select('nombre, apellido, razon_social, telefono')
    .in('id', ids);
  const { enviarTemplate } = await import('@/modules/whatsapp');
  for (const p of (perfiles as Array<{ nombre?: string | null; apellido?: string | null; razon_social?: string | null; telefono?: string | null }> | null) ?? []) {
    if (!p.telefono) continue;
    const nombre = p.razon_social || `${p.nombre ?? ''} ${p.apellido ?? ''}`.trim() || 'señor(a)';
    await enviarTemplate({
      to: p.telefono,
      template: 'ESTUDIO_BLOQUEADO_DOCUMENTO',
      variables: [nombre, ...whatsapp.variables.slice(1)],
      urlButtons: whatsapp.urlButtons,
      context: { expediente_id: expedienteId },
    });
  }
}

/**
 * Flujo §9: "El solicitante recibe una notificacion indicando que el prospecto
 * ya autorizo". Hasta 2026-09-07 solo quedaba en la bitacora (y solo en la
 * opcion C): el gestor se enteraba al ver que el estudio ya corria. In-app al
 * propietario del inmueble (si lo hay) y al responsable del expediente. Best
 * effort: la firma ya quedo escrita.
 */
async function avisarAutorizacionFirmada(expedienteId: string, solicitanteId: string) {
  const { notificarUsuario, notificarResponsableExpediente } =
    await import('@/modules/notificaciones/notificaciones.service');

  const { data: expRow } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero, inmuebles!expedientes_inmueble_id_fkey(propietario_id, direccion), solicitantes(nombre, apellido)')
    .eq('id', expedienteId)
    .maybeSingle();
  const exp = expRow as unknown as {
    numero?: string;
    inmuebles?: { propietario_id?: string | null; direccion?: string | null } | null;
    solicitantes?: { nombre?: string | null; apellido?: string | null } | null;
  } | null;

  const nombre = `${exp?.solicitantes?.nombre ?? ''} ${exp?.solicitantes?.apellido ?? ''}`.trim() || 'El prospecto';
  const titulo = 'El prospecto ya autorizó';
  const mensaje = `${nombre} autorizó la consulta en centrales de riesgo para el estudio ${formatNumeroEstudio(exp?.numero)}${exp?.inmuebles?.direccion ? ` (${exp.inmuebles.direccion})` : ''}. El estudio continúa según la forma de pago elegida.`;
  const link = `/expedientes/${expedienteId}`;
  const payload = { expediente_id: expedienteId, solicitante_id: solicitanteId };

  const propietarioId = exp?.inmuebles?.propietario_id ?? null;
  if (propietarioId) {
    await notificarUsuario({ userId: propietarioId, tipo: 'autorizacion.firmada', titulo, mensaje, link, payload })
      .catch((e) => logger.warn({ error: e }, '§9: notif propietario'));
  }
  await notificarResponsableExpediente({
    expedienteId,
    excluirPerfilId: propietarioId,
    tipo: 'autorizacion.firmada',
    titulo,
    mensaje,
    link,
    payload,
  }).catch((e) => logger.warn({ error: e }, '§9: notif responsable'));
}

// ============================================================
// 4. Firmar autorizacion (public)
// ============================================================

export async function firmarAutorizacion(
  token: string,
  input: FirmarInput,
  ip?: string,
  userAgent?: string,
) {
  // 1. Get autorizacion and validate
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, token_expiracion, texto_autorizado, solicitante_id, expediente_id, solicitantes(tipo_documento, numero_documento), expedientes(estado)')
    .eq('token', token)
    .maybeSingle();

  // Distinguir error real de BD (→ 500, reintentable) de "no existe" (→ 404).
  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion para firmar');
    throw fromSupabaseError(error);
  }
  if (!autorizacion) {
    throw AppError.notFound('Autorización no encontrada', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as AutorizacionRow & {
    expediente_id?: string;
    solicitantes?: { tipo_documento: string | null; numero_documento: string | null } | null;
    expedientes?: { estado: string } | null;
  };

  // Estudio cancelado o rechazado: no se firma (ni se dispara el orquestador).
  // 'autorizado' sigue siendo exito idempotente: esa firma ya existe.
  if (auth.estado !== 'autorizado') assertEstudioActivo(auth.expedientes?.estado);

  if (auth.estado !== 'pendiente') {
    // Diferenciar: 'autorizado' = ya firmada (el front puede mostrar éxito
    // idempotente); expirado/revocado = el enlace ya NO sirve — mostrar éxito
    // aquí haría creer al solicitante que terminó cuando nada va a correr.
    if (auth.estado === 'autorizado') {
      throw AppError.badRequest('Esta autorización ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorización ya no está vigente', 'AUTORIZACION_NO_VIGENTE');
  }

  if (new Date(auth.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de autorización ha expirado', 'AUTORIZACION_EXPIRADA');
  }

  // 1b. §8.1: la firma lleva el documento que escribio el prospecto y se
  // compara otra vez con la ficha (el paso de confirmar-identidad lo hace la
  // web, pero un POST directo lo saltaria). Si no coincide cuenta como un
  // intento más (BLQ §1); agotados, el enlace muere y el gestor corrige. Sin
  // esto, un digito mal puesto en la ficha terminaba en la consulta de un tercero.
  const cotejo = await cotejarDocumento(
    {
      id: auth.id,
      expediente_id: auth.expediente_id ?? null,
      solicitante_id: auth.solicitante_id,
      numero_documento: auth.solicitantes?.numero_documento ?? null,
      tipo_documento: auth.solicitantes?.tipo_documento ?? null,
    },
    input.numero_documento,
    'firma',
    ip,
    userAgent,
  );
  if (!cotejo.coincide) {
    throw AppError.badRequest('El documento no coincide con el registrado', 'DOCUMENTO_NO_COINCIDE', {
      intentos_restantes: cotejo.intentos_restantes,
    });
  }

  // 2. OTP — SOLO si el metodo declarado es 'otp' (Adenda 1 §7).
  //
  // Historia corta: hasta 2026-09-04 el OTP colgaba de `metodo_firma === 'otp'`
  // y 'canvas' lo saltaba (un curl con el token bastaba para autorizar en
  // nombre del titular). Se cerro exigiendo OTP a TODA firma. Tres dias
  // despues la Gerencia General decidio por escrito lo contrario:
  //
  //   Adenda 1 §7: "No se implementa OTP en el flujo de autorizacion del
  //   estudio. [...] Riesgo aceptado que queda registrado. Sin OTP, la
  //   evidencia de que la autorizacion fue otorgada por el titular y no por un
  //   tercero que recibio el enlace reenviado se apoya unicamente en el
  //   registro de la aceptacion: fecha, hora, IP, dispositivo, texto aceptado
  //   y documento confirmado. Es una decision consciente de la Gerencia
  //   General para no agregar friccion en esta etapa."
  //
  // Asi que 'casilla' (y 'canvas') firman sin OTP, y ESO ES LO DECIDIDO, no un
  // descuido. Si el front manda 'otp', se sigue verificando: mas prueba nunca
  // sobra. El §8.1 (confirmacion de identidad) y la biometria opcional
  // (AUCO_BIOMETRIA_ENABLED) son las defensas que quedan.
  if (input.metodo_firma === 'otp') {
    const { data: otp } = await (supabase
      .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
      .select('id, codigo, expira_en, verificado')
      .eq('autorizacion_id', auth.id)
      .eq('verificado', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!otp) {
      throw AppError.badRequest(
        'Debe verificar el código OTP antes de firmar',
        'OTP_NO_VERIFICADO',
      );
    }

    // Un OTP verificado pero caducado no sirve como prueba de posesion
    // reciente: hay que pedir y verificar uno nuevo.
    if (new Date((otp as unknown as OtpRow).expira_en) < new Date()) {
      throw AppError.badRequest(
        'El código OTP expiró. Solicite uno nuevo y verifíquelo antes de firmar.',
        'OTP_EXPIRADO',
      );
    }
  }

  // 3. Compute SHA-256 hash of legal text + signature data
  const hashContent = [
    auth.texto_autorizado,
    input.metodo_firma,
    input.datos_firma || '',
    ip || '',
    userAgent || '',
    new Date().toISOString(),
  ].join('|');

  const hashDocumento = crypto.createHash('sha256').update(hashContent).digest('hex');

  // 3b. Congelar el documento del aceptante (flujo 8.4: "el numero de
  // documento de quien acepto"). Se toma un SNAPSHOT de `solicitantes` en el
  // instante de la aceptacion y se guarda en la propia fila: el campo de
  // `solicitantes` es editable por el gestor y el backend lo reescribe tras
  // cada ejecucion (sincronizarDocumentoSolicitante), asi que leerlo por FK
  // mas tarde no prueba a quien se le pidio la autorizacion.
  const numeroDocumentoAceptante = auth.solicitantes?.numero_documento?.trim() || null;
  // (Nunca vacio: sin numero en la ficha, documentoCoincide ya detuvo la firma.)
  const tipoDocumentoAceptante = auth.solicitantes?.tipo_documento?.trim().toLowerCase() || null;

  // 3c. Vigencia congelada. Se calcula una sola vez, aqui, para que un cambio
  // de politica no reescriba evidencia pasada.
  const autorizadoEn = new Date();
  const vigenteHasta = new Date(autorizadoEn);
  vigenteHasta.setMonth(vigenteHasta.getMonth() + env.AUTORIZACION_VIGENCIA_MESES);

  // 4. Update autorizacion to autorizado.
  // Idempotencia / anti doble-firma: el UPDATE incluye `.eq('estado','pendiente')`,
  // así la transición es atómica. Si dos POST /firmar entran concurrentes, solo uno
  // afecta filas; el otro recibe 0 filas y se trata como "ya procesada" SIN volver a
  // disparar el orquestador (evita estudio de crédito duplicado).
  const { data: updatedRows, error: updateError } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'autorizado',
      metodo_firma: input.metodo_firma,
      datos_firma: input.datos_firma || null,
      hash_documento: hashDocumento,
      autorizado_en: autorizadoEn.toISOString(),
      ip_autorizacion: ip || null,
      user_agent: userAgent || null,
      // Evidencia del 8.4 que faltaba: documento del aceptante congelado.
      numero_documento_aceptante: numeroDocumentoAceptante,
      tipo_documento_aceptante: tipoDocumentoAceptante,
      vigencia_meses: env.AUTORIZACION_VIGENCIA_MESES,
      vigente_hasta: vigenteHasta.toISOString(),
      // Consentimientos opcionales (Paso 2). No condicionan el servicio.
      consent_analitica: input.consentimientos_opcionales?.analitica ?? false,
      consent_comercial: input.consentimientos_opcionales?.comercial ?? false,
      consent_historial_referencia: input.consentimientos_opcionales?.historial_referencia ?? false,
    } as never)
    .eq('id', auth.id)
    .eq('estado', 'pendiente')
    .select('id');

  if (updateError) {
    logger.error({ error: updateError, autorizacionId: auth.id }, 'Error al firmar autorizacion');
    throw AppError.badRequest('Error al firmar la autorización', 'AUTORIZACION_FIRMA_ERROR');
  }

  if (!updatedRows || (updatedRows as unknown[]).length === 0) {
    // Otra request la procesó entre la lectura y el UPDATE. Releer para
    // diferenciar: 'autorizado' = doble submit (éxito idempotente en el front);
    // expirado/revocado (reenvío que invalidó este enlace) = NO mostrar éxito.
    const { data: actual } = await (supabase
      .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
      .select('estado')
      .eq('id', auth.id)
      .maybeSingle();
    const estadoActual = (actual as { estado?: string } | null)?.estado;
    if (estadoActual === 'autorizado') {
      throw AppError.badRequest('Esta autorización ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorización ya no está vigente', 'AUTORIZACION_NO_VIGENTE');
  }

  // 4b. Flujo §8.1: el documento ya coincidio arriba, asi que la identidad
  // queda confirmada con las MISMAS columnas que confirmar-identidad
  // (camposIdentidadConfirmada), por si ese paso no alcanzo a escribirla.
  if (auth.expediente_id) {
    await registrarIdentidadConfirmada(auth.expediente_id, auth.id, autorizadoEn.toISOString());
  }

  // 5. Audit
  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.AUTORIZACION_FIRMADA,
    entidad: AUDIT_ENTITIES.AUTORIZACION,
    entidadId: auth.id,
    detalle: {
      solicitante_id: auth.solicitante_id,
      metodo_firma: input.metodo_firma,
      documento_confirmado: true,
      hash_documento: hashDocumento,
      ip,
    },
    ip,
  });

  // 6. Orchestrator: disparar estudio automatico si hay expediente asociado
  if (auth.expediente_id) {
    // §9: aviso al gestor de que el prospecto ya autorizo. Fire-and-forget.
    void avisarAutorizacionFirmada(auth.expediente_id, auth.solicitante_id).catch((err) =>
      logger.warn({ error: err, expedienteId: auth.expediente_id }, '§9: no se pudo avisar la autorizacion firmada'),
    );

    import('@/modules/orchestrator/orchestrator.service')
      .then(({ onHabeasDataAutorizado }) =>
        onHabeasDataAutorizado({
          expedienteId: auth.expediente_id!,
          solicitanteId: auth.solicitante_id,
          autorizacionId: auth.id,
        }),
      )
      .catch((err) => logger.warn({ error: err }, 'Orchestrator: error en hook post-autorizacion'));
  }

  // §6.3: al prospecto le toca pagar DESPUÉS de firmar (opción C). La pantalla
  // pública no puede inferirlo —el mismo endpoint sirve a A y B, donde el pago
  // ya ocurrió y ofrecerle un cobro sería cobrar dos veces—, así que el dato
  // viaja en la respuesta. Es una lectura barata y DERIVADA: no toca la
  // pasarela, para no colgar al prospecto con un spinner después de haber
  // escrito evidencia legal que ya quedó inmutable. El link real se lo mandan
  // el correo y el WhatsApp que dispara el hook de arriba.
  //
  // "No hay pago completado" NO alcanza como criterio: en A y B, y mientras el
  // gestor no haya decidido quién paga, el backend resuelve 'esperar_pago' y NO
  // envía ningún cobro — prometerle "revisa tu correo para pagar" lo dejaba
  // esperando un correo que no existe, y encima le pedía plata a quien no le
  // toca pagar. Solo la opción C (estudios.pago_por='arrendatario', que escribe
  // marcarPagoArrendatario) le genera el link al firmar.
  // La firma ya quedó guardada: un fallo leyendo el pagador no la puede tumbar
  // (antes daba false en silencio; ahora queda en el log). La pantalla de «ya
  // firmaste» vuelve a preguntar por el pago con getPagoProspectoPorToken.
  let pagoRequerido = false;
  if (auth.expediente_id) {
    try {
      pagoRequerido = !(await estudioPagado(auth.expediente_id)) && (await cobroLeTocaAlProspecto(auth.expediente_id));
    } catch (err) {
      logger.warn({ autorizacionId: auth.id, err: err instanceof Error ? err.message : String(err) }, 'Firma: no se pudo saber si al prospecto le toca pagar');
    }
  }

  return {
    estado: 'autorizado',
    hash_documento: hashDocumento,
    autorizado_en: autorizadoEn.toISOString(),
    pago_requerido: pagoRequerido,
  };
}

/**
 * Estado del cobro del prospecto para la pantalla de "ya firmaste".
 *
 * Tras firmar, la pantalla le decia "te enviamos el enlace de pago por correo y
 * WhatsApp": el prospecto tenia que salir de la pagina a buscar un mensaje que
 * el orquestador genera fire-and-forget segundos despues. Con esto la propia
 * pantalla espera el enlace y lo muestra.
 *
 * No expone email, external_id ni nada del expediente: solo estado, monto y el
 * enlace de pago cuando ya existe.
 */
export async function getPagoProspectoPorToken(token: string): Promise<{
  estado: 'preparando' | 'sin_enlace' | 'pendiente' | 'procesando' | 'completado' | 'no_aplica';
  monto_formateado: string | null;
  payment_link_url: string | null;
}> {
  const { data: auth } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, expediente_id, autorizado_en')
    .eq('token', token)
    .maybeSingle();
  const a = auth as { estado?: string; expediente_id?: string | null; autorizado_en?: string | null } | null;
  if (!a) throw AppError.notFound('Autorización no encontrada', 'AUTORIZACION_NOT_FOUND');
  if (a.estado !== 'autorizado' || !a.expediente_id) {
    return { estado: 'no_aplica', monto_formateado: null, payment_link_url: null };
  }
  // B16: el pagador y la fila de pago se leen a la vez (~200 ms por consulta).
  const [leTocaPagar, { data: pagoRow }] = await Promise.all([
    cobroLeTocaAlProspecto(a.expediente_id),
    (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('estado, monto, tarifa_iva, payment_link_url')
      .eq('expediente_id', a.expediente_id)
      .eq('concepto', 'estudio')
      .in('estado', ['pendiente', 'procesando', 'completado'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!leTocaPagar) {
    return { estado: 'no_aplica', monto_formateado: null, payment_link_url: null };
  }
  const pago = pagoRow as { estado?: string; monto?: number; tarifa_iva?: number | null; payment_link_url?: string | null } | null;

  const montoFormateado = await montoAlProspecto(pago);

  // Una fila 'pendiente' sin URL significa que el link todavia se esta creando
  // en la pasarela: el front sigue esperando en vez de mostrar un boton muerto.
  const listo = pago?.estado === 'pendiente' && !!pago.payment_link_url;
  // Sin fila de pago a los 2 minutos de la firma, el orquestador (que tarda
  // segundos) ya no la va a crear: sin correo del solicitante, tope de canon o
  // pasarela caida. Lo arregla el gestor desde el estudio; la pantalla deja de
  // decir "estamos preparando tu enlace" para siempre.
  const firmadaHaceMs = a.autorizado_en ? Date.now() - Date.parse(a.autorizado_en) : 0;
  return {
    estado: !pago
      ? firmadaHaceMs > 2 * 60_000 ? 'sin_enlace' : 'preparando'
      : pago.estado === 'pendiente' && !listo ? 'preparando' : (pago.estado as 'pendiente' | 'procesando' | 'completado'),
    monto_formateado: montoFormateado,
    payment_link_url: listo ? (pago!.payment_link_url as string) : null,
  };
}

/**
 * Aviso de cobro ANTES de firmar (A2). Mismo monto que la pantalla de «ya
 * firmaste» (getPagoProspectoPorToken): el del pago si ya existe; si no, el
 * configurado (configuracion_sistema.monto_estudio, getMontoEstudio).
 *
 * `requerido`:
 *   - true  → el pagador es el arrendatario (opción C) y aún no pagó.
 *   - false → ya está pagado o lo paga la inmobiliaria / el propietario.
 *   - null  → B17: el gestor todavía no eligió quién paga (`estudios.pago_por`
 *     null; el enlace directo y el orquestador lo envían sin marcarlo). No se
 *     afirma «sin costo»: si después elige al arrendatario, le llegará un cobro.
 *     La pantalla debe decir que quien tramita el estudio le indicará si tiene
 *     costo (la web actual lo trata como false: no muestra aviso).
 */
async function cobroAnticipado(
  expedienteId: string,
): Promise<{ requerido: boolean | null; monto_formateado: string | null }> {
  // B16: las tres lecturas van en paralelo; el orden de las decisiones de
  // abajo es el de antes (un fallo solo cuenta si su dato hacía falta).
  const [senal, pagoPor, { data: pagoRow, error: pagoError }] = await Promise.all([
    leerSenalPagoEstudio(expedienteId),
    leerPagoPor(expedienteId).then(
      (valor) => ({ valor, error: null as unknown }),
      (error: unknown) => ({ valor: null, error }),
    ),
    (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('monto, tarifa_iva')
      .eq('expediente_id', expedienteId)
      .eq('concepto', 'estudio')
      .in('estado', ['pendiente', 'procesando'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  // B15: 'no_verificable' no es «no pagado»: sin saberlo, no se afirma nada.
  if (senal === 'no_verificable') throw new Error('No se pudo verificar el pago del estudio');
  if (senal === 'pagado') return { requerido: false, monto_formateado: null };
  if (pagoPor.error) throw pagoPor.error;
  if (pagoPor.valor === null) return { requerido: null, monto_formateado: null };
  if (pagoPor.valor !== 'arrendatario') return { requerido: false, monto_formateado: null };
  if (pagoError) throw pagoError;
  return {
    requerido: true,
    monto_formateado: await montoAlProspecto(pagoRow as { monto?: number; tarifa_iva?: number | null } | null),
  };
}

/**
 * Lo que ve el prospecto: el del pago si ya existe; si no, el precio vigente.
 * Adenda de precios §1.2 (Ley 1480 art. 26): el total con «(IVA incluido)».
 */
async function montoAlProspecto(pago: { monto?: number; tarifa_iva?: number | null } | null): Promise<string | null> {
  const { getPrecioEstudio, montoProspecto } = await import('@/modules/pago-estudio/pago-estudio.service');
  if (typeof pago?.monto === 'number') return montoProspecto(Math.round(pago.monto), pago.tarifa_iva);
  const precio = await getPrecioEstudio().catch(() => null);
  return precio ? montoProspecto(precio.total, precio.tarifaIva) : null;
}

/**
 * ¿El pagador del estudio es el ARRENDATARIO (opción C del §6.3)? Es el mismo
 * dato con el que decide el orquestador (`siguientePasoEstudio`), leído de la
 * misma columna, para que la pantalla del prospecto no prometa un cobro que el
 * backend no va a emitir.
 */
async function cobroLeTocaAlProspecto(expedienteId: string): Promise<boolean> {
  return (await leerPagoPor(expedienteId)) === 'arrendatario';
}

/** `estudios.pago_por` del estudio del titular (null = aún no se eligió quién paga). */
async function leerPagoPor(expedienteId: string): Promise<string | null> {
  const { data, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('pago_por')
    .eq('expediente_id', expedienteId)
    .neq('tipo', 'con_coarrendatario')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // B15: un fallo de lectura no es «no le toca pagar».
  if (error) throw error;
  return (data as { pago_por?: string | null } | null)?.pago_por ?? null;
}

// ============================================================
// 5. Enviar codigo OTP (public)
// ============================================================

export async function enviarOtpCode(token: string) {
  // 1. Get autorizacion
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, token_expiracion, solicitantes(nombre, apellido, email, telefono)')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion para enviar OTP');
    throw fromSupabaseError(error);
  }
  if (!autorizacion) {
    throw AppError.notFound('Autorización no encontrada', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as {
    id: string;
    estado: string;
    token_expiracion: string;
    solicitantes: { nombre: string; apellido: string; email: string; telefono: string | null };
  };

  if (auth.estado !== 'pendiente') {
    // Diferenciar: 'autorizado' = ya firmada (el front puede mostrar éxito
    // idempotente); expirado/revocado = el enlace ya NO sirve — mostrar éxito
    // aquí haría creer al solicitante que terminó cuando nada va a correr.
    if (auth.estado === 'autorizado') {
      throw AppError.badRequest('Esta autorización ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorización ya no está vigente', 'AUTORIZACION_NO_VIGENTE');
  }

  if (new Date(auth.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de autorización ha expirado', 'AUTORIZACION_EXPIRADA');
  }

  // 2. Check cooldown — last OTP must be older than 60 seconds
  const { data: lastOtp } = await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .select('created_at')
    .eq('autorizacion_id', auth.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastOtp) {
    const lastCreated = new Date((lastOtp as unknown as OtpRow).created_at).getTime();
    const elapsed = (Date.now() - lastCreated) / 1000;
    if (elapsed < OTP_COOLDOWN_SECONDS) {
      const remaining = Math.ceil(OTP_COOLDOWN_SECONDS - elapsed);
      throw AppError.tooMany(
        `Debe esperar ${remaining} segundos antes de solicitar otro código`,
        'OTP_COOLDOWN',
      );
    }
  }

  // 3. Generate 6-digit code. randomInt es [min, max) (max exclusivo), por eso 1000000.
  const codigo = String(crypto.randomInt(100000, 1000000));
  const expiraEn = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  // 3b. Invalidar OTPs previos no verificados (un solo código activo a la vez):
  // reduce la superficie de adivinación y evita códigos antiguos que confunden.
  await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .update({ expira_en: new Date().toISOString() } as never)
    .eq('autorizacion_id', auth.id)
    .eq('verificado', false);

  // 4. Insert OTP record (devolvemos el id para poder limpiarlo si no se entrega).
  const { data: nuevoOtp, error: insertError } = await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .insert({
      autorizacion_id: auth.id,
      codigo,
      expira_en: expiraEn,
    } as never)
    .select('id')
    .maybeSingle();

  if (insertError || !nuevoOtp) {
    logger.error({ error: insertError, autorizacionId: auth.id }, 'Error al crear OTP');
    throw AppError.badRequest('Error al generar el código OTP', 'OTP_CREATE_ERROR');
  }

  const otpId = (nuevoOtp as unknown as { id: string }).id;

  // 5. Entregar el OTP. Email y WhatsApp son best-effort, pero rastreamos si AL
  // MENOS UN canal lo aceptó: si ninguno entrega, no podemos reportar éxito (el
  // usuario quedaría esperando un código que nunca llega).
  const nombreCompleto = `${auth.solicitantes.nombre} ${auth.solicitantes.apellido}`;
  let entregado = false;

  try {
    await sendOtpEmail(auth.solicitantes.email, nombreCompleto, codigo);
    entregado = true;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), autorizacionId: auth.id },
      'No se pudo enviar el OTP por email (se intenta WhatsApp)',
    );
  }

  // 5b. Enviar el OTP por WhatsApp si hay celular (best-effort; email de respaldo).
  if (auth.solicitantes.telefono) {
    const res = await enviarMensaje({
      to: auth.solicitantes.telefono,
      template_id: WHATSAPP_TEMPLATES.AUTORIZACION_OTP.id,
      language: WHATSAPP_TEMPLATES.AUTORIZACION_OTP.language,
      variables: [codigo],
      is_authentication: true,
    });
    if (res.estado === 'fallido') {
      logger.warn({ error: res.error, autorizacionId: auth.id }, 'No se pudo enviar el OTP por WhatsApp');
    } else {
      entregado = true;
    }
  }

  // 5c. Si ningún canal entregó, eliminamos el OTP recién creado (para no bloquear
  // el reintento por cooldown) y devolvemos error claro para que el usuario reintente.
  if (!entregado) {
    await (supabase
      .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', otpId);
    logger.error({ autorizacionId: auth.id }, 'OTP no entregado por ningún canal (email y WhatsApp fallaron)');
    throw AppError.badRequest(
      'No pudimos enviarle el código en este momento. Intente de nuevo en unos segundos.',
      'OTP_DELIVERY_FAILED',
    );
  }

  return {
    mensaje: auth.solicitantes.telefono
      ? 'Código OTP enviado por WhatsApp y correo'
      : 'Código OTP enviado al correo del solicitante',
    expira_en: expiraEn,
  };
}

// ============================================================
// 6. Verificar codigo OTP (public)
// ============================================================

export async function verificarOtpCode(token: string, codigo: string) {
  // 1. Get autorizacion
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, token_expiracion')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion para verificar OTP');
    throw fromSupabaseError(error);
  }
  if (!autorizacion) {
    throw AppError.notFound('Autorización no encontrada', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as { id: string; estado: string; token_expiracion: string };

  if (auth.estado !== 'pendiente') {
    // Diferenciar: 'autorizado' = ya firmada (el front puede mostrar éxito
    // idempotente); expirado/revocado = el enlace ya NO sirve — mostrar éxito
    // aquí haría creer al solicitante que terminó cuando nada va a correr.
    if (auth.estado === 'autorizado') {
      throw AppError.badRequest('Esta autorización ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorización ya no está vigente', 'AUTORIZACION_NO_VIGENTE');
  }

  // 2. Find matching OTP (not expired, not verified)
  const { data: otp } = await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .select('id, codigo, expira_en, verificado')
    .eq('autorizacion_id', auth.id)
    .eq('verificado', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!otp) {
    throw AppError.badRequest('No hay código OTP pendiente. Solicite uno nuevo.', 'OTP_NOT_FOUND');
  }

  const otpRow = otp as unknown as OtpRow;

  if (new Date(otpRow.expira_en) < new Date()) {
    throw AppError.badRequest(
      'El código OTP ha expirado. Solicite uno nuevo.',
      'OTP_EXPIRADO',
    );
  }

  if (otpRow.codigo !== codigo) {
    throw AppError.badRequest('Código OTP incorrecto', 'OTP_INCORRECTO');
  }

  // 3. Mark OTP as verified
  await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .update({ verificado: true } as never)
    .eq('id', otpRow.id);

  return {
    verificado: true,
    mensaje: 'Código OTP verificado correctamente',
  };
}

// ============================================================
// 7. Revocar autorizacion (auth)
// ============================================================

const CANAL_REVOCACION_LABEL: Record<RevocarInput['canal'], string> = {
  correo: 'correo electrónico',
  whatsapp: 'WhatsApp',
  llamada: 'llamada telefónica',
  escrito: 'escrito',
};

/** Lo que queda en motivo_revocacion: quien, cuando y por donde lo pidio, y el soporte. */
export function textoRevocacion(input: Pick<RevocarInput, 'canal' | 'fecha_solicitud' | 'motivo'>): string {
  const [a, m, d] = input.fecha_solicitud.split('-');
  return `Solicitud del titular recibida por ${CANAL_REVOCACION_LABEL[input.canal]} el ${d}/${m}/${a}. Soporte: ${input.motivo.trim()}`;
}

export async function revocarAutorizacion(
  expedienteId: string,
  input: RevocarInput,
  userId: string,
  userRol?: string,
  ip?: string,
) {
  // Tenant guard: no-op para roles internos / llamadas sin identidad; 404 para
  // propietario/inmobiliaria/solicitante fuera de su cartera. Revocar es mutar
  // la evidencia legal de la firma, así que gateamos ANTES de buscar/mutar.
  await assertExpedienteAccess(expedienteId, userId, userRol);

  // 1. Find active autorizacion DEL TITULAR for this expediente.
  //
  //    `coarrendatario_id IS NULL` + ORDER BY determinista: desde 2026-09-03 un
  //    expediente puede tener DOS filas 'autorizado' (titular y coarrendatario
  //    invitado). Sin filtrar por sujeto, Postgres podía devolver la del
  //    coarrendatario: la API respondía 200 'revocado' al titular, revocaba a
  //    quien no lo pidió y dejaba viva la firma del titular — que el gate seguía
  //    aceptando, así que el buró se podía volver a consultar sobre alguien que
  //    acababa de revocar. Y el trigger de la migración hace la revocación
  //    irreversible. El gate (autorizacion.guard.ts) ya resuelve el sujeto antes
  //    de consultar; aquí se hace igual.
  //
  //    `input.coarrendatario_id` selecciona el otro sujeto: es la única vía por
  //    la que se puede revocar la autorización del coarrendatario invitado
  //    (Ley 1581 de 2012, art. 8) sin tocar la del titular.
  const base = (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .eq('estado', 'autorizado')
    .is('fecha_revocacion', null)
    .order('created_at', { ascending: false })
    .limit(1);

  const { data: autorizacion, error } = await (input.coarrendatario_id
    ? base.eq('coarrendatario_id', input.coarrendatario_id)
    : base.is('coarrendatario_id', null)
  ).maybeSingle();

  if (error || !autorizacion) {
    throw AppError.notFound(
      input.coarrendatario_id
        ? 'No se encontró autorización activa de ese coarrendatario en este estudio'
        : 'No se encontró autorización activa para este estudio',
      'AUTORIZACION_NOT_FOUND',
    );
  }

  const auth = autorizacion as unknown as { id: string; estado: string };

  // 2. Update to revocado. El trigger de inalterabilidad solo deja escribir
  //    estado, fecha_revocacion y motivo_revocacion: la fecha y el canal de la
  //    solicitud del titular van en el texto del motivo (y estructurados en la
  //    bitacora). fecha_revocacion = cuando Cofianza la registro.
  const motivoRevocacion = textoRevocacion(input);
  const { error: updateError } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'revocado',
      fecha_revocacion: new Date().toISOString(),
      motivo_revocacion: motivoRevocacion,
    } as never)
    .eq('id', auth.id);

  if (updateError) {
    logger.error({ error: updateError, autorizacionId: auth.id }, 'Error al revocar autorizacion');
    throw AppError.badRequest('Error al revocar la autorización', 'AUTORIZACION_REVOKE_ERROR');
  }

  // 3. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.AUTORIZACION_REVOCADA,
    entidad: AUDIT_ENTITIES.AUTORIZACION,
    entidadId: auth.id,
    detalle: {
      expediente_id: expedienteId,
      motivo: motivoRevocacion,
      canal_solicitud: input.canal,
      fecha_solicitud: input.fecha_solicitud,
      soporte: input.motivo,
      sujeto: input.coarrendatario_id ? 'coarrendatario' : 'solicitante',
      ...(input.coarrendatario_id ? { coarrendatario_id: input.coarrendatario_id } : {}),
    },
    ip,
  });

  return {
    estado: 'revocado',
    fecha_revocacion: new Date().toISOString(),
  };
}

// ============================================================
// 9. Bloqueo por documento (BLQ 07/10/2026): corrección ciega, traza y banner
// ============================================================

export interface CorregirDocumentoInput {
  tipo_documento: string;
  numero_documento: string;
  fuente_verificacion: 'documento_fisico' | 'copia_documento' | 'confirmacion_telefonica';
}

const ESTADOS_CON_CONSULTA = ['en_proceso', 'completado'];

/** ¿Alguna evaluación (no del coarrendatario) de estos expedientes ya llegó a las centrales? */
async function hayConsulta(expedienteIds: string[]): Promise<boolean> {
  if (expedienteIds.length === 0) return false;
  const { data, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('estado, referencia_proveedor')
    .in('expediente_id', expedienteIds)
    .neq('tipo', 'con_coarrendatario');
  if (error) throw fromSupabaseError(error);
  return ((data ?? []) as Array<{ estado: string; referencia_proveedor: string | null }>).some(
    (e) => !!e.referencia_proveedor || ESTADOS_CON_CONSULTA.includes(e.estado),
  );
}

/**
 * BLQ §3.6: la ficha del solicitante es compartida. Si OTRO expediente vivo ya
 * tiene con ella una autorización firmada, una consulta o un contrato, corregir
 * el documento cambiaría a la persona evaluada allá también.
 */
async function fichaUsadaEnOtroEstudio(solicitanteId: string, expedienteId: string): Promise<boolean> {
  const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
  const { data, error } = await db('expedientes')
    .select('id')
    .eq('solicitante_id', solicitanteId)
    .neq('id', expedienteId)
    .not('estado', 'in', '(cerrado,rechazado)');
  if (error) throw fromSupabaseError(error);
  const ids = ((data ?? []) as Array<{ id: string }>).map((e) => e.id);
  if (ids.length === 0) return false;
  const [firmadas, contratos] = await Promise.all([
    db('autorizaciones_habeas_data').select('id', { count: 'exact', head: true }).in('expediente_id', ids).is('coarrendatario_id', null).eq('estado', 'autorizado'),
    db('contratos').select('id', { count: 'exact', head: true }).in('expediente_id', ids),
  ]);
  if (firmadas.error) throw fromSupabaseError(firmadas.error);
  if (contratos.error) throw fromSupabaseError(contratos.error);
  return (firmadas.count ?? 0) > 0 || (contratos.count ?? 0) > 0 || (await hayConsulta(ids));
}

const ETIQUETA_FUENTE: Record<CorregirDocumentoInput['fuente_verificacion'], string> = {
  documento_fisico: 'documento físico',
  copia_documento: 'copia del documento',
  confirmacion_telefonica: 'confirmación telefónica con el prospecto',
};

/**
 * BLQ §3: corrección CIEGA del tipo y número de documento del titular. El
 * gestor nunca ve lo que digitó el prospecto; declara contra qué verificó.
 * No reenvía el enlace (§4.4): el pendiente se expira y el estudio queda
 * «pendiente de reenvío». Pasado MAX_CORRECCIONES_DOCUMENTO el estudio se
 * cierra y se avisa a la Gerencia General (§3.6).
 */
export async function corregirDocumentoProspecto(
  expedienteId: string,
  input: CorregirDocumentoInput,
  user: AuthUser,
  ip?: string,
): Promise<{ correcciones_restantes: number; estado_bloqueo: 'pendiente_reenvio' }> {
  await assertExpedienteAccess(expedienteId, user.id, user.rol);
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, solicitante_id, solicitantes(id, nombre, apellido, email, telefono, tipo_documento, numero_documento, tipo_persona, creado_por, inmobiliaria_id)')
    .eq('id', expedienteId)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  const exp = data as unknown as Pick<ExpedienteInfo, 'id' | 'numero' | 'estado' | 'solicitante_id' | 'solicitantes'> | null;
  if (!exp || !exp.solicitante_id || !exp.solicitantes) throw AppError.notFound('Estudio no encontrado', 'EXPEDIENTE_NOT_FOUND');
  assertEstudioActivo(exp.estado);

  const sol = exp.solicitantes;
  const anterior = { tipo: sol.tipo_documento ?? null, numero: sol.numero_documento ?? null };
  const numeroNuevo = input.numero_documento.trim();
  if (
    normalizarDocumento(numeroNuevo) === normalizarDocumento(anterior.numero) &&
    normalizarTipoDocumento(input.tipo_documento) === normalizarTipoDocumento(anterior.tipo)
  ) {
    throw AppError.badRequest('El documento es igual al registrado. Si el registro está bien, solo reenvíe el enlace.', 'DOCUMENTO_SIN_CAMBIOS');
  }
  const motivoDoc = motivoNoAfianzable(undefined, { tipo_persona: sol.tipo_persona, tipo_documento: input.tipo_documento });
  if (motivoDoc) throw await errorNoAfianzableSegunCobro(motivoDoc, [expedienteId]);

  if (await hayConsulta([expedienteId])) {
    throw AppError.conflict(
      'Este estudio ya consultó las centrales de riesgo con el documento registrado. Para evaluar a otra persona cree un estudio nuevo.',
      'ESTUDIO_CON_CONSULTA',
    );
  }
  if (await fichaUsadaEnOtroEstudio(exp.solicitante_id, expedienteId)) {
    throw AppError.conflict(
      'Este prospecto tiene otro estudio en curso con autorización firmada, evaluación o contrato. Para corregir su documento comuníquese con Cofianza.',
      'FICHA_COMPARTIDA',
    );
  }

  // BLQ §8.2: tras «no soy yo» solo Cofianza corrige y reenvía; si no, la
  // corrección dejaba el estado en «pendiente de reenvío» y el reenvío pasaba.
  if ((user.rol === 'inmobiliaria' || user.rol === 'propietario') && (await identidadRechazada(expedienteId))) {
    throw AppError.conflict(
      'El titular de los datos respondió que no es él. Comuníquese con Cofianza para revisar el caso.',
      'IDENTIDAD_RECHAZADA',
    );
  }

  const cal = await getCalibracion();
  const hechas = await contarCorrecciones(expedienteId);
  if (hechas >= cal.MAX_CORRECCIONES_DOCUMENTO) {
    await cerrarPorLimiteCorrecciones(expedienteId, exp.numero, user);
    throw AppError.conflict(
      'Se superó el límite de correcciones del documento: el estudio se cerró. Cree un estudio nuevo.',
      'LIMITE_CORRECCIONES_DOCUMENTO',
    );
  }

  // Primero la ficha (con sus validaciones); la corrección se registra después
  // y, si eso falla, la ficha vuelve a lo anterior: no hay corrección sin traza.
  await escribirDocumentoFicha(exp.solicitante_id, sol, input.tipo_documento, numeroNuevo, expedienteId, user.rol);
  const { error: insErr } = await (supabase
    .from('correcciones_documento' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      solicitante_id: exp.solicitante_id,
      tipo_anterior: anterior.tipo,
      numero_anterior: anterior.numero,
      tipo_nuevo: input.tipo_documento,
      numero_nuevo: numeroNuevo,
      fuente_verificacion: input.fuente_verificacion,
      usuario_id: user.id,
    } as never);
  if (insErr) {
    await (supabase.from('solicitantes' as string) as ReturnType<typeof supabase.from>)
      .update({ tipo_documento: anterior.tipo, numero_documento: anterior.numero } as never)
      .eq('id', exp.solicitante_id);
    logger.error({ expedienteId, err: insErr.message }, 'BLQ: no se pudo registrar la corrección; ficha restaurada');
    throw new AppError(503, 'CORRECCION_NO_REGISTRADA', 'No pudimos registrar la corrección. Intente de nuevo en unos minutos.');
  }

  // La evaluación sin consulta toma el documento corregido (el gate 8.4 compara el par).
  const { data: ests } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, datos_formulario')
    .eq('expediente_id', expedienteId)
    .neq('tipo', 'con_coarrendatario');
  for (const e of (ests ?? []) as Array<{ id: string; datos_formulario: Record<string, unknown> | null }>) {
    if (!e.datos_formulario) continue;
    await (supabase.from('estudios' as string) as ReturnType<typeof supabase.from>)
      .update({ datos_formulario: { ...e.datos_formulario, tipo_documento: input.tipo_documento, numero_documento: numeroNuevo } } as never)
      .eq('id', e.id);
  }

  // El enlace vivo muere: el cotejo no puede cambiar en silencio (§3, §4.4).
  const { data: vivas } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'expirado' } as never)
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .eq('estado', 'pendiente')
    .select('id');
  await cerrarEnvios(idsDe(vivas), 'correccion');

  // Registro de la inmobiliaria, antes y después. Lo digitado por el prospecto nunca.
  logAudit({
    usuarioId: user.id,
    accion: AUDIT_ACTIONS.SOLICITANTE_UPDATED,
    entidad: AUDIT_ENTITIES.SOLICITANTE,
    entidadId: exp.solicitante_id,
    detalle: {
      origen: 'correccion_documento',
      expediente_id: expedienteId,
      fuente_verificacion: input.fuente_verificacion,
      before: { tipo_documento: anterior.tipo, numero_documento: anterior.numero },
      after: { tipo_documento: input.tipo_documento, numero_documento: numeroNuevo },
    },
    ip,
  });
  const { error: tlErr } = await (supabase.from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'estudio',
      descripcion: `Se corrigió el documento del prospecto (verificado con ${ETIQUETA_FUENTE[input.fuente_verificacion]}). Falta reenviar el enlace de autorización.`,
      usuario_id: user.id,
      metadata: { origen: 'correccion_documento', fuente_verificacion: input.fuente_verificacion },
    } as never);
  if (tlErr) logger.warn({ expedienteId, err: tlErr.message }, 'BLQ: timeline de la corrección');

  return { correcciones_restantes: Math.max(0, cal.MAX_CORRECCIONES_DOCUMENTO - hechas - 1), estado_bloqueo: 'pendiente_reenvio' };
}

/** BLQ §3.6: cierra el estudio (con devolución si aplica) y avisa a la Gerencia General. */
async function cerrarPorLimiteCorrecciones(expedienteId: string, numero: string, user: AuthUser): Promise<void> {
  const { executeTransition } = await import('@/modules/expedientes/expediente-workflow.service');
  await executeTransition(
    expedienteId,
    {
      nuevo_estado: 'cerrado',
      etiqueta: 'Cancelar estudio',
      comentario: 'Se superó el límite de correcciones del documento (LIMITE_CORRECCIONES_DOCUMENTO). Debe crearse un estudio nuevo.',
    } as TransitionInput,
    user,
    { sinAcuse: true },
  );
  const [{ gerenciaGeneralIds }, { notificarYCorreo }] = await Promise.all([
    import('@/modules/beneficios/beneficios.service'),
    import('@/modules/notificaciones/notificaciones.service'),
  ]);
  const ids = await gerenciaGeneralIds().catch(() => [] as string[]);
  await Promise.all(
    ids.map((userId) =>
      notificarYCorreo({
        userId,
        tipo: 'estudio.limite_correcciones_documento',
        titulo: 'Estudio cerrado por correcciones del documento',
        mensaje: `El estudio ${formatNumeroEstudio(numero)} se cerró por superar el límite de correcciones del documento. Debe crearse un estudio nuevo.`,
        link: `/expedientes/${expedienteId}`,
        payload: { expediente_id: expedienteId },
      }).catch((e) => logger.warn({ error: e }, 'BLQ: aviso a la Gerencia General')),
    ),
  );
}

/**
 * BLQ §7: traza completa, SOLO para Cofianza (la ruta ya lo exige; se repite
 * aquí porque lleva `valor_digitado`). El «vencido» se deriva de la fecha.
 */
export async function getTrazaAutorizacion(expedienteId: string, userRol?: string) {
  if (!esRolInternoCofianza(userRol)) throw AppError.forbidden('Solo Cofianza ve la traza de la autorización', 'TRAZA_SOLO_COFIANZA');
  const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
  const [intentos, correcciones, envios, enlaces, cupo] = await Promise.all([
    db('autorizacion_intentos_documento')
      .select('autorizacion_id, tipo_digitado, valor_digitado, coincide, origen, ip, user_agent, created_at')
      .eq('expediente_id', expedienteId)
      .order('created_at', { ascending: true }),
    db('correcciones_documento')
      .select('tipo_anterior, numero_anterior, tipo_nuevo, numero_nuevo, fuente_verificacion, usuario_id, created_at')
      .eq('expediente_id', expedienteId)
      .order('created_at', { ascending: true }),
    db('autorizacion_envios').select('autorizacion_id, generado_por, es_reenvio, envios, motivo_cierre, cerrado_at').eq('expediente_id', expedienteId),
    db('autorizaciones_habeas_data')
      .select('id, estado, token_expiracion, created_at')
      .eq('expediente_id', expedienteId)
      .is('coarrendatario_id', null)
      .order('created_at', { ascending: true }),
    db('movimientos_creditos_estudios')
      .select('tipo, literal, notas, created_at')
      .eq('expediente_id', expedienteId)
      .in('tipo', ['reserva', 'consumo', 'liberacion', 'ajuste'])
      .order('created_at', { ascending: true }),
  ]);
  for (const r of [intentos, correcciones, envios, enlaces, cupo]) if (r.error) throw fromSupabaseError(r.error);

  const porAut = new Map(((envios.data ?? []) as Array<Record<string, unknown>>).map((e) => [e.autorizacion_id as string, e]));
  const ahora = Date.now();
  return {
    intentos: intentos.data ?? [],
    correcciones: correcciones.data ?? [],
    enlaces: ((enlaces.data ?? []) as Array<{ id: string; estado: string; token_expiracion: string; created_at: string }>).map((a) => {
      const e = porAut.get(a.id);
      const vencido = a.estado !== 'autorizado' && !e?.motivo_cierre && Date.parse(a.token_expiracion) < ahora;
      return {
        autorizacion_id: a.id,
        creado_en: a.created_at,
        estado: a.estado,
        generado_por: e?.generado_por ?? null,
        es_reenvio: e?.es_reenvio ?? null,
        envios: e?.envios ?? [],
        motivo_cierre: (e?.motivo_cierre as string | undefined) ?? (vencido ? 'vencido' : null),
        cerrado_en: (e?.cerrado_at as string | undefined) ?? (vencido ? a.token_expiracion : null),
      };
    }),
    // §7: si el evento consumió cupo o no, con el motivo.
    cupo: cupo.data ?? [],
  };
}

/**
 * BLQ §2.1 y §2.6: estudios bloqueados por documento que nadie ha atendido
 * (sin corrección ni reenvío después). Liviano y con el alcance de tenantScope.
 */
export async function listBloqueosPendientes(userId: string, userRol: string) {
  const permitidos = await resolveAllowedExpedienteIds(userId, userRol);
  if (permitidos && permitidos.length === 0) return [];
  const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
  let q = db('autorizacion_envios')
    .select('autorizacion_id, expediente_id, cerrado_at, motivo_cierre')
    .in('motivo_cierre', ['intentos', 'datos_incorrectos'])
    .is('coarrendatario_id', null)
    .order('cerrado_at', { ascending: false })
    .limit(50);
  if (permitidos) q = q.in('expediente_id', permitidos);
  const { data: cerrados, error } = await q;
  if (error) throw fromSupabaseError(error);
  const filas = (cerrados ?? []) as Array<{ autorizacion_id: string; expediente_id: string; cerrado_at: string; motivo_cierre: string }>;
  const ids = [...new Set(filas.map((f) => f.expediente_id))];
  if (ids.length === 0) return [];

  const [ultimas, corr, exps] = await Promise.all([
    db('autorizaciones_habeas_data').select('id, expediente_id, created_at').in('expediente_id', ids).is('coarrendatario_id', null).order('created_at', { ascending: false }),
    db('correcciones_documento').select('expediente_id, created_at').in('expediente_id', ids).is('coarrendatario_id', null),
    db('expedientes').select('id, numero, estado, solicitantes(nombre, apellido)').in('id', ids),
  ]);
  for (const r of [ultimas, corr, exps]) if (r.error) throw fromSupabaseError(r.error);

  const ultimaPorExp = new Map<string, { id: string; created_at: string }>();
  for (const a of (ultimas.data ?? []) as Array<{ id: string; expediente_id: string; created_at: string }>) {
    if (!ultimaPorExp.has(a.expediente_id)) ultimaPorExp.set(a.expediente_id, a);
  }
  const corrPorExp = new Map<string, number>();
  for (const c of (corr.data ?? []) as Array<{ expediente_id: string; created_at: string }>) {
    corrPorExp.set(c.expediente_id, Math.max(corrPorExp.get(c.expediente_id) ?? 0, Date.parse(c.created_at)));
  }
  const expPorId = new Map(
    ((exps.data ?? []) as Array<{ id: string; numero: string; estado: string; solicitantes?: { nombre?: string; apellido?: string } | null }>).map((e) => [e.id, e]),
  );
  return filas
    .filter((f, i) => filas.findIndex((g) => g.expediente_id === f.expediente_id) === i)
    .filter((f) => {
      const ultima = ultimaPorExp.get(f.expediente_id);
      const e = expPorId.get(f.expediente_id);
      return (
        ultima?.id === f.autorizacion_id &&
        (corrPorExp.get(f.expediente_id) ?? 0) <= Date.parse(ultima.created_at) &&
        !!e && !['cerrado', 'rechazado'].includes(e.estado)
      );
    })
    .map((f) => {
      const e = expPorId.get(f.expediente_id)!;
      return {
        expediente_id: f.expediente_id,
        numero: formatNumeroEstudio(e.numero),
        prospecto: `${e.solicitantes?.nombre ?? ''} ${e.solicitantes?.apellido ?? ''}`.trim(),
        bloqueado_en: f.cerrado_at,
        motivo: f.motivo_cierre,
      };
    });
}

import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { sendAutorizacionEmail, sendOtpEmail } from '@/lib/email';
import { enviarMensaje } from '@/modules/whatsapp/whatsapp.service';
import { WHATSAPP_TEMPLATES } from '@/modules/whatsapp/templates';
import { perfilEsDuenoDeInmueble, assertExpedienteAccess } from '@/lib/tenantScope';
import { estudioYaCobrado as estudioPagado } from '@/modules/estudios/pago.guard';
import { env } from '@/config';
import { getCalibracion } from '@/lib/calibracion';
import type {
  FirmarInput,
  RevocarInput,
  PerfilProspectoInput,
  ReportarIdentidadInput,
} from './autorizaciones.schema';
import { senalDiscrepanciaIngreso } from './ingreso-declarado';
import { textoLegalSolicitante } from './autorizaciones.texto';
// Cotejo biometrico AucoFace (Politica Anexo A + §14). Apagado por
// AUCO_BIOMETRIA_ENABLED no se pide nada y el texto legal no cambia.
import {
  validarIdentidadProspecto,
  biometriaOmitida,
  leerResumenBiometria,
} from './biometria';
import type { ResumenBiometria } from './biometria';

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
  await assertExpedienteAccess(expedienteId, userId, userRol);

  // Verify expediente exists. Para roles internos el guard es no-op, así que
  // conservamos este 404 explícito de "no existe".
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Estudio no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  // Get latest autorizacion DEL TITULAR para este expediente. Incluye los
  // consentimientos opcionales que el solicitante eligió y la evidencia
  // completa de la firma (IP, dispositivo, versión y texto literal firmado) —
  // el panel admin los muestra como soporte legal de la autorización.
  //
  // `coarrendatario_id IS NULL` NO es opcional: desde 2026-09-03 el
  // co-arrendatario invitado tiene su PROPIA fila con el MISMO expediente_id, y
  // como se inserta después, era la que devolvía el `order by created_at desc`.
  // El panel habría mostrado la IP, el dispositivo y el texto de OTRO titular
  // de datos como si fueran los del solicitante: exactamente la evidencia que
  // el 8.4 exige poder demostrar si alguna vez se cuestiona.
  const { data: autorizacion } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, canal, metodo_firma, autorizado_en, hash_documento, fecha_revocacion, motivo_revocacion, token_expiracion, created_at, consent_analitica, consent_comercial, consent_historial_referencia, ip_autorizacion, user_agent, version_terminos, texto_autorizado, numero_documento_aceptante, tipo_documento_aceptante, vigente_hasta')
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!autorizacion) return null;

  // PASO 5 (Flujo §8): lo que el prospecto declaro en su celular. Se adjunta
  // por ALLOWLIST construida campo a campo, NUNCA con `...perfil`.
  //
  // Una blocklist se rompe sola en cuanto alguien agregue una columna, y este
  // endpoint corre bajo authorize('expedientes','read') — que la inmobiliaria
  // tiene. La promesa que el §8.2 le hace al prospecto en pantalla ("esta
  // cifra no se la mostramos a la inmobiliaria") se sostiene AQUI, en el
  // servicio junto al tenant guard, no en el render: con DevTools se lee igual.
  const perfil = await leerPerfilProspecto(expedienteId, userRol);
  return { ...(autorizacion as Record<string, unknown>), perfil_prospecto: perfil };
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
 * co-arrendatario invitado comparte `expediente_id` (coarrendatarios.service
 * lo inserta con tipo='con_coarrendatario') y produce su propia fila en
 * estudios_scorecard_sombra. Sin el `.neq` de abajo, el declarado del TITULAR
 * se contrastaba contra el inferido del CO-ARRENDATARIO: una discrepancia
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

export async function enviarEnlaceAutorizacion(
  expedienteId: string,
  userId: string,
  ip?: string,
  // Corrección del contacto del solicitante: si viene y difiere, se persiste
  // en `solicitantes` y el enlace (email + WhatsApp) va al corregido.
  contacto?: { email?: string; telefono?: string },
  userRol?: string,
) {
  // 1. Get expediente with solicitante + inmueble
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, solicitante_id, solicitantes(id, nombre, apellido, email, telefono, tipo_documento, numero_documento), inmuebles!expedientes_inmueble_id_fkey(id, direccion, ciudad, barrio, propietario_id, inmobiliaria_id)')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Estudio no encontrado', 'EXPEDIENTE_NOT_FOUND');
  }

  const exp = expediente as unknown as ExpedienteInfo;

  // 0b. Tenant guard: propietario/inmobiliaria solo pueden operar sobre
  // expedientes de un inmueble que administran. Sin esto, cualquier usuario
  // con ese rol podía redirigir el enlace (y ahora reescribir el contacto)
  // de solicitantes ajenos conociendo el expedienteId. Admin/operador pasan.
  if (userRol === 'propietario' || userRol === 'inmobiliaria') {
    const esDueno = await perfilEsDuenoDeInmueble({
      userId,
      userRol,
      inmueblePropietarioId: exp.inmuebles?.propietario_id ?? null,
      inmuebleInmobiliariaId: exp.inmuebles?.inmobiliaria_id ?? null,
    });
    if (!esDueno) {
      throw AppError.forbidden(
        'No tienes permisos para enviar la autorización de este estudio',
        'AUTORIZACION_FORBIDDEN',
      );
    }
  }

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

  if (!exp.solicitantes?.email) {
    throw AppError.badRequest('El solicitante no tiene email registrado', 'SOLICITANTE_SIN_EMAIL');
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
  //   - sin `coarrendatario_id IS NULL`: la fila del co-arrendatario (mismo
  //     expediente_id) bloqueaba el enlace del titular de inmediato.
  const { data: yaAutorizada } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .eq('estado', 'autorizado')
    .is('fecha_revocacion', null)
    .or(`vigente_hasta.is.null,vigente_hasta.gt.${new Date().toISOString()}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (yaAutorizada) {
    throw AppError.badRequest(
      'Este estudio ya tiene una autorizacion firmada vigente.',
      'AUTORIZACION_YA_FIRMADA',
    );
  }

  // 2. Invalidate any existing pending autorizacion DEL TITULAR for this
  //    expediente (mismo filtro de sujeto que el resto del módulo).
  await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'expirado' } as never)
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .eq('estado', 'pendiente');

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
    throw AppError.badRequest('Error al crear la autorizacion', 'AUTORIZACION_CREATE_ERROR');
  }

  const autorizacionId = (autorizacion as unknown as { id: string }).id;

  // 5. Send email
  const autorizacionUrl = `${env.FRONTEND_URL}/autorizar/${token}`;
  const nombreCompleto = `${exp.solicitantes.nombre} ${exp.solicitantes.apellido}`;

  // Email best-effort: si Resend falla (p.ej. dirección no verificada en dev),
  // NO debe bloquear el envío del link por WhatsApp que viene abajo.
  try {
    await sendAutorizacionEmail(exp.solicitantes.email, nombreCompleto, autorizacionUrl, expiryHours);
  } catch (err) {
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
      variables: [exp.solicitantes.nombre, autorizacionUrl],
      context: { expediente_id: expedienteId },
    });
    if (res.estado === 'fallido') {
      logger.warn({ error: res.error, expedienteId }, 'No se pudo enviar el link de autorización por WhatsApp');
    }
  }

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

/** Enmascara un teléfono dejando visibles solo los 2 últimos dígitos. */
function maskTelefono(tel: string | null): string | null {
  if (!tel) return null;
  const digits = tel.replace(/\D/g, '');
  if (digits.length < 2) return null;
  return `••• ••${digits.slice(-2)}`;
}

/**
 * Enmascara un documento dejando visibles solo los 4 ultimos digitos.
 *
 * §8.1 pide mostrar "el documento registrado" para que el prospecto lo
 * confirme, pero §12 dice que esa confirmacion ES la defensa contra el enlace
 * reenviado a un tercero: enseñarle el numero completo al portador del enlace
 * le regalaria la respuesta al impostor, y encima seria PII nueva sobre un
 * endpoint que hoy minimiza a proposito (quito el email, enmascara el
 * telefono). Mismo criterio que maskTelefono.
 */
function maskDocumento(doc: string | null): string | null {
  if (!doc) return null;
  const digits = doc.replace(/[^A-Za-z0-9]/g, '');
  if (digits.length < 4) return null;
  return `••••${digits.slice(-4)}`;
}

export async function getAutorizacionByToken(token: string) {
  const { data: autorizacion, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, estado, token_expiracion, texto_autorizado, version_terminos, metodo_firma,
      solicitantes(nombre, apellido, telefono, tipo_documento, numero_documento),
      expedientes(numero, inmuebles!expedientes_inmueble_id_fkey(direccion, ciudad, barrio))
    `)
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion por token');
    throw fromSupabaseError(error);
  }
  if (!autorizacion) {
    throw AppError.notFound('Autorizacion no encontrada o enlace invalido', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as {
    id: string;
    estado: string;
    token_expiracion: string;
    texto_autorizado: string;
    version_terminos: string;
    metodo_firma: string | null;
    solicitantes: {
      nombre: string;
      apellido: string;
      telefono: string | null;
      tipo_documento: string | null;
      numero_documento: string | null;
    };
    expedientes: { numero: string; inmuebles: { direccion: string; ciudad: string; barrio: string | null } };
  };

  // Check if expired
  if (new Date(auth.token_expiracion) < new Date()) {
    // Mark as expired if still pending
    if (auth.estado === 'pendiente') {
      await (supabase
        .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'expirado' } as never)
        .eq('id', auth.id);
    }
    throw AppError.badRequest('El enlace de autorizacion ha expirado', 'AUTORIZACION_EXPIRADA');
  }

  if (auth.estado !== 'pendiente') {
    // Codigos distintos porque la pantalla del prospecto los trata distinto:
    // reabrir el enlace despues de firmar (gesto normalisimo: el enlace vive en
    // WhatsApp) tiene que mostrar la pantalla de exito, no una alerta roja. El
    // mensaje NO se le renderiza al prospecto — el front tiene copy propio —
    // asi que el nombre interno del enum se queda aqui, para los logs.
    if (auth.estado === 'autorizado') {
      throw AppError.badRequest('Esta autorizacion ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest(
      `Esta autorizacion tiene estado: ${auth.estado}`,
      'AUTORIZACION_ESTADO_INVALIDO',
    );
  }

  const biometriaPrevia = env.AUCO_BIOMETRIA_ENABLED
    ? await leerBiometriaPorAutorizacion(auth.id)
    : null;

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
      requerida: env.AUCO_BIOMETRIA_ENABLED,
      estado: biometriaPrevia?.estado ?? null,
    },
    solicitante: {
      nombre: auth.solicitantes.nombre,
      apellido: auth.solicitantes.apellido,
      // PII minimizada para el portador del token: NO se devuelve el email completo
      // (la pantalla no lo usa) y el teléfono va enmascarado.
      telefono_masked: maskTelefono(auth.solicitantes.telefono),
      // §8.1: el prospecto confirma su identidad. El documento va ENMASCARADO
      // (ver maskDocumento) — nunca completo.
      tipo_documento: auth.solicitantes.tipo_documento,
      numero_documento_masked: maskDocumento(auth.solicitantes.numero_documento),
    },
    expediente: {
      numero_expediente: auth.expedientes.numero,
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
async function autorizacionPendientePorToken(token: string): Promise<{
  id: string;
  expediente_id: string | null;
  solicitante_id: string;
}> {
  const { data, error } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, token_expiracion, expediente_id, solicitante_id')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion por token');
    throw fromSupabaseError(error);
  }
  if (!data) {
    throw AppError.notFound('Autorizacion no encontrada o enlace invalido', 'AUTORIZACION_NOT_FOUND');
  }
  const auth = data as unknown as {
    id: string;
    estado: string;
    token_expiracion: string;
    expediente_id: string | null;
    solicitante_id: string;
  };
  if (new Date(auth.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de autorizacion ha expirado', 'AUTORIZACION_EXPIRADA');
  }
  if (auth.estado !== 'pendiente') {
    throw AppError.badRequest('Este enlace de autorizacion ya no esta vigente', 'AUTORIZACION_NO_VIGENTE');
  }
  return { id: auth.id, expediente_id: auth.expediente_id, solicitante_id: auth.solicitante_id };
}

/**
 * Columnas con las que se registra la confirmacion de identidad del §8.1 en
 * `autorizacion_perfil_prospecto`. UNA sola definicion para los dos caminos
 * que la escriben (el PASO 5 y la firma): si divergieran, el banner del
 * gestor diria una cosa segun por donde haya entrado la confirmacion.
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
 * Guarda lo que el prospecto declara en el PASO 5 (§8.1 confirmacion de
 * identidad, §8.2 laboral e ingreso, §8.3 solo/acompanado).
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
  if (input.identidad_confirmada) {
    Object.assign(fila, camposIdentidadConfirmada(ahora));
  }
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
  const umbral = env.AUCO_BIOMETRIA_UMBRAL_SIMILITUD;

  if (!env.AUCO_BIOMETRIA_ENABLED) {
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
      return 'No pudimos confirmar que la foto y el documento sean de la misma persona. Puedes intentarlo de nuevo con mejor luz, o continuar: alguien de nuestro equipo revisara tu caso.';
    case 'omitida':
      return 'Continuamos sin la verificacion con foto. Tu solicitud sigue: la revisara una persona de nuestro equipo.';
    default:
      return 'No pudimos completar la verificacion en este momento. Puedes continuar: alguien de nuestro equipo revisara tu caso.';
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
  const resumen = biometriaOmitida(new Date().toISOString(), env.AUCO_BIOMETRIA_UMBRAL_SIMILITUD);

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
 *
 * ORDEN NO NEGOCIABLE: primero se guarda el reporte, DESPUES se expira la
 * autorizacion. Al reves, el chequeo de estado='pendiente' del propio servicio
 * rechazaria la escritura del reporte y se perderia el motivo.
 */
export async function reportarIdentidadProspecto(
  token: string,
  input: ReportarIdentidadInput,
  ip?: string,
  userAgent?: string,
) {
  const auth = await autorizacionPendientePorToken(token);
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
  await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({ estado: 'expirado' } as never)
    .eq('id', auth.id)
    .eq('estado', 'pendiente');

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.AUTORIZACION_REVOCADA,
    entidad: AUDIT_ENTITIES.AUTORIZACION,
    entidadId: auth.id,
    detalle: {
      origen: 'reporte_identidad_prospecto',
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

  return { reportado: true };
}

const MOTIVO_REPORTE_LABEL: Record<string, string> = {
  no_soy_yo: 'la persona que abrio el enlace dice que NO es el titular de esos datos',
  datos_incorrectos: 'los datos registrados no corresponden a esa persona',
};

/**
 * Evento de timeline + notificaciones del §12. Tipo 'estudio' a proposito: la
 * UI del timeline filtra por una lista CERRADA de tipos, asi que un tipo nuevo
 * se escribiria pero seria invisible (ya paso con citas y contratos).
 *
 * Canales: in-app + correo. SIN WhatsApp — ninguna plantilla aprobada en Meta
 * corresponde a este mensaje, y WHATSAPP_PROVIDER cae a 'mock' por defecto, o
 * sea el aviso critico podria no salir nunca y fallar en silencio.
 *
 * Tampoco se le escribe al contacto del solicitante: si acaban de reportar que
 * esos datos no son de esa persona, ese correo y ese telefono son justamente
 * los que estan en duda.
 */
async function avisarReporteIdentidad(expedienteId: string, input: ReportarIdentidadInput) {
  const [{ notificarUsuario, notificarYCorreo, notificarResponsableExpediente }, { listOperators }] =
    await Promise.all([
      import('@/modules/notificaciones/notificaciones.service'),
      import('@/modules/users/users.service'),
    ]);

  const { data: expRow } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero, inmuebles!expedientes_inmueble_id_fkey(propietario_id, direccion)')
    .eq('id', expedienteId)
    .maybeSingle();
  const exp = expRow as unknown as {
    numero?: string;
    inmuebles?: { propietario_id?: string | null; direccion?: string | null } | null;
  } | null;

  const titulo = 'Verificacion de identidad detenida';
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
  const mensaje =
    `En el estudio ${exp?.numero || expedienteId}, ${MOTIVO_REPORTE_LABEL[input.motivo]}. ` +
    'Detuvimos el enlace de autorizacion y no se consultara ninguna central de riesgo. ' +
    'Revisa los datos del solicitante y, si corresponde, envia un enlace nuevo.' +
    (input.detalle ? ' Quien reporto dejo una nota: la ve el equipo de Cofianza en el estudio.' : '');
  const link = `/expedientes/${expedienteId}`;
  const payload = { expediente_id: expedienteId, motivo: input.motivo };

  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'estudio',
      descripcion: `Autorizacion detenida: ${MOTIVO_REPORTE_LABEL[input.motivo]}. Marcado para revision.`,
      metadata: { automatico: true, origen: 'reporte_identidad_prospecto', motivo: input.motivo },
    } as never);

  const propietarioId = exp?.inmuebles?.propietario_id ?? null;
  if (propietarioId) {
    await notificarUsuario({
      userId: propietarioId,
      tipo: 'autorizacion.identidad_reportada',
      titulo,
      mensaje,
      link,
      payload,
    }).catch((e) => logger.warn({ error: e }, '§12: notif propietario'));
  }
  await notificarResponsableExpediente({
    expedienteId,
    excluirPerfilId: propietarioId,
    tipo: 'autorizacion.identidad_reportada',
    titulo,
    mensaje,
    link,
    payload,
  }).catch((e) => logger.warn({ error: e }, '§12: notif responsable'));

  // "y a Cofianza": no existe un canal interno unico, asi que se avisa a los
  // operadores activos (in-app + correo con la cascara generica).
  const operadores = await listOperators().catch(() => []);
  await Promise.all(
    operadores.map((op) =>
      notificarYCorreo({
        userId: op.id,
        tipo: 'autorizacion.identidad_reportada',
        titulo,
        mensaje,
        link,
        payload,
      }).catch((e) => logger.warn({ error: e }, '§12: notif operador Cofianza')),
    ),
  );
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
  const titulo = 'El prospecto ya autorizo';
  const mensaje = `${nombre} autorizo la consulta en centrales de riesgo para el estudio ${exp?.numero ?? ''}${exp?.inmuebles?.direccion ? ` (${exp.inmuebles.direccion})` : ''}. El estudio continua segun la forma de pago elegida.`;
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
    .select('id, estado, token_expiracion, texto_autorizado, solicitante_id, expediente_id, solicitantes(tipo_documento, numero_documento)')
    .eq('token', token)
    .maybeSingle();

  // Distinguir error real de BD (→ 500, reintentable) de "no existe" (→ 404).
  if (error) {
    logger.error({ error }, 'Error de BD consultando autorizacion para firmar');
    throw fromSupabaseError(error);
  }
  if (!autorizacion) {
    throw AppError.notFound('Autorizacion no encontrada', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as AutorizacionRow & {
    expediente_id?: string;
    solicitantes?: { tipo_documento: string | null; numero_documento: string | null } | null;
  };

  if (auth.estado !== 'pendiente') {
    // Diferenciar: 'autorizado' = ya firmada (el front puede mostrar éxito
    // idempotente); expirado/revocado = el enlace ya NO sirve — mostrar éxito
    // aquí haría creer al solicitante que terminó cuando nada va a correr.
    if (auth.estado === 'autorizado') {
      throw AppError.badRequest('Esta autorizacion ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorizacion ya no esta vigente', 'AUTORIZACION_NO_VIGENTE');
  }

  if (new Date(auth.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de autorizacion ha expirado', 'AUTORIZACION_EXPIRADA');
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
        'Debe verificar el codigo OTP antes de firmar',
        'OTP_NO_VERIFICADO',
      );
    }

    // Un OTP verificado pero caducado no sirve como prueba de posesion
    // reciente: hay que pedir y verificar uno nuevo.
    if (new Date((otp as unknown as OtpRow).expira_en) < new Date()) {
      throw AppError.badRequest(
        'El codigo OTP expiro. Solicite uno nuevo y verifiquelo antes de firmar.',
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
  const tipoDocumentoAceptante = auth.solicitantes?.tipo_documento?.trim().toLowerCase() || null;
  if (!numeroDocumentoAceptante) {
    logger.warn(
      { autorizacionId: auth.id, solicitanteId: auth.solicitante_id },
      'firmarAutorizacion: el solicitante no tiene numero_documento — la evidencia queda sin documento del aceptante',
    );
  }

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
    throw AppError.badRequest('Error al firmar la autorizacion', 'AUTORIZACION_FIRMA_ERROR');
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
      throw AppError.badRequest('Esta autorizacion ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorizacion ya no esta vigente', 'AUTORIZACION_NO_VIGENTE');
  }

  // 4b. Flujo §8.1: la confirmacion de identidad puede venir tambien en el
  // body de la firma. El PASO 5 la guarda por su propio endpoint, pero la web
  // traga ese fallo y firma igual; si llego aqui se registra con las MISMAS
  // columnas (camposIdentidadConfirmada), en la fila 1:1 del expediente.
  // Best-effort: la firma ya quedo escrita; perder esta marca es malo,
  // deshacer la firma por ella seria peor.
  if (input.identidad_confirmada && auth.expediente_id) {
    try {
      const { error: perfilError } = await (supabase
        .from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
        .upsert(
          {
            expediente_id: auth.expediente_id,
            autorizacion_id: auth.id,
            updated_at: autorizadoEn.toISOString(),
            ...camposIdentidadConfirmada(autorizadoEn.toISOString()),
          } as never,
          { onConflict: 'expediente_id' },
        );
      if (perfilError) throw new Error(perfilError.message);
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), autorizacionId: auth.id, expedienteId: auth.expediente_id },
        '§8.1: no se pudo registrar la confirmacion de identidad que vino con la firma',
      );
    }
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
      identidad_confirmada: input.identidad_confirmada === true,
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
  const pagoRequerido = auth.expediente_id
    ? !(await estudioPagado(auth.expediente_id)) && (await cobroLeTocaAlProspecto(auth.expediente_id))
    : false;

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
  estado: 'preparando' | 'pendiente' | 'procesando' | 'completado' | 'no_aplica';
  monto_formateado: string | null;
  payment_link_url: string | null;
}> {
  const { data: auth } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, expediente_id')
    .eq('token', token)
    .maybeSingle();
  const a = auth as { estado?: string; expediente_id?: string | null } | null;
  if (!a) throw AppError.notFound('Autorización no encontrada', 'AUTORIZACION_NOT_FOUND');
  if (a.estado !== 'autorizado' || !a.expediente_id) {
    return { estado: 'no_aplica', monto_formateado: null, payment_link_url: null };
  }
  if (!(await cobroLeTocaAlProspecto(a.expediente_id))) {
    return { estado: 'no_aplica', monto_formateado: null, payment_link_url: null };
  }

  const { data: pagoRow } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('estado, monto, payment_link_url')
    .eq('expediente_id', a.expediente_id)
    .eq('concepto', 'estudio')
    .in('estado', ['pendiente', 'procesando', 'completado'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const pago = pagoRow as { estado?: string; monto?: number; payment_link_url?: string | null } | null;

  const { getMontoEstudio } = await import('@/modules/pago-estudio/pago-estudio.service');
  const monto = pago?.monto ?? (await getMontoEstudio().catch(() => null));
  const montoFormateado =
    typeof monto === 'number' ? `$${Math.round(monto).toLocaleString('es-CO')}` : null;

  // Una fila 'pendiente' sin URL significa que el link todavia se esta creando
  // en la pasarela: el front sigue esperando en vez de mostrar un boton muerto.
  const listo = pago?.estado === 'pendiente' && !!pago.payment_link_url;
  return {
    estado: !pago ? 'preparando' : pago.estado === 'pendiente' && !listo ? 'preparando' : (pago.estado as 'pendiente' | 'procesando' | 'completado'),
    monto_formateado: montoFormateado,
    payment_link_url: listo ? (pago!.payment_link_url as string) : null,
  };
}

/**
 * ¿El pagador del estudio es el ARRENDATARIO (opción C del §6.3)? Es el mismo
 * dato con el que decide el orquestador (`siguientePasoEstudio`), leído de la
 * misma columna, para que la pantalla del prospecto no prometa un cobro que el
 * backend no va a emitir.
 */
async function cobroLeTocaAlProspecto(expedienteId: string): Promise<boolean> {
  const { data } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select('pago_por')
    .eq('expediente_id', expedienteId)
    .neq('tipo', 'con_coarrendatario')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { pago_por?: string | null } | null)?.pago_por === 'arrendatario';
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
    throw AppError.notFound('Autorizacion no encontrada', 'AUTORIZACION_NOT_FOUND');
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
      throw AppError.badRequest('Esta autorizacion ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorizacion ya no esta vigente', 'AUTORIZACION_NO_VIGENTE');
  }

  if (new Date(auth.token_expiracion) < new Date()) {
    throw AppError.badRequest('El enlace de autorizacion ha expirado', 'AUTORIZACION_EXPIRADA');
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
        `Debe esperar ${remaining} segundos antes de solicitar otro codigo`,
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
    throw AppError.badRequest('Error al generar el codigo OTP', 'OTP_CREATE_ERROR');
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
      'No pudimos enviarte el codigo en este momento. Intenta de nuevo en unos segundos.',
      'OTP_DELIVERY_FAILED',
    );
  }

  return {
    mensaje: auth.solicitantes.telefono
      ? 'Codigo OTP enviado por WhatsApp y correo'
      : 'Codigo OTP enviado al correo del solicitante',
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
    throw AppError.notFound('Autorizacion no encontrada', 'AUTORIZACION_NOT_FOUND');
  }

  const auth = autorizacion as unknown as { id: string; estado: string; token_expiracion: string };

  if (auth.estado !== 'pendiente') {
    // Diferenciar: 'autorizado' = ya firmada (el front puede mostrar éxito
    // idempotente); expirado/revocado = el enlace ya NO sirve — mostrar éxito
    // aquí haría creer al solicitante que terminó cuando nada va a correr.
    if (auth.estado === 'autorizado') {
      throw AppError.badRequest('Esta autorizacion ya fue firmada', 'AUTORIZACION_YA_FIRMADA');
    }
    throw AppError.badRequest('Este enlace de autorizacion ya no esta vigente', 'AUTORIZACION_NO_VIGENTE');
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
    throw AppError.badRequest('No hay codigo OTP pendiente. Solicite uno nuevo.', 'OTP_NOT_FOUND');
  }

  const otpRow = otp as unknown as OtpRow;

  if (new Date(otpRow.expira_en) < new Date()) {
    throw AppError.badRequest(
      'El codigo OTP ha expirado. Solicite uno nuevo.',
      'OTP_EXPIRADO',
    );
  }

  if (otpRow.codigo !== codigo) {
    throw AppError.badRequest('Codigo OTP incorrecto', 'OTP_INCORRECTO');
  }

  // 3. Mark OTP as verified
  await (supabase
    .from('autorizacion_otps' as string) as ReturnType<typeof supabase.from>)
    .update({ verificado: true } as never)
    .eq('id', otpRow.id);

  return {
    verificado: true,
    mensaje: 'Codigo OTP verificado correctamente',
  };
}

// ============================================================
// 7. Revocar autorizacion (auth)
// ============================================================

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
  //    expediente puede tener DOS filas 'autorizado' (titular y co-arrendatario
  //    invitado). Sin filtrar por sujeto, Postgres podía devolver la del
  //    co-arrendatario: la API respondía 200 'revocado' al titular, revocaba a
  //    quien no lo pidió y dejaba viva la firma del titular — que el gate seguía
  //    aceptando, así que el buró se podía volver a consultar sobre alguien que
  //    acababa de revocar. Y el trigger de la migración hace la revocación
  //    irreversible. El gate (autorizacion.guard.ts) ya resuelve el sujeto antes
  //    de consultar; aquí se hace igual.
  //
  //    `input.coarrendatario_id` selecciona el otro sujeto: es la única vía por
  //    la que se puede revocar la autorización del co-arrendatario invitado
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
        ? 'No se encontro autorizacion activa de ese co-arrendatario en este estudio'
        : 'No se encontro autorizacion activa para este estudio',
      'AUTORIZACION_NOT_FOUND',
    );
  }

  const auth = autorizacion as unknown as { id: string; estado: string };

  // 2. Update to revocado
  const { error: updateError } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .update({
      estado: 'revocado',
      fecha_revocacion: new Date().toISOString(),
      motivo_revocacion: input.motivo,
    } as never)
    .eq('id', auth.id);

  if (updateError) {
    logger.error({ error: updateError, autorizacionId: auth.id }, 'Error al revocar autorizacion');
    throw AppError.badRequest('Error al revocar la autorizacion', 'AUTORIZACION_REVOKE_ERROR');
  }

  // 3. Audit
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.AUTORIZACION_REVOCADA,
    entidad: AUDIT_ENTITIES.AUTORIZACION,
    entidadId: auth.id,
    detalle: {
      expediente_id: expedienteId,
      motivo: input.motivo,
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

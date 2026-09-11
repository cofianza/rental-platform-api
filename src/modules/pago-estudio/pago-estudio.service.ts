/**
 * Pago Estudio Service (HP-353)
 *
 * Formas de pago del estudio (Flujo §6, Adenda 2 §7 — no hay una cuarta):
 * - A: credito del paquete prepagado (creditos-estudios).
 * - B: el gestor paga en el momento por la pasarela (pagarGestor).
 * - C: enlace de pago al prospecto, despues de su autorizacion (enviarLinkPago).
 * La modalidad "a cuenta" (el costo se anotaba sin cobrar) NO se aprobo.
 */

import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { sendPaymentLinkEmail } from '@/lib/email';
import { getPaymentGateway } from '@/modules/pagos/gateway';
import { transitionPagoState } from '@/modules/pagos/pago-state-machine';
import { attachFacturas } from '@/modules/pagos/pagos.service';
import { notificarUsuario, findPerfilIdByEmail } from '@/modules/notificaciones/notificaciones.service';
import { enviarTemplate } from '@/modules/whatsapp';
import { perfilEsDuenoDeInmueble, assertExpedienteAccess } from '@/lib/tenantScope';
import { assertCanonDentroDelTope } from '@/modules/estudios/tope-canon.guard';
import type { EnviarLinkInput, ReenviarLinkInput } from './pago-estudio.schema';

/**
 * WhatsApp con el link de pago al solicitante del expediente (refuerzo del
 * correo). Fire-and-forget: enviarTemplate ya traga errores y sin teléfono
 * simplemente no envía. `telefonoOverride` (del form de enviar-link) tiene
 * prioridad sobre el teléfono registrado del solicitante.
 */
async function enviarLinkPagoWhatsApp(
  expedienteId: string,
  montoFormateado: string,
  linkUrl: string,
  telefonoOverride?: string | null,
) {
  const { data: exp } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('solicitante_id, solicitantes(nombre, telefono)')
    .eq('id', expedienteId)
    .maybeSingle();
  const sol = (exp as { solicitantes?: { nombre?: string | null; telefono?: string | null } } | null)?.solicitantes;
  await enviarTemplate({
    to: telefonoOverride ?? sol?.telefono ?? null,
    template: 'PAGO_ESTUDIO_LINK',
    variables: [sol?.nombre || 'Hola', montoFormateado, linkUrl],
    context: { expediente_id: expedienteId },
  });
}

/**
 * El PhoneInput de la web emite '+57 ' (truthy) cuando el usuario borra el
 * número — solo tratamos el teléfono como override si tiene dígitos reales
 * más allá del indicativo.
 */
function telefonoOverrideValido(telefono?: string): string | undefined {
  if (!telefono) return undefined;
  const digits = telefono.replace(/\D/g, '').replace(/^57/, '');
  return digits.length >= 7 ? telefono : undefined;
}

// ============================================================
// Helpers
// ============================================================

const PAGO_SELECT = `
  id, expediente_id, concepto, descripcion, monto, moneda, metodo, estado,
  payment_link_url, external_id, email_pagador, nombre_pagador,
  fecha_pago, created_at, updated_at, creado_por
`;

/**
 * Precio canonico del estudio. Exportado porque la ruta generica
 * POST /expedientes/:id/pagos tambien puede cobrar concepto='estudio' y NO
 * puede aceptar el monto que mande el cliente: el gate de ejecucion solo mira
 * que exista la fila 'completado', asi que un link de $1.000 compraba una
 * consulta al buro entera.
 */
export async function getMontoEstudio(): Promise<number> {
  const { data, error } = await (supabase
    .from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>)
    .select('valor')
    .eq('clave', 'monto_estudio')
    .single();

  if (error || !data) {
    logger.warn('monto_estudio not found in configuracion_sistema — using default 80000');
    return 80000;
  }

  return parseInt((data as { valor: string }).valor, 10) || 80000;
}

async function getExpedienteWithInmueble(expedienteId: string) {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, inmueble_id')
    .eq('id', expedienteId)
    .single();

  if (error || !data) throw AppError.notFound('Estudio no encontrado');

  const exp = data as { id: string; numero: string; estado: string; inmueble_id: string | null };

  let inmuebleDireccion = '';
  if (exp.inmueble_id) {
    const { data: inmueble } = await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .select('direccion, ciudad')
      .eq('id', exp.inmueble_id)
      .single();

    if (inmueble) {
      const inm = inmueble as { direccion: string; ciudad: string };
      inmuebleDireccion = `${inm.direccion}${inm.ciudad ? `, ${inm.ciudad}` : ''}`;
    }
  }

  return { ...exp, inmueble_direccion: inmuebleDireccion };
}

async function findPagoEstudio(expedienteId: string) {
  const { data } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select(PAGO_SELECT)
    .eq('expediente_id', expedienteId)
    .eq('concepto', 'estudio')
    .not('estado', 'eq', 'cancelado')
    .order('created_at', { ascending: false })
    .limit(1);

  return (data && data.length > 0) ? data[0] as Record<string, unknown> : null;
}

function formatCOP(amount: number): string {
  return `$${amount.toLocaleString('es-CO')}`;
}

/**
 * ¿El TITULAR ya firmó el habeas data y sigue vigente?
 *
 * Mismo predicado que `enviarEnlaceAutorizacion` y que el gate 8.4
 * (`coarrendatario_id IS NULL`, no revocada, vigente): si se desincronizan, una
 * capa cobra y la otra bloquea.
 */
async function titularYaAutorizo(expedienteId: string): Promise<boolean> {
  const { data } = await (supabase
    .from('autorizaciones_habeas_data' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('expediente_id', expedienteId)
    .is('coarrendatario_id', null)
    .eq('estado', 'autorizado')
    .is('fecha_revocacion', null)
    .or(`vigente_hasta.is.null,vigente_hasta.gt.${new Date().toISOString()}`)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Deja anotado en el estudio que el pagador sera el ARRENDATARIO (opcion C).
 * Es lo que le permite al hook de la firma saber si tiene que generarle el
 * cobro al prospecto o si el gestor todavia no decidio y hay que esperarlo.
 *
 * Best-effort: si falla, el estudio queda en espera y el gestor decide desde el
 * panel — el lado seguro (nunca se cobra de mas). Solo se escribe aqui: A y B
 * crean su fila de pago 'completado', y `pago_por` unicamente se consulta
 * cuando NO hay ninguna fila de pago.
 */
async function marcarPagoArrendatario(expedienteId: string): Promise<void> {
  const { error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .update({ pago_por: 'arrendatario' } as never)
    .eq('expediente_id', expedienteId)
    .neq('tipo', 'con_coarrendatario');
  if (error) {
    logger.warn({ error: error.message, expedienteId }, 'No se pudo marcar pago_por en el estudio');
  }
}

// ============================================================
// Get estado del pago del estudio
// ============================================================

export async function getEstadoPagoEstudio(expedienteId: string, userId?: string, userRol?: string) {
  // Tenant guard (404 fuera de scope): esta respuesta lleva el objeto `pago`
  // completo —con email_pagador/nombre_pagador del prospecto— y, desde el
  // §6.3, tambien `autorizado`, o sea si un tercero ya firmo su habeas data.
  await assertExpedienteAccess(expedienteId, userId, userRol);

  const monto = await getMontoEstudio();
  const pago = await findPagoEstudio(expedienteId);
  // `autorizado` es lo unico que le permite al panel (y a la vista del
  // prospecto) distinguir "esperando que autorice" de "autorizado, falta
  // cobrar". Sin el, con el orden del §6.3 la ventana entre habilitar y firmar
  // se veia igual que "el gestor no ha decidido nada".
  const autorizado = await titularYaAutorizo(expedienteId);

  if (!pago) {
    // Opcion C con el orden nuevo: el gestor ya eligio "enviar link al
    // arrendatario", pero todavia no existe fila de pago porque el cobro se
    // crea al firmar. No es 'sin_definir': la decision ya esta tomada.
    const { data: estRow } = await (supabase
      .from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select('pago_por')
      .eq('expediente_id', expedienteId)
      .neq('tipo', 'con_coarrendatario')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const esperandoAutorizacion =
      !autorizado && (estRow as { pago_por?: string | null } | null)?.pago_por === 'arrendatario';

    return {
      estado: esperandoAutorizacion ? 'esperando_autorizacion' : 'sin_definir',
      puede_avanzar: false,
      autorizado,
      monto,
      moneda: 'COP',
      monto_formateado: formatCOP(monto),
      pago: null,
    };
  }

  const estado = pago.estado as string;
  const metodo = pago.metodo as string;

  // Adjuntar la factura emitida al pago para que el frontend pueda decidir
  // si mostrar "Facturar" vs "Ver factura" tras un refresh. Sin esto, el
  // boton "Facturar" reaparecia despues de emitir porque el local state
  // (facturaIdEmitida) se pierde al re-montar el componente.
  const [pagoConFactura] = await attachFacturas([pago as Record<string, unknown> & { id: string }]);

  return {
    estado: estado === 'completado' && metodo !== 'pasarela' ? 'asumido_inmobiliaria' : estado,
    puede_avanzar: estado === 'completado',
    autorizado,
    monto: pago.monto as number,
    moneda: 'COP',
    monto_formateado: formatCOP(pago.monto as number),
    pago: pagoConFactura,
  };
}

/**
 * Expira el link en la pasarela (best-effort, fire-and-forget): un pago
 * cancelado en BD no debe seguir siendo pagable desde el email del arrendatario.
 */
function invalidarLinkPasarela(pago: { external_id?: string | null; metodo?: string | null }): void {
  if (pago.metodo !== 'pasarela' || !pago.external_id) return;
  const gateway = getPaymentGateway();
  if (!gateway.cancelPaymentLink) return;
  gateway
    .cancelPaymentLink(pago.external_id)
    .catch((err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), externalId: pago.external_id },
        'No se pudo expirar el link en la pasarela (el pago en BD ya quedó cancelado)',
      ),
    );
}

// ============================================================
// Cobro por pasarela — compartido por la opcion B y la C
// ============================================================

/**
 * Crea el pago 'pendiente' y su checkout en la pasarela. Lanza si ya hay un
 * pago activo. Lo usan la C (paga el prospecto, fase 2 de enviarLinkPago) y la
 * B (paga el gestor, pagarGestor): mismo cobro, distinto pagador.
 */
async function crearCobroPasarela(args: {
  expedienteId: string;
  userId: string;
  emailPagador: string;
  nombrePagador: string;
  /** Sufijo del concepto que ve el pagador en el checkout. */
  sufijoConcepto?: string;
}) {
  const { expedienteId, userId, emailPagador, nombrePagador } = args;

  // Check no existing active pago (pendiente or procesando)
  const existing = await findPagoEstudio(expedienteId);
  if (existing) {
    const estado = existing.estado as string;
    if (estado === 'completado') {
      throw AppError.conflict('Ya existe un pago de estudio completado', 'PAGO_ESTUDIO_YA_COMPLETADO');
    }
    if (estado === 'pendiente' || estado === 'procesando') {
      throw AppError.conflict('Ya existe un link de pago pendiente para este estudio', 'PAGO_ESTUDIO_PENDIENTE');
    }
  }

  const exp = await getExpedienteWithInmueble(expedienteId);
  const monto = await getMontoEstudio();
  const conceptLabel = `Estudio de arrendamiento - ${exp.inmueble_direccion || `Exp. ${exp.numero}`}${args.sufijoConcepto ?? ''}`;

  // El id va PRE-generado y viaja en las URLs de retorno: el arrendatario que
  // cancela o al que le rechazan el pago no tiene sesión, así que sin el
  // `pago` en la URL la pantalla de resultado no puede ofrecerle reintentar.
  const pagoId = crypto.randomUUID();

  // Build success/cancel/pending URLs (pending: PSE/efectivo no es éxito todavía)
  const successUrl = `${env.FRONTEND_URL}/pago/resultado?status=success&expediente=${expedienteId}&pago=${pagoId}`;
  const cancelUrl = `${env.FRONTEND_URL}/pago/resultado?status=cancelled&expediente=${expedienteId}&pago=${pagoId}`;
  const pendingUrl = `${env.FRONTEND_URL}/pago/resultado?status=pending&expediente=${expedienteId}&pago=${pagoId}`;

  // Insert pago ANTES de crear el checkout, con id pre-generado: la preference
  // lleva el pago_id en external_reference y el webhook casa el pago EXACTO.
  // El índice único uq_pagos_estudio_activo convierte la carrera de doble click
  // en un 23505 limpio en lugar de dos links vivos.
  const gateway = getPaymentGateway();
  const { error: insertError } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      id: pagoId,
      expediente_id: expedienteId,
      concepto: 'estudio',
      descripcion: conceptLabel,
      monto,
      metodo: 'pasarela',
      estado: 'pendiente',
      email_pagador: emailPagador,
      nombre_pagador: nombrePagador,
      creado_por: userId,
    } as never);

  if (insertError) {
    if (insertError.code === '23505') {
      throw AppError.conflict('Ya existe un pago de evaluación activo para este estudio', 'PAGO_ESTUDIO_PENDIENTE');
    }
    logger.error({ error: insertError.message }, 'Error creating estudio payment record');
    throw fromSupabaseError(insertError);
  }

  let linkResult: { url: string; externalId: string };
  try {
    linkResult = await gateway.createPaymentLink({
      amount: monto,
      concept: conceptLabel,
      description: `Pago de estudio de arrendamiento para ${nombrePagador}`,
      metadata: {
        expediente_id: expedienteId,
        concepto: 'estudio',
        email_pagador: emailPagador,
        pago_id: pagoId,
      },
      successUrl,
      cancelUrl,
      pendingUrl,
    });
  } catch (gatewayError) {
    // No dejar la fila huérfana bloqueando el índice único.
    await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', pagoId);
    throw gatewayError;
  }

  // CAS sobre 'pendiente': si el pago fue cancelado concurrentemente (p. ej.
  // cancelar-y-pagar mientras se creaba el checkout), no se adjunta un link
  // pagable a un pago cancelado — se expira la preference y se aborta.
  const { data: pago, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .update({
      payment_link_url: linkResult.url,
      external_id: linkResult.externalId,
    } as never)
    .eq('id', pagoId)
    .eq('estado', 'pendiente')
    .select(PAGO_SELECT)
    .maybeSingle();

  if (error) {
    logger.error({ error: error.message, pagoId }, 'Error guardando el link del estudio — se revierte');
    await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', pagoId);
    if (gateway.cancelPaymentLink) {
      gateway.cancelPaymentLink(linkResult.externalId).catch((err) =>
        logger.warn({ err, externalId: linkResult.externalId }, 'No se pudo expirar la preference tras revertir'),
      );
    }
    throw fromSupabaseError(error);
  }

  if (!pago) {
    if (gateway.cancelPaymentLink) {
      gateway.cancelPaymentLink(linkResult.externalId).catch((err) =>
        logger.warn({ err, externalId: linkResult.externalId }, 'No se pudo expirar la preference tras cancelación concurrente'),
      );
    }
    throw AppError.conflict('El pago fue cancelado mientras se creaba el link', 'PAGO_CANCELADO_CONCURRENTE');
  }

  // Record events
  await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .insert({
      pago_id: pago.id,
      tipo: 'created',
      origen: 'system',
      detalles: { gateway: gateway.provider, external_id: linkResult.externalId },
    } as never);

  return { pago: pago as Record<string, unknown> & { id: string }, linkUrl: linkResult.url, exp, monto };
}

// ============================================================
// Opcion B — el gestor paga en el momento por la pasarela: POST /pagar
// ============================================================

/**
 * Adenda 2 §7: "NO se aprueba la modalidad a cuenta. La opción de pago
 * inmediato de la inmobiliaria debe conectarse a la pasarela de pagos. El
 * estudio no avanza hasta que el pago quede confirmado." Reemplaza a
 * asumirCosto, que anotaba un pago 'completado' sin mover dinero.
 *
 * Crea el checkout a nombre de quien paga (el gestor) y devuelve el pago con
 * su enlace para abrirlo. Al confirmarse, el webhook o la reconciliación
 * disparan onPagoConfirmado -> onEstudioPagado, igual que en la opción C: si
 * el prospecto no ha autorizado se le manda el habeas data; si ya autorizó, se
 * ejecuta el estudio. Si el gestor ya tenía SU checkout abierto, se le
 * devuelve el mismo (cerró la pestaña y vuelve a pulsar).
 *
 * `reemplazarPendiente`: si hay un enlace vivo del PROSPECTO se cancela
 * primero (era "cancelar y asumir"); sin la bandera se rechaza con 409.
 */
export async function pagarGestor(
  expedienteId: string,
  userId: string,
  ip?: string,
  userRol?: string,
  opts: { reemplazarPendiente?: boolean } = {},
) {
  // Tenant guard (404 fuera de scope): este cobro, una vez confirmado, dispara
  // la consulta FACTURABLE al buro del prospecto.
  await assertExpedienteAccess(expedienteId, userId, userRol);

  // TOPE DE CANON — flujo §4.4: "no se cobra el estudio". Antes de tocar el
  // pago vivo: cancelarlo y luego chocar con el tope dejaria el expediente sin
  // enlace y sin pago.
  await assertCanonDentroDelTope({ expedienteId, origen: 'pagarGestor' });

  const [{ data: authData }, { data: perfilRow }] = await Promise.all([
    supabase.auth.admin.getUserById(userId),
    (supabase.from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('nombre, apellido, razon_social')
      .eq('id', userId)
      .maybeSingle(),
  ]);
  const email = authData?.user?.email ?? null;
  const perfil = perfilRow as { nombre?: string | null; apellido?: string | null; razon_social?: string | null } | null;
  const nombre = perfil?.razon_social?.trim() || `${perfil?.nombre ?? ''} ${perfil?.apellido ?? ''}`.trim();
  if (!email || !nombre) {
    throw AppError.badRequest('Tu cuenta no tiene correo o nombre para emitir el cobro.', 'GESTOR_SIN_CONTACTO');
  }

  const existing = await findPagoEstudio(expedienteId);
  if (existing && ['pendiente', 'procesando'].includes(existing.estado as string)) {
    const esSuyo =
      existing.metodo === 'pasarela' &&
      String(existing.email_pagador ?? '').toLowerCase() === email.toLowerCase() &&
      !!existing.payment_link_url;
    if (esSuyo) return existing;
    if (!opts.reemplazarPendiente) {
      throw AppError.conflict(
        'Hay un enlace de pago vivo del prospecto. Cancélalo y paga tú desde el estudio.',
        'PAGO_ESTUDIO_PENDIENTE',
      );
    }
    // Cancelar el enlace del prospecto (BD + preference en la pasarela): sin
    // esto coexistirian dos cobros y el arrendatario podria pagar el viejo.
    await transitionPagoState({
      pagoId: existing.id as string,
      targetEstado: 'cancelado',
      origen: 'manual',
      detalles: { cancelado_por: userId, motivo: 'gestor_paga_por_pasarela' },
      userId,
      ip,
    });
    invalidarLinkPasarela(existing as { external_id?: string | null; metodo?: string | null });
  }

  const { pago, monto } = await crearCobroPasarela({
    expedienteId,
    userId,
    emailPagador: email,
    nombrePagador: nombre,
    sufijoConcepto: ` (pago de ${nombre})`,
  });

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_CREATED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: { expediente_id: expedienteId, concepto: 'estudio', monto, metodo: 'pasarela_gestor' },
    ip,
  });

  return pago;
}

// ============================================================
// Enviar link de pago al arrendatario — POST /enviar-link
// ============================================================

export async function enviarLinkPago(
  expedienteId: string,
  input: EnviarLinkInput,
  userId: string,
  ip?: string,
  userRol?: string,
) {
  // Tenant guard (404 fuera de scope). Desde el §6.3 la primera pasada de esta
  // funcion EMITE EVIDENCIA LEGAL: invalida la autorizacion pendiente del
  // titular, genera un token de habeas data firmable con OTP y le manda correo
  // + WhatsApp. Sin este guard, un gestor de otra agencia (o cualquier
  // solicitante, antes del roleGuard de la ruta) hacia todo eso sobre un
  // expediente ajeno. Las llamadas de sistema (habilitarEstudio, el hook de la
  // firma) no pasan rol y siguen entrando: assertExpedienteAccess retorna
  // early sin identidad.
  await assertExpedienteAccess(expedienteId, userId, userRol);

  // TOPE DE CANON — flujo §4.4: "el flujo se detiene con un mensaje claro y no
  // se cobra el estudio". Este es el cobro literal al prospecto (checkout de la
  // pasarela + correo + WhatsApp con el link), así que el tope se verifica
  // antes de crear la preference.
  await assertCanonDentroDelTope({ expedienteId, origen: 'enviarLinkPago' });

  // FASE 0 — LA INVERSIÓN DEL §6.3.
  //
  //   "El pago se solicita DESPUÉS de que el prospecto otorgue la autorización
  //    y ANTES de que el motor ejecute la evaluación. Si se cobra antes de
  //    autorizar, se cobra a personas que nunca autorizan."
  //
  // Por eso esta función tiene DOS fases y sigue teniendo un solo nombre
  // (ponytail: renombrarla arrastra routes, controller y el componente web sin
  // cambiar nada de comportamiento):
  //   1ª llamada (el gestor pulsa "Enviar link al arrendatario", o el
  //      propietario habilita el estudio): NO se cobra. Se anota quién paga y
  //      se le manda el habeas data. Es la única rama que cambia de orden.
  //   2ª llamada (el hook de la firma, orchestrator §6.3): el prospecto ya
  //      autorizó, así que aquí abajo se crea el cobro de verdad.
  //
  // Va ANTES del INSERT y de la preference —lo abortable primero, lo
  // irreversible después, la misma doctrina que cancelarYAsumir— para no dejar
  // una fila 'pendiente' huérfana bloqueando el índice único si el solicitante
  // no tiene email.
  //
  // Las opciones A y B NO pasan por aquí y NO cambian de orden: ahí el pagador
  // es la agencia y el cobro ya ocurrió antes de la autorización.
  if (!(await titularYaAutorizo(expedienteId))) {
    const { enviarEnlaceAutorizacion } = await import('@/modules/autorizaciones/autorizaciones.service');
    await enviarEnlaceAutorizacion(expedienteId, userId, ip, undefined, userRol);
    await marcarPagoArrendatario(expedienteId);
    logger.info(
      { expedienteId },
      '§6.3: primero la autorización — el enlace de pago se le genera al arrendatario cuando firme',
    );
    const monto = await getMontoEstudio();
    return {
      estado: 'esperando_autorizacion' as const,
      monto,
      monto_formateado: formatCOP(monto),
      pago: null,
    };
  }

  const { pago, linkUrl, exp, monto } = await crearCobroPasarela({
    expedienteId,
    userId,
    emailPagador: input.email_pagador,
    nombrePagador: input.nombre_pagador,
  });

  // Send email
  try {
    await sendPaymentLinkEmail(
      input.email_pagador,
      input.nombre_pagador,
      linkUrl,
      {
        concepto: 'Estudio de arrendamiento',
        monto: formatCOP(monto),
        expediente_numero: exp.numero,
      },
    );

    await (supabase
      .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
      .insert({
        pago_id: pago.id,
        tipo: 'link_sent',
        origen: 'system',
        detalles: { email: input.email_pagador },
      } as never);
  } catch (emailError) {
    logger.error({ emailError, pagoId: pago.id }, 'Error sending estudio payment email');
  }

  // WhatsApp con el link al solicitante (refuerzo del correo) — fire-and-forget.
  // El teléfono escrito en el form tiene prioridad sobre el registrado (antes
  // se aceptaba en el schema pero se ignoraba — dato muerto).
  enviarLinkPagoWhatsApp(expedienteId, formatCOP(monto), linkUrl, telefonoOverrideValido(input.telefono)).catch((err) =>
    logger.warn({ err, expedienteId }, 'No se pudo enviar el WhatsApp del link de pago'),
  );

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_CREATED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: { expediente_id: expedienteId, concepto: 'estudio', monto, email: input.email_pagador },
    ip,
  });

  // Notificacion in-app al solicitante: el link de pago esta listo. Si su
  // email matchea un perfil registrado, le aparece en la campana del panel.
  // Fire-and-forget — el email ya salio antes; esta es solo redundancia util.
  findPerfilIdByEmail(input.email_pagador).then((solicitanteUserId) => {
    if (!solicitanteUserId) return;
    return notificarUsuario({
      userId: solicitanteUserId,
      tipo: 'pago.disponible',
      titulo: 'Pago de estudio disponible',
      mensaje: `Ya autorizaste el tratamiento de datos. Paga el estudio crediticio (${formatCOP(monto)}) y ejecutamos la consulta en centrales automáticamente.`,
      link: `/expedientes/${expedienteId}`,
      payload: { expediente_id: expedienteId, pago_id: pago.id },
    });
  }).catch((e) => logger.warn({ error: e, pagoId: pago.id }, 'Error notificando link de pago disponible'));

  return pago;
}

// ============================================================
// Reenviar link — POST /reenviar
// ============================================================

export async function reenviarLink(
  expedienteId: string,
  userId: string,
  ip?: string,
  input?: ReenviarLinkInput,
  userRol?: string,
) {
  // Tenant guard: propietario/inmobiliaria solo sobre expedientes de inmuebles
  // que administran — sin esto, el override permitía reescribir el email del
  // pagador de otro tenant y desviar su link de pago. Admin/operador pasan.
  if (userRol === 'propietario' || userRol === 'inmobiliaria') {
    const { data: expRow } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('inmuebles!expedientes_inmueble_id_fkey(propietario_id, inmobiliaria_id)')
      .eq('id', expedienteId)
      .maybeSingle();
    const inm = (expRow as { inmuebles?: { propietario_id: string | null; inmobiliaria_id: string | null } } | null)?.inmuebles;
    const esDueno = await perfilEsDuenoDeInmueble({
      userId,
      userRol,
      inmueblePropietarioId: inm?.propietario_id ?? null,
      inmuebleInmobiliariaId: inm?.inmobiliaria_id ?? null,
    });
    if (!esDueno) {
      throw AppError.forbidden(
        'No tienes permisos para reenviar el link de pago de este estudio',
        'PAGO_ESTUDIO_FORBIDDEN',
      );
    }
  }

  const pago = await findPagoEstudio(expedienteId);
  if (!pago) throw AppError.notFound('No existe un pago de estudio para este estudio');
  if ((pago.estado as string) !== 'pendiente') {
    throw AppError.badRequest('Solo se puede reenviar el link de pagos en estado pendiente', 'PAGO_NO_REENVIABLE');
  }
  if (!pago.payment_link_url || !pago.email_pagador) {
    throw AppError.badRequest('Este pago no tiene link o email asociado', 'NO_PAYMENT_LINK');
  }

  // Corrección del destinatario: si vienen email/nombre nuevos, se persisten
  // en la fila `pagos` y el MISMO link se reenvía al contacto corregido (la
  // preference de Mercado Pago no está atada al email — no hay que recrearla).
  const emailNuevo = input?.email_pagador?.trim().toLowerCase();
  const nombreNuevo = input?.nombre_pagador?.trim();
  const emailDestino = emailNuevo || (pago.email_pagador as string);
  const nombreDestino = nombreNuevo || (pago.nombre_pagador as string) || '';
  const cambioContacto =
    (!!emailNuevo && emailNuevo !== (pago.email_pagador as string).toLowerCase()) ||
    (!!nombreNuevo && nombreNuevo !== ((pago.nombre_pagador as string) || ''));
  if (cambioContacto) {
    const { error: updError } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .update({
        ...(emailNuevo ? { email_pagador: emailNuevo } : {}),
        ...(nombreNuevo ? { nombre_pagador: nombreNuevo } : {}),
      } as never)
      .eq('id', pago.id as string);
    if (updError) {
      logger.warn(
        { error: updError.message, pagoId: pago.id },
        'No se pudo actualizar el contacto del pagador (se reenvía igual al corregido)',
      );
    }
  }

  const exp = await getExpedienteWithInmueble(expedienteId);
  const monto = pago.monto as number;

  await sendPaymentLinkEmail(
    emailDestino,
    nombreDestino,
    pago.payment_link_url as string,
    {
      concepto: 'Estudio de arrendamiento',
      monto: formatCOP(monto),
      expediente_numero: exp.numero,
    },
  );

  await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .insert({
      pago_id: pago.id as string,
      tipo: 'link_sent',
      origen: 'system',
      detalles: {
        email: emailDestino,
        reenviado_por: userId,
        ...(cambioContacto ? { email_anterior: pago.email_pagador } : {}),
      },
    } as never);

  // WhatsApp con el link al solicitante (refuerzo del correo) — fire-and-forget.
  enviarLinkPagoWhatsApp(expedienteId, formatCOP(monto), pago.payment_link_url as string).catch((err) =>
    logger.warn({ err, expedienteId }, 'No se pudo reenviar el WhatsApp del link de pago'),
  );

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_LINK_RESENT,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id as string,
    detalle: {
      email: emailDestino,
      ...(cambioContacto ? { email_anterior: pago.email_pagador } : {}),
    },
    ip,
  });

  return { message: `Link reenviado a ${emailDestino}` };
}

/**
 * Inmobiliaria: cancela el link pendiente y paga el estudio CONSUMIENDO UN
 * CRÉDITO (no "asume" gratis). Reusa liberarEstudioConCredito, que valida saldo,
 * crea el pago y auto-envía la autorización.
 */
export async function cancelarYLiberarCredito(expedienteId: string, userId: string, ip?: string, userRol?: string) {
  // Tenant guard (404 fuera de scope): igual que cancelarYAsumir, cancela el
  // link vivo y consume un credito.
  await assertExpedienteAccess(expedienteId, userId, userRol);

  // TOPE DE CANON — flujo §4.4. Antes de tocar el pago, por la misma razón que
  // el saldo de créditos se verifica abajo antes de cancelar el link: el guard
  // vive dentro de liberarEstudioConCredito, que se llama al final, y para
  // entonces el link ya estaría cancelado y la preference expirada.
  await assertCanonDentroDelTope({ expedienteId, origen: 'cancelarYLiberarCredito' });

  const pago = await findPagoEstudio(expedienteId);
  if (!pago) throw AppError.notFound('No existe un pago de estudio pendiente');
  if (!['pendiente', 'procesando'].includes(pago.estado as string)) {
    throw AppError.badRequest('Solo se puede cancelar un pago en estado pendiente o en proceso', 'PAGO_NO_CANCELABLE');
  }

  // perfilId = userId: la inmobiliaria dueña del inmueble es dueña de los créditos.
  const { liberarEstudioConCredito, getSaldoCreditos } = await import('@/modules/creditos-estudios/creditos-estudios.service');

  // Verificar saldo ANTES de cancelar el link: sin esto, una inmobiliaria sin
  // créditos perdía el link ya enviado al arrendatario y quedaba sin pago.
  // Mejor fallar acá y dejar el link vivo (puede comprar paquete o que pague el arrendatario).
  const saldo = await getSaldoCreditos(userId);
  if (saldo.saldo_total < 1) {
    throw AppError.conflict(
      'No tienes créditos disponibles. Compra un paquete o deja que el arrendatario pague el link actual.',
      'SIN_CREDITOS',
    );
  }

  await transitionPagoState({
    pagoId: pago.id as string,
    targetEstado: 'cancelado',
    origen: 'manual',
    detalles: { cancelado_por: userId, motivo: 'inmobiliaria_libera_credito' },
    userId,
    ip,
  });
  invalidarLinkPasarela(pago as { external_id?: string | null; metodo?: string | null });

  return liberarEstudioConCredito(expedienteId, userId, userId, ip);
}

// ============================================================
// Public: resultado del pago
// ============================================================

export async function getResultadoPagoPublico(pagoId: string) {
  const { data, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, concepto, monto, moneda, fecha_pago, expediente_id, payment_link_url')
    .eq('id', pagoId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Pago no encontrado');
  }

  const pago = data as { id: string; estado: string; concepto: string; monto: number; moneda: string; fecha_pago: string | null; expediente_id: string; payment_link_url: string | null };

  // Get expediente numero (minimal, no sensitive data)
  const { data: exp } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero')
    .eq('id', pago.expediente_id)
    .single();

  return {
    id: pago.id,
    estado: pago.estado,
    concepto: pago.concepto,
    monto: pago.monto,
    moneda: pago.moneda,
    monto_formateado: formatCOP(pago.monto),
    fecha_pago: pago.fecha_pago,
    expediente_numero: (exp as { numero: string } | null)?.numero || null,
    // Para que la pantalla de resultado pueda ofrecer "Volver a intentar" a
    // quien no tiene sesión. Solo mientras el checkout siga sirviendo:
    // 'fallido' incluido porque la máquina de estados permite fallido →
    // completado (Mercado Pago deja reintentar dentro del mismo checkout).
    // En 'completado'/'cancelado'/'reembolsado' se devuelve null: reabrir el
    // link ahí sería invitarlo a pagar dos veces o a un enlace muerto.
    payment_link_url: ['pendiente', 'procesando', 'fallido'].includes(pago.estado)
      ? pago.payment_link_url
      : null,
  };
}

/**
 * Reconciliación pública: tras volver del checkout, confirma el pago consultando
 * la pasarela con el payment_id (la pasarela lo pone en la URL de retorno). Es la
 * red de seguridad por si el webhook no llega — reusa la lógica del webhook, que
 * es idempotente. Import dinámico para evitar ciclos con pagos.service.
 */
export async function reconciliarPagoEstudio(paymentId: string): Promise<{ reconciliado: boolean }> {
  const { reconcileMercadoPagoPayment } = await import('@/modules/pagos/pagos.service');
  await reconcileMercadoPagoPayment(paymentId);
  return { reconciliado: true };
}

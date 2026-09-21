/**
 * Contratos V3 — asistente del contrato de vivienda (Entrega 3, diseño §3, §5.1, §5.6, §5.8).
 *
 * El borrador ES la fila `contratos` V3 en estado borrador (D1): los pasos viven
 * en datos_variables.asistente y se retoma desde cualquier equipo. Un paso
 * guardado solo escribe eso (y la propiedad horizontal del inmueble, §1.4);
 * solo generar escribe las columnas del contrato, contrato_partes y el PDF (D4).
 *
 * Toda lectura falla CERRADO (503 LECTURA_NO_VERIFICABLE): con un dato que no
 * se pudo leer no se decide si el contrato se puede crear. El aislamiento por
 * inmobiliaria es assertExpedienteAccess con userId Y userRol (sin ellos es no-op).
 */

import { env } from '@/config';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { assertExpedienteAccess } from '@/lib/tenantScope';
import { getCalibracion, type Calibracion } from '@/lib/calibracion';
import { checkPerfilCompletitud } from '@/modules/perfil-arrendador/perfil-arrendador.service';
import { tarifasDelEstudio } from '@/modules/estudios/tarifa-override.service';
import { ESTADOS_VINCULADO } from '@/modules/estudios/coarrendatario-vinculado';
import { avisarCandidatosDeReserva } from '@/modules/estudios/reserva-inmueble.notificaciones';
import {
  liberarReservaDeExpediente,
  reservarInmuebleParaContrato,
  type ReservaInmuebleResult,
} from '@/modules/inmuebles/inmuebles.service';
import type { EstadoAsistente, GuardarPasoBody, NumeroPaso, Pasos } from './asistente.types';
import {
  armarDatosVivienda,
  avisoCanon,
  avisosDePendientes,
  bloqueoNoImprimible,
  evaluarBloqueos,
  evaluarCanon,
  faltantes,
  masDias,
  maximoSinNuevaEvaluacionCop,
  noImprimibles,
  prefill,
  type Asistente,
  type AsistenteCompleto,
  type ContratoV3,
  type DocumentoV3,
  type Fuentes,
  type PerfilArrendador,
} from './asistente.reglas';
import type { LogoPdf } from './documento';
import { fechaBogota, sumarMeses } from './formato';
import { contexto, generarContratoVivienda, type DatosVivienda } from './vivienda';

const BUCKET = 'documentos-expedientes';
const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
const hoyBogota = () => fechaBogota(new Date());

const DESHABILITADO: EstadoAsistente = { habilitado: false, bloqueos: [], avisos: [], resumen: null, contrato: null };

const CONTRATO_V3_SELECT = 'id, estado, destinacion, numero, updated_at, datos_variables, storage_key';
const PERFIL_SELECT = `
  razon_social, nit, representante_legal,
  representante_legal_tipo_documento, representante_legal_documento,
  matricula_arrendador, matricula_expedida_por,
  domicilio_direccion, domicilio_ciudad, email_recaudo, whatsapp_recaudo, logo_storage_key,
  cuenta_recaudo_banco, cuenta_recaudo_tipo, cuenta_recaudo_numero,
  cuenta_recaudo_titular_nombre, cuenta_recaudo_titular_nit
`;

// ── Errores del asistente (§3.3) ──

const noHabilitado = () =>
  AppError.notFound('El asistente de contratos no está habilitado para este estudio.', 'CONTRATOS_V3_NO_HABILITADO');
const noIniciado = () => AppError.notFound('Primero inicia el contrato.', 'CONTRATO_V3_NO_INICIADO');
const noEditable = () =>
  AppError.conflict('El contrato ya no está en borrador; no se puede editar.', 'CONTRATO_NO_EDITABLE');
const borradorCambiado = () =>
  AppError.conflict(
    'El borrador cambió en otra sesión. Recarga la página para continuar.',
    'CONTRATO_BORRADOR_CAMBIADO',
  );
const bloqueado = (bloqueos: EstadoAsistente['bloqueos']) =>
  new AppError(409, 'CONTRATO_BLOQUEADO', bloqueos[0].mensaje, { bloqueos });

function noVerificable(expedienteId: string, que: string, detalle?: unknown): AppError {
  logger.error({ expedienteId, que, detalle }, 'Asistente V3: lectura fallida — no se decide nada (fail-closed)');
  return new AppError(
    503,
    'LECTURA_NO_VERIFICABLE',
    'No pudimos verificar los datos del estudio. Intenta de nuevo en un momento.',
  );
}

/** data de una lectura de Supabase, o 503. */
function dato<T>(r: { data: unknown; error: unknown } | null, expedienteId: string, que: string): T {
  if (r?.error) throw noVerificable(expedienteId, que, r.error);
  return (r?.data ?? null) as T;
}

/** NUMERIC de PostgREST (llega como string) → número > 0, o null. */
const monto = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

// ── §5.1 Fuentes ──

interface FilaExpediente {
  id: string;
  numero: string;
  estado: string;
  duracion_contrato_meses: number | null;
  fecha_inicio_contrato: string | null;
  inmuebles: (Omit<Fuentes['inmueble'], 'valorArriendoCop' | 'inmobiliaria_id'> & {
    inmobiliaria_id: string | null;
    valor_arriendo: number | string;
  }) | null;
  solicitantes: Fuentes['solicitante'] | null;
}

interface Cargadas {
  f: Fuentes;
  cal: Calibracion;
}

/** null = el asistente no aplica a este estudio (inmueble sin inmobiliaria, D5). */
export async function cargarFuentes(expedienteId: string): Promise<Cargadas | null> {
  const exp = dato<FilaExpediente | null>(
    await db('expedientes')
      .select(
        `id, numero, estado, duracion_contrato_meses, fecha_inicio_contrato,
        inmuebles!expedientes_inmueble_id_fkey(
          id, codigo, direccion, ciudad, uso, estado, reservado_por_expediente_id,
          inmobiliaria_id, valor_arriendo, propiedad_horizontal, parqueadero, cuarto_util
        ),
        solicitantes(nombre, apellido, tipo_documento, numero_documento, tipo_persona, email, telefono, direccion, ciudad)`,
      )
      .eq('id', expedienteId)
      .maybeSingle(),
    expedienteId,
    'expediente',
  );
  if (!exp) throw AppError.notFound('Estudio no encontrado', 'EXPEDIENTE_NOT_FOUND');
  const inm = exp.inmuebles;
  if (!inm?.inmobiliaria_id) return null;
  if (!exp.solicitantes) throw noVerificable(expedienteId, 'solicitante');

  const [estR, coaR, orgR, contratosR, cal] = await Promise.all([
    db('estudios')
      .select('id, resultado, fecha_completado, canon_evaluado')
      .eq('expediente_id', expedienteId)
      .eq('tipo', 'individual')
      .eq('estado', 'completado')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db('expediente_coarrendatarios')
      .select('id, nombre, apellido, tipo_documento, numero_documento, email, telefono, estado, estudio_id')
      .eq('expediente_id', expedienteId)
      .in('estado', ESTADOS_VINCULADO)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db('inmobiliarias').select('owner_perfil_id').eq('id', inm.inmobiliaria_id).maybeSingle(),
    db('contratos')
      .select(CONTRATO_V3_SELECT)
      .eq('expediente_id', expedienteId)
      .not('estado', 'in', '(cancelado,finalizado)'),
    getCalibracion(),
  ]);
  const est = dato<{ id: string; resultado: string | null; fecha_completado: string | null; canon_evaluado: unknown } | null>(
    estR,
    expedienteId,
    'estudio',
  );
  const coa = dato<Omit<NonNullable<Fuentes['coarrendatario']>, 'estudio'> | null>(coaR, expedienteId, 'coarrendatario');
  const org = dato<{ owner_perfil_id: string } | null>(orgR, expedienteId, 'inmobiliaria');
  const contratos = dato<(ContratoV3 & { destinacion: string | null })[] | null>(contratosR, expedienteId, 'contratos') ?? [];
  if (!org) throw noVerificable(expedienteId, 'inmobiliaria sin titular');
  const ownerId = org.owner_perfil_id;

  const [crcR, tarifa, sombraR, coaEstR, perfilR, completitud] = await Promise.all([
    est
      ? db('estudios_certificados')
          .select('id, codigo, version, fecha_emision, fecha_vencimiento, pdf_storage_key')
          .eq('estudio_id', est.id)
          .maybeSingle()
      : null,
    // Llamada de sistema (el acceso ya se verificó). Sin tarifa de respaldo (G9).
    est
      ? tarifasDelEstudio(est.id).catch((e: unknown) => {
          throw noVerificable(expedienteId, 'tarifas', e);
        })
      : null,
    est
      ? db('estudios_scorecard_sombra')
          .select('ingreso_inferido_ajustado_cop')
          .eq('estudio_id', est.id)
          .order('fecha_calculo', { ascending: false })
          .limit(1)
          .maybeSingle()
      : null,
    coa?.estudio_id ? db('estudios').select('estado, resultado').eq('id', coa.estudio_id).maybeSingle() : null,
    db('perfiles').select(PERFIL_SELECT).eq('id', ownerId).maybeSingle(),
    checkPerfilCompletitud(ownerId).catch((e: unknown) => {
      throw noVerificable(expedienteId, 'completitud', e);
    }),
  ]);
  const perfil = dato<PerfilArrendador | null>(perfilR, expedienteId, 'perfil del arrendador');
  // checkPerfilCompletitud no lanza: sin perfil devuelve incompleto SIN faltantes.
  if (!perfil || (!completitud.completo && completitud.faltantes.length === 0))
    throw noVerificable(expedienteId, 'perfil del arrendador');

  // El coarrendatario se lee ESTRICTO: la prima del CRC (tarifas, lectura
  // best-effort que ante error dice "solo") y las partes deben decir lo mismo.
  if (tarifa && tarifa.tarifas.con_coarrendatario !== (coa !== null))
    throw noVerificable(expedienteId, 'coarrendatario inconsistente con la tarifa', {
      tarifa: tarifa.tarifas.con_coarrendatario,
      coarrendatario: coa?.id ?? null,
    });

  const f: Fuentes = {
    expediente: {
      id: exp.id,
      numero: exp.numero,
      estado: exp.estado,
      duracion_contrato_meses: exp.duracion_contrato_meses,
      fecha_inicio_contrato: exp.fecha_inicio_contrato,
    },
    inmueble: { ...inm, inmobiliaria_id: inm.inmobiliaria_id, valorArriendoCop: Number(inm.valor_arriendo) },
    solicitante: exp.solicitantes,
    estudio: est
      ? {
          id: est.id,
          resultado: est.resultado,
          fecha_completado: est.fecha_completado,
          canonEvaluadoCop: monto(est.canon_evaluado),
        }
      : null,
    crc: dato<Fuentes['crc']>(crcR, expedienteId, 'CRC'),
    tarifas: tarifa?.tarifas ?? null,
    ingresoAjustadoCop: monto(
      dato<{ ingreso_inferido_ajustado_cop: unknown } | null>(sombraR, expedienteId, 'ingreso')
        ?.ingreso_inferido_ajustado_cop,
    ),
    coarrendatario: coa
      ? {
          ...coa,
          estudio: dato<{ estado: string; resultado: string | null } | null>(coaEstR, expedienteId, 'estudio del coarrendatario'),
        }
      : null,
    arrendador: perfil,
    completitudFaltantes: completitud.faltantes.map((x) => x.etiqueta),
    legacyVivos: contratos.filter((c) => !c.destinacion).length,
    v3: contratos.find((c) => c.destinacion) ?? null,
  };
  return { f, cal };
}

// ── Estado (GET y respuesta de toda acción) ──

const pasosDe = (a: Asistente): Partial<Pasos> =>
  Object.fromEntries(
    ([1, 2, 3, 4, 5] as NumeroPaso[]).filter((n) => a[`paso${n}`]).map((n) => [n, a[`paso${n}`]]),
  ) as Partial<Pasos>;

function armarEstado({ f, cal }: Cargadas, hoy: string): EstadoAsistente {
  const bloqueos = evaluarBloqueos(f, hoy, cal);
  const avisos: string[] = [];
  const a: Asistente = f.v3?.datos_variables?.asistente ?? {};

  // D7: el canon del paso 1 bloquea; antes de guardarlo, el del registro solo avisa.
  const canon = evaluarCanon(f, a.paso1?.canonCop ?? f.inmueble.valorArriendoCop, cal);
  if (canon?.bloqueo) {
    if (a.paso1) bloqueos.push(canon.bloqueo);
    else avisos.push(avisoCanon(canon.bloqueo));
  }

  let contrato: EstadoAsistente['contrato'] = null;
  if (f.v3 && f.v3.estado !== 'borrador') {
    // No se llega en E3 (la fila V3 solo se cancela); por si E5 la mueve.
    bloqueos.push({ codigo: 'CONTRATO_NO_EDITABLE', mensaje: 'El contrato ya no está en borrador; no se puede editar.' });
  } else if (f.v3) {
    const falta = faltantes(a, f, hoy);
    // Con todo lo demás resuelto, lo que generar rechazaría por no imprimible también se ve aquí.
    if (!bloqueos.length && !falta.length) {
      const rutas = noImprimibles(armarDatosVivienda(f, a as AsistenteCompleto, hoy, f.v3.numero));
      if (rutas.length) bloqueos.push(bloqueoNoImprimible(rutas));
    }
    const doc = f.v3.datos_variables?.documento;
    contrato = {
      id: f.v3.id,
      numero: f.v3.numero,
      estado: 'borrador',
      guardados: pasosDe(a),
      prefill: prefill(f, hoy, cal),
      faltantes: falta,
      documento: doc
        ? {
            generadoEn: doc.generadoEn,
            avisos: doc.avisos,
            desactualizado: !!a.actualizadoEn && a.actualizadoEn > doc.generadoEn,
          }
        : null,
    };
  }

  const { arrendador: p, solicitante: s, coarrendatario: coa, inmueble: inm, tarifas: t, crc } = f;
  return {
    habilitado: true,
    bloqueos,
    avisos,
    resumen: {
      expedienteNumero: f.expediente.numero,
      arrendador: {
        razonSocial: p.razon_social,
        nit: p.nit,
        representanteLegal: p.representante_legal,
        matricula: p.matricula_arrendador,
        matriculaExpedidaPor: p.matricula_expedida_por,
        cuenta: {
          banco: p.cuenta_recaudo_banco,
          tipo: p.cuenta_recaudo_tipo,
          numero: p.cuenta_recaudo_numero,
          titular: p.cuenta_recaudo_titular_nombre,
          nit: p.cuenta_recaudo_titular_nit,
        },
      },
      arrendatario: {
        nombre: `${s.nombre} ${s.apellido}`.trim(),
        tipoDocumento: s.tipo_documento,
        numeroDocumento: s.numero_documento,
      },
      coarrendatario: coa
        ? {
            nombre: `${coa.nombre} ${coa.apellido}`.trim(),
            tipoDocumento: coa.tipo_documento,
            numeroDocumento: coa.numero_documento,
          }
        : null,
      inmueble: {
        id: inm.id,
        codigo: inm.codigo,
        direccion: inm.direccion,
        municipio: inm.ciudad,
        canonRegistroCop: inm.valorArriendoCop,
      },
      fianza: t
        ? {
            via: t.via,
            primaPct: t.prima_vinculacion_pct,
            tarifaPct: t.tarifa_mensual_pct,
            ivaPct: t.iva_pct,
            cashbackPct: t.cashback_pct,
            negociada: t.negociada,
            crc: crc
              ? {
                  codigo: crc.codigo,
                  fechaEmision: fechaBogota(crc.fecha_emision),
                  vigenteHasta: fechaBogota(crc.fecha_vencimiento),
                }
              : null,
          }
        : null,
      // Sin el ingreso: el máximo no lo revela (§3.1).
      canon: { evaluadoCop: f.estudio?.canonEvaluadoCop ?? null, maximoSinNuevaEvaluacionCop: maximoSinNuevaEvaluacionCop(f, cal) },
    },
    contrato,
  };
}

/** Fuentes de un estudio con asistente, o 404 si no aplica. Sin verificar acceso: lo hace el caller. */
async function cargar(expedienteId: string): Promise<Cargadas> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  const c = await cargarFuentes(expedienteId);
  if (!c) throw noHabilitado();
  return c;
}

/** GET: sin efectos. Con el flag apagado no toca la base (ni para el acceso). */
export async function obtenerEstado(
  expedienteId: string,
  userId: string,
  userRol: string,
): Promise<EstadoAsistente> {
  if (!env.CONTRATOS_V3_ENABLED) return DESHABILITADO;
  await assertExpedienteAccess(expedienteId, userId, userRol);
  const c = await cargarFuentes(expedienteId);
  return c ? armarEstado(c, hoyBogota()) : DESHABILITADO;
}

function avisarAfectados(reserva: ReservaInmuebleResult, expedienteId: string) {
  if (!reserva.afectados.length) return;
  avisarCandidatosDeReserva({
    afectados: reserva.afectados,
    inmuebleCodigo: reserva.inmueble_codigo ?? null,
    inmuebleDireccion: reserva.inmueble_direccion ?? null,
    expedienteGanadorId: expedienteId,
  }).catch((e) => logger.warn({ error: e, expedienteId }, 'No se pudo avisar a los demas candidatos'));
}

// ── §5.6 Iniciar ──

/**
 * Asigna el número (trigger), reserva el inmueble y avisa a los demás
 * candidatos, en el orden del legacy (reserva ANTES del INSERT): un contrato
 * vivo siempre implica un inmueble reservado. Idempotente por el índice
 * contratos_v3_vivo_uq.
 */
export async function iniciarContrato(
  expedienteId: string,
  userId: string,
  userRol: string,
  ip?: string,
): Promise<{ estado: EstadoAsistente; creado: boolean }> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  await assertExpedienteAccess(expedienteId, userId, userRol);
  const c = await cargar(expedienteId);
  const hoy = hoyBogota();
  if (c.f.v3) return { estado: armarEstado(c, hoy), creado: false };

  const bloqueos = evaluarBloqueos(c.f, hoy, c.cal);
  if (bloqueos.length) throw bloqueado(bloqueos);

  // 409 INMUEBLE_YA_RESERVADO / 503 RESERVA_NO_VERIFICABLE pasan tal cual.
  const reserva = await reservarInmuebleParaContrato(expedienteId);

  const { data, error } = await db('contratos')
    .insert({
      expediente_id: expedienteId,
      estado: 'borrador',
      destinacion: 'vivienda',
      iva_canon_pct: 0,
      generado_por: userId,
      datos_variables: { asistente: {} },
    } as never)
    .select(CONTRATO_V3_SELECT)
    .single();

  if (error || !data) {
    // Otra pestaña lo inició primero: la reserva es de este mismo estudio, no se suelta. Si
    // la hizo ESTA petición, solo ella tiene los afectados (la otra recibió ya_reservado y
    // lista vacía): el contrato vivo existe, así que el aviso se envía aquí.
    if (error?.code === '23505') {
      avisarAfectados(reserva, expedienteId);
      return { estado: armarEstado(await cargar(expedienteId), hoy), creado: false };
    }
    logger.error({ expedienteId, error: error?.message }, 'Asistente V3: no se pudo crear el borrador');
    if (reserva.reservado) await liberarReservaDeExpediente(expedienteId);
    throw new AppError(500, 'CONTRATO_CREATE_ERROR', 'No se pudo iniciar el contrato. Intenta de nuevo.');
  }

  // Después del INSERT: nadie recibe el aviso por un contrato que no llegó a existir.
  avisarAfectados(reserva, expedienteId);

  const fila = data as unknown as ContratoV3;
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_GENERATED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: fila.id,
    detalle: { expediente_id: expedienteId, v3: true, fase: 'iniciado', numero: fila.numero },
    ip,
  });
  return { estado: armarEstado({ ...c, f: { ...c.f, v3: fila } }, hoy), creado: true };
}

// ── §5.6 Guardar paso ──

function borradorEditable(f: Fuentes): ContratoV3 {
  if (!f.v3) throw noIniciado();
  if (f.v3.estado !== 'borrador') throw noEditable();
  return f.v3;
}

export async function guardarPaso(
  expedienteId: string,
  body: GuardarPasoBody,
  userId: string,
  userRol: string,
): Promise<EstadoAsistente> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  await assertExpedienteAccess(expedienteId, userId, userRol);
  const c = await cargar(expedienteId);
  const v3 = borradorEditable(c.f);
  const hoy = hoyBogota();

  if (body.paso === 3) {
    const max = masDias(hoy, 365);
    if ([body.datos.fechaInicio, body.datos.fechaEntrega].some((d) => d < hoy || d > max))
      throw AppError.badRequest('La fecha debe estar entre hoy y dentro de un año.', 'VALIDATION_ERROR');
  }

  const dv = v3.datos_variables ?? {};
  const asistente: Asistente = {
    ...dv.asistente,
    [`paso${body.paso}`]: body.datos,
    actualizadoEn: new Date().toISOString(),
  };
  // CAS: si otra sesión guardó o generó en el medio, updated_at ya cambió.
  const { data, error } = await db('contratos')
    .update({ datos_variables: { ...dv, asistente } } as never)
    .eq('id', v3.id)
    .eq('estado', 'borrador')
    .eq('updated_at', v3.updated_at)
    .select('id');
  if (error) {
    logger.error({ expedienteId, error: error.message }, 'Asistente V3: no se pudo guardar el paso');
    throw new AppError(500, 'CONTRATO_GUARDAR_ERROR', 'No se pudo guardar el paso. Intenta de nuevo.');
  }
  if (!(data as unknown[] | null)?.length) throw borradorCambiado();

  // §1.4: la propiedad horizontal se contesta aquí y se escribe en el inmueble. Best-effort.
  if (body.paso === 2 && body.datos.propiedadHorizontal !== c.f.inmueble.propiedad_horizontal) {
    const { error: phError } = await db('inmuebles')
      .update({ propiedad_horizontal: body.datos.propiedadHorizontal } as never)
      .eq('id', c.f.inmueble.id);
    if (phError)
      logger.warn({ expedienteId, error: phError.message }, 'Asistente V3: no se actualizo propiedad_horizontal del inmueble');
  }

  return armarEstado(await cargar(expedienteId), hoy);
}

// ── §5.6 Generar (vista previa en modo revisión, D6) ──

const MIME_LOGO: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/** El logo por su llave (el logo_url firmado vence a los 30 días). Sin logo la cabecera va vacía (§9.3). */
async function leerLogo(key: string | null): Promise<LogoPdf | null> {
  const mime = key ? MIME_LOGO[key.split('.').pop()?.toLowerCase() ?? ''] : undefined;
  if (!key || !mime) return null;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(key);
    if (error || !data) throw error ?? new Error('sin datos');
    return { mime, base64: Buffer.from(await data.arrayBuffer()).toString('base64') };
  } catch (e) {
    logger.warn({ key, error: e instanceof Error ? e.message : String(e) }, 'Asistente V3: logo no disponible — sale sin logo');
    return null;
  }
}

/** Una fila de contrato_partes por Persona del contrato (orden = orden de firma, V3 §6.5). */
function partes(contratoId: string, d: DatosVivienda, f: Fuentes) {
  const fila = (
    rol: string,
    orden: number,
    x: DatosVivienda['arrendador'],
    extra: Record<string, unknown>,
  ) => ({
    contrato_id: contratoId,
    rol,
    orden,
    tipo_persona: x.tipoPersona,
    nombre: x.nombre,
    tipo_documento: x.tipoDocumento,
    numero_documento: x.numeroDocumento,
    email: x.email,
    telefono: x.telefono,
    direccion: x.direccion,
    municipio: x.municipio,
    ...extra,
  });
  const coa = d.coarrendatarios[0];
  const p = f.arrendador;
  return [
    fila('arrendatario', 1, d.arrendatario, { estudio_id: f.estudio?.id ?? null }),
    ...(coa ? [fila('coarrendatario', 2, coa, { estudio_id: f.coarrendatario?.estudio_id ?? null })] : []),
    fila('arrendador', coa ? 3 : 2, d.arrendador, {
      digito_verificacion: d.arrendador.digitoVerificacion,
      representante_legal_nombre: p.representante_legal,
      representante_legal_tipo_documento: p.representante_legal_tipo_documento,
      representante_legal_documento: p.representante_legal_documento,
      matricula_numero: p.matricula_arrendador,
      matricula_expedida_por: p.matricula_expedida_por,
    }),
  ];
}

export async function generarVistaPrevia(
  expedienteId: string,
  userId: string,
  userRol: string,
  ip?: string,
): Promise<EstadoAsistente> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  await assertExpedienteAccess(expedienteId, userId, userRol);
  const c = await cargar(expedienteId);
  const { f, cal } = c;
  const v3 = borradorEditable(f);
  const hoy = hoyBogota();

  // Idempotente para el titular: cura una reserva perdida; si reserva de nuevo, avisa.
  avisarAfectados(await reservarInmuebleParaContrato(expedienteId), expedienteId);

  const dv = v3.datos_variables ?? {};
  const a: Asistente = dv.asistente ?? {};
  const bloqueos = evaluarBloqueos(f, hoy, cal);
  const canon = a.paso1 ? evaluarCanon(f, a.paso1.canonCop, cal) : null;
  if (canon?.bloqueo) bloqueos.push(canon.bloqueo);
  if (bloqueos.length) throw bloqueado(bloqueos);
  const falta = faltantes(a, f, hoy);
  if (falta.length)
    throw new AppError(422, 'CONTRATO_ASISTENTE_INCOMPLETO', `Faltan datos del asistente: ${falta[0].mensaje}`, {
      faltantes: falta,
    });

  const completo = a as AsistenteCompleto;
  const d = armarDatosVivienda(f, completo, hoy, v3.numero);
  const rutas = noImprimibles(d);
  if (rutas.length) throw bloqueado([bloqueoNoImprimible(rutas)]);

  const logoStorageKey = f.arrendador.logo_storage_key;
  // PLANTILLA_* (400/422/500) pasan tal cual.
  const r = await generarContratoVivienda(d, {
    modo: 'revision',
    logoInmobiliaria: await leerLogo(logoStorageKey),
    adicionales: [],
  });

  const generacion = (dv.documento?.generacion ?? 0) + 1;
  // Con el instante en la llave: un PDF huérfano (reinicio o timeout entre la
  // subida y el CAS) no deja el borrador atascado en "ya existe" con upsert:false.
  const key = `contratos/${expedienteId}/${v3.id}/revision-${generacion}-${Date.now()}.pdf`;
  const { error: upError } = await supabase.storage
    .from(BUCKET)
    .upload(key, r.pdf, { contentType: 'application/pdf', upsert: false });
  if (upError) {
    logger.error({ expedienteId, key, error: upError.message }, 'Asistente V3: no se pudo subir la vista previa');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al almacenar el PDF');
  }

  const generadoEn = new Date().toISOString();
  const valores = contexto(d).valores;
  const pendientes = r.pendientes.map((x) => x.id);
  const documento: DocumentoV3 = {
    generacion,
    generadoEn,
    plantillaVersion: r.version,
    pendientes,
    avisos: avisosDePendientes(r.pendientes),
    entrada: d,
    logoStorageKey,
    fijos: { diaPago: 1, puntosIpc: 0, servicios: 'arrendatario_todos' },
    snapshot: {
      estudio: { id: f.estudio?.id, fechaCompletado: f.estudio?.fecha_completado, canonEvaluadoCop: f.estudio?.canonEvaluadoCop },
      crc: f.crc && {
        id: f.crc.id,
        codigo: f.crc.codigo,
        version: f.crc.version,
        fechaEmision: f.crc.fecha_emision,
        fechaVencimiento: f.crc.fecha_vencimiento,
        pdfStorageKey: f.crc.pdf_storage_key,
      },
      tarifas: f.tarifas,
      cop: {
        comisionCop: valores.comisionCop,
        primaCop: valores.primaCop,
        tarifaCop: valores.tarifaCop,
        totalIngreso: valores.totalIngreso,
        totalMensual: valores.totalMensual,
      },
      // Sin el ingreso ni la relación en %: solo van a la bitácora.
      canon: {
        evaluadoCop: f.estudio?.canonEvaluadoCop ?? null,
        pactadoCop: completo.paso1.canonCop,
        veredicto: canon?.veredicto ?? null,
        canonIngreso: canon?.canonIngreso ?? null,
        topeCop: canon?.topeCop ?? null,
        toleranciaPct: canon?.toleranciaPct ?? null,
      },
      coarrendatario: f.coarrendatario ? { id: f.coarrendatario.id, estudioId: f.coarrendatario.estudio_id } : null,
    },
  };

  const { data, error } = await db('contratos')
    .update({
      valor_arriendo: completo.paso1.canonCop,
      fecha_inicio: completo.paso3.fechaInicio,
      fecha_fin: sumarMeses(completo.paso3.fechaInicio, completo.paso3.vigenciaMeses),
      duracion_meses: completo.paso3.vigenciaMeses,
      storage_key: key,
      nombre_archivo: `${v3.numero}-borrador.pdf`,
      fecha_generacion: generadoEn,
      datos_variables: { ...dv, asistente: a, documento },
    } as never)
    .eq('id', v3.id)
    .eq('estado', 'borrador')
    .eq('updated_at', v3.updated_at)
    .select('id');
  if (error || !(data as unknown[] | null)?.length) {
    await supabase.storage.from(BUCKET).remove([key]);
    if (error) {
      logger.error({ expedienteId, error: error.message }, 'Asistente V3: no se pudo guardar la vista previa');
      throw new AppError(500, 'CONTRATO_GUARDAR_ERROR', 'No se pudo guardar la vista previa. Intenta de nuevo.');
    }
    throw borradorCambiado();
  }

  // ponytail: borrar + insertar no es atómico; si falla, el próximo generar
  // realinea las partes y E5 las reconstruye antes de enviar a firma.
  const { error: delError } = await db('contrato_partes').delete().eq('contrato_id', v3.id);
  const { error: insError } = delError
    ? { error: delError }
    : await db('contrato_partes').insert(partes(v3.id, d, f) as never);

  if (v3.storage_key && v3.storage_key !== key) {
    const { error: rmError } = await supabase.storage.from(BUCKET).remove([v3.storage_key]);
    if (rmError) logger.warn({ expedienteId, key: v3.storage_key }, 'Asistente V3: no se borro la vista previa anterior');
  }

  if (insError) {
    logger.error({ expedienteId, error: insError.message }, 'Asistente V3: no se guardaron las partes del contrato');
    throw new AppError(
      500,
      'CONTRATO_PARTES_NO_GUARDADAS',
      'La vista previa quedó generada, pero no se guardaron las partes. Vuelve a generarla.',
    );
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_GENERATED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: v3.id,
    detalle: {
      expediente_id: expedienteId,
      v3: true,
      fase: 'vista_previa',
      numero: v3.numero,
      generacion,
      pendientes,
      // El ingreso SOLO queda aquí (nunca en datos_variables ni en la web).
      canon: {
        evaluado: f.estudio?.canonEvaluadoCop ?? null,
        pactado: completo.paso1.canonCop,
        veredicto: canon?.veredicto ?? null,
        ingreso_ajustado_cop: f.ingresoAjustadoCop,
        canon_ingreso_pct: canon?.canonIngresoPct ?? null,
      },
    },
    ip,
  });

  return armarEstado(await cargar(expedienteId), hoy);
}

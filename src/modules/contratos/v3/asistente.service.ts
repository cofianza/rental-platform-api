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

import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { PDFDocument } from 'pdf-lib';
import { env } from '@/config';
import { mergePdfs, PdfInvalidoError, validarPdfPropio, type MotivoPdfInvalido } from '@/lib/pdfMerger';
import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { assertExpedienteAccess, resolveMembershipInmobiliariaIds, resolveRolMiembro } from '@/lib/tenantScope';
import { getCalibracion, type Calibracion } from '@/lib/calibracion';
import { checkPerfilCompletitud } from '@/modules/perfil-arrendador/perfil-arrendador.service';
import { tarifasDelEstudio } from '@/modules/estudios/tarifa-override.service';
import { ESTADOS_VINCULADO } from '@/modules/estudios/coarrendatario-vinculado';
import { avisarCandidatosDeReserva, cancelarVisitasDeOtros } from '@/modules/estudios/reserva-inmueble.notificaciones';
import {
  liberarReservaDeExpediente,
  reservarInmuebleParaContrato,
  type ReservaInmuebleResult,
} from '@/modules/inmuebles/inmuebles.service';
import type {
  AceptacionClausulas,
  ClausulaEnContrato,
  EnvioV3,
  EstadoAsistente,
  GuardarPasoBody,
  Hallazgo,
  NumeroPaso,
  Paso4,
  Paso4Entrada,
  Pasos,
} from './asistente.types';
import {
  armarDatosVivienda,
  avisoCanon,
  avisosDePendientes,
  bloqueoNoImprimible,
  bloqueosAdicionales,
  cambiosInmueble,
  evaluarBloqueos,
  evaluarCanon,
  faltantes,
  masDias,
  maximoSinNuevaEvaluacionCop,
  noImprimibles,
  prefill,
  textosPendientesPrevistos,
  type Asistente,
  type AsistenteCompleto,
  type ContratoV3,
  type DocumentoV3,
  type FilaCatalogoAdicional,
  type Fuentes,
  type PerfilArrendador,
  type PropioGuardado,
} from './asistente.reglas';
import { validarTexto } from './clausulas.ia';
import {
  AVISO_PREVALENCIA,
  AVISO_RESPONSABILIDAD,
  AVISO_VERSION,
  campos,
  huella,
  llenar,
  shaClausula,
} from './clausulas.reglas';
import type { LogoPdf } from './documento';
import { fechaBogota, mayus, ordinal, sumarMeses } from './formato';
import { APROBACIONES } from './aprobaciones';
import { contarClausulas, type Plantilla } from './motor';
import { PLANTILLA_ANEXO, PLANTILLA_VIVIENDA } from './plantilla-vivienda';
import { contexto, generarAnexoVivienda, generarContratoVivienda, type DatosVivienda } from './vivienda';
import { validarFirmantes, type ParteFirmante } from './firma/reglas';
import { actualizarFirma, crearSobre, estadoEnviado, reenviar, reintentar } from './firma/firma.service';
import { ultimoSobre } from './firma/reconciliar';

const BUCKET = 'documentos-expedientes';
const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;
const hoyBogota = () => fechaBogota(new Date());

const DESHABILITADO: EstadoAsistente = {
  habilitado: false,
  bloqueos: [],
  avisos: [],
  resumen: null,
  contrato: null,
  enviado: null,
};

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
  inmuebles: (Omit<Fuentes['inmueble'], 'valorArriendoCop' | 'inmobiliaria_id' | 'administracionCop'> & {
    inmobiliaria_id: string | null;
    valor_arriendo: number | string;
    administracion: number | string | null;
  }) | null;
  solicitantes: Fuentes['solicitante'] | null;
}

interface Cargadas {
  f: Fuentes;
  cal: Calibracion;
  /** Filas del catálogo de las adicionales del paso 4 guardado (vacío si no hay). */
  catalogo: FilaCatalogoAdicional[];
}

type Paso4ConClausulas = Extract<Paso4, { clausulas: unknown }>;
const clausulasDe = (p4: Paso4 | undefined): ClausulaEnContrato[] => (p4 && 'clausulas' in p4 ? p4.clausulas : []);

/** null = el asistente no aplica a este estudio (inmueble sin inmobiliaria, D5). */
export async function cargarFuentes(expedienteId: string): Promise<Cargadas | null> {
  const exp = dato<FilaExpediente | null>(
    await db('expedientes')
      .select(
        `id, numero, estado, duracion_contrato_meses, fecha_inicio_contrato,
        inmuebles!expedientes_inmueble_id_fkey(
          id, codigo, direccion, ciudad, uso, estado, reservado_por_expediente_id,
          inmobiliaria_id, valor_arriendo, propiedad_horizontal, parqueadero, cuarto_util,
          nombre_copropiedad, parqueadero_numero, parqueadero_moto, parqueadero_moto_numero,
          cuarto_util_numero, administracion
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
      .select('id, nombre, apellido, tipo_documento, numero_documento, email, telefono, estado, estudio_id, direccion, municipio')
      .eq('expediente_id', expedienteId)
      .in('estado', ESTADOS_VINCULADO)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db('inmobiliarias').select('owner_perfil_id, modalidad_fianza_defecto').eq('id', inm.inmobiliaria_id).maybeSingle(),
    // Los cancelados también: el último V3 cancelado precarga el borrador nuevo.
    db('contratos')
      .select(CONTRATO_V3_SELECT)
      .eq('expediente_id', expedienteId)
      .neq('estado', 'finalizado'),
    getCalibracion(),
  ]);
  const est = dato<{ id: string; resultado: string | null; fecha_completado: string | null; canon_evaluado: unknown } | null>(
    estR,
    expedienteId,
    'estudio',
  );
  const coa = dato<Omit<NonNullable<Fuentes['coarrendatario']>, 'estudio'> | null>(coaR, expedienteId, 'coarrendatario');
  const org = dato<{ owner_perfil_id: string; modalidad_fianza_defecto: Fuentes['modalidadFianzaDefecto'] } | null>(
    orgR,
    expedienteId,
    'inmobiliaria',
  );
  const filas = dato<(ContratoV3 & { destinacion: string | null })[] | null>(contratosR, expedienteId, 'contratos') ?? [];
  const contratos = filas.filter((c) => c.estado !== 'cancelado');
  if (!org) throw noVerificable(expedienteId, 'inmobiliaria sin titular');
  const ownerId = org.owner_perfil_id;
  const v3 = contratos.find((c) => c.destinacion) ?? null;
  const idsAdicionales = clausulasDe(v3?.datos_variables?.asistente?.paso4).map((c) => c.clausulaId);

  const [crcR, tarifa, sombraR, coaEstR, perfilR, completitud, catalogoR] = await Promise.all([
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
    // Entrega 4: el estado vigente de las adicionales guardadas (inhabilitada, versión nueva).
    idsAdicionales.length
      ? db('clausulas_adicionales').select('id, estado, version, inhabilitada_motivo').in('id', idsAdicionales)
      : null,
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
    inmueble: {
      ...inm,
      inmobiliaria_id: inm.inmobiliaria_id,
      valorArriendoCop: Number(inm.valor_arriendo),
      administracionCop: monto(inm.administracion),
    },
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
    modalidadFianzaDefecto: org.modalidad_fianza_defecto ?? null,
    completitudFaltantes: completitud.faltantes.map((x) => x.etiqueta),
    legacyVivos: contratos.filter((c) => !c.destinacion).length,
    v3,
    anterior: v3
      ? null
      : (filas
          .filter((c) => c.estado === 'cancelado' && c.destinacion)
          .sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0]?.datos_variables?.asistente ?? null),
  };
  const catalogo = dato<FilaCatalogoAdicional[] | null>(catalogoR, expedienteId, 'cláusulas adicionales') ?? [];
  return { f, cal, catalogo };
}

// ── Estado (GET y respuesta de toda acción) ──

const pasosDe = (a: Asistente): Partial<Pasos> =>
  Object.fromEntries(
    ([1, 2, 3, 4, 5] as NumeroPaso[]).filter((n) => a[`paso${n}`]).map((n) => [n, a[`paso${n}`]]),
  ) as Partial<Pasos>;

/**
 * Número de la primera adicional con lo guardado hasta ahora (D1, sin huecos):
 * el coarrendatario del estudio; la comisión y la PH de los pasos 3 y 2 o, antes, del registro.
 */
const primeraAdicional = (f: Fuentes, a: Asistente) =>
  contarClausulas(PLANTILLA_VIVIENDA, {
    coa: f.coarrendatario !== null,
    comision: (a.paso3?.comisionPct ?? 0) > 0,
    ph: a.paso2?.propiedadHorizontal ?? f.inmueble.propiedad_horizontal ?? false,
  }) + 1;

const opcionesAdicionales = (f: Fuentes, cal: Calibracion) => ({
  maximo: cal.MAX_CLAUSULAS_ADICIONALES,
  sinCoarrendatario: f.coarrendatario === null,
  iaEncendida: env.CLAUSULAS_IA_ENABLED,
});

/**
 * Ids que el motor marcaría como pendientes en cada plantilla (diseño §6.c): los
 * PENDIENTE(x) (texto que todavía no existe) y los borradores sin aprobación en
 * aprobaciones.ts. Se calcula al cargar: aprobar un texto es un despliegue.
 */
const sinAprobarDe = (p: Plantilla): ReadonlySet<string> =>
  new Set([
    ...p.borradores.filter((b) => APROBACIONES[b.id]?.sha256 !== b.sha256).map((b) => b.id),
    // Los nodos PENDIENTE(x) son { t: 'pendiente', id } dentro del árbol.
    ...[...JSON.stringify(p.nodos).matchAll(/"t":"pendiente","id":"([\w-]+)"/g)].map((m) => m[1]),
  ]);
const SIN_APROBAR = { A: sinAprobarDe(PLANTILLA_VIVIENDA), B: sinAprobarDe(PLANTILLA_ANEXO) };

function armarEstado({ f, cal, catalogo }: Cargadas, hoy: string): EstadoAsistente {
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
    let datos: DatosVivienda | null = null;
    if (!bloqueos.length && !falta.length) {
      datos = armarDatosVivienda(f, a as AsistenteCompleto, hoy, f.v3.numero);
      const rutas = noImprimibles(datos);
      if (rutas.length) bloqueos.push(bloqueoNoImprimible(rutas));
    }
    // Ruta B: sin cláusulas adicionales (§4.8); un paso 4 que quedó de la A no bloquea.
    if (a.paso1?.ruta !== 'B') {
      const adic = bloqueosAdicionales(a, catalogo, opcionesAdicionales(f, cal));
      bloqueos.push(...adic.bloqueos);
      avisos.push(...adic.avisos);
    }
    const primera = primeraAdicional(f, a);
    const doc = f.v3.datos_variables?.documento;
    contrato = {
      id: f.v3.id,
      numero: f.v3.numero,
      estado: 'borrador',
      guardados: pasosDe(a),
      prefill: prefill(f, hoy, cal),
      textosPendientes: textosPendientesPrevistos(f, a, SIN_APROBAR[a.paso1?.ruta ?? 'A']),
      textosSinAprobar: { tradicional: SIN_APROBAR.A.has('b'), sinPropiedadHorizontal: SIN_APROBAR.A.has('d') },
      modalidadConvenio: f.modalidadFianzaDefecto,
      faltantes: falta,
      documento: doc
        ? {
            generacion: doc.generacion,
            generadoEn: doc.generadoEn,
            avisos: doc.avisos,
            pendientes: doc.pendientes,
            // Lo mismo que rechaza enviarAFirma: pasos guardados después, o perfil, estudio, CRC o logo distintos.
            desactualizado:
              (!!a.actualizadoEn && a.actualizadoEn > doc.generadoEn) ||
              (!!datos && difiereDeVistaPrevia(datos, doc, f.arrendador.logo_storage_key)),
          }
        : null,
      propio: propioVisible(f.v3.datos_variables?.propio),
      adicionales: {
        maximo: cal.MAX_CLAUSULAS_ADICIONALES,
        // primera ≤ 34 y 34 + 24 = 58: dentro de lo que ordinal() sabe escribir.
        ordinales: Array.from({ length: 25 }, (_, i) => mayus(ordinal(primera + i))),
        aviso: { version: AVISO_VERSION, texto: AVISO_RESPONSABILIDAD },
        prevalencia: AVISO_PREVALENCIA,
        excesoAutorizado: a.excesoAutorizado
          ? { huella: a.excesoAutorizado.huella, cantidad: a.excesoAutorizado.cantidad, en: a.excesoAutorizado.en }
          : null,
      },
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
    enviado: null,
  };
}

const propioVisible = (p: PropioGuardado | undefined): NonNullable<EstadoAsistente['contrato']>['propio'] =>
  p ? { nombre: p.nombre, paginas: p.paginas, bytes: p.bytes, sha256: p.sha256, subidoEn: p.subidoEn } : null;

/**
 * El V3 que ya salió de borrador (EN FIRMA, FIRMA INCOMPLETA, FIANZA ACTIVA o
 * TERMINADO), o null. Manda el más reciente no cancelado: si es un borrador, la
 * pantalla es el asistente. Lectura liviana: sin cargarFuentes ni
 * evaluarBloqueos (a los 61 días una fianza activa no debe mostrar "estudio vencido").
 */
async function contratoEnviado(expedienteId: string): Promise<{ id: string } | null> {
  const ultimo = dato<{ id: string; estado: string } | null>(
    await db('contratos')
      .select('id, estado')
      .eq('expediente_id', expedienteId)
      .not('destinacion', 'is', null)
      .neq('estado', 'cancelado')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    expedienteId,
    'contrato V3',
  );
  return ultimo && ultimo.estado !== 'borrador' ? { id: ultimo.id } : null;
}

const estadoDeEnviado = (enviado: EnvioV3): EstadoAsistente => ({ ...DESHABILITADO, habilitado: true, enviado });

/** Fuentes de un estudio con asistente, o 404 si no aplica. Sin verificar acceso: lo hace el caller. */
async function cargar(expedienteId: string): Promise<Cargadas> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  const c = await cargarFuentes(expedienteId);
  if (!c) throw noHabilitado();
  return c;
}

/**
 * GET: sin efectos. El flag frena lo nuevo (iniciar, editar, generar, enviar),
 * no a los contratos que ya salieron: apagarlo de emergencia no deja sin
 * pantalla (firma, cancelar, terminar, acta) a uno en firma o con fianza
 * activa. Solo la pantalla del asistente lo llama.
 */
export async function obtenerEstado(
  expedienteId: string,
  userId: string,
  userRol: string,
): Promise<EstadoAsistente> {
  await assertExpedienteAccess(expedienteId, userId, userRol);
  const enviado = await contratoEnviado(expedienteId);
  const vista = enviado && (await estadoEnviado(enviado.id));
  if (vista) return estadoDeEnviado(vista);
  if (!env.CONTRATOS_V3_ENABLED) return DESHABILITADO;
  const c = await cargarFuentes(expedienteId);
  return c ? armarEstado(c, hoyBogota()) : DESHABILITADO;
}

function avisarAfectados(reserva: ReservaInmuebleResult, expedienteId: string) {
  // Las visitas de los demás (también de quien solo pidió visita) se cancelan al reservar.
  if (reserva.reservado && reserva.inmueble_id) void cancelarVisitasDeOtros(reserva.inmueble_id, expedienteId);
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
  // Ya salió de borrador (en firma, activo o terminado): un estudio, un contrato.
  if (await contratoEnviado(expedienteId))
    throw AppError.conflict('Este estudio ya tiene su contrato; no se puede iniciar otro.', 'CONTRATO_YA_EXISTE');
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

// ── Entrega 4: paso 4 con cláusulas adicionales (§5.3) ──

interface FilaClausula {
  id: string;
  inmobiliaria_id: string | null;
  titulo: string;
  texto: string;
  version: number;
  estado: string;
  validacion: { reglas: string; ia: ClausulaEnContrato['ia'] } | null;
}

/**
 * Quién (D5), el aviso vigente, que cada cláusula siga disponible para la org
 * del contrato, sus [[campos]] y las reglas (y la IA, si está encendida) sobre
 * el texto FINAL. Devuelve el Paso4 a guardar; ninguna falla escribe nada.
 * Pasar el máximo no impide guardar: queda como bloqueo (D6).
 */
async function prepararPaso4(
  f: Fuentes,
  e: Extract<Paso4Entrada, { clausulas: unknown }>,
  u: { id: string; rol: string; email: string; ip?: string },
): Promise<Paso4ConClausulas> {
  const exp = f.expediente.id;
  const org = f.inmueble.inmobiliaria_id;
  // El aviso compromete a la org del contrato: entrar por propietario_id o como responsable no basta.
  if (u.rol !== 'inmobiliaria' || !(await resolveMembershipInmobiliariaIds(u.id)).includes(org))
    throw AppError.forbidden(
      'Las cláusulas adicionales las incorpora y acepta un miembro de la inmobiliaria del contrato.',
      'CLAUSULAS_SOLO_INMOBILIARIA',
    );
  if (e.avisoVersion !== AVISO_VERSION)
    throw AppError.conflict('El aviso de responsabilidad cambió. Léelo de nuevo y acéptalo.', 'AVISO_CAMBIADO');

  const ids = e.clausulas.map((c) => c.clausulaId);
  const [filasR, perfilR, rolMiembro] = await Promise.all([
    db('clausulas_adicionales').select('id, inmobiliaria_id, titulo, texto, version, estado, validacion').in('id', ids),
    db('perfiles').select('nombre, apellido').eq('id', u.id).maybeSingle(),
    resolveRolMiembro(u.id),
  ]);
  const filas = dato<FilaClausula[] | null>(filasR, exp, 'cláusulas adicionales') ?? [];
  const perfil = dato<{ nombre: string | null; apellido: string | null } | null>(perfilR, exp, 'perfil de quien acepta');
  const anteriores = clausulasDe(f.v3?.datos_variables?.asistente?.paso4);

  const clausulas: ClausulaEnContrato[] = [];
  const hallazgos: Hallazgo[] = [];
  const avisos: Hallazgo[] = [];
  const bloqueadas: string[] = [];
  for (const [indice, item] of e.clausulas.entries()) {
    const fila = filas.find((x) => x.id === item.clausulaId);
    // Sin el título: el id pudo venir de otra org.
    if (!fila || fila.estado !== 'activa' || (fila.inmobiliaria_id !== null && fila.inmobiliaria_id !== org))
      throw new AppError(
        422,
        'CLAUSULA_NO_DISPONIBLE',
        'Una de las cláusulas elegidas ya no está disponible. Quítala del contrato.',
        { indice },
      );
    const origen = fila.inmobiliaria_id ? 'propia' : 'biblioteca';
    // Solo la biblioteca lleva [[campos]]; una propia no puede traer valores.
    const nombres = origen === 'biblioteca' ? campos(fila.texto) : [];
    const valores = item.valores ?? {};
    const faltan = nombres.filter((n) => !Object.hasOwn(valores, n));
    const sobran = Object.keys(valores).filter((n) => !nombres.includes(n));
    if (faltan.length || sobran.length)
      throw new AppError(
        422,
        'CLAUSULA_CAMPOS',
        faltan.length
          ? `Completa los datos de la cláusula «${fila.titulo}»: ${faltan.join(', ')}.`
          : `La cláusula «${fila.titulo}» no lleva estos datos: ${sobran.join(', ')}.`,
        { indice },
      );
    const c = { titulo: fila.titulo, texto: llenar(fila.texto, valores) };
    if (c.texto.length > 4000)
      throw new AppError(422, 'CLAUSULA_CAMPOS', 'Con los datos, el texto supera 4.000 caracteres; acórtalos.', {
        indice,
      });

    // Veredicto IA reutilizable: el de este mismo texto en el paso 4 anterior o en el catálogo.
    // ponytail: en serie; con la IA encendida, n cláusulas de biblioteca con datos nuevos son n
    // llamadas seguidas (hasta ~50 s cada una). Paralelizar con un límite si llega a pesar.
    const sha = shaClausula(c);
    const iaPrevia =
      [anteriores.find((x) => x.clausulaId === fila.id)?.ia, fila.validacion?.ia].find((x) => x?.sha256 === sha) ?? null;
    const r = await validarTexto(c, {
      destinacion: 'vivienda',
      sinCoarrendatario: f.coarrendatario === null,
      conIA: origen === 'propia' || nombres.length > 0,
      iaPrevia,
    });
    if (r.hallazgos.length) bloqueadas.push(sha);
    hallazgos.push(...r.hallazgos.map((h) => ({ ...h, indice })));
    avisos.push(...r.avisos.map((h) => ({ ...h, indice })));
    clausulas.push({
      clausulaId: fila.id,
      origen,
      version: fila.version,
      ...c,
      valores: nombres.length ? valores : null,
      ia: r.ia,
    });
  }
  if (hallazgos.length) {
    // Para afinar las reglas: códigos y sha256, nunca el texto.
    logger.info(
      { expedienteId: exp, codigos: hallazgos.map((h) => h.codigo), sha256: bloqueadas },
      'Paso 4: cláusula adicional bloqueada',
    );
    throw new AppError(422, 'CLAUSULA_NO_PERMITIDA', hallazgos[0].mensaje, { hallazgos, avisos });
  }

  if (!perfil) throw noVerificable(exp, 'perfil de quien acepta');
  const aceptacion: AceptacionClausulas = {
    usuarioId: u.id,
    nombre: `${perfil.nombre ?? ''} ${perfil.apellido ?? ''}`.trim(),
    email: u.email,
    rolMiembro,
    en: new Date().toISOString(),
    ip: u.ip ?? null,
    avisoVersion: e.avisoVersion,
  };
  return { clausulas, huella: huella(clausulas), aceptacion };
}

export async function guardarPaso(
  expedienteId: string,
  body: GuardarPasoBody,
  userId: string,
  userRol: string,
  ip?: string,
  email = '',
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
  // { omitir: true } se guarda como siempre, para cualquier rol con contratos:create.
  const paso4 =
    body.paso === 4 && 'clausulas' in body.datos
      ? await prepararPaso4(c.f, body.datos, { id: userId, rol: userRol, email, ip })
      : null;

  const dv = v3.datos_variables ?? {};
  // Volver a guardar lo mismo (p. ej. «Guardar y continuar» al repasar un paso)
  // no deja desactualizada la vista previa. Por JSON: el jsonb no guarda los
  // undefined ni el orden de las claves. El paso 4 con cláusulas siempre
  // cambia (la aceptación lleva hora).
  const igual =
    !paso4 && isDeepStrictEqual(JSON.parse(JSON.stringify(body.datos)), dv.asistente?.[`paso${body.paso}`]);
  const asistente: Asistente = {
    ...dv.asistente,
    [`paso${body.paso}`]: paso4 ?? body.datos,
    actualizadoEn: igual ? dv.asistente?.actualizadoEn : new Date().toISOString(),
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

  if (paso4)
    logAudit({
      usuarioId: userId,
      accion: AUDIT_ACTIONS.CONTRATO_CLAUSULAS_ACEPTADAS,
      entidad: AUDIT_ENTITIES.CONTRATO,
      entidadId: v3.id,
      detalle: {
        expediente_id: expedienteId,
        huella: paso4.huella,
        clausulas: paso4.clausulas.map((x) => ({ id: x.clausulaId, version: x.version, origen: x.origen })),
        aviso_version: paso4.aceptacion.avisoVersion,
        email,
      },
      ip,
    });

  // §1.4: lo que se confirma del inmueble (PH, copropiedad, usos conexos, cuota)
  // se guarda también en su registro, no solo en el contrato. Si falla, el paso
  // ya quedó guardado y se avisa: volver a guardar reintenta la escritura.
  const cambios = body.paso === 2 || body.paso === 3 ? cambiosInmueble(c.f.inmueble, body) : null;
  if (cambios) {
    const { error: inmError } = await db('inmuebles').update(cambios as never).eq('id', c.f.inmueble.id);
    if (inmError) {
      logger.error({ expedienteId, error: inmError.message }, 'Asistente V3: no se actualizó el registro del inmueble');
      throw new AppError(
        503,
        'INMUEBLE_NO_ACTUALIZADO',
        'Guardamos el paso, pero no pudimos actualizar la ficha del inmueble. Vuelve a guardar.',
      );
    }
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

/**
 * Lo que Auco no acepta de los firmantes (celular o correo repetido entre
 * partes, o inválido). Se revisa al generar, para que no aparezca recién al
 * enviar, después de revisar la vista previa, y otra vez al enviar.
 */
function assertFirmantes(contratoId: string, d: DatosVivienda, f: Fuentes) {
  const fallas = validarFirmantes(
    partes(contratoId, d, f).map((p, i) => ({ id: String(i), ...p }) as unknown as ParteFirmante),
  );
  if (fallas.length)
    throw new AppError(422, 'FIRMANTES_INVALIDOS', `${fallas[0].motivo} (${fallas[0].rol})`, { fallas });
}

/**
 * Reescribe las partes y el registro de adicionales del contrato (lo que se
 * firma tiene que ser exactamente lo registrado, §5.4.1). Solo con el contrato
 * en borrador: el trigger de partes lo exige. Devuelve el error, si hubo.
 * ponytail: borrar + insertar no es atómico; un fallo se realinea en el
 * próximo generar o enviar (crearSobre verifica que las partes estén completas).
 */
async function escribirPartesYRegistro(
  contratoId: string,
  d: DatosVivienda,
  f: Fuentes,
  adicionales: ClausulaEnContrato[],
  primera: number,
): Promise<{ message: string } | null> {
  const del = await db('contrato_partes').delete().eq('contrato_id', contratoId);
  if (del.error) return del.error;
  const ins = await db('contrato_partes').insert(partes(contratoId, d, f) as never);
  if (ins.error) return ins.error;
  // Registro pasivo (D3): la versión y el texto exactos que imprimió ESTE contrato.
  const reg = await db('contrato_clausulas_adicionales').delete().eq('contrato_id', contratoId);
  if (reg.error || !adicionales.length) return reg.error;
  const filas = adicionales.map((x, k) => ({
    contrato_id: contratoId,
    clausula_id: x.clausulaId,
    orden: k + 1,
    numero: primera + k,
    version: x.version,
    origen: x.origen,
    titulo: x.titulo,
    texto: x.texto,
  }));
  return (await db('contrato_clausulas_adicionales').insert(filas as never)).error;
}

const nombreBorrador = (numero: string, ruta: 'A' | 'B') =>
  ruta === 'B' ? `${numero}-anexo-borrador.pdf` : `${numero}-borrador.pdf`;

export async function generarVistaPrevia(
  expedienteId: string,
  userId: string,
  userRol: string,
  ip?: string,
): Promise<EstadoAsistente> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  await assertExpedienteAccess(expedienteId, userId, userRol);
  const c = await cargar(expedienteId);
  const { f, cal, catalogo } = c;
  const v3 = borradorEditable(f);
  const hoy = hoyBogota();

  // Idempotente para el titular: cura una reserva perdida; si reserva de nuevo, avisa.
  avisarAfectados(await reservarInmuebleParaContrato(expedienteId), expedienteId);

  const dv = v3.datos_variables ?? {};
  const a: Asistente = dv.asistente ?? {};
  const bloqueos = evaluarBloqueos(f, hoy, cal);
  const canon = a.paso1 ? evaluarCanon(f, a.paso1.canonCop, cal) : null;
  if (canon?.bloqueo) bloqueos.push(canon.bloqueo);
  // Generar nunca llama a la IA: con el flag encendido, bloquea la cláusula sin veredicto vigente.
  if (a.paso1?.ruta !== 'B') bloqueos.push(...bloqueosAdicionales(a, catalogo, opcionesAdicionales(f, cal)).bloqueos);
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
  assertFirmantes(v3.id, d, f);

  // Ruta A: el contrato de Cofianza con sus adicionales. Ruta B: el Anexo de
  // Condiciones (el contrato de la inmobiliaria no se genera ni se toca, §4.4).
  const ruta = completo.paso1.ruta;
  const p4 = ruta === 'A' ? completo.paso4 : undefined;
  const adicionales = clausulasDe(p4);
  const ctx = contexto(d);
  // La misma cuenta que hace el motor al numerar (vivienda.test la fija contra lo impreso).
  const primera = contarClausulas(PLANTILLA_VIVIENDA, ctx.condiciones) + 1;

  const logoStorageKey = f.arrendador.logo_storage_key;
  const logoInmobiliaria = await leerLogo(logoStorageKey);
  // PLANTILLA_* (400/422/500) pasan tal cual.
  const r =
    ruta === 'B'
      ? await generarAnexoVivienda(d, { modo: 'revision', logoInmobiliaria })
      : await generarContratoVivienda(d, {
          modo: 'revision',
          logoInmobiliaria,
          adicionales: adicionales.map(({ titulo, texto }) => ({ titulo, texto })),
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
  const valores = ctx.valores;
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
    adicionales: p4 && 'clausulas' in p4 ? { huella: p4.huella, aceptacion: p4.aceptacion, primera } : null,
  };

  const { data, error } = await db('contratos')
    .update({
      valor_arriendo: completo.paso1.canonCop,
      fecha_inicio: completo.paso3.fechaInicio,
      fecha_fin: sumarMeses(completo.paso3.fechaInicio, completo.paso3.vigenciaMeses),
      duracion_meses: completo.paso3.vigenciaMeses,
      storage_key: key,
      nombre_archivo: nombreBorrador(v3.numero, ruta),
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

  const partesError = await escribirPartesYRegistro(v3.id, d, f, adicionales, primera);

  if (v3.storage_key && v3.storage_key !== key) {
    const { error: rmError } = await supabase.storage.from(BUCKET).remove([v3.storage_key]);
    if (rmError) logger.warn({ expedienteId, key: v3.storage_key }, 'Asistente V3: no se borro la vista previa anterior');
  }

  if (partesError) {
    logger.error(
      { expedienteId, error: partesError.message },
      'Asistente V3: no se guardaron las partes o el registro de cláusulas',
    );
    throw new AppError(
      500,
      'CONTRATO_PARTES_NO_GUARDADAS',
      'La vista previa quedó generada, pero no se guardaron las partes o el registro de cláusulas. Vuelve a generarla.',
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

// ── Entrega 4: autorizar más adicionales que el máximo (D6) ──

/**
 * Un administrador autoriza el conjunto EXACTO (huella) que la inmobiliaria
 * pidió revisar por Soporte. Cualquier cambio de la lista cambia la huella y
 * el bloqueo vuelve. No toca actualizadoEn: la vista previa no queda desactualizada.
 */
export async function autorizarExceso(
  expedienteId: string,
  huellaPedida: string,
  userId: string,
  userRol: string,
  ip?: string,
): Promise<EstadoAsistente> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  await assertExpedienteAccess(expedienteId, userId, userRol);
  const c = await cargar(expedienteId);
  const v3 = borradorEditable(c.f);
  const dv = v3.datos_variables ?? {};
  const a: Asistente = dv.asistente ?? {};
  const p4 = a.paso4;
  const noAplica = () =>
    AppError.conflict('Este contrato no supera el máximo de cláusulas adicionales.', 'EXCESO_NO_APLICA');
  if (!p4 || !('clausulas' in p4)) throw noAplica();
  if (p4.huella !== huellaPedida) throw borradorCambiado();
  const cantidad = p4.clausulas.length;
  if (cantidad <= c.cal.MAX_CLAUSULAS_ADICIONALES) throw noAplica();

  const excesoAutorizado = { huella: p4.huella, cantidad, usuarioId: userId, en: new Date().toISOString() };
  const { data, error } = await db('contratos')
    .update({ datos_variables: { ...dv, asistente: { ...a, excesoAutorizado } } } as never)
    .eq('id', v3.id)
    .eq('estado', 'borrador')
    .eq('updated_at', v3.updated_at)
    .select('id');
  if (error) {
    logger.error({ expedienteId, error: error.message }, 'Asistente V3: no se pudo autorizar el exceso de cláusulas');
    throw new AppError(500, 'CONTRATO_GUARDAR_ERROR', 'No se pudo guardar la autorización. Intenta de nuevo.');
  }
  if (!(data as unknown[] | null)?.length) throw borradorCambiado();

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_CLAUSULAS_EXCESO_AUTORIZADO,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: v3.id,
    detalle: { expediente_id: expedienteId, huella: p4.huella, cantidad, maximo: c.cal.MAX_CLAUSULAS_ADICIONALES },
    ip,
  });
  return armarEstado(await cargar(expedienteId), hoyBogota());
}

// ── Entrega 5: Ruta B — el contrato propio de la inmobiliaria (§4.4-4.5) ──

/** Topes del PDF propio. ponytail: hasta medir con la sonda cuánto base64 acepta Auco. */
const MAX_BYTES_PROPIO = 6 * 1024 * 1024;
const MAX_PAGINAS_PROPIO = 60;
/** Tope del PDF unido que va a Auco (propio + Anexo + CRC). Mismo ponytail. */
const MAX_BYTES_SOBRE = 8 * 1024 * 1024;

const MOTIVO_PDF: Record<MotivoPdfInvalido, string> = {
  peso: 'El PDF pesa más de 6 MB. Redúcelo (por ejemplo, imprimiéndolo de nuevo a PDF) y súbelo otra vez.',
  no_es_pdf: 'El archivo no es un PDF.',
  protegido: 'El PDF está protegido con contraseña. Súbelo sin contraseña.',
  danado: 'El PDF está dañado o no se puede leer. Genéralo de nuevo y vuelve a subirlo.',
  paginas: `El PDF debe tener entre 1 y ${MAX_PAGINAS_PROPIO} páginas.`,
  formulario: 'El PDF tiene campos de formulario editables. Imprímelo a PDF (sin campos) y súbelo de nuevo.',
  activo: 'El PDF tiene contenido activo (JavaScript o acciones automáticas). Imprímelo a PDF y súbelo de nuevo.',
};

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function bajar(key: string, que: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(BUCKET).download(key);
  if (error || !data) {
    logger.error({ key, error: error?.message }, `Asistente V3: no se pudo leer ${que}`);
    throw new AppError(503, 'LECTURA_NO_VERIFICABLE', `No pudimos leer ${que}. Intenta de nuevo en un momento.`);
  }
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Carga (o reemplaza) el contrato propio de la Ruta B. No se modifica ni una
 * coma (§4.4): se valida que se pueda unir tal cual al Anexo y se guarda con su
 * sha256. No toca `actualizadoEn`: el Anexo no depende del PDF propio.
 */
export async function cargarPropio(
  expedienteId: string,
  archivo: { buffer: Buffer; originalname: string } | undefined,
  userId: string,
  userRol: string,
): Promise<EstadoAsistente> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  await assertExpedienteAccess(expedienteId, userId, userRol);
  const c = await cargar(expedienteId);
  const v3 = borradorEditable(c.f);
  const dv = v3.datos_variables ?? {};
  if (dv.asistente?.paso1?.ruta !== 'B')
    throw AppError.conflict('El contrato propio solo se carga en la Ruta B.', 'RUTA_NO_ES_B');
  if (!archivo?.buffer?.length) throw AppError.badRequest('Adjunta el PDF del contrato.', 'ARCHIVO_REQUERIDO');

  let info: { paginas: number; bytes: number };
  try {
    info = await validarPdfPropio(archivo.buffer, { maxBytes: MAX_BYTES_PROPIO, maxPaginas: MAX_PAGINAS_PROPIO });
  } catch (e) {
    if (e instanceof PdfInvalidoError)
      throw new AppError(422, 'PDF_PROPIO_INVALIDO', MOTIVO_PDF[e.motivo], { motivo: e.motivo });
    throw e;
  }

  const key = `contratos/${expedienteId}/${v3.id}/propio-${Date.now()}.pdf`;
  const { error: upError } = await supabase.storage
    .from(BUCKET)
    .upload(key, archivo.buffer, { contentType: 'application/pdf', upsert: false });
  if (upError) {
    logger.error({ expedienteId, key, error: upError.message }, 'Asistente V3: no se pudo subir el contrato propio');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al almacenar el PDF');
  }
  const propio: PropioGuardado = {
    key,
    nombre: archivo.originalname.slice(0, 200),
    ...info,
    sha256: sha256(archivo.buffer),
    subidoEn: new Date().toISOString(),
    subidoPor: userId,
  };
  const { data, error } = await db('contratos')
    .update({ datos_variables: { ...dv, propio } } as never)
    .eq('id', v3.id)
    .eq('estado', 'borrador')
    .eq('updated_at', v3.updated_at)
    .select('id');
  if (error || !(data as unknown[] | null)?.length) {
    await supabase.storage.from(BUCKET).remove([key]);
    if (error) {
      logger.error({ expedienteId, error: error.message }, 'Asistente V3: no se pudo guardar el contrato propio');
      throw new AppError(500, 'CONTRATO_GUARDAR_ERROR', 'No se pudo guardar el PDF. Intenta de nuevo.');
    }
    throw borradorCambiado();
  }
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_GENERATED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: v3.id,
    detalle: {
      expediente_id: expedienteId,
      v3: true,
      fase: 'contrato_propio',
      nombre: propio.nombre,
      sha256: propio.sha256,
      bytes: propio.bytes,
      paginas: propio.paginas,
      reemplaza: dv.propio?.sha256 ?? null,
    },
  });
  if (dv.propio?.key) await supabase.storage.from(BUCKET).remove([dv.propio.key]);
  return armarEstado(await cargar(expedienteId), hoyBogota());
}

/** URL firmada (10 min) de un PDF del contrato V3 vivo, en cualquier estado (solo lectura, también con el flag apagado). null = no hay. */
async function urlDelContrato(
  expedienteId: string,
  userId: string,
  userRol: string,
  cual: (dv: { propio?: PropioGuardado; documento?: DocumentoV3 }) => string | null | undefined,
): Promise<string | null> {
  await assertExpedienteAccess(expedienteId, userId, userRol);
  // El más reciente no cancelado: también el TERMINADO (sus documentos se siguen viendo).
  const r = await db('contratos')
    .select('datos_variables')
    .eq('expediente_id', expedienteId)
    .not('destinacion', 'is', null)
    .neq('estado', 'cancelado')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const fila = dato<{ datos_variables: { propio?: PropioGuardado; documento?: DocumentoV3 } | null } | null>(r, expedienteId, 'contrato V3');
  const key = fila?.datos_variables ? cual(fila.datos_variables) : null;
  if (!key) return null;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(key, 600);
  if (error || !data?.signedUrl) throw new AppError(500, 'STORAGE_ERROR', 'No se pudo abrir el PDF.');
  return data.signedUrl;
}

/** El contrato propio de la inmobiliaria (Ruta B). */
export async function propioUrl(expedienteId: string, userId: string, userRol: string): Promise<{ url: string }> {
  const url = await urlDelContrato(expedienteId, userId, userRol, (dv) => dv.propio?.key);
  if (!url) throw AppError.notFound('Este contrato no tiene un contrato propio cargado.', 'SIN_CONTRATO_PROPIO');
  return { url };
}

/**
 * El CRC que se envió a firma (congelado en documento.final). null en borrador:
 * ahí vale el del estudio vigente, que es el que se adjuntaría.
 */
export async function crcUrl(expedienteId: string, userId: string, userRol: string): Promise<{ url: string | null }> {
  return { url: await urlDelContrato(expedienteId, userId, userRol, (dv) => dv.documento?.final?.crcKey) };
}

// ── Entrega 5: enviar a firma (§3 del diseño, V3 §8.7.5 y §10) ──

/** Lo que se firma es lo que se revisó: los datos de hoy, salvo la fecha, deben ser los de la vista previa. */
function difiereDeVistaPrevia(d: DatosVivienda, doc: DocumentoV3, logo: string | null | undefined): boolean {
  const sinFecha = (x: DatosVivienda) => JSON.parse(JSON.stringify({ ...x, fechaDocumento: null })) as unknown;
  return !isDeepStrictEqual(sinFecha(d), sinFecha(doc.entrada)) || (logo ?? null) !== (doc.logoStorageKey ?? null);
}

async function paginasDe(pdf: Buffer): Promise<number> {
  return (await PDFDocument.load(pdf)).getPageCount();
}

/**
 * Saca el contrato de borrador y lo manda a Auco. Lo que se firma es lo que se
 * revisó: se exige la vista previa vigente (misma generación y mismos datos,
 * salvo la fecha) y, en la Ruta B, el mismo PDF propio (sha256).
 *
 * Orden (el congelamiento de V3 no revisa el UPDATE que saca la fila de
 * borrador, así que todo lo que queda congelado se escribe ahí):
 *   1. compuertas de generar + vista previa vigente + firmantes válidos;
 *   2. render FINAL (sin marca de agua, con anclas de firma) y PDF unido
 *      (Ruta A: contrato + CRC; Ruta B: propio intacto + Anexo + CRC);
 *   3. partes y registro de adicionales (en borrador: el trigger lo exige);
 *   4. un UPDATE con CAS: borrador → pendiente_firma + storage_key + documento.final;
 *   5. el sobre en Auco (o la verificación de identidad, si está encendida).
 * Si 5 falla, vuelve a borrador con su vista previa (salvo que el sobre sí haya salido).
 */
export async function enviarAFirma(
  expedienteId: string,
  body: { generacion: number; propioSha256?: string },
  userId: string,
  userRol: string,
  ip?: string,
): Promise<EstadoAsistente> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  await assertExpedienteAccess(expedienteId, userId, userRol);
  const c = await cargar(expedienteId);
  const { f, cal, catalogo } = c;
  const v3 = borradorEditable(f);
  const hoy = hoyBogota();
  const dv = v3.datos_variables ?? {};
  const a: Asistente = dv.asistente ?? {};
  const ruta = a.paso1?.ruta ?? 'A';

  // 1. Las mismas compuertas que generar.
  const bloqueos = evaluarBloqueos(f, hoy, cal);
  const canon = a.paso1 ? evaluarCanon(f, a.paso1.canonCop, cal) : null;
  if (canon?.bloqueo) bloqueos.push(canon.bloqueo);
  if (ruta === 'A') bloqueos.push(...bloqueosAdicionales(a, catalogo, opcionesAdicionales(f, cal)).bloqueos);
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

  const doc = dv.documento;
  if (!doc) throw AppError.conflict('Genera la vista previa antes de enviar a firma.', 'VISTA_PREVIA_REQUERIDA');
  const desactualizada = () =>
    AppError.conflict(
      'Cambiaron datos del contrato, del perfil, del estudio o del CRC después de la vista previa. Genérala de nuevo y revísala.',
      'VISTA_PREVIA_DESACTUALIZADA',
    );
  if ((a.actualizadoEn && a.actualizadoEn > doc.generadoEn) || doc.generacion !== body.generacion) throw desactualizada();
  if (doc.pendientes.length)
    throw new AppError(409, 'TEXTOS_PENDIENTES', 'El contrato tiene textos pendientes de aprobación de Cofianza.', {
      avisos: doc.avisos,
    });
  if (difiereDeVistaPrevia(d, doc, f.arrendador.logo_storage_key)) throw desactualizada();

  assertFirmantes(v3.id, d, f);
  const crcKey = f.crc?.pdf_storage_key;
  if (!crcKey) throw AppError.conflict('El estudio no tiene el PDF del CRC emitido.', 'CRC_NO_EMITIDO');
  const propio = dv.propio;
  if (ruta === 'B') {
    if (!propio) throw AppError.conflict('Carga el contrato de la inmobiliaria en PDF.', 'CONTRATO_PROPIO_REQUERIDO');
    if (body.propioSha256 !== propio.sha256)
      throw AppError.conflict('El contrato cargado cambió. Revísalo de nuevo antes de enviar.', 'PDF_PROPIO_ALTERADO');
  }

  // 2. Render final y PDF unido.
  const logoInmobiliaria = await leerLogo(f.arrendador.logo_storage_key);
  const adicionales = ruta === 'A' ? clausulasDe(completo.paso4) : [];
  let final: { pdf: Buffer };
  try {
    final =
      ruta === 'B'
        ? await generarAnexoVivienda(d, { modo: 'final', logoInmobiliaria, anclas: true })
        : await generarContratoVivienda(d, {
            modo: 'final',
            logoInmobiliaria,
            adicionales: adicionales.map(({ titulo, texto }) => ({ titulo, texto })),
            anclas: true,
          });
  } catch (e) {
    const pend = e instanceof AppError && e.errorCode === 'PLANTILLA_TEXTO_PENDIENTE'
      ? ((e.details as { pendientes?: { id: string }[] } | undefined)?.pendientes ?? [])
      : null;
    // Con la vista previa sin pendientes, lo único que cambia al enviar es la fecha (§ k-dia1).
    if (pend?.length && pend.every((x) => x.id === 'k-dia1'))
      throw AppError.conflict(
        'Hoy es día 1.º y la redacción de esa fecha está pendiente de aprobación de Cofianza. Envíalo a partir de mañana.',
        'ENVIO_DIA_1',
      );
    throw e;
  }
  const crcPdf = await bajar(crcKey, 'el PDF del CRC');
  let piezas: Buffer[] = [final.pdf, crcPdf];
  if (ruta === 'B') {
    const propioPdf = await bajar(propio!.key, 'el contrato de la inmobiliaria');
    if (sha256(propioPdf) !== propio!.sha256)
      throw AppError.conflict('El contrato cargado cambió. Revísalo de nuevo antes de enviar.', 'PDF_PROPIO_ALTERADO');
    piezas = [propioPdf, final.pdf, crcPdf];
  }
  const unido = await mergePdfs(piezas, { estricto: true });
  if (unido.length > MAX_BYTES_SOBRE)
    throw new AppError(413, 'PDF_SOBRE_DEMASIADO_GRANDE', 'El documento para firmar supera 8 MB. Reduce el PDF de la inmobiliaria.');
  const paginas = await Promise.all(piezas.map(paginasDe));
  const keyFinal = `contratos/${expedienteId}/${v3.id}/final-${Date.now()}.pdf`;
  const { error: upError } = await supabase.storage
    .from(BUCKET)
    .upload(keyFinal, unido, { contentType: 'application/pdf', upsert: false });
  if (upError) {
    logger.error({ expedienteId, error: upError.message }, 'Asistente V3: no se pudo subir el documento final');
    throw new AppError(500, 'STORAGE_ERROR', 'Error al almacenar el PDF');
  }
  const quitarFinal = () => supabase.storage.from(BUCKET).remove([keyFinal]).then(() => undefined);

  // 3. Partes y registro, todavía en borrador.
  const primera = contarClausulas(PLANTILLA_VIVIENDA, contexto(d).condiciones) + 1;
  const partesError = await escribirPartesYRegistro(v3.id, d, f, adicionales, primera);
  if (partesError) {
    await quitarFinal();
    logger.error({ expedienteId, error: partesError.message }, 'Asistente V3: no se guardaron las partes al enviar');
    throw new AppError(500, 'CONTRATO_PARTES_NO_GUARDADAS', 'No se guardaron las partes del contrato. Intenta de nuevo.');
  }

  // 4. Fuera de borrador, en un solo UPDATE con CAS.
  const ahora = new Date().toISOString();
  const documento: DocumentoV3 = {
    ...doc,
    final: { ruta, sha256: sha256(unido), bytes: unido.length, paginas, crcKey, propioKey: propio?.key ?? null, fechaDocumento: hoy },
  };
  const { data, error } = await db('contratos')
    .update({
      estado: 'pendiente_firma',
      storage_key: keyFinal,
      nombre_archivo: `${v3.numero}-para-firma.pdf`,
      fecha_generacion: ahora,
      datos_variables: { ...dv, documento },
    } as never)
    .eq('id', v3.id)
    .eq('estado', 'borrador')
    .eq('updated_at', v3.updated_at)
    .select('id');
  if (error || !(data as unknown[] | null)?.length) {
    await quitarFinal();
    if (error) {
      logger.error({ expedienteId, error: error.message }, 'Asistente V3: no se pudo sacar el contrato de borrador');
      throw new AppError(500, 'CONTRATO_GUARDAR_ERROR', 'No se pudo enviar a firma. Intenta de nuevo.');
    }
    throw borradorCambiado();
  }
  await db('contrato_historial_estados').insert({
    contrato_id: v3.id,
    estado_anterior: 'borrador',
    estado_nuevo: 'pendiente_firma',
    descripcion: `Enviado a firma (asistente V3, Ruta ${ruta})`,
    usuario_id: userId,
  } as never);
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.CONTRATO_TRANSITIONED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: v3.id,
    detalle: { expediente_id: expedienteId, v3: true, ruta, de: 'borrador', a: 'pendiente_firma', sha256: documento.final!.sha256 },
    ip,
  });

  // 5. La verificación de identidad (si está encendida) o el sobre.
  try {
    if (env.FIRMA_BIOMETRIA_ENABLED) {
      const { iniciarVerificacionIdentidad } = await import('@/modules/firma/verificacion-identidad.service');
      await iniciarVerificacionIdentidad(v3.id, userId);
    } else {
      await crearSobre(v3.id, userId);
    }
  } catch (e) {
    // El proceso sí salió: no se revierte (el webhook lo adopta).
    if (e instanceof AppError && e.errorCode === 'FIRMA_ENVIADA_SIN_REGISTRO') throw e;
    // Defensa: si pese al error hay un proceso vivo en Auco, el envío cuenta.
    const vivo = await ultimoSobre(v3.id).catch(() => null);
    if (vivo?.estado === 'en_firma' && vivo.auco_code) {
      logger.warn({ expedienteId, error: e instanceof Error ? e.message : String(e) }, 'Asistente V3: error al enviar, pero el proceso quedó vivo en Auco');
    } else {
      if (await revertirEnvio(v3, dv, ruta, e)) await quitarFinal();
      throw e;
    }
  }

  // Solo con el sobre fuera se borra la vista previa: si hubo que revertir, sigue ahí.
  if (v3.storage_key) {
    const { error: rmError } = await supabase.storage.from(BUCKET).remove([v3.storage_key]);
    if (rmError) logger.warn({ expedienteId, key: v3.storage_key }, 'Asistente V3: no se borro la vista previa al enviar');
  }
  const vista = await estadoEnviado(v3.id);
  return vista ? estadoDeEnviado(vista) : armarEstado(await cargar(expedienteId), hoy);
}

/**
 * Vuelta a borrador tras un envío fallido. Dos pasos por el congelamiento:
 * primero el estado (columna libre), después, ya en borrador, el documento.
 */
async function revertirEnvio(
  v3: ContratoV3,
  dv: NonNullable<ContratoV3['datos_variables']>,
  ruta: 'A' | 'B',
  e: unknown,
): Promise<boolean> {
  const detalle = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  const volver = await db('contratos')
    .update({ estado: 'borrador' } as never)
    .eq('id', v3.id)
    .eq('estado', 'pendiente_firma')
    .select('id');
  // Sin fila (lo cancelaron mientras tanto) o con error: no se toca nada más, ni
  // el PDF final que el contrato sigue usando, ni el historial.
  if (volver.error || !(volver.data as unknown[] | null)?.length) {
    logger.error({ contratoId: v3.id, error: volver.error?.message }, 'Asistente V3: el envío falló y el contrato no volvió a borrador');
    return false;
  }
  const restaurar = await db('contratos')
    .update({
      storage_key: v3.storage_key,
      nombre_archivo: nombreBorrador(v3.numero, ruta),
      fecha_generacion: dv.documento?.generadoEn ?? null,
      datos_variables: dv,
    } as never)
    .eq('id', v3.id)
    .eq('estado', 'borrador');
  if (restaurar.error)
    logger.error({ contratoId: v3.id, error: restaurar.error.message }, 'Asistente V3: no se restauró la vista previa');
  await db('contrato_historial_estados').insert({
    contrato_id: v3.id,
    estado_anterior: 'pendiente_firma',
    estado_nuevo: 'borrador',
    descripcion: `Reversión automática: el envío a firma falló: ${detalle}`,
    usuario_id: null,
  } as never);
  return true;
}

/** El V3 fuera de borrador de este estudio, con acceso verificado. */
async function enviadoOError(expedienteId: string, userId: string, userRol: string): Promise<string> {
  await assertExpedienteAccess(expedienteId, userId, userRol);
  const c = await contratoEnviado(expedienteId);
  if (!c) throw AppError.conflict('El contrato no está en firma.', 'CONTRATO_ESTADO_CAMBIADO');
  return c.id;
}

async function estadoTras(contratoId: string, expedienteId: string): Promise<EstadoAsistente> {
  const vista = await estadoEnviado(contratoId);
  return vista ? estadoDeEnviado(vista) : armarEstado(await cargar(expedienteId), hoyBogota());
}

/** Reenvío desde FIRMA INCOMPLETA (§11.7.5). Un proceso nuevo en Auco: solo con el flag encendido. */
export async function reenviarFirma(expedienteId: string, userId: string, userRol: string): Promise<EstadoAsistente> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  const id = await enviadoOError(expedienteId, userId, userRol);
  await reenviar(id, userId);
  return estadoTras(id, expedienteId);
}

/** EN FIRMA sin sobre (Auco falló después de la verificación de identidad, o el sobre quedó huérfano). */
export async function reintentarFirma(expedienteId: string, userId: string, userRol: string): Promise<EstadoAsistente> {
  if (!env.CONTRATOS_V3_ENABLED) throw noHabilitado();
  const id = await enviadoOError(expedienteId, userId, userRol);
  await reintentar(id, userId);
  return estadoTras(id, expedienteId);
}

/** "Actualizar estado": pregunta a Auco ya, sin esperar el webhook ni el barrido (también con el flag apagado). */
export async function actualizarFirmaV3(expedienteId: string, userId: string, userRol: string): Promise<EstadoAsistente> {
  const id = await enviadoOError(expedienteId, userId, userRol);
  await actualizarFirma(id);
  return estadoTras(id, expedienteId);
}

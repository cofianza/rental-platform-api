// ============================================================
// Carga de cartera en dos pasadas (spec §2.4).
//
// validar: lee el archivo, aplica §1.2/§1.3 y los cruces contra la base, y
//   devuelve el reporte por fila. No crea nada (§2.4.1).
// procesar: revalida el archivo (no confía en la primera pasada), crea el lote
//   y una fila por renglón en migracion_filas. Los contratos NO se crean aquí:
//   nacen todos juntos al firmarse el acta (fn_activar_lote_migracion, A3).
// ============================================================

import { createHash, randomUUID } from 'crypto';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { fetchAll } from '@/lib/fetchAll';
import { getCalibracion } from '@/lib/calibracion';
import { getCatalog } from '@/lib/colombia-municipios';
import { getCompany } from '@/lib/companyConfig';
import { generarActa } from './acta';
import { avisarExposicionLote } from './cartera.service';
import { BUCKET, faltantesHabilitacion, getOrg, listarHabilitaciones, type OrgMigracion } from './habilitacion.service';
import { generarReporte, leerArchivo } from './plantilla';
import {
  aplicarConflicto,
  claveInmueble,
  exposicionDe,
  validarFilas,
  type ContextoValidacion,
  type ResultadoFila,
} from './validacion';
import type { ProcesarInput } from './migracion.schema';

const db = (tabla: string) => supabase.from(tabla as string) as ReturnType<typeof supabase.from>;

const ESTADOS_CONTRATO_VIVO = ['pendiente_firma', 'firma_incompleta', 'firmado', 'vigente'];

const hoyBogota = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

/** Condiciones de la inmobiliaria para cargar (§1.1, §7.2.2) + contexto de validación. */
async function prepararCarga(inmobiliariaId: string) {
  const org = await getOrg(inmobiliariaId);
  if (org.estado !== 'activa')
    throw AppError.conflict('La inmobiliaria no está activa en la plataforma.', 'INMOBILIARIA_NO_ACTIVA');
  if (org.migracion_suspendida_en)
    throw AppError.conflict(
      'Las migraciones de esta inmobiliaria están suspendidas hasta decisión de la Gerencia General.',
      'MIGRACION_SUSPENDIDA',
    );

  const habs = await listarHabilitaciones(inmobiliariaId);
  const usables = habs.filter((h) => faltantesHabilitacion(h).length === 0);
  if (!usables.length)
    throw new AppError(
      409,
      'MIGRACION_NO_HABILITADA',
      'La inmobiliaria no tiene habilitación de migración para ninguna destinación. Complete la revisión de la plantilla y los convenios.',
      habs.map((h) => ({ destinacion: h.destinacion, faltantes: faltantesHabilitacion(h) })),
    );

  const [cal, municipios] = await Promise.all([getCalibracion(), getCatalog()]);
  // El respaldo embebido trae unos 30 municipios: validar con él rechazaría filas buenas.
  if (municipios.length < 100)
    throw new AppError(503, 'CATALOGO_MUNICIPIOS_NO_DISPONIBLE', 'No se pudo cargar el catálogo de municipios. Intente de nuevo en unos minutos.');

  const ctx: ContextoValidacion = {
    hoy: hoyBogota(),
    parametros: cal,
    habilitaciones: Object.fromEntries(usables.map((h) => [h.destinacion, { habeas_subrogatario: h.habeas_subrogatario }])),
    municipios,
  };
  return { org, ctx, cal, usables };
}

/**
 * Cruces contra la base (§1.3): contrato o fianza ya existentes sobre el
 * inmueble, inmueble ocupado o reservado, fila viva en otro lote. Una dirección
 * que coincide con un inmueble de otra inmobiliaria solo advierte.
 */
export async function cruzarConBase(org: OrgMigracion, resultados: ResultadoFila[]): Promise<void> {
  const vivos = resultados.filter((r) => r.resultado !== 'rechazada' && r.clave_inmueble);
  if (!vivos.length) return;

  type Inm = { id: string; direccion: string; ciudad: string; estado: string; reservado_por_expediente_id: string | null };
  const [propios, ajenos, contratos, filas] = await Promise.all([
    fetchAll<Inm>((d, h) =>
      db('inmuebles')
        .select('id, direccion, ciudad, estado, reservado_por_expediente_id')
        .eq('inmobiliaria_id', org.id)
        .order('id')
        .range(d, h) as never,
    ),
    // ponytail: recorre todos los inmuebles ajenos; con volumen, guardar la clave normalizada en una columna indexada.
    fetchAll<Pick<Inm, 'id' | 'direccion' | 'ciudad'>>((d, h) =>
      db('inmuebles')
        .select('id, direccion, ciudad')
        .or(`inmobiliaria_id.is.null,inmobiliaria_id.neq.${org.id}`)
        .order('id')
        .range(d, h) as never,
    ),
    fetchAll<{ expedientes: { inmueble_id: string } }>((d, h) =>
      db('contratos')
        .select('id, expedientes!inner(inmueble_id)')
        .eq('expedientes.inmobiliaria_id', org.id)
        .in('estado', ESTADOS_CONTRATO_VIVO)
        .order('id')
        .range(d, h) as never,
    ),
    fetchAll<{ clave_inmueble: string; migracion_lotes: { numero: string } }>((d, h) =>
      db('migracion_filas')
        .select('clave_inmueble, migracion_lotes(numero)')
        .eq('inmobiliaria_id', org.id)
        .in('resultado', ['aceptada', 'advertencia'])
        .is('excluido_en', null)
        .is('liberada_en', null)
        .order('id')
        .range(d, h) as never,
    ),
  ]);
  for (const r of [propios, ajenos, contratos, filas]) if (r.error) throw fromSupabaseError(r.error);

  const propioPorClave = new Map(propios.data.map((i) => [claveInmueble(i.direccion, i.ciudad), i]));
  const ajenosPorClave = new Map<string, string[]>();
  for (const i of ajenos.data) {
    const k = claveInmueble(i.direccion, i.ciudad);
    ajenosPorClave.set(k, [...(ajenosPorClave.get(k) ?? []), i.id]);
  }
  // §1.3: un inmueble ajeno con fianza viva de Cofianza se rechaza (sin nombrar a su dueño).
  const idsAjenos = [...new Set(vivos.flatMap((r) => ajenosPorClave.get(r.clave_inmueble!) ?? []))];
  const ajenosConContrato = new Set<string>();
  for (let i = 0; i < idsAjenos.length; i += 200) {
    const { data, error } = await db('contratos')
      .select('id, expedientes!inner(inmueble_id)')
      .in('expedientes.inmueble_id', idsAjenos.slice(i, i + 200))
      .in('estado', ESTADOS_CONTRATO_VIVO);
    if (error) throw fromSupabaseError(error);
    for (const c of (data as unknown as { expedientes: { inmueble_id: string } }[] | null) ?? []) ajenosConContrato.add(c.expedientes.inmueble_id);
  }
  const conContrato = new Set(contratos.data.map((c) => c.expedientes.inmueble_id));
  const loteDeClave = new Map(filas.data.map((f) => [f.clave_inmueble, f.migracion_lotes?.numero ?? '']));

  for (const r of vivos) {
    const clave = r.clave_inmueble!;
    const lote = loteDeClave.get(clave);
    if (lote !== undefined) {
      aplicarConflicto(r, { motivo: `Inmueble ya cargado en el lote de migración ${lote}.` });
      continue;
    }
    const inm = propioPorClave.get(clave);
    if (inm) {
      if (conContrato.has(inm.id))
        aplicarConflicto(r, { motivo: 'Contrato ya existente en la plataforma: el inmueble tiene un contrato en curso o una fianza activa de Cofianza.' });
      else if (inm.estado === 'ocupado' || inm.reservado_por_expediente_id)
        aplicarConflicto(r, { motivo: 'El inmueble figura ocupado o reservado en la plataforma.' });
      else
        aplicarConflicto(r, {
          inmueble_id: inm.id,
          advertencia: inm.estado === 'inactivo' ? 'El inmueble está inactivo en la plataforma.' : undefined,
        });
    }
    const ajenosClave = ajenosPorClave.get(clave);
    if (ajenosClave?.some((id) => ajenosConContrato.has(id)))
      aplicarConflicto(r, { motivo: 'Inmueble ya vinculado a una fianza activa de Cofianza.' });
    else if (ajenosClave)
      aplicarConflicto(r, { advertencia: 'La dirección coincide con un inmueble de otra inmobiliaria o propietario en la plataforma.' });
  }
}

async function validarBuffer(inmobiliariaId: string, archivo: Buffer) {
  const prep = await prepararCarga(inmobiliariaId);
  const filas = await leerArchivo(archivo, prep.cal.MAX_FILAS_POR_CARGA);
  if (!filas.length) throw AppError.badRequest('El archivo no tiene contratos diligenciados.', 'MIGRACION_ARCHIVO_VACIO');
  const resultados = validarFilas(filas, prep.ctx);
  await cruzarConBase(prep.org, resultados);
  return { ...prep, filas, resultados };
}

function resumir(resultados: ResultadoFila[]) {
  const cuenta = (r: string) => resultados.filter((x) => x.resultado === r).length;
  return {
    total: resultados.length,
    aceptadas: cuenta('aceptada'),
    advertencias: cuenta('advertencia'),
    rechazadas: cuenta('rechazada'),
  };
}

const vistaFila = (r: ResultadoFila) => ({
  n_fila: r.n_fila,
  resultado: r.resultado,
  motivos: r.motivos,
  advertencias: r.advertencias,
  direccion: r.datos.direccion,
  municipio: r.datos.municipio,
  arrendatario: r.datos.arrendatario.nombre,
  documento: r.documento_arrendatario,
  canon: r.datos.canon,
  reportable: r.reportable,
  tarifa_pct: r.tarifa_pct,
});

/** Primera pasada (§2.4.1): no crea ningún registro. */
export async function validarArchivo(inmobiliariaId: string, archivo: Buffer) {
  const { resultados } = await validarBuffer(inmobiliariaId, archivo);
  return { resumen: resumir(resultados), filas: resultados.map(vistaFila) };
}

/** El mismo reporte en Excel, con los datos tal como llegaron (§2.4.1). */
export async function validarArchivoXlsx(inmobiliariaId: string, archivo: Buffer) {
  const { resultados, filas, cal } = await validarBuffer(inmobiliariaId, archivo);
  return generarReporte(filas, resultados, cal.MESES_SIN_MORA_REQUERIDOS);
}

/**
 * Segunda pasada (§2.4.3-§2.4.5): lote + filas. Las rechazadas también se
 * guardan (el acta las lista con su motivo, §3.2) pero no detienen el lote.
 */
export async function procesarArchivo(inmobiliariaId: string, archivo: Buffer, rep: ProcesarInput, usuarioId: string) {
  const { org, resultados, cal, usables } = await validarBuffer(inmobiliariaId, archivo);
  const resumen = resumir(resultados);
  if (resumen.aceptadas + resumen.advertencias === 0)
    throw new AppError(422, 'MIGRACION_SIN_ACEPTADAS', 'Ningún contrato del archivo es aceptable: no se creó el lote. Revise el reporte de validación.');

  const exposicion = exposicionDe(resultados);
  const ahora = new Date();
  const alerta = exposicion >= cal.UMBRAL_ALERTA_EXPOSICION_LOTE;

  const archivoKey = `migracion/${org.id}/lotes/${randomUUID()}.xlsx`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(archivoKey, archivo, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    upsert: false,
  });
  if (upErr) throw new AppError(500, 'STORAGE_ERROR', 'No se pudo guardar el archivo. Intente de nuevo.');

  const { data: loteRow, error: loteErr } = await db('migracion_lotes')
    .insert({
      inmobiliaria_id: org.id,
      vence_en: new Date(ahora.getTime() + cal.DIAS_VIGENCIA_LOTE_SIN_FIRMA * 86_400_000).toISOString(),
      archivo_storage_key: archivoKey,
      archivo_hash: createHash('sha256').update(archivo).digest('hex'),
      // total_aceptadas incluye las que tienen advertencia (las dos se activan).
      total_aceptadas: resumen.aceptadas + resumen.advertencias,
      total_rechazadas: resumen.rechazadas,
      total_advertencias: resumen.advertencias,
      exposicion_cop: exposicion,
      alerta_exposicion_en: alerta ? ahora.toISOString() : null,
      rep_legal_nombre: rep.rep_legal_nombre,
      rep_legal_documento: rep.rep_legal_documento,
      rep_legal_email: rep.rep_legal_email.toLowerCase(),
      rep_legal_celular: rep.rep_legal_celular,
      creado_por: usuarioId,
    } as never)
    .select('id, numero, estado, vence_en, exposicion_cop')
    .single();
  if (loteErr) {
    await supabase.storage.from(BUCKET).remove([archivoKey]);
    throw fromSupabaseError(loteErr);
  }
  const lote = loteRow as { id: string; numero: string; estado: string; vence_en: string; exposicion_cop: number };

  const { error: filasErr } = await db('migracion_filas').insert(
    resultados.map((r) => ({
      lote_id: lote.id,
      inmobiliaria_id: org.id,
      n_fila: r.n_fila,
      datos: r.datos,
      resultado: r.resultado,
      motivos: r.motivos,
      advertencias: r.advertencias,
      clave_inmueble: r.clave_inmueble,
      documento_arrendatario: r.documento_arrendatario,
      reportable: r.reportable,
      reportable_motivo: r.reportable_motivo,
      tarifa_acta_pct: r.tarifa_pct,
      tarifa_pct: r.tarifa_pct,
    })) as never,
  );
  if (filasErr) {
    // Sin filas el lote no sirve: se borra (cascada) junto con el archivo.
    await db('migracion_lotes').delete().eq('id', lote.id);
    await supabase.storage.from(BUCKET).remove([archivoKey]);
    if (filasErr.code === '23505')
      throw AppError.conflict(
        'Otro lote tomó uno de estos inmuebles mientras se procesaba. Valide de nuevo el archivo.',
        'MIGRACION_INMUEBLE_EN_OTRO_LOTE',
      );
    throw fromSupabaseError(filasErr);
  }

  // §3.1: el Acta de Migración del lote. Sin acta el lote no se puede firmar, así
  // que si falla se deshace todo (filas en cascada) y se puede reintentar.
  // El envío a firma es aparte (C5); hasta entonces el lote queda 'procesado'.
  let acta: { storage_key: string; hash: string } | null = null;
  try {
    acta = await generarActa(
      {
        empresa: await getCompany(),
        inmobiliaria: { id: org.id, nombre: org.nombre },
        habilitaciones: usables.map((h) => ({ destinacion: h.destinacion, revisado_en: h.revisado_en })),
        lote: { numero: lote.numero, rep_legal_nombre: rep.rep_legal_nombre, rep_legal_documento: rep.rep_legal_documento },
        generadaEn: ahora,
        filas: resultados,
        mesesSinMora: cal.MESES_SIN_MORA_REQUERIDOS,
        diasRespuestaAuditoria: cal.DIAS_RESPUESTA_AUDITORIA,
      },
      lote.id,
    );
    const { error: actaErr } = await db('migracion_lotes')
      .update({ acta_storage_key: acta.storage_key, acta_hash: acta.hash } as never)
      .eq('id', lote.id);
    if (actaErr) throw fromSupabaseError(actaErr);
  } catch (err) {
    await db('migracion_lotes').delete().eq('id', lote.id);
    await supabase.storage.from(BUCKET).remove(acta ? [archivoKey, acta.storage_key] : [archivoKey]);
    throw err;
  }

  if (alerta) {
    // §8.4: informa a la Gerencia General, no bloquea.
    logger.warn({ loteId: lote.id, exposicion, umbral: cal.UMBRAL_ALERTA_EXPOSICION_LOTE }, 'Lote de migración supera el umbral de exposición');
    void avisarExposicionLote({
      id: lote.id,
      numero: lote.numero,
      inmobiliaria: org.nombre,
      exposicion,
      umbral: cal.UMBRAL_ALERTA_EXPOSICION_LOTE,
    });
  }

  return {
    lote: { ...lote, exposicion_cop: Number(lote.exposicion_cop), alerta_exposicion: alerta, acta_hash: acta.hash },
    resumen,
    filas: resultados.map(vistaFila),
  };
}

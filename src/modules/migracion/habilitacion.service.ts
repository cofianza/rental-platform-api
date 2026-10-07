// ============================================================
// Habilitación de migración por inmobiliaria y destinación (spec §1.1) y
// suspensión de nuevas migraciones (§7.2.2).
// ============================================================

import { randomUUID } from 'crypto';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { esGerenciaGeneral } from '@/lib/gerenciaGeneral';
import type { Destinacion } from './validacion';
import type { GuardarHabilitacionInput } from './migracion.schema';

const db = (tabla: string) => supabase.from(tabla as string) as ReturnType<typeof supabase.from>;

export const BUCKET = 'documentos-expedientes';

export interface Habilitacion {
  id: string;
  inmobiliaria_id: string;
  destinacion: Destinacion;
  estado: 'habilitada' | 'con_observaciones' | 'no_habilitada';
  arrendador_es_inmobiliaria: boolean | null;
  habeas_subrogatario: boolean | null;
  orden_imputacion: string | null;
  regimen_prorroga: string | null;
  deposito_dinero: boolean | null;
  renovacion_comercial: string | null;
  observaciones: string | null;
  plantilla_storage_key: string | null;
  convenio_migracion_storage_key: string | null;
  convenio_vigente_confirmado: boolean;
  revisado_por: string | null;
  revisado_en: string | null;
}

export interface OrgMigracion {
  id: string;
  nombre: string;
  estado: string;
  owner_perfil_id: string;
  migracion_suspendida_en: string | null;
  migracion_suspendida_motivo: string | null;
}

export async function getOrg(inmobiliariaId: string): Promise<OrgMigracion> {
  const { data, error } = await db('inmobiliarias')
    .select('id, nombre, estado, owner_perfil_id, migracion_suspendida_en, migracion_suspendida_motivo')
    .eq('id', inmobiliariaId)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!data) throw AppError.notFound('Inmobiliaria no encontrada', 'INMOBILIARIA_NO_ENCONTRADA');
  return data as OrgMigracion;
}

export async function listarHabilitaciones(inmobiliariaId: string): Promise<Habilitacion[]> {
  const { data, error } = await db('migracion_habilitaciones').select('*').eq('inmobiliaria_id', inmobiliariaId);
  if (error) throw fromSupabaseError(error);
  return (data ?? []) as Habilitacion[];
}

/**
 * Pura. Una habilitación sirve para cargar si la revisión no la descartó y
 * están las condiciones de entrada §1.1.1-§1.1.3. Devuelve qué falta.
 */
export function faltantesHabilitacion(h: Habilitacion): string[] {
  const faltan: string[] = [];
  if (h.estado === 'no_habilitada') faltan.push('la revisión de la plantilla la dejó no habilitada');
  if (!h.convenio_vigente_confirmado) faltan.push('confirmar el convenio de inmobiliaria vigente');
  if (!h.convenio_migracion_storage_key) faltan.push('cargar el convenio de migración firmado');
  if (!h.plantilla_storage_key) faltan.push('cargar la plantilla de contrato revisada');
  return faltan;
}

/** Estado de migración de una inmobiliaria para el backoffice, con enlaces temporales a los documentos. */
export async function estadoMigracionOrg(inmobiliariaId: string) {
  const [org, habs] = await Promise.all([getOrg(inmobiliariaId), listarHabilitaciones(inmobiliariaId)]);
  const firmar = async (key: string | null) => {
    if (!key) return null;
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(key, 600);
    return data?.signedUrl ?? null;
  };
  const habilitaciones = await Promise.all(
    habs.map(async (h) => ({
      ...h,
      faltantes: faltantesHabilitacion(h),
      plantilla_url: await firmar(h.plantilla_storage_key),
      convenio_migracion_url: await firmar(h.convenio_migracion_storage_key),
    })),
  );
  return {
    inmobiliaria: { id: org.id, nombre: org.nombre, estado: org.estado },
    suspension: org.migracion_suspendida_en
      ? { desde: org.migracion_suspendida_en, motivo: org.migracion_suspendida_motivo }
      : null,
    habilitaciones,
  };
}

/** Registra (o corrige) el resultado de la revisión manual §1.1.4-§1.1.5. */
export async function guardarHabilitacion(
  inmobiliariaId: string,
  destinacion: Destinacion,
  input: GuardarHabilitacionInput,
  usuarioId: string,
): Promise<Habilitacion> {
  await getOrg(inmobiliariaId);
  const { data, error } = await db('migracion_habilitaciones')
    .upsert(
      {
        inmobiliaria_id: inmobiliariaId,
        destinacion,
        ...input,
        // §1.1.4: el régimen de renovación comercial solo aplica a comercial.
        renovacion_comercial: destinacion === 'comercial' ? input.renovacion_comercial ?? null : null,
        revisado_por: usuarioId,
        revisado_en: new Date().toISOString(),
      } as never,
      { onConflict: 'inmobiliaria_id,destinacion' },
    )
    .select('*')
    .single();
  if (error) throw fromSupabaseError(error);
  return data as Habilitacion;
}

export type TipoDocumentoHabilitacion = 'plantilla' | 'convenio';

/** Sube la plantilla de contrato (§1.1.3) o el convenio de migración firmado (§1.1.2). */
export async function cargarDocumentoHabilitacion(
  inmobiliariaId: string,
  destinacion: Destinacion,
  tipo: TipoDocumentoHabilitacion,
  archivo: Buffer,
): Promise<Habilitacion> {
  const { data: actual, error } = await db('migracion_habilitaciones')
    .select('id')
    .eq('inmobiliaria_id', inmobiliariaId)
    .eq('destinacion', destinacion)
    .maybeSingle();
  if (error) throw fromSupabaseError(error);
  if (!actual)
    throw AppError.notFound('Registre primero la revisión de la plantilla para esta destinación.', 'HABILITACION_NO_ENCONTRADA');

  const key = `migracion/${inmobiliariaId}/habilitacion/${destinacion}-${tipo}-${randomUUID()}.pdf`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(key, archivo, { contentType: 'application/pdf', upsert: false });
  if (upErr) throw new AppError(500, 'STORAGE_ERROR', 'No se pudo guardar el documento. Intente de nuevo.');

  const columna = tipo === 'plantilla' ? 'plantilla_storage_key' : 'convenio_migracion_storage_key';
  const { data, error: updErr } = await db('migracion_habilitaciones')
    .update({ [columna]: key } as never)
    .eq('id', (actual as { id: string }).id)
    .select('*')
    .single();
  if (updErr) throw fromSupabaseError(updErr);
  return data as Habilitacion;
}

/**
 * §7.2.2: bloquea nuevas cargas de la inmobiliaria. La llama la exclusión por
 * declaración falsa (automática) y un analista a mano. Idempotente: conserva
 * la primera fecha y motivo.
 */
export async function suspenderMigraciones(inmobiliariaId: string, motivo: string): Promise<boolean> {
  const { data, error } = await db('inmobiliarias')
    .update({ migracion_suspendida_en: new Date().toISOString(), migracion_suspendida_motivo: motivo } as never)
    .eq('id', inmobiliariaId)
    .is('migracion_suspendida_en', null)
    .select('id');
  if (error) throw fromSupabaseError(error);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/** §7.2.2: solo la Gerencia General levanta la suspensión. */
export async function reactivarMigraciones(
  inmobiliariaId: string,
  usuario: { id: string; rol: string; email: string },
): Promise<void> {
  if (!esGerenciaGeneral(usuario))
    throw AppError.forbidden(
      'Solo la Gerencia General puede reactivar las migraciones de una inmobiliaria suspendida.',
      'SOLO_GERENCIA_GENERAL',
    );
  const org = await getOrg(inmobiliariaId);
  if (!org.migracion_suspendida_en)
    throw AppError.conflict('Las migraciones de esta inmobiliaria no están suspendidas.', 'MIGRACION_NO_SUSPENDIDA');
  const { error } = await db('inmobiliarias')
    .update({
      migracion_suspendida_en: null,
      migracion_suspendida_motivo: null,
      migracion_reactivada_por: usuario.id,
    } as never)
    .eq('id', inmobiliariaId);
  if (error) throw fromSupabaseError(error);
}

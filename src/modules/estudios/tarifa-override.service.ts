// ============================================================
// Tarifa negociada por estudio — Adenda 1 §5, nota para desarrollo
// ------------------------------------------------------------
//   "Pueden existir contratos con condiciones especiales negociadas caso por
//    caso, que se cargan manualmente y no se derivan del score. El sistema
//    debe permitir sobrescribir la tarifa con autorizacion de Gerencia
//    General, dejando registro de quien autorizo y cuando."
//
// Gerencia General = rol administrador (la ruta lo exige). El override vive
// en estudios.tarifa_override (JSONB) y calcularTarifas() lo aplica encima de
// la tabla estandar; el CRC ya lo imprimia como "condiciones especiales
// autorizadas". Aqui esta lo que faltaba: leerlo, ponerlo y quitarlo.
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { getCalibracion } from '@/lib/calibracion';
import { assertExpedienteAccess } from '@/lib/tenantScope';
import {
  calcularTarifas,
  leerTarifaOverride,
  viaSegunCalibracion,
  type Tarifas,
  type TarifaOverride,
} from './tarifas';
import { generarCertificado, leerSombraDelEstudio } from './certificado.service';
import { coarrendatarioVinculado } from './coarrendatario-vinculado';
import type { TarifaOverrideInput } from './estudios.schema';

interface FilaEstudio {
  id: string;
  expediente_id: string;
  tipo: string;
  estado: string;
  resultado: string | null;
  canon_evaluado: number | string | null;
  tarifa_override: unknown;
  certificado_url: string | null;
  expedientes: { inmuebles: { valor_arriendo: number | null } | null } | null;
}

export interface TarifaEstudio {
  estudio_id: string;
  estado: string;
  resultado: string | null;
  /** Tabla estandar con el override (si lo hay) aplicado encima. */
  tarifas: Tarifas;
  override: (TarifaOverride & { autorizado_por_nombre: string | null }) | null;
  certificado_emitido: boolean;
  /** Solo en PATCH/DELETE: si el CRC ya emitido se regenero con las cifras nuevas. */
  crc_regenerado?: boolean;
  crc_error?: string | null;
}

async function leerFila(estudioId: string): Promise<FilaEstudio> {
  const { data, error } = await (supabase
    .from('estudios' as string) as ReturnType<typeof supabase.from>)
    .select(
      'id, expediente_id, tipo, estado, resultado, canon_evaluado, tarifa_override, certificado_url, ' +
        'expedientes!estudios_expediente_id_fkey(inmuebles!expedientes_inmueble_id_fkey(valor_arriendo))',
    )
    .eq('id', estudioId)
    .maybeSingle();
  if (error || !data) throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  return data as unknown as FilaEstudio;
}

async function armar(e: FilaEstudio): Promise<TarifaEstudio> {
  const cal = await getCalibracion();
  const sombra = await leerSombraDelEstudio(e.id);
  const usaPuntaje = env.MOTOR_DECIDE_ENABLED || env.MOTOR_RUTA_USA_SCORECARD;
  const puntaje = usaPuntaje ? (sombra?.puntaje ?? null) : null;
  // Mismo criterio que el CRC (Adenda §5.2 / §3): el coarrendatario es la fila
  // vinculada al expediente con su propio puntaje, no el `tipo` de este estudio.
  const coa = await coarrendatarioVinculado(e.expediente_id);
  const conCoarrendatario = coa !== null;
  const puntajeCoa = usaPuntaje ? (coa?.puntaje ?? null) : null;
  const override = leerTarifaOverride(e.tarifa_override);
  // Mismo canon que el CRC: el congelado al ejecutar; si no lo hay, el del inmueble.
  const canonCop =
    e.canon_evaluado === null || e.canon_evaluado === undefined
      ? (e.expedientes?.inmuebles?.valor_arriendo ?? null)
      : Number(e.canon_evaluado);
  const tarifas = calcularTarifas({
    via: viaSegunCalibracion(puntaje, conCoarrendatario, cal, puntajeCoa),
    conCoarrendatario,
    canonCop,
    override,
  });

  let autorizadoPorNombre: string | null = null;
  if (override) {
    const { data } = await (supabase.from('perfiles' as string) as ReturnType<typeof supabase.from>)
      .select('nombre, apellido')
      .eq('id', override.autorizado_por)
      .maybeSingle();
    const p = data as { nombre?: string | null; apellido?: string | null } | null;
    autorizadoPorNombre = p ? `${p.nombre ?? ''} ${p.apellido ?? ''}`.trim() || null : null;
  }

  return {
    estudio_id: e.id,
    estado: e.estado,
    resultado: e.resultado,
    tarifas,
    override: override ? { ...override, autorizado_por_nombre: autorizadoPorNombre } : null,
    certificado_emitido: !!e.certificado_url,
  };
}

/** Lectura para el gestor (scoping por expediente, como el detalle del estudio). */
export async function tarifasDelEstudio(estudioId: string, userId?: string, userRol?: string): Promise<TarifaEstudio> {
  const e = await leerFila(estudioId);
  await assertExpedienteAccess(e.expediente_id, userId, userRol);
  return armar(e);
}

async function guardar(
  e: FilaEstudio,
  nuevo: TarifaOverride | null,
  userId: string,
  userRol: string | undefined,
  ip?: string,
): Promise<TarifaEstudio> {
  const { error } = await (supabase.from('estudios' as string) as ReturnType<typeof supabase.from>)
    .update({ tarifa_override: nuevo } as never)
    .eq('id', e.id);
  if (error) {
    logger.error({ estudioId: e.id, error: error.message }, 'No se pudo guardar tarifa_override');
    throw new AppError(500, 'INTERNAL_ERROR', 'No se pudo guardar la tarifa');
  }
  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ESTUDIO_TARIFA_OVERRIDE,
    entidad: AUDIT_ENTITIES.ESTUDIO,
    entidadId: e.id,
    detalle: { anterior: leerTarifaOverride(e.tarifa_override), nuevo },
    ip,
  });

  // El CRC ya emitido imprime las cifras viejas: se regenera con las nuevas
  // (generarCertificado borra el PDF anterior y reemplaza el codigo). Es
  // best-effort: si no se puede (p. ej. el estudio ya vencio), la tarifa queda
  // guardada igual y se le dice al usuario por que.
  let crcRegenerado = false;
  let crcError: string | null = null;
  if (e.certificado_url) {
    try {
      await generarCertificado(e.id, userId, ip, userRol);
      crcRegenerado = true;
    } catch (err) {
      crcError = err instanceof Error ? err.message : 'No se pudo regenerar el CRC';
      logger.warn({ estudioId: e.id, err: crcError }, 'Tarifa guardada pero el CRC no se regenero');
    }
  }

  return { ...(await armar(await leerFila(e.id))), crc_regenerado: crcRegenerado, crc_error: crcError };
}

export async function setTarifaOverride(
  estudioId: string,
  input: TarifaOverrideInput,
  userId: string,
  userRol: string | undefined,
  ip?: string,
): Promise<TarifaEstudio> {
  const e = await leerFila(estudioId);
  if (e.estado === 'cancelado') {
    throw AppError.conflict('El estudio esta cancelado', 'ESTUDIO_CANCELADO');
  }
  const nuevo: TarifaOverride = {
    tarifa_mensual_pct: input.tarifa_mensual_pct,
    prima_vinculacion_pct: input.prima_vinculacion_pct,
    cashback_pct: input.cashback_pct,
    autorizado_por: userId,
    autorizado_en: new Date().toISOString(),
    motivo: input.motivo,
  };
  return guardar(e, nuevo, userId, userRol, ip);
}

export async function quitarTarifaOverride(
  estudioId: string,
  userId: string,
  userRol: string | undefined,
  ip?: string,
): Promise<TarifaEstudio> {
  const e = await leerFila(estudioId);
  if (!leerTarifaOverride(e.tarifa_override)) {
    throw AppError.conflict('Este estudio no tiene condiciones especiales', 'SIN_TARIFA_OVERRIDE');
  }
  return guardar(e, null, userId, userRol, ip);
}

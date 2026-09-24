// ============================================================
// Coarrendatario VINCULADO a un expediente — lectura compartida
// ------------------------------------------------------------
// La prima de vinculacion (Adenda 1 §5.2: 20% solo / 10% con coarrendatario)
// y la fila de 2,5% (§5.1: zona gris con coarrendatario >= 80) dependen de si
// el expediente TIENE un coarrendatario, no del `tipo` de la fila de estudios:
// 'con_coarrendatario' es el tipo del estudio PROPIO del coarrendatario, asi
// que mirar el tipo del estudio del titular siempre decia "solo" y el CRC
// imprimia prima 20% aun con acompañante vinculado.
//
// Una sola lectura para el CRC (certificado.service) y para
// GET /estudios/:id/tarifa (tarifa-override.service). No importa nada de
// coarrendatarios.service para no cerrar un ciclo con el modulo de estudios.
// ============================================================

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';

export interface CoarrendatarioVinculado {
  /** Fila de expediente_coarrendatarios. */
  id: string;
  nombre: string;
  /** Su estudio propio (tipo='con_coarrendatario'), ya completado y no rechazado. */
  estudioId: string;
  /** Ultimo puntaje normalizado del scorecard de SU estudio; null si no hay corrida. */
  puntaje: number | null;
}

/**
 * El estudio 'con_coarrendatario' cuelga del expediente del titular, pero es
 * de OTRA persona: su reporte de buro y su formulario (Ley 1266).
 * assertExpedienteAccess autoriza al titular por expediente, asi que sin esto
 * lo leia por id. 404, como si no existiera: ninguna pantalla suya lo usa.
 * Va en toda ruta por id que el solicitante alcance (detalle, ejecutar,
 * estado-proveedor, historial, certificado, tarifa).
 */
export function assertNoEsEstudioDeOtraPersona(tipo: unknown, userRol?: string): void {
  if (userRol === 'solicitante' && tipo === 'con_coarrendatario') {
    throw AppError.notFound('Estudio no encontrado', 'ESTUDIO_NOT_FOUND');
  }
}

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

/**
 * Estados de la invitacion que la dejan en pie (aceptada, no declinada ni
 * cancelada). Por si solos ya NO vinculan: falta evaluacionCuenta.
 */
export const ESTADOS_VINCULADO = ['aceptado', 'estudio_completado'] as const;

/**
 * P2 (decision 2026-09-24; Adenda 2 §6, Flujo §12): el coarrendatario cuenta
 * —prima 10 %, firma, tarifa 2,5 %— solo si su evaluacion termino y no salio
 * rechazada. Rechazada, fallida, sin pagar o en curso: 20 % y contrato sin el.
 * Una sola regla para el CRC, las tarifas, la prima sugerida y los dos contratos.
 */
export function evaluacionCuenta(
  estudio: { estado?: string | null; resultado?: string | null } | null | undefined,
): boolean {
  return estudio?.estado === 'completado' && (estudio.resultado === 'aprobado' || estudio.resultado === 'condicionado');
}

/** Nombre del coarrendatario que imprimio un contrato anterior (V4 anidado o V2 plano), o null. */
export function coarrendatarioImpreso(anidado: unknown, plano: unknown): string | null {
  const n = (anidado as { nombre_completo?: unknown } | null)?.nombre_completo;
  if (typeof n === 'string' && n.trim()) return n.trim();
  return typeof plano === 'string' && plano.trim() ? plano.trim() : null;
}

/**
 * P2 + contrato (plata): si el estudio ya tiene un contrato FIJO —el anterior
 * ya generado o el V3 que salio de borrador, sin cancelar ni terminar— que no
 * lleva al coarrendatario, manda el contrato: una evaluacion que termina
 * despues no lo mete (ni prima del 10 % ni CRC). Para meterlo se cancela ese
 * contrato y se genera otro. El borrador V3 no fija nada: se regenera con lo
 * vivo. Lanza si no puede leer.
 */
export async function contratoFijoSinCoarrendatario(expedienteId: string): Promise<boolean> {
  const { data, error } = await db('contratos')
    .select('id, estado, destinacion, coa_anidado:datos_variables->coarrendatario, coa_plano:datos_variables->>coarrendatario_nombre')
    .eq('expediente_id', expedienteId)
    .not('estado', 'in', '(cancelado,finalizado)');
  if (error) throw new Error(error.message);
  const fijos = ((data ?? []) as Array<{
    id: string;
    estado: string;
    destinacion: string | null;
    coa_anidado: unknown;
    coa_plano: unknown;
  }>).filter((c) => !c.destinacion || c.estado !== 'borrador');
  if (fijos.some((c) => !c.destinacion && !coarrendatarioImpreso(c.coa_anidado, c.coa_plano))) return true;

  const v3 = fijos.filter((c) => c.destinacion).map((c) => c.id);
  if (v3.length === 0) return false;
  const { data: partes, error: partesError } = await db('contrato_partes')
    .select('contrato_id')
    .in('contrato_id', v3)
    .eq('rol', 'coarrendatario');
  if (partesError) throw new Error(partesError.message);
  const conCoa = new Set(((partes ?? []) as Array<{ contrato_id: string }>).map((x) => x.contrato_id));
  return v3.some((id) => !conCoa.has(id));
}

/**
 * El coarrendatario que cuenta en el expediente: acepto la invitacion (tiene
 * su propia autorizacion y su estudio), su evaluacion cuenta (evaluacionCuenta)
 * y ningun contrato fijo va sin el (contratoFijoSinCoarrendatario).
 * Best-effort: ante un error de lectura devuelve null (= "solo"), la cifra
 * conservadora, y lo deja en el log; con `estricto` lanza el error, para quien
 * necesita distinguir "no hay" de "no se pudo leer".
 */
export async function coarrendatarioVinculado(
  expedienteId: string,
  opts: { estricto?: boolean } = {},
): Promise<CoarrendatarioVinculado | null> {
  try {
    if (await contratoFijoSinCoarrendatario(expedienteId)) return null;

    const { data, error } = await db('expediente_coarrendatarios')
      .select('id, nombre, estudio_id')
      .eq('expediente_id', expedienteId)
      .in('estado', ESTADOS_VINCULADO)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as { id: string; nombre: string; estudio_id: string | null } | null;
    if (!row?.estudio_id) return null;

    const { data: est, error: estError } = await db('estudios')
      .select('estado, resultado')
      .eq('id', row.estudio_id)
      .maybeSingle();
    if (estError) throw new Error(estError.message);
    if (!evaluacionCuenta(est as { estado?: string | null; resultado?: string | null } | null)) return null;

    const { data: sombra } = await db('estudios_scorecard_sombra')
      .select('puntaje_normalizado')
      .eq('estudio_id', row.estudio_id)
      .order('fecha_calculo', { ascending: false })
      .limit(1)
      .maybeSingle();
    const raw = (sombra as { puntaje_normalizado?: number | string | null } | null)?.puntaje_normalizado;
    const n = raw === null || raw === undefined ? null : Number(raw);
    const puntaje = n !== null && Number.isFinite(n) ? n : null;

    return { id: row.id, nombre: row.nombre, estudioId: row.estudio_id, puntaje };
  } catch (err) {
    if (opts.estricto) throw err;
    logger.warn(
      { expedienteId, err: err instanceof Error ? err.message : String(err) },
      'No se pudo leer el coarrendatario vinculado — se asume sin coarrendatario',
    );
    return null;
  }
}

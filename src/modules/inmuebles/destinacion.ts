// ============================================================
// Destinacion del inmueble -> flujo de contrato (Contratos V3, Entrega 1).
//
// La destinacion sale de `inmuebles.uso` (el unico enum con valores); ni
// `inmuebles.destinacion` (texto libre) ni `tipo` cuentan. Cada destinacion
// tiene su propio contrato y su propio tope de canon (Complemento comercial
// §1.4 / §2.1): el de vivienda urbana NO se usa para un inmueble comercial.
//
// Modulo puro: sin Supabase. Lo usan contratos.service (generar, renovar,
// regenerar y la vista previa) y tope-canon.guard.
// ============================================================

import { AppError } from '@/lib/errors';
import { COMPANY } from '@/config/company';
import type { Calibracion } from '@/lib/calibracion';

export type Destinacion = 'vivienda' | 'comercial';
export type ClaveTopeCanon = 'CANON_MAX_TRANSITORIO' | 'TOPE_CANON_COMERCIAL';
export interface ReglaDestino { habilitado: boolean; claveTope: ClaveTopeCanon }

// Fase 2 = comercial.habilitado: true (+ su plantilla). Record exhaustivo.
export const DESTINOS: Readonly<Record<Destinacion, ReglaDestino>> = {
  vivienda:  { habilitado: true,  claveTope: 'CANON_MAX_TRANSITORIO' },
  comercial: { habilitado: false, claveTope: 'TOPE_CANON_COMERCIAL' },
};
export const DESTINACION_NO_HABILITADA = 'DESTINACION_NO_HABILITADA';

type MotivoNoHabilitada = 'no_habilitada' | 'mixto' | 'uso_desconocido';

/** Cada mensaje nombra el flujo que le corresponde (Complemento §1.4). */
const MENSAJES: Readonly<Record<MotivoNoHabilitada, string>> = {
  no_habilitada:
    'Este inmueble está registrado con destinación comercial. Le corresponde el contrato de arrendamiento comercial, que todavía no está habilitado en la plataforma, y el contrato de vivienda urbana no se puede usar para un inmueble comercial. Escríbenos para revisar el caso.',
  mixto:
    'Este inmueble está registrado con destinación mixta (vivienda y comercio). Los inmuebles de destinación mixta no se contratan por la plataforma, ni con el contrato de vivienda ni con el comercial: el caso lo revisa la Gerencia General de Cofianza. Escríbenos para revisarlo.',
  uso_desconocido:
    'No pudimos determinar la destinación de este inmueble, así que no se puede generar su contrato. Escríbenos para revisar el caso.',
};

export function destinacionDeUso(uso: string | null | undefined): Destinacion | null {
  switch (uso) {
    case 'vivienda': return 'vivienda';
    case 'comercial':
    case 'local_comercial': return 'comercial'; // legacy; la web lo muestra "Comercio"
    default: return null;                       // mixto o desconocido: sin flujo
  }
}

/** Destinacion con la que se genera el contrato, o 400 DESTINACION_NO_HABILITADA. */
export function destinacionParaContrato(
  uso: string | null | undefined, destinos: Readonly<Record<Destinacion, ReglaDestino>> = DESTINOS,
): Destinacion {
  const d = destinacionDeUso(uso);
  if (d && destinos[d].habilitado) return d;
  const motivo: MotivoNoHabilitada = d ? 'no_habilitada' : uso === 'mixto' ? 'mixto' : 'uso_desconocido';
  throw AppError.badRequest(MENSAJES[motivo], DESTINACION_NO_HABILITADA, { uso: uso ?? null, destinacion: d, motivo });
}

export function topeCanonPara(
  uso: string | null | undefined, cal: Pick<Calibracion, ClaveTopeCanon>,
  destinos: Readonly<Record<Destinacion, ReglaDestino>> = DESTINOS,
): { topeCop: number; clave: ClaveTopeCanon } {
  const d = destinacionDeUso(uso);
  // ponytail: destinacion no habilitada o desconocida usa el tope de vivienda
  // (nada cambia en Fase 1); Fase 2 = habilitar comercial en DESTINOS.
  const clave = d && destinos[d].habilitado ? destinos[d].claveTope : DESTINOS.vivienda.claveTope;
  return { topeCop: cal[clave], clave };
}

// ============================================================
// Estudio que no puede nacer ni cobrarse (lo aplica tope-canon.guard en todos
// los sitios previos al cobro, y vitrina.createInterest). Ver la nota alli.
// ============================================================

export const ESTUDIO_NO_AFIANZABLE_ERROR_CODE = 'ESTUDIO_NO_AFIANZABLE';
export type MotivoNoAfianzable = 'destinacion' | 'persona_juridica';

export interface ArrendatarioDelTope {
  tipo_persona?: string | null;
  tipo_documento?: string | null;
}

/** Regla pura. null = el estudio puede nacer. */
export function motivoNoAfianzable(
  uso: string | null | undefined,
  arrendatario?: ArrendatarioDelTope | null,
): MotivoNoAfianzable | null {
  const d = destinacionDeUso(uso);
  if (uso === 'mixto' || (d !== null && !DESTINOS[d].habilitado)) return 'destinacion';
  if (arrendatario?.tipo_persona === 'juridica' || arrendatario?.tipo_documento?.toLowerCase() === 'nit') {
    return 'persona_juridica';
  }
  return null;
}

const MENSAJES_NO_AFIANZABLE: Readonly<Record<MotivoNoAfianzable, string>> = {
  destinacion:
    'Este inmueble es de uso comercial o mixto: por ahora Cofianza no afianza ese contrato por la plataforma, ' +
    `así que no se cobra el estudio. Escríbanos a ${COMPANY.email} para revisar el caso.`,
  persona_juridica:
    'El arrendatario es una persona jurídica o se identifica con NIT: por ahora Cofianza no afianza ese contrato ' +
    `por la plataforma, así que no se cobra el estudio. Escríbanos a ${COMPANY.email} para revisar el caso.`,
};

export function errorNoAfianzable(motivo: MotivoNoAfianzable): AppError {
  return new AppError(409, ESTUDIO_NO_AFIANZABLE_ERROR_CODE, MENSAJES_NO_AFIANZABLE[motivo], { motivo });
}

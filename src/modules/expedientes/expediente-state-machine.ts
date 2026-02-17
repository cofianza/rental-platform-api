/**
 * Motor de estados del expediente - Funciones puras sin dependencias externas.
 * Define el mapa de transiciones, validadores y tipos.
 */

// ============================================================
// Tipos
// ============================================================

export const ESTADOS_EXPEDIENTE = [
  'borrador',
  'en_revision',
  'informacion_incompleta',
  'aprobado',
  'rechazado',
  'condicionado',
  'cerrado',
] as const;

export type EstadoExpediente = (typeof ESTADOS_EXPEDIENTE)[number];

export type PreconditionId =
  | 'ANALISTA_ASIGNADO'
  | 'DOCUMENTOS_EXISTENTES'
  | 'ESTUDIO_APROBADO'
  | 'ESTUDIO_RECHAZADO'
  | 'ESTUDIO_CONDICIONADO'
  | 'DOCUMENTOS_NUEVOS_DESDE_ULTIMA_TRANSICION'
  | 'CONTRATO_FIRMADO_O_MOTIVO';

export interface TransitionDef {
  from: EstadoExpediente;
  to: EstadoExpediente;
  preconditions: PreconditionId[];
}

// ============================================================
// Mapa de transiciones (AC #1)
// ============================================================

export const TRANSITION_MAP: readonly TransitionDef[] = [
  {
    from: 'borrador',
    to: 'en_revision',
    preconditions: ['ANALISTA_ASIGNADO', 'DOCUMENTOS_EXISTENTES'],
  },
  {
    from: 'en_revision',
    to: 'informacion_incompleta',
    preconditions: [],
  },
  {
    from: 'en_revision',
    to: 'aprobado',
    preconditions: ['ESTUDIO_APROBADO'],
  },
  {
    from: 'en_revision',
    to: 'rechazado',
    preconditions: ['ESTUDIO_RECHAZADO'],
  },
  {
    from: 'en_revision',
    to: 'condicionado',
    preconditions: ['ESTUDIO_CONDICIONADO'],
  },
  {
    from: 'informacion_incompleta',
    to: 'en_revision',
    preconditions: ['DOCUMENTOS_NUEVOS_DESDE_ULTIMA_TRANSICION'],
  },
  {
    from: 'condicionado',
    to: 'aprobado',
    preconditions: [],
  },
  {
    from: 'condicionado',
    to: 'rechazado',
    preconditions: [],
  },
  {
    from: 'aprobado',
    to: 'cerrado',
    preconditions: ['CONTRATO_FIRMADO_O_MOTIVO'],
  },
  {
    from: 'rechazado',
    to: 'cerrado',
    preconditions: [],
  },
];

// ============================================================
// Funciones puras
// ============================================================

export function getAvailableTransitions(currentState: EstadoExpediente): EstadoExpediente[] {
  return TRANSITION_MAP.filter((t) => t.from === currentState).map((t) => t.to);
}

export function isTransitionValid(from: EstadoExpediente, to: EstadoExpediente): boolean {
  return TRANSITION_MAP.some((t) => t.from === from && t.to === to);
}

export function getTransitionDef(from: EstadoExpediente, to: EstadoExpediente): TransitionDef | null {
  return TRANSITION_MAP.find((t) => t.from === from && t.to === to) ?? null;
}

export function isTerminalState(state: EstadoExpediente): boolean {
  return getAvailableTransitions(state).length === 0;
}

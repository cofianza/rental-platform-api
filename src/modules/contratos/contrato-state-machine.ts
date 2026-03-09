/**
 * Motor de estados del contrato - Funciones puras sin dependencias externas.
 * Define el mapa de transiciones, validadores y tipos.
 */

// ============================================================
// Tipos
// ============================================================

export const ESTADOS_CONTRATO = [
  'borrador',
  'en_revision',
  'aprobado',
  'pendiente_firma',
  'firmado',
  'vigente',
  'finalizado',
  'cancelado',
] as const;

export type EstadoContrato = (typeof ESTADOS_CONTRATO)[number];

export type ContratoPreconditionId =
  | 'PDF_GENERADO'
  | 'ESTUDIO_APROBADO'
  | 'MOTIVO_REQUERIDO';

export interface ContratoTransitionDef {
  from: EstadoContrato;
  to: EstadoContrato;
  label: string;
  preconditions: ContratoPreconditionId[];
}

// ============================================================
// Mapa de transiciones
// ============================================================

export const CONTRATO_TRANSITION_MAP: readonly ContratoTransitionDef[] = [
  // Flujo principal
  {
    from: 'borrador',
    to: 'en_revision',
    label: 'Enviar a revision',
    preconditions: ['PDF_GENERADO'],
  },
  {
    from: 'en_revision',
    to: 'aprobado',
    label: 'Aprobar contrato',
    preconditions: [],
  },
  {
    from: 'en_revision',
    to: 'borrador',
    label: 'Devolver a borrador',
    preconditions: [],
  },
  {
    from: 'aprobado',
    to: 'pendiente_firma',
    label: 'Enviar a firma',
    preconditions: ['ESTUDIO_APROBADO'],
  },
  {
    from: 'aprobado',
    to: 'borrador',
    label: 'Devolver a borrador',
    preconditions: [],
  },
  {
    from: 'pendiente_firma',
    to: 'firmado',
    label: 'Registrar firma',
    preconditions: [],
  },
  {
    from: 'firmado',
    to: 'vigente',
    label: 'Activar contrato',
    preconditions: [],
  },
  {
    from: 'vigente',
    to: 'finalizado',
    label: 'Finalizar contrato',
    preconditions: ['MOTIVO_REQUERIDO'],
  },
  {
    from: 'vigente',
    to: 'cancelado',
    label: 'Cancelar contrato',
    preconditions: ['MOTIVO_REQUERIDO'],
  },
  // Cancelacion desde estados pre-firma
  {
    from: 'borrador',
    to: 'cancelado',
    label: 'Cancelar contrato',
    preconditions: ['MOTIVO_REQUERIDO'],
  },
  {
    from: 'en_revision',
    to: 'cancelado',
    label: 'Cancelar contrato',
    preconditions: ['MOTIVO_REQUERIDO'],
  },
  {
    from: 'aprobado',
    to: 'cancelado',
    label: 'Cancelar contrato',
    preconditions: ['MOTIVO_REQUERIDO'],
  },
  {
    from: 'pendiente_firma',
    to: 'cancelado',
    label: 'Cancelar contrato',
    preconditions: ['MOTIVO_REQUERIDO'],
  },
];

// ============================================================
// Funciones puras
// ============================================================

export interface AvailableContratoTransition {
  estado: EstadoContrato;
  label: string;
}

export function getAvailableContratoTransitions(currentState: EstadoContrato): AvailableContratoTransition[] {
  return CONTRATO_TRANSITION_MAP
    .filter((t) => t.from === currentState)
    .map((t) => ({ estado: t.to, label: t.label }));
}

export function isContratoTransitionValid(from: EstadoContrato, to: EstadoContrato): boolean {
  return CONTRATO_TRANSITION_MAP.some((t) => t.from === from && t.to === to);
}

export function getContratoTransitionDef(from: EstadoContrato, to: EstadoContrato): ContratoTransitionDef | null {
  return CONTRATO_TRANSITION_MAP.find((t) => t.from === from && t.to === to) ?? null;
}

export function isContratoTerminalState(state: EstadoContrato): boolean {
  return getAvailableContratoTransitions(state).length === 0;
}

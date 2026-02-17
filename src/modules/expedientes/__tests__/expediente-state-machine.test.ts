import { describe, it, expect } from 'vitest';
import {
  TRANSITION_MAP,
  ESTADOS_EXPEDIENTE,
  getAvailableTransitions,
  isTransitionValid,
  getTransitionDef,
  isTerminalState,
  type EstadoExpediente,
} from '../expediente-state-machine';

describe('expediente-state-machine', () => {
  // AC #1: El mapa de transiciones esta implementado como constante tipada
  describe('TRANSITION_MAP', () => {
    it('debe ser un array no vacio', () => {
      expect(TRANSITION_MAP.length).toBeGreaterThan(0);
    });

    it('todos los estados from/to deben ser valores validos', () => {
      for (const t of TRANSITION_MAP) {
        expect(ESTADOS_EXPEDIENTE).toContain(t.from);
        expect(ESTADOS_EXPEDIENTE).toContain(t.to);
      }
    });

    it('debe tener 10 transiciones definidas', () => {
      expect(TRANSITION_MAP).toHaveLength(10);
    });
  });

  // AC #2 y #3: Validacion de transiciones
  describe('isTransitionValid', () => {
    // AC #2: borrador -> en_revision retorna verdadero
    it('borrador -> en_revision debe ser valida', () => {
      expect(isTransitionValid('borrador', 'en_revision')).toBe(true);
    });

    // AC #3: borrador -> aprobado retorna falso
    it('borrador -> aprobado debe ser invalida', () => {
      expect(isTransitionValid('borrador', 'aprobado')).toBe(false);
    });

    it('cerrado -> cualquier estado debe ser invalida (terminal)', () => {
      for (const state of ESTADOS_EXPEDIENTE) {
        expect(isTransitionValid('cerrado', state)).toBe(false);
      }
    });

    it('en_revision -> informacion_incompleta debe ser valida', () => {
      expect(isTransitionValid('en_revision', 'informacion_incompleta')).toBe(true);
    });

    it('en_revision -> aprobado debe ser valida', () => {
      expect(isTransitionValid('en_revision', 'aprobado')).toBe(true);
    });

    it('en_revision -> rechazado debe ser valida', () => {
      expect(isTransitionValid('en_revision', 'rechazado')).toBe(true);
    });

    it('en_revision -> condicionado debe ser valida', () => {
      expect(isTransitionValid('en_revision', 'condicionado')).toBe(true);
    });

    it('condicionado -> aprobado debe ser valida', () => {
      expect(isTransitionValid('condicionado', 'aprobado')).toBe(true);
    });

    it('condicionado -> rechazado debe ser valida', () => {
      expect(isTransitionValid('condicionado', 'rechazado')).toBe(true);
    });

    it('aprobado -> cerrado debe ser valida', () => {
      expect(isTransitionValid('aprobado', 'cerrado')).toBe(true);
    });

    it('rechazado -> cerrado debe ser valida', () => {
      expect(isTransitionValid('rechazado', 'cerrado')).toBe(true);
    });

    it('informacion_incompleta -> en_revision debe ser valida', () => {
      expect(isTransitionValid('informacion_incompleta', 'en_revision')).toBe(true);
    });

    // Transiciones invalidas
    it('borrador -> rechazado debe ser invalida', () => {
      expect(isTransitionValid('borrador', 'rechazado')).toBe(false);
    });

    it('aprobado -> en_revision debe ser invalida (no se regresa)', () => {
      expect(isTransitionValid('aprobado', 'en_revision')).toBe(false);
    });

    it('informacion_incompleta -> aprobado debe ser invalida', () => {
      expect(isTransitionValid('informacion_incompleta', 'aprobado')).toBe(false);
    });
  });

  // AC #4: Transiciones disponibles desde en_revision
  describe('getAvailableTransitions', () => {
    it('en_revision debe retornar 4 estados destino', () => {
      const transitions = getAvailableTransitions('en_revision');
      expect(transitions).toHaveLength(4);
      expect(transitions).toContain('informacion_incompleta');
      expect(transitions).toContain('aprobado');
      expect(transitions).toContain('rechazado');
      expect(transitions).toContain('condicionado');
    });

    it('borrador debe retornar solo en_revision', () => {
      expect(getAvailableTransitions('borrador')).toEqual(['en_revision']);
    });

    it('cerrado debe retornar array vacio (terminal)', () => {
      expect(getAvailableTransitions('cerrado')).toEqual([]);
    });

    it('condicionado debe retornar aprobado y rechazado', () => {
      const transitions = getAvailableTransitions('condicionado');
      expect(transitions).toHaveLength(2);
      expect(transitions).toContain('aprobado');
      expect(transitions).toContain('rechazado');
    });

    it('informacion_incompleta debe retornar solo en_revision', () => {
      expect(getAvailableTransitions('informacion_incompleta')).toEqual(['en_revision']);
    });

    it('aprobado debe retornar solo cerrado', () => {
      expect(getAvailableTransitions('aprobado')).toEqual(['cerrado']);
    });

    it('rechazado debe retornar solo cerrado', () => {
      expect(getAvailableTransitions('rechazado')).toEqual(['cerrado']);
    });
  });

  // Precondiciones por transicion
  describe('getTransitionDef', () => {
    it('borrador -> en_revision requiere ANALISTA_ASIGNADO + DOCUMENTOS_EXISTENTES', () => {
      const def = getTransitionDef('borrador', 'en_revision')!;
      expect(def).not.toBeNull();
      expect(def.preconditions).toEqual(['ANALISTA_ASIGNADO', 'DOCUMENTOS_EXISTENTES']);
    });

    it('en_revision -> aprobado requiere ESTUDIO_APROBADO', () => {
      const def = getTransitionDef('en_revision', 'aprobado')!;
      expect(def.preconditions).toEqual(['ESTUDIO_APROBADO']);
    });

    it('en_revision -> rechazado requiere ESTUDIO_RECHAZADO', () => {
      const def = getTransitionDef('en_revision', 'rechazado')!;
      expect(def.preconditions).toEqual(['ESTUDIO_RECHAZADO']);
    });

    it('en_revision -> condicionado requiere ESTUDIO_CONDICIONADO', () => {
      const def = getTransitionDef('en_revision', 'condicionado')!;
      expect(def.preconditions).toEqual(['ESTUDIO_CONDICIONADO']);
    });

    it('en_revision -> informacion_incompleta no tiene precondiciones', () => {
      const def = getTransitionDef('en_revision', 'informacion_incompleta')!;
      expect(def.preconditions).toEqual([]);
    });

    it('informacion_incompleta -> en_revision requiere DOCUMENTOS_NUEVOS', () => {
      const def = getTransitionDef('informacion_incompleta', 'en_revision')!;
      expect(def.preconditions).toEqual(['DOCUMENTOS_NUEVOS_DESDE_ULTIMA_TRANSICION']);
    });

    it('aprobado -> cerrado requiere CONTRATO_FIRMADO_O_MOTIVO', () => {
      const def = getTransitionDef('aprobado', 'cerrado')!;
      expect(def.preconditions).toEqual(['CONTRATO_FIRMADO_O_MOTIVO']);
    });

    it('rechazado -> cerrado no tiene precondiciones', () => {
      const def = getTransitionDef('rechazado', 'cerrado')!;
      expect(def.preconditions).toEqual([]);
    });

    it('transicion invalida retorna null', () => {
      expect(getTransitionDef('borrador', 'aprobado')).toBeNull();
    });
  });

  describe('isTerminalState', () => {
    it('cerrado es terminal', () => {
      expect(isTerminalState('cerrado')).toBe(true);
    });

    it('borrador no es terminal', () => {
      expect(isTerminalState('borrador')).toBe(false);
    });

    const nonTerminalStates: EstadoExpediente[] = [
      'borrador', 'en_revision', 'informacion_incompleta',
      'aprobado', 'rechazado', 'condicionado',
    ];
    for (const state of nonTerminalStates) {
      it(`${state} no es terminal`, () => {
        expect(isTerminalState(state)).toBe(false);
      });
    }
  });
});

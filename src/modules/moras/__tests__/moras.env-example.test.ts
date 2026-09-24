import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// Las variables de moras que cada despliegue tiene que decidir están en
// .env.example con su explicación: la de autoescalado faltaba y no se sabía
// que ya no controla la cola de la Ley 2300.
const ENV_EXAMPLE = readFileSync(path.resolve(__dirname, '../../../../.env.example'), 'utf-8');

describe('.env.example — moras', () => {
  it.each(['MORAS_AUTOESCALAR_ENABLED', 'MORAS_COBROS_PROGRAMADOS_ENABLED', 'WHATSAPP_MORA_PLANTILLAS_V2'])(
    '%s está documentada',
    (variable) => {
      expect(ENV_EXAMPLE).toMatch(new RegExp(`^# .+\\n(?:# .*\\n)*${variable}=`, 'm'));
    },
  );
});

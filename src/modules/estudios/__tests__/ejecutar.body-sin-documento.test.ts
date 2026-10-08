import { describe, it, expect } from 'vitest';
import { ejecutarEstudioBodySchema } from '../estudios.schema';

// BLQ §3.5: «Reintentar consulta» ya no cambia el documento (se corrige con
// «Corregir documento», ciego y con fuente). Solo completa el primer apellido.
describe('POST /estudios/:id/ejecutar · body', () => {
  it('descarta tipo y número de documento; conserva el primer apellido', () => {
    const r = ejecutarEstudioBodySchema.parse({ tipo_documento: 'cc', numero_documento: '1023456780', primer_apellido: 'Pérez' });
    expect(r).toEqual({ primer_apellido: 'Pérez' });
  });
});

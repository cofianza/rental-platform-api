import { describe, it, expect, vi } from 'vitest';

// notificarResponsableExpediente acepta el responsable ya resuelto (citas: el
// del inmueble cuando el estudio no tiene); sin él, lee el del estudio.

const { tablas, mockEnviar } = vi.hoisted(() => ({ tablas: [] as string[], mockEnviar: vi.fn() }));

vi.mock('@/lib/supabase', () => {
  const chain = (tabla: string) => {
    tablas.push(tabla);
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'insert']) c[m] = () => c;
    c.maybeSingle = async () =>
      tabla === 'perfiles' ? { data: { nombre: 'Luisa', apellido: 'Gómez', telefono: '3004445566' } } : { data: null };
    c.then = (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r);
    return c;
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: {} }));
vi.mock('../../orchestrator/orchestrator.emails', () => ({ sendResponsableAsignadoEmail: vi.fn() }));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: mockEnviar }));

import { notificarResponsableExpediente } from '../notificaciones.service';

describe('notificarResponsableExpediente', () => {
  it('con miembroId avisa a ese responsable sin leer el del estudio', async () => {
    await notificarResponsableExpediente({
      expedienteId: 'exp1',
      miembroId: 'asesor2',
      tipo: 'cita.solicitada',
      titulo: 'Nueva solicitud de visita',
      mensaje: 'Ana solicitó visitar Cra 7.',
      whatsapp: { template: 'CITA_SOLICITADA_DUENO', variables: ['Norte', 'Ana', 'Cra 7', 'Bogotá', 'vie 2 oct'] },
    });
    expect(tablas).not.toContain('expedientes');
    expect(mockEnviar).toHaveBeenCalledWith(expect.objectContaining({ to: '3004445566', template: 'CITA_SOLICITADA_DUENO' }));
  });
});

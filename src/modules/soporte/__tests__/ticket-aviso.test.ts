import { describe, it, expect, vi } from 'vitest';

// Solo el administrador ve /soporte: un ticket nuevo le llega como notificación
// (a todos los administradores activos, menos a quien lo abrió).
const { notificar } = vi.hoisted(() => ({ notificar: vi.fn(async () => undefined) }));

vi.mock('@/lib/supabase', () => {
  const res: Record<string, unknown> = {
    tickets_soporte: {
      data: { id: 't1', ticket_numero: 'TCK-0001', remitente_id: 'inmo-1', tipo: 'clausulas_adicionales', asunto: 'Revisión', estado: 'abierto' },
      error: null,
    },
    perfiles: { data: [{ id: 'admin-1' }, { id: 'admin-2' }, { id: 'inmo-1' }], error: null },
  };
  const from = (t: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['insert', 'select', 'eq']) chain[m] = () => chain;
    chain.single = async () => res[t];
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(res[t]).then(ok);
    return chain;
  };
  return { supabase: { from } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: notificar }));

import { createTicket } from '../soporte.service';

describe('createTicket', () => {
  it('avisa a los administradores con enlace a Soporte', async () => {
    await createTicket('inmo-1', { tipo: 'clausulas_adicionales', asunto: 'Revisión' } as never);

    await vi.waitFor(() => expect(notificar).toHaveBeenCalledTimes(2));
    expect(notificar.mock.calls.map((c) => (c as unknown as [{ userId: string }])[0].userId)).toEqual(['admin-1', 'admin-2']);
    expect(notificar).toHaveBeenCalledWith(expect.objectContaining({ link: '/soporte', mensaje: 'TCK-0001: Revisión' }));
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// La V4 vive en contenido_html con @page y las anclas firma-line: un HTML sin
// ellas (lo que deja el editor TipTap) no se guarda.
const { updates } = vi.hoisted(() => ({ updates: [] as unknown[] }));
vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) chain[m] = () => chain;
  chain.single = async () => ({
    data: { id: 'p1', nombre: 'V4', contenido: null, contenido_html: '<style>@page{}</style><div class="firma-line"></div>', version: 1 },
    error: null,
  });
  chain.update = (data: unknown) => {
    updates.push(data);
    return { eq: async () => ({ error: null }) };
  };
  return { supabase: { from: () => chain }, supabaseAuth: {} };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));

import { updatePlantilla } from '../plantillas.service';

beforeEach(() => {
  updates.length = 0;
});

describe('updatePlantilla — plantilla HTML', () => {
  it('rechaza un contenido sin @page ni firma-line y no escribe nada', async () => {
    await expect(updatePlantilla('p1', { contenido: '<p>Contrato</p>' } as never, 'u1')).rejects.toMatchObject({
      errorCode: 'PLANTILLA_HTML_INVALIDA',
      statusCode: 400,
    });
    expect(updates).toHaveLength(0);
  });

  it('renombrar sin contenido sigue funcionando', async () => {
    await updatePlantilla('p1', { nombre: 'V4 nueva' } as never, 'u1');
    expect(updates).toEqual([{ nombre: 'V4 nueva' }]);
  });
});

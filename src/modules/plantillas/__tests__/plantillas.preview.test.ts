import { describe, it, expect, vi } from 'vitest';

// «Vista previa» del panel de plantillas: la V4 usa variables con punto y
// {{#if}}; antes salían las llaves tal cual.
vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) chain[m] = () => chain;
  chain.single = async () => ({
    data: {
      id: 'p1',
      nombre: 'V4',
      contenido: null,
      contenido_html:
        '<p>{{inmobiliaria.razon_social}}</p>{{#if cotitular.nombre}}<p>Co: {{cotitular.nombre}}</p>{{/if}}<p>{{canon_mensual}}</p>',
      variables: [],
    },
    error: null,
  });
  return { supabase: { from: () => chain }, supabaseAuth: {} };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));

import { previewPlantilla } from '../plantillas.service';

describe('previewPlantilla', () => {
  it('resuelve variables con punto y {{#if}}; las planas siguen con el dato de ejemplo', async () => {
    const { html } = await previewPlantilla('p1', {} as never);
    expect(html).toContain('<p>[inmobiliaria.razon_social]</p>');
    expect(html).toContain('<p>Co: [cotitular.nombre]</p>');
    expect(html).toContain('<p>$1.500.000</p>');
    expect(html).not.toContain('{{');
  });
});

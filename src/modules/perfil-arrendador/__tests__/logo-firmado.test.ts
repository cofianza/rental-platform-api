import { describe, it, expect, vi } from 'vitest';

// El logo_url guardado al subir el logo vence a los 30 días: Datos para contrato
// debe devolver una URL firmada de nuevo por la llave, no la guardada.
vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) chain[m] = () => chain;
  chain.single = async () => ({
    data: { id: 'p1', logo_storage_key: 'logos-arrendador/p1/logo.png', logo_url: 'https://vieja/vencida' },
    error: null,
  });
  return {
    supabase: {
      from: () => chain,
      storage: { from: () => ({ createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://nueva/${key}` }, error: null }) }) },
    },
  };
});
vi.mock('@/lib/tenantScope', () => ({
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
  resolveRolMiembro: vi.fn(async () => 'owner'),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));

import { getMiPerfilArrendador } from '../perfil-arrendador.service';

describe('getMiPerfilArrendador', () => {
  it('firma el logo por su llave en vez de devolver la URL guardada', async () => {
    const perfil = await getMiPerfilArrendador('p1');
    expect(perfil.logo_url).toBe('https://nueva/logos-arrendador/p1/logo.png');
    expect(perfil.puede_editar).toBe(true);
  });
});

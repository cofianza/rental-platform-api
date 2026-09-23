/**
 * env.ts real (sin mock): cómo queda GERENCIA_GENERAL_EMAILS (Adenda 1 del
 * módulo de contratos, respuesta 17) y las advertencias que deja al arrancar.
 * Cada caso vuelve a importar el módulo con sus variables.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const OBLIGATORIAS = {
  SUPABASE_URL: 'https://prueba.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  SUPABASE_JWT_SECRET: 'secreto',
  RESEND_API_KEY: 're_prueba',
  AUCO_SENDER_EMAIL: 'firmas@cofianza.co',
};

async function arrancar(vars: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...OBLIGATORIAS, ...vars })) vi.stubEnv(k, v);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { env } = await import('../env');
  return { env, avisos: warn.mock.calls.map((c) => String(c[0])) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GERENCIA_GENERAL_EMAILS', () => {
  it('minúsculas y sin espacios; coma, punto y coma, espacios y saltos de línea separan; los vacíos no cuentan', async () => {
    const { env, avisos } = await arrancar({
      GERENCIA_GENERAL_EMAILS: ' Mario@Cofianza.CO ,, ana@cofianza.co;LUIS@cofianza.co\n  pedro@cofianza.co , ',
    });
    expect(env.GERENCIA_GENERAL_EMAILS).toEqual([
      'mario@cofianza.co',
      'ana@cofianza.co',
      'luis@cofianza.co',
      'pedro@cofianza.co',
    ]);
    expect(avisos.filter((a) => a.includes('GERENCIA_GENERAL_EMAILS'))).toEqual([]);
  });

  it('vacía: lista vacía y advertencia de que cualquier administrador cambia los de riesgo', async () => {
    const { env, avisos } = await arrancar({ GERENCIA_GENERAL_EMAILS: '  ,  ' });
    expect(env.GERENCIA_GENERAL_EMAILS).toEqual([]);
    expect(avisos.some((a) => a.includes('GERENCIA_GENERAL_EMAILS vacía'))).toBe(true);
  });

  it('una entrada que no parece correo se advierte y se conserva: la lista no queda vacía (no le abre todo a todos)', async () => {
    const { env, avisos } = await arrancar({ GERENCIA_GENERAL_EMAILS: 'mario@cofianza, ana@cofianza.co' });
    expect(env.GERENCIA_GENERAL_EMAILS).toEqual(['mario@cofianza', 'ana@cofianza.co']);
    const aviso = avisos.find((a) => a.includes('no parecen correos'));
    expect(aviso).toContain('mario@cofianza');
    expect(aviso).not.toContain('ana@cofianza.co');
  });
});

describe('CLAUSULAS_IA_ENABLED (respuesta 13 bis)', () => {
  it('encendido deja una advertencia al arrancar: no tiene efecto', async () => {
    const { avisos } = await arrancar({ CLAUSULAS_IA_ENABLED: 'true', GERENCIA_GENERAL_EMAILS: 'mario@cofianza.co' });
    expect(avisos.some((a) => a.includes('CLAUSULAS_IA_ENABLED=true no tiene efecto'))).toBe(true);
  });
});

import { describe, it, expect, vi } from 'vitest';

// El correo de verificación es el primero que recibe quien se registra. Salía
// sin tildes («correo electronico», «boton», «automatico») y, cuando el nombre
// llegaba con el espacio que deja el teclado del celular, con «Hola Roberto , …».

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn(async (..._args: unknown[]) => ({ data: { id: 'e' }, error: null })) }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => mockSend(...args) };
  },
}));
vi.mock('@/config', () => ({
  env: { RESEND_API_KEY: 're_test', RESEND_FROM_EMAIL: 'no-reply@cofianza.co', FRONTEND_URL: 'http://localhost:3000' },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sendVerificationEmail } from '../email';

const html = () => (mockSend.mock.calls.at(-1)![0] as { html: string }).html;

describe('correo de verificación', () => {
  it('saluda sin espacio antes de la coma y va con tildes', async () => {
    await sendVerificationEmail('roberto@correo.co', 'Roberto ', 'http://localhost:3000/verificar-email?token=abc');

    expect(html()).toContain('Hola Roberto, gracias por registrarse en Cofianza.');
    expect(html()).toContain('Verifique su correo electrónico');
    expect(html()).toContain('Si el botón no funciona');
    expect(html()).toContain('Este es un correo automático');
    expect(html()).not.toMatch(/electronico|boton|automatico/);
  });

  it('el nombre sigue saliendo escapado', async () => {
    await sendVerificationEmail('x@correo.co', '<b>Ana</b> ', 'http://localhost:3000/verificar-email?token=abc');
    expect(html()).toContain('Hola &lt;b&gt;Ana&lt;/b&gt;, gracias');
  });
});

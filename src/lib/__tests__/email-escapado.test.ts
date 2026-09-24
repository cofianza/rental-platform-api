import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /public/properties/:id/interes no pide sesión: el nombre y el mensaje
// que escribe cualquiera salen escapados en el correo de Cofianza.

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

import { sendInteresadoConfirmacionEmail, sendNuevoInteresadoEmail } from '../email';

const PHISHING = '<a href="https://evil.co">Verifica tu cuenta</a>';
const html = () => (mockSend.mock.calls.at(-1)![0] as { html: string }).html;

beforeEach(() => mockSend.mockClear());

describe('correos del interesado de la vitrina (ruta anónima)', () => {
  it('la confirmación al interesado no lleva texto que haya escrito el visitante', async () => {
    // Va a una dirección sin verificar: solo el inmueble (de la base), escapado.
    await sendInteresadoConfirmacionEmail('victima@correo.co', { inmuebleLabel: PHISHING });
    expect(html()).not.toContain('<a href="https://evil.co"');
    expect(html()).toContain('Hola, gracias por tu interés');
  });

  it('el aviso al dueño escapa nombre y mensaje', async () => {
    await sendNuevoInteresadoEmail('dueno@correo.co', {
      duenoNombre: 'Dueño',
      interesadoNombre: PHISHING,
      interesadoTelefono: '300',
      interesadoEmail: 'x@y.co',
      inmuebleLabel: 'Calle 1',
      mensaje: PHISHING,
      panelUrl: 'http://localhost:3000/interesados',
    });
    expect(html()).not.toContain('<a href="https://evil.co"');
  });
});

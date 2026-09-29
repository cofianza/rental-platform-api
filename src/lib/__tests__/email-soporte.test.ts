import { describe, it, expect, vi } from 'vitest';

// El WhatsApp y el correo de soporte de los correos al prospecto son los que
// el administrador edita en «Datos de la empresa», no los del archivo.

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
vi.mock('@/lib/companyConfig', () => ({
  getCompany: async () => ({ phone: '+57 300 999 9999', email: 'soporte-nuevo@cofianza.co' }),
}));

import { sendAutorizacionEmail, sendPaymentLinkEmail } from '../email';

const html = () => (mockSend.mock.calls.at(-1)![0] as { html: string }).html;

const SOLICITUD = { quienSolicita: 'Inmobiliaria Norte', direccion: 'Cra 7 # 1-2, Bogotá' };

describe('correo de autorización (M5)', () => {
  it('nombra a quien pide el estudio y el inmueble, con el botón de la plantilla y la marca actual', async () => {
    await sendAutorizacionEmail('p@correo.co', 'Ana', 'http://x/autorizar', 360, SOLICITUD);
    expect(html()).toContain('<strong>Inmobiliaria Norte</strong> inició un estudio para el arriendo del inmueble ubicado en <strong>Cra 7 # 1-2, Bogotá</strong>');
    expect(html()).toContain('Revisar y autorizar');
    expect(html()).not.toContain('Firmar autorización');
    // Sin el logo viejo: la «C» sobre #0f766e.
    expect(html()).not.toContain('#0f766e');
    expect(html()).toContain('>cofianza</td>');
  });

  it('escapa quién pide y la dirección (vienen de datos que escribe el gestor)', async () => {
    await sendAutorizacionEmail('p@correo.co', 'Ana', 'http://x/autorizar', 360, {
      quienSolicita: '<b>Inmo</b>',
      direccion: 'Calle "1" & 2',
    });
    expect(html()).toContain('&lt;b&gt;Inmo&lt;/b&gt;');
    expect(html()).toContain('Calle &quot;1&quot; &amp; 2');
  });
});

describe('pie de soporte de los correos', () => {
  it('usa el canal editado en «Datos de la empresa»', async () => {
    await sendAutorizacionEmail('p@correo.co', 'Ana', 'http://x/autorizar', 360, SOLICITUD);
    expect(html()).toContain('WhatsApp al +57 300 999 9999 o a soporte-nuevo@cofianza.co');

    await sendPaymentLinkEmail('p@correo.co', 'Ana', 'http://x/pago', { concepto: 'Estudio', monto: '$1', expediente_numero: 'E-1' });
    expect(html()).toContain('WhatsApp al +57 300 999 9999 o a soporte-nuevo@cofianza.co');
  });
});

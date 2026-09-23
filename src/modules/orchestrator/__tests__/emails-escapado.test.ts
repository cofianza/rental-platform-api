import { describe, it, expect, vi, beforeEach } from 'vitest';

// Texto libre de personas (motivo de cancelación desde el enlace público, notas
// de la visita, nombres) sale escapado en el HTML de los correos de Cofianza.

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn(async (..._args: unknown[]) => ({ data: { id: 'e' }, error: null })) }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => mockSend(...args) };
  },
}));
vi.mock('@/config/env', () => ({ env: { RESEND_API_KEY: 're_test', RESEND_FROM_EMAIL: 'no-reply@cofianza.co' } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/companyConfig', () => ({ getCompany: vi.fn(async () => ({ phone: '300', email: 'hola@cofianza.co' })) }));
vi.mock('@/modules/estudios/rutas-resultado', () => ({ resolverRuta: vi.fn() }));

import { sendCitaCanceladaEmail, sendCitaConfirmadaSolicitanteEmail } from '../orchestrator.emails';

const PHISHING = '<a href="https://evil.co">Paga aquí</a>';
const html = () => (mockSend.mock.calls.at(-1)![0] as { html: string }).html;

beforeEach(() => mockSend.mockClear());

describe('correos de visita', () => {
  it('el motivo de cancelación (enlace público) no inyecta HTML', async () => {
    await sendCitaCanceladaEmail({
      email: 'dueno@correo.co',
      nombre_destinatario: 'Dueño',
      inmueble: 'Calle 1',
      ciudad: 'Medellín',
      fecha_cita: '2026-09-30T15:00:00Z',
      motivo: PHISHING,
      cancelado_por: 'solicitante',
    });
    expect(html()).not.toContain('<a href="https://evil.co"');
    expect(html()).toContain('&lt;a href=&quot;https://evil.co&quot;&gt;');
  });

  it('las notas y el nombre del solicitante tampoco', async () => {
    await sendCitaConfirmadaSolicitanteEmail({
      email: 'victima@correo.co',
      nombre_solicitante: PHISHING,
      inmueble: 'Calle 1',
      ciudad: 'Medellín',
      fecha_confirmada: '2026-09-30T15:00:00Z',
      notas_propietario: PHISHING,
    });
    expect(html()).not.toContain('<a href="https://evil.co"');
  });
});

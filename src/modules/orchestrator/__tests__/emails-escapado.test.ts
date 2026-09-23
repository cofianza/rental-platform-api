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

import {
  sendCitaCanceladaEmail,
  sendCitaConfirmadaSolicitanteEmail,
  sendCitaReprogramadaSolicitanteEmail,
  sendCitaSolicitadaPropietarioEmail,
} from '../orchestrator.emails';

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

// El correo decía «ingresa a la plataforma» o «desde tu panel» sin ningún
// enlace, y el prospecto no tiene panel de visitas: ahora lleva los mismos
// enlaces que los botones del WhatsApp.
describe('correos de visita con enlaces', () => {
  const base = { email: 'p@correo.co', nombre_solicitante: 'Ana', inmueble: 'Calle 1', ciudad: 'Medellín' };
  const enlaces = { reprogramar: 'https://cofianza.co/visita/reprogramar/tok', cancelar: 'https://cofianza.co/visita/cancelar/tok' };

  it('confirmada y reprogramada llevan Reprogramar y Cancelar', async () => {
    await sendCitaConfirmadaSolicitanteEmail({ ...base, fecha_confirmada: '2026-09-30T15:00:00Z', enlaces });
    expect(html()).toContain(`href="${enlaces.reprogramar}"`);
    expect(html()).toContain(`href="${enlaces.cancelar}"`);
    await sendCitaReprogramadaSolicitanteEmail({
      ...base, fecha_propuesta: '2026-09-29T15:00:00Z', fecha_confirmada: '2026-09-30T15:00:00Z', enlaces,
    });
    expect(html()).toContain(`href="${enlaces.reprogramar}"`);
    expect(html()).not.toContain('panel');
  });

  it('sin token no promete un panel que el prospecto no tiene', async () => {
    await sendCitaReprogramadaSolicitanteEmail({
      ...base, fecha_propuesta: '2026-09-29T15:00:00Z', fecha_confirmada: '2026-09-30T15:00:00Z',
    });
    expect(html()).not.toContain('panel');
    await sendCitaCanceladaEmail({
      email: 'p@correo.co', nombre_destinatario: 'Ana', inmueble: 'Calle 1', ciudad: 'Medellín',
      fecha_cita: '2026-09-30T15:00:00Z', motivo: 'viaje', cancelado_por: 'propietario',
    });
    expect(html()).not.toContain('panel');
  });

  it('al dueño la solicitud lo lleva a la visita en /citas', async () => {
    await sendCitaSolicitadaPropietarioEmail({
      email: 'd@correo.co', nombre_propietario: 'Dueño', nombre_solicitante: 'Ana', inmueble: 'Calle 1',
      ciudad: 'Medellín', fecha_propuesta: '2026-09-30T15:00:00Z', url_visita: 'https://cofianza.co/citas#cita-c1',
    });
    expect(html()).toContain('href="https://cofianza.co/citas#cita-c1"');
  });
});

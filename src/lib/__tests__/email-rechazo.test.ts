import { describe, it, expect, vi, beforeEach } from 'vitest';

// Resend no lanza cuando rechaza un envío (cuota, dominio sin verificar,
// destinatario inválido, corte de red): devuelve { data: null, error }. Antes
// ningún envío de email.ts miraba esa respuesta y el rechazo quedaba en los
// logs como «enviado». Aquí cada función del archivo recibe un rechazo.

const { mockSend, mockLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(async (..._args: unknown[]): Promise<{ data: unknown; error: unknown }> => ({ data: { id: 'e' }, error: null })),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => mockSend(...args) };
  },
}));
vi.mock('@/config', () => ({
  env: { RESEND_API_KEY: 're_test', RESEND_FROM_EMAIL: 'no-reply@cofianza.co', FRONTEND_URL: 'http://localhost:3000' },
}));
vi.mock('@/lib/logger', () => ({ logger: mockLogger }));
vi.mock('@/lib/companyConfig', () => ({ getCompany: async () => ({ phone: '+57 300 000 0000', email: 'gerencia@cofianza.co' }) }));

import * as email from '../email';

const RECHAZO = { data: null, error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' } };
const A = 'p@correo.co';

// Las que lanzan (quien llama decide qué hacer) y las de mejor esfuerzo (no lanzan).
const LANZAN: Array<[string, () => Promise<void>]> = [
  ['sendPasswordResetEmail', () => email.sendPasswordResetEmail(A, 'http://x/restablecer')],
  ['sendWelcomeEmail', () => email.sendWelcomeEmail(A, 'Ana', 'Temporal123')],
  ['sendEnlaceMagicoEmail', () => email.sendEnlaceMagicoEmail(A, 'http://x/entrar')],
  ['sendVerificationEmail', () => email.sendVerificationEmail(A, 'Ana', 'http://x/verificar')],
  ['sendEstudioFormEmail', () => email.sendEstudioFormEmail(A, 'Ana', 'http://x/estudio', 72)],
  ['sendAutorizacionEmail', () => email.sendAutorizacionEmail(A, 'Ana', 'http://x/autorizar', 360, { quienSolicita: 'Inmo', direccion: 'Calle 1' })],
  ['sendOtpEmail', () => email.sendOtpEmail(A, 'Ana', '123456')],
  ['sendFirmaEmail', () => email.sendFirmaEmail(A, 'Ana', 'http://x/firma', 72, { direccion_inmueble: 'Calle 1', ciudad_inmueble: 'Medellín', nombre_arrendatario: 'Ana' })],
  ['sendPaymentLinkEmail', () => email.sendPaymentLinkEmail(A, 'Ana', 'http://x/pago', { concepto: 'Estudio', monto: '$1', expediente_numero: 'E-1' })],
];
const MEJOR_ESFUERZO: Array<[string, () => Promise<void>]> = [
  ['sendInteresadoConfirmacionEmail', () => email.sendInteresadoConfirmacionEmail(A, { inmuebleLabel: 'Apartamento en Laureles' })],
  ['sendNuevoInteresadoEmail', () => email.sendNuevoInteresadoEmail(A, {
    duenoNombre: 'Dueño', interesadoNombre: 'Ana', interesadoTelefono: '300', interesadoEmail: 'x@y.co', inmuebleLabel: 'Calle 1', panelUrl: 'http://x/interesados',
  })],
];

const registroElMotivo = () =>
  expect(mockLogger.error).toHaveBeenCalledWith(
    expect.objectContaining({ to: A, motivo: 'rate_limit_exceeded', status: 429, error: 'Too many requests' }),
    'Resend rechazó el correo',
  );

beforeEach(() => vi.clearAllMocks());

describe('si Resend rechaza el correo', () => {
  it.each(LANZAN)('%s lanza y no registra «enviado»', async (_nombre, enviar) => {
    mockSend.mockResolvedValueOnce(RECHAZO);
    await expect(enviar()).rejects.toThrow('Resend rate_limit_exceeded: Too many requests');
    expect(mockLogger.info).not.toHaveBeenCalled();
    registroElMotivo();
  });

  it.each(MEJOR_ESFUERZO)('%s no lanza (es de mejor esfuerzo) y tampoco registra «enviado»', async (_nombre, enviar) => {
    mockSend.mockResolvedValueOnce(RECHAZO);
    await expect(enviar()).resolves.toBeUndefined();
    expect(mockLogger.info).not.toHaveBeenCalled();
    registroElMotivo();
  });

  it('la lista cubre todas las funciones de envío del archivo', () => {
    const exportadas = Object.keys(email).filter((k) => k.startsWith('send')).sort();
    expect([...LANZAN, ...MEJOR_ESFUERZO].map(([nombre]) => nombre).sort()).toEqual(exportadas);
  });
});

describe('si Resend acepta el correo', () => {
  it('registra «enviado» y no lanza', async () => {
    await expect(email.sendVerificationEmail(A, 'Ana', 'http://x/verificar')).resolves.toBeUndefined();
    expect(mockLogger.info).toHaveBeenCalledWith({ to: A }, 'Email de verificacion enviado');
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
